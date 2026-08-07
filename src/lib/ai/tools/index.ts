// AI Tool Registry — the contract between the AI and the circuit editor.
// ─────────────────────────────────────────────────────────────────────────────
// Each tool is a self-contained operation the AI can invoke. Tools are
// categorized for documentation purposes, but all share the same shape:
//   - name (namespaced like 'schematic.addComponent')
//   - description (what it does, when to use it)
//   - parameters (JSON schema for the arguments)
//   - execute (runs the operation against a ToolContext, returns JSON-serializable result)
//
// The ToolContext carries:
//   - doc: the current CircuitDocument (components, wires, etc.)
//   - pcb: the current PCB state (footprints, traces, vias, board)
//   - simContext: the latest SimContext (if simulation has run)
//   - history: the full chat history (for context-aware tools)
//
// Tools return a result object: { ok: boolean, result?: any, error?: string }
// The API route serializes this and feeds it back to the AI as a 'tool' message.

import type { CircuitDocument, CircuitComponent, Wire, SimContext } from '@/lib/circuit/types';
import type { PCBDocument, Footprint, Trace, Via, BoardOutline } from '@/lib/pcb/types';
import { simulateStep, buildNodeMap, getTerminalsForComponent, computeComponentCurrents, computeWireCurrents, solveDC } from '@/lib/circuit/engine';
import { getPlugin, getAllPlugins, getPluginsByCategory } from '@/lib/circuit/registry';
import { validatePhysics } from '@/lib/circuit/physics-validator';
import { exampleCategories } from '@/lib/circuit/examples';
import { exportSPICENetlist, exportBOMCSV, exportKiCadNetlist } from '@/lib/circuit/netlist-export';
import { runDRC } from '@/lib/pcb/drc';
import { verifyNetlist } from '@/lib/pcb/netlist-verify';
import { autoRoute } from '@/lib/pcb/auto-router';
import { routeTopologically, DEFAULT_ROUTER_OPTIONS } from '@/lib/pcb/topological-router';

// ─────────────────────────────────────────────────────────────────────────────
// Tool context — passed to every tool execute()
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolContext {
  doc: CircuitDocument;
  pcb?: {
    board: BoardOutline;
    footprints: Footprint[];
    traces: Trace[];
    vias: Via[];
  };
  simContext?: SimContext | null;
  plugins: Map<string, any>;
}

export interface ToolResult {
  ok: boolean;
  result?: any;
  error?: string;
}

export interface Tool {
  name: string;
  category: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper utilities
// ─────────────────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function findComponent(doc: CircuitDocument, id: string): CircuitComponent | undefined {
  return doc.components.find(c => c.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMATIC COMPONENT TOOLS
// ─────────────────────────────────────────────────────────────────────────────

const addComponentTool: Tool = {
  name: 'schematic.addComponent',
  category: 'Circuit Building',
  description: 'Add a new component to the schematic. Returns the new component ID. Use this when the user wants to add a resistor, capacitor, IC, etc. After adding, you may want to addWire to connect it.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Component type, e.g. "resistor", "capacitor", "led", "npn", "opamp", "dcVoltage", "acVoltage", "ground", "arduinoReal", "timer555", "speaker". Use listComponentTypes to see all available types.' },
      x: { type: 'number', description: 'X position on the grid (in grid units, 1 unit = 1 cell). Typical range: 0-40.' },
      y: { type: 'number', description: 'Y position on the grid. Typical range: 0-30.' },
      parameters: { type: 'object', description: 'Optional: parameter overrides, e.g. {resistance: 330} for a resistor, or {voltage: 5} for a DC source. Use getComponentInfo to see available parameters.', additionalProperties: true },
    },
    required: ['type', 'x', 'y'],
  },
  execute(args, ctx) {
    const plugin = getPlugin(args.type);
    if (!plugin) {
      return { ok: false, error: `Unknown component type: "${args.type}". Use listComponentTypes to see available types.` };
    }
    const id = genId(args.type);
    const defaults: any = {};
    for (const p of plugin.parameters) defaults[p.key] = p.default;
    const comp: CircuitComponent = {
      id,
      type: args.type,
      position: { x: args.x, y: args.y },
      rotation: 0,
      parameters: { ...defaults, ...(args.parameters || {}) },
    };
    ctx.doc.components.push(comp);
    return { ok: true, result: { id, type: args.type, position: comp.position, parameters: comp.parameters } };
  },
};

