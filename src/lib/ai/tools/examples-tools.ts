// EXAMPLES TOOLS
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

export { listExamplesTool, loadExampleTool };
