// AI Tool Registry — imports all tool definitions from category files and
// builds the TOOLS array + lookup maps.
//
// Tool definitions are split into category files:
//   - schematic-component-tools.ts  (add/remove/move/rotate/wire)
//   - schematic-inspection-tools.ts  (list/get components)
//   - simulation-tools.ts            (run sim, get V/I, validate, solve DC)
//   - simulation-control-tools.ts    (start/pause/reset/setSpeed)
//   - examples-tools.ts              (list/load examples)
//   - export-tools.ts                 (export SPICE/BOM)
//   - pcb-tools.ts                    (import to PCB, auto-route, DRC)
//   - pcb-board-setup-tools.ts        (board size, trace width, layers, etc.)
//   - erc-annotation-tools.ts         (ERC, reannotate)
//   - search-tools.ts                 (find component)
//   - document-tools.ts               (serialize, export netlist, load doc)
//   - diagnostic-tools.ts             (AI root-cause diagnosis)
//   - kb-tools.ts                     (knowledge base lookup/search)
//   - whatif-tools.ts                 (non-mutating what-if simulation)

import type { Tool, ToolContext } from './types';
export type { Tool, ToolContext, ToolResult } from './types';

import { addComponentTool, removeComponentTool, moveComponentTool, rotateComponentTool, setParameterTool, addWireTool, removeWireTool, clearCircuitTool } from './schematic-component-tools';
import { listComponentsTool, listWiresTool, listComponentTypesTool, getComponentInfoTool, describeCircuitTool } from './schematic-inspection-tools';
import { runSimulationTool, getVoltageTool, getCurrentTool, validatePhysicsTool, solveDCTool } from './simulation-tools';
import { startSimulationTool, pauseSimulationTool, resetSimulationTool, setSimulationSpeedTool } from './simulation-control-tools';
import { listExamplesTool, loadExampleTool } from './examples-tools';
import { exportSPICENetlistTool, exportBOMTool } from './export-tools';
import { importToPCBTool, runAutoRouteTool, runDRCTool, runTopoRouteTool } from './pcb-tools';
import { setBoardSizeTool, setDefaultTraceWidthTool, setActiveLayerTool, addCopperPourTool, generateTeardropsTool, verifyNetlistTool } from './pcb-board-setup-tools';
import { runERCTool, reannotateTool } from './erc-annotation-tools';
import { findComponentTool } from './search-tools';
import { serializeDocumentTool, exportKiCadNetlistTool, loadDocumentTool } from './document-tools';
import { diagnoseCircuitTool } from './diagnostic-tools';
import { kbLookupTool, kbSearchTool, kbListByCategoryTool, kbRelatedTool, kbListCategoriesTool } from './kb-tools';
import { simulateWhatIfTool } from './whatif-tools';
import { simulateSweepTool } from './sweep-tools';
import { designCalculateTool } from './design-calculators';
import { designBuildPatternTool } from './design-patterns';

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
  reannotateTool,
  loadDocumentTool,

  // Discovery
  listComponentsTool,
  listWiresTool,
  listComponentTypesTool,
  getComponentInfoTool,
  findComponentTool,
  serializeDocumentTool,
  describeCircuitTool,

  // Simulation & Analysis
  runSimulationTool,
  getVoltageTool,
  getCurrentTool,
  validatePhysicsTool,
  solveDCTool,
  runERCTool,

  // Simulation Control (client-side)
  startSimulationTool,
  pauseSimulationTool,
  resetSimulationTool,
  setSimulationSpeedTool,

  // AI-Powered Diagnosis, Teaching & Design
  diagnoseCircuitTool,
  simulateWhatIfTool,
  simulateSweepTool,
  designCalculateTool,
  designBuildPatternTool,

  // Knowledge Base
  kbLookupTool,
  kbSearchTool,
  kbListByCategoryTool,
  kbRelatedTool,
  kbListCategoriesTool,

  // Examples & Export
  listExamplesTool,
  loadExampleTool,
  exportSPICENetlistTool,
  exportBOMTool,
  exportKiCadNetlistTool,

  // PCB
  importToPCBTool,
  runAutoRouteTool,
  runDRCTool,
  runTopoRouteTool,
  setBoardSizeTool,
  setDefaultTraceWidthTool,
  setActiveLayerTool,
  addCopperPourTool,
  generateTeardropsTool,
  verifyNetlistTool,
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
