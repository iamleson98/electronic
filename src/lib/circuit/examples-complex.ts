// Complex example circuits — Falstad-class library.
//
// Every circuit in this file is a "real engineering" circuit (bias networks,
// feedback loops, differential pairs, power stages, digital logic built from
// gates) — the kind falstad.com/circuit organizes into its example tree.
// Each one is layout-designed (sources left, ground bottom, ≥4-grid spacing,
// orthogonal wires) and, critically, EVERY one is simulation-verified by
// tests/examples-falstad-verify.test.ts: transient runs, physics checks, and
// per-circuit behavioral assertions (frequency, gain, clipping, state
// sequences, current flow).
//
// Conventions reused from examples.ts: comp()/wire() builders; the exported
// raw documents are normalized by examples.ts's normalizeExampleWires.

import type { CircuitDocument } from './types';
import { getPlugin } from './registry';
import './components';

function defaultsFor(type: string): Record<string, number | string | boolean> {
  const plugin = getPlugin(type);
  if (!plugin) return {};
  const defaults: Record<string, number | string | boolean> = {};
  for (const p of plugin.parameters) defaults[p.key] = p.default;
  return defaults;
}

function comp(
  type: string,
  id: string,
  pos: [number, number],
  rotation: 0 | 1 | 2 | 3 = 0,
  params?: Record<string, number | string | boolean>,
) {
  return {
    id,
    type,
    position: { x: pos[0], y: pos[1] },
    rotation,
    parameters: { ...defaultsFor(type), ...params },
  };
}

function wire(id: string, fromC: string, fromT: string, toC: string, toT: string, waypoints?: [number, number][]) {
  const w: any = { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
  if (waypoints && waypoints.length > 0) {
    w.waypoints = waypoints.map(([x, y]) => ({ x, y }));
  }
  return w;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRANSISTOR CIRCUITS
// ═══════════════════════════════════════════════════════════════════════════

// ── BJT Common-Emitter Amplifier ───────────────────────────────────────────
// The canonical single-stage amplifier: divider bias (68k/12k), emitter
// degeneration (470Ω), collector load (2.2k), AC-coupled in/out (10µF).
// 9V supply, 2N2222-style NPN (β=150). Vb ≈ 1.35V → Ve ≈ 0.65V → Ie ≈ 1.4mA
// → Vc ≈ 9 − 2.2k·1.4mA ≈ 5.9V — dead-center in the active region.
// 300mV sine in → inverted, amplified swing on the collector (scopes show
// both). Flip the button to compare the bypassed/unbypassed gain if wired.
const rawExCeAmplifier: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'vcc1', [2, 4], 0, { voltage: 9 }),
    comp('resistor', 'r1', [8, 2], 0, { resistance: 68000 }),
    comp('resistor', 'r2', [8, 10], 0, { resistance: 12000 }),
    comp('resistor', 'rc', [16, 2], 0, { resistance: 2200 }),
    comp('resistor', 're', [16, 10], 0, { resistance: 470 }),
    comp('resistor', 'rload', [30, 4], 0, { resistance: 10000 }),
    comp('capacitor', 'cin', [12, 6], 0, { capacitance: 1e-5 }),
    comp('capacitor', 'cout', [24, 4], 0, { capacitance: 1e-5 }),
    comp('npn', 'q1', [20, 6], 0, { hfe: 150, vbe: 0.7, satV: 0.2 }),
    comp('acVoltage', 'vin', [4, 6], 0, { amplitude: 0.3, frequency: 1000, offset: 0, phase: 0 }),
    comp('oscilloscope', 'scIn', [4, 14], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [26, 14], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 20], 0, {}),
  ],
  wires: [
    // bias divider
    wire('w1', 'vcc1', 'p', 'r1', 'a', [[3, 3], [8, 3]]),
    wire('w2', 'r1', 'b', 'r2', 'a', [[12, 3], [12, 11]]),
    wire('w3', 'r2', 'b', 'gnd1', 'g', [[12, 21], [3, 21]]),
    wire('w4', 'vcc1', 'n', 'gnd1', 'g', [[3, 21]]),
    // input coupling: vin → cin → base; base also fed by divider mid
    wire('w5', 'vin', 'p', 'cin', 'a', [[5, 7], [12, 7]]),
    wire('w6', 'cin', 'b', 'q1', 'b', [[16, 7], [21, 7]]),
    wire('w7', 'r1', 'b', 'q1', 'b', [[12, 3], [21, 7]]),
    wire('w8', 'vin', 'n', 'gnd1', 'g', [[5, 21], [3, 21]]),
    // collector branch
    wire('w9', 'vcc1', 'p', 'rc', 'a', [[3, 3], [17, 3]]),
    wire('w10', 'rc', 'b', 'q1', 'c', [[20, 3], [23, 7]]),
    // emitter branch
    wire('w11', 'q1', 'e', 're', 'a', [[23, 11], [16, 11]]),
    wire('w12', 're', 'b', 'gnd1', 'g', [[20, 21], [3, 21]]),
    // output coupling
    wire('w13', 'q1', 'c', 'cout', 'a', [[23, 7], [27, 5]]),
    wire('w14', 'cout', 'b', 'rload', 'a', [[28, 5]]),
    wire('w15', 'rload', 'b', 'gnd1', 'g', [[34, 21], [3, 21]]),
    // scopes
    wire('w16', 'vin', 'p', 'scIn', 'p', [[5, 15]]),
    wire('w17', 'scIn', 'n', 'gnd1', 'g', [[5, 15], [5, 21]]),
    wire('w18', 'q1', 'c', 'scOut', 'p', [[23, 7], [23, 15], [27, 15]]),
    wire('w19', 'scOut', 'n', 'gnd1', 'g', [[28, 15], [28, 21], [3, 21]]),
  ],
};

// ── Class-B Push-Pull Output Stage ─────────────────────────────────────────
// The output stage of every audio power amplifier: complementary NPN/PNP
// emitter followers stacked between ±9V rails. Each transistor conducts on
// its half-cycle; the 0.7V Vbe pair creates the textbook CROSSOVER DEAD ZONE
// (watch the load voltage: the sine's tips are shaved near zero). Drive it
// harder (amplitude > 3V) and the clipping at the rails appears too.
const rawExPushPull: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'vp', [2, 2], 0, { voltage: 9 }),
    comp('dcVoltage', 'vn', [2, 12], 0, { voltage: -9 }),
    comp('npn', 'qn', [12, 6], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    comp('pnp', 'qp', [12, 14], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    comp('acVoltage', 'vin', [4, 10], 0, { amplitude: 3, frequency: 200, offset: 0, phase: 0 }),
    comp('resistor', 'rl', [20, 10], 0, { resistance: 100 }),
    comp('oscilloscope', 'scIn', [4, 18], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [24, 18], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 24], 0, {}),
  ],
  wires: [
    wire('w1', 'vp', 'p', 'qn', 'c', [[3, 3], [15, 3], [15, 7]]),
    wire('w2', 'vn', 'p', 'qp', 'c', [[3, 17], [15, 17], [15, 15]]),
    wire('w3', 'vin', 'p', 'qn', 'b', [[5, 11], [11, 7]]),
    wire('w4', 'vin', 'p', 'qp', 'b', [[5, 11], [11, 15]]),
    wire('w5', 'qn', 'e', 'rl', 'a', [[15, 11]]),
    wire('w6', 'qp', 'e', 'rl', 'a', [[15, 11]]),
    wire('w7', 'rl', 'b', 'gnd1', 'g', [[24, 25], [3, 25]]),
    wire('w8', 'vp', 'n', 'gnd1', 'g', [[3, 25]]),
    wire('w9', 'vn', 'n', 'gnd1', 'g', [[3, 6], [3, 25]]),
    wire('w10', 'vin', 'n', 'gnd1', 'g', [[5, 25], [3, 25]]),
    wire('w11', 'vin', 'p', 'scIn', 'p', [[5, 19]]),
    wire('w12', 'scIn', 'n', 'gnd1', 'g', [[5, 19], [5, 25]]),
    wire('w13', 'rl', 'a', 'scOut', 'p', [[21, 11], [21, 19], [25, 19]]),
    wire('w14', 'scOut', 'n', 'gnd1', 'g', [[26, 19], [26, 25], [3, 25]]),
  ],
};

