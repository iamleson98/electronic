// P3 logic ICs: CD4027 dual JK flip-flop, CD4017 decade counter, CD4060
// 14-stage ripple counter + oscillator, CD4093 quad NAND Schmitt trigger,
// CD4511 BCD→7-segment latch/decoder/driver, 7490 decade counter (÷2 + ÷5),
// 74164 8-bit serial-in/parallel-out shift register, 74245 octal bus
// transceiver, 74374 octal D flip-flop with tri-state outputs, and the
// 74HC4046 phase-locked loop (behavioral).
//
// Conventions shared with p1-logic.ts:
//   - Inputs are read from sim.nodeVoltage against a param threshold
//     (default 2.5 V); every input pin gets a 1 µS (1 MΩ) weak pull-down so
//     floating pins read LOW instead of drifting.
//   - Outputs are ideal voltage sources to ground (0 V / VCC). An unconnected
//     output pin maps to node 0 and is NOT stamped — a voltage source between
//     ground and ground leaves an all-zero MNA row and a singular system.
//   - Sequential state lives in sim.state.__global under stateKey(prefix, comp)
//     so it survives node renumbering (see state-keys.ts).
//   - MULTI-STAMP SAFETY: the solver re-stamps during Newton iterations and
//     DC sweeps, so edge detection is LEVEL based — clkPrev is refreshed on
//     every stamp call and an edge only fires when the stored previous level
//     actually differs from the freshly read one. Re-stamping the same
//     solution can therefore never re-fire an edge.
//   - The two genuinely time-integrating parts (CD4060 oscillator, 4046 PLL)
//     advance their phase only when sim.time CHANGES (time guard), so a
//     re-stamp at the same instant can never double-integrate. (The transient
//     engine gives every simulateStep() a unique sim.time; solveDC() ramps
//     time by its huge DC timestep per iteration, which only scrambles the
//     oscillator phase of a DC "operating point" that has none anyway.)

import type { MnaSystem } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';

const INPUT_PULL_DOWN = 1e-6; // 1 MΩ — floating inputs read LOW

/** Node id of a terminal (unwired pins map to node 0 = ground). */
function pinOf(terminals: { terminalId: string; nodeId: number }[], id: string): number {
  return terminals.find(t => t.terminalId === id)?.nodeId ?? 0;
}

/** Pin voltage (node 0 / unwired pins read 0 V). */
function v(sim: { nodeVoltage: Float64Array }, node: number): number {
  return sim.nodeVoltage[node] ?? 0;
}

/** Weak pull-down on an input pin (skipped for ground / the IC's own rails). */
function pullDown(sys: MnaSystem, node: number, gnd: number, vcc: number): void {
  if (node !== 0 && node !== gnd && node !== vcc) sys.stampConductance(node, gnd, INPUT_PULL_DOWN);
}

