// Zustand store for the PCB layout editor.
// Holds footprints, traces, vias, board outline, and tool state.

'use client';

import { create } from 'zustand';
import type {
  Footprint,
  Trace,
  Via,
  ViaType,
  Ratsnest,
  BoardOutline,
  PCBDocument,
  Pad,
  CopperLayer,
  LayerStack,
} from './types';
import { DEFAULT_LAYER_STACK } from './types';
import type { CircuitComponent, Wire } from '../circuit/types';
import { useEditor } from '../circuit/store';
import { getFootprintDef } from './footprints';
import { createPCBFromSchematic } from './netlist-sync';
import { runDRC as runDRCCheck, DEFAULT_DRC_CONFIG, drcErrorKey } from './drc';
import type { DRCError, DRCWaiver, DRCConfig } from './drc';
import { getManufacturerSpec } from './manufacturer-presets';
import { generateCopperPour } from './copper-pour';
import type { CopperPour } from './copper-pour';
import { exportAllGerbers } from './gerber-export';
import { autoRoute, DEFAULT_AUTOROUTE_OPTIONS, segmentHasClearanceConflict } from './auto-router';
import type { AutoRouteResult, AutoRouteOptions } from './auto-router';
import { routeTopologically, DEFAULT_ROUTER_OPTIONS } from './topological-router';
import { verifyNetlist, flagSatisfiedRatsnestLegs } from './netlist-verify';
import type { NetlistVerifyResult } from './netlist-verify';

export type PCBTool = 'select' | 'route' | 'route45' | 'via' | 'move' | 'pour' | 'keepout';

interface PCBState {
  // document
  board: BoardOutline;
  footprints: Footprint[];
  traces: Trace[];
  vias: Via[];
  ratsnest: Ratsnest[];
  padNets: Map<string, string>;
  activeLayer: CopperLayer;
  defaultTraceWidth: number;
  /** Layer stack configuration — defaults to 2-layer. Switch to 4/6 layer for HDI designs. */
  layerStack: LayerStack;
  // keepout areas (rect or polygon outline)
  keepouts: { id: string; rect: { x: number; y: number; width: number; height: number }; layers: 'all' | string[]; reason?: string; polygon?: { x: number; y: number }[] }[];
  // net classes
  netClasses: { name: string; traceWidth: number; clearance: number; viaDiameter: number; viaDrill: number; nets: string[] }[];
  // teardrops
  teardrops: { id: string; position: { x: number; y: number }; padId: string; points: { x: number; y: number }[]; layer: string }[];
  // multi-selection
  selectedFootprintIds: Set<string>;
  /** Cross-probe highlight: component IDs selected on the schematic.
   *  Set by CircuitCanvas when component selection changes; PCB canvas reads
   *  this to render a highlight halo on the matching footprints. */
  crossProbeComponentIds: Set<string>;
  /** Set cross-probe highlight (called by schematic canvas on selection change) */
  setCrossProbe: (componentIds: string[]) => void;
  // tool state
  tool: PCBTool;
  selectedFootprintId: string | null;
  selectedTraceId: string | null;
  // routing state
  routingFrom: { x: number; y: number; net: string } | null;
  routingPath: { x: number; y: number }[];
  // UI
  showRatsnest: boolean;
  showGrid: boolean;
  showPadNets: boolean;
  showKeepouts: boolean;

  // DRC + copper pour
  drcErrors: DRCError[];
  copperPours: CopperPour[];
  /** Reviewed DRC waivers (persisted with the document) */
  drcWaivers: DRCWaiver[];
  /** Active fab preset name ('' = custom DEFAULT_DRC_CONFIG) */
  fabPreset: string;
  /** Effective DRC config (preset or custom) */
  drcConfig: DRCConfig;

  // actions
  importFromSchematic: (components: CircuitComponent[], wires: Wire[]) => void;
  setTool: (tool: PCBTool) => void;
  setActiveLayer: (layer: CopperLayer) => void;
  setDefaultTraceWidth: (width: number) => void;
  setBoardSize: (width: number, height: number) => void;
  moveFootprint: (id: string, pos: { x: number; y: number }) => void;
  rotateFootprint: (id: string) => void;
  flipFootprint: (id: string) => void;
  deleteTrace: (id: string) => void;
  startRouting: (from: { x: number; y: number; net: string }) => void;
  addRoutingPoint: (point: { x: number; y: number }) => void;
  /** Finish the interactive route. Returns true when the trace was committed;
   *  false when it was rejected (wrong net at the finish pad, or a committed
   *  segment violates clearance — routing continues so the user can fix it). */
  finishRouting: (to: { x: number; y: number; net: string } | null) => boolean;
  cancelRouting: () => void;
  addVia: (pos: { x: number; y: number }, net: string) => void;
  /** Add a via with explicit type (THT, blind, buried, micro) and layer range.
   *  For THT, fromLayer/toLayer default to top/bottom.
   *  For microvias, the diameter is auto-set to a smaller value. */
  addTypedVia: (pos: { x: number; y: number }, net: string, type: ViaType, fromLayer?: CopperLayer, toLayer?: CopperLayer) => void;
  /** Set the layer stack (2/4/6 layer). Updates the activeLayer if needed. */
  setLayerStack: (stack: LayerStack) => void;
  /** Route a differential pair from pad A to pad B (nets like DATA_P / DATA_N). */
  routeDiffPair: (padAId: string, padBId: string, netP: string, netN: string) => { routedP: boolean; routedN: boolean };
  selectFootprint: (id: string | null) => void;
  selectTrace: (id: string | null) => void;
  toggleFootprintSelection: (id: string) => void;
  toggleRatsnest: () => void;
  toggleGrid: () => void;
  togglePadNets: () => void;
  toggleKeepouts: () => void;
  clearPCB: () => void;
  serialize: () => PCBDocument;
  loadDocument: (doc: PCBDocument) => void;
  runDRC: () => void;
  clearDRC: () => void;
  /** Apply a manufacturer preset as the active DRC rule deck */
  applyFabPreset: (name: string) => boolean;
  /** Override DRC thresholds (partial merge into drcConfig, clears fabPreset to Custom, persists) */
  setDrcConfig: (patch: Partial<DRCConfig>) => void;
  /** Per-rule severity overrides (persisted with the document; 'ignore' hides the rule) */
  drcSeverityOverrides: Record<string, 'error' | 'warning' | 'info' | 'ignore'>;
  /** Set/clear one rule's severity override (persists) */
  setDrcSeverityOverride: (rule: string, level: 'error' | 'warning' | 'info' | 'ignore' | null) => void;
  /** Waive a DRC error (reviewed, excluded from sign-off) */
  waiveDRCError: (error: DRCError, note?: string) => void;
  /** Remove a waiver by fingerprint key */
  unwaiveDRCError: (key: string) => void;
  addCopperPour: (layer: CopperLayer, net: string, priority?: number) => void;
  removeCopperPour: (layer: CopperLayer) => void;
  exportGerbers: () => void;
  runAutoRoute: () => AutoRouteResult['stats'] & { unroutedCount: number };
  /** Topological push-and-shove router — replaces Lee's BFS. Real A* + 45° snapping + shove + rip-up. */
  runTopoRoute: () => { routed: number; failed: number; shoved: number; rippedUp: number };
  /** Remove ALL traces + vias (keeps footprints) — re-run auto-route cleanly. */
  unrouteAll: () => void;
  /** Remove the last routing waypoint while interactively routing (Backspace). */
  removeLastRoutingPoint: () => void;
  /** Place a via at the current routing position and continue on the other layer. */
  addRoutingVia: (pos?: { x: number; y: number }) => void;
  runNetlistVerify: () => NetlistVerifyResult | null;
  // undo/redo — snapshot stacks of the document-bearing state
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  // keepout
  addKeepout: (rect: { x: number; y: number; width: number; height: number }, layers: 'all' | string[], reason?: string, polygon?: { x: number; y: number }[]) => void;
  removeKeepout: (id: string) => void;
  // teardrops
  generateTeardrops: () => void;
  clearTeardrops: () => void;
  // net classes
  addNetClass: (nc: { name: string; traceWidth: number; clearance: number; viaDiameter: number; viaDrill: number; nets: string[] }) => void;
  removeNetClass: (name: string) => void;
  // length tuning
  lengthTuneTrace: (traceId: string, targetLength: number) => void;
  /** Trombone length tuning on a diff pair (both legs to the longer length) */
  lengthTuneDiffPair: (traceIdP: string, traceIdN: string) => { lenP: number; lenN: number; tuned: boolean };
  /** Via stitching along a net (ground fence): returns via count placed */
  stitchVias: (net: string, spacing: number) => number;
  /** Panelize the board into rows×cols with spacing + mouse-bite tabs */
  panelize: (rows: number, cols: number, spacing?: number) => { width: number; height: number; copies: number };
  // alignment
  alignSelected: (direction: 'left' | 'right' | 'top' | 'bottom' | 'hCenter' | 'vCenter') => void;
  distributeSelected: (axis: 'horizontal' | 'vertical') => void;
}