// ── Phase-Shift Oscillator (BJT) ───────────────────────────────────────────
// The classic RC sine oscillator: a common-emitter amplifier (β=150, gain
// set well above 29) with a 3-section RC ladder feeding its output phase
// back to its base. Each RC section contributes 60° at the oscillation
// frequency, so the ladder's total 180° plus the CE stage's inversion
// closes the loop at exactly 360°. Watch the oscillation build from
// nothing on the scope — the loop gain only exceeds 1 thanks to the
// bypassed emitter resistor, and the amplitude grows until the
// transistor's nonlinearity clamps it.
const rawExPhaseShiftOscillator: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'vcc1', [2, 4], 0, { voltage: 9 }),
    comp('resistor', 'rb1', [8, 2], 0, { resistance: 68000 }),
    comp('resistor', 'rb2', [8, 10], 0, { resistance: 8200 }),
    comp('resistor', 'rc', [16, 2], 0, { resistance: 10000 }),
    comp('resistor', 're', [16, 12], 0, { resistance: 470 }),
    comp('capacitor', 'ce', [22, 12], 0, { capacitance: 1e-4 }),
    // phase-shift ladder: 3 stages of C (10nF) + R (10k)
    comp('capacitor', 'cs1', [26, 6], 0, { capacitance: 1e-8 }),
    comp('capacitor', 'cs2', [32, 6], 0, { capacitance: 1e-8 }),
    comp('capacitor', 'cs3', [38, 6], 0, { capacitance: 1e-8 }),
    comp('resistor', 'rs1', [26, 10], 0, { resistance: 10000 }),
    comp('resistor', 'rs2', [32, 10], 0, { resistance: 10000 }),
    comp('resistor', 'rs3', [38, 10], 0, { resistance: 10000 }),
    comp('npn', 'q1', [20, 6], 0, { hfe: 150, vbe: 0.7, satV: 0.2 }),
    comp('oscilloscope', 'sc1', [24, 16], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 24], 0, {}),
  ],
  wires: [
    // bias divider
    wire('w1', 'vcc1', 'p', 'rb1', 'a', [[3, 3]]),
    wire('w2', 'rb1', 'b', 'rb2', 'a', [[12, 3], [12, 11]]),
    wire('w3', 'rb2', 'b', 'gnd1', 'g', [[12, 25], [3, 25]]),
    wire('w4', 'vcc1', 'n', 'gnd1', 'g', [[3, 25]]),
    // collector branch
    wire('w5', 'vcc1', 'p', 'rc', 'a', [[3, 4], [17, 3]]),
    wire('w6', 'rc', 'b', 'q1', 'c', [[20, 3], [23, 7]]),
    // phase-shift ladder from the collector: each node has C from the
    // previous node and R to ground; the LAST R feeds the base
    wire('w7', 'q1', 'c', 'cs1', 'a', [[23, 7], [23, 5]]),
    wire('w8', 'cs1', 'b', 'rs1', 'a', [[27, 5], [27, 11]]),
    wire('w9', 'rs1', 'b', 'gnd1', 'g', [[30, 25], [3, 25]]),
    wire('w10', 'cs1', 'b', 'cs2', 'a', [[27, 5], [33, 5]]),
    wire('w11', 'cs2', 'b', 'rs2', 'a', [[33, 11]]),
    wire('w12', 'rs2', 'b', 'gnd1', 'g', [[36, 25], [3, 25]]),
    wire('w13', 'cs2', 'b', 'cs3', 'a', [[33, 5], [39, 5]]),
    wire('w14', 'cs3', 'b', 'rs3', 'a', [[39, 11]]),
    wire('w15', 'rs3', 'b', 'q1', 'b', [[39, 11], [39, 19], [13, 19], [13, 9]]),
    // base bias joins at the base node
    wire('w16', 'rb1', 'b', 'q1', 'b', [[12, 3], [13, 9]]),
    // emitter with bypass
    wire('w17', 'q1', 'e', 're', 'a', [[23, 11], [16, 13]]),
    wire('w18', 're', 'b', 'gnd1', 'g', [[20, 25], [3, 25]]),
    wire('w19', 'q1', 'e', 'ce', 'a', [[23, 11], [23, 13]]),
    wire('w20', 'ce', 'b', 'gnd1', 'g', [[24, 25], [3, 25]]),
    // scope on the collector
    wire('w21', 'q1', 'c', 'sc1', 'p', [[23, 7], [23, 17], [25, 17]]),
    wire('w22', 'sc1', 'n', 'gnd1', 'g', [[26, 17], [26, 25], [3, 25]]),
  ],
};

// ── NPN Current Mirror ─────────────────────────────────────────────────────
// The backbone of every analog IC: Q1 is diode-connected (collector tied to
// base) and converts the reference current (set by Rset) into a Vbe; Q2
// sees the same Vbe and sinks the SAME collector current into its load,
// independent (to first order) of what the load voltage is. Iref =
// (9−0.7)/10k ≈ 0.83mA; the mirror's 5k load therefore sits at 9 −
// 0.83mA·5k ≈ 4.9V. Swap Rload and watch the load voltage move while the
// mirror current barely changes.
const rawExCurrentMirror: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 4], 0, { voltage: 9 }),
    comp('resistor', 'rset', [8, 2], 0, { resistance: 10000 }),
    comp('resistor', 'rload', [26, 2], 0, { resistance: 5000 }),
    comp('npn', 'q1', [14, 6], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    comp('npn', 'q2', [22, 6], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    // emitter ballast (1Ω each): separates the two transistors' Vbe source
    // branches — without them Q1/Q2 stamp identical parallel voltage sources
    // between the shared base/emitter nodes and the branch currents (the
    // mirror's Ib readout) become indeterminate. 1Ω ≪ everything else.
    comp('resistor', 're1', [14, 12], 0, { resistance: 1 }),
    comp('resistor', 're2', [22, 12], 0, { resistance: 1 }),
    comp('ammeter', 'am1', [30, 10], 0, {}),
    comp('voltmeter', 'vm1', [18, 2], 0, {}),
    comp('ground', 'gnd1', [3, 20], 0, {}),
  ],
  wires: [
    // reference branch: VCC → rset → Q1 (diode-connected)
    wire('w1', 'v1', 'p', 'rset', 'a', [[3, 3], [8, 3]]),
    wire('w2', 'rset', 'b', 'q1', 'c', [[12, 3], [15, 7]]),
    wire('w3', 'q1', 'c', 'q1', 'b', [[15, 7], [15, 9]]),          // diode connection
    wire('w4', 'q1', 'b', 'q2', 'b', [[15, 9], [23, 9]]),          // shared Vbe
    wire('w5', 'q1', 'e', 're1', 'a', [[17, 12], [17, 13]]),
    wire('w5b', 're1', 'b', 'gnd1', 'g', [[17, 21], [3, 21]]),
    wire('w6', 'q2', 'e', 're2', 'a', [[25, 12], [25, 13]]),
    wire('w6b', 're2', 'b', 'gnd1', 'g', [[25, 21], [3, 21]]),
    // mirror output: VCC → rload → ammeter → Q2 collector
    wire('w7', 'v1', 'p', 'rload', 'a', [[3, 4], [27, 3]]),
    wire('w8', 'rload', 'b', 'am1', 'p', [[31, 3], [31, 5]]),
    wire('w9', 'am1', 'n', 'q2', 'c', [[33, 5], [33, 7], [23, 7]]),
    wire('w10', 'q2', 'c', 'vm1', 'p', [[23, 7], [19, 3]]),
    wire('w11', 'vm1', 'n', 'gnd1', 'g', [[19, 21], [3, 21]]),
    wire('w12', 'v1', 'n', 'gnd1', 'g', [[3, 21]]),
  ],
};

// ── Emitter Follower (Common-Collector Buffer) ─────────────────────────────
// High input impedance, low output impedance, unity voltage gain: the
// buffer every circuit uses. A 3V-offset 1kHz sine rides on the base (the
// offset IS the bias); the emitter tracks it 0.7V below, driving the 1k
// load with β+1× current gain. Scope both: Vout = Vin − 0.7, in phase.
const rawExEmitterFollower: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'vcc', [2, 2], 0, { voltage: 9 }),
    comp('acVoltage', 'vin', [2, 8], 0, { amplitude: 1, frequency: 1000, offset: 3, phase: 0 }),
    comp('npn', 'q1', [10, 6], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    comp('resistor', 're', [16, 10], 0, { resistance: 1000 }),
    comp('oscilloscope', 'scIn', [4, 16], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [20, 16], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 22], 0, {}),
  ],
  wires: [
    // collector to the rail (the follower's current source path)
    wire('w0', 'vcc', 'p', 'q1', 'c', [[3, 3], [11, 3], [13, 7]]),
    wire('w0b', 'vcc', 'n', 'gnd1', 'g', [[3, 23]]),
    wire('w1', 'vin', 'p', 'q1', 'b', [[3, 9], [11, 9]]),
    wire('w2', 'vin', 'n', 'gnd1', 'g', [[3, 23]]),
    wire('w3', 'q1', 'e', 're', 'a', [[13, 11], [16, 11]]),
    wire('w4', 're', 'b', 'gnd1', 'g', [[20, 23], [3, 23]]),
    wire('w5', 'vin', 'p', 'scIn', 'p', [[3, 17]]),
    wire('w6', 'scIn', 'n', 'gnd1', 'g', [[5, 17], [5, 23]]),
    wire('w7', 'q1', 'e', 'scOut', 'p', [[13, 11], [13, 17], [21, 17]]),
    wire('w8', 'scOut', 'n', 'gnd1', 'g', [[22, 17], [22, 23], [3, 23]]),
  ],
};

