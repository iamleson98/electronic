// Zustand store for the circuit editor.
// Holds: components, wires, selection, simulation settings, current sim state.
// Provides: add/move/rotate/delete components, add/remove wires, undo/redo,
// serialize/deserialize, run/pause/step simulation.

'use client';

import { create } from 'zustand';
import type {
  CircuitComponent,
  CircuitDocument,
  SimContext,
  Wire,
} from './types';
import { getPlugin } from './registry';
import { simulateStep, getTerminalsForComponent } from './engine';
import './components'; // register all built-in plugins

export interface Selection {
  type: 'component' | 'wire' | null;
  id: string | null;
}

export interface ProbeSample {
  time: number;
  voltage: number;
}

export interface ProbeTrace {
  componentId: string;
  color: string;
  label: string;
  samples: ProbeSample[];
}

interface EditorState {
  // document
  components: CircuitComponent[];
  wires: Wire[];
  // selection
  selection: Selection;
  // simulation settings
  running: boolean;
  speed: number;          // multiplier (1 = real-time at chosen dt)
  dt: number;             // timestep in seconds
  // current sim context (read-only mirror)
  simContext: SimContext | null;
  // probe traces (per oscilloscope)
  traces: ProbeTrace[];
  maxTraceSamples: number;
  // history
  past: { components: CircuitComponent[]; wires: Wire[] }[];
  future: { components: CircuitComponent[]; wires: Wire[] }[];
  // ui
  paused: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  // wire draft
  wireDraft: { from: { componentId: string; terminalId: string }; cursor: { x: number; y: number } } | null;

  // actions
  addComponent: (type: string, position: { x: number; y: number }) => string;
  moveComponent: (id: string, position: { x: number; y: number }) => void;
  rotateComponent: (id: string) => void;
  deleteComponent: (id: string) => void;
  deleteWire: (id: string) => void;
  setParameter: (id: string, key: string, value: number | string | boolean) => void;
  setSelection: (sel: Selection) => void;
  startWire: (from: { componentId: string; terminalId: string }, cursor: { x: number; y: number }) => void;
  updateWireCursor: (cursor: { x: number; y: number }) => void;
  cancelWire: () => void;
  completeWire: (to: { componentId: string; terminalId: string }) => void;
  setWireWaypoints: (id: string, waypoints: { x: number; y: number }[]) => void;
  toggleSwitch: (id: string) => void;

  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
  clear: () => void;
  loadDocument: (doc: CircuitDocument) => void;
  serialize: () => CircuitDocument;

  setRunning: (running: boolean) => void;
  setSpeed: (s: number) => void;
  setDt: (dt: number) => void;
  step: () => void;
  reset: () => void;
  setShowGrid: (s: boolean) => void;
  setSnapToGrid: (s: boolean) => void;
}

