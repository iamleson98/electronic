// EXPORT TOOLS
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

export { exportSPICENetlistTool, exportBOMTool };