// ── Relay Driver with Flyback Diode ────────────────────────────────────────
// The industry-standard inductive-load switch: a relay coil (an inductor)
// driven through a switch, protected by a flyback diode. Close the switch —
// the coil energizes and the contact (com→no) closes, lighting the lamp.
// OPEN the switch and watch the scope: without D1 the coil's stored energy
// would slam the switch node to thousands of volts; with D1 the spike is
// clamped to a single diode drop and the current recirculates safely.
const rawExRelayFlyback: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 4], 0, { voltage: 12 }),
    comp('switch', 'sw1', [8, 4], 0, { closed: true }),
    comp('inductor', 'lcoil', [13, 4], 0, { inductance: 0.1 }),   // coil inductance
    comp('relay', 'rl1', [18, 6], 0, {}),
    comp('diode', 'd1', [13, 12], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('resistor', 'rlamp', [28, 4], 0, { resistance: 470 }),
    comp('led', 'led1', [34, 4], 0, { color: '#eab308', forwardV: 2.0, seriesR: 1 }),
    comp('oscilloscope', 'sc1', [24, 14], 0, { color: '#22d3ee', label: 'Coil' }),
    comp('ground', 'gnd1', [3, 20], 0, {}),
  ],
  wires: [
    // coil branch: 12V → switch → L (coil inductance) → coilA; coilB → gnd
    wire('w1', 'v1', 'p', 'sw1', 'a', [[3, 5], [8, 5]]),
    wire('w2', 'sw1', 'b', 'lcoil', 'a', [[12, 5], [13, 5]]),
    wire('w3', 'lcoil', 'b', 'rl1', 'coilA', [[17, 5], [18, 5]]),
    wire('w4', 'rl1', 'coilB', 'gnd1', 'g', [[22, 21], [3, 21]]),
    wire('w5', 'v1', 'n', 'gnd1', 'g', [[3, 21]]),
    // flyback diode across the WHOLE coil (L + winding): cathode at the top
    // (switch side), anode at the bottom (coilB) — when the switch opens the
    // coil current recirculates through D1 instead of spiking the switch node
    wire('w6', 'd1', 'a', 'rl1', 'coilB', [[12, 13], [22, 13], [22, 11]]),
    wire('w7', 'd1', 'k', 'sw1', 'b', [[12, 13], [12, 5]]),
    // contact: 12V → com; no → lamp → gnd
    wire('w8', 'v1', 'p', 'rl1', 'com', [[3, 6], [18, 6]]),
    wire('w9', 'rl1', 'no', 'rlamp', 'a', [[22, 7], [28, 5]]),
    wire('w10', 'rlamp', 'b', 'led1', 'a', [[32, 5]]),
    wire('w11', 'led1', 'k', 'gnd1', 'g', [[38, 5], [38, 21], [3, 21]]),
    // scope on the switch node (the one that would spike unprotected)
    wire('w12', 'sw1', 'b', 'sc1', 'p', [[12, 5], [12, 15], [25, 15]]),
    wire('w13', 'sc1', 'n', 'gnd1', 'g', [[26, 15], [26, 21], [3, 21]]),
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// OP-AMP CIRCUITS
// ═══════════════════════════════════════════════════════════════════════════

// ── Op-Amp Integrator (Miller) ─────────────────────────────────────────────
// The analog computer's building block: R=10k into the virtual ground, C=100nF
// around it. A ±1V square wave integrates into a clean TRIANGLE wave — slope
// dV/dt = −Vin/(R·C) = ±1000 V/s. The 1MΩ bleed resistor across C models the
// real part's finite leakage and keeps the output from drifting to a rail
// over time (a pure integrator has no DC stability point).
const rawExOpampIntegrator: CircuitDocument = {
  version: 1,
  components: [
    comp('pulseSource', 'vin', [2, 6], 0, { high: 1, low: -1, frequency: 500, duty: 50 }),
    comp('resistor', 'rin', [8, 6], 0, { resistance: 10000 }),
    comp('opamp', 'u1', [16, 8], 0, { gain: 1e5 }),
    comp('capacitor', 'cf', [16, 2], 0, { capacitance: 1e-7 }),
    comp('resistor', 'rbleed', [22, 2], 0, { resistance: 1000000 }),
    comp('oscilloscope', 'scIn', [4, 14], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [24, 14], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 20], 0, {}),
  ],
  wires: [
    wire('w1', 'vin', 'p', 'rin', 'a'),
    wire('w2', 'rin', 'b', 'u1', 'in-'),
    wire('w3', 'vin', 'n', 'gnd1', 'g', [[3, 21]]),
    wire('w4', 'u1', 'in+', 'gnd1', 'g', [[14, 21], [3, 21]]),
    // feedback cap: out → C → in-
    wire('w5', 'u1', 'out', 'cf', 'b', [[20, 8], [20, 3]]),
    wire('w6', 'cf', 'a', 'u1', 'in-', [[18, 3], [14, 9]]),
    // bleed resistor in parallel with C
    wire('w7', 'u1', 'out', 'rbleed', 'b', [[20, 8], [20, 3], [24, 3]]),
    wire('w8', 'rbleed', 'a', 'u1', 'in-', [[26, 3], [14, 9]]),
    // scopes
    wire('w9', 'vin', 'p', 'scIn', 'p', [[3, 15]]),
    wire('w10', 'scIn', 'n', 'gnd1', 'g', [[5, 15], [5, 21]]),
    wire('w11', 'u1', 'out', 'scOut', 'p', [[20, 8], [20, 15], [25, 15]]),
    wire('w12', 'scOut', 'n', 'gnd1', 'g', [[26, 15], [26, 21], [3, 21]]),
  ],
};

// ── Sallen-Key 2nd-Order Low-Pass Filter ───────────────────────────────────
// The most-used active filter stage: unity-gain (output tied to in−)
// Sallen-Key with R1=R2=1k, C1=100nF (to output), C2=200nF (to ground) —
// a Butterworth Q=0.707, fc = 1/(2π√(R1R2C1C2)) ≈ 1.13kHz. Feed it 200Hz
// and it passes untouched; feed it 10kHz and it's attenuated ~40dB. Sweep
// the source frequency and watch the rolloff on the scopes.
const rawExSallenKey: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'vin', [2, 8], 0, { amplitude: 1, frequency: 200, offset: 0, phase: 0 }),
    comp('resistor', 'r1', [8, 6], 0, { resistance: 1000 }),
    comp('resistor', 'r2', [14, 6], 0, { resistance: 1000 }),
    comp('capacitor', 'c1', [14, 2], 0, { capacitance: 1e-7 }),
    comp('capacitor', 'c2', [20, 10], 0, { capacitance: 2e-7 }),
    comp('opamp', 'u1', [26, 6], 0, { gain: 1e5 }),
    comp('oscilloscope', 'scIn', [4, 16], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [32, 16], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 22], 0, {}),
  ],
  wires: [
    wire('w1', 'vin', 'p', 'r1', 'a', [[3, 9]]),
    wire('w2', 'r1', 'b', 'r2', 'a'),
    wire('w3', 'vin', 'n', 'gnd1', 'g', [[3, 23]]),
    // C1 from r1/r2 junction (the + input node) to OUTPUT (bootstraps the
    // corner — this is what makes it Sallen-Key rather than passive RC)
    wire('w4', 'u1', 'out', 'c1', 'b', [[30, 8], [30, 1], [16, 1]]),
    wire('w5', 'c1', 'a', 'r1', 'b', [[16, 7]]),
    // C2 from the same junction to ground... actually to in+ node? No:
    // classic SK LPF: C2 from the opamp + input to ground.
    wire('w6', 'r2', 'b', 'u1', 'in+', [[18, 7], [26, 7]]),
    wire('w7', 'c2', 'a', 'r2', 'b', [[18, 7], [18, 11]]),
    wire('w8', 'c2', 'b', 'gnd1', 'g', [[22, 23], [3, 23]]),
    // unity gain: in− tied to out
    wire('w9', 'u1', 'in-', 'u1', 'out', [[24, 23], [30, 23], [30, 8]]),
    // scopes
    wire('w10', 'vin', 'p', 'scIn', 'p', [[3, 17]]),
    wire('w11', 'scIn', 'n', 'gnd1', 'g', [[5, 17], [5, 23]]),
    wire('w12', 'u1', 'out', 'scOut', 'p', [[30, 8], [30, 17], [33, 17]]),
    wire('w13', 'scOut', 'n', 'gnd1', 'g', [[34, 17], [34, 23], [3, 23]]),
  ],
};

// ── Op-Amp Schmitt Trigger ─────────────────────────────────────────────────
// Positive feedback turns an op-amp into a hysteresis switch: the inverting
// input takes the sine; the non-inverting input sits at a fraction of the
// OUTPUT (10k from ground, 100k from out). When out = ±11.5V (±12 rails),
// the trip points sit at ±11.5·10/110 ≈ ±1.05V. A noisy sine crossing the
// threshold can't chatter — the loop must overshoot past the hysteresis
// band before the output flips back. Output: a clean square wave.
const rawExSchmitt: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'vin', [2, 6], 0, { amplitude: 2, frequency: 200, offset: 0, phase: 0 }),
    comp('opampRails', 'u1', [12, 8], 0, { gain: 1e5, railMargin: 0.5, rout: 100 }),
    comp('resistor', 'r1', [18, 4], 0, { resistance: 10000 }),
    comp('resistor', 'rf', [18, 12], 0, { resistance: 100000 }),
    comp('dcVoltage', 'vp', [8, 1], 0, { voltage: 12 }),
    comp('dcVoltage', 'vn', [8, 15], 0, { voltage: -12 }),
    comp('oscilloscope', 'scIn', [4, 20], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [26, 20], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 26], 0, {}),
  ],
  wires: [
    wire('w1', 'vin', 'p', 'u1', 'in-', [[3, 7], [12, 9]]),
    wire('w2', 'vin', 'n', 'gnd1', 'g', [[3, 27]]),
    // positive feedback divider: r1 to ground, rf from output
    wire('w3', 'u1', 'in+', 'r1', 'a', [[14, 5]]),
    wire('w4', 'r1', 'b', 'gnd1', 'g', [[22, 5], [22, 27], [3, 27]]),
    wire('w5', 'u1', 'out', 'rf', 'b', [[18, 9], [18, 13]]),
    wire('w6', 'rf', 'a', 'r1', 'a', [[18, 5], [18, 13]]),
    // power
    wire('w7', 'vp', 'p', 'u1', 'v+'),
    wire('w8', 'vn', 'p', 'u1', 'v-'),
    wire('w9', 'vp', 'n', 'gnd1', 'g', [[9, 27], [3, 27]]),
    wire('w10', 'vn', 'n', 'gnd1', 'g', [[9, 27]]),
    // scopes
    wire('w11', 'vin', 'p', 'scIn', 'p', [[3, 21]]),
    wire('w12', 'scIn', 'n', 'gnd1', 'g', [[5, 21], [5, 27]]),
    wire('w13', 'u1', 'out', 'scOut', 'p', [[16, 9], [16, 21], [27, 21]]),
    wire('w14', 'scOut', 'n', 'gnd1', 'g', [[28, 21], [28, 27], [3, 27]]),
  ],
};

// ── Op-Amp Differential Amplifier (Subtractor) ─────────────────────────────
// Four matched 10k resistors around one op-amp: Vout = V2 − V1 exactly
// (when the pairs match). This is the front-end of every sensor bridge and
// current-shunt amplifier. Two DC inputs (3V and 1V) → output 2V; flip
// either source and the output follows the difference, rejecting anything
// common to both inputs.
const rawExDiffAmp: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 2], 0, { voltage: 3 }),
    comp('dcVoltage', 'v2', [2, 10], 0, { voltage: 1 }),
    comp('opampRails', 'u1', [16, 6], 0, { gain: 1e5, railMargin: 0.5, rout: 100 }),
    comp('resistor', 'r1', [8, 2], 0, { resistance: 10000 }),
    comp('resistor', 'r2', [8, 10], 0, { resistance: 10000 }),
    comp('resistor', 'r3', [24, 2], 0, { resistance: 10000 }),
    comp('resistor', 'r4', [24, 10], 0, { resistance: 10000 }),
    comp('dcVoltage', 'vp', [10, 16], 0, { voltage: 12 }),
    comp('dcVoltage', 'vn', [10, 24], 0, { voltage: -12 }),
    comp('voltmeter', 'vm1', [30, 6], 0, {}),
    comp('ground', 'gnd1', [3, 30], 0, {}),
  ],
  wires: [
    // v1 → r1 → in-
    wire('w1', 'v1', 'p', 'r1', 'a', [[3, 3]]),
    wire('w2', 'r1', 'b', 'u1', 'in-', [[12, 3], [14, 7]]),
    wire('w3', 'v1', 'n', 'gnd1', 'g', [[3, 31]]),
    // v2 → r2 → in+
    wire('w4', 'v2', 'p', 'r2', 'a', [[3, 11]]),
    wire('w5', 'r2', 'b', 'u1', 'in+', [[12, 11], [14, 5]]),
    wire('w6', 'v2', 'n', 'gnd1', 'g', [[3, 31]]),
    // feedback: r3 out → in-; divider r4 gnd ← in+... classic: r4 from in+ to gnd
    wire('w7', 'u1', 'out', 'r3', 'a', [[20, 8], [22, 3]]),
    wire('w8', 'r3', 'b', 'u1', 'in-', [[26, 3], [26, 5], [14, 7]]),
    wire('w9', 'r4', 'a', 'u1', 'in+', [[24, 11], [14, 5]]),
    wire('w10', 'r4', 'b', 'gnd1', 'g', [[28, 31], [3, 31]]),
    // output meter
    wire('w11', 'u1', 'out', 'vm1', 'p', [[20, 8], [20, 7], [31, 7]]),
    wire('w12', 'vm1', 'n', 'gnd1', 'g', [[32, 7], [32, 31], [3, 31]]),
    // power
    wire('w13', 'vp', 'p', 'u1', 'v+'),
    wire('w14', 'vn', 'p', 'u1', 'v-'),
    wire('w15', 'vp', 'n', 'gnd1', 'g', [[11, 31], [3, 31]]),
    wire('w16', 'vn', 'n', 'gnd1', 'g', [[11, 31]]),
  ],
};