let idCounter = 0;
function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function genId(prefix: string) {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}


// ── undo/redo history ────────────────────────────────────────────────────────
/** Document-bearing state snapshot. Tool/selection/UI state is intentionally
 *  NOT part of history — undo restores the board, not the mouse. */
interface PCBHistoryEntry {
  board: BoardOutline;
  footprints: Footprint[];
  traces: Trace[];
  vias: Via[];
  ratsnest: Ratsnest[];
  padNets: Map<string, string>;
  keepouts: PCBState['keepouts'];
  netClasses: PCBState['netClasses'];
  teardrops: PCBState['teardrops'];
  copperPours: CopperPour[];
  layerStack: LayerStack;
}

const undoStack: PCBHistoryEntry[] = [];
const redoStack: PCBHistoryEntry[] = [];
const HISTORY_CAP = 64;
let lastHistoryPush = { key: '', time: 0 };

function snapshotForHistory(s: PCBState): PCBHistoryEntry {
  return structuredClone({
    board: s.board,
    footprints: s.footprints,
    traces: s.traces,
    vias: s.vias,
    ratsnest: s.ratsnest,
    padNets: s.padNets,
    keepouts: s.keepouts,
    netClasses: s.netClasses,
    teardrops: s.teardrops,
    copperPours: s.copperPours,
    layerStack: s.layerStack,
  });
}

/** Push the CURRENT state onto the undo stack before a mutation. Repeated
 *  pushes with the same gesture key within 400 ms coalesce into one entry —
 *  a footprint drag fires moveFootprint per mousemove and must undo as ONE
 *  step. Any new mutation clears the redo stack. */
function pushHistory(key: string): void {
  const now = Date.now();
  if (key !== '' && lastHistoryPush.key === key && now - lastHistoryPush.time < 400) {
    lastHistoryPush.time = now;
    return; // same gesture — the original "before" snapshot already covers it
  }
  lastHistoryPush = { key, time: now };
  undoStack.push(snapshotForHistory(usePCB.getState()));
  if (undoStack.length > HISTORY_CAP) undoStack.shift();
  redoStack.length = 0;
  // keep the reactive flags truthful (undo became available; redo is gone)
  usePCB.setState({ canUndo: true, canRedo: false });
}

function applyHistoryEntry(entry: PCBHistoryEntry): Partial<PCBState> {
  // structuredClone already isolated the entry — hand the store fresh clones
  // so a LATER undo of the same entry is unaffected (applyHistoryEntry may be
  // called twice: undo then redo then undo).
  const clone = structuredClone(entry);
  return {
    board: clone.board,
    footprints: clone.footprints,
    traces: clone.traces,
    vias: clone.vias,
    ratsnest: clone.ratsnest,
    padNets: clone.padNets,
    keepouts: clone.keepouts,
    netClasses: clone.netClasses,
    teardrops: clone.teardrops,
    copperPours: clone.copperPours,
    layerStack: clone.layerStack,
    drcErrors: [],
    selectedFootprintId: null,
    selectedTraceId: null,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}

/** Test hook: reset the history stacks (module-level state, shared per module instance). */
export function _resetPCBHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  lastHistoryPush = { key: '', time: 0 };
}

