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
  // NOTE: the server never carries a live PCB store (ctx.pcb is unset on the
  // API routes) — these tools are CLIENT-EXECUTED, like simulate.start etc.
  // Returning ok:false here would tell the model the action failed (it would
  // apologize/retry) while the client actually ran it successfully.
  execute() {
    return { ok: true, result: { action: 'importFromSchematic', message: 'Import queued. The client will import the schematic into the PCB editor — tell the user to switch to the PCB tab to see it.' } };
  },
};

const runAutoRouteTool: Tool = {
  name: 'pcb.autoRoute',
  category: 'PCB',
  description: 'Run the auto-router on the PCB layout. Routes all unrouted nets using the Lee BFS algorithm. Returns statistics on routes completed vs failed.',
  parameters: { type: 'object', properties: {} },
  execute() {
    return { ok: true, result: { action: 'autoRoute', message: 'Auto-route queued. The client will run the Lee BFS router and report routed vs failed nets.' } };
  },
};

const runDRCTool: Tool = {
  name: 'pcb.runDRC',
  category: 'PCB',
  description: 'Run the Design Rule Check on the PCB layout. Checks clearance, trace width, drill size, annular ring, courtyard, and netlist match. Returns a list of errors.',
  parameters: { type: 'object', properties: {} },
  execute() {
    return { ok: true, result: { action: 'runDRC', message: 'DRC queued. The client will run the check and display the results in the PCB tab.' } };
  },
};

const runTopoRouteTool: Tool = {
  name: 'pcb.topoRoute',
  category: 'PCB',
  description: 'Run the topological (push-and-shove) router with A* and 45° snapping. Higher quality than autoRoute but slower.',
  parameters: { type: 'object', properties: {} },
  execute() {
    return { ok: true, result: { action: 'topoRoute', message: 'Topo-route queued. The client will run the topological router.' } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { importToPCBTool, runAutoRouteTool, runDRCTool, runTopoRouteTool };
