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
import { simulateStep, getTerminalsForComponent, buildNodeMap } from './engine';
import './components'; // register all built-in plugins

// ===== ERC (Electrical Rule Check) =====
export interface ERCError {
  type: 'unconnected_pin' | 'power_short' | 'conflicting_drivers' | 'missing_ground';
  severity: 'error' | 'warning';
  message: string;
  componentId: string;
  terminalId: string;
  position: { x: number; y: number };
}

export interface ERCResult {
  errors: ERCError[];
  passed: boolean;
  stats: { errors: number; warnings: number };
}

function getTerminalElecType(compType: string, terminalId: string): string {
  if (compType === 'dcVoltage' || compType === 'acVoltage' || compType === 'pulseSource') {
    return terminalId === 'p' ? 'power' : 'ground';
  }
  if (compType === 'ground' || compType === 'powerGND') return 'ground';
  if (compType.startsWith('power') && compType !== 'powerGND') return 'power';
  if (compType === 'netLabel') return 'passive';
  if (compType === 'resistor' || compType === 'capacitor' || compType === 'inductor' ||
      compType === 'diode' || compType === 'led' || compType === 'switch' || compType === 'pushButton') return 'passive';
  if (compType === 'npn' || compType === 'pnp' || compType === 'nmos' || compType === 'pmos') {
    if (terminalId === 'b' || terminalId === 'g') return 'input';
    return 'passive';
  }
  if (compType === 'opamp') {
    if (terminalId === 'in+' || terminalId === 'in-') return 'input';
    if (terminalId === 'out') return 'output';
    if (terminalId === 'vcc' || terminalId === 'vee') return 'power';
  }
  if (compType === 'timer555') {
    if (terminalId === 'out') return 'output';
    if (terminalId === 'vcc') return 'power';
    if (terminalId === 'gnd') return 'ground';
    return 'input';
  }
  if (compType === 'arduino' || compType === 'arduinoReal' || compType === 'raspberryPi') {
    if (terminalId === 'gnd') return 'ground';
    if (terminalId === '5v' || terminalId === '3v3') return 'power';
    return 'bidirectional';
  }
  return 'unspecified';
}

