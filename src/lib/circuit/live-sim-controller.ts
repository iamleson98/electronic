// Main-thread side of the off-thread live simulation.
//
// Owns the Worker running LiveSimHost, mirrors store edits into it
// (patch / reload / config), and turns each snapshot back into the SimContext
// + oscilloscope traces the UI already consumes — so canvas current-flow,
// probes, property panel, status bar and scope views need no changes.

import { useEditor } from './store';
import { describeSimFailure, flattenForSim, type SimBackend } from './live-step';
import type { LiveHostMsg, LiveHostReply, SimSnapshot } from './sim-live-host';
import type { CircuitComponent, SimContext, Wire } from './types';

/** Circuits with more simulated components than this use the worker in 'auto' mode. */
export const WORKER_AUTO_THRESHOLD = 150;

export type { SimBackend };

export interface LiveWorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: any }) => void) | null;
  onerror: ((e: any) => void) | null;
}
type LiveWorkerFactory = () => LiveWorkerLike;

function defaultFactory(): LiveWorkerFactory | null {
  if (typeof Worker === 'undefined') return null;
  return () =>
    new Worker(new URL('./live-sim.worker.ts', import.meta.url), { type: 'module' }) as unknown as LiveWorkerLike;
}

let factoryOverride: LiveWorkerFactory | null | undefined;
/** Test / diagnostics hook. */
export function setLiveWorkerFactory(f: LiveWorkerFactory | null | undefined): void { factoryOverride = f; }

let workerBroken = false;

/** Which backend should run the live sim for the current editor state. */
export function resolveBackend(
  setting: SimBackend,
  simComponents: CircuitComponent[],
): 'main' | 'worker' {
  if (workerBroken) return 'main';
  const factory = factoryOverride === undefined ? defaultFactory() : factoryOverride;
  if (!factory) return 'main';
  if (setting === 'main') return 'main';
  if (setting === 'worker') return 'worker';
  // 'auto': only big circuits. MCU circuits stay on the main thread: their
  // serial monitor / plotter mutate plugin state directly from the UI.
  if (simComponents.some((c) => c.type === 'arduinoReal' || c.type === 'arduino')) return 'main';
  return simComponents.length > WORKER_AUTO_THRESHOLD ? 'worker' : 'main';
}

// ── singleton worker session ─────────────────────────────────────────────────

let worker: LiveWorkerLike | null = null;
let epoch = 0;
let unsubscribe: (() => void) | null = null;
let active = false;
/** accept exactly one flush snapshot after pause (carries final state) */
let expectFlush = false;

// What the worker currently has (for diffing edits)
let sentComponents: CircuitComponent[] = [];
let sentWires: Wire[] = [];
let simComponents: CircuitComponent[] = [];
let simWires: Wire[] = [];
let usingHierarchy = false;
let sentCfg = { dt: NaN, speed: NaN, opts: '', print: '' };

// Decoded-topology cache (sent only when it changes)
let tcKeys: string[] = [];
let netNames: Map<string, number> | undefined;
let floating: Set<number> | undefined;
let lastState: Record<string, any> = {};

function send(msg: LiveHostMsg): void { worker?.postMessage(msg); }

function liveOpts(s: ReturnType<typeof useEditor.getState>) {
  return {
    initialConditions: s.simOptions?.initialConditions,
    nodeSets: s.simOptions?.nodeSets,
    method: s.simOptions?.method ?? 'gear',
    temp: s.simOptions?.temp ?? 27,
  } as const;
}

function cfgKey(s: ReturnType<typeof useEditor.getState>) {
  return {
    dt: s.dt, speed: s.speed,
    opts: JSON.stringify(liveOpts(s)),
    print: JSON.stringify(s.simOptions?.printNodes ?? []),
  };
}

function structurallyEqual(a: CircuitComponent, b: CircuitComponent): boolean {
  return a.id === b.id && a.type === b.type
    && a.rotation === b.rotation && a.rotationDeg === b.rotationDeg
    && a.mirrorX === b.mirrorX && a.mirrorY === b.mirrorY
    && a.unit === b.unit && a.convert === b.convert && a.variant === b.variant
    && a.temp === b.temp;
}

