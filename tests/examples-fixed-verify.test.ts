// Scratch: measure the fixed examples end-to-end (audio amp tuning + verification).
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import {
  exampleAudioAmplifier, exampleRLHighPass, exampleCurrentSource,
  exampleDiodeRectifier, exampleOpampNonInverting, exampleSpeaker,
} from '../src/lib/circuit/examples';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function plugins() {
  return new Map(getAllPlugins().map(p => [p.type, p]));
}
function runDoc(doc: any, steps: number, dt = 1e-4) {
  const p = plugins();
  let prev: any;
  let last: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(doc.components, doc.wires, p, prev, dt);
    if (!r) return { last: null, trace: [] as number[][] };
    last = r;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return last;
}
function nodeOf(r: any, id: string, term: string): number {
  return r.sim.nodeVoltage[r.nodeMap.terminalNode.get(`${id}:${term}`)!];
}

function ppOf(r: any, id: string, term: string): number {
  return Math.abs(nodeOf(r, id, term));
}

describe('fixed examples verification', () => {
  it('RL high-pass passes 1kHz', () => {
    // 1kHz, R=100 series, L=10mH shunt: |H| = ωL/√(R²+(ωL)²) = 0.528
    // Run 5 cycles of settling, measure peak
    let prev: any; let maxIn = 0, maxOut = 0;
    const p = plugins();
    for (let i = 0; i < 120; i++) {
      const r = simulateStep(exampleRLHighPass.components, exampleRLHighPass.wires, p, prev, 1e-4);
      expect(r).not.toBeNull();
      const vin = nodeOf(r!, 'v1', 'p');
      const vout = nodeOf(r!, 'l1', 'a');
      if (i > 60) { maxIn = Math.max(maxIn, Math.abs(vin)); maxOut = Math.max(maxOut, Math.abs(vout)); }
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    const ratio = maxOut / maxIn;
    console.log('RL high-pass ratio @1kHz:', ratio.toFixed(3), '(analytic 0.528)');
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.7);
  });

  it('current source example reads positive', () => {
    const r = runDoc(exampleCurrentSource, 5)!;
    expect(r).not.toBeNull();
    const vLoad = nodeOf(r, 'r1', 'a');
    console.log('current source load voltage:', vLoad.toFixed(3), 'V (expect +5)');
    expect(vLoad).toBeCloseTo(5, 1);
  });

  it('rectifier example blocks negative half', () => {
    let prev: any; let minOut = Infinity, maxOut = -Infinity;
    const p = plugins();
    for (let i = 0; i < 400; i++) {
      const r = simulateStep(exampleDiodeRectifier.components, exampleDiodeRectifier.wires, p, prev, 1e-4);
      expect(r).not.toBeNull();
      const out = nodeOf(r!, 'r1', 'a');
      minOut = Math.min(minOut, out); maxOut = Math.max(maxOut, out);
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    console.log('rectifier out range:', minOut.toFixed(3), 'to', maxOut.toFixed(3));
    expect(minOut).toBeGreaterThan(-0.1);
    expect(maxOut).toBeGreaterThan(3.5);
  });

  it('non-inverting amp example has gain 11', () => {
    const r = runDoc(exampleOpampNonInverting, 15)!;
    expect(r).not.toBeNull();
    const vout = nodeOf(r, 'op1', 'out');
    const vin = nodeOf(r, 'vin', 'p');
    console.log('non-inverting: vin', vin.toFixed(3), 'vout', vout.toFixed(3));
    expect(vout / vin).toBeCloseTo(11, 0);
  });

  it('speaker driver has gain -10', () => {
    let prev: any; let maxIn = 0, maxOut = 0;
    const p = plugins();
    for (let i = 0; i < 80; i++) {
      const r = simulateStep(exampleSpeaker.components, exampleSpeaker.wires, p, prev, 1e-4);
      expect(r).not.toBeNull();
      if (i > 40) {
        maxIn = Math.max(maxIn, Math.abs(nodeOf(r!, 'v1', 'p')));
        maxOut = Math.max(maxOut, Math.abs(nodeOf(r!, 'spk1', 'a')));
      }
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    console.log('speaker: in-peak', maxIn.toFixed(3), 'out-peak', maxOut.toFixed(3), 'gain', (maxOut / maxIn).toFixed(2));
    expect(maxOut / maxIn).toBeCloseTo(10, 0);
  });

  it('audio amplifier end-to-end (settled measurement)', () => {
    let prev: any;
    let maxIn = 0, maxMid = 0, maxOut = 0;
    let minMid = Infinity, minOut = Infinity;
    const p = plugins();
    // 500ms at 1kHz = 500 cycles — all coupling caps fully settled
    // (C1's bias path has a ~17ms time constant; shorter windows measure
    // settling drift, not signal).
    for (let i = 0; i < 5000; i++) {
      const r = simulateStep(exampleAudioAmplifier.components, exampleAudioAmplifier.wires, p, prev, 1e-4);
      expect(r).not.toBeNull();
      if (i > 4500) {
        maxIn = Math.max(maxIn, Math.abs(nodeOf(r!, 'vSig', 'p')));
        maxMid = Math.max(maxMid, Math.abs(nodeOf(r!, 'rtone', 'b')));
        minMid = Math.min(minMid, nodeOf(r!, 'rtone', 'b'));
        maxOut = Math.max(maxOut, Math.abs(nodeOf(r!, 'spk1', 'a')));
        minOut = Math.min(minOut, nodeOf(r!, 'spk1', 'a'));
      }
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
    }
    console.log('audio amp: in-pp', (2 * maxIn).toFixed(4), 'mid-pp', (maxMid - minMid).toFixed(4), 'out-pp', (maxOut - minOut).toFixed(4));
    console.log('audio amp: mid gain', ((maxMid - minMid) / (2 * maxIn)).toFixed(2), 'end-to-end gain', ((maxOut - minOut) / (2 * maxIn)).toFixed(2));
    // Stage 1 + tone node must amplify (>= 3.5x)
    expect((maxMid - minMid) / (2 * maxIn)).toBeGreaterThan(3.5);
    // End-to-end the amplifier must AMPLIFY (>= 2.5x) — before the follower
    // rework the 8-ohm speaker shunted the CE collector and the whole amp
    // ATTENUATED by 0.07x.
    expect((maxOut - minOut) / (2 * maxIn)).toBeGreaterThan(2.5);
    // Speaker level: hundreds of mV pp (audible), not microvolts
    expect(maxOut - minOut).toBeGreaterThan(0.2);
    expect(maxOut - minOut).toBeLessThan(0.7);
  });
});
