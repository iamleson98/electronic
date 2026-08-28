// Zustand store for the circuit editor.
// Holds: components, wires, selection, simulation settings, current sim state.
// Provides: add/move/rotate/delete components, add/remove wires, undo/redo,
// serialize/deserialize, run/pause/step simulation.

'use client';

import { create } from 'zustand';
import type {
  CircuitComponent,
  CircuitDocument,
  ComponentField,
  DrawingPrimitive,
  Group,
  HierarchicalSheet,
  NetClass,
  NoConnectMarker,
  PageSetup,
  PinElecType,
  SavedView,
  SimContext,
  Wire,
} from './types';
import { DEFAULT_PAGE_SETUP, DEFAULT_TITLE_BLOCK } from './types';
import { getPlugin, getAllPlugins } from './registry';
import { simulateStep, getTerminalsForComponent } from './engine';
import { cleanupComponentState } from './memory';
import { findRoute, buildRoutingGrid, pathToWaypoints } from './smart-wire-router';
import { validatePhysics, type PhysicsViolation } from './physics-validator';
import { runFullERC } from './erc';
import { snapshotSheet, flattenHierarchy } from './hierarchy';
import { runAnalysis as runAnalysisEngine, type AnalysisConfig, type AnalysisResult } from './analysis';
import { runBatch as runBatchEngine, type BatchConfig, type BatchResult } from './batch-runner';
import { execMeas, type MeasCommand, type RealTrace as MeasRealTrace, type MeasResult } from './measurement';
import { solveDCRobust as solveDCRobustEngine } from './convergence';
import { DEFAULT_OPTIONS, type SimOptions, type ConvergenceReport } from './sim-options';
import './components'; // register all built-in plugins

// ===== ERC (Electrical Rule Check) =====
// Backward-compatible wrapper around the new full ERC engine in `erc.ts`.
// Use `runFullERC` directly for the full pin-conflict matrix + no-connect honor.

export type ERCError = import('./erc').ERCError;
export type ERCResult = import('./erc').ERCResult;

/** @deprecated use runFullERC for the complete rule set */
export function runERC(components: CircuitComponent[], wires: Wire[]): ERCResult {
  return runFullERC(components, wires, []);
}

// ===== Selection / Probe types =====

export interface Selection {
  type: 'component' | 'wire' | 'drawing' | 'group' | 'sheet' | null;
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
  // simulation error message (null = no error). Set when solver fails.
  simError: string | null;
  // physics validation results (debug — catches simulation bugs)
  physicsViolations: PhysicsViolation[];
  // probe traces (per oscilloscope)
  traces: ProbeTrace[];
  maxTraceSamples: number;
  // history — full document snapshot so undo/redo restore everything
  // (drawings, noConnects, groups, sheets, netClasses, pageSetup, etc.)
  past: ReturnType<typeof snapshot>[];
  future: ReturnType<typeof snapshot>[];
  // ui
  paused: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  // wire draft
  wireDraft: { from: { componentId: string; terminalId: string }; cursor: { x: number; y: number } } | null;
  // keyboard placement draft (a11y): type + pending position + rotation
  placementDraft: { type: string; position: { x: number; y: number }; rotation: number } | null;
  /** Screen-reader announcement (rendered into the ARIA live region). */
  announcement: string | null;

  // ── New KiCad-parity document state ──────────────────────────────────────
  sheets: HierarchicalSheet[];
  netClasses: NetClass[];
  drawings: DrawingPrimitive[];
  noConnects: NoConnectMarker[];
  groups: Group[];
  pageSetup: PageSetup;
  savedViews: SavedView[];
  childSheets: Record<string, CircuitDocument>;
  activeSheet: string;
  metadata: {
    title?: string;
    company?: string;
    revision?: string;
    date?: string;
    author?: string;
  };

  // ── Display / units / view state ──────────────────────────────────────────
  units: 'mm' | 'mil' | 'in' | 'grid';
  gridSize: number;             // grid spacing in grid units
  showPinNumbers: boolean;
  showPinNames: boolean;
  showPinElecTypes: boolean;
  showRefdes: boolean;
  showValues: boolean;
  showTitleBlock: boolean;
  /** color-code wires by net name (ground=gray, power=red, signal=cyan) */
  showNetColors: boolean;
  /** UI theme: 'dark' (default), 'light', or 'high-contrast' (WCAG AAA) */
  theme: 'dark' | 'light' | 'high-contrast';
  /** Customizable hotkeys (overrides defaults). Keys are hotkey names, values are key strings. */
  customHotkeys: Record<string, string>;
  activeTool: 'select' | 'wire' | 'bus' | 'label' | 'globalLabel' | 'hierLabel' | 'junction' | 'noConnect' | 'powerPort' | 'text' | 'line' | 'poly' | 'image';

  // actions
  addComponent: (type: string, position: { x: number; y: number }) => string;
  moveComponent: (id: string, position: { x: number; y: number }) => void;
  /** Push history once at drag start so the whole drag is a single undo step. */
  beginDrag: () => void;
  rotateComponent: (id: string) => void;
  /** Free rotation: rotate by arbitrary degrees (snapped to 15° increments). Stored as degrees. */
  rotateComponentFree: (id: string, degrees: number) => void;
  mirrorComponent: (id: string, axis: 'x' | 'y') => void;
  /** Toggle De Morgan alternate body style (convert 1 ↔ 2). No-op if plugin has no alternate body. */
  toggleDeMorgan: (id: string) => void;
  /** Swap two pins within a pin-swap group. Returns true if swap was legal. */
  swapPins: (id: string, pinIdA: string, pinIdB: string) => boolean;
  deleteComponent: (id: string) => void;
  deleteWire: (id: string) => void;
  setParameter: (id: string, key: string, value: number | string | boolean) => void;
  setSelection: (sel: Selection) => void;
  // multi-selection
  toggleMultiSelect: (type: 'component' | 'wire', id: string) => void;
  setMultiSelection: (sel: { components: Set<string>; wires: Set<string> }) => void;
  clearMultiSelection: () => void;
  moveSelectedComponents: (delta: { x: number; y: number }) => void;
  alignSelected: (axis: 'x' | 'y', mode: 'min' | 'max' | 'center') => void;
  distributeSelected: (axis: 'x' | 'y') => void;
  deleteSelected: () => void;
  mirrorSelected: (axis: 'x' | 'y') => void;
  rotateSelected: () => void;
  // copy/paste
  copySelection: () => void;
  paste: () => void;
  duplicate: () => void;
  // ERC
  runERC: () => ERCResult;
  runFullERCCheck: () => ERCResult;
  // annotation
  reannotate: () => void;
  reannotateByPosition: () => void;
  // fields
  setField: (compId: string, key: string, name: string, value: string, visible?: boolean) => void;
  removeField: (compId: string, key: string) => void;
  // lock
  toggleLock: (compId: string) => void;
  lockSelected: () => void;
  unlockSelected: () => void;
  // multi-unit
  setComponentUnit: (compId: string, unit: number) => void;
  setComponentConvert: (compId: string, convert: 1 | 2) => void;
  // net classes
  addNetClass: (name: string, description?: string) => string;
  updateNetClass: (id: string, patch: Partial<NetClass>) => void;
  removeNetClass: (id: string) => void;
  // drawings
  addDrawing: (d: DrawingPrimitive) => void;
  updateDrawing: (id: string, patch: Partial<DrawingPrimitive>) => void;
  removeDrawing: (id: string) => void;
  // no-connects
  addNoConnect: (componentId: string, terminalId: string) => void;
  removeNoConnect: (componentId: string, terminalId: string) => void;
  // groups
  createGroup: (name: string, componentIds: string[], wireIds?: string[], drawingIds?: string[]) => string;
  ungroup: (groupId: string) => void;
  // sheets
  addSheet: (sheetName: string, fileName: string) => string;
  removeSheet: (id: string) => void;
  setActiveSheet: (fileName: string) => void;
  /** Move a sheet box on the canvas (drag). Position is in grid coords. */
  moveSheet: (id: string, position: { x: number; y: number }) => void;
  /** Add a sheet pin to a sheet box. Auto-places on the right side if no side given. */
  addSheetPin: (sheetId: string, name: string, side?: 'top' | 'bottom' | 'left' | 'right') => string;
  /** Rename a sheet pin. */
  renameSheetPin: (sheetId: string, pinId: string, name: string) => void;
  /** Remove a sheet pin. */
  removeSheetPin: (sheetId: string, pinId: string) => void;
  /** Move a sheet pin to a new position (in grid coords, relative to sheet box). */
  moveSheetPin: (sheetId: string, pinId: string, position: { x: number; y: number }) => void;
  // saved views
  saveView: (name: string, camera: { x: number; y: number; zoom: number }) => string;
  loadView: (id: string) => SavedView | null;
  removeSavedView: (id: string) => void;
  // page setup
  setPageSetup: (patch: Partial<PageSetup>) => void;
  setMetadata: (patch: Partial<{ title: string; company: string; revision: string; date: string; author: string }>) => void;
  // display settings
  setUnits: (u: 'mm' | 'mil' | 'in' | 'grid') => void;
  setGridSize: (s: number) => void;
  setShowPinNumbers: (s: boolean) => void;
  setShowPinNames: (s: boolean) => void;
  setShowPinElecTypes: (s: boolean) => void;
  setShowRefdes: (s: boolean) => void;
  setShowValues: (s: boolean) => void;
  setShowTitleBlock: (s: boolean) => void;
  setShowNetColors: (s: boolean) => void;
  setTheme: (t: 'dark' | 'light' | 'high-contrast') => void;
  setHotkey: (name: string, key: string) => void;
  resetHotkeys: () => void;
  setActiveTool: (t: EditorState['activeTool']) => void;
  // wire ops
  startWire: (from: { componentId: string; terminalId: string }, cursor: { x: number; y: number }) => void;
  updateWireCursor: (cursor: { x: number; y: number }) => void;
  cancelWire: () => void;
  completeWire: (to: { componentId: string; terminalId: string }) => void;
  // keyboard placement (a11y)
  startPlacement: (type: string, position: { x: number; y: number }) => void;
  nudgePlacement: (dx: number, dy: number) => void;
  rotatePlacement: () => void;
  confirmPlacement: (repeat?: boolean) => void;
  cancelPlacement: () => void;
  /** Move the virtual keyboard focus (Tab / Shift+Tab) among components/wires. */
  focusCycle: (dir: 1 | -1) => void;
  /** Set the screen-reader announcement. */
  announce: (msg: string) => void;
  setWireWaypoints: (id: string, waypoints: { x: number; y: number }[]) => void;
  toggleSwitch: (id: string) => void;
  // find/replace
  findComponents: (query: string, opts?: { searchRefdes?: boolean; searchValue?: boolean; searchFields?: boolean; caseSensitive?: boolean }) => CircuitComponent[];
  replaceComponentParameter: (compId: string, key: string, newValue: string | number | boolean) => void;

  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
  clear: () => void;
  loadDocument: (doc: CircuitDocument) => void;
  serialize: () => CircuitDocument;

