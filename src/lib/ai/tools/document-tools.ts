// DOCUMENT TOOLS
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

const serializeDocumentTool: Tool = {
  name: 'schematic.serialize',
  category: 'Discovery',
  description: 'Get the full current circuit document as JSON (components, wires, metadata). Useful for understanding the complete state.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    return {
      ok: true,
      result: {
        version: ctx.doc.version,
        componentCount: ctx.doc.components.length,
        wireCount: ctx.doc.wires.length,
        components: ctx.doc.components.map(c => ({ id: c.id, type: c.type, position: c.position, rotation: c.rotation, parameters: c.parameters })),
        wires: ctx.doc.wires.map(w => ({ id: w.id, from: w.from, to: w.to })),
      },
    };
  },
};

const exportKiCadNetlistTool: Tool = {
  name: 'export.kiCadNetlist',
  category: 'Examples & Export',
  description: 'Export the circuit as a KiCad XML netlist (.net format) for importing into KiCad\'s PCB editor.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    try {
      const netlist = exportKiCadNetlist(ctx.doc);
      return { ok: true, result: { netlist } };
    } catch (e) {
      return { ok: false, error: `Export failed: ${(e as Error).message}` };
    }
  },
};

const loadDocumentTool: Tool = {
  name: 'schematic.loadDocument',
  category: 'Circuit Building',
  description: 'Replace the entire circuit with a provided document (components + wires). Use this to load a previously-saved circuit or apply a large batch of changes at once.',
  parameters: {
    type: 'object',
    properties: {
      components: {
        type: 'array',
        description: 'Array of component objects, each with {id, type, position:{x,y}, rotation, parameters}',
        items: { type: 'object' },
      },
      wires: {
        type: 'array',
        description: 'Array of wire objects, each with {id, from:{componentId,terminalId}, to:{componentId,terminalId}}',
        items: { type: 'object' },
      },
    },
    required: ['components', 'wires'],
  },
  execute(args, ctx) {
    ctx.doc.components = args.components;
    ctx.doc.wires = args.wires;
    return { ok: true, result: { componentsLoaded: args.components.length, wiresLoaded: args.wires.length } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { serializeDocumentTool, exportKiCadNetlistTool, loadDocumentTool };