// ── Wien Bridge Oscillator ─────────────────────────────────────────────────
// THE classic sine oscillator: a frequency-selective RC bridge (R=10k,
// C=10nF → f = 1/(2πRC) ≈ 1.59kHz) feeding the + input, and a gain of ~3
// (needs to be just above 3 to start) with diode soft-limiting: the
// anti-parallel diode pair across part of Rf progressively shorts it as
// amplitude rises, dropping the loop gain to exactly 3 — the amplitude
// stabilizes itself instead of hard-clipping. C1's 0.1V initial charge
// kicks the loop (a perfectly symmetric net never starts).
const rawExWienBridge: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'vp', [2, 2], 0, { voltage: 9 }),
    comp('dcVoltage', 'vn', [2, 10], 0, { voltage: -9 }),
    comp('opampRails', 'u1', [18, 6], 0, { gain: 1e5, railMargin: 0.5, rout: 100 }),
    // Wien network
    comp('resistor', 'rs1', [8, 2], 0, { resistance: 10000 }),
    comp('capacitor', 'cs1', [8, 8], 0, { capacitance: 1e-8, initialV: 0.1 }),
    comp('resistor', 'rs2', [8, 14], 0, { resistance: 10000 }),
    comp('capacitor', 'cs2', [14, 2], 0, { capacitance: 1e-8 }),
    // gain network: rf1 + (rf2 ∥ diodes)
    comp('resistor', 'rf1', [26, 2], 0, { resistance: 20000 }),
    comp('resistor', 'rf2', [32, 2], 0, { resistance: 10000 }),
    comp('diode', 'd1', [32, 6], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('diode', 'd2', [32, 10], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('resistor', 'rg', [26, 12], 0, { resistance: 10000 }),
    comp('oscilloscope', 'sc1', [22, 18], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 26], 0, {}),
  ],
  wires: [
    // power
    wire('w1', 'vp', 'p', 'u1', 'v+'),
    wire('w2', 'vn', 'p', 'u1', 'v-'),
    wire('w3', 'vp', 'n', 'gnd1', 'g', [[3, 27]]),
    wire('w4', 'vn', 'n', 'gnd1', 'g', [[3, 8], [3, 27]]),
    // Wien network (classic): out → rs1 → cs2 → node X (series RC branch);
    // node X → rs2 ∥ cs1 → gnd (parallel branch); in+ senses node X.
    // At f₀ = 1/(2πRC) the divider V_X/V_out = 1/3 with zero phase, so the
    // amplifier needs gain 3 to oscillate.
    wire('w5', 'u1', 'out', 'rs1', 'a', [[22, 8], [8, 3]]),
    wire('w6', 'rs1', 'b', 'cs2', 'a', [[12, 3]]),               // series cap top
    wire('w7', 'cs2', 'b', 'u1', 'in+', [[16, 3], [16, 7]]),    // node X
    wire('w8', 'cs2', 'b', 'rs2', 'a', [[16, 3], [8, 15]]),
    wire('w9', 'cs2', 'b', 'cs1', 'a', [[16, 3]]),
    wire('w10', 'cs1', 'b', 'gnd1', 'g', [[12, 27], [3, 27]]),
    wire('w11', 'rs2', 'b', 'gnd1', 'g', [[12, 27], [3, 27]]),
    // gain network: in- → rg → gnd; out → rf1+rf2 → in-; diodes across rf2
    wire('w13', 'u1', 'in-', 'rg', 'a', [[22, 9], [28, 13]]),
    wire('w14', 'rg', 'b', 'gnd1', 'g', [[32, 27], [3, 27]]),
    wire('w15', 'u1', 'out', 'rf1', 'a', [[22, 8], [22, 3], [28, 3]]),
    wire('w16', 'rf1', 'b', 'rf2', 'a', [[32, 3]]),
    wire('w17', 'rf2', 'b', 'u1', 'in-', [[36, 3], [36, 9], [22, 9]]),
    wire('w18', 'd1', 'a', 'rf2', 'a', [[36, 7], [36, 3]]),
    wire('w19', 'd1', 'k', 'rf2', 'b', [[36, 7], [36, 9]]),
    wire('w20', 'd2', 'k', 'rf2', 'a', [[36, 11], [36, 3]]),
    wire('w21', 'd2', 'a', 'rf2', 'b', [[36, 11], [36, 9]]),
    // scope
    wire('w22', 'u1', 'out', 'sc1', 'p', [[22, 8], [22, 19], [23, 19]]),
    wire('w23', 'sc1', 'n', 'gnd1', 'g', [[24, 19], [24, 27], [3, 27]]),
  ],
};

// ── Precision Rectifier (Super-Diode) ──────────────────────────────────────
// An op-amp and a diode that behaves like a PERFECT diode: the feedback
// loop wraps around the diode's 0.7V drop, so the output follows the input
// down to millivolts. Positive half-cycles: the op-amp drives the diode on
// and node X (= in−) is servo'd to equal vin. Negative half-cycles: the
// output rails negative, the diode blocks, and Rload pulls the output to
// exactly 0. Compare with a plain diode rectifier: no 0.7V dead zone.
const rawExPrecisionRectifier: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'vin', [2, 6], 0, { amplitude: 2, frequency: 200, offset: 0, phase: 0 }),
    comp('opampRails', 'u1', [12, 8], 0, { gain: 1e5, railMargin: 0.5, rout: 100 }),
    comp('diode', 'd1', [16, 12], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('resistor', 'rload', [22, 8], 0, { resistance: 10000 }),
    comp('dcVoltage', 'vp', [8, 1], 0, { voltage: 9 }),
    comp('dcVoltage', 'vn', [8, 15], 0, { voltage: -9 }),
    comp('oscilloscope', 'scIn', [4, 20], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [28, 20], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [3, 26], 0, {}),
  ],
  wires: [
    // non-inverting super-diode: signal → in+; node X (=vout, =in−) follows
    wire('w1', 'vin', 'p', 'u1', 'in+', [[3, 7], [14, 7]]),
    wire('w2', 'vin', 'n', 'gnd1', 'g', [[3, 27]]),
    // diode: anode at op-amp out, cathode at node X
    wire('w3', 'u1', 'out', 'd1', 'a', [[16, 9], [16, 13]]),
    // node X = d1.k = rload top = in−  (the feedback point)
    wire('w4', 'd1', 'k', 'rload', 'a', [[18, 13], [22, 9]]),
    wire('w5', 'd1', 'k', 'u1', 'in-', [[18, 13], [18, 15], [14, 9]]),
    wire('w6', 'rload', 'b', 'gnd1', 'g', [[26, 27], [3, 27]]),
    // power
    wire('w7', 'vp', 'p', 'u1', 'v+'),
    wire('w8', 'vn', 'p', 'u1', 'v-'),
    wire('w9', 'vp', 'n', 'gnd1', 'g', [[9, 27], [3, 27]]),
    wire('w10', 'vn', 'n', 'gnd1', 'g', [[9, 27]]),
    // scopes
    wire('w11', 'vin', 'p', 'scIn', 'p', [[3, 21]]),
    wire('w12', 'scIn', 'n', 'gnd1', 'g', [[5, 21], [5, 27]]),
    wire('w13', 'rload', 'a', 'scOut', 'p', [[23, 9], [23, 21], [29, 21]]),
    wire('w14', 'scOut', 'n', 'gnd1', 'g', [[30, 21], [30, 27], [3, 27]]),
  ],
};