  setRunning: (running: boolean) => void;
  setSimError: (msg: string | null) => void;
  setSpeed: (s: number) => void;
  setDt: (dt: number) => void;
  step: () => void;
  reset: () => void;
  setShowGrid: (s: boolean) => void;
  setSnapToGrid: (s: boolean) => void;

  // ── Advanced analysis (KiCad ngspice parity) ──────────────────────────────
  /** last analysis result (AC/DC sweep/TF/etc.) — null if none yet */
  lastAnalysisResult: AnalysisResult | null;
  /** sim options — exposed to UI */
  simOptions: SimOptions;
  /** run an analysis (AC/DC/TF/etc.) and store result */
  runAnalysis: (config: AnalysisConfig) => AnalysisResult;
  /** run a batch sweep (.step / .mc / .worst) */
  runBatch: (config: BatchConfig) => BatchResult;
  /** run a .meas post-process on a trace */
  runMeasurement: (cmd: MeasCommand, trace: MeasRealTrace) => MeasResult;
  /** update sim options (reltol, gmin, method, temp, etc.) */
  setSimOptions: (patch: Partial<SimOptions>) => void;
  /** robust DC operating point using convergence aids */
  solveDCRobust: () => { sim: SimContext | null; report: ConvergenceReport };
}

let idCounter = 0;
function genId(prefix: string = 'c') {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

/** Get the reference designator prefix for a component type */
function refdesPrefix(type: string): string {
  switch (type) {
    case 'resistor': return 'R';
    case 'capacitor': return 'C';
    case 'inductor': return 'L';
    case 'led': return 'LED';
    case 'diode': return 'D';
    case 'zener': return 'DZ';
    case 'schottky': return 'D';
    case 'dcVoltage':
    case 'acVoltage':
    case 'pulseSource': return 'V';
    case 'currentSource': return 'I';
    case 'timer555':
    case 'opamp':
    case 'opampRails':
    case 'voltageRegulator':
    case 'vco': return 'U';
    case 'npn':
    case 'pnp':
    case 'nmos':
    case 'pmos': return 'Q';
    case 'switch':
    case 'pushButton': return 'SW';
    case 'fuse': return 'F';
    case 'crystal': return 'Y';
    case 'transformer': return 'T';
    case 'speaker':
    case 'buzzer': return 'LS';
    case 'dcMotor': return 'M';
    case 'photoresistor': return 'LDR';
    case 'sevenSegment': return 'DSP';
    case 'ground':
    case 'powerGND': return 'GND';
    case 'junction': return 'J';
    case 'oscilloscope':
    case 'voltmeter':
    case 'ammeter': return 'TP';
    case 'arduino':
    case 'arduinoReal':
    case 'raspberryPi': return 'U';
    case 'netLabel':
    case 'busLabel': return 'NL';
    case 'bus': return 'BUS';
    default:
      if (type.startsWith('7400_') || type.startsWith('7402_') || type.startsWith('7404_') ||
          type.startsWith('7408_') || type.startsWith('7432_') || type.startsWith('7486_') ||
          type.startsWith('7474_')) return 'U';
      if (type.startsWith('custom_')) return 'U';
      return 'U';
  }
}

/** Generate the next refdes for a given type, based on existing components */
function nextRefdes(type: string, components: CircuitComponent[]): string {
  const prefix = refdesPrefix(type);
  let maxNum = 0;
  for (const c of components) {
    if (refdesPrefix(c.type) === prefix) {
      const ref = c.refdes ?? c.id;
      const match = ref.match(/(\d+)$/);
      if (match) {
        const n = parseInt(match[1]);
        if (n > maxNum) maxNum = n;
      }
    }
  }
  return `${prefix}${maxNum + 1}`;
}

function snapshot(s: {
  components: CircuitComponent[];
  wires: Wire[];
  drawings?: DrawingPrimitive[];
  noConnects?: NoConnectMarker[];
  groups?: Group[];
  sheets?: HierarchicalSheet[];
  netClasses?: NetClass[];
  pageSetup?: any;
  metadata?: any;
  savedViews?: any[];
  childSheets?: Record<string, any>;
  activeSheet?: string;
}) {
  return {
    components: s.components.map((c) => ({ ...c, parameters: { ...c.parameters }, simState: undefined, fields: c.fields ? c.fields.map((f) => ({ ...f })) : undefined })),
    wires: s.wires.map((w) => ({ ...w })),
    drawings: s.drawings ? s.drawings.map((d) => ({ ...d })) : [],
    noConnects: s.noConnects ? s.noConnects.map((n) => ({ ...n })) : [],
    groups: s.groups ? s.groups.map((g) => ({ ...g, componentIds: [...g.componentIds], wireIds: [...g.wireIds], drawingIds: [...g.drawingIds] })) : [],
    sheets: s.sheets ? s.sheets.map((sh) => ({ ...sh, pins: sh.pins.map((p) => ({ ...p })) })) : [],
    netClasses: s.netClasses ? s.netClasses.map((nc) => ({ ...nc, nets: [...nc.nets] })) : [],
    // Capture page setup + metadata too so undo restores the full document.
    pageSetup: s.pageSetup ? { ...s.pageSetup } : undefined,
    metadata: s.metadata ? { ...s.metadata } : undefined,
    savedViews: s.savedViews ? s.savedViews.map((v) => ({ ...v })) : undefined,
    childSheets: s.childSheets ? { ...s.childSheets } : undefined,
    activeSheet: s.activeSheet,
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
  simError: null,
  physicsViolations: [],
  traces: [],
  maxTraceSamples: 500,
  past: [],
  future: [],
  paused: true,
  showGrid: true,
  snapToGrid: true,
  wireDraft: null,
  placementDraft: null,
  announcement: null,
  // new doc state
  sheets: [],
  netClasses: [],
  drawings: [],
  noConnects: [],
  groups: [],
  pageSetup: { ...DEFAULT_PAGE_SETUP },
  savedViews: [],
  childSheets: {},
  activeSheet: '',
  metadata: { title: 'Untitled', revision: 'Rev 1', date: new Date().toISOString().slice(0, 10) },
  // display
  units: 'grid',
  gridSize: 1,
  showPinNumbers: false,
  showPinNames: false,
  showPinElecTypes: false,
  showRefdes: true,
  showValues: true,
  showTitleBlock: false,
  showNetColors: true,
  theme: 'dark',
  customHotkeys: {},
  activeTool: 'select',

  addComponent: (type, position) => {
    get().pushHistory();
    const id = genId('comp');
    const s = get();
    const refdes = nextRefdes(type, s.components);
    const comp: CircuitComponent = {
      id,
      type,
      position: { ...position },
      rotation: 0,
      parameters: defaultsFor(type),
      refdes,
    };
    set((s) => ({ components: [...s.components, comp], selection: { type: 'component', id } }));
    return id;
  },

  beginDrag: () => {
    // Push a single history entry at drag start. The canvas calls this on
    // mousedown before the first moveComponent() so that the entire drag
    // sequence becomes a single Ctrl+Z undo step (instead of one entry
    // per mousemove, which would flood the history stack).
    get().pushHistory();
  },

  moveComponent: (id, position) => {
    // Note: pushHistory() is called once at drag START (via beginDrag),
    // not on every mousemove. Calling it here would flood the history stack
    // with hundreds of micro-moves.
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

  mirrorComponent: (id, axis) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id
          ? { ...c, [axis === 'x' ? 'mirrorX' : 'mirrorY']: !c[axis === 'x' ? 'mirrorX' : 'mirrorY'] }
          : c,
      ),
    }));
  },

  rotateComponentFree: (id, degrees) => {
    // Snap to 15° increments (24 distinct angles). Stored in `rotationDeg`.
    // The canvas's render loop should use rotationDeg if present, otherwise fall back to rotation*90.
    get().pushHistory();
    const snapped = Math.round(degrees / 15) * 15;
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, rotationDeg: snapped } : c,
      ),
    }));
  },

  toggleDeMorgan: (id) => {
    const comp = get().components.find((c) => c.id === id);
    if (!comp) return;
    const plugin = getPlugin(comp.type);
    if (!plugin?.hasAlternateBody) return;
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === id ? { ...c, convert: c.convert === 2 ? 1 : 2 } : c,
      ),
    }));
  },

  swapPins: (id, pinIdA, pinIdB) => {
    const comp = get().components.find((c) => c.id === id);
    if (!comp) return false;
    const plugin = getPlugin(comp.type);
    if (!plugin?.pinSwapGroups) return false;
    // Check if both pins are in the same swap group
    const inSameGroup = plugin.pinSwapGroups.some((group) =>
      group.includes(pinIdA) && group.includes(pinIdB),
    );
    if (!inSameGroup) return false;
    // Swap: we re-emit all wires that referenced pinIdA to pinIdB and vice versa.
    // This requires walking the wires array and swapping terminal IDs.
    get().pushHistory();
    set((s) => ({
      wires: s.wires.map((w) => {
        if (w.from.componentId === id && w.from.terminalId === pinIdA) {
          return { ...w, from: { ...w.from, terminalId: pinIdB } };
        }
        if (w.from.componentId === id && w.from.terminalId === pinIdB) {
          return { ...w, from: { ...w.from, terminalId: pinIdA } };
        }
        if (w.to.componentId === id && w.to.terminalId === pinIdA) {
          return { ...w, to: { ...w.to, terminalId: pinIdB } };
        }
        if (w.to.componentId === id && w.to.terminalId === pinIdB) {
          return { ...w, to: { ...w.to, terminalId: pinIdA } };
        }
        return w;
      }),
    }));
    return true;
  },

  deleteComponent: (id) => {
    get().pushHistory();
    // Clean up orphaned sim-state entries for the deleted component — with
    // EXACT key matching. The old substring match (`key.includes('_'+id)`)
    // also wiped other components whose ids share a prefix (deleting
    // comp_x_5 destroyed cap_comp_x_51's state).
    const s = get();
    cleanupComponentState(s.simContext, s.components.filter((c) => c.id !== id));
    set((s2) => ({
      components: s2.components.filter((c) => c.id !== id),
      wires: s2.wires.filter((w) => w.from.componentId !== id && w.to.componentId !== id),
      selection: { type: null, id: null },
      traces: s2.traces.filter((t) => t.componentId !== id),
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
    // KiCad parity: parameter edits must be undoable. Coalesce rapid edits into a single history entry.
    const s = get();
    const last = s.past[s.past.length - 1];
    const isCoalescing = last &&
      (last as any).__paramEdit?.id === id &&
      (last as any).__paramEdit?.key === key &&
      Date.now() - ((last as any).__paramEdit?.ts ?? 0) < 1500;
    if (!isCoalescing) {
      get().pushHistory();
      // mark the snapshot as a param-edit so subsequent edits to same param can coalesce
      const cur = get();
      if (cur.past.length > 0) {
        (cur.past[cur.past.length - 1] as any).__paramEdit = { id, key, ts: Date.now() };
      }
    }
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

  alignSelected: (axis: 'x' | 'y', mode: 'min' | 'max' | 'center') => {
    const s = get();
    const ids = new Set(s.multiSelection.components);
    if (s.selection.type === 'component' && s.selection.id) ids.add(s.selection.id);
    if (ids.size < 2) return;
    s.pushHistory();
    const selected = s.components.filter(c => ids.has(c.id));
    if (selected.length < 2) return;
    let target: number;
    if (mode === 'min') {
      target = axis === 'x' ? Math.min(...selected.map(c => c.position.x)) : Math.min(...selected.map(c => c.position.y));
    } else if (mode === 'max') {
      target = axis === 'x' ? Math.max(...selected.map(c => c.position.x)) : Math.max(...selected.map(c => c.position.y));
    } else {
      target = axis === 'x'
        ? selected.reduce((sum, c) => sum + c.position.x, 0) / selected.length
        : selected.reduce((sum, c) => sum + c.position.y, 0) / selected.length;
    }
    set((s) => ({
      components: s.components.map(c => {
        if (!ids.has(c.id)) return c;
        if (axis === 'x') return { ...c, position: { ...c.position, x: target } };
        return { ...c, position: { ...c.position, y: target } };
      }),
    }));
  },

  distributeSelected: (axis: 'x' | 'y') => {
    const s = get();
    const ids = new Set(s.multiSelection.components);
    if (s.selection.type === 'component' && s.selection.id) ids.add(s.selection.id);
    if (ids.size < 3) return;
    s.pushHistory();
    const selected = s.components.filter(c => ids.has(c.id)).sort((a, b) =>
      axis === 'x' ? a.position.x - b.position.x : a.position.y - b.position.y
    );
    if (selected.length < 3) return;
    const first = selected[0];
    const last = selected[selected.length - 1];
    const start = axis === 'x' ? first.position.x : first.position.y;
    const end = axis === 'x' ? last.position.x : last.position.y;
    const step = (end - start) / (selected.length - 1);
    const idToPos = new Map<string, number>();
    selected.forEach((c, i) => {
      idToPos.set(c.id, start + step * i);
    });
    set((s) => ({
      components: s.components.map(c => {
        const pos = idToPos.get(c.id);
        if (pos === undefined) return c;
        if (axis === 'x') return { ...c, position: { ...c.position, x: pos } };
        return { ...c, position: { ...c.position, y: pos } };
      }),
    }));
  },

  deleteSelected: () => {
    get().pushHistory();
    set((s) => {
      const idsToDelete = new Set(s.multiSelection.components);
      if (s.selection.type === 'component' && s.selection.id) idsToDelete.add(s.selection.id);
      const wiresToDelete = new Set(s.multiSelection.wires);
      if (s.selection.type === 'wire' && s.selection.id) wiresToDelete.add(s.selection.id);
      const remaining = s.components.filter((c) => !idsToDelete.has(c.id));
      // Clean up orphaned sim state and traces exactly like deleteComponent —
      // deleting an oscilloscope via multi-select used to leave its trace in
      // the probe panel and leak every deleted component's state keys.
      cleanupComponentState(s.simContext, remaining);
      return {
        components: remaining,
        wires: s.wires.filter((w) => !wiresToDelete.has(w.id) &&
          !idsToDelete.has(w.from.componentId) && !idsToDelete.has(w.to.componentId)),
        selection: { type: null, id: null },
        multiSelection: { components: new Set(), wires: new Set() },
        traces: s.traces.filter((t) => !idsToDelete.has(t.componentId)),
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
    // Paste at +3,+3 offset from original positions (better than +2,+2)
    const newComponents = s.clipboard.components.map((c) => {
      const newId = genId('comp');
      idMap.set(c.id, newId);
      return { ...c, id: newId, position: { x: c.position.x + 3, y: c.position.y + 3 }, parameters: { ...c.parameters }, simState: undefined };
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
    // Toast feedback for paste
    if (typeof window !== 'undefined') {
      import('sonner').then(({ toast }) => {
        toast.success(`Pasted ${newComponents.length} component(s)`);
      }).catch(() => {});
    }
  },

  duplicate: () => { get().copySelection(); get().paste(); },

  // ===== ERC =====
  runERC: () => {
    const s = get();
    const result = runERC(s.components, s.wires);
    set({ ercErrors: result.errors });
    return result;
  },

  runFullERCCheck: () => {
    const s = get();
    // Run ERC across the flattened hierarchy so cross-sheet errors are caught
    let ercComponents = s.components;
    let ercWires = s.wires;
    if (s.activeSheet || s.sheets.length > 0) {
      let childSheets = s.childSheets;
      if (s.activeSheet) {
        childSheets = {
          ...childSheets,
          [s.activeSheet]: snapshotSheet(s.components, s.wires, s.sheets),
        };
      }
      const rootDoc = s.activeSheet
        ? (childSheets as any).__root__ ?? { version: 1 as const, components: [], wires: [], sheets: [] }
        : { version: 1 as const, components: s.components, wires: s.wires, sheets: s.sheets };
      const flat = flattenHierarchy(rootDoc as any, childSheets as any);
      ercComponents = flat.components;
      ercWires = flat.wires;
    }
    const result = runFullERC(ercComponents, ercWires, s.noConnects);
    set({ ercErrors: result.errors });
    return result;
  },

  reannotate: () => {
    get().pushHistory();
    const s = get();
    const counters: Record<string, number> = {};
    const newComponents = s.components.map((c) => {
      const prefix = refdesPrefix(c.type);
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      return { ...c, refdes: `${prefix}${counters[prefix]}` };
    });
    set({ components: newComponents });
  },

  // KiCad parity: annotate by X-then-Y position (left-to-right, top-to-bottom)
  reannotateByPosition: () => {
    get().pushHistory();
    const s = get();
    // stable sort: y asc (top first), then x asc (left first)
    const sorted = [...s.components].sort((a, b) => {
      if (Math.abs(a.position.y - b.position.y) > 0.5) return a.position.y - b.position.y;
      return a.position.x - b.position.x;
    });
    const counters: Record<string, number> = {};
    const updates = new Map<string, string>();
    for (const c of sorted) {
      const prefix = refdesPrefix(c.type);
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      updates.set(c.id, `${prefix}${counters[prefix]}`);
    }
    set({
      components: s.components.map((c) => updates.has(c.id) ? { ...c, refdes: updates.get(c.id)! } : c),
    });
  },

  // ===== Component fields (KiCad "Fields" tab) =====
  setField: (compId, key, name, value, visible = true) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) => {
        if (c.id !== compId) return c;
        const fields = c.fields ? [...c.fields] : [];
        const idx = fields.findIndex((f) => f.key === key);
        if (idx >= 0) fields[idx] = { ...fields[idx], name, value, visible };
        else fields.push({ key, name, value, visible });
        return { ...c, fields };
      }),
    }));
  },
  removeField: (compId, key) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) => {
        if (c.id !== compId || !c.fields) return c;
        return { ...c, fields: c.fields.filter((f) => f.key !== key) };
      }),
    }));
  },

  // ===== Lock =====
  toggleLock: (compId) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === compId ? { ...c, locked: !c.locked } : c,
      ),
    }));
  },
  lockSelected: () => {
    get().pushHistory();
    set((s) => {
      const ids = new Set(s.multiSelection.components);
      if (s.selection.type === 'component' && s.selection.id) ids.add(s.selection.id);
      return {
        components: s.components.map((c) => ids.has(c.id) ? { ...c, locked: true } : c),
      };
    });
  },
  unlockSelected: () => {
    get().pushHistory();
    set((s) => {
      const ids = new Set(s.multiSelection.components);
      if (s.selection.type === 'component' && s.selection.id) ids.add(s.selection.id);
      return {
        components: s.components.map((c) => ids.has(c.id) ? { ...c, locked: false } : c),
      };
    });
  },

  // ===== Multi-unit components =====
  setComponentUnit: (compId, unit) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === compId ? { ...c, unit } : c,
      ),
    }));
  },
  setComponentConvert: (compId, convert) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) =>
        c.id === compId ? { ...c, convert } : c,
      ),
    }));
  },

  // ===== Mirror/Rotate selection =====
  mirrorSelected: (axis) => {
    get().pushHistory();
    set((s) => {
      const ids = new Set(s.multiSelection.components);
      if (s.selection.type === 'component' && s.selection.id) ids.add(s.selection.id);
      const field = axis === 'x' ? 'mirrorX' : 'mirrorY';
      return {
        components: s.components.map((c) =>
          ids.has(c.id) ? { ...c, [field]: !c[field] } : c,
        ),
      };
    });
  },
  rotateSelected: () => {
    get().pushHistory();
    set((s) => {
      const ids = new Set(s.multiSelection.components);
      if (s.selection.type === 'component' && s.selection.id) ids.add(s.selection.id);
      return {
        components: s.components.map((c) =>
          ids.has(c.id) ? { ...c, rotation: (((c.rotation + 1) % 4) as 0 | 1 | 2 | 3) } : c,
        ),
      };
    });
  },

  // ===== Net classes =====
  addNetClass: (name, description) => {
    const id = genId('nc');
    set((s) => ({
      netClasses: [...s.netClasses, { id, name, description: description ?? '', nets: [], color: '#22d3ee' }],
    }));
    return id;
  },
  updateNetClass: (id, patch) => {
    get().pushHistory();
    set((s) => ({
      netClasses: s.netClasses.map((nc) => nc.id === id ? { ...nc, ...patch } : nc),
    }));
  },
  removeNetClass: (id) => {
    get().pushHistory();
    set((s) => ({
      netClasses: s.netClasses.filter((nc) => nc.id !== id),
      components: s.components.map((c) => c.netClassId === id ? { ...c, netClassId: undefined } : c),
    }));
  },

  // ===== Drawings =====
  addDrawing: (d) => {
    get().pushHistory();
    set((s) => ({ drawings: [...s.drawings, d] }));
  },
  updateDrawing: (id, patch) => {
    set((s) => ({
      drawings: s.drawings.map((d) => d.id === id ? { ...d, ...patch } as DrawingPrimitive : d),
    }));
  },
  removeDrawing: (id) => {
    get().pushHistory();
    set((s) => ({ drawings: s.drawings.filter((d) => d.id !== id) }));
  },

  // ===== No-Connect markers =====
  addNoConnect: (componentId, terminalId) => {
    get().pushHistory();
    set((s) => ({
      noConnects: s.noConnects.filter((n) => !(n.componentId === componentId && n.terminalId === terminalId)),
    }));
    set((s) => ({
      noConnects: [...s.noConnects, { id: genId('nc'), componentId, terminalId }],
    }));
  },
  removeNoConnect: (componentId, terminalId) => {
    get().pushHistory();
    set((s) => ({
      noConnects: s.noConnects.filter((n) => !(n.componentId === componentId && n.terminalId === terminalId)),
    }));
  },

  // ===== Groups =====
  createGroup: (name, componentIds, wireIds = [], drawingIds = []) => {
    const id = genId('grp');
    get().pushHistory();
    set((s) => ({
      groups: [...s.groups, { id, name, componentIds: [...componentIds], wireIds: [...wireIds], drawingIds: [...drawingIds] }],
    }));
    return id;
  },
  ungroup: (groupId) => {
    get().pushHistory();
    set((s) => ({ groups: s.groups.filter((g) => g.id !== groupId) }));
  },

  // ===== Hierarchical sheets =====
  addSheet: (sheetName, fileName) => {
    const id = genId('sheet');
    get().pushHistory();
    set((s) => ({
      sheets: [...s.sheets, {
        id, sheetName, fileName,
        position: { x: 20, y: 10 },
        size: { width: 10, height: 6 },
        pins: [],
      }],
      childSheets: { ...s.childSheets, [fileName]: { version: 1, components: [], wires: [] } },
    }));
    return id;
  },
  removeSheet: (id) => {
    get().pushHistory();
    set((s) => {
      const sheet = s.sheets.find((sh) => sh.id === id);
      const newChild = { ...s.childSheets };
      if (sheet) delete newChild[sheet.fileName];
      return {
        sheets: s.sheets.filter((sh) => sh.id !== id),
        childSheets: newChild,
      };
    });
  },
  setActiveSheet: (fileName) => {
    const s = get();
    // Snapshot the current sheet into childSheets (or root, kept implicitly as the
    // active components/wires when activeSheet === '').
    const currentSheetFileName = s.activeSheet;
    if (currentSheetFileName) {
      // Save the current sheet's contents back to childSheets[currentSheetFileName]
      const snap = snapshotSheet(s.components, s.wires, s.sheets);
      set((st) => ({
        childSheets: {
          ...st.childSheets,
          [currentSheetFileName]: snap,
        },
      }));
    } else {
      // We were on root — root's components/wires stay in place (no swap needed
      // when navigating back to root, just restore the saved snapshot below
      // when going elsewhere).
    }

    if (!fileName) {
      // Navigating back to root — restore root's saved snapshot if we have one.
      // Root's components/wires are kept as the "current" state when on root,
      // so if we're already on root there's nothing to do. If we're returning
      // from a sub-sheet, the root snapshot is in `childSheets['__root__']`
      // (a special key we use to preserve root state across sub-sheet edits).
      const rootSnap = (s.childSheets as any)['__root__'];
      if (rootSnap) {
        set({
          activeSheet: '',
          components: rootSnap.components,
          wires: rootSnap.wires,
          sheets: rootSnap.sheets ?? [],
        });
        // Remove the temporary __root__ key
        const newChild = { ...get().childSheets };
        delete (newChild as any)['__root__'];
        set({ childSheets: newChild });
      } else {
        set({ activeSheet: '' });
      }
      return;
    }

    // Save current root state into __root__ if we're leaving root
    if (!currentSheetFileName) {
      const rootSnap = snapshotSheet(s.components, s.wires, s.sheets);
      set((st) => ({
        childSheets: {
          ...st.childSheets,
          __root__: rootSnap as any,
        },
      }));
    }

    // Switch to the target sub-sheet
    const targetDoc = get().childSheets[fileName];
    if (targetDoc) {
      set({
        activeSheet: fileName,
        components: targetDoc.components ?? [],
        wires: targetDoc.wires ?? [],
        sheets: (targetDoc as any).sheets ?? [],
      });
    } else {
      // Sub-sheet doesn't exist yet — create an empty one
      set({
        activeSheet: fileName,
        components: [],
        wires: [],
        sheets: [],
      });
    }
  },

  moveSheet: (id, position) => {
    // No pushHistory here: fires on every mousemove of a sheet drag (the
    // canvas pushes once at drag start).
    set((s) => ({
      sheets: s.sheets.map((sh) => sh.id === id ? { ...sh, position } : sh),
    }));
  },

  addSheetPin: (sheetId, name, side = 'right') => {
    const id = genId('pin');
    get().pushHistory();
    set((s) => ({
      sheets: s.sheets.map((sh) => {
        if (sh.id !== sheetId) return sh;
        // Auto-place on the chosen side
        const pinsOnSide = sh.pins.filter((p) => p.side === side);
        const idx = pinsOnSide.length + 1;
        let position: { x: number; y: number };
        switch (side) {
          case 'left':   position = { x: 0, y: idx }; break;
          case 'right':  position = { x: sh.size.width, y: idx }; break;
          case 'top':    position = { x: idx, y: 0 }; break;
          case 'bottom': position = { x: idx, y: sh.size.height }; break;
        }
        return {
          ...sh,
          pins: [...sh.pins, {
            id, name, electricalType: 'passive' as const,
            position, side,
          }],
        };
      }),
    }));
    return id;
  },

  renameSheetPin: (sheetId, pinId, name) => {
    get().pushHistory();
    set((s) => ({
      sheets: s.sheets.map((sh) => sh.id !== sheetId ? sh : {
        ...sh,
        pins: sh.pins.map((p) => p.id === pinId ? { ...p, name } : p),
      }),
    }));
  },

  removeSheetPin: (sheetId, pinId) => {
    get().pushHistory();
    set((s) => ({
      sheets: s.sheets.map((sh) => sh.id !== sheetId ? sh : {
        ...sh,
        pins: sh.pins.filter((p) => p.id !== pinId),
      }),
    }));
  },

  moveSheetPin: (sheetId, pinId, position) => {
    get().pushHistory();
    set((s) => ({
      sheets: s.sheets.map((sh) => sh.id !== sheetId ? sh : {
        ...sh,
        pins: sh.pins.map((p) => p.id === pinId ? { ...p, position } : p),
      }),
    }));
  },

  // ===== Saved views =====
  saveView: (name, camera) => {
    const id = genId('view');
    set((s) => ({ savedViews: [...s.savedViews, { id, name, camera }] }));
    return id;
  },
  loadView: (id) => {
    const s = get();
    return s.savedViews.find((v) => v.id === id) ?? null;
  },
  removeSavedView: (id) => {
    set((s) => ({ savedViews: s.savedViews.filter((v) => v.id !== id) }));
  },

  // ===== Page setup & metadata =====
  setPageSetup: (patch) => {
    get().pushHistory();
    set((s) => ({ pageSetup: { ...s.pageSetup, ...patch } }));
  },
  setMetadata: (patch) => {
    get().pushHistory();
    set((s) => ({ metadata: { ...s.metadata, ...patch } }));
  },

  // ===== Display =====
  setUnits: (u) => set({ units: u }),
  setGridSize: (s) => set({ gridSize: s }),
  setShowPinNumbers: (s) => set({ showPinNumbers: s }),
  setShowNetColors: (s) => set({ showNetColors: s }),
  setShowPinNames: (s) => set({ showPinNames: s }),
  setShowPinElecTypes: (s) => set({ showPinElecTypes: s }),
  setShowRefdes: (s) => set({ showRefdes: s }),
  setShowValues: (s) => set({ showValues: s }),
  setShowTitleBlock: (s) => set({ showTitleBlock: s }),
  setTheme: (t) => set({ theme: t }),
  setHotkey: (name, key) => set((s) => ({ customHotkeys: { ...s.customHotkeys, [name]: key } })),
  resetHotkeys: () => set({ customHotkeys: {} }),
  setActiveTool: (t) => set({ activeTool: t }),

  // ===== Find / Replace =====
  findComponents: (query, opts = {}) => {
    const s = get();
    if (!query) return [];
    const { searchRefdes = true, searchValue = true, searchFields = true, caseSensitive = false } = opts;
    const q = caseSensitive ? query : query.toLowerCase();
    return s.components.filter((c) => {
      if (searchRefdes) {
        const r = c.refdes ?? c.id;
        if ((caseSensitive ? r : r.toLowerCase()).includes(q)) return true;
      }
      if (searchValue) {
        for (const v of Object.values(c.parameters)) {
          const s = String(v);
          if ((caseSensitive ? s : s.toLowerCase()).includes(q)) return true;
        }
      }
      if (searchFields && c.fields) {
        for (const f of c.fields) {
          const combined = `${f.name}=${f.value}`;
          if ((caseSensitive ? combined : combined.toLowerCase()).includes(q)) return true;
        }
      }
      return false;
    });
  },
  replaceComponentParameter: (compId, key, newValue) => {
    get().pushHistory();
    set((s) => ({
      components: s.components.map((c) => {
        if (c.id !== compId) return c;
        const params = { ...c.parameters };
        // try to preserve type: if old was number, coerce newValue to number
        const old = params[key];
        if (typeof old === 'number') {
          const n = parseFloat(newValue as string);
          params[key] = isNaN(n) ? newValue : n;
        } else if (typeof old === 'boolean') {
          params[key] = (newValue === 'true' || newValue === true || newValue === '1');
        } else {
          params[key] = newValue;
        }
        return { ...c, parameters: params };
      }),
    }));
  },

  startWire: (from, cursor) => set({ wireDraft: { from, cursor } }),
  updateWireCursor: (cursor) => set((s) => (s.wireDraft ? { wireDraft: { ...s.wireDraft, cursor } } : {})),
  cancelWire: () => set({ wireDraft: null }),

  // ── Keyboard placement (a11y) ─────────────────────────────────────────────
  startPlacement: (type, position) => {
    set({
      placementDraft: { type, position: { ...position }, rotation: 0 },
      announcement: `Placing ${type}. Arrow keys move, Enter places, Escape cancels.`,
    });
  },
  nudgePlacement: (dx, dy) => {
    set((s) => s.placementDraft ? {
      placementDraft: {
        ...s.placementDraft,
        position: {
          x: Math.max(0, s.placementDraft.position.x + dx),
          y: Math.max(0, s.placementDraft.position.y + dy),
        },
      },
    } : {});
  },
  rotatePlacement: () => {
    set((s) => s.placementDraft ? {
      placementDraft: { ...s.placementDraft, rotation: ((s.placementDraft.rotation + 1) % 4) as 0 | 1 | 2 | 3 },
    } : {});
  },
  confirmPlacement: (repeat = false) => {
    const draft = get().placementDraft;
    if (!draft) return;
    // addComponent pushes history, assigns refdes, selects the new part.
    const id = get().addComponent(draft.type, draft.position);
    // apply the draft rotation to the freshly placed part
    const rot = draft.rotation as 0 | 1 | 2 | 3;
    if (rot !== 0) {
      set((s) => ({
        components: s.components.map((c) =>
          c.id === id ? { ...c, rotation: rot } : c,
        ),
      }));
    }
    if (repeat) {
      // Shift+Enter: keep placing — offset the next draft so instances
      // don't stack on top of each other.
      set({
        placementDraft: { ...draft, position: { x: draft.position.x + 3, y: draft.position.y + 3 }, rotation: 0 },
        announcement: `Placed ${draft.type}. Continue placing — arrow keys move, Enter places.`,
      });
    } else {
      set({ placementDraft: null, announcement: `Placed ${draft.type}.` });
    }
  },
  cancelPlacement: () => set({ placementDraft: null, announcement: 'Placement cancelled.' }),

  // ── Virtual keyboard focus (a11y): Tab / Shift+Tab cycling ────────────────
  // Reuses `selection` as the focus target so every selection-based shortcut
  // (Delete, R, X, PropertyPanel) works on the focused item for free.
  focusCycle: (dir) => {
    const s = get();
    const items: { type: 'component' | 'wire'; id: string }[] = [
      ...s.components.map((c) => ({ type: 'component' as const, id: c.id })),
      ...s.wires.map((w) => ({ type: 'wire' as const, id: w.id })),
    ];
    if (items.length === 0) return;
    const cur = s.selection && s.selection.type !== 'group' && s.selection.type !== 'sheet'
      ? items.findIndex((it) => it.type === s.selection!.type && it.id === s.selection!.id)
      : -1;
    const next = cur === -1
      ? (dir === 1 ? 0 : items.length - 1)
      : (cur + dir + items.length) % items.length;
    const target = items[next];
    // Human-readable announcement: "R1 resistor, 2 of 12 components"
    let label = target.id;
    let kind: string = target.type;
    if (target.type === 'component') {
      const c = s.components.find((x) => x.id === target.id);
      if (c) {
        label = c.refdes ?? c.id;
        kind = c.type;
      }
    }
    const compCount = s.components.length;
    const wireCount = s.wires.length;
    const pos = target.type === 'component' ? next + 1 : next - compCount + 1;
    set({
      selection: { type: target.type, id: target.id },
      multiSelection: { components: new Set(), wires: new Set() },
      announcement: `${label} ${kind}, ${pos} of ${target.type === 'component' ? compCount : wireCount} ${target.type}s`,
    });
  },

  announce: (msg) => set({ announcement: msg }),

  completeWire: (to) => {
    const draft = get().wireDraft;
    if (!draft) return;
    if (draft.from.componentId === to.componentId && draft.from.terminalId === to.terminalId) {
      set({ wireDraft: null });
      return;
    }
    get().pushHistory();
    const id = genId('wire');

    // Try smart wire routing (A* with obstacle avoidance) — falls back to
    // simple L-shaped routing if findRoute fails or isn't available.
    let waypoints: { x: number; y: number }[] | undefined;
    try {
      const s = get();
      const plugins = new Map(getAllPlugins().map((p: any) => [p.type, p]));
      const grid = buildRoutingGrid(s.components, s.wires, plugins, { width: 100, height: 60 }, 5);
      // Resolve terminal positions
      const fromComp = s.components.find((c: any) => c.id === draft.from.componentId);
      const toComp = s.components.find((c: any) => c.id === to.componentId);
      if (fromComp && toComp) {
        const fromTerm = (plugins.get(fromComp.type) as any)?.terminals.find((t: any) => t.id === draft.from.terminalId);
        const toTerm = (plugins.get(toComp.type) as any)?.terminals.find((t: any) => t.id === to.terminalId);
        if (fromTerm && toTerm) {
          const startPos = { x: fromComp.position.x + fromTerm.position.x, y: fromComp.position.y + fromTerm.position.y };
          const endPos = { x: toComp.position.x + toTerm.position.x, y: toComp.position.y + toTerm.position.y };
          const route = findRoute(grid, startPos, endPos);
          if (route.path.length > 2) {
            waypoints = pathToWaypoints(route.path);
          }
        }
      }
    } catch {
      // Smart router failed — use simple L-shape (no waypoints)
    }

    const wire: Wire = { id, from: draft.from, to };
    if (waypoints && waypoints.length > 0) wire.waypoints = waypoints;
    set((s) => ({ wires: [...s.wires, wire], wireDraft: null }));
  },

  setWireWaypoints: (id, waypoints) => {
    // No pushHistory here: this fires on EVERY mousemove during a wire-handle
    // drag. The canvas pushes one history entry at drag start (same pattern
    // as component drags) — pushing per-move flooded the 100-entry history
    // and made undo retreat one waypoint tweak at a time.
    set((s) => ({
      wires: s.wires.map((w) => (w.id === id ? { ...w, waypoints: waypoints.length > 0 ? waypoints : undefined } : w)),
    }));
  },

  toggleSwitch: (id) => {
    // Switch toggles change circuit topology (open ↔ closed) — must be undoable.
    get().pushHistory();
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
    const hadPast = get().past.length > 0;
    set((s) => {
      if (s.past.length === 0) return {};
      const prev = s.past[s.past.length - 1];
      const current = snapshot(s);
      return {
        past: s.past.slice(0, -1),
        future: [current, ...s.future].slice(0, MAX_HISTORY),
        components: prev.components,
        wires: prev.wires,
        drawings: prev.drawings,
        noConnects: prev.noConnects,
        groups: prev.groups,
        sheets: prev.sheets,
        netClasses: prev.netClasses,
        // Restore the FULL document snapshot. Dropping these fields made
        // setPageSetup/setMetadata edits permanently un-undoable (history
        // was captured but never restored) and let undo cross a sheet
        // switch, corrupting sub-sheets with root content.
        pageSetup: prev.pageSetup,
        metadata: prev.metadata,
        savedViews: prev.savedViews,
        childSheets: prev.childSheets,
        activeSheet: prev.activeSheet,
        selection: { type: null, id: null },
        multiSelection: { components: new Set(), wires: new Set() },
      };
    });
    // Toast feedback — fire after state update so it's visible to the user
    if (hadPast && typeof window !== 'undefined') {
      import('sonner').then(({ toast }) => {
        toast.info('Undo', { description: `${get().future.length} redo available`, duration: 2000 });
      }).catch(() => {});
    }
  },

  redo: () => {
    const hadFuture = get().future.length > 0;
    set((s) => {
      if (s.future.length === 0) return {};
      const next = s.future[0];
      const current = snapshot(s);
      return {
        past: [...s.past, current].slice(-MAX_HISTORY),
        future: s.future.slice(1),
        components: next.components,
        wires: next.wires,
        drawings: next.drawings,
        noConnects: next.noConnects,
        groups: next.groups,
        sheets: next.sheets,
        netClasses: next.netClasses,
        // Restore the full document snapshot (see undo())
        pageSetup: next.pageSetup,
        metadata: next.metadata,
        savedViews: next.savedViews,
        childSheets: next.childSheets,
        activeSheet: next.activeSheet,
        selection: { type: null, id: null },
        multiSelection: { components: new Set(), wires: new Set() },
      };
    });
    if (hadFuture && typeof window !== 'undefined') {
      import('sonner').then(({ toast }) => {
        toast.info('Redo', { description: `${get().past.length} undo available`, duration: 2000 });
      }).catch(() => {});
    }
  },

  clear: () => {
    get().pushHistory();
    set({
      components: [],
      wires: [],
      drawings: [],
      noConnects: [],
      groups: [],
      sheets: [],
      netClasses: [],
      savedViews: [],
      childSheets: {},
      activeSheet: '',
      selection: { type: null, id: null },
      multiSelection: { components: new Set(), wires: new Set() },
      traces: [],
      simContext: null,
      // Reset session state that should not persist across a "new circuit".
      // Previously: stale sim errors, ERC violations, wire drafts, and a
      // still-running sim would carry over into the empty canvas.
      running: false,
      paused: false,
      simError: null,
      ercErrors: [],
      lastAnalysisResult: null,
      physicsViolations: [],
      wireDraft: null,
      placementDraft: null,
    });
  },

  loadDocument: (doc) => {
    set({
      components: doc.components.map((c) => ({ ...c, parameters: { ...c.parameters }, simState: undefined, fields: c.fields ? c.fields.map((f) => ({ ...f })) : undefined })),
      wires: doc.wires.map((w) => ({ ...w })),
      drawings: doc.drawings ?? [],
      noConnects: doc.noConnects ?? [],
      groups: doc.groups ?? [],
      sheets: doc.sheets ?? [],
      netClasses: doc.netClasses ?? [],
      savedViews: doc.savedViews ?? [],
      childSheets: doc.childSheets ?? {},
      activeSheet: doc.activeSheet ?? '',
      pageSetup: doc.pageSetup ?? { ...DEFAULT_PAGE_SETUP },
      metadata: doc.metadata ?? { title: 'Untitled', revision: 'Rev 1', date: new Date().toISOString().slice(0, 10) },
      selection: { type: null, id: null },
      multiSelection: { components: new Set(), wires: new Set() },
      traces: [],
      simContext: null,
      // Reset session state — same rationale as clear(). Loading a new
      // circuit should not inherit sim errors or wire drafts from the old one.
      running: false,
      paused: false,
      simError: null,
      ercErrors: [],
      lastAnalysisResult: null,
      physicsViolations: [],
      wireDraft: null,
      placementDraft: null,
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
      drawings: s.drawings,
      noConnects: s.noConnects,
      groups: s.groups,
      sheets: s.sheets,
      netClasses: s.netClasses,
      savedViews: s.savedViews,
      childSheets: s.childSheets,
      activeSheet: s.activeSheet,
      pageSetup: s.pageSetup,
      metadata: s.metadata,
    };
  },

  setRunning: (running) => {
    if (running) {
      // Guard: refuse to start on empty circuit
      const s = get();
      if (s.components.length === 0 && s.sheets.length === 0) {
        set({ simError: 'Cannot start: circuit is empty. Add components first.' });
        return;
      }
      // Clear any previous error
      set({ running: true, paused: false, simError: null });
    } else {
      set({ running: false, paused: true });
    }
  },
  setSimError: (msg: string | null) => set({ simError: msg }),
  setSpeed: (speed) => set({ speed }),
  setDt: (dt) => set({ dt }),

  step: () => {
    const s = get();
    if (s.components.length === 0 && s.sheets.length === 0) return;

    try {

    // ── Cross-sheet simulation ────────────────────────────────────────────
    // If we're inside a sub-sheet OR the root has sub-sheets, we need to
    // flatten the hierarchy into a single (components, wires) pair before
    // simulating. We do this on every step so sub-sheet edits are picked up
    // immediately. The flattened components have prefixed IDs (e.g. "amp.R1")
    // so they don't collide with the active sheet's IDs.
    let simComponents = s.components;
    let simWires = s.wires;
    let usingHierarchy = false;
    if (s.activeSheet || s.sheets.length > 0) {
      usingHierarchy = true;
      // Save the current sheet back into childSheets so flattenHierarchy sees it
      let childSheets = s.childSheets;
      if (s.activeSheet) {
        childSheets = {
          ...childSheets,
          [s.activeSheet]: snapshotSheet(s.components, s.wires, s.sheets),
        };
      }
      // Build root document from either the active root state or the saved __root__
      const rootDoc = s.activeSheet
        ? (childSheets as any).__root__ ?? { version: 1 as const, components: [], wires: [], sheets: [] }
        : { version: 1 as const, components: s.components, wires: s.wires, sheets: s.sheets };
      const flat = flattenHierarchy(rootDoc as any, childSheets as any);
      simComponents = flat.components;
      simWires = flat.wires;
    }

    const plugins = new Map<string, any>();
    for (const c of simComponents) {
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
    // For speed >= 1: run floor(speed) sub-steps per frame (e.g., 4x = 4 steps)
    // For speed < 1: run 1 step every Nth frame, where N = ceil(1/speed)
    //   This is tracked via simStepCounter in the store state
    const speed = s.speed;
    // Guard: speed <= 0 (reachable via the AI chat's unvalidated setSpeed)
    // would freeze the sim forever — 1/0 = Infinity and the modulo check
    // below never passes.
    if (!(speed > 0)) return;
    let subSteps: number;
    if (speed >= 1) {
      subSteps = Math.max(1, Math.floor(speed));
    } else {
      // Sub-real-time: skip steps to slow down the simulation
      const skipInterval = Math.ceil(1 / speed); // e.g., 0.5x → skip every 2nd frame
      const stepCount = (s as any).__stepCount ?? 0;
      (s as any).__stepCount = stepCount + 1;
      if (stepCount % skipInterval !== 0) {
        return; // skip this frame to slow down
      }
      subSteps = 1;
    }
    const dt = s.dt;
    // Build simOptions from the editor's settings (temperature, .IC, .NODESET,
    // and the integration method selected in the Options dialog).
    const simOpts = {
      initialConditions: s.simOptions?.initialConditions,
      nodeSets: s.simOptions?.nodeSets,
      method: s.simOptions?.method ?? 'euler',
    };
    let result: { sim: SimContext; branchCurrentSize: number; nodeMap: any } | null = null;
    for (let i = 0; i < subSteps; i++) {
      result = simulateStep(simComponents, simWires, plugins, prev, dt, simOpts);
      if (!result) break;
      prev.nodeVoltage = result.sim.nodeVoltage;
      prev.branchCurrent = result.sim.branchCurrent;
      prev.time = result.sim.time;
      prev.state = result.sim.state;

      // Digital fast-forward: advance sim.time toward the next clock edge.
      // Handles two types of clock sources:
      //   1. pulseSource (crystal) — when no capacitors/inductors present
      //   2. timer555 in astable mode — computes output from sim.time + R/C params
      // Without fast-forward, a 1Hz clock would take ~10000 steps per cycle.
      const hasCapacitor = simComponents.some(c => c.type === 'capacitor' || c.type === 'inductor');
      const hasPulseSource = simComponents.some(c => c.type === 'pulseSource');
      const hasArduino = simComponents.some(c => c.type === 'arduinoReal' || c.type === 'arduino');
      const hasAstable555 = simComponents.some(c =>
        c.type === 'timer555' && (c.parameters.astable as boolean) === true);

      // Compute the minimum clock frequency across all digital clock sources
      let minFreq = Infinity;

      // Pulse sources
      if (hasPulseSource && !hasCapacitor && !hasArduino) {
        for (const c of simComponents) {
          if (c.type === 'pulseSource') {
            const f = c.parameters.frequency as number;
            if (f > 0 && f < minFreq) minFreq = f;
          }
        }
      }

      // Astable 555 timers: frequency = 1 / (0.693 * (R1 + 2*R2) * C)
      if (hasAstable555) {
        for (const c of simComponents) {
          if (c.type === 'timer555' && (c.parameters.astable as boolean) === true) {
            const r1 = (c.parameters.r1 as number) || 47000;
            const r2 = (c.parameters.r2 as number) || 47000;
            const cap = (c.parameters.c as number) || 1e-5;
            const period = 0.693 * (r1 + 2 * r2) * cap;
            const f = 1 / period;
            if (f > 0 && f < minFreq) minFreq = f;
          }
        }
      }

      if (minFreq !== Infinity && minFreq > 0) {
        const currentTime = result.sim.time;
        const phase = (currentTime * minFreq) % 1;
        const timeToRisingEdge = (1.0 - phase) / minFreq;
        const advance = Math.min(0.016, timeToRisingEdge + 0.001);
        if (advance > dt) {
          const newTime = currentTime + advance;
          prev.time = newTime;
          result.sim.time = newTime;
        }
      }
    }
    if (!result) {
      // Solver failed — diagnose common issues for actionable error messages
      const hasGround = simComponents.some(c => c.type === 'ground' || c.type === 'powerGND');
      const vSources = simComponents.filter(c => c.type === 'dcVoltage' || c.type === 'acVoltage');
      // Check for parallel voltage sources (same node pair)
      const parallelVSources: string[] = [];
      for (let i = 0; i < vSources.length; i++) {
        for (let j = i + 1; j < vSources.length; j++) {
          // If two V-sources connect to the same pair of nodes, they're parallel
          const w1 = simWires.filter(w => w.from.componentId === vSources[i].id || w.to.componentId === vSources[i].id);
          const w2 = simWires.filter(w => w.from.componentId === vSources[j].id || w.to.componentId === vSources[j].id);
          if (w1.length >= 2 && w2.length >= 2) {
            // Simplified check: if they share at least one connected node
            const nodes1 = new Set(w1.flatMap(w => [w.from.componentId, w.to.componentId]));
            const nodes2 = new Set(w2.flatMap(w => [w.from.componentId, w.to.componentId]));
            const shared = [...nodes1].filter(n => nodes2.has(n));
            if (shared.length >= 2) {
              parallelVSources.push(`${vSources[i].id} & ${vSources[j].id}`);
            }
          }
        }
      }
      let errorMsg: string;
      if (!hasGround) {
        errorMsg = 'Simulation failed: No ground reference found. Add a Ground component to your circuit.';
      } else if (parallelVSources.length > 0) {
        errorMsg = `Simulation failed: Conflicting voltage sources (${parallelVSources.join(', ')}). Two voltage sources in parallel with different values cause a singular matrix. Add a small series resistor between them.`;
      } else {
        errorMsg = 'Simulation failed: Singular matrix. Check for: (1) floating nodes with no DC path to ground, (2) voltage source loops with no series resistance, (3) capacitor-only branches with no DC path. Try adding a 1MΩ resistor from the floating node to ground.';
      }
      set({ running: false, paused: true, simError: errorMsg });
      return;
    }
    // update traces for oscilloscope components — when using hierarchy, the
    // active sheet's oscilloscope IDs match the flattened IDs (no prefix when
    // on root). When inside a sub-sheet, oscilloscope IDs need prefix lookup.
    const traces = [...s.traces];
    for (const comp of simComponents) {
      if (comp.type !== 'oscilloscope') continue;
      const plugin = plugins.get('oscilloscope');
      if (!plugin) continue;
      const terminals = getTerminalsForComponent(comp, plugin, result.nodeMap);
      const measurements = plugin.measure(comp.parameters, terminals, result.sim, comp);
      const v = parseFloat(measurements[0]?.value ?? '0');
      // .PRINT directive: if printNodes is set, log matching node voltages to console
      if (s.simOptions.printNodes && s.simOptions.printNodes.length > 0) {
        for (const termKey of s.simOptions.printNodes) {
          const nodeId = result.nodeMap.terminalNode.get(termKey);
          if (nodeId != null && nodeId > 0) {
            const nodeV = result.sim.nodeVoltage[nodeId - 1] ?? 0;
            // eslint-disable-next-line no-console
            console.log(`[.PRINT t=${result.sim.time.toFixed(6)}] V(${termKey}) = ${nodeV.toFixed(6)} V`);
          }
        }
      }
      // When using hierarchy, the trace's componentId is the active sheet's local ID
      // (without prefix). Map back: if comp.id contains a '.', strip the prefix.
      const traceKey = usingHierarchy && comp.id.includes('.') ? comp.id.split('.').slice(1).join('.') : comp.id;
      let traceIdx = traces.findIndex((t) => t.componentId === traceKey);
      if (traceIdx < 0) {
        traces.push({
          componentId: traceKey,
          color: (comp.parameters.color as string) || '#22d3ee',
          label: (comp.parameters.label as string) || 'CH',
          samples: [],
        });
        traceIdx = traces.length - 1;
      }
      const trace = traces[traceIdx];
      trace.samples.push({ time: result.sim.time, voltage: v });
      // Ring buffer: only slice every 50 steps to reduce GC pressure
      // (was: slice on every step, allocating a new array 60×/sec)
      if (trace.samples.length > s.maxTraceSamples + 50) {
        trace.samples = trace.samples.slice(-s.maxTraceSamples);
      }
      traces[traceIdx] = { ...trace };
    }
    // Run physics validation (debug — catches simulation bugs).
    // Only runs when a special debug flag is set to avoid perf overhead in production.
    let physicsViolations: PhysicsViolation[] = s.physicsViolations;
    if (typeof window !== 'undefined' && (window as any).__PHYSICS_DEBUG__) {
      try {
        const validation = validatePhysics(simComponents, simWires, plugins, result.sim);
        physicsViolations = validation.violations;
        if (!validation.passed) {
          // eslint-disable-next-line no-console
          console.warn('[Physics] Violations detected:', validation.violations.length);
        }
      } catch (e) {
        // validation errors should never break the simulation
      }
    }
    set({ simContext: result.sim, traces, physicsViolations });
    } catch (err) {
      // Catch any unexpected errors from the simulation engine, plugins, or
      // hierarchy flattening. Prevents a single throwing plugin from killing
      // the RAF loop silently.
      const errorMsg = `Simulation error: ${(err as Error).message || 'Unknown error'}`;
      set({ running: false, paused: true, simError: errorMsg });
    }
  },

  reset: () => {
    set((s) => ({
      running: false,
      paused: true,
      components: s.components.map((c) => ({ ...c, simState: undefined })),
      simContext: null,
      simError: null,
      physicsViolations: [],
      traces: [],
      wireDraft: null,
      placementDraft: null,
    }));
  },

  setShowGrid: (showGrid) => set({ showGrid }),
  setSnapToGrid: (snapToGrid) => set({ snapToGrid }),

  // ── Advanced analysis ──────────────────────────────────────────────────────
  lastAnalysisResult: null,
  simOptions: { ...DEFAULT_OPTIONS },

  runAnalysis: (config) => {
    const s = get();
    const plugins = new Map<string, any>();
    for (const c of s.components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    const result = runAnalysisEngine(s.components, s.wires, plugins, config, s.simOptions);
    set({ lastAnalysisResult: result });
    return result;
  },

  runBatch: (config) => {
    const s = get();
    const plugins = new Map<string, any>();
    for (const c of s.components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    return runBatchEngine(s.components, s.wires, plugins, config, s.simOptions);
  },

  runMeasurement: (cmd, trace) => {
    return execMeas(cmd, trace);
  },

  setSimOptions: (patch) => {
    set((s) => ({ simOptions: { ...s.simOptions, ...patch } }));
  },

  solveDCRobust: () => {
    const s = get();
    const plugins = new Map<string, any>();
    for (const c of s.components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    return solveDCRobustEngine(s.components, s.wires, plugins, s.simOptions);
  },
}));
