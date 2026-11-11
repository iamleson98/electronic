// Stateful live-simulation host.
//
// Owns the circuit + engine state (PrevState) on the worker side and runs the
// UI step loop off the main thread. The class is transport-agnostic: the worker
// shell (live-sim.worker.ts) wires `handle()` to self.onmessage and `post` to
// self.postMessage; unit tests drive `handle()` directly in Node.
//
// ── Protocol (main -> worker) ────────────────────────────────────────────────
//   load    { components, wires, dt, speed, opts, printNodes?, mode, seed? }
//             mode 'fresh'  : start from t=0
//             mode 'seed'   : continue from `seed` {nodeVoltage, branchCurrent, time, state}
//             mode 'keep'   : topology edit mid-run, keep the worker's own state
//   patch   { params: [{ id, parameters }] }   param / switch / pot change (no reload)
//   config  { dt?, speed?, opts?, printNodes? }
//   run | pause | ack | dispose
//   step    { frames? }   run N UI frames synchronously, then post one snapshot
//
// ── Protocol (worker -> main) ────────────────────────────────────────────────
//   snapshot  (see SimSnapshot) — at most one per ~16 ms; the host will not
//             post another until the main thread answers with `ack`.
//   error     { kind: 'solver' | 'exception', message }
//
// ── Snapshot layout ──────────────────────────────────────────────────────────
//   nodeVoltage    Float64Array  (transferred copy; index 0 = ground)
//   branchCurrent  Float64Array
//   tcValues       Float64Array  values of sim.terminalCurrents in Map order
//   tcKeys?        string[]      the matching `${compId}:${terminalId}` keys —
//                                only present when the key list changed
//   scopeIds       string[]      oscilloscope component ids (flattened ids)
//   scopeTimes     Float64Array  one entry per sample taken since last post
//   scopeValues    Float64Array  row-major [sample][scope]
//   netNames?, floating?         only with tcKeys (topology-dependent)
//   state?         structured-cloned plugin state map (adaptive cadence)

import { getPlugin } from './registry';
import type { PrevState } from './engine';
import {
  pluginsFor, subStepsForFrame, runFrameSubSteps, scopeSampleValue,
  type LiveSimOptions,
} from './live-step';
import type { CircuitComponent, ComponentPlugin, Wire } from './types';

export interface LiveLoadMsg {
  type: 'load';
  components: CircuitComponent[];
  wires: Wire[];
  dt: number;
  speed: number;
  opts: LiveSimOptions;
  printNodes?: string[];
  mode: 'fresh' | 'seed' | 'keep';
  /** echoed on every snapshot so the main thread can drop stale ones */
  epoch?: number;
  seed?: { nodeVoltage: Float64Array; branchCurrent: Float64Array; time: number; state: Record<string, any> };
}
export interface LivePatchMsg { type: 'patch'; params: Array<{ id: string; parameters: Record<string, any> }> }
export interface LiveConfigMsg { type: 'config'; dt?: number; speed?: number; opts?: LiveSimOptions; printNodes?: string[] }
export interface LiveStepMsg { type: 'step'; frames?: number }
export type LiveHostMsg =
  | LiveLoadMsg | LivePatchMsg | LiveConfigMsg | LiveStepMsg
  | { type: 'run' } | { type: 'pause' } | { type: 'ack' } | { type: 'dispose' } | { type: 'ping' };

export interface SimSnapshot {
  type: 'snapshot';
  seq: number;
  epoch: number;
  time: number;
  dt: number;
  numNodes?: number;
  method?: 'euler' | 'trap' | 'gear';
  temp?: number;
  nodeVoltage: Float64Array;
  branchCurrent: Float64Array;
  tcValues: Float64Array;
  tcKeys?: string[];
  netNames?: Array<[string, number]>;
  floating?: number[];
  scopeIds: string[];
  scopeTimes: Float64Array;
  scopeValues: Float64Array;
  state?: Record<string, any>;
  /** wall-clock ms the worker spent stepping for this snapshot */
  simMs: number;
  /** engine sub-steps executed since the previous snapshot */
  steps: number;
}
export interface SimErrorMsg { type: 'error'; kind: 'solver' | 'exception'; message: string }
export type LiveHostReply = SimSnapshot | SimErrorMsg | { type: 'pong' };

export interface HostScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const defaultScheduler: HostScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as any),
};