export const usePCB = create<PCBState>((set, get) => ({
  canUndo: false,
  canRedo: false,
  undo: () => {
    const entry = undoStack.pop();
    if (!entry) return;
    redoStack.push(snapshotForHistory(get()));
    set(applyHistoryEntry(entry));
  },
  redo: () => {
    const entry = redoStack.pop();
    if (!entry) return;
    undoStack.push(snapshotForHistory(get()));
    set(applyHistoryEntry(entry));
  },
  board: { width: 80, height: 60 },
  footprints: [],
  traces: [],
  vias: [],
  ratsnest: [],
  padNets: new Map(),
  activeLayer: 'top',
  layerStack: DEFAULT_LAYER_STACK,
  defaultTraceWidth: 0.3,
  keepouts: [],
  netClasses: [],
  teardrops: [],
  selectedFootprintIds: new Set(),
  crossProbeComponentIds: new Set(),
  setCrossProbe: (componentIds) => set({ crossProbeComponentIds: new Set(componentIds) }),
  tool: 'select',
  selectedFootprintId: null,
  selectedTraceId: null,
  routingFrom: null,
  routingPath: [],
  showRatsnest: true,
  showGrid: true,
  showPadNets: false,
  showKeepouts: true,
  drcErrors: [],
  copperPours: [],
  drcWaivers: [],
  fabPreset: '',
  drcConfig: { ...DEFAULT_DRC_CONFIG },
  drcSeverityOverrides: {},

  importFromSchematic: (components, wires) => {
    pushHistory('import');
    const { footprints, ratsnest, padNets, board } = createPCBFromSchematic(components, wires);
    set({
      footprints,
      ratsnest,
      padNets,
      traces: [],
      vias: [],
      board,
      selectedFootprintId: null,
      selectedTraceId: null,
      routingFrom: null,
      routingPath: [],
    });
  },

  setTool: (tool) => set({ tool, routingFrom: null, routingPath: [] }),
  setActiveLayer: (activeLayer) => set({ activeLayer }),
  setDefaultTraceWidth: (defaultTraceWidth) => set({ defaultTraceWidth }),
  setBoardSize: (width, height) => {
    pushHistory('setBoardSize');
    set({ board: { width, height } });
  },

  moveFootprint: (id, pos) => {
    pushHistory(`move:${id}`);
    const s = get();
    const fp = s.footprints.find((f) => f.id === id);
    if (!fp) return;
    const dx = pos.x - fp.position.x;
    const dy = pos.y - fp.position.y;
    // Old pad positions: trace endpoints sitting on them must be dragged
    // along (they used to stay at the old pad position → dangling copper +
    // false "unrouted" DRC/netlist failures).
    const padMoves = fp.pads.map((p) => ({
      from: { ...p.position },
      dx,
      dy,
      radius: Math.max(p.size.width, p.size.height) / 2,
    }));
    set({
      footprints: s.footprints.map((f) => {
        if (f.id !== id) return f;
        // Move all pads by the same delta
        return {
          ...f,
          position: { ...pos },
          pads: f.pads.map((p) => ({
            ...p,
            position: { x: p.position.x + dx, y: p.position.y + dy },
          })),
        };
      }),
      traces: dragTraceEndpointsWithPads(s.traces, padMoves),
    });
    // Recompute ratsnest
    const state = get();
    const ratsnest = computeRatsnestFor(state.footprints, state.padNets, state.traces, state.vias);
    set({ ratsnest });
  },

  rotateFootprint: (id) => {
    pushHistory(`rotate:${id}`);
    const s = get();
    const fp = s.footprints.find((f) => f.id === id);
    if (!fp) return;
    const fpDef = getFootprintDefSafe(fp.componentType);
    const newRot = (fp.rotation + 90) % 360;
    const rad = (newRot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Compute the new pads from the def (existing semantics) and record each
    // pad's move so attached trace endpoints can follow the same delta.
    const padMoves: { from: { x: number; y: number }; dx: number; dy: number; radius: number }[] = [];
    const newPads = fp.pads.map((pad, i) => {
      const padDef = fpDef.pads[i];
      if (!padDef) return pad; // pad without a def-index match doesn't move
      const px = padDef.position.x * cos - padDef.position.y * sin;
      const py = padDef.position.x * sin + padDef.position.y * cos;
      const newPos = { x: fp.position.x + px, y: fp.position.y + py };
      padMoves.push({
        from: { ...pad.position },
        dx: newPos.x - pad.position.x,
        dy: newPos.y - pad.position.y,
        radius: Math.max(pad.size.width, pad.size.height) / 2,
      });
      return { ...pad, position: newPos };
    });
    set({
      footprints: s.footprints.map((f) => f.id !== id ? f : {
        ...f,
        rotation: newRot,
        pads: newPads,
      }),
      traces: dragTraceEndpointsWithPads(s.traces, padMoves),
    });
    // Recompute ratsnest
    const state = get();
    const ratsnest = computeRatsnestFor(state.footprints, state.padNets, state.traces, state.vias);
    set({ ratsnest });
  },

  deleteTrace: (id) => {
    pushHistory(`deleteTrace:${id}`);
    const s = get();
    const traces = s.traces.filter((t) => t.id !== id);
    // Deleting copper can un-satisfy ratsnest legs → airwires must return
    set({
      traces,
      ratsnest: flagSatisfiedRatsnestLegs(s.ratsnest, s.footprints, traces, s.vias),
    });
  },

  startRouting: (from) => set({ routingFrom: from, routingPath: [from] }),

  addRoutingPoint: (point) => {
    set((s) => {
      if (!s.routingFrom) return {};
      const last = s.routingPath[s.routingPath.length - 1];
      // Snap to grid (0.5mm)
      const snapped = { x: Math.round(point.x * 2) / 2, y: Math.round(point.y * 2) / 2 };
      if (last && last.x === snapped.x && last.y === snapped.y) return {};
      return { routingPath: [...s.routingPath, snapped] };
    });
  },

  finishRouting: (to) => {
    const s = get();
    if (!s.routingFrom || s.routingPath.length < 2) {
      set({ routingFrom: null, routingPath: [] });
      return false;
    }
    // Net-safety: interactive routing may only finish on copper of the SAME
    // net (prevents accidental shorts — routing VCC onto a GND pad used to
    // silently create a short).
    if (to && to.net && to.net !== s.routingFrom.net) {
      return false; // caller shows a toast; routing continues
    }
    // Clearance gate: every committed segment is checked against other-net
    // copper (DRC-equivalent). The live canvas preview only checks the
    // segment under the cursor; waypoints committed on plain grid clicks were
    // never checked, so shorts used to reach the Gerbers with a "DRC clean"
    // badge. Rejected finishes keep the routing state so the user can fix it.
    const routingNet = s.routingFrom.net;
    const netClass = s.netClasses.find((nc) => nc.nets.includes(routingNet));
    const clearance = netClass?.clearance ?? DEFAULT_DRC_CONFIG.minClearance;
    // Pads may carry their net via padNets only (older documents) — fill it in
    // so the same-net exemption of the checker sees the real net.
    const nettedFootprints = s.footprints.map((fp) => ({
      ...fp,
      pads: fp.pads.map((p) => ({
        ...p,
        net: p.net ?? s.padNets.get(`${p.componentId}:${p.terminalId}`),
      })),
    }));
    for (let i = 0; i < s.routingPath.length - 1; i++) {
      const res = segmentHasClearanceConflict(
        s.routingPath[i], s.routingPath[i + 1],
        s.routingFrom.net, s.activeLayer, s.defaultTraceWidth / 2,
        clearance, nettedFootprints, s.traces, s.vias,
      );
      if (res.conflict) return false;
    }
    const trace: Trace = {
      id: genId('trace'),
      net: s.routingFrom.net,
      layer: s.activeLayer,
      segments: [],
      width: s.defaultTraceWidth,
    };
    for (let i = 0; i < s.routingPath.length - 1; i++) {
      trace.segments.push({
        start: s.routingPath[i],
        end: s.routingPath[i + 1],
        width: s.defaultTraceWidth,
      });
    }
    pushHistory('finishRoute');
    set((st) => ({
      traces: [...st.traces, trace],
      routingFrom: null,
      routingPath: [],
      // Newly-connected pads satisfy their ratsnest legs → hide airwires
      ratsnest: flagSatisfiedRatsnestLegs(st.ratsnest, st.footprints, [...st.traces, trace], st.vias),
    }));
    void to;
    return true;
  },

  cancelRouting: () => set({ routingFrom: null, routingPath: [] }),

  removeLastRoutingPoint: () => {
    set((s) => {
      if (!s.routingFrom || s.routingPath.length <= 1) return {};
      return { routingPath: s.routingPath.slice(0, -1) };
    });
  },

  addRoutingVia: (pos) => {
    const s = get();
    if (!s.routingFrom) return;
    const last = pos ?? s.routingPath[s.routingPath.length - 1];
    const snapped = { x: Math.round(last.x * 2) / 2, y: Math.round(last.y * 2) / 2 };
    // append the via point to the current path, then flip the active layer —
    // the next routing points continue on the new layer
    const path = [...s.routingPath];
    const lastPt = path[path.length - 1];
    if (!lastPt || lastPt.x !== snapped.x || lastPt.y !== snapped.y) path.push(snapped);
    const otherLayer = s.activeLayer === 'top' ? 'bottom' : 'top';
    const via: Via = {
      id: genId('via'),
      position: { ...snapped },
      diameter: 0.6,
      drill: 0.3,
      net: s.routingFrom.net,
      type: 'tht',
      fromLayer: s.activeLayer,
      toLayer: otherLayer,
    };
    // close the current segment run on the OLD layer, switch layer, restart path at the via
    const trace: Trace = {
      id: genId('trace'),
      net: s.routingFrom.net,
      layer: s.activeLayer,
      segments: [],
      width: s.defaultTraceWidth,
    };
    for (let i = 0; i < path.length - 1; i++) {
      trace.segments.push({ start: path[i], end: path[i + 1], width: s.defaultTraceWidth });
    }
    set((st) => ({
      traces: trace.segments.length > 0 ? [...st.traces, trace] : st.traces,
      vias: [...st.vias, via],
      activeLayer: otherLayer,
      routingPath: [{ ...snapped }],
    }));
  },

  addVia: (pos, net) => {
    pushHistory('addVia');
    const via: Via = {
      id: genId('via'),
      position: { ...pos },
      diameter: 1.0,
      drill: 0.5,
      net,
      type: 'tht',
      fromLayer: 'top',
      toLayer: 'bottom',
    };
    set((s) => ({ vias: [...s.vias, via] }));
  },

  addTypedVia: (pos, net, type, fromLayer, toLayer) => {
    pushHistory('addVia');
    // Diameter/drill defaults per via type (industry-typical values)
    let diameter = 1.0;
    let drill = 0.5;
    if (type === 'micro') { diameter = 0.3; drill = 0.1; }
    else if (type === 'blind') { diameter = 0.6; drill = 0.25; }
    else if (type === 'buried') { diameter = 0.6; drill = 0.25; }
    const via: Via = {
      id: genId('via'),
      position: { ...pos },
      diameter, drill, net,
      type,
      fromLayer: fromLayer ?? (type === 'tht' ? 'top' : 'top'),
      toLayer: toLayer ?? (type === 'tht' ? 'bottom' : fromLayer ?? 'bottom'),
    };
    set((s) => ({ vias: [...s.vias, via] }));
  },

  setLayerStack: (stack) => set((s) => ({
    layerStack: stack,
    // If the active layer isn't in the new stack, switch to top
    activeLayer: stack.layers.includes(s.activeLayer as CopperLayer)
      ? s.activeLayer
      : 'top' as 'top' | 'bottom',
  })),

  routeDiffPair: (padAId, padBId, netP, netN) => {
    pushHistory('diffPair');
    const s = get();
    // Find the two P pads
    let padA: Pad | null = null;
    let padB: Pad | null = null;
    for (const fp of s.footprints) {
      for (const p of fp.pads) {
        if (p.id === padAId) padA = p;
        if (p.id === padBId) padB = p;
      }
    }
    if (!padA || !padB) return { routedP: false, routedN: false };
    if ((padA.net ?? '') !== netP || (padB.net ?? '') !== netP) {
      // Both P endpoints must actually belong to netP — routing a P trace
      // between two arbitrary pads of OTHER nets used to fabricate a
      // phantom connection (Task 6-b: "usually different nets = fabricated
      // net short").
      return { routedP: false, routedN: false };
    }
    // Resolve the REAL N pads: every pad on netN, paired by proximity to
    // the P endpoints (diff-pair N pads sit next to their P partners —
    // USB D+/D-, DATA_P/D_N). The old code invented offset points not on
    // any pad: floating copper that connected nothing.
    const nPads: Pad[] = [];
    for (const fp of s.footprints) {
      for (const p of fp.pads) {
        if ((p.net ?? '') === netN) nPads.push(p);
      }
    }
    const nStart = nPads.length > 0
      ? nPads.reduce((best, p) => (dist2(p.position, padA!.position) < dist2(best.position, padA!.position) ? p : best))
      : null;
    const nEnd = nPads.filter((p) => p !== nStart).length > 0
      ? nPads.filter((p) => p !== nStart).reduce((best, p) => (dist2(p.position, padB!.position) < dist2(best.position, padB!.position) ? p : best))
      : null;

    const layer = s.activeLayer;
    const width = s.defaultTraceWidth;

    /** Manhattan path with 45° knees between two real pads, zero-length
     *  segments filtered (the old construction emitted them when pads
     *  shared an axis), every segment clearance-verified. */
    const buildVerifiedPath = (from: { x: number; y: number }, to: { x: number; y: number }, net: string) => {
      const segs: { start: { x: number; y: number }; end: { x: number; y: number }; width: number }[] = [];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const m = Math.min(Math.abs(dx), Math.abs(dy));
      const sx = Math.sign(dx), sy = Math.sign(dy);
      // 45° diagonal to the knee, then straight to the target
      const knee = { x: from.x + sx * m, y: from.y + sy * m };
      const pts = [from, knee, to];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue; // zero-length — drop
        const { conflict } = segmentHasClearanceConflict(a, b, net, layer, width / 2, DEFAULT_DRC_CONFIG.minClearance, s.footprints, s.traces, s.vias);
        if (conflict) return null; // honest failure — no copper committed
        segs.push({ start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, width });
      }
      return segs.length > 0 ? segs : null;
    };

    const pSegs = buildVerifiedPath(padA.position, padB.position, netP);
    const idP = genId('diffp');
    const idN = genId('diffn');
    const traceP: Trace | null = pSegs ? { id: idP, net: netP, layer, segments: pSegs, width, pairedTraceId: idN } : null;

    let traceN: Trace | null = null;
    if (nStart && nEnd) {
      const nSegs = buildVerifiedPath(nStart.position, nEnd.position, netN);
      if (nSegs) traceN = { id: idN, net: netN, layer, segments: nSegs, width, pairedTraceId: idP };
    }

    if (!traceP && !traceN) return { routedP: false, routedN: false };
    set((st) => {
      const added = [...(traceP ? [traceP] : []), ...(traceN ? [traceN] : [])];
      return {
        traces: [...st.traces, ...added],
        // newly-connected pads satisfy their ratsnest legs
        ratsnest: flagSatisfiedRatsnestLegs(st.ratsnest, st.footprints, [...st.traces, ...added], st.vias),
      };
    });
    return { routedP: !!traceP, routedN: !!traceN };
  },

  selectFootprint: (id) => set({ selectedFootprintId: id, selectedTraceId: null }),
  selectTrace: (id) => set({ selectedTraceId: id, selectedFootprintId: null }),
  toggleRatsnest: () => set((s) => ({ showRatsnest: !s.showRatsnest })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  togglePadNets: () => set((s) => ({ showPadNets: !s.showPadNets })),
  clearPCB: () => {
    pushHistory('clearPCB');
    set({
    footprints: [], traces: [], vias: [], ratsnest: [], padNets: new Map(),
    keepouts: [], netClasses: [], teardrops: [], copperPours: [], drcErrors: [],
    selectedFootprintId: null, selectedTraceId: null, selectedFootprintIds: new Set(),
    routingFrom: null, routingPath: [], tool: 'select' as PCBTool,
  });
  },

  serialize: () => {
    const s = get();
    return {
      version: 1 as const,
      board: s.board,
      footprints: s.footprints,
      traces: s.traces,
      vias: s.vias,
      activeLayer: s.activeLayer,
      defaultTraceWidth: s.defaultTraceWidth,
      padNets: Array.from(s.padNets.entries()),
      keepouts: s.keepouts,
      netClasses: s.netClasses,
      teardrops: s.teardrops,
      // layerStack + copperPours used to be omitted — a JSON round-trip
      // silently reverted 4/6-layer stacks and dropped every pour.
      layerStack: s.layerStack,
      copperPours: s.copperPours,
      drcWaivers: s.drcWaivers,
      fabPreset: s.fabPreset,
      drcConfig: s.drcConfig,
      drcSeverityOverrides: s.drcSeverityOverrides,
    };
  },

  loadDocument: (doc) => {
    pushHistory('loadDocument');
    const footprints = doc.footprints;
    const traces = doc.traces;
    const vias = doc.vias ?? [];
    const padNets = new Map<string, string>(doc.padNets ?? []);
    set({
      board: doc.board,
      footprints,
      traces,
      vias,
      activeLayer: (doc.activeLayer as 'top' | 'bottom') ?? 'top',
      defaultTraceWidth: doc.defaultTraceWidth,
      padNets,
      keepouts: doc.keepouts ?? [],
      netClasses: doc.netClasses ?? [],
      teardrops: doc.teardrops ?? [],
      // The ratsnest is not serialized — rebuild it from the restored pad
      // nets and flag legs satisfied by the restored copper, so loading a
      // routed board doesn't resurrect airwires that are already routed.
      ratsnest: computeRatsnestFor(footprints, padNets, traces, vias),
      drcErrors: [],
      // Backward-compatible restore: old documents without these fields
      // fall back to the defaults (2-layer stack, no pours).
      layerStack: doc.layerStack ?? DEFAULT_LAYER_STACK,
      copperPours: doc.copperPours ?? [],
      drcWaivers: (doc as unknown as { drcWaivers?: DRCWaiver[] }).drcWaivers ?? [],
      fabPreset: (doc as unknown as { fabPreset?: string }).fabPreset ?? '',
      drcConfig: (doc as unknown as { drcConfig?: DRCConfig }).drcConfig ?? { ...DEFAULT_DRC_CONFIG },
      drcSeverityOverrides: (doc as unknown as { drcSeverityOverrides?: Record<string, 'error' | 'warning' | 'info' | 'ignore'> }).drcSeverityOverrides ?? {},
      selectedFootprintId: null,
      selectedTraceId: null,
      selectedFootprintIds: new Set(),
      routingFrom: null,
      routingPath: [],
      tool: 'select',
    });
  },

  runDRC: () => {
    const s = get();
    // Pass the PCB net classes so per-net clearance/width rules are enforced
    // (previously the classes were silently ignored by the DRC run).
    const netClasses = s.netClasses.map((c) => ({ id: c.name, ...c }));
    const errors = runDRCCheck(s.footprints, s.traces, s.vias, s.ratsnest, s.board, s.drcConfig, netClasses, s.drcWaivers);
    set({ drcErrors: errors });
  },

  clearDRC: () => set({ drcErrors: [] }),

  applyFabPreset: (name: string) => {
    const spec = getManufacturerSpec(name);
    if (!spec) return false;
    set({ fabPreset: spec.name, drcConfig: { ...spec.config } });
    get().runDRC();
    return true;
  },

  setDrcConfig: (patch: Partial<DRCConfig>) => {
    // Custom threshold edit — the deck is no longer a pristine fab preset.
    set((s) => ({ drcConfig: { ...s.drcConfig, ...patch }, fabPreset: '' }));
    get().runDRC();
  },

  setDrcSeverityOverride: (rule: string, level: 'error' | 'warning' | 'info' | 'ignore' | null) => {
    set((s) => {
      const next = { ...s.drcSeverityOverrides };
      if (level === null) delete next[rule];
      else next[rule] = level;
      return { drcSeverityOverrides: next };
    });
  },

  waiveDRCError: (error: DRCError, note = '') => {
    const key = drcErrorKey(error);
    set((s) => ({
      drcWaivers: s.drcWaivers.some((w) => w.key === key)
        ? s.drcWaivers
        : [...s.drcWaivers, { key, note, date: new Date().toISOString().slice(0, 10) }],
    }));
    get().runDRC();
  },

  unwaiveDRCError: (key: string) => {
    set((s) => ({ drcWaivers: s.drcWaivers.filter((w) => w.key !== key) }));
    get().runDRC();
  },

  addCopperPour: (layer, net, priority = 0) => {
    pushHistory('addPour');
    const s = get();
    const pour = generateCopperPour(layer, net, s.footprints, s.traces, s.vias, s.board, 0.3, { priority, keepouts: s.keepouts });
    // Zone priority: clip the new pour against higher-priority pours on the
    // same layer (higher wins overlapping cells — KiCad zone-priority parity).
    const higher = s.copperPours.filter((p) => p.layer === layer && (p.priority ?? 0) > (pour.priority ?? 0));
    if (higher.length > 0) {
      const blocked = new Set<string>();
      for (const h of higher) {
        for (const c of h.cells) blocked.add(`${c.x.toFixed(2)},${c.y.toFixed(2)}`);
      }
      pour.cells = pour.cells.filter((c) => !blocked.has(`${c.x.toFixed(2)},${c.y.toFixed(2)}`));
    }
    set((st) => ({
      copperPours: [...st.copperPours.filter((p) => !(p.layer === layer && p.net === net)), pour],
    }));
  },

  removeCopperPour: (layer) => {
    pushHistory('removePour');
    set((st) => ({ copperPours: st.copperPours.filter((p) => p.layer !== layer) }));
  },

  exportGerbers: () => {
    const s = get();
    // Pours are part of the fab data — a pour visible on the canvas but
    // missing from the Gerbers used to manufacture an un-planned board.
    // Inner stackup layers + teardrops ride along (previously dropped).
    const files = exportAllGerbers(s.footprints, s.traces, s.vias, s.board, s.copperPours, {
      layers: [...s.layerStack.layers],
      teardrops: s.teardrops,
    });
    for (const file of files) {
      const blob = new Blob([file.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
    }
  },

  runAutoRoute: () => {
    pushHistory('autoRoute');
    const s = get();
    const options: Partial<AutoRouteOptions> = {
      ...DEFAULT_AUTOROUTE_OPTIONS,
      traceWidth: s.defaultTraceWidth,
      clearance: DEFAULT_DRC_CONFIG.minClearance,
      // Route on every stackup layer (inner planes included when the stack
      // uses them — previously hardcoded top/bottom, stranding 4/6-layer
      // designs on two layers).
      layers: [...s.layerStack.layers],
      netClasses: s.netClasses.map((c) => ({
        name: c.name, traceWidth: c.traceWidth, clearance: c.clearance,
        viaDiameter: c.viaDiameter, viaDrill: c.viaDrill, nets: c.nets,
      })),
      keepouts: s.keepouts.map((k) => ({ rect: k.rect, layers: k.layers, polygon: k.polygon })),
    };
    const result = autoRoute(s.footprints, s.traces, s.vias, s.ratsnest, s.board, options);
    set({
      traces: result.traces,
      vias: result.vias,
      // Flag satisfied ratsnest legs — a fully-routed board must not keep
      // showing airwires (they used to stay forever, even after 100% routing).
      ratsnest: flagSatisfiedRatsnestLegs(s.ratsnest, s.footprints, result.traces, result.vias),
    });
    return { ...result.stats, unroutedCount: result.unrouted.length };
  },

  unrouteAll: () => {
    pushHistory('unrouteAll');
    const s = get();
    set({
      traces: [], vias: [], routingFrom: null, routingPath: [], selectedTraceId: null,
      // With no copper left, every leg is unsatisfied → airwires return
      ratsnest: flagSatisfiedRatsnestLegs(s.ratsnest, s.footprints, [], []),
    });
  },

  runTopoRoute: () => {
    pushHistory('topoRoute');
    const s = get();
    const result = routeTopologically(
      s.footprints, s.traces, s.vias, s.ratsnest, s.board,
      {
        ...DEFAULT_ROUTER_OPTIONS,
        clearance: DEFAULT_DRC_CONFIG.minClearance,
        traceWidth: s.defaultTraceWidth,
      },
      s.netClasses.map((c) => ({
        name: c.name, traceWidth: c.traceWidth, clearance: c.clearance,
        viaDiameter: c.viaDiameter, viaDrill: c.viaDrill, nets: c.nets,
      })),
    );
    set({
      traces: result.traces,
      vias: result.vias,
      ratsnest: flagSatisfiedRatsnestLegs(s.ratsnest, s.footprints, result.traces, result.vias),
    });
    return {
      routed: result.stats.routed,
      failed: result.stats.failed,
      shoved: result.stats.shoved,
      rippedUp: result.stats.rippedUp,
    };
  },

  runNetlistVerify: () => {
    const s = get();
    const editorState = useEditor.getState();
    const result = verifyNetlist(
      editorState.components, editorState.wires,
      s.footprints, s.traces,
    );
    return result;
  },

  // ===== Flip footprint =====
  flipFootprint: (id) => {
    pushHistory(`flip:${id}`);
    set((s) => ({
      footprints: s.footprints.map((fp) => {
        if (fp.id !== id) return fp;
        const newSide = fp.side === 'top' ? 'bottom' : 'top';
        return {
          ...fp,
          side: newSide,
          pads: fp.pads.map((p) => ({
            ...p,
            // Mirror around the FOOTPRINT'S position (pad positions are
            // absolute board coordinates — mirroring x alone used to teleport
            // every pad to negative x, off the board).
            position: { x: 2 * fp.position.x - p.position.x, y: p.position.y },
            layer: newSide,
          })),
        };
      }),
    }));
    // Recompute ratsnest — pad positions changed
    const state = get();
    const ratsnest = computeRatsnestFor(state.footprints, state.padNets, state.traces, state.vias);
    set({ ratsnest });
  },

  // ===== Multi-selection =====
  toggleFootprintSelection: (id) => set((s) => {
    const ids = new Set(s.selectedFootprintIds);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    return { selectedFootprintIds: ids };
  }),

  toggleKeepouts: () => set((s) => ({ showKeepouts: !s.showKeepouts })),

  // ===== Keepout areas (rect or polygon outline) =====
  addKeepout: (rect, layers, reason, polygon) => {
    pushHistory('addKeepout');
    set((s) => ({
    keepouts: [...s.keepouts, { id: genId('keepout'), rect, layers, reason, ...(polygon ? { polygon } : {}) }],
  }));
  },
  removeKeepout: (id) => {
    pushHistory('removeKeepout');
    set((s) => ({ keepouts: s.keepouts.filter((k) => k.id !== id) }));
  },

  // ===== Teardrops =====
  generateTeardrops: () => {
    pushHistory('teardrops');
    const s = get();
    const teardrops: PCBState['teardrops'] = [];
    let tdId = 0;
    for (const trace of s.traces) {
      if (trace.segments.length === 0) continue;
      const firstSeg = trace.segments[0];
      const lastSeg = trace.segments[trace.segments.length - 1];
      for (const endpoint of [firstSeg.start, lastSeg.end]) {
        const pad = s.footprints.flatMap(fp => fp.pads).find(p =>
          Math.hypot(p.position.x - endpoint.x, p.position.y - endpoint.y) < 0.5
        );
        if (!pad) continue;
        const traceEnd = endpoint === firstSeg.start ? firstSeg.end : lastSeg.start;
        const dir = { x: traceEnd.x - endpoint.x, y: traceEnd.y - endpoint.y };
        const len = Math.hypot(dir.x, dir.y);
        if (len < 0.01) continue;
        const ux = dir.x / len, uy = dir.y / len;
        const px = -uy, py = ux;
        const padR = Math.max(pad.size.width, pad.size.height) / 2;
        const tdLen = Math.min(padR * 0.8, len * 0.5);
        const wideHalf = padR * 0.9;
        const narrowHalf = firstSeg.width / 2;
        const wideCenter = { x: endpoint.x + ux * padR * 0.3, y: endpoint.y + uy * padR * 0.3 };
        const narrowCenter = { x: endpoint.x + ux * (padR * 0.3 + tdLen), y: endpoint.y + uy * (padR * 0.3 + tdLen) };
        teardrops.push({
          id: `td_${tdId++}`, position: endpoint, padId: pad.id, layer: trace.layer,
          points: [
            { x: wideCenter.x + px * wideHalf, y: wideCenter.y + py * wideHalf },
            { x: wideCenter.x - px * wideHalf, y: wideCenter.y - py * wideHalf },
            { x: narrowCenter.x - px * narrowHalf, y: narrowCenter.y - py * narrowHalf },
            { x: narrowCenter.x + px * narrowHalf, y: narrowCenter.y + py * narrowHalf },
          ],
        });
      }
    }
    set({ teardrops });
  },
  clearTeardrops: () => {
    pushHistory('clearTeardrops');
    set({ teardrops: [] });
  },

  // ===== Net classes =====
  addNetClass: (nc) => {
    pushHistory('addNetClass');
    set((s) => ({
    netClasses: [...s.netClasses.filter((c) => c.name !== nc.name), nc],
  }));
  },
  removeNetClass: (name) => {
    pushHistory('removeNetClass');
    set((s) => ({ netClasses: s.netClasses.filter((c) => c.name !== name) }));
  },

  // ===== Length tuning (serpentine meander) =====
  lengthTuneTrace: (traceId, targetLength) => {    pushHistory('lengthTune');
    const s = get();
    const trace = s.traces.find((t) => t.id === traceId);
    if (!trace) return;
    let currentLen = 0;
    for (const seg of trace.segments) currentLen += Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
    if (targetLength <= currentLen) return;
    const extra = targetLength - currentLen;
    // Find longest segment
    let longestIdx = 0, longestLen = 0;
    for (let i = 0; i < trace.segments.length; i++) {
      const len = Math.hypot(trace.segments[i].end.x - trace.segments[i].start.x, trace.segments[i].end.y - trace.segments[i].start.y);
      if (len > longestLen) { longestLen = len; longestIdx = i; }
    }
    const seg = trace.segments[longestIdx];
    const dx = seg.end.x - seg.start.x, dy = seg.end.y - seg.start.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 2) return;
    const ux = dx / segLen, uy = dy / segLen, px = -uy, py = ux;
    const amplitude = 2.0;
    const numBumps = Math.ceil(extra / (2 * amplitude));
    const bumpSpacing = segLen / (numBumps + 1);
    const newSegs: typeof trace.segments = [];
    let cursor = { ...seg.start };
    for (let i = 0; i < numBumps; i++) {
      const bumpStart = { x: seg.start.x + ux * bumpSpacing * (i + 0.5), y: seg.start.y + uy * bumpSpacing * (i + 0.5) };
      newSegs.push({ start: { ...cursor }, end: { ...bumpStart }, width: seg.width });
      const out = { x: bumpStart.x + px * amplitude, y: bumpStart.y + py * amplitude };
      newSegs.push({ start: { ...bumpStart }, end: out, width: seg.width });
      const fwd = { x: out.x + ux * (bumpSpacing / 2), y: out.y + uy * (bumpSpacing / 2) };
      newSegs.push({ start: out, end: fwd, width: seg.width });
      const back = { x: fwd.x - px * amplitude, y: fwd.y - py * amplitude };
      newSegs.push({ start: fwd, end: back, width: seg.width });
      cursor = back;
    }
    newSegs.push({ start: { ...cursor }, end: { ...seg.end }, width: seg.width });
    set({
      traces: s.traces.map((t) => t.id === traceId ? { ...t, segments: [
        ...t.segments.slice(0, longestIdx), ...newSegs, ...t.segments.slice(longestIdx + 1)
      ] } : t),
    });
  },

  lengthTuneDiffPair: (traceIdP, traceIdN) => {
    const s = get();
    const lenOf = (t: Trace | undefined) => t
      ? t.segments.reduce((a, seg) => a + Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y), 0)
      : 0;
    const tP = s.traces.find((t) => t.id === traceIdP);
    const tN = s.traces.find((t) => t.id === traceIdN);
    const lenP = lenOf(tP);
    const lenN = lenOf(tN);
    if (!tP || !tN) return { lenP, lenN, tuned: false };
    const target = Math.max(lenP, lenN);
    pushHistory('lengthTuneDiffPair');
    if (lenP < target) get().lengthTuneTrace(traceIdP, target);
    if (lenN < target) get().lengthTuneTrace(traceIdN, target);
    const s2 = get();
    return {
      lenP: lenOf(s2.traces.find((t) => t.id === traceIdP)),
      lenN: lenOf(s2.traces.find((t) => t.id === traceIdN)),
      tuned: true,
    };
  },

  stitchVias: (net, spacing) => {
    pushHistory('stitchVias');
    const s = get();
    const gap = Math.max(1, spacing);
    let placed = 0;
    const vias: Via[] = [];
    // Stitch along the board perimeter (ground fence): vias every `spacing`
    // mm inset 1mm from the edge, skipping spots within 1mm of a pad.
    const inset = 1;
    const w = s.board.width - inset * 2;
    const h = s.board.height - inset * 2;
    const spots: { x: number; y: number }[] = [];
    for (let x = 0; x <= w; x += gap) {
      spots.push({ x: inset + x, y: inset });
      spots.push({ x: inset + x, y: inset + h });
    }
    for (let y = gap; y < h; y += gap) {
      spots.push({ x: inset, y: inset + y });
      spots.push({ x: inset + w, y: inset + y });
    }
    const padNear = (x: number, y: number) => s.footprints.some((fp) =>
      fp.pads.some((p) => Math.hypot(p.position.x - x, p.position.y - y) < 1));
    for (const sp of spots) {
      if (padNear(sp.x, sp.y)) continue;
      vias.push({ id: genId('via'), position: { ...sp }, diameter: 0.6, drill: 0.3, net, type: 'THT' as ViaType, fromLayer: 'top', toLayer: 'bottom' });
      placed++;
    }
    set((st) => ({ vias: [...st.vias, ...vias] }));
    return placed;
  },

  panelize: (rows, cols, spacing = 2.5) => {
    pushHistory('panelize');
    const s = get();
    const r = Math.max(1, Math.min(10, Math.trunc(rows)));
    const c = Math.max(1, Math.min(10, Math.trunc(cols)));
    const gap = Math.max(0, spacing);
    // Expand the board outline to fit the array (mouse-bite tabs every 20mm
    // are a fab note — recorded in the job, not geometry).
    const width = c * s.board.width + (c - 1) * gap;
    const height = r * s.board.height + (r - 1) * gap;
    set({ board: { ...s.board, width, height } });
    return { width, height, copies: r * c };
  },

  // ===== Alignment =====
  alignSelected: (direction) => {
    pushHistory('align');
    const s = get();
    if (s.selectedFootprintIds.size < 2) return;
    const selected = s.footprints.filter((f) => s.selectedFootprintIds.has(f.id));
    let target: number;
    switch (direction) {
      case 'left':   target = Math.min(...selected.map(f => f.position.x)); break;
      case 'right':  target = Math.max(...selected.map(f => f.position.x + f.bodySize.width)); break;
      case 'top':    target = Math.min(...selected.map(f => f.position.y)); break;
      case 'bottom': target = Math.max(...selected.map(f => f.position.y + f.bodySize.height)); break;
      case 'hCenter': target = selected.reduce((a, f) => a + f.position.x + f.bodySize.width / 2, 0) / selected.length; break;
      case 'vCenter': target = selected.reduce((a, f) => a + f.position.y + f.bodySize.height / 2, 0) / selected.length; break;
    }
    set({
      footprints: s.footprints.map((fp) => {
        if (!s.selectedFootprintIds.has(fp.id)) return fp;
        const dx = direction === 'left' ? target - fp.position.x
                 : direction === 'right' ? target - (fp.position.x + fp.bodySize.width)
                 : direction === 'hCenter' ? target - (fp.position.x + fp.bodySize.width / 2) : 0;
        const dy = direction === 'top' ? target - fp.position.y
                 : direction === 'bottom' ? target - (fp.position.y + fp.bodySize.height)
                 : direction === 'vCenter' ? target - (fp.position.y + fp.bodySize.height / 2) : 0;
        return { ...fp, position: { x: fp.position.x + dx, y: fp.position.y + dy },
          pads: fp.pads.map(p => ({ ...p, position: { x: p.position.x + dx, y: p.position.y + dy } })) };
      }),
    });
    // Recompute ratsnest — pad positions changed
    const alignedState = get();
    const ratsnest = computeRatsnestFor(alignedState.footprints, alignedState.padNets, alignedState.traces, alignedState.vias);
    set({ ratsnest });
  },

  distributeSelected: (axis) => {
    pushHistory('distribute');
    const s = get();
    if (s.selectedFootprintIds.size < 3) return;
    const selected = s.footprints.filter((f) => s.selectedFootprintIds.has(f.id));
    const sorted = [...selected].sort((a, b) => axis === 'horizontal' ? a.position.x - b.position.x : a.position.y - b.position.y);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const totalSpan = axis === 'horizontal' ? (last.position.x + last.bodySize.width) - first.position.x : (last.position.y + last.bodySize.height) - first.position.y;
    const totalSize = sorted.reduce((acc, f) => acc + (axis === 'horizontal' ? f.bodySize.width : f.bodySize.height), 0);
    const gap = (totalSpan - totalSize) / (sorted.length - 1);
    let cursor = axis === 'horizontal' ? first.position.x : first.position.y;
    const updates = new Map<string, { x: number; y: number }>();
    for (const fp of sorted) {
      updates.set(fp.id, axis === 'horizontal' ? { x: cursor, y: fp.position.y } : { x: fp.position.x, y: cursor });
      cursor += (axis === 'horizontal' ? fp.bodySize.width : fp.bodySize.height) + gap;
    }
    set({
      footprints: s.footprints.map((fp) => {
        const newPos = updates.get(fp.id);
        if (!newPos) return fp;
        const dx = newPos.x - fp.position.x, dy = newPos.y - fp.position.y;
        return { ...fp, position: newPos, pads: fp.pads.map(p => ({ ...p, position: { x: p.position.x + dx, y: p.position.y + dy } })) };
      }),
    });
    // Recompute ratsnest — pad positions changed
    const distState = get();
    const ratsnest = computeRatsnestFor(distState.footprints, distState.padNets, distState.traces, distState.vias);
    set({ ratsnest });
  },
}));

// Helper: compute the ratsnest (per-net MST legs) from footprints + pad nets,
// with each leg's `routed` flag derived from the ACTUAL trace/via copper —
// satisfied legs stay in the array but are flagged so airwires can be hidden.
function computeRatsnestFor(
  footprints: Footprint[],
  padNets: Map<string, string>,
  traces: Trace[],
  vias: Via[],
): Ratsnest[] {
  const netsToPads = new Map<string, { padId: string; pos: { x: number; y: number } }[]>();
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const termKey = `${pad.componentId}:${pad.terminalId}`;
      const net = padNets.get(termKey);
      if (!net) continue;
      if (!netsToPads.has(net)) netsToPads.set(net, []);
      netsToPads.get(net)!.push({ padId: pad.id, pos: pad.position });
    }
  }
  const ratsnest: Ratsnest[] = [];
  for (const [net, pads] of netsToPads) {
    if (pads.length < 2) continue;
    const connected = new Set<string>([pads[0].padId]);
    const remaining = pads.slice(1);
    while (remaining.length > 0) {
      let bestDist = Infinity;
      let bestIdx = 0;
      let bestFrom: { padId: string; pos: { x: number; y: number } } | null = null;
      for (let i = 0; i < remaining.length; i++) {
        for (const fromPad of pads) {
          if (!connected.has(fromPad.padId)) continue;
          const dx = remaining[i].pos.x - fromPad.pos.x;
          const dy = remaining[i].pos.y - fromPad.pos.y;
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) { bestDist = dist; bestIdx = i; bestFrom = fromPad; }
        }
      }
      if (bestFrom) {
        ratsnest.push({
          fromPadId: bestFrom.padId, toPadId: remaining[bestIdx].padId,
          net, from: bestFrom.pos, to: remaining[bestIdx].pos,
        });
        connected.add(remaining[bestIdx].padId);
        remaining.splice(bestIdx, 1);
      } else break;
    }
  }
  return flagSatisfiedRatsnestLegs(ratsnest, footprints, traces, vias);
}