// ─────────────────────────────────────────────────────────────────────────────
// CD4027 — Dual JK Flip-Flop (both units in one symbol)
// Rising-edge clock; async active-HIGH SET / RST.
// J-K table: 00 hold, 01 reset, 10 set, 11 toggle.
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'cd4027',
  name: 'CD4027 (Dual JK Flip-Flop)',
  category: 'logic',
  description: 'CD4027 CMOS dual JK flip-flop (both units in one symbol). Rising-edge clock; async active-HIGH SET and RST. J/K: 00 hold, 01 reset, 10 set, 11 toggle.',
  symbol: 'JK',
  boundingBox: { width: 8, height: 8 },
  terminals: [
    // unit 1 (top half)
    { id: 'j1', label: 'J1', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'clk1', label: 'CLK1', position: { x: 0, y: 2 }, electricalType: 'input' as const, shape: 'clock' as const },
    { id: 'k1', label: 'K1', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'set1', label: 'SET1', position: { x: 2, y: 0 }, electricalType: 'input' as const },
    { id: 'rst1', label: 'RST1', position: { x: 2, y: 8 }, electricalType: 'input' as const },
    { id: 'q1', label: 'Q1', position: { x: 8, y: 1.5 }, electricalType: 'output' as const },
    { id: 'qbar1', label: 'Q̄1', position: { x: 8, y: 3.5 }, electricalType: 'output' as const },
    // unit 2 (bottom half)
    { id: 'j2', label: 'J2', position: { x: 0, y: 5 }, electricalType: 'input' as const },
    { id: 'clk2', label: 'CLK2', position: { x: 0, y: 6 }, electricalType: 'input' as const, shape: 'clock' as const },
    { id: 'k2', label: 'K2', position: { x: 0, y: 7 }, electricalType: 'input' as const },
    { id: 'set2', label: 'SET2', position: { x: 6, y: 0 }, electricalType: 'input' as const },
    { id: 'rst2', label: 'RST2', position: { x: 6, y: 8 }, electricalType: 'input' as const },
    { id: 'q2', label: 'Q2', position: { x: 8, y: 5.5 }, electricalType: 'output' as const },
    { id: 'qbar2', label: 'Q̄2', position: { x: 8, y: 7.5 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 8 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 3, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Clock Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['cd4027', 'cmos', 'flip-flop', 'jk', 'digital', 'counter'],
  extraVars: () => 4, // q1/qbar1/q2/qbar2 voltage sources when wired
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 7 * cellSize);
    ctx.moveTo(cellSize, 4.5 * cellSize); ctx.lineTo(7 * cellSize, 4.5 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '4027', 4 * cellSize, 2.5 * cellSize);
    drawLabel(ctx, '4027', 4 * cellSize, 6.5 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13); // keep rail node alive
    for (const id of ['j1', 'k1', 'clk1', 'set1', 'rst1', 'j2', 'k2', 'clk2', 'set2', 'rst2']) {
      pullDown(sys, pinOf(terminals, id), gnd, vcc);
    }
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('cd4027', comp);
    const s = st[key] ?? (st[key] = { q1: 0, clk1Prev: 0, q2: 0, clk2Prev: 0 });
    for (const u of [1, 2] as const) {
      const clkNow = v(sim, pinOf(terminals, `clk${u}`));
      // Level-based edge detect — clkPrev is refreshed every stamp, so
      // repeated stamps of the same solution never re-fire the same edge.
      const rising = clkNow > thresh && s[`clk${u}Prev`] <= thresh;
      if (v(sim, pinOf(terminals, `set${u}`)) > thresh) {
        s[`q${u}`] = 1; // async set dominates (matches CD4013 ordering)
      } else if (v(sim, pinOf(terminals, `rst${u}`)) > thresh) {
        s[`q${u}`] = 0; // async reset
      } else if (rising) {
        const j = v(sim, pinOf(terminals, `j${u}`)) > thresh;
        const k = v(sim, pinOf(terminals, `k${u}`)) > thresh;
        if (j && k) s[`q${u}`] = s[`q${u}`] ? 0 : 1; // toggle
        else if (j) s[`q${u}`] = 1; // set
        else if (k) s[`q${u}`] = 0; // reset
        // 00 → hold
      }
      s[`clk${u}Prev`] = clkNow;
      const qv = s[`q${u}`] ? vccV : 0;
      const q = pinOf(terminals, `q${u}`);
      const qbar = pinOf(terminals, `qbar${u}`);
      if (q !== 0) sys.stampVoltageSource(q, 0, qv);
      if (qbar !== 0) sys.stampVoltageSource(qbar, 0, qv ? 0 : vccV);
    }
  },
  measure(params, terminals, sim) {
    return [
      { label: 'Q1', value: v(sim, pinOf(terminals, 'q1')).toFixed(2), unit: 'V' },
      { label: 'Q2', value: v(sim, pinOf(terminals, 'q2')).toFixed(2), unit: 'V' },
    ];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4017 — Decade Counter with 10 decoded outputs
// Counts 0..9 on CLK rising edge; EN high inhibits; RST async active-high.
// CARRY is high during counts 0-4 (clocks the next decade on its wrap).
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'cd4017',
  name: 'CD4017 (Decade Counter)',
  category: 'logic',
  description: 'CD4017 CMOS decade counter with 10 decoded outputs. Counts 0-9 on the CLK rising edge (EN high inhibits the clock). RST is async active-high. CARRY is high for counts 0-4.',
  symbol: '4017',
  boundingBox: { width: 8, height: 10 },
  terminals: [
    { id: 'clk', label: 'CLK', position: { x: 0, y: 1 }, electricalType: 'input' as const, shape: 'clock' as const },
    { id: 'en', label: 'EN', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'rst', label: 'RST', position: { x: 0, y: 5 }, electricalType: 'input' as const },
    { id: 'carry', label: 'CO', position: { x: 0, y: 8 }, electricalType: 'output' as const },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `y${i}`, label: `Y${i}`, position: { x: 8, y: 0.5 + i }, electricalType: 'output' as const,
    })),
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 10 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 3, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['cd4017', 'cmos', 'counter', 'decade', 'johnson', 'digital'],
  extraVars: () => 11, // y0..y9 + carry voltage sources when wired
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 9 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '4017', 4 * cellSize, 5 * cellSize);
    ctx.beginPath(); // clock-edge wedge
    ctx.moveTo(cellSize, 1.5 * cellSize);
    ctx.lineTo(1.5 * cellSize, cellSize);
    ctx.lineTo(cellSize, 0.5 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    for (const id of ['clk', 'en', 'rst']) pullDown(sys, pinOf(terminals, id), gnd, vcc);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('cd4017', comp);
    const s = st[key] ?? (st[key] = { count: 0, clkPrev: 0 });
    const clkNow = v(sim, pinOf(terminals, 'clk'));
    const rising = clkNow > thresh && s.clkPrev <= thresh;
    if (v(sim, pinOf(terminals, 'rst')) > thresh) {
      s.count = 0; // async reset dominates
    } else if (rising && v(sim, pinOf(terminals, 'en')) <= thresh) {
      s.count = (s.count + 1) % 10; // EN high inhibits the clock
    }
    s.clkPrev = clkNow;
    for (let i = 0; i < 10; i++) {
      const y = pinOf(terminals, `y${i}`);
      if (y !== 0) sys.stampVoltageSource(y, 0, s.count === i ? vccV : 0);
    }
    const carry = pinOf(terminals, 'carry');
    if (carry !== 0) sys.stampVoltageSource(carry, 0, s.count < 5 ? vccV : 0);
  },
  measure(_params, terminals, sim, comp) {
    const st = sim.state.__global ?? {};
    const s = st[stateKey('cd4017', comp)] ?? { count: 0 };
    return [{ label: 'Count', value: String(s.count), unit: '' }];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4060 — 14-Stage Binary Ripple Counter with Oscillator
// Clock externally via CLK, or leave CLK unwired to run the internal RC
// oscillator (approximated by the oscFreq param). Outputs Q3..Q14 — Q11 is
// not bonded on the real part either. Qn = bit n of the internal count,
// which increments on each (effective) clock rising edge; RST clears.
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'cd4060',
  name: 'CD4060 (14-Stage Counter)',
  category: 'logic',
  description: 'CD4060 14-stage binary ripple counter with internal oscillator. Clock externally through CLK, or leave CLK unwired to use the internal oscillator (oscFreq param). Outputs Q3-Q14 (Q11 not bonded, like the real part). RST async active-high.',
  symbol: '4060',
  boundingBox: { width: 8, height: 12 },
  terminals: [
    // Oscillator pins RS/RC are kept for schematic fidelity; the behavioral
    // model derives the internal clock from the oscFreq parameter.
    { id: 'rs', label: 'RS', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'rc', label: 'RC', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'clk', label: 'CLK', position: { x: 0, y: 4 }, electricalType: 'input' as const, shape: 'clock' as const },
    { id: 'rst', label: 'RST', position: { x: 0, y: 6 }, electricalType: 'input' as const },
    { id: 'q3', label: 'Q3', position: { x: 8, y: 0.5 }, electricalType: 'output' as const },
    { id: 'q4', label: 'Q4', position: { x: 8, y: 1.5 }, electricalType: 'output' as const },
    { id: 'q5', label: 'Q5', position: { x: 8, y: 2.5 }, electricalType: 'output' as const },
    { id: 'q6', label: 'Q6', position: { x: 8, y: 3.5 }, electricalType: 'output' as const },
    { id: 'q7', label: 'Q7', position: { x: 8, y: 4.5 }, electricalType: 'output' as const },
    { id: 'q8', label: 'Q8', position: { x: 8, y: 5.5 }, electricalType: 'output' as const },
    { id: 'q9', label: 'Q9', position: { x: 8, y: 6.5 }, electricalType: 'output' as const },
    { id: 'q10', label: 'Q10', position: { x: 8, y: 7.5 }, electricalType: 'output' as const },
    { id: 'q12', label: 'Q12', position: { x: 8, y: 8.5 }, electricalType: 'output' as const },
    { id: 'q13', label: 'Q13', position: { x: 8, y: 9.5 }, electricalType: 'output' as const },
    { id: 'q14', label: 'Q14', position: { x: 8, y: 10.5 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 12 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 3, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
    { key: 'oscFreq', label: 'Oscillator Freq', type: 'number', default: 100, unit: 'Hz', min: 0.1, max: 1e6, step: 1 },
  ],
  keywords: ['cd4060', 'cmos', 'counter', 'ripple', 'oscillator', 'digital'],
  extraVars: () => 11, // q3..q14 voltage sources when wired
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 11 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '4060', 4 * cellSize, 6 * cellSize);
    ctx.beginPath(); // clock-edge wedge
    ctx.moveTo(cellSize, 4.5 * cellSize);
    ctx.lineTo(1.5 * cellSize, 4 * cellSize);
    ctx.lineTo(cellSize, 3.5 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const oscFreq = params.oscFreq as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    for (const id of ['rs', 'rc', 'rst']) pullDown(sys, pinOf(terminals, id), gnd, vcc);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('cd4060', comp);
    const s = st[key] ?? (st[key] = { count: 0, clkPrev: 0, oscPhase: 0, lastTime: undefined as number | undefined });
    const rstHigh = v(sim, pinOf(terminals, 'rst')) > thresh;
    const clk = pinOf(terminals, 'clk');
    const clkNow = v(sim, clk);
    if (rstHigh) {
      s.count = 0; // async reset dominates
    } else if (clk !== 0) {
      // External clock — level-based rising-edge detect (multi-stamp safe).
      if (clkNow > thresh && s.clkPrev <= thresh) {
        s.count = (s.count + 1) & 0x3fff; // 14 stages
      }
    } else {
      // CLK unwired → internal oscillator. Phase advances once per UNIQUE
      // sim.time (time guard), so repeated stamps at one instant never
      // double-count. Wraps are computed with floor() instead of a loop so a
      // huge dt (solveDC uses dt = 1e6 s) cannot spin.
      if (s.lastTime === undefined || sim.time !== s.lastTime) {
        const dt = s.lastTime === undefined ? 0 : Math.max(0, sim.time - s.lastTime);
        s.lastTime = sim.time;
        s.oscPhase += dt * oscFreq;
        const wraps = Math.floor(s.oscPhase);
        s.oscPhase -= wraps;
        if (wraps > 0) s.count = (s.count + wraps) & 0x3fff;
      }
    }
    s.clkPrev = clkNow;
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14]) {
      const q = pinOf(terminals, `q${n}`);
      if (q !== 0) sys.stampVoltageSource(q, 0, (s.count >> n) & 1 ? vccV : 0);
    }
  },
  measure(_params, terminals, sim, comp) {
    const st = sim.state.__global ?? {};
    const s = st[stateKey('cd4060', comp)] ?? { count: 0 };
    return [{ label: 'Count', value: String(s.count), unit: '' }];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4093 — Quad 2-Input NAND Schmitt Trigger (single gate, 7400-style)
// Hysteresis per input: an input registers HIGH above VT+, stays HIGH down
// to VT−. Output is LOW only while BOTH (filtered) inputs are HIGH.
// Thresholds default to 0.6/0.4 of a 5 V rail (CMOS-ish).
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'cd4093',
  name: 'CD4093 (NAND Schmitt)',
  category: 'logic',
  description: 'CD4093 quad 2-input NAND Schmitt trigger (one gate). Output goes LOW only when both inputs are above VT+, HIGH when any input is below VT−, and holds its previous state in between. Eliminates chatter on slowly-changing inputs.',
  symbol: '4093',
  boundingBox: { width: 4, height: 3 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'b', label: 'B', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'y', label: 'Y', position: { x: 4, y: 1.5 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 3 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Logic High (VCC)', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
    { key: 'vtPos', label: 'Positive Threshold', type: 'number', default: 3.0, unit: 'V', min: 0.1, max: 18, step: 0.1 },
    { key: 'vtNeg', label: 'Negative Threshold', type: 'number', default: 2.0, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['cd4093', 'cmos', 'schmitt', 'trigger', 'hysteresis', 'nand', 'digital'],
  extraVars: () => 1,
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(0, 2 * cellSize); ctx.lineTo(cellSize, 2 * cellSize);
    ctx.moveTo(3 * cellSize, 1.5 * cellSize); ctx.lineTo(4 * cellSize, 1.5 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cellSize, cellSize * 0.5);
    ctx.lineTo(cellSize, cellSize * 2.5);
    ctx.lineTo(2 * cellSize, cellSize * 2.5);
    ctx.arc(2 * cellSize, 1.5 * cellSize, cellSize, Math.PI / 2, -Math.PI / 2, true);
    ctx.closePath();
    ctx.fillStyle = '#fce7f3';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath(); // NAND bubble
    ctx.arc(3.1 * cellSize, 1.5 * cellSize, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath(); // hysteresis glyph
    ctx.moveTo(1.3 * cellSize, 1.2 * cellSize);
    ctx.lineTo(1.6 * cellSize, 1.2 * cellSize);
    ctx.lineTo(1.6 * cellSize, 1.8 * cellSize);
    ctx.lineTo(1.9 * cellSize, 1.8 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '4093', 2 * cellSize, 1.9 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const vtPos = params.vtPos as number;
    const vtNeg = params.vtNeg as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    pullDown(sys, pinOf(terminals, 'a'), gnd, vcc);
    pullDown(sys, pinOf(terminals, 'b'), gnd, vcc);
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('cd4093', comp);
    // Per-input Schmitt state (like a real CD4093: hysteresis acts on each
    // input independently, then the NAND combines them).
    const s = st[key] ?? (st[key] = { a: false, b: false });
    const aV = v(sim, pinOf(terminals, 'a'));
    const bV = v(sim, pinOf(terminals, 'b'));
    const aHigh = s.a ? aV > vtNeg : aV > vtPos;
    s.a = aHigh;
    const bHigh = s.b ? bV > vtNeg : bV > vtPos;
    s.b = bHigh;
    const out = !(aHigh && bHigh);
    const y = pinOf(terminals, 'y');
    if (y !== 0) sys.stampVoltageSource(y, 0, out ? vccV : 0);
  },
  measure(_params, terminals, sim) {
    return [
      { label: 'A', value: v(sim, pinOf(terminals, 'a')).toFixed(2), unit: 'V' },
      { label: 'B', value: v(sim, pinOf(terminals, 'b')).toFixed(2), unit: 'V' },
      { label: 'Y', value: v(sim, pinOf(terminals, 'y')).toFixed(2), unit: 'V' },
    ];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4511 — BCD to 7-Segment Latch / Decoder / Driver
// BCD 0-9 decode to segments a-g (10-15 blank). LT (active-low) lights all
// segments; BI (active-low) blanks; LE (active-high) latches the BCD input.
// Priority: LT > BI > decoder, per the datasheet.
// ─────────────────────────────────────────────────────────────────────────────

// Segment order a, b, c, d, e, f, g — 1 = ON.
const SEG7_PATTERNS: number[][] = [
  [1, 1, 1, 1, 1, 1, 0], // 0
  [0, 1, 1, 0, 0, 0, 0], // 1
  [1, 1, 0, 1, 1, 0, 1], // 2
  [1, 1, 1, 1, 0, 0, 1], // 3
  [0, 1, 1, 0, 0, 1, 1], // 4
  [1, 0, 1, 1, 0, 1, 1], // 5
  [1, 0, 1, 1, 1, 1, 1], // 6
  [1, 1, 1, 0, 0, 0, 0], // 7
  [1, 1, 1, 1, 1, 1, 1], // 8
  [1, 1, 1, 1, 0, 1, 1], // 9
];
const SEG7_BLANK = [0, 0, 0, 0, 0, 0, 0];
const SEG7_ALL_ON = [1, 1, 1, 1, 1, 1, 1];

registerPlugin({
  type: 'cd4511',
  name: 'CD4511 (BCD→7-Seg)',
  category: 'logic',
  description: 'CD4511 BCD-to-7-segment latch/decoder/driver. BCD 0-9 decoded onto segments a-g (10-15 blank). LT (active-low) forces all segments on, BI (active-low) blanks them, LE (active-high) latches the current BCD value.',
  symbol: '4511',
  boundingBox: { width: 8, height: 10 },
  terminals: [
    { id: 'd0', label: 'D0', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'd1', label: 'D1', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'd2', label: 'D2', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'd3', label: 'D3', position: { x: 0, y: 4 }, electricalType: 'input' as const },
    { id: 'le', label: 'LE', position: { x: 0, y: 6 }, electricalType: 'input' as const },
    { id: 'bi', label: 'BI', position: { x: 0, y: 7 }, electricalType: 'input' as const },
    { id: 'lt', label: 'LT', position: { x: 0, y: 8 }, electricalType: 'input' as const },
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s, i) => ({
      id: s, label: s.toUpperCase(), position: { x: 8, y: 1 + i }, electricalType: 'output' as const,
    })),
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 10 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 3, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['cd4511', 'cmos', 'bcd', '7-segment', 'decoder', 'display', 'digital'],
  extraVars: () => 7, // a..g voltage sources when wired
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 9 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '4511', 4 * cellSize, 5 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    for (const id of ['d0', 'd1', 'd2', 'd3', 'le', 'bi', 'lt']) {
      pullDown(sys, pinOf(terminals, id), gnd, vcc);
    }
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('cd4511', comp);
    const s = st[key] ?? (st[key] = { latched: 0 });
    const bcd =
      (v(sim, pinOf(terminals, 'd3')) > thresh ? 8 : 0) |
      (v(sim, pinOf(terminals, 'd2')) > thresh ? 4 : 0) |
      (v(sim, pinOf(terminals, 'd1')) > thresh ? 2 : 0) |
      (v(sim, pinOf(terminals, 'd0')) > thresh ? 1 : 0);
    // Transparent while LE is low; the value present when LE goes high is held.
    if (v(sim, pinOf(terminals, 'le')) <= thresh) s.latched = bcd;
    let pattern: number[];
    if (v(sim, pinOf(terminals, 'lt')) <= thresh) {
      pattern = SEG7_ALL_ON; // lamp test overrides everything
    } else if (v(sim, pinOf(terminals, 'bi')) <= thresh) {
      pattern = SEG7_BLANK; // blanking overrides the decoder
    } else {
      pattern = SEG7_PATTERNS[s.latched] ?? SEG7_BLANK;
    }
    const segs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (let i = 0; i < 7; i++) {
      const node = pinOf(terminals, segs[i]);
      if (node !== 0) sys.stampVoltageSource(node, 0, pattern[i] ? vccV : 0);
    }
  },
  measure(_params, terminals, sim, comp) {
    const st = sim.state.__global ?? {};
    const s = st[stateKey('cd4511', comp)] ?? { latched: 0 };
    return [{ label: 'BCD', value: String(s.latched), unit: '' }];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 7490 — Decade Counter (÷2 and ÷5 sections)
// Falling-edge clocked (as the original bipolar part). CLKA feeds the ÷2
// stage (QA); CLKB feeds the ÷5 stage (QB QC QD, binary with QB = LSB).
// R0(1)&R0(2) high resets to 0; R9(1)&R9(2) high presets to 9 (QA=QD=1).
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'ic7490',
  name: '7490 (Decade Counter)',
  category: 'logic',
  description: '7490 decade counter with separate ÷2 (CLKA→QA) and ÷5 (CLKB→QB,QC,QD) sections, falling-edge clocked. R0(1)&R0(2) high resets to 0; R9(1)&R9(2) high presets to 9 (QA=QD=1). Wire QA to CLKB for BCD decade counting.',
  symbol: '490',
  boundingBox: { width: 8, height: 8 },
  terminals: [
    { id: 'clka', label: 'CLKA', position: { x: 0, y: 1 }, electricalType: 'input' as const, shape: 'falling_edge' as const },
    { id: 'clkb', label: 'CLKB', position: { x: 0, y: 2 }, electricalType: 'input' as const, shape: 'falling_edge' as const },
    { id: 'r0a', label: 'R0(1)', position: { x: 0, y: 4 }, electricalType: 'input' as const },
    { id: 'r0b', label: 'R0(2)', position: { x: 0, y: 5 }, electricalType: 'input' as const },
    { id: 'r9a', label: 'R9(1)', position: { x: 0, y: 6 }, electricalType: 'input' as const },
    { id: 'r9b', label: 'R9(2)', position: { x: 0, y: 7 }, electricalType: 'input' as const },
    { id: 'qa', label: 'QA', position: { x: 8, y: 1 }, electricalType: 'output' as const },
    { id: 'qb', label: 'QB', position: { x: 8, y: 3 }, electricalType: 'output' as const },
    { id: 'qc', label: 'QC', position: { x: 8, y: 5 }, electricalType: 'output' as const },
    { id: 'qd', label: 'QD', position: { x: 8, y: 7 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 8 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Logic High', type: 'number', default: 5, unit: 'V', min: 1, max: 8, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 8, step: 0.1 },
  ],
  keywords: ['7490', 'counter', 'decade', 'divide', 'ttl', 'digital'],
  extraVars: () => 4, // qa..qd voltage sources when wired
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 7 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '490', 4 * cellSize, 4 * cellSize);
    ctx.beginPath(); // falling-edge wedge (bubble + wedge on clock pins)
    ctx.moveTo(cellSize, 1.5 * cellSize);
    ctx.lineTo(1.4 * cellSize, cellSize * 1.1);
    ctx.lineTo(cellSize, 0.7 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    for (const id of ['clka', 'clkb', 'r0a', 'r0b', 'r9a', 'r9b']) {
      pullDown(sys, pinOf(terminals, id), gnd, vcc);
    }
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('ic7490', comp);
    const s = st[key] ?? (st[key] = { qa: 0, c5: 0, aPrev: 0, bPrev: 0 });
    const aNow = v(sim, pinOf(terminals, 'clka'));
    const bNow = v(sim, pinOf(terminals, 'clkb'));
    // Falling-edge detect (historically accurate for the 7490).
    const fallA = aNow < thresh && s.aPrev >= thresh;
    const fallB = bNow < thresh && s.bPrev >= thresh;
    const r0 = v(sim, pinOf(terminals, 'r0a')) > thresh && v(sim, pinOf(terminals, 'r0b')) > thresh;
    const r9 = v(sim, pinOf(terminals, 'r9a')) > thresh && v(sim, pinOf(terminals, 'r9b')) > thresh;
    if (r9) {
      s.qa = 1; s.c5 = 4; // preset 9 = 1001 (QA and QD high)
    } else if (r0) {
      s.qa = 0; s.c5 = 0; // reset dominates when only R0 pair is high
    } else {
      if (fallA) s.qa = s.qa ? 0 : 1; // ÷2 section
      if (fallB) s.c5 = (s.c5 + 1) % 5; // ÷5 section counts 0-4
    }
    s.aPrev = aNow;
    s.bPrev = bNow;
    const outs: [string, number][] = [
      ['qa', s.qa],
      ['qb', s.c5 & 1],
      ['qc', (s.c5 >> 1) & 1],
      ['qd', (s.c5 >> 2) & 1],
    ];
    for (const [id, bit] of outs) {
      const node = pinOf(terminals, id);
      if (node !== 0) sys.stampVoltageSource(node, 0, bit ? vccV : 0);
    }
  },
  measure(_params, terminals, sim, comp) {
    const st = sim.state.__global ?? {};
    const s = st[stateKey('ic7490', comp)] ?? { qa: 0, c5: 0 };
    return [{ label: 'Count', value: String(s.c5 * 2 + s.qa), unit: '' }];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 74164 — 8-Bit Serial-In / Parallel-Out Shift Register
// Data = A AND B (gated serial inputs), shifted into Q0 on the CLK rising
// edge; Q0..Q7 shift up. CLR (active-low) asynchronously clears everything.
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'ic74164',
  name: '74164 (Shift Register)',
  category: 'logic',
  description: '74164 8-bit serial-in / parallel-out shift register. Serial data (A AND B) enters Q0 on each CLK rising edge and shifts toward Q7. CLR (active-low) asynchronously clears all outputs.',
  symbol: '164',
  boundingBox: { width: 8, height: 10 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'b', label: 'B', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'clk', label: 'CLK', position: { x: 0, y: 4 }, electricalType: 'input' as const, shape: 'clock' as const },
    { id: 'clr', label: 'CLR', position: { x: 0, y: 6 }, electricalType: 'input' as const, shape: 'inverted' as const },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `q${i}`, label: `Q${i}`, position: { x: 8, y: 0.5 + i }, electricalType: 'output' as const,
    })),
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 10 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Logic High', type: 'number', default: 5, unit: 'V', min: 1, max: 8, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 8, step: 0.1 },
  ],
  keywords: ['74164', 'shift', 'register', 'serial', 'sipo', 'digital'],
  extraVars: () => 8, // q0..q7 voltage sources when wired
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 9 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '164', 4 * cellSize, 5 * cellSize);
    ctx.beginPath(); // clock-edge wedge
    ctx.moveTo(cellSize, 4.5 * cellSize);
    ctx.lineTo(1.5 * cellSize, 4 * cellSize);
    ctx.lineTo(cellSize, 3.5 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    for (const id of ['a', 'b', 'clk', 'clr']) pullDown(sys, pinOf(terminals, id), gnd, vcc);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('ic74164', comp);
    const s = st[key] ?? (st[key] = { bits: 0, clkPrev: 0 });
    const clkNow = v(sim, pinOf(terminals, 'clk'));
    const rising = clkNow > thresh && s.clkPrev <= thresh;
    if (v(sim, pinOf(terminals, 'clr')) <= thresh) {
      s.bits = 0; // async active-low clear dominates
    } else if (rising) {
      const data =
        v(sim, pinOf(terminals, 'a')) > thresh && v(sim, pinOf(terminals, 'b')) > thresh ? 1 : 0;
      s.bits = ((s.bits << 1) | data) & 0xff; // Q0 = new bit, others shift up
    }
    s.clkPrev = clkNow;
    for (let i = 0; i < 8; i++) {
      const node = pinOf(terminals, `q${i}`);
      if (node !== 0) sys.stampVoltageSource(node, 0, (s.bits >> i) & 1 ? vccV : 0);
    }
  },
  measure(_params, terminals, sim, comp) {
    const st = sim.state.__global ?? {};
    const s = st[stateKey('ic74164', comp)] ?? { bits: 0 };
    return [{ label: 'Byte', value: s.bits.toString(2).padStart(8, '0'), unit: '' }];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 74245 — Octal Bus Transceiver
// OE (active-low) connects the eight A↔B channels through RON; OE high
// leaves them at ROFF. Simplification: each bit is a bilateral pass switch
// (CD4066-style) — a linear MNA stamp cannot know which side is driving, so
// DIR only exists for pin fidelity, not for the electrical model.
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'ic74245',
  name: '74245 (Bus Transceiver)',
  category: 'logic',
  description: '74245 octal bus transceiver. OE (active-low) enables the eight A↔B channels through RON; OE high disables them (ROFF). Each bit is modeled as a bilateral pass switch — DIR is kept for pin fidelity but the channel conducts both ways (linear-model simplification).',
  symbol: '245',
  boundingBox: { width: 8, height: 12 },
  terminals: [
    { id: 'dir', label: 'DIR', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'oe', label: 'OE', position: { x: 0, y: 2 }, electricalType: 'input' as const, shape: 'inverted' as const },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `a${i}`, label: `A${i}`, position: { x: 0, y: 4 + i }, electricalType: 'bidirectional' as const,
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `b${i}`, label: `B${i}`, position: { x: 8, y: 4 + i }, electricalType: 'bidirectional' as const,
    })),
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 12 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'ron', label: 'On Resistance', type: 'number', default: 10, unit: 'Ω', min: 0.001, max: 1000, step: 1 },
    { key: 'roff', label: 'Off Resistance', type: 'number', default: 1e9, unit: 'Ω', min: 1e3, max: 1e15, step: 1e6 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['74245', 'bus', 'transceiver', 'octal', 'tri-state', 'digital'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 11 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '245', 4 * cellSize, 6 * cellSize);
    // direction arrow through the body
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, 5 * cellSize);
    ctx.lineTo(6 * cellSize, 5 * cellSize);
    ctx.moveTo(5.4 * cellSize, 4.7 * cellSize);
    ctx.lineTo(6 * cellSize, 5 * cellSize);
    ctx.lineTo(5.4 * cellSize, 5.3 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim) {
    const thresh = params.threshold as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    pullDown(sys, pinOf(terminals, 'dir'), gnd, vcc);
    pullDown(sys, pinOf(terminals, 'oe'), gnd, vcc);
    // OE is active low: enabled when below the threshold.
    const enabled = v(sim, pinOf(terminals, 'oe')) < thresh;
    const g = enabled ? 1 / Math.max(0.001, params.ron as number) : 1 / (params.roff as number);
    // Each bit: bilateral switch between aN and bN. A channel with an
    // unwired pin (node 0) is left floating — in this node model an unwired
    // pin is indistinguishable from a grounded one, and grounding a bus line
    // through RON just for being unwired would be far worse.
    for (let i = 0; i < 8; i++) {
      const a = pinOf(terminals, `a${i}`);
      const b = pinOf(terminals, `b${i}`);
      if (a !== 0 && b !== 0) sys.stampConductance(a, b, g);
    }
  },
  measure(_params, terminals, sim) {
    return [
      { label: 'OE', value: v(sim, pinOf(terminals, 'oe')) < 2.5 ? 'EN' : 'Hi-Z', unit: '' },
    ];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 74374 — Octal D Flip-Flop with Tri-State Outputs
// All eight D inputs latch to Q on the CLK rising edge. OE (active-low)
// drives the latched values onto Q; OE high leaves the outputs high-Z
// (only pin leakage to ground — keeps floating bus nodes non-singular).
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'ic74374',
  name: '74374 (Octal D FF)',
  category: 'logic',
  description: '74374 octal D flip-flop with tri-state outputs. All eight D inputs latch to Q on the CLK rising edge. OE (active-low) drives the outputs; OE high puts them in high-impedance (leakage only).',
  symbol: '374',
  boundingBox: { width: 8, height: 12 },
  terminals: [
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `d${i}`, label: `D${i}`, position: { x: 0, y: 1 + i }, electricalType: 'input' as const,
    })),
    { id: 'clk', label: 'CLK', position: { x: 0, y: 10 }, electricalType: 'input' as const, shape: 'clock' as const },
    { id: 'oe', label: 'OE', position: { x: 0, y: 11 }, electricalType: 'input' as const, shape: 'inverted' as const },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `q${i}`, label: `Q${i}`, position: { x: 8, y: 1 + i }, electricalType: 'output' as const,
    })),
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 12 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Logic High', type: 'number', default: 5, unit: 'V', min: 1, max: 8, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 8, step: 0.1 },
  ],
  keywords: ['74374', 'flip-flop', 'octal', 'latch', 'tri-state', 'bus', 'digital'],
  extraVars: () => 8, // q0..q7 voltage sources when wired
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 11 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '374', 4 * cellSize, 6 * cellSize);
    ctx.beginPath(); // clock-edge wedge
    ctx.moveTo(cellSize, 10.5 * cellSize);
    ctx.lineTo(1.5 * cellSize, 10 * cellSize);
    ctx.lineTo(cellSize, 9.5 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    for (const id of ['clk', 'oe', 'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']) {
      pullDown(sys, pinOf(terminals, id), gnd, vcc);
    }
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('ic74374', comp);
    const s = st[key] ?? (st[key] = { bits: 0, clkPrev: 0 });
    const clkNow = v(sim, pinOf(terminals, 'clk'));
    if (clkNow > thresh && s.clkPrev <= thresh) {
      let bits = 0;
      for (let i = 0; i < 8; i++) {
        if (v(sim, pinOf(terminals, `d${i}`)) > thresh) bits |= 1 << i;
      }
      s.bits = bits;
    }
    s.clkPrev = clkNow;
    const oeLow = v(sim, pinOf(terminals, 'oe')) <= thresh;
    for (let i = 0; i < 8; i++) {
      const node = pinOf(terminals, `q${i}`);
      if (node === 0) continue;
      if (oeLow) {
        sys.stampVoltageSource(node, 0, (s.bits >> i) & 1 ? vccV : 0);
      } else {
        // High-impedance: 1 GΩ leakage keeps otherwise-unstamped bus nodes
        // from producing an all-zero (singular) MNA row.
        sys.stampConductance(node, 0, 1e-9);
      }
    }
  },
  measure(_params, terminals, sim, comp) {
    const st = sim.state.__global ?? {};
    const s = st[stateKey('ic74374', comp)] ?? { bits: 0 };
    return [{ label: 'Byte', value: s.bits.toString(2).padStart(8, '0'), unit: '' }];
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 74HC4046 — Phase-Locked Loop (behavioral)
// Phase detector II + charge pump on PCPOUT, VCO on VCOOUT:
//   - VCO: f = FMIN + (FMAX − FMIN) · clamp(V(VCOIN)/VCC, 0, 1); the output
//     duty is set by vcoDuty. INH (active high) parks the VCO at 0 V.
//   - PFD: classic sequential phase detector — SIGIN rising edge arms UP,
//     COMPIN rising edge arms DOWN, and once both are armed they reset
//     (overlap reset). The charge pump then sources ICp into PCPOUT (UP,
//     reference leads) or sinks ICp out of it (DOWN), or stays high-Z.
// Close the loop: VCOOUT ÷ N → COMPIN, PCPOUT → RC filter → VCOIN.
// All time integration is guarded on sim.time so the repeated stamps of a
// Newton iteration can never double-advance the VCO phase or double-fire an
// edge; only the first stamp at a given instant mutates the state.
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin({
  type: 'pll4046',
  name: '74HC4046 (PLL)',
  category: 'logic',
  description: '74HC4046 phase-locked loop (behavioral). VCO: f = FMIN + (FMAX−FMIN)·V(VCOIN)/VCC on VCOOUT. Phase detector II charge pump on PCPOUT: sources ICp when SIGIN leads COMPIN, sinks when it lags. INH high disables the VCO. Feed VCOOUT back to COMPIN and filter PCPOUT into VCOIN to close the loop.',
  symbol: 'PLL',
  boundingBox: { width: 8, height: 6 },
  terminals: [
    { id: 'sigin', label: 'SIGIN', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'compin', label: 'COMPIN', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'vcoin', label: 'VCOIN', position: { x: 0, y: 3.5 }, electricalType: 'input' as const },
    { id: 'inh', label: 'INH', position: { x: 0, y: 5 }, electricalType: 'input' as const },
    { id: 'pcpout', label: 'PCPOUT', position: { x: 8, y: 1 }, electricalType: 'output' as const },
    { id: 'vcoout', label: 'VCOOUT', position: { x: 8, y: 3 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 6 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 3, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
    { key: 'fmin', label: 'VCO Fmin', type: 'number', default: 1000, unit: 'Hz', min: 0.001, max: 1e7, step: 1 },
    { key: 'fmax', label: 'VCO Fmax', type: 'number', default: 10000, unit: 'Hz', min: 0.001, max: 1e8, step: 100 },
    { key: 'icp', label: 'Charge-Pump Current', type: 'number', default: 0.001, unit: 'A', min: 1e-6, max: 0.1, step: 1e-5 },
    { key: 'vcoDuty', label: 'VCO Duty', type: 'number', default: 0.5, unit: '', min: 0.05, max: 0.95, step: 0.05 },
  ],
  keywords: ['4046', 'pll', 'phase', 'locked', 'loop', 'vco', 'charge pump', 'digital'],
  extraVars: () => 1, // vcoout voltage source when wired
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 5 * cellSize);
    ctx.moveTo(4.5 * cellSize, 1 * cellSize); // VCO block divider
    ctx.lineTo(4.5 * cellSize, 5 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'PFD', 2.75 * cellSize, 3 * cellSize);
    drawLabel(ctx, 'VCO', 6.25 * cellSize, 3 * cellSize);
    drawLabel(ctx, '4046', 4 * cellSize, 0.9 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const fmin = params.fmin as number;
    const fmax = params.fmax as number;
    const icp = params.icp as number;
    const duty = params.vcoDuty as number;
    const gnd = pinOf(terminals, 'gnd');
    const vcc = pinOf(terminals, 'vcc');
    if (vcc !== 0 && vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    for (const id of ['sigin', 'compin', 'vcoin', 'inh']) {
      pullDown(sys, pinOf(terminals, id), gnd, vcc);
    }
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('pll4046', comp);
    const s = st[key] ?? (st[key] = {
      phase: 0, lastTime: undefined as number | undefined,
      sigPrev: 0, compPrev: 0, up: false, down: false,
    });
    // ── time guard: mutate integrators only at a NEW sim.time ──
    if (s.lastTime === undefined || sim.time !== s.lastTime) {
      const dt = s.lastTime === undefined ? 0 : Math.max(0, sim.time - s.lastTime);
      s.lastTime = sim.time;
      // VCO phase (in cycles, [0,1)) — control voltage from the previous
      // solve, one-step lag, standard for behavioral companion models.
      const vIn = Math.min(1, Math.max(0, v(sim, pinOf(terminals, 'vcoin')) / vccV));
      const freq = fmin + (fmax - fmin) * vIn;
      s.phase = (s.phase + freq * dt) % 1;
      // PFD edge detection on the reference and feedback inputs.
      const sigNow = v(sim, pinOf(terminals, 'sigin'));
      const compNow = v(sim, pinOf(terminals, 'compin'));
      if (sigNow > thresh && s.sigPrev <= thresh) s.up = true;
      if (compNow > thresh && s.compPrev <= thresh) s.down = true;
      if (s.up && s.down) {
        s.up = false; s.down = false; // classic PFD overlap reset
      }
      s.sigPrev = sigNow;
      s.compPrev = compNow;
    }
    // VCO output square wave (INH parks it low).
    const vcoout = pinOf(terminals, 'vcoout');
    if (vcoout !== 0) {
      const inhibited = v(sim, pinOf(terminals, 'inh')) > thresh;
      const level = inhibited ? 0 : s.phase < duty ? vccV : 0;
      sys.stampVoltageSource(vcoout, 0, level);
    }
    // Charge pump: UP sources current INTO the filter node (pulls it up),
    // DOWN sinks it OUT (pulls it down), otherwise high-Z with pin leakage.
    const pcpout = pinOf(terminals, 'pcpout');
    if (pcpout !== 0) {
      if (s.up && !s.down) sys.stampCurrentSource(0, pcpout, icp);
      else if (s.down && !s.up) sys.stampCurrentSource(pcpout, 0, icp);
      else sys.stampConductance(pcpout, 0, 1e-9);
    }
  },
  measure(params, terminals, sim, comp) {
    const vccV = params.vcc as number;
    const fmin = params.fmin as number;
    const fmax = params.fmax as number;
    const st = sim.state.__global ?? {};
    const s = st[stateKey('pll4046', comp)] ?? { up: false, down: false };
    const vIn = Math.min(1, Math.max(0, v(sim, pinOf(terminals, 'vcoin')) / vccV));
    const freq = fmin + (fmax - fmin) * vIn;
    return [
      { label: 'f_VCO', value: freq >= 1000 ? `${(freq / 1000).toFixed(2)}k` : freq.toFixed(1), unit: 'Hz' },
      { label: 'VCOout', value: v(sim, pinOf(terminals, 'vcoout')).toFixed(2), unit: 'V' },
      { label: 'PFD', value: s.up ? 'UP' : s.down ? 'DOWN' : '—', unit: '' },
    ];
  },
});