let idCounter = 0;
function genId(prefix: string = 'c') {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function snapshot(s: { components: CircuitComponent[]; wires: Wire[] }) {
  return {
    components: s.components.map((c) => ({ ...c, parameters: { ...c.parameters }, simState: undefined })),
    wires: s.wires.map((w) => ({ ...w })),
  };
}

const MAX_HISTORY = 100;

// helper: get plugin defaults
function defaultsFor(type: string): Record<string, number | string | boolean> {
  const plugin = getPlugin(type);
  if (!plugin) return {};
  const defaults: Record<string, number | string | boolean> = {};
  for (const p of plugin.parameters) defaults[p.key] = p.default;
  return defaults;
}

export const useEditor = create<EditorState>((set, get) => ({
  components: [],
  wires: [],
  selection: { type: null, id: null },
  running: false,
  speed: 1,
  dt: 1e-4,
  simContext: null,
  traces: [],
  maxTraceSamples: 500,
  past: [],
  future: [],
  paused: true,
  showGrid: true,
  snapToGrid: true,
  wireDraft: null,

  addComponent: (type, position) => {
    get().pushHistory();
    const id = genId('comp');
    const comp: CircuitComponent = {
      id,
      type,
      position: { ...position },
      rotation: 0,
      parameters: defaultsFor(type),
    };
    set((s) => ({ components: [...s.components, comp], selection: { type: 'component', id } }));
    return id;
  },

  moveComponent: (id, position) => {
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, position: { ...position } } : c,
      ),
    }));
  },

  rotateComponent: (id) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id
          ? { ...c, rotation: (((c.rotation + 1) % 4) as 0 | 1 | 2 | 3) }
          : c,
      ),
    }));
  },

  deleteComponent: (id) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.filter((c) => c.id !== id),
      wires: s.wires.filter((w) => w.from.componentId !== id && w.to.componentId !== id),
      selection: { type: null, id: null },
      traces: s.traces.filter((t) => t.componentId !== id),
    }));
  },

  deleteWire: (id) => {
    get().pushHistory();
    set((s) => ({
      wires: s.wires.filter((w) => w.id !== id),
      selection: { type: null, id: null },
    }));
  },

  setParameter: (id, key, value) => {
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, parameters: { ...c.parameters, [key]: value } } : c,
      ),
    }));
  },

  setSelection: (sel) => set({ selection: sel }),

  startWire: (from, cursor) => set({ wireDraft: { from, cursor } }),
  updateWireCursor: (cursor) => set((s) => (s.wireDraft ? { wireDraft: { ...s.wireDraft, cursor } } : {})),
  cancelWire: () => set({ wireDraft: null }),
  completeWire: (to) => {
    const draft = get().wireDraft;
    if (!draft) return;
    if (draft.from.componentId === to.componentId && draft.from.terminalId === to.terminalId) {
      set({ wireDraft: null });
      return;
    }
    get().pushHistory();
    const id = genId('wire');
    const wire: Wire = { id, from: draft.from, to };
    set((s) => ({ wires: [...s.wires, wire], wireDraft: null }));
  },

  setWireWaypoints: (id, waypoints) => {
    set((s) => ({
      wires: s.wires.map((w) => (w.id === id ? { ...w, waypoints: waypoints.length > 0 ? waypoints : undefined } : w)),
    }));
  },

  toggleSwitch: (id) => {
    set((s) => ({
      components: s.components.map((c) => {
        if (c.id !== id) return c;
        if (c.type === 'switch') return { ...c, parameters: { ...c.parameters, closed: !c.parameters.closed } };
        if (c.type === 'pushButton') return { ...c, parameters: { ...c.parameters, pressed: !c.parameters.pressed } };
        return c;
      }),
    }));
  },

  pushHistory: () => {
    set((s) => {
      const snap = snapshot(s);
      const past = [...s.past, snap].slice(-MAX_HISTORY);
      return { past, future: [] };
    });
  },

  undo: () => {
    set((s) => {
      if (s.past.length === 0) return {};
      const prev = s.past[s.past.length - 1];
      const current = snapshot(s);
      return {
        past: s.past.slice(0, -1),
        future: [current, ...s.future].slice(0, MAX_HISTORY),
        components: prev.components,
        wires: prev.wires,
        selection: { type: null, id: null },
      };
    });
  },

  redo: () => {
    set((s) => {
      if (s.future.length === 0) return {};
      const next = s.future[0];
      const current = snapshot(s);
      return {
        past: [...s.past, current].slice(-MAX_HISTORY),
        future: s.future.slice(1),
        components: next.components,
        wires: next.wires,
        selection: { type: null, id: null },
      };
    });
  },

  clear: () => {
    get().pushHistory();
    set({ components: [], wires: [], selection: { type: null, id: null }, traces: [], simContext: null });
  },

  loadDocument: (doc) => {
    set({
      components: doc.components.map((c) => ({ ...c, parameters: { ...c.parameters }, simState: undefined })),
      wires: doc.wires.map((w) => ({ ...w })),
      selection: { type: null, id: null },
      traces: [],
      simContext: null,
      past: [],
      future: [],
    });
  },

  serialize: () => {
    const s = get();
    return {
      version: 1 as const,
      components: s.components.map((c) => ({ ...c, simState: undefined })),
      wires: s.wires.map((w) => ({ ...w })),
    };
  },

  setRunning: (running) => set({ running, paused: !running }),
  setSpeed: (speed) => set({ speed }),
  setDt: (dt) => set({ dt }),

  step: () => {
    const s = get();
    if (s.components.length === 0) return;
    const plugins = new Map<string, any>();
    for (const c of s.components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    // Keep a persistent state map across steps so capacitors/inductors/555 remember their state
    const persistentState = s.simContext?.state ?? {};
    const prev = s.simContext
      ? {
          nodeVoltage: s.simContext.nodeVoltage,
          branchCurrent: s.simContext.branchCurrent,
          time: s.simContext.time,
          state: persistentState,
        }
      : { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: persistentState };
    // run sub-steps based on speed
    const subSteps = Math.max(1, Math.floor(s.speed));
    const dt = s.dt;
    let result: { sim: SimContext; branchCurrentSize: number; nodeMap: any } | null = null;
    for (let i = 0; i < subSteps; i++) {
      result = simulateStep(s.components, s.wires, plugins, prev, dt);
      if (!result) break;
      prev.nodeVoltage = result.sim.nodeVoltage;
      prev.branchCurrent = result.sim.branchCurrent;
      prev.time = result.sim.time;
      prev.state = result.sim.state;
    }
    if (!result) {
      set({ running: false, paused: true });
      return;
    }
    // update traces for oscilloscope components
    const traces = [...s.traces];
    for (const comp of s.components) {
      if (comp.type !== 'oscilloscope') continue;
      const plugin = plugins.get('oscilloscope');
      if (!plugin) continue;
      const terminals = getTerminalsForComponent(comp, plugin, result.nodeMap);
      const measurements = plugin.measure(comp.parameters, terminals, result.sim);
      const v = parseFloat(measurements[0]?.value ?? '0');
      let traceIdx = traces.findIndex((t) => t.componentId === comp.id);
      if (traceIdx < 0) {
        traces.push({
          componentId: comp.id,
          color: (comp.parameters.color as string) || '#22d3ee',
          label: (comp.parameters.label as string) || 'CH',
          samples: [],
        });
        traceIdx = traces.length - 1;
      }
      const trace = traces[traceIdx];
      trace.samples.push({ time: result.sim.time, voltage: v });
      if (trace.samples.length > s.maxTraceSamples) {
        trace.samples = trace.samples.slice(-s.maxTraceSamples);
      }
      traces[traceIdx] = { ...trace };
    }
    set({ simContext: result.sim, traces });
  },

  reset: () => {
    set((s) => ({
      components: s.components.map((c) => ({ ...c, simState: undefined })),
      simContext: null,
      traces: [],
    }));
  },

  setShowGrid: (showGrid) => set({ showGrid }),
  setSnapToGrid: (snapToGrid) => set({ snapToGrid }),
}));
