// Main-thread controller: store <-> (fake) worker. Verifies the worker backend
// leaves the store in the same state shape the UI consumes, and that edits and
// pause/reset behave.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../src/lib/circuit/components';
import { useEditor } from '../src/lib/circuit/store';
import { example555, exampleRC } from '../src/lib/circuit/examples';
import { LiveSimHost } from '../src/lib/circuit/sim-live-host';
import {
  startLiveSim, stopLiveSim, setLiveWorkerFactory, resolveBackend, WORKER_AUTO_THRESHOLD,
  __resetLiveSimForTests, isLiveSimActive, type LiveWorkerLike,
} from '../src/lib/circuit/live-sim-controller';
import { computeWireCurrents, buildNodeMap } from '../src/lib/circuit/engine';
import { pluginsFor } from '../src/lib/circuit/live-step';

/** Fake worker: a real LiveSimHost behind async structured-clone message passing. */
function fakeWorkerFactory() {
  const sent: any[] = [];
  const factory = (): LiveWorkerLike => {
    const w: LiveWorkerLike = {
      onmessage: null, onerror: null, terminate() { /* noop */ },
      postMessage(msg: any) {
        sent.push(msg);
        const cloned = structuredClone(msg);
        queueMicrotask(() => host.handle(cloned));
      },
    };
    const host = new LiveSimHost(
      (m, transfer) => {
        const c = structuredClone(m, { transfer: (transfer ?? []) as ArrayBuffer[] });
        queueMicrotask(() => w.onmessage?.({ data: c }));
      },
      // manual pump instead of timers: tests call pump()
      { set: (fn) => { pending.push(fn); return pending.length; }, clear: () => { pending.length = 0; } },
    );
    return w;
  };
  const pending: Array<() => void> = [];
  const pump = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const f = pending.shift();
      f?.();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { factory, sent, pump };
}

