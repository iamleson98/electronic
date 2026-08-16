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

export { listComponentsTool, listWiresTool, listComponentTypesTool, getComponentInfoTool };
