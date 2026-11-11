// Worker protocol: drive LiveSimHost.handle() directly (no real Worker) and
// check its snapshots against direct engine calls for the 555 example.
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/lib/circuit/components';
import { example555, exampleRC } from '../src/lib/circuit/examples';
import { simulateStep, type PrevState } from '../src/lib/circuit/engine';
import { pluginsFor } from '../src/lib/circuit/live-step';
import { LiveSimHost, type LiveHostReply, type SimSnapshot, type LiveLoadMsg } from '../src/lib/circuit/sim-live-host';
import type { CircuitComponent } from '../src/lib/circuit/types';

const OPTS = { method: 'gear' as const, temp: 27 };

function makeHost() {
  const out: Array<{ msg: LiveHostReply; transfer?: Transferable[] }> = [];
  const timers: Array<() => void> = [];
  const host = new LiveSimHost(
    (msg, transfer) => out.push({ msg, transfer }),
    { set: (fn) => { timers.push(fn); return timers.length; }, clear: () => { /* manual */ } },
  );
  const snaps = () => out.filter((o) => o.msg.type === 'snapshot').map((o) => o.msg as SimSnapshot);
  return { host, out, snaps, timers };
}

const load = (components: CircuitComponent[], wires: any[], extra: Partial<LiveLoadMsg> = {}): LiveLoadMsg => ({
  type: 'load', mode: 'fresh', components, wires, dt: 1e-4, speed: 1, opts: OPTS, epoch: 1, ...extra,
});

function directSteps(components: CircuitComponent[], wires: any[], n: number, dt = 1e-4) {
  const plugins = pluginsFor(components);
  const prev: PrevState = { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: {} };
  let r: ReturnType<typeof simulateStep> = null;
  for (let i = 0; i < n; i++) {
    r = simulateStep(components, wires, plugins, prev, dt, { ...OPTS, recordTerminalCurrents: i === n - 1 });
    expect(r).not.toBeNull();
    prev.nodeVoltage = r!.sim.nodeVoltage; prev.branchCurrent = r!.sim.branchCurrent;
    prev.time = r!.sim.time; prev.state = r!.sim.state;
  }
  return r!;
}

function expectSnapshotMatches(snap: SimSnapshot, ref: NonNullable<ReturnType<typeof directSteps>>) {
  expect(snap.time).toBe(ref.sim.time);
  expect(Array.from(snap.nodeVoltage)).toEqual(Array.from(ref.sim.nodeVoltage));
  expect(Array.from(snap.branchCurrent)).toEqual(Array.from(ref.sim.branchCurrent));
  const tc = ref.sim.terminalCurrents!;
  if (snap.tcKeys) expect(snap.tcKeys).toEqual(Array.from(tc.keys())); // keys only sent when changed
  expect(Array.from(snap.tcValues)).toEqual(Array.from(tc.values()));
}