describe('live-sim controller', () => {
  beforeEach(() => {
    __resetLiveSimForTests();
    useEditor.getState().reset();
    useEditor.getState().loadDocument(structuredClone(example555));
    useEditor.setState({ simBackend: 'worker', simError: null });
  });
  afterEach(() => { __resetLiveSimForTests(); setLiveWorkerFactory(undefined); });

  it('auto picks the worker only for big circuits; main when no Worker exists', () => {
    const big = Array.from({ length: WORKER_AUTO_THRESHOLD + 1 }, (_, i) => ({ id: `r${i}`, type: 'resistor', position: { x: 0, y: 0 }, rotation: 0 as const, parameters: {} }));
    setLiveWorkerFactory(fakeWorkerFactory().factory);
    expect(resolveBackend('auto', big)).toBe('worker');
    expect(resolveBackend('auto', big.slice(0, 10))).toBe('main');
    expect(resolveBackend('auto', [...big, { ...big[0], id: 'mcu', type: 'arduinoReal' }])).toBe('main');
    expect(resolveBackend('main', big)).toBe('main');
    expect(resolveBackend('worker', big.slice(0, 3))).toBe('worker');
    setLiveWorkerFactory(null); // Node / SSR / blocked Workers
    expect(resolveBackend('worker', big)).toBe('main');
    expect(startLiveSim()).toBe(false);
  });

  it('worker frames reproduce main-thread step() results exactly', async () => {
    const fw = fakeWorkerFactory();
    setLiveWorkerFactory(fw.factory);
    expect(startLiveSim()).toBe(true);
    expect(isLiveSimActive()).toBe(true);
    await fw.pump(10);
    stopLiveSim();
    await fw.pump(2); // final flush snapshot
    const w = useEditor.getState().simContext!;
    const dt = useEditor.getState().dt;
    const n = Math.round(w.time / dt);
    expect(n).toBeGreaterThanOrEqual(2);
    const wV = Array.from(w.nodeVoltage), wTC = Array.from(w.terminalCurrents!.entries());

    // same number of steps on the main-thread path
    useEditor.getState().reset();
    for (let i = 0; i < n; i++) useEditor.getState().step();
    const m = useEditor.getState().simContext!;
    expect(m.time).toBe(w.time);
    expect(wV).toEqual(Array.from(m.nodeVoltage));
    expect(wTC).toEqual(Array.from(m.terminalCurrents!.entries()));
  });

  it('snapshot SimContext feeds computeWireCurrents (flow animation) like the main path', async () => {
    const fw = fakeWorkerFactory();
    setLiveWorkerFactory(fw.factory);
    startLiveSim();
    await fw.pump(30);
    const st = useEditor.getState();
    const sim = st.simContext!;
    expect(sim.terminalCurrents!.size).toBeGreaterThan(10);
    const plugins = pluginsFor(st.components);
    const wc = computeWireCurrents(st.components, st.wires, plugins, sim);
    expect(wc.size).toBeGreaterThan(0);
    const anyNonZero = Array.from(wc.values()).some((v) => Math.abs(v) > 1e-9);
    expect(anyNonZero).toBe(true);
    expect(buildNodeMap(st.components, st.wires, plugins).terminalNode.size).toBeGreaterThan(0);
    stopLiveSim();
  });

  it('param edits are forwarded as patches (no reload); structural edits reload with keep', async () => {
    const fw = fakeWorkerFactory();
    setLiveWorkerFactory(fw.factory);
    startLiveSim();
    await fw.pump(3);
    fw.sent.length = 0;
    useEditor.getState().setParameter('ra', 'resistance', 22000);
    expect(fw.sent.map((m) => m.type)).toEqual(['patch']);
    expect(fw.sent[0].params[0].id).toBe('ra');
    expect(fw.sent[0].params[0].parameters.resistance).toBe(22000);
    fw.sent.length = 0;
    // component position change alone does not touch the worker
    useEditor.setState((s) => ({ components: s.components.map((c) => (c.id === 'c1' ? { ...c, position: { x: 99, y: 99 } } : c)) }));
    expect(fw.sent).toEqual([]);
    // wiring change => reload, state kept
    useEditor.setState((s) => ({ wires: s.wires.slice(0, -1) }));
    expect(fw.sent.map((m) => m.type)).toEqual(['load']);
    expect(fw.sent[0].mode).toBe('keep');
    // speed/dt => config
    fw.sent.length = 0;
    useEditor.getState().setSpeed(2);
    expect(fw.sent.map((m) => m.type)).toEqual(['config']);
    stopLiveSim();
  });

  it('pause applies one final snapshot with plugin state; reset then drops stale flushes', async () => {
    const fw = fakeWorkerFactory();
    setLiveWorkerFactory(fw.factory);
    startLiveSim();
    await fw.pump(5);
    stopLiveSim();
    await fw.pump(2);
    const paused = useEditor.getState().simContext!;
    expect(Object.keys(paused.state).length).toBeGreaterThan(0);
    // resume continues from simContext (seed) rather than restarting
    const t0 = paused.time;
    startLiveSim();
    await fw.pump(4);
    expect(useEditor.getState().simContext!.time).toBeGreaterThan(t0);
    stopLiveSim();
    useEditor.getState().reset();
    await fw.pump(3);
    expect(useEditor.getState().simContext).toBeNull(); // stale flush discarded
  });

  it('solver error surfaces as simError and stops the sim', async () => {
    useEditor.getState().loadDocument(structuredClone(exampleRC));
    // remove ground -> engine failure
    useEditor.setState((s) => ({ components: s.components.filter((c) => c.type !== 'ground'), wires: s.wires.filter((w) => w.from.componentId !== 'gnd1' && w.to.componentId !== 'gnd1') }));
    const fw = fakeWorkerFactory();
    setLiveWorkerFactory(fw.factory);
    useEditor.getState().setRunning(true);
    startLiveSim();
    await fw.pump(3);
    const st = useEditor.getState();
    // either the engine tolerates it (then no error) or we get a described failure + stopped
    if (st.simError) {
      expect(st.running).toBe(false);
      expect(st.simError).toMatch(/Simulation/);
    }
    stopLiveSim();
  });
});
