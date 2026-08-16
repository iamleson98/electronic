// PCB BOARD SETUP TOOLS
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

const setBoardSizeTool: Tool = {
  name: 'pcb.setBoardSize',
  category: 'PCB',
  description: 'Set the PCB board outline dimensions in millimeters.',
  parameters: {
    type: 'object',
    properties: {
      width: { type: 'number', description: 'Board width in mm (e.g. 80)' },
      height: { type: 'number', description: 'Board height in mm (e.g. 60)' },
    },
    required: ['width', 'height'],
  },
  execute(args) { return { ok: true, result: { action: 'setBoardSize', width: args.width, height: args.height } }; },
};

const setDefaultTraceWidthTool: Tool = {
  name: 'pcb.setDefaultTraceWidth',
  category: 'PCB',
  description: 'Set the default trace width for new PCB routes (in mm). Typical: 0.3mm for signals, 0.5mm for power.',
  parameters: {
    type: 'object',
    properties: {
      width: { type: 'number', description: 'Trace width in mm' },
    },
    required: ['width'],
  },
  execute(args) { return { ok: true, result: { action: 'setDefaultTraceWidth', width: args.width } }; },
};

const setActiveLayerTool: Tool = {
  name: 'pcb.setActiveLayer',
  category: 'PCB',
  description: 'Set the active copper layer for routing (top or bottom).',
  parameters: {
    type: 'object',
    properties: {
      layer: { type: 'string', enum: ['top', 'bottom'], description: 'Layer to make active' },
    },
    required: ['layer'],
  },
  execute(args) { return { ok: true, result: { action: 'setActiveLayer', layer: args.layer } }; },
};

const addCopperPourTool: Tool = {
  name: 'pcb.addCopperPour',
  category: 'PCB',
  description: 'Generate a copper pour (ground plane) on a layer for a specified net. Fills all empty area with copper connected to that net.',
  parameters: {
    type: 'object',
    properties: {
      layer: { type: 'string', enum: ['top', 'bottom'], description: 'Layer to pour on' },
      net: { type: 'string', description: 'Net name to connect the pour to (e.g. "GND", "VCC")' },
    },
    required: ['layer', 'net'],
  },
  execute(args) { return { ok: true, result: { action: 'addCopperPour', layer: args.layer, net: args.net } }; },
};

const generateTeardropsTool: Tool = {
  name: 'pcb.generateTeardrops',
  category: 'PCB',
  description: 'Generate teardrops at trace-pad junctions to improve manufacturability (prevents drill breakout).',
  parameters: { type: 'object', properties: {} },
  execute() { return { ok: true, result: { action: 'generateTeardrops' } }; },
};

const verifyNetlistTool: Tool = {
  name: 'pcb.verifyNetlist',
  category: 'PCB',
  description: 'Verify that the PCB netlist matches the schematic netlist. Catches missing connections, wrong nets, short circuits.',
  parameters: { type: 'object', properties: {} },
  execute() { return { ok: true, result: { action: 'verifyNetlist' } }; },
};

// ─────────────────────────────────────────────────────────────────────────────

export { setBoardSizeTool, setDefaultTraceWidthTool, setActiveLayerTool, addCopperPourTool, generateTeardropsTool, verifyNetlistTool };