describe('LiveSimHost protocol (555 example)', () => {
  it('N single-frame steps == N direct simulateStep calls', () => {
    const { host, snaps } = makeHost();
    host.handle(load(example555.components, example555.wires));
    for (const n of [1, 5, 40]) {
      host.handle({ type: 'step', frames: n === 1 ? 1 : n === 5 ? 4 : 35 }); // cumulative 1, 5, 40
      host.handle({ type: 'ack' });
      const snap = snaps().at(-1)!;
      expectSnapshotMatches(snap, directSteps(example555.components, example555.wires, n));
    }
  });

  it('first snapshot carries the topology tables; later ones omit them', () => {
    const { host, snaps } = makeHost();
    host.handle(load(example555.components, example555.wires));
    host.handle({ type: 'step', frames: 1 });
    host.handle({ type: 'step', frames: 1 });
    const [a, b] = snaps();
    expect(a.tcKeys!.length).toBeGreaterThan(5);
    expect(a.tcKeys!.some((k) => k.startsWith('ic1:'))).toBe(true);
    expect(b.tcKeys).toBeUndefined();
    expect(b.tcValues.length).toBe(a.tcKeys!.length);
    expect(b.seq).toBe(a.seq + 1);
  });

  it('speed 3 runs 3 sub-steps per frame', () => {
    const { host, snaps } = makeHost();
    host.handle(load(example555.components, example555.wires, { speed: 3 }));
    host.handle({ type: 'step', frames: 4 });
    expect(snaps().at(-1)!.steps).toBe(12);
    expectSnapshotMatches(snaps().at(-1)!, directSteps(example555.components, example555.wires, 12));
  });

  it('speed 0.5 skips alternate frames; invalid speed idles', () => {
    const a = makeHost();
    a.host.handle(load(example555.components, example555.wires, { speed: 0.5 }));
    a.host.handle({ type: 'step', frames: 6 });
    expect(a.snaps().at(-1)!.steps).toBe(3);
    const b = makeHost();
    b.host.handle(load(example555.components, example555.wires, { speed: 0 }));
    b.host.handle({ type: 'step', frames: 6 });
    expect(b.snaps()).toHaveLength(0);
  });

  it('snapshot buffers are transferable copies (engine state not detached)', () => {
    const { host, out, snaps } = makeHost();
    host.handle(load(example555.components, example555.wires));
    host.handle({ type: 'step', frames: 2 });
    const o = out.find((x) => x.msg.type === 'snapshot')!;
    const s = o.msg as SimSnapshot;
    expect(o.transfer).toContain(s.nodeVoltage.buffer);
    expect(o.transfer).toContain(s.branchCurrent.buffer);
    expect(o.transfer).toContain(s.tcValues.buffer);
    // simulate the transfer detaching the posted buffers, then keep stepping
    structuredClone(s, { transfer: o.transfer as ArrayBuffer[] });
    host.handle({ type: 'step', frames: 3 });
    expectSnapshotMatches(snaps().at(-1)!, directSteps(example555.components, example555.wires, 5));
  });

  it('patch (switch/pot/param edit) takes effect on the very next step', () => {
    const { host, snaps } = makeHost();
    const comps = exampleRC.components;
    host.handle(load(comps, exampleRC.wires));
    host.handle({ type: 'step', frames: 20 });
    const r = comps.find((c) => c.type === 'resistor')!;
    const newParams = { ...r.parameters, resistance: (r.parameters.resistance as number) * 10 };
    host.handle({ type: 'patch', params: [{ id: r.id, parameters: newParams }] });
    host.handle({ type: 'step', frames: 1 });
    // reference: 20 steps with original, 1 with patched, continuing state
    const plugins = pluginsFor(comps);
    const prev: PrevState = { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: {} };
    const patched = comps.map((c) => (c.id === r.id ? { ...c, parameters: newParams } : c));
    let res: any;
    for (let i = 0; i < 21; i++) {
      res = simulateStep(i < 20 ? comps : patched, exampleRC.wires, plugins, prev, 1e-4, { ...OPTS, recordTerminalCurrents: i === 20 });
      prev.nodeVoltage = res.sim.nodeVoltage; prev.branchCurrent = res.sim.branchCurrent; prev.time = res.sim.time; prev.state = res.sim.state;
    }
    expect(Array.from(snaps().at(-1)!.nodeVoltage)).toEqual(Array.from(res.sim.nodeVoltage));
  });

  it("'seed' mode continues from supplied state; 'keep' reload preserves worker state", () => {
    const h1 = makeHost();
    h1.host.handle(load(example555.components, example555.wires));
    h1.host.handle({ type: 'step', frames: 10 });
    const s10 = h1.snaps().at(-1)!;

    const h2 = makeHost();
    const ref10 = directSteps(example555.components, example555.wires, 10);
    h2.host.handle(load(example555.components, example555.wires, {
      mode: 'seed',
      seed: { nodeVoltage: ref10.sim.nodeVoltage.slice(), branchCurrent: ref10.sim.branchCurrent.slice(), time: ref10.sim.time, state: structuredClone(ref10.sim.state) },
    }));
    h2.host.handle({ type: 'step', frames: 5 });
    h1.host.handle({ type: 'load', ...load(example555.components, example555.wires, { mode: 'keep', epoch: 2 }) } as any);
    h1.host.handle({ type: 'step', frames: 5 });
    expect(s10.epoch).toBe(1);
    expect(h1.snaps().at(-1)!.epoch).toBe(2);
    expect(Array.from(h2.snaps().at(-1)!.nodeVoltage)).toEqual(Array.from(h1.snaps().at(-1)!.nodeVoltage));
    expect(h1.snaps().at(-1)!.time).toBeCloseTo(15e-4, 12);
  });

  it('run loop: backpressure until ack, then keeps going; pause flushes state', () => {
    const { host, snaps, timers } = makeHost();
    host.handle(load(example555.components, example555.wires));
    host.handle({ type: 'run' });
    const fire = () => { const f = timers.shift(); f?.(); };
    fire();                         // frame 1 -> snapshot
    expect(snaps()).toHaveLength(1);
    fire(); fire();                 // unacked: no new snapshots
    expect(snaps()).toHaveLength(1);
    host.handle({ type: 'ack' });
    fire();
    expect(snaps()).toHaveLength(2);
    host.handle({ type: 'ack' });
    host.handle({ type: 'pause' });
    const last = snaps().at(-1)!;
    expect(snaps().length).toBe(3); // flush
    expect(last.state).toBeTruthy();
    expect(last.time).toBeCloseTo(2e-4, 12);
  });

  it('solver failure reports an error and stops', () => {
    const { host, out } = makeHost();
    // two ideal voltage sources in parallel -> singular
    const comps: CircuitComponent[] = [
      { id: 'v1', type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0, parameters: { voltage: 5 } },
      { id: 'v2', type: 'dcVoltage', position: { x: 0, y: 4 }, rotation: 0, parameters: { voltage: 3 } },
      { id: 'g', type: 'ground', position: { x: 0, y: 8 }, rotation: 0, parameters: {} },
    ];
    const wires = [
      { id: 'a', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'v2', terminalId: 'p' } },
      { id: 'b', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'g', terminalId: 'g' } },
      { id: 'c', from: { componentId: 'v2', terminalId: 'n' }, to: { componentId: 'g', terminalId: 'g' } },
    ];
    host.handle(load(comps, wires));
    host.handle({ type: 'step', frames: 1 });
    const err = out.find((o) => o.msg.type === 'error');
    expect(err).toBeTruthy();
  });

  it('oscilloscope samples ride along in snapshots', () => {
    const doc = structuredClone(example555);
    // reuse an example that has a scope if the 555 one lacks it: add one wired to OUT
    doc.components.push({ id: 'scope1', type: 'oscilloscope', position: { x: 40, y: 8 }, rotation: 0, parameters: {} });
    doc.wires.push({ id: 'ws1', from: { componentId: 'ic1', terminalId: 'out' }, to: { componentId: 'scope1', terminalId: 'p' } } as any);
    const { host, snaps } = makeHost();
    host.handle(load(doc.components, doc.wires));
    host.handle({ type: 'step', frames: 3 });
    const s = snaps().at(-1)!;
    expect(s.scopeIds).toEqual(['scope1']);
    expect(s.scopeTimes.length).toBe(3);
    expect(s.scopeValues.length).toBe(3);
    expect(s.scopeTimes[2]).toBe(s.time);
  });
});