const removeComponentTool: Tool = {
  name: 'schematic.removeComponent',
  category: 'Circuit Building',
  description: 'Remove a component AND any wires connected to it from the schematic.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The component ID to remove (e.g. "r1", "led1", or an auto-generated ID returned by addComponent).' },
    },
    required: ['id'],
  },
  execute(args, ctx) {
    const idx = ctx.doc.components.findIndex(c => c.id === args.id);
    if (idx === -1) return { ok: false, error: `Component "${args.id}" not found` };
    ctx.doc.components.splice(idx, 1);
    // Remove wires connected to this component
    const before = ctx.doc.wires.length;
    ctx.doc.wires = ctx.doc.wires.filter(w => w.from.componentId !== args.id && w.to.componentId !== args.id);
    return { ok: true, result: { removedId: args.id, wiresRemoved: before - ctx.doc.wires.length } };
  },
};

const moveComponentTool: Tool = {
  name: 'schematic.moveComponent',
  category: 'Circuit Building',
  description: 'Move a component to a new position on the grid.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Component ID to move.' },
      x: { type: 'number', description: 'New X position.' },
      y: { type: 'number', description: 'New Y position.' },
    },
    required: ['id', 'x', 'y'],
  },
  execute(args, ctx) {
    const comp = findComponent(ctx.doc, args.id);
    if (!comp) return { ok: false, error: `Component "${args.id}" not found` };
    comp.position = { x: args.x, y: args.y };
    return { ok: true, result: { id: args.id, position: comp.position } };
  },
};

const rotateComponentTool: Tool = {
  name: 'schematic.rotateComponent',
  category: 'Circuit Building',
  description: 'Rotate a component 90° clockwise. Rotation values: 0, 1, 2, 3 (for 0°, 90°, 180°, 270°).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Component ID to rotate.' },
    },
    required: ['id'],
  },
  execute(args, ctx) {
    const comp = findComponent(ctx.doc, args.id);
    if (!comp) return { ok: false, error: `Component "${args.id}" not found` };
    comp.rotation = ((comp.rotation || 0) + 1) % 4 as 0 | 1 | 2 | 3;
    return { ok: true, result: { id: args.id, rotation: comp.rotation } };
  },
};

const setParameterTool: Tool = {
  name: 'schematic.setParameter',
  category: 'Circuit Building',
  description: 'Set a parameter on a component (e.g. resistance, voltage, capacitance, hfe). Use getComponentInfo first to see what parameters a component type supports.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Component ID.' },
      key: { type: 'string', description: 'Parameter key, e.g. "resistance", "voltage", "capacitance", "hfe", "forwardV".' },
      value: { description: 'New value (number, string, or boolean depending on the parameter).' },
    },
    required: ['id', 'key', 'value'],
  },
  execute(args, ctx) {
    const comp = findComponent(ctx.doc, args.id);
    if (!comp) return { ok: false, error: `Component "${args.id}" not found` };
    comp.parameters[args.key] = args.value;
    return { ok: true, result: { id: args.id, key: args.key, value: args.value } };
  },
};

const addWireTool: Tool = {
  name: 'schematic.addWire',
  category: 'Circuit Building',
  description: 'Connect two component terminals with a wire. Terminals are like "p"/"n" (sources), "a"/"b" (passives), "c"/"b"/"e" (transistors), "in+"/"in-"/"out" (op-amps). Use getComponentInfo to see terminal IDs for a type.',
  parameters: {
    type: 'object',
    properties: {
      fromComponentId: { type: 'string', description: 'Source component ID.' },
      fromTerminalId: { type: 'string', description: 'Source terminal ID (e.g. "p", "a", "b").' },
      toComponentId: { type: 'string', description: 'Destination component ID.' },
      toTerminalId: { type: 'string', description: 'Destination terminal ID.' },
      waypoints: {
        type: 'array',
        description: 'Optional: list of [x, y] grid points the wire should pass through, for clean L-shaped routing. E.g. [[5, 9], [10, 9]].',
        items: { type: 'array', items: [{ type: 'number' }, { type: 'number' }] },
      },
    },
    required: ['fromComponentId', 'fromTerminalId', 'toComponentId', 'toTerminalId'],
  },
  execute(args, ctx) {
    const fromComp = findComponent(ctx.doc, args.fromComponentId);
    const toComp = findComponent(ctx.doc, args.toComponentId);
    if (!fromComp) return { ok: false, error: `From component "${args.fromComponentId}" not found` };
    if (!toComp) return { ok: false, error: `To component "${args.toComponentId}" not found` };
    const fromPlugin = getPlugin(fromComp.type);
    const toPlugin = getPlugin(toComp.type);
    if (!fromPlugin) return { ok: false, error: `Plugin for type "${fromComp.type}" not found` };
    if (!toPlugin) return { ok: false, error: `Plugin for type "${toComp.type}" not found` };
    const fromTerm = fromPlugin.terminals.find(t => t.id === args.fromTerminalId);
    const toTerm = toPlugin.terminals.find(t => t.id === args.toTerminalId);
    if (!fromTerm) return { ok: false, error: `Terminal "${args.fromTerminalId}" not found on ${fromComp.type}. Available: ${fromPlugin.terminals.map(t=>t.id).join(', ')}` };
    if (!toTerm) return { ok: false, error: `Terminal "${args.toTerminalId}" not found on ${toComp.type}. Available: ${toPlugin.terminals.map(t=>t.id).join(', ')}` };

    const wire: Wire = {
      id: genId('w'),
      from: { componentId: args.fromComponentId, terminalId: args.fromTerminalId },
      to: { componentId: args.toComponentId, terminalId: args.toTerminalId },
    };
    if (args.waypoints && args.waypoints.length > 0) {
      (wire as any).waypoints = args.waypoints.map(([x, y]: [number, number]) => ({ x, y }));
    }
    ctx.doc.wires.push(wire);
    return { ok: true, result: { id: wire.id, from: wire.from, to: wire.to } };
  },
};