export function runERC(components: CircuitComponent[], wires: Wire[]): ERCResult {
  const errors: ERCError[] = [];
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }

  // Check 1: Unconnected pins
  const connectedTerminals = new Set<string>();
  for (const wire of wires) {
    connectedTerminals.add(`${wire.from.componentId}:${wire.from.terminalId}`);
    connectedTerminals.add(`${wire.to.componentId}:${wire.to.terminalId}`);
  }
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const term of plugin.terminals) {
      const key = `${comp.id}:${term.id}`;
      if (!connectedTerminals.has(key)) {
        if (comp.type === 'ground' || comp.type === 'powerGND') continue;
        const elecType = getTerminalElecType(comp.type, term.id);
        if (elecType === 'input' || elecType === 'output' || elecType === 'power') {
          errors.push({
            type: 'unconnected_pin',
            severity: elecType === 'power' ? 'warning' : 'error',
            message: `${comp.id}.${term.id} (${elecType}) is unconnected`,
            componentId: comp.id,
            terminalId: term.id,
            position: { x: comp.position.x + term.position.x, y: comp.position.y + term.position.y },
          });
        }
      }
    }
  }

  // Check 2: Missing ground
  const hasGround = components.some(c => c.type === 'ground' || c.type === 'powerGND');
  if (!hasGround && components.length > 0) {
    errors.push({
      type: 'missing_ground', severity: 'error',
      message: 'Circuit has no ground reference — add a Ground component',
      componentId: '', terminalId: '', position: { x: 0, y: 0 },
    });
  }

  // Check 3: Conflicting drivers (multiple outputs on same net)
  const nodeMap = buildNodeMap(components, wires, plugins);
  const netToOutputs = new Map<number, { compId: string; termId: string; refdes: string }[]>();
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    for (const t of terms) {
      const elecType = getTerminalElecType(comp.type, t.terminalId);
      if (elecType === 'output' || elecType === 'power') {
        const node = t.nodeId;
        if (!netToOutputs.has(node)) netToOutputs.set(node, []);
        netToOutputs.get(node)!.push({ compId: comp.id, termId: t.terminalId, refdes: comp.id });
      }
    }
  }
  for (const [node, outputs] of netToOutputs) {
    if (outputs.length > 1 && node !== 0) {
      errors.push({
        type: 'conflicting_drivers', severity: 'error',
        message: `Net has ${outputs.length} conflicting drivers: ${outputs.map(o => o.refdes).join(', ')}`,
        componentId: outputs[0].compId, terminalId: outputs[0].termId, position: { x: 0, y: 0 },
      });
    }
  }

  const errorCount = errors.filter(e => e.severity === 'error').length;
  const warningCount = errors.filter(e => e.severity === 'warning').length;
  return { errors, passed: errorCount === 0, stats: { errors: errorCount, warnings: warningCount } };
}

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
  // selection (single)
  selection: Selection;
  // multi-selection
  multiSelection: { components: Set<string>; wires: Set<string> };
  // clipboard
  clipboard: { components: CircuitComponent[]; wires: Wire[] } | null;
  // ERC results
  ercErrors: ERCError[];
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
  // multi-selection
  toggleMultiSelect: (type: 'component' | 'wire', id: string) => void;
  setMultiSelection: (sel: { components: Set<string>; wires: Set<string> }) => void;
  clearMultiSelection: () => void;
  moveSelectedComponents: (delta: { x: number; y: number }) => void;
  deleteSelected: () => void;
  // copy/paste
  copySelection: () => void;
  paste: () => void;
  duplicate: () => void;
  // ERC
  runERC: () => ERCResult;
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
  multiSelection: { components: new Set(), wires: new Set() },
  clipboard: null,
  ercErrors: [],
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

  setSelection: (sel) => set({ selection: sel, multiSelection: { components: new Set(), wires: new Set() } }),

  // ===== Multi-selection =====
  toggleMultiSelect: (type, id) => {
    set((s) => {
      const ms = {
        components: new Set(s.multiSelection.components),
        wires: new Set(s.multiSelection.wires),
      };
      if (type === 'component') {
        if (ms.components.has(id)) ms.components.delete(id);
        else ms.components.add(id);
      } else {
        if (ms.wires.has(id)) ms.wires.delete(id);
        else ms.wires.add(id);
      }
      return { multiSelection: ms };
    });
  },
  setMultiSelection: (sel) => set({ multiSelection: sel, selection: { type: null, id: null } }),
  clearMultiSelection: () => set({ multiSelection: { components: new Set(), wires: new Set() } }),

  moveSelectedComponents: (delta) => {
    set((s) => {
      const ids = new Set(s.multiSelection.components);
      if (s.selection.type === 'component' && s.selection.id) ids.add(s.selection.id);
      if (ids.size === 0) return {};
      return {
        components: s.components.map((c) =>
          ids.has(c.id) ? { ...c, position: { x: c.position.x + delta.x, y: c.position.y + delta.y } } : c,
        ),
      };
    });
  },

  deleteSelected: () => {
    get().pushHistory();
    set((s) => {
      const idsToDelete = new Set(s.multiSelection.components);
      if (s.selection.type === 'component' && s.selection.id) idsToDelete.add(s.selection.id);
      const wiresToDelete = new Set(s.multiSelection.wires);
      if (s.selection.type === 'wire' && s.selection.id) wiresToDelete.add(s.selection.id);
      return {
        components: s.components.filter((c) => !idsToDelete.has(c.id)),
        wires: s.wires.filter((w) => !wiresToDelete.has(w.id) &&
          !idsToDelete.has(w.from.componentId) && !idsToDelete.has(w.to.componentId)),
        selection: { type: null, id: null },
        multiSelection: { components: new Set(), wires: new Set() },
      };
    });
  },

  // ===== Copy/Paste =====
  copySelection: () => {
    const s = get();
    const idsToCopy = new Set(s.multiSelection.components);
    if (s.selection.type === 'component' && s.selection.id) idsToCopy.add(s.selection.id);
    if (idsToCopy.size === 0) return;
    const copiedComponents = s.components
      .filter((c) => idsToCopy.has(c.id))
      .map((c) => ({ ...c, parameters: { ...c.parameters }, simState: undefined }));
    const copiedWires = s.wires
      .filter((w) => idsToCopy.has(w.from.componentId) && idsToCopy.has(w.to.componentId))
      .map((w) => ({ ...w }));
    set({ clipboard: { components: copiedComponents, wires: copiedWires } });
  },

  paste: () => {
    const s = get();
    if (!s.clipboard || s.clipboard.components.length === 0) return;
    get().pushHistory();
    const idMap = new Map<string, string>();
    const newComponents = s.clipboard.components.map((c) => {
      const newId = genId('comp');
      idMap.set(c.id, newId);
      return { ...c, id: newId, position: { x: c.position.x + 2, y: c.position.y + 2 }, parameters: { ...c.parameters }, simState: undefined };
    });
    const newWires = s.clipboard.wires.map((w) => ({
      id: genId('wire'),
      from: { componentId: idMap.get(w.from.componentId) ?? w.from.componentId, terminalId: w.from.terminalId },
      to: { componentId: idMap.get(w.to.componentId) ?? w.to.componentId, terminalId: w.to.terminalId },
    }));
    set((st) => ({
      components: [...st.components, ...newComponents],
      wires: [...st.wires, ...newWires],
      selection: { type: null, id: null },
      multiSelection: {
        components: new Set(newComponents.map((c) => c.id)),
        wires: new Set(newWires.map((w) => w.id)),
      },
    }));
  },

  duplicate: () => { get().copySelection(); get().paste(); },

  // ===== ERC =====
  runERC: () => {
    const s = get();
    const result = runERC(s.components, s.wires);
    set({ ercErrors: result.errors });
    return result;
  },

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