// ── Op-Amp Relaxation Oscillator (Triangle + Square) ───────────────────────
// One op-amp, two resistors, one cap — and BOTH classic waveforms: the
// output is a ±11.5V square (the Schmitt action of the positive-feedback
// divider R2/R3 on IN+), while the timing node at IN− is a clean
// TRIANGLE wave (the cap integrates the constant ±Vsat through R).
// Trip points sit at ±Vsat·R3/(R2+R3) ≈ ±3.7V; the period is
// 2·RC·ln((1+β)/(1−β)) with β = R3/(R2+R3). The scope shows both
// traces — the same topology powers every function generator's front end.
const rawExTriangleGen: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'vp', [2, 2], 0, { voltage: 12 }),
    comp('dcVoltage', 'vn', [2, 10], 0, { voltage: -12 }),
    comp('opampRails', 'u1', [12, 6], 0, { gain: 1e5, railMargin: 0.5, rout: 100 }),
    comp('resistor', 'r', [4, 6], 0, { resistance: 10000 }),       // timing R: out → IN−
    comp('capacitor', 'c', [4, 12], 0, { capacitance: 1e-7 }),     // IN− → gnd (triangle node)
    comp('resistor', 'r2', [18, 2], 0, { resistance: 100000 }),    // out → IN+
    comp('resistor', 'r3', [18, 12], 0, { resistance: 47000 }),    // IN+ → gnd
    comp('oscilloscope', 'scOut', [16, 16], 0, { color: '#f97316', label: 'Square' }),
    comp('oscilloscope', 'scTri', [6, 16], 0, { color: '#22d3ee', label: 'Triangle' }),
    comp('ground', 'gnd1', [3, 22], 0, {}),
  ],
  wires: [
    wire('w1', 'vp', 'p', 'u1', 'v+'),
    wire('w2', 'vn', 'p', 'u1', 'v-'),
    wire('w3', 'vp', 'n', 'gnd1', 'g', [[3, 23]]),
    wire('w4', 'vn', 'n', 'gnd1', 'g', [[3, 8], [3, 23]]),
    // timing: out → R → IN−; C from IN− to gnd
    wire('w5', 'u1', 'out', 'r', 'a', [[16, 8], [16, 7], [5, 7]]),
    wire('w6', 'r', 'b', 'u1', 'in-', [[5, 9], [12, 9]]),
    wire('w7', 'r', 'b', 'c', 'a', [[5, 13]]),
    wire('w8', 'c', 'b', 'gnd1', 'g', [[5, 23]]),
    // Schmitt divider: out → R2 → IN+; IN+ → R3 → gnd
    wire('w9', 'u1', 'out', 'r2', 'a', [[16, 8], [20, 3]]),
    wire('w10', 'r2', 'b', 'u1', 'in+', [[22, 3], [22, 5], [14, 5]]),
    wire('w11', 'r2', 'b', 'r3', 'a', [[22, 13]]),
    wire('w12', 'r3', 'b', 'gnd1', 'g', [[22, 23], [3, 23]]),
    // scopes
    wire('w13', 'u1', 'out', 'scOut', 'p', [[16, 8], [16, 17], [17, 17]]),
    wire('w14', 'scOut', 'n', 'gnd1', 'g', [[18, 17], [18, 23], [3, 23]]),
    wire('w15', 'r', 'b', 'scTri', 'p', [[5, 9], [5, 17], [7, 17]]),
    wire('w16', 'scTri', 'n', 'gnd1', 'g', [[8, 17], [8, 23], [3, 23]]),
  ],
};

// // ═══════════════════════════════════════════════════════════════════════════
// 555 TIMER CIRCUITS
// ═══════════════════════════════════════════════════════════════════════════

// ── 555 Monostable (One-Shot) ──────────────────────────────────────────────
// Press the button → the 555 fires a single output pulse of exactly
// T = 1.1·R·C = 1.1·47k·10µF ≈ 0.52s, then re-arms. The button (active-low
// on TRIG) must return HIGH before the pulse ends. RST is tied high, DIS
// unused, THR/TRIG capacitor charges through R until 2/3 VCC flips the
// internal flip-flop off. Every staircase-light timer works like this.
const rawEx555Monostable: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 4], 0, { voltage: 9 }),
    comp('ground', 'gnd1', [4, 26], 0, {}),
    comp('timer555', 'ic1', [12, 6], 0, { vcc: 9, astable: false }),
    comp('resistor', 'rt', [8, 2], 0, { resistance: 47000 }),
    comp('capacitor', 'ct', [18, 14], 0, { capacitance: 1e-5 }),
    comp('resistor', 'rtrig', [8, 10], 0, { resistance: 10000 }),
    comp('pushButton', 'btn1', [4, 14], 0, { pressed: false }),
    comp('resistor', 'rl', [24, 6], 0, { resistance: 330 }),
    comp('led', 'led1', [30, 6], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('oscilloscope', 'sc1', [22, 20], 0, { color: '#22d3ee', label: 'Out' }),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'ic1', 'vcc', [[3, 8]]),
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[3, 26]]),
    wire('w3', 'ic1', 'gnd', 'gnd1', 'g', [[12, 26]]),
    wire('w4', 'v1', 'p', 'ic1', 'rst', [[3, 9], [12, 9]]),
    // timing: VCC → Rt → THR ; C from THR to GND
    wire('w5', 'v1', 'p', 'rt', 'a', [[3, 3]]),
    wire('w6', 'rt', 'b', 'ic1', 'thr', [[12, 3], [12, 11]]),
    wire('w7', 'ic1', 'thr', 'ct', 'a', [[12, 11], [18, 15]]),
    wire('w8', 'ct', 'b', 'gnd1', 'g', [[22, 27], [4, 27]]),
    // trigger: pull-up R to VCC; button shorts TRIG to GND
    wire('w9', 'v1', 'p', 'rtrig', 'a', [[3, 5], [9, 11]]),
    wire('w10', 'rtrig', 'b', 'ic1', 'trig', [[12, 11], [12, 8]]),
    wire('w11', 'rtrig', 'b', 'btn1', 'a', [[12, 8], [5, 15]]),
    wire('w12', 'btn1', 'b', 'gnd1', 'g', [[5, 27], [4, 27]]),
    // output: LED pulse
    wire('w13', 'ic1', 'out', 'rl', 'a', [[18, 7], [24, 7]]),
    wire('w14', 'rl', 'b', 'led1', 'a', [[28, 7]]),
    wire('w15', 'led1', 'k', 'gnd1', 'g', [[34, 7], [34, 27], [4, 27]]),
    // scope
    wire('w16', 'ic1', 'out', 'sc1', 'p', [[18, 7], [18, 21], [23, 21]]),
    wire('w17', 'sc1', 'n', 'gnd1', 'g', [[24, 21], [24, 27], [4, 27]]),
  ],
};

// ── 555 PWM LED Dimmer ─────────────────────────────────────────────────────
// The classic diode-steered 555 PWM: the potentiometer's upper half charges
// the timing cap through D1, its lower half (through D2) discharges it into
// the DIS pin. Moving the wiper trades charge resistance against discharge
// resistance, so the FREQUENCY stays ~fixed while the DUTY CYCLE swings
// from ~10% to ~90% — dimming the LED. Set the wiper parameter and watch
// the scope: same period, different on-time.
const rawEx555Pwm: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 4], 0, { voltage: 9 }),
    comp('ground', 'gnd1', [4, 24], 0, {}),
    comp('timer555', 'ic1', [16, 8], 0, { vcc: 9, astable: false }),
    comp('potentiometer', 'pot1', [8, 2], 0, { resistance: 100000, wiper: 25 }),
    comp('diode', 'd1', [12, 2], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('diode', 'd2', [12, 12], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('capacitor', 'ct', [22, 16], 0, { capacitance: 1e-6 }),
    comp('resistor', 'rl', [26, 6], 0, { resistance: 330 }),
    comp('led', 'led1', [32, 6], 0, { color: 'green', forwardV: 2.0, seriesR: 1 }),
    comp('oscilloscope', 'sc1', [26, 20], 0, { color: '#22d3ee', label: 'Out' }),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'ic1', 'vcc', [[3, 9]]),
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[3, 24]]),
    wire('w3', 'ic1', 'gnd', 'gnd1', 'g', [[16, 24]]),
    wire('w4', 'v1', 'p', 'ic1', 'rst', [[3, 10], [16, 10]]),
    // pot across VCC... a → VCC? No: pot a to DIS (b to DIS): classic wiring is
    // a → VCC, b → DIS, wiper → D1/D2 junction feeding the cap.
    // pot: END b → VCC, END a → DIS, wiper steers the two diodes.
    // (b→w section charges through D1; w→a section discharges into DIS
    // through D2 — this orientation keeps the wiper BELOW the cap during
    // discharge so D2 actually conducts; the reverse wiring stalls with the
    // cap stuck just under the THR threshold.)
    wire('w5', 'v1', 'p', 'pot1', 'b', [[3, 3], [12, 3]]),
    wire('w6', 'pot1', 'a', 'ic1', 'dis', [[5, 3], [5, 13], [22, 13], [22, 11]]),
    // charge path: wiper → D1 → cap node
    wire('w7', 'pot1', 'w', 'd1', 'a', [[10, 3], [13, 3]]),
    wire('w8', 'd1', 'k', 'ct', 'a', [[13, 17], [22, 17]]),
    // discharge path: cap node → D2 → wiper (then through lower pot half to DIS)
    wire('w9', 'ct', 'a', 'd2', 'a', [[22, 17], [22, 13], [13, 13]]),
    wire('w10', 'd2', 'k', 'pot1', 'w', [[13, 13], [13, 3], [10, 3]]),
    // THR + TRIG tied to the cap node
    wire('w11', 'ct', 'a', 'ic1', 'thr', [[22, 17], [22, 19], [16, 19], [16, 13]]),
    wire('w12', 'ic1', 'thr', 'ic1', 'trig', [[16, 13], [16, 10]]),
    wire('w13', 'ct', 'b', 'gnd1', 'g', [[26, 27], [4, 27]]),
    // output
    wire('w14', 'ic1', 'out', 'rl', 'a', [[22, 9], [26, 9]]),
    wire('w15', 'rl', 'b', 'led1', 'a', [[30, 9]]),
    wire('w16', 'led1', 'k', 'gnd1', 'g', [[36, 9], [36, 27], [4, 27]]),
    // scope
    wire('w17', 'ic1', 'out', 'sc1', 'p', [[22, 9], [22, 21], [27, 21]]),
    wire('w18', 'sc1', 'n', 'gnd1', 'g', [[28, 21], [28, 27], [4, 27]]),
  ],
};

