// Zustand store for the PCB layout editor.
// Holds footprints, traces, vias, board outline, and tool state.

'use client';

import { create } from 'zustand';
import type {
  Footprint,
  Trace,
  Via,
  Ratsnest,
  BoardOutline,
  PCBDocument,
  Pad,
} from './types';
import type { CircuitComponent, Wire } from '../circuit/types';
import { useEditor } from '../circuit/store';
import { getFootprintDef } from './footprints';
import { createPCBFromSchematic } from './netlist-sync';
import { runDRC as runDRCCheck, DEFAULT_DRC_CONFIG } from './drc';
import type { DRCError } from './drc';
import { generateCopperPour } from './copper-pour';
import type { CopperPour } from './copper-pour';
import { exportAllGerbers } from './gerber-export';
import { autoRoute } from './auto-router';
import { verifyNetlist } from './netlist-verify';
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
  activeLayer: 'top' | 'bottom';
  defaultTraceWidth: number;
  // keepout areas
  keepouts: { id: string; rect: { x: number; y: number; width: number; height: number }; layers: 'all' | string[]; reason?: string }[];
  // net classes
  netClasses: { name: string; traceWidth: number; clearance: number; viaDiameter: number; viaDrill: number; nets: string[] }[];
  // teardrops
  teardrops: { id: string; position: { x: number; y: number }; padId: string; points: { x: number; y: number }[]; layer: string }[];
  // multi-selection
  selectedFootprintIds: Set<string>;
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

  // actions
  importFromSchematic: (components: CircuitComponent[], wires: Wire[]) => void;
  setTool: (tool: PCBTool) => void;
  setActiveLayer: (layer: 'top' | 'bottom') => void;
  setDefaultTraceWidth: (width: number) => void;
  setBoardSize: (width: number, height: number) => void;
  moveFootprint: (id: string, pos: { x: number; y: number }) => void;
  rotateFootprint: (id: string) => void;
  flipFootprint: (id: string) => void;
  deleteTrace: (id: string) => void;
  startRouting: (from: { x: number; y: number; net: string }) => void;
  addRoutingPoint: (point: { x: number; y: number }) => void;
  finishRouting: (to: { x: number; y: number; net: string } | null) => void;
  cancelRouting: () => void;
  addVia: (pos: { x: number; y: number }, net: string) => void;
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
  addCopperPour: (layer: 'top' | 'bottom', net: string) => void;
  removeCopperPour: (layer: 'top' | 'bottom') => void;
  exportGerbers: () => void;
  runAutoRoute: () => void;
  runNetlistVerify: () => NetlistVerifyResult | null;
  // keepout
  addKeepout: (rect: { x: number; y: number; width: number; height: number }, layers: 'all' | string[], reason?: string) => void;
  removeKeepout: (id: string) => void;
  // teardrops
  generateTeardrops: () => void;
  clearTeardrops: () => void;
  // net classes
  addNetClass: (nc: { name: string; traceWidth: number; clearance: number; viaDiameter: number; viaDrill: number; nets: string[] }) => void;
  removeNetClass: (name: string) => void;
  // length tuning
  lengthTuneTrace: (traceId: string, targetLength: number) => void;
  // alignment
  alignSelected: (direction: 'left' | 'right' | 'top' | 'bottom' | 'hCenter' | 'vCenter') => void;
  distributeSelected: (axis: 'horizontal' | 'vertical') => void;
}

