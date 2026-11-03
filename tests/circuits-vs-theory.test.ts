// Complex circuits built from scratch, simulated, and checked against their
// closed-form textbook numbers (tight tolerances — a "works roughly" test
// would hide exactly the bugs this suite exists to catch).
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { runACAnalysis } from '../src/lib/circuit/ac-analysis';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, ComponentPlugin, Wire } from '../src/lib/circuit/types';

// ── tiny netlist builder: parts + named nets ────────────────────────────────
function circuit() {
  const components: CircuitComponent[] = [];
  const wires: Wire[] = [];
  let x = 0;
  const api = {
    components, wires,
    part(type: string, id: string, params: Record<string, number | string | boolean> = {}) {
      const pl = getPlugin(type);
      if (!pl) throw new Error(`no plugin ${type}`);
      const defaults: Record<string, number | string | boolean> = {};
      for (const p of pl.parameters) defaults[p.key] = p.default as number | string | boolean;
      components.push({ id, type, position: { x: (x += 8), y: 0 }, rotation: 0, parameters: { ...defaults, ...params } } as CircuitComponent);
      return api;
    },
    /** connect pins ("id:terminal") into one net; 'gnd' adds a ground symbol */
    net(...pins: string[]) {
      const list = pins.map((p) => {
        if (p !== 'gnd') return p;
        const id = `gnd_${components.length}`;
        api.part('ground', id);
        return `${id}:g`;
      });
      for (let i = 1; i < list.length; i++) {
        const [ca, ta] = list[0].split(':');
        const [cb, tb] = list[i].split(':');
        wires.push({ id: `w${wires.length}`, from: { componentId: ca, terminalId: ta }, to: { componentId: cb, terminalId: tb } });
      }
      return api;
    },
  };
  return api;
}
type Circuit = ReturnType<typeof circuit>;

function plugins(c: Circuit) {
  const m = new Map<string, ComponentPlugin>();
  for (const p of c.components) m.set(p.type, getPlugin(p.type)!);
  return m;
}

/** transient run → voltage sampler v(pin, step) */
function tran(c: Circuit, steps: number, dt: number, method: 'euler' | 'trap' | 'gear' = 'trap') {
  const pl = plugins(c);
  const nm = buildNodeMap(c.components, c.wires, pl);
  const nv: Float64Array[] = [];
  const bc: Float64Array[] = [];
  let prev: Parameters<typeof simulateStep>[3];
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(c.components, c.wires, pl, prev, dt, { method });
    if (!r) throw new Error(`step ${i} failed`);
    nv.push(Float64Array.from(r.sim.nodeVoltage));
    bc.push(Float64Array.from(r.sim.branchCurrent));
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  const node = (pin: string) => {
    const n = nm.terminalNode.get(pin);
    if (n === undefined) throw new Error(`no node for ${pin}`);
    return n;
  };
  return {
    v: (pin: string, i: number) => nv[i][node(pin)],
    series: (pin: string, from = 0, to = steps) => nv.slice(from, to).map((a) => a[node(pin)]),
    dt,
  };
}

/** rising zero crossings (linear interpolation) of x − level */
function crossings(x: number[], dt: number, level = 0): number[] {
  const t: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1] - level, b = x[i] - level;
    if (a < 0 && b >= 0) t.push((i - 1 + a / (a - b)) * dt);
  }
  return t;
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want);

// ── AC ──────────────────────────────────────────────────────────────────────

