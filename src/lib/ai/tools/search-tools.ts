// SEARCH TOOLS
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

const findComponentTool: Tool = {
  name: 'schematic.findComponent',
  category: 'Discovery',
  description: 'Find components by type, partial ID match, or parameter value. Returns matching component IDs.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Optional: component type to match (e.g. "resistor", "led")' },
      idContains: { type: 'string', description: 'Optional: substring to match in component ID' },
      parameterKey: { type: 'string', description: 'Optional: parameter key to check (e.g. "resistance")' },
      parameterValue: { description: 'Optional: parameter value to match' },
    },
  },
  execute(args, ctx) {
    let results = ctx.doc.components;
    if (args.type) results = results.filter(c => c.type === args.type);
    if (args.idContains) results = results.filter(c => c.id.includes(args.idContains));
    if (args.parameterKey) {
      results = results.filter(c => c.parameters[args.parameterKey] !== undefined);
      if (args.parameterValue !== undefined) {
        results = results.filter(c => c.parameters[args.parameterKey] == args.parameterValue);
      }
    }
    return {
      ok: true,
      result: results.map(c => ({ id: c.id, type: c.type, position: c.position, parameters: c.parameters })),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { findComponentTool };