let idCounter = 0;
function genId(prefix: string) {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export const usePCB = create<PCBState>((set, get) => ({
  board: { width: 80, height: 60 },
  footprints: [],
  traces: [],
  vias: [],
  ratsnest: [],
  padNets: new Map(),
  activeLayer: 'top',
  defaultTraceWidth: 0.3,
  keepouts: [],
  netClasses: [],
  teardrops: [],
  selectedFootprintIds: new Set(),
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

  importFromSchematic: (components, wires) => {
    const { footprints, ratsnest, padNets } = createPCBFromSchematic(components, wires);
    // Auto-size board based on footprint positions
    let maxX = 50, maxY = 50;
    for (const fp of footprints) {
      maxX = Math.max(maxX, fp.position.x + fp.bodySize.width / 2 + 5);
      maxY = Math.max(maxY, fp.position.y + fp.bodySize.height / 2 + 5);
    }
    set({
      footprints,
      ratsnest,
      padNets,
      traces: [],
      vias: [],
      board: { width: Math.ceil(maxX), height: Math.ceil(maxY) },
      selectedFootprintId: null,
      selectedTraceId: null,
      routingFrom: null,
      routingPath: [],
    });
  },

  setTool: (tool) => set({ tool, routingFrom: null, routingPath: [] }),
  setActiveLayer: (activeLayer) => set({ activeLayer }),
  setDefaultTraceWidth: (defaultTraceWidth) => set({ defaultTraceWidth }),
  setBoardSize: (width, height) => set({ board: { width, height } }),

  moveFootprint: (id, pos) => {
    set((s) => ({
      footprints: s.footprints.map((fp) => {
        if (fp.id !== id) return fp;
        // Move all pads by the same delta
        const dx = pos.x - fp.position.x;
        const dy = pos.y - fp.position.y;
        return {
          ...fp,
          position: { ...pos },
          pads: fp.pads.map((p) => ({
            ...p,
            position: { x: p.position.x + dx, y: p.position.y + dy },
          })),
        };
      }),
    }));
    // Recompute ratsnest
    const state = get();
    const { ratsnest } = computeRatsnestFromState(state);
    set({ ratsnest });
  },

  rotateFootprint: (id) => {
    set((s) => ({
      footprints: s.footprints.map((fp) => {
        if (fp.id !== id) return fp;
        const newRot = (fp.rotation + 90) % 360;
        const rad = (newRot * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const fpDef = getFootprintDefSafe(fp.componentType);
        return {
          ...fp,
          rotation: newRot,
          pads: fp.pads.map((pad, i) => {
            const padDef = fpDef.pads[i];
            if (!padDef) return pad;
            const px = padDef.position.x * cos - padDef.position.y * sin;
            const py = padDef.position.x * sin + padDef.position.y * cos;
            return {
              ...pad,
              position: { x: fp.position.x + px, y: fp.position.y + py },
            };
          }),
        };
      }),
    }));
    // Recompute ratsnest
    const state = get();
    const { ratsnest } = computeRatsnestFromState(state);
    set({ ratsnest });
  },

  deleteTrace: (id) => set((s) => ({ traces: s.traces.filter((t) => t.id !== id) })),

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
      return;
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
    set((st) => ({
      traces: [...st.traces, trace],
      routingFrom: null,
      routingPath: [],
    }));
    void to;
  },

  cancelRouting: () => set({ routingFrom: null, routingPath: [] }),

  addVia: (pos, net) => {
    const via: Via = {
      id: genId('via'),
      position: { ...pos },
      diameter: 1.0,
      drill: 0.5,
      net,
    };
    set((s) => ({ vias: [...s.vias, via] }));
  },

  selectFootprint: (id) => set({ selectedFootprintId: id, selectedTraceId: null }),
  selectTrace: (id) => set({ selectedTraceId: id, selectedFootprintId: null }),
  toggleRatsnest: () => set((s) => ({ showRatsnest: !s.showRatsnest })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  togglePadNets: () => set((s) => ({ showPadNets: !s.showPadNets })),
  clearPCB: () => set({
    footprints: [], traces: [], vias: [], ratsnest: [], padNets: new Map(),
    keepouts: [], netClasses: [], teardrops: [], copperPours: [], drcErrors: [],
    selectedFootprintId: null, selectedTraceId: null, selectedFootprintIds: new Set(),
    routingFrom: null, routingPath: [], tool: 'select' as PCBTool,
  }),

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
    };
  },

  loadDocument: (doc) => set({
    board: doc.board,
    footprints: doc.footprints,
    traces: doc.traces,
    vias: doc.vias ?? [],
    activeLayer: (doc.activeLayer as 'top' | 'bottom') ?? 'top',
    defaultTraceWidth: doc.defaultTraceWidth,
    padNets: new Map((doc as any).padNets ?? []),
    keepouts: (doc as any).keepouts ?? [],
    netClasses: (doc as any).netClasses ?? [],
    teardrops: (doc as any).teardrops ?? [],
    ratsnest: [],
    drcErrors: [],
    copperPours: [],
    selectedFootprintId: null,
    selectedTraceId: null,
    selectedFootprintIds: new Set(),
    routingFrom: null,
    routingPath: [],
    tool: 'select',
  }),

  runDRC: () => {
    const s = get();
    const errors = runDRCCheck(s.footprints, s.traces, s.vias, s.ratsnest, s.board, DEFAULT_DRC_CONFIG);
    set({ drcErrors: errors });
  },

  clearDRC: () => set({ drcErrors: [] }),

  addCopperPour: (layer, net) => {
    const s = get();
    const pour = generateCopperPour(layer, net, s.footprints, s.traces, s.vias, s.board);
    set((st) => ({
      copperPours: [...st.copperPours.filter((p) => !(p.layer === layer && p.net === net)), pour],
    }));
  },

  removeCopperPour: (layer) => {
    set((st) => ({ copperPours: st.copperPours.filter((p) => p.layer !== layer) }));
  },

  exportGerbers: () => {
    const s = get();
    const files = exportAllGerbers(s.footprints, s.traces, s.vias, s.board);
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
    const s = get();
    const result = autoRoute(
      s.footprints, s.traces, s.vias, s.ratsnest, s.board,
      s.activeLayer, s.defaultTraceWidth,
    );
    set({ traces: result.traces, vias: result.vias });
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
  flipFootprint: (id) => set((s) => ({
    footprints: s.footprints.map((fp) => {
      if (fp.id !== id) return fp;
      const newSide = fp.side === 'top' ? 'bottom' : 'top';
      return {
        ...fp,
        side: newSide,
        pads: fp.pads.map((p) => ({
          ...p,
          position: { x: -p.position.x, y: p.position.y },
          layer: newSide,
        })),
      };
    }),
  })),

  // ===== Multi-selection =====
  toggleFootprintSelection: (id) => set((s) => {
    const ids = new Set(s.selectedFootprintIds);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    return { selectedFootprintIds: ids };
  }),

  toggleKeepouts: () => set((s) => ({ showKeepouts: !s.showKeepouts })),

  // ===== Keepout areas =====
  addKeepout: (rect, layers, reason) => set((s) => ({
    keepouts: [...s.keepouts, { id: genId('keepout'), rect, layers, reason }],
  })),
  removeKeepout: (id) => set((s) => ({ keepouts: s.keepouts.filter((k) => k.id !== id) })),

  // ===== Teardrops =====
  generateTeardrops: () => {
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
  clearTeardrops: () => set({ teardrops: [] }),

  // ===== Net classes =====
  addNetClass: (nc) => set((s) => ({
    netClasses: [...s.netClasses.filter((c) => c.name !== nc.name), nc],
  })),
  removeNetClass: (name) => set((s) => ({ netClasses: s.netClasses.filter((c) => c.name !== name) })),

  // ===== Length tuning (serpentine meander) =====
  lengthTuneTrace: (traceId, targetLength) => {
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

  // ===== Alignment =====
  alignSelected: (direction) => {
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
  },

  distributeSelected: (axis) => {
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
  },
}));

// Helper: compute ratsnest from current state
function computeRatsnestFromState(state: PCBState) {
  const padNets = state.padNets;
  const netsToPads = new Map<string, { padId: string; pos: { x: number; y: number } }[]>();
  for (const fp of state.footprints) {
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
  return { ratsnest };
}

// Helper: safe footprint def getter
function getFootprintDefSafe(type: string) {
  return getFootprintDef(type);
}