const FRAME_MS = 16;
/** Max ms of postMessage cost per frame we are willing to spend on cloning `state`. */
const STATE_BUDGET_MS = 1.5;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class LiveSimHost {
  private components: CircuitComponent[] = [];
  private wires: Wire[] = [];
  private plugins = new Map<string, ComponentPlugin>();
  private prev: PrevState = { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: {} };
  private dt = 1e-4;
  private speed = 1;
  private opts: LiveSimOptions = {};
  private printNodes: string[] = [];
  private scopes: CircuitComponent[] = [];

  private running = false;
  private awaitingAck = false;
  private timer: unknown = null;
  private frameCounter = 0;
  private seq = 0;
  private epoch = 0;
  private loaded = false;

  private lastKeys: string[] = [];
  private pendingScopeTimes: number[] = [];
  private pendingScopeValues: number[] = [];
  private pendingSteps = 0;
  private pendingSimMs = 0;
  private lastResult: ReturnType<typeof runFrameSubSteps> = null;

  private stateEvery = 1;
  private framesSinceState = 0;
  private stateCloneable = true;

  constructor(
    private post: (msg: LiveHostReply, transfer?: Transferable[]) => void,
    private scheduler: HostScheduler = defaultScheduler,
  ) {}

  handle(msg: LiveHostMsg): void {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'load': this.load(msg); break;
      case 'patch': this.patch(msg); break;
      case 'config':
        if (msg.dt !== undefined) this.dt = msg.dt;
        if (msg.speed !== undefined) this.speed = msg.speed;
        if (msg.opts) this.opts = msg.opts;
        if (msg.printNodes) this.printNodes = msg.printNodes;
        break;
      case 'run':
        if (!this.loaded) return;
        this.running = true;
        this.awaitingAck = false;
        this.scheduleTick(0);
        break;
      case 'pause':
        this.running = false;
        this.cancelTimer();
        // Flush a final snapshot WITH state so the paused UI is exact.
        if (this.loaded && this.lastResult) this.postSnapshot(true);
        break;
      case 'ack':
        this.awaitingAck = false;
        break;
      case 'step': this.stepFrames(msg.frames ?? 1); break;
      case 'dispose':
        this.running = false;
        this.cancelTimer();
        this.loaded = false;
        break;
      case 'ping': this.post({ type: 'pong' }); break;
    }
  }

  // ── commands ───────────────────────────────────────────────────────────────

  private load(msg: LiveLoadMsg): void {
    this.epoch = msg.epoch ?? this.epoch;
    this.components = msg.components;
    this.wires = msg.wires;
    this.dt = msg.dt;
    this.speed = msg.speed;
    this.opts = msg.opts ?? {};
    this.printNodes = msg.printNodes ?? [];
    this.plugins = pluginsFor(this.components);
    if (msg.mode === 'seed' && msg.seed) {
      this.prev = {
        nodeVoltage: msg.seed.nodeVoltage,
        branchCurrent: msg.seed.branchCurrent,
        time: msg.seed.time,
        state: msg.seed.state ?? {},
      };
    } else if (msg.mode === 'fresh' || (msg.mode === 'seed' && !msg.seed)) {
      this.prev = { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: {} };
      this.frameCounter = 0;
    }
    this.scopes = this.components.filter((c) => c.type === 'oscilloscope');
    this.lastResult = null;
    this.pendingSteps = 0;
    this.pendingSimMs = 0;
    this.lastKeys = []; // force topology tables out with the next snapshot
    this.pendingScopeTimes = [];
    this.pendingScopeValues = [];
    this.framesSinceState = this.stateEvery; // send state promptly after a load
    this.loaded = true;
  }

  private patch(msg: LivePatchMsg): void {
    if (!this.loaded) return;
    const byId = new Map(msg.params.map((p) => [p.id, p.parameters]));
    // New array + new objects for touched parts (same identity semantics as an
    // editor edit on the main thread, so engine caches keyed on identity miss).
    this.components = this.components.map((c) =>
      byId.has(c.id) ? { ...c, parameters: { ...byId.get(c.id)! } } : c,
    );
    this.scopes = this.components.filter((c) => c.type === 'oscilloscope');
  }

  private scheduleTick(ms: number): void {
    this.cancelTimer();
    this.timer = this.scheduler.set(() => this.tick(), ms);
  }
  private cancelTimer(): void {
    if (this.timer !== null) { this.scheduler.clear(this.timer); this.timer = null; }
  }

  private tick(): void {
    this.timer = null;
    if (!this.running) return;
    if (this.awaitingAck) { this.scheduleTick(4); return; } // backpressure
    const t0 = now();
    const ok = this.runFrame();
    if (!this.running && !ok) return; // runFrame stopped us on error
    if (ok && this.lastResult && this.pendingSteps > 0) this.postSnapshot(false);
    const spent = now() - t0;
    this.scheduleTick(Math.max(0, FRAME_MS - spent));
  }

  /** Run N frames synchronously and post one snapshot (single-step & tests). */
  private stepFrames(frames: number): void {
    if (!this.loaded) return;
    for (let i = 0; i < frames; i++) {
      if (!this.runFrame()) return;
    }
    if (this.lastResult) this.postSnapshot(true);
  }

  /** One UI frame of simulation. Returns false on solver/exception failure. */
  private runFrame(): boolean {
    const subSteps = subStepsForFrame(this.speed, this.frameCounter);
    if (this.speed < 1 && this.speed > 0) this.frameCounter++;
    if (subSteps < 0) return true;  // invalid speed: idle (matches store.step)
    if (subSteps === 0) return true; // sub-real-time skipped frame
    const t0 = now();
    try {
      const result = runFrameSubSteps(this.components, this.wires, this.plugins, this.prev, this.dt, this.opts, subSteps);
      if (!result) {
        this.running = false;
        this.cancelTimer();
        this.post({ type: 'error', kind: 'solver', message: 'solver failed' });
        return false;
      }
      this.lastResult = result;
      this.pendingSteps += subSteps;
      // Oscilloscope samples: one per frame (same cadence as store.step).
      if (this.scopes.length > 0) {
        this.pendingScopeTimes.push(result.sim.time);
        for (const comp of this.scopes) {
          const plugin = this.plugins.get('oscilloscope') ?? getPlugin('oscilloscope');
          this.pendingScopeValues.push(plugin ? scopeSampleValue(comp, plugin, result.nodeMap, result.sim) : 0);
        }
      }
      if (this.printNodes.length > 0) {
        for (const termKey of this.printNodes) {
          const nodeId = result.nodeMap.terminalNode.get(termKey);
          if (nodeId != null && nodeId > 0) {
            const nodeV = result.sim.nodeVoltage[nodeId] ?? 0;
            // eslint-disable-next-line no-console
            console.log(`[.PRINT t=${result.sim.time.toFixed(6)}] V(${termKey}) = ${nodeV.toFixed(6)} V`);
          }
        }
      }
      this.pendingSimMs += now() - t0;
      return true;
    } catch (err) {
      this.running = false;
      this.cancelTimer();
      this.post({ type: 'error', kind: 'exception', message: `Simulation error: ${(err as Error).message || 'Unknown error'}` });
      return false;
    }
  }

  private postSnapshot(forceState: boolean): void {
    const result = this.lastResult;
    if (!result) return;
    const sim = result.sim;
    const tc = sim.terminalCurrents;
    const keys = tc ? Array.from(tc.keys()) : [];
    const tcValues = new Float64Array(keys.length);
    for (let i = 0; i < keys.length; i++) tcValues[i] = tc!.get(keys[i])!;
    let keysChanged = keys.length !== this.lastKeys.length;
    if (!keysChanged) for (let i = 0; i < keys.length; i++) if (keys[i] !== this.lastKeys[i]) { keysChanged = true; break; }

    const snap: SimSnapshot = {
      type: 'snapshot',
      seq: ++this.seq,
      epoch: this.epoch,
      time: sim.time,
      dt: sim.dt,
      numNodes: sim.numNodes,
      method: sim.method,
      temp: sim.temp,
      // Copies: the engine keeps using its own buffers as `prev`; transferring
      // those would detach them.
      nodeVoltage: sim.nodeVoltage.slice(),
      branchCurrent: sim.branchCurrent.slice(),
      tcValues,
      scopeIds: this.scopes.map((c) => c.id),
      scopeTimes: Float64Array.from(this.pendingScopeTimes),
      scopeValues: Float64Array.from(this.pendingScopeValues),
      simMs: this.pendingSimMs,
      steps: this.pendingSteps,
    };
    if (keysChanged) {
      snap.tcKeys = keys;
      this.lastKeys = keys;
      snap.netNames = sim.netNames ? Array.from(sim.netNames.entries()) : undefined;
      snap.floating = sim.floatingNodes ? Array.from(sim.floatingNodes) : undefined;
    }

    this.framesSinceState++;
    const wantState = this.stateCloneable && (forceState || this.framesSinceState >= this.stateEvery);
    const transfer: Transferable[] = [
      snap.nodeVoltage.buffer, snap.branchCurrent.buffer, snap.tcValues.buffer,
      snap.scopeTimes.buffer, snap.scopeValues.buffer,
    ];
    this.pendingScopeTimes = [];
    this.pendingScopeValues = [];
    this.pendingSteps = 0;
    this.pendingSimMs = 0;

    if (wantState) {
      snap.state = sim.state;
      const t0 = now();
      try {
        this.post(snap, transfer);
      } catch {
        // State holds something un-cloneable (function / DOM object): stop
        // syncing it and send the numeric snapshot alone.
        this.stateCloneable = false;
        snap.state = undefined;
        this.post(snap, transfer);
      }
      const cost = now() - t0;
      this.framesSinceState = 0;
      // Adaptive cadence: keep clone cost under the per-frame budget.
      this.stateEvery = Math.max(1, Math.min(30, Math.ceil(cost / STATE_BUDGET_MS)));
    } else {
      this.post(snap, transfer);
    }
    this.awaitingAck = true;
  }
}