describe('AC: filters and resonators match their transfer functions', () => {
  it('Sallen-Key unity-gain low-pass: Butterworth Q = 0.707, f0 = 1/(2π√(R1R2C1C2))', () => {
    const R = 10e3, C1 = 20e-9, C2 = 10e-9;
    const c = circuit()
      .part('acVoltage', 'vin', { amplitude: 1, frequency: 1000 })
      .part('resistor', 'r1', { resistance: R })
      .part('resistor', 'r2', { resistance: R })
      .part('capacitor', 'c1', { capacitance: C1 })
      .part('capacitor', 'c2', { capacitance: C2 })
      .part('opamp', 'u1', { vmax: 15, vmin: -15 })
      .net('vin:p', 'r1:a')
      .net('r1:b', 'r2:a', 'c1:a')
      .net('r2:b', 'c2:a', 'u1:in+')
      .net('u1:out', 'u1:in-', 'c1:b')
      .net('vin:n', 'c2:b', 'gnd');
    const f0 = 1 / (2 * Math.PI * Math.sqrt(R * R * C1 * C2)); // 1125.4 Hz
    const Q = Math.sqrt(R * R * C1 * C2) / (C2 * 2 * R);       // 0.7071
    const at = (f: number) => runACAnalysis({ components: c.components, wires: c.wires, fStart: f, fStop: f, nPoints: 1, sweep: 'lin', sourceId: 'vin', outputNode: 'u1:out' }).points[0];
    expect(at(10).magnitude).toBeCloseTo(1, 3);
    expect(rel(at(f0).magnitude, Q)).toBeLessThan(0.01);
    expect(Math.abs(at(f0).phase + 90)).toBeLessThan(1);
    // 2nd-order Butterworth one decade up: 1/√(1+(f/f0)^4)
    expect(rel(at(10 * f0).magnitude, 1 / Math.sqrt(1 + 1e4))).toBeLessThan(0.03);
  });

  it('parallel LC tank fed through R peaks at 1/(2π√LC) with Q = R√(C/L)', () => {
    const L = 1e-3, C = 1e-6, R = 1e3;
    const c = circuit()
      .part('acVoltage', 'vin', { amplitude: 1, frequency: 1000 })
      .part('resistor', 'r', { resistance: R })
      .part('inductor', 'l', { inductance: L })
      .part('capacitor', 'c', { capacitance: C })
      .net('vin:p', 'r:a')
      .net('r:b', 'l:a', 'c:a')
      .net('vin:n', 'l:b', 'c:b', 'gnd');
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C)); // 5033 Hz
    const res = runACAnalysis({ components: c.components, wires: c.wires, fStart: 0.9 * f0, fStop: 1.1 * f0, nPoints: 401, sweep: 'lin', sourceId: 'vin', outputNode: 'r:b' });
    const peak = res.points.reduce((a, b) => (b.magnitude > a.magnitude ? b : a));
    expect(rel(peak.frequency, f0)).toBeLessThan(0.002);
    expect(peak.magnitude).toBeCloseTo(1, 2);
    // −3 dB bandwidth = f0/Q
    const Qth = R * Math.sqrt(C / L);
    const half = res.points.filter((p) => p.magnitude >= 1 / Math.SQRT2);
    const bw = half[half.length - 1].frequency - half[0].frequency;
    expect(rel(bw, f0 / Qth)).toBeLessThan(0.03);
  });
});

// ── transient ───────────────────────────────────────────────────────────────

