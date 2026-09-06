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
  description: 'Set the default trace width for new PCB routes (in mm). Server-side when a PCB is loaded (verified by re-running DRC); queued to the client otherwise. Typical: 0.3mm signals, 0.5mm+ power.',
  parameters: {
    type: 'object',
    properties: {
      width: { type: 'number', description: 'Trace width in mm' },
    },
    required: ['width'],
  },
  execute(args, ctx) {
    const w = Number(args.width);
    if (!Number.isFinite(w) || w <= 0 || w > 10) {
      return { ok: false, error: 'Trace width must be a positive number ≤ 10mm.' };
    }
    if (ctx.pcb) {
      ctx.pcb.defaultTraceWidth = w;
      // Server-verify: re-run DRC so the model sees violations immediately.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { runDRC, DEFAULT_DRC_CONFIG } = require('@/lib/pcb/drc');
        const errors = runDRC(ctx.pcb.footprints ?? [], ctx.pcb.traces ?? [], ctx.pcb.vias ?? [], ctx.pcb.ratsnest ?? [], ctx.pcb.board, DEFAULT_DRC_CONFIG);
        return { ok: true, result: { width: w, applied: 'server', drcErrors: errors.length, message: `Default trace width set to ${w}mm (DRC: ${errors.length} issue(s)).` } };
      } catch {
        return { ok: true, result: { width: w, applied: 'server' } };
      }
    }
    return { ok: true, result: { action: 'setDefaultTraceWidth', width: w } };
  },
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
  description: 'Generate a copper pour (ground plane) on a layer for a specified net. Server-side when a PCB is loaded (real pour geometry + DRC-verified); queued to the client otherwise.',
  parameters: {
    type: 'object',
    properties: {
      layer: { type: 'string', enum: ['top', 'bottom'], description: 'Layer to pour on' },
      net: { type: 'string', description: 'Net name to connect the pour to (e.g. "GND", "VCC")' },
    },
    required: ['layer', 'net'],
  },
  execute(args, ctx) {
    if (ctx.pcb) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { generateCopperPour } = require('@/lib/pcb/copper-pour');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { runDRC, DEFAULT_DRC_CONFIG } = require('@/lib/pcb/drc');
        const pour = generateCopperPour(args.layer, args.net, ctx.pcb.footprints ?? [], ctx.pcb.traces ?? [], ctx.pcb.vias ?? [], ctx.pcb.board);
        ctx.pcb.copperPours = [...(ctx.pcb.copperPours ?? []).filter((p: { layer: string; net: string }) => !(p.layer === args.layer && p.net === args.net)), pour];
        const errors = runDRC(ctx.pcb.footprints ?? [], ctx.pcb.traces ?? [], ctx.pcb.vias ?? [], ctx.pcb.ratsnest ?? [], ctx.pcb.board, DEFAULT_DRC_CONFIG);
        return { ok: true, result: { applied: 'server', layer: args.layer, net: args.net, drcErrors: errors.length, message: `Copper pour on ${args.layer} for ${args.net} generated server-side (DRC: ${errors.length} issue(s)).` } };
      } catch (e) {
        return { ok: false, error: `Pour failed: ${(e as Error).message}` };
      }
    }
    return { ok: true, result: { action: 'addCopperPour', layer: args.layer, net: args.net } };
  },
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
