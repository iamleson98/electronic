// SCHEMATIC COMPONENT TOOLS
// Auto-extracted from the original ai/tools/index.ts during refactor.

import type { Tool } from './types';
import { genId, findComponent } from './helpers';
import type { CircuitComponent, Wire } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';
import { orthogonalizePath } from '@/lib/circuit/wire-geometry';
import { simplifyPath, pathToWaypoints } from '@/lib/circuit/smart-wire-router';
import { resolveEndpointGridPos } from '@/lib/circuit/endpoint-position';
import { parseStrictSpiceNumber } from '@/lib/circuit/measurement';

/**
 * Coerce a model-supplied parameter value to the plugin's declared type.
 * Numbers accept unit-suffixed strings ("4k7", "10u", "1Meg") via the SPICE
 * parser — a raw "10k" string used to assign 10 (1000× error) or NaN.
 */
export function coerceParamValue(def: { type: string }, raw: unknown, fallback: unknown): unknown {
  if (raw === null || raw === undefined) return fallback;
  if (def.type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = parseStrictSpiceNumber(raw);
      if (parsed !== null) return parsed;
      const f = parseFloat(raw);
      return Number.isFinite(f) ? f : fallback;
    }
    return fallback;
  }
  if (def.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (['true', '1', 'yes', 'on', 'high'].includes(t)) return true;
      if (['false', '0', 'no', 'off', 'low'].includes(t)) return false;
    }
    if (typeof raw === 'number') return raw !== 0;
    return fallback;
  }
  return raw;
}

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
      // Record the requested type so the turn runner can surface it to the
      // user as a "Missing components" card — the AI is blocked on library
      // availability the user can fix (Symbol Editor / Sub-Circuit dialog).
      if (typeof args.type === 'string' && args.type.trim()) {
        if (!ctx.missingComponents) ctx.missingComponents = new Set();
        ctx.missingComponents.add(args.type.trim());
      }
      return { ok: false, error: `Unknown component type: "${args.type}". Use listComponentTypes to see available types. If the user needs this component, tell them it is missing from the library so they can add it.` };
    }
    const id = genId(args.type);
    const defaults: any = {};
    for (const p of plugin.parameters) defaults[p.key] = p.default;
    // Models routinely send explicit nulls for parameters they don't care
    // about (e.g. {resistance: null}) — a null would override the plugin
    // default here and later crash label rendering / the solver. Drop them.
    // Unit-suffixed strings ("4k7", "10u") are coerced via the SPICE parser.
    const overrides: Record<string, any> = {};
    for (const [k, v] of Object.entries(args.parameters || {})) {
      if (v === null || v === undefined) continue;
      const def = plugin.parameters.find((p) => p.key === k);
      overrides[k] = def ? coerceParamValue(def, v, defaults[k]) : v;
    }
    const comp: CircuitComponent = {
      id,
      type: args.type,
      position: { x: args.x, y: args.y },
      rotation: 0,
      parameters: { ...defaults, ...overrides },
    };
    ctx.doc.components.push(comp);
    // Topology changed — invalidate any cached simulation (node ids get
    // renumbered; a stale simContext would silently return wrong-node data).
    ctx.simContext = null;
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
    ctx.simContext = null; // topology changed — node ids renumbered
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
    // Guard against null/undefined values — models sometimes send them
    // explicitly; they would poison the parameter and crash rendering.
    if (args.value === null || args.value === undefined) {
      return { ok: false, error: `Parameter "${args.key}" value cannot be null — pass a number/string/boolean.` };
    }
    // Unit-safe: coerce "10k"/"4u7"/"1Meg" strings via the SPICE parser so a
    // raw string can never assign 10 for "10k" (1000× error).
    const plugin = getPlugin(comp.type);
    const def = plugin?.parameters.find((p) => p.key === args.key);
    const coerced = def ? coerceParamValue(def, args.value, comp.parameters[args.key]) : args.value;
    comp.parameters[args.key] = coerced as number | string | boolean;
    // A `net` parameter change on a label/power symbol rewires connectivity —
    // and any parameter change invalidates the cached solve's physics.
    ctx.simContext = null;
    return { ok: true, result: { id: args.id, key: args.key, value: coerced } };
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
      // The editor's wire style is strictly orthogonal (Ox/OY) — the
      // renderer draws waypoints verbatim, so a diagonal LLM waypoint would
      // render a slanted wire. Orthogonalize with the same elbow semantics
      // the interactive editor uses at commit time (store.completeWire).
      const from = resolveEndpointGridPos(wire.from, ctx.doc.components, ctx.doc.sheets ?? []);
      const to = resolveEndpointGridPos(wire.to, ctx.doc.components, ctx.doc.sheets ?? []);
      const rawWps = args.waypoints.map(([x, y]: [number, number]) => ({ x, y }));
      let wps: { x: number; y: number }[] = rawWps;
      if (from && to) {
        wps = pathToWaypoints(simplifyPath([from, ...orthogonalizePath(from, to, rawWps), to]));
      }
      if (wps.length > 0) (wire as any).waypoints = wps;
    }
    ctx.doc.wires.push(wire);
    ctx.simContext = null; // topology changed — node ids renumbered
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
    ctx.simContext = null; // topology changed — node ids renumbered
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
    ctx.simContext = null;
    return { ok: true, result: { cleared: true, componentsRemoved: compCount, wiresRemoved: wireCount } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { addComponentTool, removeComponentTool, moveComponentTool, rotateComponentTool, setParameterTool, addWireTool, removeWireTool, clearCircuitTool };