// ── 555 Tone Generator (audio) ─────────────────────────────────────────────
// The same astable core at audio frequency (R1=4.7k, R2=15k, C=100nF →
// ~420Hz, close to concert A) driving a speaker through a current-limiting
// resistor. Enable the speaker icon in the status bar — the audio engine
// tracks the output's zero crossings, so the speaker actually TONES. The
// scope shows the classic 555 output duty: (R1+R2)/(R1+2R2) ≈ 58%.
const rawEx555Tone: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 4], 0, { voltage: 9 }),
    comp('ground', 'gnd1', [4, 22], 0, {}),
    comp('timer555', 'ic1', [12, 6], 0, { vcc: 9, astable: false }),
    comp('resistor', 'ra', [8, 2], 0, { resistance: 4700 }),
    comp('resistor', 'rb', [20, 2], 0, { resistance: 15000 }),
    comp('capacitor', 'c1', [20, 14], 0, { capacitance: 1e-7 }),
    comp('resistor', 'rs', [26, 6], 0, { resistance: 150 }),
    comp('speaker', 'spk1', [32, 8], 0, { impedance: 8 }),
    comp('oscilloscope', 'sc1', [26, 18], 0, { color: '#22d3ee', label: 'Out' }),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'ic1', 'vcc', [[3, 8]]),
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[3, 22]]),
    wire('w3', 'ic1', 'gnd', 'gnd1', 'g', [[12, 22]]),
    wire('w4', 'v1', 'p', 'ic1', 'rst', [[3, 9], [12, 9]]),
    wire('w5', 'v1', 'p', 'ra', 'a', [[3, 3]]),
    wire('w6', 'ra', 'b', 'ic1', 'dis', [[12, 3]]),
    wire('w7', 'ic1', 'dis', 'rb', 'a', [[18, 3], [20, 3]]),
    wire('w8', 'rb', 'b', 'ic1', 'thr', [[24, 3], [24, 11], [12, 11]]),
    wire('w9', 'ic1', 'thr', 'ic1', 'trig', [[12, 11], [12, 8]]),
    wire('w10', 'ic1', 'thr', 'c1', 'a', [[12, 11], [20, 15]]),
    wire('w11', 'c1', 'b', 'gnd1', 'g', [[24, 23], [4, 23]]),
    wire('w12', 'ic1', 'out', 'rs', 'a', [[18, 7], [26, 7]]),
    wire('w13', 'rs', 'b', 'spk1', 'a', [[30, 9]]),
    wire('w14', 'spk1', 'b', 'gnd1', 'g', [[36, 9], [36, 23], [4, 23]]),
    wire('w15', 'ic1', 'out', 'sc1', 'p', [[18, 7], [18, 19], [27, 19]]),
    wire('w16', 'sc1', 'n', 'gnd1', 'g', [[28, 19], [28, 23], [4, 23]]),
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// POWER SUPPLIES
// ═══════════════════════════════════════════════════════════════════════════

// ── Full-Wave Bridge Rectifier + Zener-Regulated Supply ────────────────────
// A complete linear power supply front-end: 12V AC (50Hz) → 4-diode bridge
// → 470µF smoothing cap → 220Ω series R → 5.1V zener shunt regulator → 1k
// load. The bridge output on the scope shows the classic full-wave humps
// (100Hz ripple) riding ~1V below the peak; after the zener the rail is
// flat 5.1V. Each diode pair conducts on alternate half-cycles — follow the
// animated current: it reverses through the transformer, always the same
// direction through the load.
const rawExBridgeSupply: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'vac', [2, 6], 0, { amplitude: 12, frequency: 50, offset: 0, phase: 0 }),
    comp('diode', 'd1', [10, 2], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('diode', 'd2', [10, 12], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('diode', 'd3', [16, 6], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('diode', 'd4', [16, 12], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('capacitor', 'cs', [22, 6], 0, { capacitance: 4.7e-4 }),
    comp('resistor', 'rs', [28, 4], 0, { resistance: 220 }),
    comp('zener', 'dz', [34, 8], 0, { zenerV: 5.1, forwardV: 0.7, onR: 5, offR: 1e7 }),
    comp('resistor', 'rl', [40, 4], 0, { resistance: 1000 }),
    comp('oscilloscope', 'sc1', [24, 16], 0, { color: '#f97316', label: 'Bridge' }),
    comp('oscilloscope', 'sc2', [38, 16], 0, { color: '#22d3ee', label: 'Reg' }),
    comp('ground', 'gnd1', [3, 24], 0, {}),
  ],
  wires: [
    // Bridge topology — neither AC node is grounded:
    //   X (vac.p) → D1 → P (+) ; Y (vac.n) → D2 → P
    //   N (gnd)  → D3 → X    ; N → D4 → Y
    // X positive: current X→D1→P→load→N→D4→Y. Y positive: Y→D2→P→load→N→D3→X.
    wire('w1', 'vac', 'p', 'd1', 'a', [[3, 7], [10, 3]]),
    wire('w2', 'vac', 'n', 'd2', 'a', [[3, 13], [10, 13]]),
    wire('w3', 'vac', 'n', 'd4', 'k', [[3, 13], [17, 13]]),
    wire('w4', 'd1', 'k', 'd2', 'k', [[14, 3], [14, 13]]),
    wire('w5', 'd1', 'k', 'cs', 'a', [[14, 3], [22, 7]]),
    wire('w6', 'd3', 'k', 'vac', 'p', [[17, 7], [17, 3], [3, 7]]),
    wire('w7', 'd3', 'a', 'gnd1', 'g', [[16, 25], [3, 25]]),
    wire('w8', 'd4', 'a', 'gnd1', 'g', [[16, 25], [3, 25]]),
    // smoothing cap across P-N
    wire('w9', 'cs', 'b', 'gnd1', 'g', [[26, 25], [3, 25]]),
    // series R to zener node
    wire('w10', 'cs', 'a', 'rs', 'a', [[22, 7], [28, 5]]),
    wire('w11', 'rs', 'b', 'dz', 'k', [[32, 5], [34, 9]]),
    wire('w12', 'rs', 'b', 'rl', 'a', [[32, 5], [40, 5]]),
    wire('w13', 'dz', 'a', 'gnd1', 'g', [[38, 25], [3, 25]]),
    wire('w14', 'rl', 'b', 'gnd1', 'g', [[44, 25], [3, 25]]),
    // scopes
    wire('w15', 'cs', 'a', 'sc1', 'p', [[22, 7], [22, 17], [25, 17]]),
    wire('w16', 'sc1', 'n', 'gnd1', 'g', [[26, 17], [26, 25], [3, 25]]),
    wire('w17', 'dz', 'k', 'sc2', 'p', [[34, 9], [34, 17], [39, 17]]),
    wire('w18', 'sc2', 'n', 'gnd1', 'g', [[40, 17], [40, 25], [3, 25]]),
  ],
};

// ── Voltage Doubler (Greinacher) ───────────────────────────────────────────
// Two diodes, two caps, double the voltage: C1 couples the AC source to
// node A; D2 clamps node A's negative swings at −0.7V (charging C1 to the
// peak); on positive half-cycles node A then rides UP to ≈ +2·Vp, and D1
// pumps that into the reservoir C2. Output ≈ 2·Vp − 2·Vf ≈ 10.6V from a 6V
// amplitude source. Follow the animated current through the charge/discharge
// phases — energy flows in pulses, twice per cycle.
const rawExVoltageDoubler: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'vin', [2, 6], 0, { amplitude: 6, frequency: 50, offset: 0, phase: 0 }),
    comp('capacitor', 'c1', [8, 6], 0, { capacitance: 1e-4 }),
    comp('diode', 'd1', [14, 6], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('diode', 'd2', [14, 12], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('capacitor', 'c2', [20, 8], 0, { capacitance: 1e-4 }),
    comp('resistor', 'rl', [26, 6], 0, { resistance: 10000 }),
    comp('voltmeter', 'vm1', [26, 12], 0, {}),
    comp('ground', 'gnd1', [3, 20], 0, {}),
  ],
  wires: [
    // AC → C1 → node A
    wire('w1', 'vin', 'p', 'c1', 'a', [[3, 7], [8, 7]]),
    wire('w2', 'c1', 'b', 'd1', 'a', [[12, 7], [13, 7]]),        // node A
    // clamp diode: node A negative swings → GND (anode at gnd, cathode at A)
    wire('w3', 'vin', 'n', 'd2', 'a', [[3, 19], [13, 13]]),      // d2.a to ground net
    wire('w4', 'd2', 'k', 'd1', 'a', [[13, 13], [13, 7]]),       // d2.k at node A
    // pump diode: node A → D1 → reservoir node B
    wire('w5', 'd1', 'k', 'c2', 'a', [[17, 7], [20, 9]]),        // node B
    wire('w6', 'c2', 'b', 'gnd1', 'g', [[24, 21], [3, 21]]),
    wire('w7', 'vin', 'n', 'gnd1', 'g', [[3, 21]]),
    // load + meter across C2
    wire('w8', 'c2', 'a', 'rl', 'a', [[24, 7], [26, 7]]),
    wire('w9', 'rl', 'b', 'gnd1', 'g', [[30, 21], [3, 21]]),
    wire('w10', 'c2', 'a', 'vm1', 'p', [[24, 9], [24, 13]]),
    wire('w11', 'vm1', 'n', 'gnd1', 'g', [[27, 21], [3, 21]]),
  ],
};

// ── Zener Shunt Regulator with Load ────────────────────────────────────────
// 12V raw input → 220Ω series resistor → 5.1V zener (cathode to the
// regulated node) → 1k load. The zener absorbs whatever current the load
// doesn't take: at 12V in, the load draws 5.1mA and the zener ≈ 28mA.
// Raise the input to 20V or halve the load — the output barely moves (the
// zener's dynamic impedance is onR = 5Ω). Ammeter shows the zener branch
// current.
const rawExZenerRegulator: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 4], 0, { voltage: 12 }),
    comp('resistor', 'rs', [8, 4], 0, { resistance: 220 }),
    comp('zener', 'dz', [14, 6], 0, { zenerV: 5.1, forwardV: 0.7, onR: 5, offR: 1e7 }),
    comp('resistor', 'rl', [20, 4], 0, { resistance: 1000 }),
    comp('ammeter', 'am1', [14, 12], 0, {}),
    comp('voltmeter', 'vm1', [20, 12], 0, {}),
    comp('ground', 'gnd1', [3, 20], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'rs', 'a', [[3, 5], [8, 5]]),
    wire('w2', 'rs', 'b', 'dz', 'k', [[12, 5], [14, 5]]),
    wire('w3', 'rs', 'b', 'rl', 'a', [[12, 5], [20, 5]]),
    wire('w4', 'dz', 'a', 'am1', 'p', [[14, 7], [14, 13]]),
    wire('w5', 'am1', 'n', 'gnd1', 'g', [[15, 21], [3, 21]]),
    wire('w6', 'rl', 'b', 'gnd1', 'g', [[24, 21], [3, 21]]),
    wire('w7', 'v1', 'n', 'gnd1', 'g', [[3, 21]]),
    wire('w8', 'rs', 'b', 'vm1', 'p', [[12, 5], [12, 13], [20, 13]]),
    wire('w9', 'vm1', 'n', 'gnd1', 'g', [[21, 21], [3, 21]]),
  ],
};

