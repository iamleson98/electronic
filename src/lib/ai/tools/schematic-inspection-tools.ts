// SCHEMATIC INSPECTION TOOLS
// Auto-extracted from the original ai/tools/index.ts during refactor.

import type { Tool } from './types';
import type { ToolContext } from './types';
import { genId, findComponent } from './helpers';
import type { CircuitDocument, CircuitComponent, Wire, SimContext } from '@/lib/circuit/types';
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
// schematic.describe — one-call netlist-style grounding summary.
// ─────────────────────────────────────────────────────────────────────────────
// The AI's biggest failure mode on COMPLEX circuits is losing track of what
// connects to what. This tool computes the actual netlist (union of terminals
// over wires), names the nets, flags floating pins, and detects supply rails —
// everything needed to reason about an existing circuit in a single call.

const describeCircuitTool: Tool = {
  name: 'schematic.describe',
  category: 'Discovery',
  description:
    'One-call netlist-style summary of the ENTIRE circuit: components with their key values, all nets (which terminals are electrically connected), floating/unwired pins, and detected supply rails. Use this FIRST when you need to understand or debug a circuit the user built — it is much more compact than listComponents + listWires and shows connectivity directly.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    const { components, wires } = ctx.doc;

    // Union-find over terminal keys "compId:termId"
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      // path compression
      let cur = x;
      while (parent.get(cur) !== cur) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    // Every terminal of every component is a node
    for (const c of components) {
      const plugin = getPlugin(c.type);
      if (!plugin) continue;
      for (const t of plugin.terminals) {
        const key = `${c.id}:${t.id}`;
        if (!parent.has(key)) parent.set(key, key);
      }
    }
    const wiredTerminals = new Set<string>();
    for (const w of wires) {
      union(`${w.from.componentId}:${w.from.terminalId}`, `${w.to.componentId}:${w.to.terminalId}`);
      wiredTerminals.add(`${w.from.componentId}:${w.from.terminalId}`);
      wiredTerminals.add(`${w.to.componentId}:${w.to.terminalId}`);
    }

    // Group terminals into nets
    const nets = new Map<string, string[]>();
    for (const key of parent.keys()) {
      const root = find(key);
      if (!nets.has(root)) nets.set(root, []);
      nets.get(root)!.push(key);
    }

    // Classify nets
    const groundNets: string[] = [];
    const railNets: Array<{ net: string; label: string }> = [];
    const signalNets: Array<{ net: string; members: string[] }> = [];
    const dangling: string[] = [];

    const compById = new Map(components.map(c => [c.id, c]));
    for (const [root, members] of nets) {
      const isGround = members.some(m => {
        const [cid] = m.split(':');
        return compById.get(cid)?.type === 'ground';
      });
      if (isGround) { groundNets.push(`N${[...nets.keys()].indexOf(root) + 1}`); continue; }
      // Supply rail: contains the p terminal of a DC source or a rail-type param source
      const railMember = members.find(m => {
        const [cid, tid] = m.split(':');
        const c = compById.get(cid);
        if (!c) return false;
        if (c.type === 'dcVoltage' && tid === 'p') return true;
        if (c.type === 'customPowerRail') return true;
        return false;
      });
      if (railMember) {
        const [cid] = railMember.split(':');
        const c = compById.get(cid)!;
        railNets.push({ net: `N${[...nets.keys()].indexOf(root) + 1}`, label: `+${(c.parameters as any).voltage ?? '?'}V (${c.id})` });
        continue;
      }
      if (members.length > 1) {
        signalNets.push({ net: `N${[...nets.keys()].indexOf(root) + 1}`, members });
      }
    }

    // Dangling terminals: not touched by any wire (and not a no-connect-style part)
    const skipTypes = new Set(['ground', 'netLabel', 'globalLabel', 'hierLabel', 'noConnect', 'powerFlag', 'busLabel', 'busEntry', 'junction', 'testPoint', 'connector']);
    for (const c of components) {
      if (skipTypes.has(c.type)) continue;
      const plugin = getPlugin(c.type);
      if (!plugin) continue;
      for (const t of plugin.terminals) {
        const key = `${c.id}:${t.id}`;
        if (!wiredTerminals.has(key)) dangling.push(key);
      }
    }

    // Compact component list with the 2-3 most informative params
    const keyParams = ['resistance', 'capacitance', 'inductance', 'voltage', 'amplitude', 'frequency', 'zenerV', 'forwardV', 'hfe', 'gain', 'outputV', 'r1', 'r2', 'c', 'ratio', 'astable', 'field', 'turnsRatio'];
    const compSummary = components.map(c => {
      const shown: Record<string, any> = {};
      for (const k of keyParams) {
        if (c.parameters[k] !== undefined && c.parameters[k] !== null && c.parameters[k] !== '') shown[k] = c.parameters[k];
      }
      return { id: c.id, type: c.type, ...(Object.keys(shown).length ? { values: shown } : {}) };
    });

    return {
      ok: true,
      result: {
        componentCount: components.length,
        wireCount: wires.length,
        components: compSummary,
        netCount: nets.size,
        groundNets: groundNets.length,
        supplyRails: railNets,
        signalNets: signalNets.map(s => ({
          net: s.net,
          size: s.members.length,
          members: s.members,
        })),
        floatingPins: dangling,
        hints: [
          dangling.length > 0 ? `${dangling.length} unwired pin(s) — check whether they should be connected (e.g. source n → ground).` : 'All pins wired.',
          ...(groundNets.length === 0 && components.length > 0 ? ['No ground in the circuit — the simulator requires a ground reference!'] : []),
        ],
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { listComponentsTool, listWiresTool, listComponentTypesTool, getComponentInfoTool, describeCircuitTool };