/** Push editor changes into the worker. Cheap when nothing relevant changed. */
function syncEdits(): void {
  if (!active) return;
  const s = useEditor.getState();

  const cfg = cfgKey(s);
  if (cfg.dt !== sentCfg.dt || cfg.speed !== sentCfg.speed || cfg.opts !== sentCfg.opts || cfg.print !== sentCfg.print) {
    sentCfg = cfg;
    send({ type: 'config', dt: s.dt, speed: s.speed, opts: liveOpts(s) as any, printNodes: s.simOptions?.printNodes ?? [] });
  }

  const flat = flattenForSim(s);
  if (flat.components === sentComponents && flat.wires === sentWires) return;

  let reload = flat.wires !== sentWires && !sameWires(flat.wires, sentWires);
  const patches: Array<{ id: string; parameters: Record<string, any> }> = [];
  if (!reload) {
    if (flat.components.length !== sentComponents.length) reload = true;
    else {
      for (let i = 0; i < flat.components.length; i++) {
        const n = flat.components[i], o = sentComponents[i];
        if (n === o) continue;
        if (!structurallyEqual(n, o)) { reload = true; break; }
        if (n.parameters !== o.parameters && !shallowEqual(n.parameters, o.parameters)) {
          patches.push({ id: n.id, parameters: n.parameters as Record<string, any> });
        }
      }
    }
  }
  sentComponents = flat.components;
  sentWires = flat.wires;
  simComponents = flat.components;
  simWires = flat.wires;
  usingHierarchy = flat.usingHierarchy;
  if (reload) {
    send({
      type: 'load', mode: 'keep', epoch,
      components: stripForWorker(flat.components), wires: flat.wires,
      dt: s.dt, speed: s.speed, opts: liveOpts(s) as any, printNodes: s.simOptions?.printNodes ?? [],
    });
  } else if (patches.length > 0) {
    send({ type: 'patch', params: patches });
  }
}

function shallowEqual(a: Record<string, any>, b: Record<string, any>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
function sameWires(a: Wire[], b: Wire[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.from.componentId !== y.from.componentId || x.from.terminalId !== y.from.terminalId
      || x.to.componentId !== y.to.componentId || x.to.terminalId !== y.to.terminalId
      || x.netName !== y.netName) return false;
  }
  return true;
}

/** Components cross the thread boundary without UI-only runtime baggage. */
function stripForWorker(components: CircuitComponent[]): CircuitComponent[] {
  return components.map((c) => (c.simState === undefined ? c : { ...c, simState: undefined }));
}

function fail(message: string): void {
  const st = useEditor.getState();
  st.setSimError(message);
  st.setRunning(false);
}

function onWorkerMessage(msg: LiveHostReply): void {
  if (!msg) return;
  if (msg.type === 'error') {
    if (!active && !expectFlush) return;
    fail(msg.kind === 'solver' ? describeSimFailure(simComponents, simWires) : msg.message);
    return;
  }
  if (msg.type !== 'snapshot') return;
  if (msg.epoch !== epoch) return; // stale (pre-reload / pre-reset)
  const st = useEditor.getState();
  if (!active) {
    // Only the single post-pause flush is accepted, and only if the sim wasn't reset.
    if (!expectFlush || st.simContext === null) return;
    expectFlush = false;
  }
  applySnapshot(msg);
  send({ type: 'ack' });
}

