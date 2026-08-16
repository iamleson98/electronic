// PCB TOOLS
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

export { importToPCBTool, runAutoRouteTool, runDRCTool, runTopoRouteTool };