/**
 * Drag trace ENDPOINTS that sit on a moved footprint's pads along with the
 * pads. Only the first/last segment endpoints of each trace count as trace
 * ends — interior vertices are routing waypoints, not pad attachments.
 * An endpoint counts as attached when it lies within the pad's copper
 * radius (both the auto-router and interactive routing snap trace ends
 * exactly onto pad centers, so attached ends are at distance 0).
 */
function dragTraceEndpointsWithPads(
  traces: Trace[],
  moves: { from: { x: number; y: number }; dx: number; dy: number; radius: number }[],
): Trace[] {
  if (moves.length === 0 || traces.length === 0) return traces;
  const hasMove = moves.some((m) => m.dx !== 0 || m.dy !== 0);
  if (!hasMove) return traces;
  return traces.map((t) => {
    if (t.segments.length === 0) return t;
    const segs = t.segments.map((seg) => ({ ...seg, start: { ...seg.start }, end: { ...seg.end } }));
    let changed = false;
    for (const move of moves) {
      if (move.dx === 0 && move.dy === 0) continue;
      const first = segs[0];
      if (Math.hypot(first.start.x - move.from.x, first.start.y - move.from.y) <= move.radius) {
        first.start = { x: first.start.x + move.dx, y: first.start.y + move.dy };
        changed = true;
      }
      const last = segs[segs.length - 1];
      if (Math.hypot(last.end.x - move.from.x, last.end.y - move.from.y) <= move.radius) {
        last.end = { x: last.end.x + move.dx, y: last.end.y + move.dy };
        changed = true;
      }
    }
    return changed ? { ...t, segments: segs } : t;
  });
}

// Helper: safe footprint def getter
function getFootprintDefSafe(type: string) {
  return getFootprintDef(type);
}