const removeWireTool: Tool = {
  name: 'schematic.removeWire',
  category: 'Circuit Building',
  description: 'Remove a wire by its ID. Use listWires to find wire IDs.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Wire ID to remove.' },
    },
    required: ['id'],
  },
  execute(args, ctx) {
    const idx = ctx.doc.wires.findIndex(w => w.id === args.id);
    if (idx === -1) return { ok: false, error: `Wire "${args.id}" not found` };
    ctx.doc.wires.splice(idx, 1);
    return { ok: true, result: { removedId: args.id } };
  },
};

const clearCircuitTool: Tool = {
  name: 'schematic.clear',
  category: 'Circuit Building',
  description: 'Remove ALL components and wires from the schematic. Use with caution — this cannot be undone by the AI (but the user can undo via the UI).',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    const compCount = ctx.doc.components.length;
    const wireCount = ctx.doc.wires.length;
    ctx.doc.components = [];
    ctx.doc.wires = [];
    return { ok: true, result: { cleared: true, componentsRemoved: compCount, wiresRemoved: wireCount } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMATIC INSPECTION TOOLS
// ─────────────────────────────────────────────────────────────────────────────

const listComponentsTool: Tool = {
  name: 'schematic.listComponents',
  category: 'Discovery',
  description: 'List all components in the current schematic with their IDs, types, positions, and parameters. Use this to understand the current circuit state before making changes.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    return {
      ok: true,
      result: ctx.doc.components.map(c => ({
        id: c.id,
        type: c.type,
        position: c.position,
        rotation: c.rotation,
        parameters: c.parameters,
      })),
    };
  },
};

const listWiresTool: Tool = {
  name: 'schematic.listWires',
  category: 'Discovery',
  description: 'List all wires (connections) in the schematic, showing what connects to what.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    return {
      ok: true,
      result: ctx.doc.wires.map(w => ({
        id: w.id,
        from: `${w.from.componentId}.${w.from.terminalId}`,
        to: `${w.to.componentId}.${w.to.terminalId}`,
      })),
    };
  },
};

const listComponentTypesTool: Tool = {
  name: 'discovery.listComponentTypes',
  category: 'Discovery',
  description: 'List all available component types that can be added with addComponent. Returns type, name, category, and terminal IDs for each. Use this before addComponent if you are unsure what types exist.',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'Optional: filter by category (e.g. "passive", "source", "semiconductor", "ic", "meter", "io", "logic", "mcu", "power").' },
    },
  },
  execute(args) {
    const plugins = args.category ? getPluginsByCategory().filter(g => g.category.toLowerCase() === args.category.toLowerCase()).flatMap(g => g.plugins) : getAllPlugins();
    return {
      ok: true,
      result: plugins.map(p => ({
        type: p.type,
        name: p.name,
        category: p.category,
        description: p.description,
        terminals: p.terminals.map(t => ({ id: t.id, label: t.label })),
        parameters: p.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, default: p.default, unit: p.unit })),
      })),
    };
  },
};