describe('transient: dynamics match the closed-form solutions', () => {
  it('series RLC rings at ωd = √(1/LC − (R/2L)²) and decays as e^(−Rt/2L)', () => {
    const L = 1e-3, C = 1e-6, R = 10;
    const c = circuit()
      .part('capacitor', 'c', { capacitance: C, initialV: 1 })
      .part('inductor', 'l', { inductance: L })
      .part('resistor', 'r', { resistance: R })
      .net('c:a', 'l:a')
      .net('l:b', 'r:a')
      .net('r:b', 'c:b', 'gnd');
    const dt = 2e-7;
    const s = tran(c, 5000, dt);
    const vc = s.series('c:a');
    const wd = Math.sqrt(1 / (L * C) - (R / (2 * L)) ** 2);
    const tz = crossings(vc, dt);
    expect(tz.length).toBeGreaterThanOrEqual(3);
    const period = (tz[tz.length - 1] - tz[0]) / (tz.length - 1);
    expect(rel(period, (2 * Math.PI) / wd)).toBeLessThan(0.005);
    // successive positive peaks shrink by e^(−α·Td)
    const peaks: number[] = [];
    for (let i = 1; i < vc.length - 1; i++) if (vc[i] > vc[i - 1] && vc[i] >= vc[i + 1] && vc[i] > 0) peaks.push(vc[i]);
    const ratio = peaks[2] / peaks[1];
    expect(rel(ratio, Math.exp((-R / (2 * L)) * ((2 * Math.PI) / wd)))).toBeLessThan(0.02);
  });

  it('op-amp integrator ramps at −Vin/(RC)', () => {
    const R = 10e3, C = 100e-9, Vin = 1;
    const c = circuit()
      .part('dcVoltage', 'vs', { voltage: Vin })
      .part('resistor', 'r', { resistance: R })
      .part('capacitor', 'c', { capacitance: C, initialV: 0 })
      .part('opamp', 'u1', { vmax: 15, vmin: -15 })
      .net('vs:p', 'r:a')
      .net('r:b', 'u1:in-', 'c:a')
      .net('u1:out', 'c:b')
      .net('vs:n', 'u1:in+', 'gnd');
    const dt = 1e-5;
    const s = tran(c, 600, dt);
    // slope over 1 ms … 5 ms (well inside the ±15 V rails)
    const slope = (s.v('u1:out', 499) - s.v('u1:out', 99)) / (400 * dt);
    expect(rel(slope, -Vin / (R * C))).toBeLessThan(0.01);
  });

  it('full-wave bridge + reservoir cap: Vpeak − 2 diode drops, ripple ≈ I/(2fC) at 2f', () => {
    const f = 50, Vp = 12, C = 1000e-6, R = 1e3;
    const c = circuit()
      .part('acVoltage', 'vin', { amplitude: Vp, frequency: f })
      .part('diode', 'd1').part('diode', 'd2').part('diode', 'd3').part('diode', 'd4')
      .part('capacitor', 'c', { capacitance: C, initialV: 0 })
      .part('resistor', 'rl', { resistance: R })
      // bridge: ac+ → d1 → out+, ac− → d2 → out+, gnd → d3 → ac+, gnd → d4 → ac−
      .net('vin:p', 'd1:a', 'd3:k')
      .net('vin:n', 'd2:a', 'd4:k')
      .net('d1:k', 'd2:k', 'c:a', 'rl:a')
      .net('d3:a', 'd4:a', 'c:b', 'rl:b', 'gnd');
    const dt = 2e-5;
    const s = tran(c, 10000, dt); // 200 ms → 10 cycles
    const out = s.series('c:a', 7500); // last 2.5 cycles
    const vmax = Math.max(...out), vmin = Math.min(...out);
    // the floating source + bridge: out = |vin| − 2·Vf (Vf = 0.7 V + on-R drop)
    expect(vmax).toBeGreaterThan(Vp - 2 * 0.7 - 0.6);
    expect(vmax).toBeLessThan(Vp - 2 * 0.7 + 0.05);
    const ripple = vmax - vmin;
    const iLoad = mean(out) / R;
    expect(rel(ripple, iLoad / (2 * f * C))).toBeLessThan(0.15);
    // ripple frequency is 2f
    const tz = crossings(out, dt, mean(out));
    expect(rel(1 / ((tz[tz.length - 1] - tz[0]) / (tz.length - 1)), 2 * f)).toBeLessThan(0.03);
  });

  it('buck converter (CCM) regulates to D·Vin minus switch/diode losses', () => {
    const Vin = 12, D = 0.5, fsw = 50e3, L = 100e-6, C = 100e-6, R = 10;
    const c = circuit()
      .part('dcVoltage', 'vin', { voltage: Vin })
      .part('pulseSource', 'gate', { low: 0, high: 24, frequency: fsw, duty: D * 100 })
      .part('nmos', 'q1', { vth: 2, kp: 5, ron: 0.05 })
      .part('diode', 'd1')
      .part('inductor', 'l', { inductance: L, initialI: 0 })
      .part('capacitor', 'c', { capacitance: C, initialV: 0 })
      .part('resistor', 'rl', { resistance: R })
      .net('vin:p', 'q1:d')
      .net('gate:p', 'q1:g')
      .net('q1:s', 'd1:k', 'l:a')
      .net('l:b', 'c:a', 'rl:a')
      .net('vin:n', 'gate:n', 'd1:a', 'c:b', 'rl:b', 'gnd');
    const dt = 1 / fsw / 100;
    const s = tran(c, 40000, dt); // 20 ms
    const vout = mean(s.series('c:a', 36000)); // last 2 ms
    const iL = vout / R;
    const vd = 0.7 + iL * 1; // diode model: 0.7 V + 1 Ω on-resistance
    const expected = D * (Vin - iL * 0.05) - (1 - D) * vd;
    expect(rel(vout, expected)).toBeLessThan(0.04);
  });

  it('boost converter (CCM) steps up to (Vin − losses)/(1 − D)', () => {
    const Vin = 5, D = 0.5, fsw = 50e3, L = 100e-6, C = 100e-6, R = 50;
    const c = circuit()
      .part('dcVoltage', 'vin', { voltage: Vin })
      .part('pulseSource', 'gate', { low: 0, high: 10, frequency: fsw, duty: D * 100 })
      .part('nmos', 'q1', { vth: 2, kp: 5, ron: 0.05 })
      .part('diode', 'd1')
      .part('inductor', 'l', { inductance: L, initialI: 0 })
      .part('capacitor', 'c', { capacitance: C, initialV: 0 })
      .part('resistor', 'rl', { resistance: R })
      .net('vin:p', 'l:a')
      .net('l:b', 'q1:d', 'd1:a')
      .net('d1:k', 'c:a', 'rl:a')
      .net('gate:p', 'q1:g')
      .net('vin:n', 'gate:n', 'q1:s', 'c:b', 'rl:b', 'gnd');
    const dt = 1 / fsw / 100;
    const s = tran(c, 60000, dt); // 30 ms
    const vout = mean(s.series('c:a', 56000));
    const iOut = vout / R, iL = iOut / (1 - D);
    const vd = 0.7 + iL * 1;
    // volt-second balance: D·(Vin − iL·Ron) + (1−D)·(Vin − Vd − Vout) = 0
    const expected = (Vin - D * iL * 0.05) / (1 - D) - vd;
    expect(rel(vout, expected)).toBeLessThan(0.04);
  });

  it('BJT current mirror copies Iref with the 1/(1 + 2/β) base-current error', () => {
    const beta = 100, Vcc = 10, Rref = 9.3e3;
    const c = circuit()
      .part('dcVoltage', 'vcc', { voltage: Vcc })
      .part('resistor', 'rref', { resistance: Rref })
      .part('resistor', 'rload', { resistance: 2e3 })
      .part('npn', 'q1', { hfe: beta })
      .part('npn', 'q2', { hfe: beta })
      .net('vcc:p', 'rref:a', 'rload:a')
      .net('rref:b', 'q1:c', 'q1:b', 'q2:b')
      .net('rload:b', 'q2:c')
      .net('vcc:n', 'q1:e', 'q2:e', 'gnd');
    const s = tran(c, 3, 1e-6);
    const vbe = s.v('q1:b', 2);
    const iref = (Vcc - vbe) / Rref;
    const iout = (Vcc - s.v('q2:c', 2)) / 2e3;
    expect(rel(iout, iref / (1 + 2 / beta))).toBeLessThan(0.02);
  });

  it('PNP current mirror (high-side) sources the same 1/(1 + 2/β) copy', () => {
    const beta = 50, Vcc = 10, Rref = 9.3e3;
    const c = circuit()
      .part('dcVoltage', 'vcc', { voltage: Vcc })
      .part('resistor', 'rref', { resistance: Rref })
      .part('resistor', 'rload', { resistance: 2e3 })
      .part('pnp', 'q1', { hfe: beta })
      .part('pnp', 'q2', { hfe: beta })
      .net('vcc:p', 'q1:e', 'q2:e')
      .net('q1:c', 'q1:b', 'q2:b', 'rref:a')
      .net('q2:c', 'rload:a')
      .net('vcc:n', 'rref:b', 'rload:b', 'gnd');
    const s = tran(c, 3, 1e-6);
    const iref = s.v('rref:a', 2) / Rref;
    const iout = s.v('rload:a', 2) / 2e3;
    expect(Vcc - s.v('q1:b', 2)).toBeCloseTo(0.7, 2);
    expect(rel(iout, iref / (1 + 2 / beta))).toBeLessThan(0.02);
  });

  it('Wien-bridge oscillator starts on its own and runs at 1/(2πRC)', () => {
    const R = 10e3, C = 10e-9;
    const c = circuit()
      .part('resistor', 'rs', { resistance: R })   // series arm
      .part('capacitor', 'cs', { capacitance: C, initialV: 0.05 })
      .part('resistor', 'rp', { resistance: R })   // shunt arm
      .part('capacitor', 'cp', { capacitance: C, initialV: 0 })
      .part('resistor', 'rf', { resistance: 21e3 }) // gain 1 + 21k/10k = 3.1 (just above 3)
      .part('resistor', 'rg', { resistance: 10e3 })
      .part('opamp', 'u1', { vmax: 10, vmin: -10 })
      .net('u1:out', 'rs:a', 'rf:a')
      .net('rs:b', 'cs:a')
      .net('cs:b', 'rp:a', 'cp:a', 'u1:in+')
      .net('rf:b', 'rg:a', 'u1:in-')
      .net('rp:b', 'cp:b', 'rg:b', 'gnd');
    const f0 = 1 / (2 * Math.PI * R * C); // 1591.5 Hz
    const dt = 1 / f0 / 200;
    const s = tran(c, 200 * 60, dt); // 60 periods
    const out = s.series('u1:out', 200 * 40);
    expect(Math.max(...out)).toBeGreaterThan(5); // it really oscillates
    const tz = crossings(out, dt);
    const f = 1 / ((tz[tz.length - 1] - tz[0]) / (tz.length - 1));
    // rail clipping (gain 3.1) pulls the frequency down slightly
    expect(rel(f, f0)).toBeLessThan(0.05);
  });
});