// ── Inductive Kickback + Flyback Clamp ─────────────────────────────────────
// The physics every relay driver respects: an inductor's current CANNOT
// change instantly. Close the switch — current builds slowly (τ = L/R =
// 10ms). OPEN it — the coil fights back with V = −L·di/dt: the scope shows
// the switch node spiking to thousands of volts for a few microseconds
// (enough to weld contacts / kill transistors). This is the "without
// protection" version; see the Relay Driver example for the diode clamp.
const rawExInductorKickback: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 4], 0, { voltage: 12 }),
    comp('switch', 'sw1', [8, 4], 0, { closed: true }),
    comp('inductor', 'l1', [14, 4], 0, { inductance: 0.1 }),
    comp('resistor', 'r1', [14, 10], 0, { resistance: 10 }),
    comp('oscilloscope', 'sc1', [10, 16], 0, { color: '#22d3ee', label: 'Switch' }),
    comp('ground', 'gnd1', [3, 22], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'sw1', 'a', [[3, 5], [8, 5]]),
    wire('w2', 'sw1', 'b', 'l1', 'a', [[12, 5], [14, 5]]),
    wire('w3', 'l1', 'b', 'r1', 'a', [[18, 5], [18, 11]]),
    wire('w4', 'r1', 'b', 'gnd1', 'g', [[18, 23], [3, 23]]),
    wire('w5', 'v1', 'n', 'gnd1', 'g', [[3, 23]]),
    wire('w6', 'sw1', 'b', 'sc1', 'p', [[12, 5], [12, 17], [11, 17]]),
    wire('w7', 'sc1', 'n', 'gnd1', 'g', [[12, 17], [12, 23], [3, 23]]),
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// DIGITAL LOGIC (built from gates, Falstad-style)
// ═══════════════════════════════════════════════════════════════════════════

// ── NAND SR Latch (memory from two gates) ──────────────────────────────────
// The original 1-bit memory cell: two cross-coupled NANDs. Inputs are
// active-LOW (buttons short the input to ground; 10k pull-ups hold them
// HIGH when released). Press SET → Q latches HIGH; release → Q STAYS high
// (the feedback holds it). Press RESET → Q drops. Press both → invalid
// state (Q = Q̄ — the forbidden row of the truth table). This is the
// circuit inside every SRAM cell and flip-flop ever made.
const rawExSrLatch: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [22, 1], 0, { voltage: 5 }),
    comp('resistor', 'prs', [2, 1], 0, { resistance: 10000 }),
    comp('resistor', 'prr', [2, 15], 0, { resistance: 10000 }),
    comp('pushButton', 's1', [5, 4], 0, { pressed: false }),
    comp('pushButton', 'r1', [5, 12], 0, { pressed: false }),
    comp('nand', 'g1', [12, 2], 0, { vcc: 5, threshold: 2.5 }),
    comp('nand', 'g2', [12, 10], 0, { vcc: 5, threshold: 2.5 }),
    comp('resistor', 'rq', [20, 2], 0, { resistance: 330 }),
    comp('led', 'ledq', [26, 2], 0, { color: '#22c55e', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [22, 22], 0, {}),
  ],
  wires: [
    // pull-ups: VCC → R → input node
    wire('w1', 'v1', 'p', 'prs', 'a', [[23, 2], [3, 2]]),
    wire('w2', 'prs', 'b', 's1', 'b', [[7, 2], [7, 5]]),
    wire('w2b', 'prs', 'b', 'g1', 'a', [[7, 2], [9, 3]]),
    wire('w3', 'v1', 'p', 'prr', 'a', [[23, 2], [3, 16]]),
    wire('w4', 'prr', 'b', 'r1', 'b', [[7, 16], [7, 13]]),
    wire('w4b', 'prr', 'b', 'g2', 'a', [[7, 16], [9, 11]]),
    // buttons to GND (active-low)
    wire('w5', 's1', 'a', 'gnd1', 'g', [[6, 23], [22, 23]]),
    wire('w6', 'r1', 'a', 'gnd1', 'g', [[6, 23], [22, 23]]),
    // cross-coupling: g1.y → g2.b ; g2.y → g1.b
    wire('w7', 'g1', 'y', 'g2', 'b', [[16, 3], [16, 11]]),
    wire('w8', 'g2', 'y', 'g1', 'b', [[16, 11], [16, 3]]),
    // power & ground pins
    wire('w9', 'v1', 'p', 'g1', 'vcc'),
    wire('w10', 'v1', 'p', 'g2', 'vcc'),
    wire('w11', 'g1', 'gnd', 'gnd1', 'g', [[14, 23], [22, 23]]),
    wire('w12', 'g2', 'gnd', 'gnd1', 'g', [[14, 23], [22, 23]]),
    wire('w13', 'v1', 'n', 'gnd1', 'g', [[22, 23]]),
    // Q output LED
    wire('w14', 'g1', 'y', 'rq', 'a', [[16, 3], [20, 3]]),
    wire('w15', 'rq', 'b', 'ledq', 'a', [[24, 3]]),
    wire('w16', 'ledq', 'k', 'gnd1', 'g', [[30, 3], [30, 23], [22, 23]]),
  ],
};

// ── Divide-by-4 Counter (D Flip-Flops) ─────────────────────────────────────
// Two edge-triggered D flip-flops (the behavioral dff plugin) wired as
// toggle stages (Q̅ fed back to D)
// and cascaded: the 1Hz clock toggles the first flop, whose Q output clocks
// the second — each stage divides by 2, so the LEDs count 00 → 01 → 10
// → 11 at one step per second. This is bit [1:0] of every binary counter
// ever built; add more stages the same way for 8, 16... 256 counts.
const rawExDffCounter: CircuitDocument = {
  version: 1,
  components: [
    comp('pulseSource', 'clk1', [2, 6], 0, { high: 5, low: 0, frequency: 1, duty: 50 }),
    comp('dff', 'ff1', [12, 4], 0, { initialState: false }),
    comp('dff', 'ff2', [26, 4], 0, { initialState: false }),
    comp('resistor', 'rq1', [20, 2], 0, { resistance: 330 }),
    comp('led', 'led1', [20, 8], 0, { color: '#22c55e', forwardV: 2.0, seriesR: 1 }),
    comp('resistor', 'rq2', [34, 2], 0, { resistance: 330 }),
    comp('led', 'led2', [34, 8], 0, { color: '#f97316', forwardV: 2.0, seriesR: 1 }),
    comp('oscilloscope', 'sc1', [12, 16], 0, { color: '#22d3ee', label: 'Q0' }),
    comp('oscilloscope', 'sc2', [26, 20], 0, { color: '#f97316', label: 'Q1' }),
    comp('ground', 'gnd1', [3, 24], 0, {}),
  ],
  wires: [
    // clock into stage 1
    wire('w1', 'clk1', 'p', 'ff1', 'clk', [[3, 7], [9, 7]]),
    wire('w2', 'clk1', 'n', 'gnd1', 'g', [[3, 25]]),
    // toggle wiring: Q̅ of each stage drives its own D
    wire('w3', 'ff1', 'qbar', 'ff1', 'd', [[14, 9], [14, 15], [9, 15], [9, 5]]),
    wire('w4', 'ff2', 'qbar', 'ff2', 'd', [[28, 9], [28, 15], [23, 15], [23, 5]]),
    // cascade: Q1 (first stage) clocks the second stage
    wire('w5', 'ff1', 'q', 'ff2', 'clk', [[18, 5], [23, 7]]),
    // LED on Q0 (bit 0)
    wire('w6', 'ff1', 'q', 'rq1', 'a', [[18, 5], [18, 3]]),
    wire('w7', 'rq1', 'b', 'led1', 'a', [[22, 9]]),
    wire('w8', 'led1', 'k', 'gnd1', 'g', [[24, 25], [3, 25]]),
    // LED on Q1 (bit 1)
    wire('w9', 'ff2', 'q', 'rq2', 'a', [[32, 5], [32, 3]]),
    wire('w10', 'rq2', 'b', 'led2', 'a', [[36, 9]]),
    wire('w11', 'led2', 'k', 'gnd1', 'g', [[38, 25], [3, 25]]),
    // scopes on both Q outputs
    wire('w14', 'ff1', 'q', 'sc1', 'p', [[18, 5], [18, 17], [13, 17]]),
    wire('w15', 'sc1', 'n', 'gnd1', 'g', [[14, 17], [14, 25], [3, 25]]),
    wire('w16', 'ff2', 'q', 'sc2', 'p', [[32, 5], [32, 21], [27, 21]]),
    wire('w17', 'sc2', 'n', 'gnd1', 'g', [[28, 21], [28, 25], [3, 25]]),
  ],
};