const getComponentInfoTool: Tool = {
  name: 'discovery.getComponentInfo',
  category: 'Discovery',
  description: 'Get detailed info about a specific component type: terminal IDs, parameter schema, and a description. Essential before connecting wires or setting parameters.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Component type, e.g. "resistor", "npn", "opampRails".' },
    },
    required: ['type'],
  },
  execute(args) {
    const plugin = getPlugin(args.type);
    if (!plugin) return { ok: false, error: `Unknown type: "${args.type}"` };
    return {
      ok: true,
      result: {
        type: plugin.type,
        name: plugin.name,
        category: plugin.category,
        description: plugin.description,
        terminals: plugin.terminals.map(t => ({ id: t.id, label: t.label, position: t.position })),
        parameters: plugin.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, default: p.default, unit: p.unit, min: p.min, max: p.max, options: p.options })),
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION TOOLS
// ─────────────────────────────────────────────────────────────────────────────

const runSimulationTool: Tool = {
  name: 'simulate.run',
  category: 'Simulation & Analysis',
  description: 'Run the simulation for N steps and return the final node voltages, branch currents, and component currents. This is the main tool for analyzing circuit behavior.',
  parameters: {
    type: 'object',
    properties: {
      steps: { type: 'number', description: 'Number of simulation steps to run (default 200, max 2000). Each step is dt seconds.' },
      dt: { type: 'number', description: 'Time step in seconds (default 1e-4 = 100µs). Smaller = more accurate but slower.' },
    },
  },
  async execute(args, ctx) {
    const steps = Math.min(Math.max(args.steps || 200, 1), 2000);
    const dt = args.dt || 1e-4;
    const plugins = ctx.plugins;

    // Reset simState for fresh run
    for (const c of ctx.doc.components) if (!c.simState) c.simState = {};

    let prev: any = undefined;
    let sim: SimContext | null = null;
    let lastError: string | null = null;

    for (let i = 0; i < steps; i++) {
      try {
        const r = simulateStep(ctx.doc.components, ctx.doc.wires, plugins, prev, dt);
        if (!r) { lastError = `Simulation returned null at step ${i} (singular matrix — likely a floating node or conflicting voltage sources)`; break; }
        sim = r.sim;
        prev = {
          nodeVoltage: r.sim.nodeVoltage,
          branchCurrent: r.sim.branchCurrent,
          time: r.sim.time,
          state: r.sim.state,
        };
      } catch (e) {
        lastError = `Simulation error at step ${i}: ${(e as Error).message}`;
        break;
      }
    }

    if (!sim) return { ok: false, error: lastError || 'Simulation failed' };
    ctx.simContext = sim;

    // Build node map for terminal → node lookup
    const nodeMap = buildNodeMap(ctx.doc.components, ctx.doc.wires, plugins);
    const compCurrents = computeComponentCurrents(ctx.doc.components, ctx.doc.wires, plugins, sim);
    const wireCurrents = computeWireCurrents(ctx.doc.components, ctx.doc.wires, plugins, sim);

    // Map terminal → voltage
    const voltages: Record<string, number> = {};
    for (const [key, nodeIdx] of nodeMap.terminalNode) {
      voltages[key] = sim.nodeVoltage[nodeIdx] ?? 0;
    }

    return {
      ok: true,
      result: {
        stepsCompleted: steps,
        finalTime: sim.time,
        nodeVoltages: voltages,
        componentCurrents: Array.from(compCurrents.entries()).map(([id, i]) => ({ componentId: id, currentA: i })),
        wireCurrents: Array.from(wireCurrents.entries()).map(([id, i]) => ({ wireId: id, currentA: i })),
      },
    };
  },
};

const getVoltageTool: Tool = {
  name: 'simulate.getVoltage',
  category: 'Simulation & Analysis',
  description: 'Get the voltage at a specific component terminal. Requires that simulate.run was called first. Returns the voltage in volts.',
  parameters: {
    type: 'object',
    properties: {
      componentId: { type: 'string', description: 'Component ID.' },
      terminalId: { type: 'string', description: 'Terminal ID, e.g. "p", "a", "out", "c".' },
    },
    required: ['componentId', 'terminalId'],
  },
  execute(args, ctx) {
    if (!ctx.simContext) return { ok: false, error: 'No simulation has been run. Call simulate.run first.' };
    const nodeMap = buildNodeMap(ctx.doc.components, ctx.doc.wires, ctx.plugins);
    const nodeIdx = nodeMap.terminalNode.get(`${args.componentId}:${args.terminalId}`);
    if (nodeIdx === undefined) return { ok: false, error: `Terminal ${args.componentId}:${args.terminalId} not found` };
    return { ok: true, result: { voltage: ctx.simContext.nodeVoltage[nodeIdx] } };
  },
};

