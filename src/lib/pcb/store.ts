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

export type PCBTool = 'select' | 'route' | 'via' | 'move' | 'pour';

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
  deleteTrace: (id: string) => void;
  startRouting: (from: { x: number; y: number; net: string }) => void;
  addRoutingPoint: (point: { x: number; y: number }) => void;
  finishRouting: (to: { x: number; y: number; net: string } | null) => void;
  cancelRouting: () => void;
  addVia: (pos: { x: number; y: number }, net: string) => void;
  selectFootprint: (id: string | null) => void;
  selectTrace: (id: string | null) => void;
  toggleRatsnest: () => void;
  toggleGrid: () => void;
  togglePadNets: () => void;
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
  tool: 'select',
  selectedFootprintId: null,
  selectedTraceId: null,
  routingFrom: null,
  routingPath: [],
  showRatsnest: true,
  showGrid: true,
  showPadNets: false,
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
    selectedFootprintId: null, selectedTraceId: null, routingFrom: null, routingPath: [],
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
    };
  },

  loadDocument: (doc) => set({
    board: doc.board,
    footprints: doc.footprints,
    traces: doc.traces,
    vias: doc.vias ?? [],
    activeLayer: doc.activeLayer,
    defaultTraceWidth: doc.defaultTraceWidth,
    ratsnest: [],
    padNets: new Map(),
    drcErrors: [],
    copperPours: [],
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