// ── Half Adder (XOR + AND) ─────────────────────────────────────────────────
// One bit of binary addition, from scratch: SUM = A XOR B, CARRY = A AND B.
// Press the two buttons (active-HIGH: pressed connects the input to +5V,
// released floats LOW via the gates' internal pull-downs) and try all four
// combinations: 0+0=00, 1+0=01, 0+1=01, 1+1=10 (carry!). Chain a second
// half adder with an OR gate and you have a full adder — stack eight of
// those for an 8-bit ALU.
const rawExHalfAdder: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 1], 0, { voltage: 5 }),
    comp('pushButton', 'btna', [8, 4], 0, { pressed: false }),
    comp('pushButton', 'btnb', [8, 12], 0, { pressed: false }),
    comp('xor', 'gx', [16, 2], 0, { vcc: 5, threshold: 2.5 }),
    comp('and', 'ga', [16, 10], 0, { vcc: 5, threshold: 2.5 }),
    comp('resistor', 'rs', [24, 2], 0, { resistance: 330 }),
    comp('resistor', 'rc', [24, 10], 0, { resistance: 330 }),
    comp('led', 'leds', [30, 2], 0, { color: '#22c55e', forwardV: 2.0, seriesR: 1 }),
    comp('led', 'ledc', [30, 10], 0, { color: '#f97316', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [5, 20], 0, {}),
  ],
  wires: [
    // buttons: unpressed end floats LOW (gate pull-downs); pressed connects to VCC
    wire('w1', 'v1', 'p', 'btna', 'a', [[5, 2], [5, 5]]),
    wire('w2', 'v1', 'p', 'btnb', 'a', [[5, 3], [5, 13]]),
    // A input drives gx.a and ga.a; B drives gx.b and ga.b
    wire('w3', 'btna', 'b', 'gx', 'a', [[9, 5], [13, 3]]),
    wire('w4', 'btna', 'b', 'ga', 'a', [[9, 5], [9, 11], [13, 11]]),
    wire('w5', 'btnb', 'b', 'gx', 'b', [[9, 13], [9, 4], [13, 4]]),
    wire('w6', 'btnb', 'b', 'ga', 'b', [[9, 13], [13, 12]]),
    // outputs: SUM (XOR) and CARRY (AND)
    wire('w7', 'gx', 'y', 'rs', 'a', [[20, 3], [24, 3]]),
    wire('w8', 'rs', 'b', 'leds', 'a', [[28, 3]]),
    wire('w9', 'leds', 'k', 'gnd1', 'g', [[34, 3], [34, 21], [5, 21]]),
    wire('w10', 'ga', 'y', 'rc', 'a', [[20, 11], [24, 11]]),
    wire('w11', 'rc', 'b', 'ledc', 'a', [[28, 11]]),
    wire('w12', 'ledc', 'k', 'gnd1', 'g', [[34, 11], [34, 21], [5, 21]]),
    wire('w13', 'v1', 'n', 'gnd1', 'g', [[5, 21]]),
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// MEASUREMENT & BRIDGES
// ═══════════════════════════════════════════════════════════════════════════

// ── Wheatstone Bridge ──────────────────────────────────────────────────────
// The precision measurement circuit: two voltage dividers, and a meter
// between their midpoints. With R1=R2=R3=R4 the bridge is BALANCED and the
// voltmeter reads exactly 0.000V. Change R4 (press the edit icon) to 1.2k
// and the imbalance reads −0.227V — a 0.003% resistance change on one leg
// would still show measurable voltage. Every strain gauge, load cell, and
// thermometer front-end is this circuit.
const rawExWheatstone: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 4], 0, { voltage: 5 }),
    comp('resistor', 'r1', [8, 2], 0, { resistance: 1000 }),
    comp('resistor', 'r2', [8, 10], 0, { resistance: 1000 }),
    comp('resistor', 'r3', [16, 2], 0, { resistance: 1000 }),
    comp('resistor', 'r4', [16, 10], 0, { resistance: 1000 }),
    comp('voltmeter', 'vm', [12, 6], 0, {}),
    comp('ammeter', 'am1', [2, 12], 0, {}),
    comp('ground', 'gnd1', [3, 18], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'am1', 'p', [[3, 5]]),
    wire('w2', 'am1', 'n', 'r1', 'a', [[3, 13], [3, 3], [8, 3]]),
    wire('w3', 'am1', 'n', 'r2', 'a', [[3, 13], [3, 11], [8, 11]]),
    wire('w4', 'r1', 'b', 'r3', 'a', [[12, 3], [12, 3]]),
    wire('w5', 'r2', 'b', 'r4', 'a', [[12, 11], [12, 11]]),
    wire('w6', 'r3', 'b', 'gnd1', 'g', [[18, 19], [3, 19]]),
    wire('w7', 'r4', 'b', 'gnd1', 'g', [[18, 19]]),
    wire('w8', 'r1', 'b', 'vm', 'p', [[10, 3], [10, 7]]),
    wire('w9', 'r4', 'a', 'vm', 'n', [[10, 11], [10, 7]]),
    wire('w10', 'v1', 'n', 'gnd1', 'g', [[3, 19]]),
  ],
};

// ── R-2R Ladder DAC (4-bit) ────────────────────────────────────────────────
// Digital to analog the elegant way: a chain of R (10k) and 2R (20k) that
// makes each successive bit contribute exactly half the previous bit's
// voltage. Each bit's 2R leg connects to +5V (bit=1) or GND (bit=0)
// through complementary switches — toggle them and watch the output:
// 0001 = 0.3125V, 0011 = 0.9375V, 1011 = 3.4375V, 1111 = 4.6875V.
// Vout = 5V · (Σ bit·2ⁿ)/16. Every multiplying DAC works on exactly this
// ladder (with transmission gates instead of switches).
const rawExR2rDac: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [2, 12], 0, { voltage: 5 }),
    comp('ground', 'gnd1', [2, 26], 0, {}),
    // bit switches: bh = leg to +5V, bl = leg to GND (complementary)
    comp('switch', 'b3h', [6, 2], 0, { closed: true }),
    comp('switch', 'b3l', [6, 5], 0, { closed: false }),
    comp('switch', 'b2h', [6, 7], 0, { closed: false }),
    comp('switch', 'b2l', [6, 10], 0, { closed: true }),
    comp('switch', 'b1h', [6, 12], 0, { closed: true }),
    comp('switch', 'b1l', [6, 15], 0, { closed: false }),
    comp('switch', 'b0h', [6, 17], 0, { closed: true }),
    comp('switch', 'b0l', [6, 20], 0, { closed: false }),
    // 2R legs
    comp('resistor', 's3', [12, 3], 0, { resistance: 20000 }),
    comp('resistor', 's2', [12, 8], 0, { resistance: 20000 }),
    comp('resistor', 's1', [12, 13], 0, { resistance: 20000 }),
    comp('resistor', 's0', [12, 18], 0, { resistance: 20000 }),
    // series R rungs
    comp('resistor', 'r1', [18, 3], 0, { resistance: 10000 }),
    comp('resistor', 'r2', [18, 8], 0, { resistance: 10000 }),
    comp('resistor', 'r3', [18, 13], 0, { resistance: 10000 }),
    // terminating 2R
    comp('resistor', 'r4', [18, 18], 0, { resistance: 20000 }),
    comp('voltmeter', 'vm', [24, 13], 0, {}),
  ],
  wires: [
    // VCC rail to all "high" switches
    wire('w1', 'v1', 'p', 'b3h', 'a', [[3, 13], [3, 3], [5, 3]]),
    wire('w2', 'v1', 'p', 'b2h', 'a', [[3, 13], [3, 8], [5, 8]]),
    wire('w3', 'v1', 'p', 'b1h', 'a', [[3, 13], [3, 13], [5, 13]]),
    wire('w4', 'v1', 'p', 'b0h', 'a', [[3, 13], [3, 18], [5, 18]]),
    // GND rail to all "low" switches
    wire('w5', 'v1', 'n', 'gnd1', 'g', [[3, 27]]),
    wire('w6', 'b3l', 'a', 'gnd1', 'g', [[5, 6], [3, 6], [3, 27]]),
    wire('w7', 'b2l', 'a', 'gnd1', 'g', [[5, 11], [3, 11], [3, 27]]),
    wire('w8', 'b1l', 'a', 'gnd1', 'g', [[5, 16], [3, 16], [3, 27]]),
    wire('w9', 'b0l', 'a', 'gnd1', 'g', [[5, 21], [3, 21], [3, 27]]),
    // each bit's complementary pair drives its 2R leg
    wire('w10', 'b3h', 'b', 's3', 'a', [[10, 4]]),
    wire('w11', 'b3l', 'b', 's3', 'a', [[10, 6], [10, 4]]),
    wire('w12', 'b2h', 'b', 's2', 'a', [[10, 9]]),
    wire('w13', 'b2l', 'b', 's2', 'a', [[10, 11], [10, 9]]),
    wire('w14', 'b1h', 'b', 's1', 'a', [[10, 14]]),
    wire('w15', 'b1l', 'b', 's1', 'a', [[10, 16], [10, 14]]),
    wire('w16', 'b0h', 'b', 's0', 'a', [[10, 19]]),
    wire('w17', 'b0l', 'b', 's0', 'a', [[10, 21], [10, 19]]),
    // ladder rungs — each node joins the LADDER end (sN.b) of its 2R leg and
    // the next series R; the SWITCH end (sN.a) goes to the bit switches.
    // N3 = s3.b = r1.a ; N2 = r1.b = s2.b = r2.a ; N1 = r2.b = s1.b = r3.a ;
    // N0 (out) = r3.b = s0.b = r4.a.
    wire('w18', 's3', 'b', 'r1', 'a', [[16, 4]]),
    wire('w19', 'r1', 'b', 's2', 'b', [[22, 4], [22, 9]]),
    wire('w20', 's2', 'b', 'r2', 'a', [[16, 9]]),
    wire('w21', 'r2', 'b', 's1', 'b', [[22, 9], [22, 14]]),
    wire('w22', 's1', 'b', 'r3', 'a', [[16, 14]]),
    wire('w23', 'r3', 'b', 's0', 'b', [[22, 14], [22, 19]]),
    wire('w24', 's0', 'b', 'r4', 'a', [[16, 19]]),
    wire('w25', 'r4', 'b', 'gnd1', 'g', [[22, 27], [3, 27]]),
    // output = the MSB node (top of the ladder — the far end from the
    // terminating 2R; tapping the LSB end instead INVERTS the bit weighting)
    wire('w26', 'r1', 'a', 'vm', 'p', [[16, 4], [25, 14]]),
    wire('w27', 'vm', 'n', 'gnd1', 'g', [[25, 27], [3, 27]]),
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export const rawComplexExamples = {
  // transistors
  ceAmplifier: rawExCeAmplifier,
  pushPull: rawExPushPull,
  phaseShiftOscillator: rawExPhaseShiftOscillator,
  currentMirror: rawExCurrentMirror,
  emitterFollower: rawExEmitterFollower,
  relayFlyback: rawExRelayFlyback,
  // op-amps
  opampIntegrator: rawExOpampIntegrator,
  triangleGen: rawExTriangleGen,
  sallenKey: rawExSallenKey,
  schmitt: rawExSchmitt,
  diffAmp: rawExDiffAmp,
  wienBridge: rawExWienBridge,
  precisionRectifier: rawExPrecisionRectifier,
  // 555 timers
  monostable555: rawEx555Monostable,
  pwm555: rawEx555Pwm,
  tone555: rawEx555Tone,
  // power supplies
  bridgeSupply: rawExBridgeSupply,
  voltageDoubler: rawExVoltageDoubler,
  zenerRegulator: rawExZenerRegulator,
  inductorKickback: rawExInductorKickback,
  // digital
  srLatch: rawExSrLatch,
  dffCounter: rawExDffCounter,
  halfAdder: rawExHalfAdder,
  // measurement
  wheatstone: rawExWheatstone,
  r2rDac: rawExR2rDac,
} as const;

export type ComplexExampleKey = keyof typeof rawComplexExamples;