function applySnapshot(snap: SimSnapshot): void {
  if (snap.tcKeys) {
    tcKeys = snap.tcKeys;
    netNames = snap.netNames ? new Map(snap.netNames) : undefined;
    floating = snap.floating ? new Set(snap.floating) : undefined;
  }
  if (snap.state) lastState = snap.state;

  // NaN/Infinity guard (same contract as the main-thread loop).
  const nv = snap.nodeVoltage;
  for (let i = 0; i < nv.length; i++) {
    if (!isFinite(nv[i])) {
      fail(`Simulation diverged (node ${i} = ${nv[i]}). Check for short circuits, floating nodes, or conflicting sources.`);
      return;
    }
  }

  const terminalCurrents = new Map<string, number>();
  for (let i = 0; i < tcKeys.length; i++) terminalCurrents.set(tcKeys[i], snap.tcValues[i]);

  const sim: SimContext = {
    nodeVoltage: snap.nodeVoltage,
    branchCurrent: snap.branchCurrent,
    state: lastState,
    time: snap.time,
    dt: snap.dt,
    numNodes: snap.numNodes,
    method: snap.method,
    temp: snap.temp,
    netNames,
    floatingNodes: floating,
    terminalCurrents: tcKeys.length > 0 ? terminalCurrents : undefined,
  };

  // Oscilloscope traces (same bookkeeping as store.step).
  const s = useEditor.getState();
  let traces = s.traces;
  const nScopes = snap.scopeIds.length;
  if (nScopes > 0 && snap.scopeTimes.length > 0) {
    traces = [...s.traces];
    for (let k = 0; k < nScopes; k++) {
      const id = snap.scopeIds[k];
      const comp = simComponents.find((c) => c.id === id);
      const traceKey = usingHierarchy && id.includes('.') ? id.split('.').slice(1).join('.') : id;
      let idx = traces.findIndex((t) => t.componentId === traceKey);
      if (idx < 0) {
        traces.push({
          componentId: traceKey,
          color: (comp?.parameters.color as string) || '#22d3ee',
          label: (comp?.parameters.label as string) || 'CH',
          samples: [],
        });
        idx = traces.length - 1;
      }
      const tr = traces[idx];
      for (let j = 0; j < snap.scopeTimes.length; j++) {
        tr.samples.push({ time: snap.scopeTimes[j], voltage: snap.scopeValues[j * nScopes + k] });
      }
      if (tr.samples.length > s.maxTraceSamples + 50) tr.samples = tr.samples.slice(-s.maxTraceSamples);
      traces[idx] = { ...tr };
    }
  }
  useEditor.setState({ simContext: sim, traces });
}

function ensureWorker(): LiveWorkerLike | null {
  if (worker) return worker;
  const factory = factoryOverride === undefined ? defaultFactory() : factoryOverride;
  if (!factory) return null;
  try {
    worker = factory();
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = () => {
    // Crashed / failed to load: fall back to the main thread for good.
    workerBroken = true;
    try { worker?.terminate(); } catch { /* ignore */ }
    worker = null;
    if (active) {
      active = false;
      unsubscribe?.(); unsubscribe = null;
      useEditor.getState().setSimError('Simulation worker failed; falling back to the main thread. Press Play to resume.');
      useEditor.getState().setRunning(false);
    }
  };
  return worker;
}

/**
 * Start (or resume) the live sim in the worker. Returns false when no worker
 * can be created — the caller must then use the main-thread loop.
 */
export function startLiveSim(): boolean {
  if (active) return true;
  if (!ensureWorker()) return false;
  const s = useEditor.getState();
  const flat = flattenForSim(s);
  simComponents = flat.components; simWires = flat.wires; usingHierarchy = flat.usingHierarchy;
  sentComponents = flat.components; sentWires = flat.wires;
  sentCfg = cfgKey(s);
  epoch++;
  expectFlush = false;
  tcKeys = []; netNames = undefined; floating = undefined;
  lastState = s.simContext?.state ?? {};

  const seed = s.simContext
    ? {
        nodeVoltage: s.simContext.nodeVoltage.slice(),
        branchCurrent: s.simContext.branchCurrent.slice(),
        time: s.simContext.time,
        state: s.simContext.state,
      }
    : undefined;
  const loadMsg: LiveHostMsg = {
    type: 'load', epoch, mode: seed ? 'seed' : 'fresh', seed,
    components: stripForWorker(flat.components), wires: flat.wires,
    dt: s.dt, speed: s.speed, opts: liveOpts(s) as any, printNodes: s.simOptions?.printNodes ?? [],
  };
  try {
    worker!.postMessage(loadMsg);
  } catch {
    // state not cloneable (function in plugin state) — retry without it
    worker!.postMessage({ ...loadMsg, mode: 'fresh', seed: undefined });
  }
  active = true;
  send({ type: 'run' });
  unsubscribe = useEditor.subscribe(syncEdits);
  return true;
}

/** Pause the worker; its final snapshot (with plugin state) is applied once. */
export function stopLiveSim(): void {
  if (!active) return;
  active = false;
  unsubscribe?.(); unsubscribe = null;
  expectFlush = true;
  send({ type: 'pause' });
}

export function isLiveSimActive(): boolean { return active; }

/** Test hook: drop the worker session entirely. */
export function __resetLiveSimForTests(): void {
  try { worker?.terminate(); } catch { /* ignore */ }
  worker = null; active = false; unsubscribe?.(); unsubscribe = null;
  expectFlush = false; workerBroken = false; epoch = 0;
}