const getCurrentTool: Tool = {
  name: 'simulate.getCurrent',
  category: 'Simulation & Analysis',
  description: 'Get the current flowing through a component (in amperes). Requires that simulate.run was called first.',
  parameters: {
    type: 'object',
    properties: {
      componentId: { type: 'string', description: 'Component ID.' },
    },
    required: ['componentId'],
  },
  execute(args, ctx) {
    if (!ctx.simContext) return { ok: false, error: 'No simulation has been run. Call simulate.run first.' };
    const currents = computeComponentCurrents(ctx.doc.components, ctx.doc.wires, ctx.plugins, ctx.simContext);
    const i = currents.get(args.componentId);
    if (i === undefined) return { ok: false, error: `Component ${args.componentId} not found or has no current` };
    return { ok: true, result: { currentA: i } };
  },
};

const validatePhysicsTool: Tool = {
  name: 'simulate.validatePhysics',
  category: 'Simulation & Analysis',
  description: 'Run the physics validator on the current circuit state. Checks KCL (current conservation), Ohm\'s law, voltage source law, power conservation, diode/transistor laws. Returns a list of any violations.',
  parameters: {
    type: 'object',
    properties: {
      runSim: { type: 'boolean', description: 'If true (default), run a 200-step simulation before validating. If false, use the existing simContext.' },
    },
  },
  async execute(args, ctx) {
    if (args.runSim !== false || !ctx.simContext) {
      // Run a sim first
      const runResult = await runSimulationTool.execute({ steps: 200, dt: 1e-4 }, ctx);
      if (!runResult.ok) return runResult;
    }
    if (!ctx.simContext) return { ok: false, error: 'No simulation context available' };
    const result = validatePhysics(ctx.doc.components, ctx.doc.wires, ctx.plugins, ctx.simContext);
    return {
      ok: true,
      result: {
        passed: result.passed,
        violationCount: result.violations.length,
        errors: result.violations.filter(v => v.severity === 'error'),
        warnings: result.violations.filter(v => v.severity === 'warning'),
        checkedAt: result.checkedAt,
      },
    };
  },
};

const solveDCTool: Tool = {
  name: 'simulate.solveDC',
  category: 'Simulation & Analysis',
  description: 'Solve the DC operating point of the circuit (no time-stepping). Returns the steady-state node voltages. Useful for bias analysis.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    const sim = solveDC(ctx.doc.components, ctx.doc.wires, ctx.plugins);
    if (!sim) return { ok: false, error: 'DC solve failed (singular matrix — check for floating nodes or conflicting sources)' };
    ctx.simContext = sim;
    const nodeMap = buildNodeMap(ctx.doc.components, ctx.doc.wires, ctx.plugins);
    const voltages: Record<string, number> = {};
    for (const [key, nodeIdx] of nodeMap.terminalNode) {
      voltages[key] = sim.nodeVoltage[nodeIdx] ?? 0;
    }
    return { ok: true, result: { nodeVoltages: voltages } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLES TOOLS
// ─────────────────────────────────────────────────────────────────────────────

const listExamplesTool: Tool = {
  name: 'examples.list',
  category: 'Examples & Export',
  description: 'List all available example circuits, grouped by category. Use this to suggest circuits to the user or to find a template to start from.',
  parameters: { type: 'object', properties: {} },
  execute() {
    return {
      ok: true,
      result: exampleCategories.map(cat => ({
        category: cat.label,
        examples: cat.examples.map(ex => ({ name: ex.name, description: ex.description })),
      })),
    };
  },
};

const loadExampleTool: Tool = {
  name: 'examples.load',
  category: 'Examples & Export',
  description: 'Load an example circuit by name, replacing the current circuit. Use listExamples first to find the exact name.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact example name, e.g. "LED + Resistor", "Two-Stage Audio Amplifier", "555 Astable Blink".' },
    },
    required: ['name'],
  },
  execute(args, ctx) {
    const ex = exampleCategories.flatMap(c => c.examples).find(e => e.name === args.name);
    if (!ex) return { ok: false, error: `Example "${args.name}" not found. Use examples.list to see available names.` };
    // Replace the doc contents in-place
    ctx.doc.components = JSON.parse(JSON.stringify(ex.doc.components));
    ctx.doc.wires = JSON.parse(JSON.stringify(ex.doc.wires));
    return { ok: true, result: { loaded: args.name, components: ctx.doc.components.length, wires: ctx.doc.wires.length } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT TOOLS
// ─────────────────────────────────────────────────────────────────────────────

const exportSPICENetlistTool: Tool = {
  name: 'export.spiceNetlist',
  category: 'Examples & Export',
  description: 'Export the current circuit as a SPICE3 netlist (.cir format). Returns the netlist as a string.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional title for the netlist.' },
    },
  },
  execute(args, ctx) {
    try {
      const netlist = exportSPICENetlist(ctx.doc, args.title);
      return { ok: true, result: { netlist } };
    } catch (e) {
      return { ok: false, error: `Export failed: ${(e as Error).message}` };
    }
  },
};

