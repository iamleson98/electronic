// PCB TOOLS
// Auto-extracted from the original ai/tools/index.ts during refactor.
//
// These tools now execute SERVER-SIDE on a real PCB state (ctx.pcb):
//   - pcb.importFromSchematic builds footprints/ratsnest/padNets via the same
//     createPCBFromSchematic pipeline the client uses (smart placement);
//   - pcb.autoRoute / pcb.topoRoute run the real routers and return ACTUAL
//     statistics (routed/failed/vias/length) the model can reason about;
//   - pcb.runDRC / pcb.verifyNetlist return the real error lists so the AI
//     can verify its own PCB work and iterate until it passes.
// The turn runner snapshots ctx.pcb into `pcb_update` SSE events, so the
// user's PCB view follows along live (switch to the PCB tab to watch).

import type { Tool } from './types';
import type { ToolContext } from './types';
import type { Footprint } from '@/lib/pcb/types';
import { createPCBFromSchematic } from '@/lib/pcb/netlist-sync';
import { autoRoute, type AutoRouteResult } from '@/lib/pcb/auto-router';
import { routeTopologically, DEFAULT_ROUTER_OPTIONS } from '@/lib/pcb/topological-router';
import { runDRC } from '@/lib/pcb/drc';
import { verifyNetlist, type NetlistVerifyResult } from '@/lib/pcb/netlist-verify';

// ─────────────────────────────────────────────────────────────────────────────

const importToPCBTool: Tool = {
  name: 'pcb.importFromSchematic',
  category: 'PCB',
  description: 'Import the current schematic into the PCB layout (server-side): creates footprints with smart placement, a ratsnest, and the board outline. Run this BEFORE any other PCB tool. Returns footprint count, net count and board size.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    if (ctx.doc.components.length === 0) {
      return { ok: false, error: 'The schematic is empty — add components before importing to PCB.' };
    }
    const { footprints, ratsnest, padNets, board } = createPCBFromSchematic(ctx.doc.components, ctx.doc.wires);
    ctx.pcb = {
      board,
      footprints,
      traces: [],
      vias: [],
      ratsnest,
      padNets,
    };
    const netCount = new Set(ratsnest.map((r) => r.net)).size;
    return {
      ok: true,
      result: {
        footprints: footprints.length,
        ratsnestConnections: ratsnest.length,
        nets: netCount,
        board: { width: board.width, height: board.height },
        message: 'PCB created from schematic. The user can watch it live on the PCB tab.',
      },
    };
  },
};

/** Re-run DRC and return a compact summary (shared by route tools). */
function drcSummary(ctx: ToolContext): { errorCount: number; warningCount: number; topIssues: string[] } {
  const pcb = ctx.pcb!;
  const errors = runDRC(pcb.footprints, pcb.traces, pcb.vias, pcb.ratsnest, pcb.board);
  const errorCount = errors.filter((e) => e.severity === 'error').length;
  const warningCount = errors.filter((e) => e.severity === 'warning').length;
  const topIssues = errors.slice(0, 5).map((e) => e.message);
  return { errorCount, warningCount, topIssues };
}

const runAutoRouteTool: Tool = {
  name: 'pcb.autoRoute',
  category: 'PCB',
  description: 'Run the 2-layer A* auto-router (45° traces, vias, rip-up & reroute) on the server-side PCB. Returns real statistics: connections routed/failed, via count, total copper length, plus a DRC summary. Use pcb.importFromSchematic first.',
  parameters: {
    type: 'object',
    properties: {
      traceWidth: { type: 'number', description: 'Optional default trace width in mm (0.2–0.6 typical). Default 0.25.' },
    },
  },
  execute(args, ctx) {
    if (!ctx.pcb) return { ok: false, error: 'No PCB loaded — run pcb.importFromSchematic first.' };
    const result: AutoRouteResult = autoRoute(
      ctx.pcb.footprints,
      ctx.pcb.traces,
      ctx.pcb.vias,
      ctx.pcb.ratsnest,
      ctx.pcb.board,
      { traceWidth: typeof args.traceWidth === 'number' ? args.traceWidth : 0.25 },
    );
    ctx.pcb.traces = result.traces;
    ctx.pcb.vias = result.vias;
    const stats = result.stats;
    const drc = drcSummary(ctx);
    return {
      ok: stats.failed === 0,
      result: {
        routed: stats.routed,
        failed: stats.failed,
        totalConnections: stats.routed + stats.failed,
        vias: stats.vias,
        totalLengthMm: Math.round(stats.totalLength * 10) / 10,
        rippedUp: stats.rippedUp,
        elapsedMs: stats.elapsedMs,
        drc: drc,
        unrouted: result.unrouted.slice(0, 10).map((u) => ({ net: u.net, reason: u.reason })),
        message: stats.failed === 0
          ? `Auto-route complete: ${stats.routed}/${stats.routed + stats.failed} connections, ${stats.vias} vias, DRC ${drc.errorCount} error(s).`
          : `Auto-route routed ${stats.routed}/${stats.routed + stats.failed} connections — ${stats.failed} failed. Consider moving components apart or widening the board (pcb.setBoardSize).`,
      },
      error: stats.failed > 0 ? `${stats.failed} connection(s) could not be routed` : undefined,
    };
  },
};

