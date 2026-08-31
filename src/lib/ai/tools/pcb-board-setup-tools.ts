// PCB BOARD SETUP TOOLS
// Auto-extracted from the original ai/tools/index.ts during refactor.
//
// Split execution model:
//   - pcb.setBoardSize mutates the SERVER-side PCB state when it exists (so
//     subsequent auto-route/DRC runs see the new board) and falls back to a
//     client-queued action when no PCB is loaded yet.
//   - Trace width / active layer / copper pour / teardrops are client-queued
//     actions (interactive-editor concerns): the tool result carries an
//     `action` field, which the chat client executes against the live PCB store.

import type { Tool } from './types';

// ─────────────────────────────────────────────────────────────────────────────

const setBoardSizeTool: Tool = {
  name: 'pcb.setBoardSize',
  category: 'PCB',
  description: 'Set the PCB board outline dimensions in millimeters. Server-side when a PCB is loaded (auto-route/DRC use the new size); queued to the client otherwise.',
  parameters: {
    type: 'object',
    properties: {
      width: { type: 'number', description: 'Board width in mm (e.g. 80)' },
      height: { type: 'number', description: 'Board height in mm (e.g. 60)' },
    },
    required: ['width', 'height'],
  },
  execute(args, ctx) {
    const w = Number(args.width);
    const h = Number(args.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return { ok: false, error: 'Board dimensions must be positive numbers (mm).' };
    }
    if (ctx.pcb) {
      ctx.pcb.board = { width: w, height: h };
      return { ok: true, result: { width: w, height: h, applied: 'server', message: `Board resized to ${w}×${h}mm — re-run pcb.autoRoute to use the new space.` } };
    }
    return { ok: true, result: { action: 'setBoardSize', width: w, height: h } };
  },
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

// ─────────────────────────────────────────────────────────────────────────────

export { setBoardSizeTool, setDefaultTraceWidthTool, setActiveLayerTool, addCopperPourTool, generateTeardropsTool };