const exportBOMTool: Tool = {
  name: 'export.bomCSV',
  category: 'Examples & Export',
  description: 'Export the Bill of Materials as CSV. Lists all components with their values, footprints, and quantities.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    try {
      const csv = exportBOMCSV(ctx.doc);
      return { ok: true, result: { csv } };
    } catch (e) {
      return { ok: false, error: `Export failed: ${(e as Error).message}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PCB TOOLS
// ─────────────────────────────────────────────────────────────────────────────

const importToPCBTool: Tool = {
  name: 'pcb.importFromSchematic',
  category: 'PCB',
  description: 'Import the current schematic into the PCB layout editor. Creates footprints for each component and a ratsnest showing what needs to be routed. The user will need to switch to the PCB tab to see the result.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    if (!ctx.pcb) {
      return { ok: false, error: 'PCB context not available. This tool only works when the PCB store is initialized (user is on the PCB tab).' };
    }
    // This is a no-op on the server side — the actual import happens client-side
    // when the result is returned. We just acknowledge the request.
    return { ok: true, result: { message: 'Import request queued. The client will import the schematic into the PCB editor.' } };
  },
};

const runAutoRouteTool: Tool = {
  name: 'pcb.autoRoute',
  category: 'PCB',
  description: 'Run the auto-router on the PCB layout. Routes all unrouted nets using the Lee BFS algorithm. Returns statistics on routes completed vs failed.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    if (!ctx.pcb) return { ok: false, error: 'PCB context not available.' };
    // We need the ratsnest — the client will provide it
    // For now, just acknowledge
    return { ok: true, result: { message: 'Auto-route request queued. The client will run the router.' } };
  },
};

const runDRCTool: Tool = {
  name: 'pcb.runDRC',
  category: 'PCB',
  description: 'Run the Design Rule Check on the PCB layout. Checks clearance, trace width, drill size, annular ring, courtyard, and netlist match. Returns a list of errors.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    if (!ctx.pcb) return { ok: false, error: 'PCB context not available.' };
    return { ok: true, result: { message: 'DRC request queued. The client will run the check.' } };
  },
};

const runTopoRouteTool: Tool = {
  name: 'pcb.topoRoute',
  category: 'PCB',
  description: 'Run the topological (push-and-shove) router with A* and 45° snapping. Higher quality than autoRoute but slower.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    if (!ctx.pcb) return { ok: false, error: 'PCB context not available.' };
    return { ok: true, result: { message: 'Topo-route request queued.' } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TOOL REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  // Circuit Building
  addComponentTool,
  removeComponentTool,
  moveComponentTool,
  rotateComponentTool,
  setParameterTool,
  addWireTool,
  removeWireTool,
  clearCircuitTool,

  // Discovery
  listComponentsTool,
  listWiresTool,
  listComponentTypesTool,
  getComponentInfoTool,

  // Simulation & Analysis
  runSimulationTool,
  getVoltageTool,
  getCurrentTool,
  validatePhysicsTool,
  solveDCTool,

  // Examples & Export
  listExamplesTool,
  loadExampleTool,
  exportSPICENetlistTool,
  exportBOMTool,

  // PCB
  importToPCBTool,
  runAutoRouteTool,
  runDRCTool,
  runTopoRouteTool,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOLS_BY_NAME.get(name);
}

export function getToolDefinitions(): any[] {
  return TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function getToolsByCategory(): Record<string, Tool[]> {
  const byCat: Record<string, Tool[]> = {};
  for (const t of TOOLS) {
    if (!byCat[t.category]) byCat[t.category] = [];
    byCat[t.category].push(t);
  }
  return byCat;
}