const runTopoRouteTool: Tool = {
  name: 'pcb.topoRoute',
  category: 'PCB',
  description: 'Run the topological push-and-shove router (A* + 45° snapping + shove + rip-up) — higher quality than autoRoute. Returns real routed/failed/shoved/rippedUp statistics plus a DRC summary. Use pcb.importFromSchematic first.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    if (!ctx.pcb) return { ok: false, error: 'No PCB loaded — run pcb.importFromSchematic first.' };
    const result = routeTopologically(
      ctx.pcb.footprints,
      ctx.pcb.traces,
      ctx.pcb.vias,
      ctx.pcb.ratsnest,
      ctx.pcb.board,
      DEFAULT_ROUTER_OPTIONS,
    );
    ctx.pcb.traces = result.traces;
    ctx.pcb.vias = result.vias;
    const stats = result.stats;
    const drc = drcSummary(ctx);
    return {
      ok: stats.failed === 0,
      result: {
        routed: stats.routed,
        failed: stats.failed,
        shoved: stats.shoved,
        rippedUp: stats.rippedUp,
        vias: stats.vias,
        totalLengthMm: Math.round(stats.totalLengthMm * 10) / 10,
        drc: drc,
        message: stats.failed === 0
          ? `Topo-route complete: ${stats.routed} nets routed, ${stats.shoved} shoved, DRC ${drc.errorCount} error(s).`
          : `Topo-route routed ${stats.routed} nets, ${stats.failed} failed. DRC: ${drc.errorCount} error(s).`,
      },
      error: stats.failed > 0 ? `${stats.failed} net(s) failed to route` : undefined,
    };
  },
};

const runDRCTool: Tool = {
  name: 'pcb.runDRC',
  category: 'PCB',
  description: 'Run the Design Rule Check on the server-side PCB: clearance, trace width, drill size, annular ring, courtyard, netlist match. Returns the full error list with severity — use it to VERIFY the PCB is manufacturable before telling the user it is done.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    if (!ctx.pcb) return { ok: false, error: 'No PCB loaded — run pcb.importFromSchematic first.' };
    const pcb = ctx.pcb;
    const errors = runDRC(pcb.footprints, pcb.traces, pcb.vias, pcb.ratsnest, pcb.board);
    const errorCount = errors.filter((e) => e.severity === 'error').length;
    const warningCount = errors.filter((e) => e.severity === 'warning').length;
    return {
      ok: errorCount === 0,
      result: {
        errorCount,
        warningCount,
        errors: errors.slice(0, 20).map((e) => ({ severity: e.severity, message: e.message })),
        message: errorCount === 0 && warningCount === 0
          ? 'DRC passed — the PCB is clean (no errors, no warnings).'
          : `DRC found ${errorCount} error(s) and ${warningCount} warning(s).`,
      },
      error: errorCount > 0 ? `DRC failed with ${errorCount} error(s)` : undefined,
    };
  },
};

const verifyNetlistTool: Tool = {
  name: 'pcb.verifyNetlist',
  category: 'PCB',
  description: 'Verify the server-side PCB netlist matches the schematic netlist (net membership, pad counts, footprint coverage). Returns matched/missing nets — use it to confirm the PCB implements exactly the schematic connectivity.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    if (!ctx.pcb) return { ok: false, error: 'No PCB loaded — run pcb.importFromSchematic first.' };
    const r: NetlistVerifyResult = verifyNetlist(ctx.doc.components, ctx.doc.wires, ctx.pcb.footprints, ctx.pcb.traces);
    return {
      ok: r.ok && r.errors.filter((e) => e.severity === 'error').length === 0,
      result: {
        schematicNets: r.stats.schematicNets,
        pcbNets: r.stats.pcbNets,
        matchedNets: r.stats.matchedNets,
        missingInPCB: r.stats.missingInPCB,
        missingInSchematic: r.stats.missingInSchematic,
        padCountMismatch: r.stats.padCountMismatch,
        message: r.ok
          ? `Netlist verified: ${r.stats.matchedNets}/${r.stats.schematicNets} nets match the schematic.`
          : `Netlist mismatch: ${r.stats.missingInPCB.length} net(s) missing in PCB, ${r.stats.missingInSchematic.length} net(s) only in PCB.`,
      },
      error: r.ok ? undefined : 'PCB netlist does not match the schematic',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { importToPCBTool, runAutoRouteTool, runDRCTool, runTopoRouteTool, verifyNetlistTool };
