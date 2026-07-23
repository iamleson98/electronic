// Additional semiconductors: PNP BJT, NMOS/PMOS MOSFETs, op-amp with power rails,
// 7-segment display, VCO, crystal oscillator, transformer, speaker, photoresistor.

import type { ComponentPlugin } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';

// ----- PNP BJT (mirror of NPN) -----
const pnp: ComponentPlugin = {
  type: 'pnp',
  name: 'PNP Transistor',
  category: 'semiconductor',
  description: 'PNP BJT with simple piecewise-linear model. Use as a switch (high-side).',
  symbol: 'PNP',
  boundingBox: { width: 3, height: 4 },
  terminals: [
    { id: 'e', label: 'E', position: { x: 3, y: 0 } },
    { id: 'b', label: 'B', position: { x: 0, y: 2 } },
    { id: 'c', label: 'C', position: { x: 3, y: 4 } },
  ],
  parameters: [
    { key: 'hfe', label: 'DC Gain (hFE)', type: 'number', default: 100, unit: '', min: 1, max: 1000, step: 1 },
    { key: 'veb', label: 'VEB (on)', type: 'number', default: 0.7, unit: 'V', min: 0.1, max: 1.5, step: 0.05 },
    { key: 'satV', label: 'Vec(sat)', type: 'number', default: 0.2, unit: 'V', min: 0.01, max: 1, step: 0.05 },
  ],
  render(ctx, params, cellSize) {
    // base lead
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize);
    ctx.lineTo(cellSize * 1.2, 2 * cellSize);
    ctx.stroke();
    // emitter & collector leads
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 0);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.moveTo(3 * cellSize, cellSize * 2.8);
    ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.stroke();
    // body vertical line
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 1.2);
    ctx.lineTo(cellSize * 1.2, cellSize * 2.8);
    ctx.lineWidth = 2;
    ctx.stroke();
    // base -> emitter line (emitter is at top for PNP)
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 1.5);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.stroke();
    // arrow on emitter — PNP: arrow points INWARD (toward body)
    // Place arrow at the midpoint of the emitter line, pointing toward body.
    // Emitter line: from (3, 1.2) to (1.2, 1.5). Midpoint ≈ (2.1, 1.35).
    // Direction toward body: (1.2-3, 1.5-1.2) = (-1.8, 0.3), normalized.
    const emDirP = { x: -1.8, y: 0.3 };
    const emLenP = Math.hypot(emDirP.x, emDirP.y);
    const emNP = { x: emDirP.x / emLenP, y: emDirP.y / emLenP };
    // Arrow tip at midpoint of emitter line
    const tipXP = 2.1 * cellSize;
    const tipYP = 1.35 * cellSize;
    const arrowLenP = 7;
    const arrowWidP = 4;
    const baseXP = tipXP - emNP.x * arrowLenP;
    const baseYP = tipYP - emNP.y * arrowLenP;
    const perpP = { x: -emNP.y, y: emNP.x };
    ctx.beginPath();
    ctx.moveTo(tipXP, tipYP);
    ctx.lineTo(baseXP + perpP.x * arrowWidP, baseYP + perpP.y * arrowWidP);
    ctx.lineTo(baseXP - perpP.x * arrowWidP, baseYP - perpP.y * arrowWidP);
    ctx.closePath();
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();
    ctx.stroke();
    // base -> collector
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 2.5);
    ctx.lineTo(3 * cellSize, cellSize * 2.8);
    ctx.stroke();
    drawLabel(ctx, `β=${params.hfe}`, 1.8 * cellSize, 3.5 * cellSize);
  },
  getFlowPath() {
    // PNP: current flows Emitter→Collector. E(3,0) -> body (1.5,2) -> C(3,4)
    return [
      { x: 3, y: 0 },
      { x: 1.5, y: 2 },
      { x: 3, y: 4 },
    ];
  },
  stamp(params, terminals, sys, sim) {
    const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
    const hfe = params.hfe as number;
    const vebOn = params.veb as number;
    const vecSat = params.satV as number;

    const veb = sim.nodeVoltage[e] - sim.nodeVoltage[b];
    const vec = sim.nodeVoltage[e] - sim.nodeVoltage[c];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `pnp_${e}_${b}_${c}`;
    const prevOn = st[key] ?? false;
    const on = prevOn ? veb > vebOn - 0.1 : veb > vebOn;
    st[key] = on;
    if (!on) {
      sys.stampConductance(c, e, 1e-9);
      sys.stampConductance(b, e, 1e-9);
      return;
    }
    // E-B diode: Vsource vebOn between e (+) and b (-), creates branch current I_b
    // I_c = hfe * I_b, current from e to c
    const ibBranch = sys.stampVoltageSource(e, b, vebOn);
    sys.stampCCCS(e, c, ibBranch, hfe);
    // saturation clamp
    if (vec < vecSat) {
      sys.stampVoltageSource(e, c, vecSat);
    }
  },
  measure(params, terminals, sim) {
    const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
    return [
      { label: 'Veb', value: (sim.nodeVoltage[e] - sim.nodeVoltage[b]).toFixed(3), unit: 'V' },
      { label: 'Vec', value: (sim.nodeVoltage[e] - sim.nodeVoltage[c]).toFixed(3), unit: 'V' },
    ];
  },
};

// ----- NMOS MOSFET -----
const nmos: ComponentPlugin = {
  type: 'nmos',
  name: 'NMOS MOSFET',
  category: 'semiconductor',
  description: 'N-channel enhancement MOSFET. Threshold model: on when Vgs > Vth.',
  symbol: 'NMOS',
  boundingBox: { width: 3, height: 4 },
  terminals: [
    { id: 'd', label: 'D', position: { x: 3, y: 0 } },
    { id: 'g', label: 'G', position: { x: 0, y: 2 } },
    { id: 's', label: 'S', position: { x: 3, y: 4 } },
  ],
  parameters: [
    { key: 'vth', label: 'Threshold Vth', type: 'number', default: 2.0, unit: 'V', min: 0.1, max: 10, step: 0.1 },
    { key: 'kp', label: 'Transconductance Kp', type: 'number', default: 0.1, unit: 'A/V²', min: 0.001, max: 10, step: 0.01 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 0.1, unit: 'Ω', min: 0.001, max: 1000, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    // gate lead
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize);
    ctx.lineTo(cellSize, 2 * cellSize);
    ctx.stroke();
    // gate plate (vertical bar)
    ctx.beginPath();
    ctx.moveTo(cellSize, cellSize * 1.3);
    ctx.lineTo(cellSize, cellSize * 2.7);
    ctx.lineWidth = 2;
    ctx.stroke();
    // body line
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.3, cellSize * 1.2);
    ctx.lineTo(cellSize * 1.3, cellSize * 2.8);
    ctx.stroke();
    // drain & source leads
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 0);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.moveTo(3 * cellSize, cellSize * 2.8);
    ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.stroke();
    // channel segments (d-s broken)
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.3, cellSize * 1.5);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.moveTo(cellSize * 1.3, cellSize * 2);
    ctx.lineTo(3 * cellSize, cellSize * 2);
    ctx.moveTo(cellSize * 1.3, cellSize * 2.5);
    ctx.lineTo(3 * cellSize, cellSize * 2.8);
    ctx.stroke();
    // arrow on source (pointing inward for NMOS)
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, cellSize * 2.8);
    ctx.lineTo(2.7 * cellSize, cellSize * 2.6);
    ctx.lineTo(2.7 * cellSize, cellSize * 3.0);
    ctx.closePath();
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, `Vth=${params.vth}`, 1.8 * cellSize, 3.5 * cellSize);
  },
  getFlowPath() {
    // Drain (3,0) -> channel center (1.5,2) -> Source (3,4)
    return [
      { x: 3, y: 0 },
      { x: 1.5, y: 2 },
      { x: 3, y: 4 },
    ];
  },
  stamp(params, terminals, sys, sim) {
    const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
    const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
    const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
    const vth = params.vth as number;
    const ron = Math.max(0.001, params.ron as number);
    const vgs = sim.nodeVoltage[g] - sim.nodeVoltage[s];
    const vds = sim.nodeVoltage[d] - sim.nodeVoltage[s];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `nmos_${d}_${g}_${s}`;
    const prevOn = st[key] ?? false;
    const on = prevOn ? vgs > vth - 0.2 : vgs > vth;
    st[key] = on;
    if (!on) {
      sys.stampConductance(d, s, 1e-9);
      // gate is high-Z
      sys.stampConductance(g, s, 1e-12);
      return;
    }
    // On: if vds > (vgs - vth): saturation -> current source Id = Kp * (vgs-vth)^2
    // Else: linear region -> approximately a small resistor (ron)
    // For simplicity, model as a small resistor when on (linear-region switch model)
    // OR as a VCCS in saturation. Pick based on vds.
    const vov = vgs - vth;
    if (vds > vov && vov > 0) {
      // saturation: Id = Kp * vov^2 (current from d to s)
      const kp = params.kp as number;
      const id = kp * vov * vov;
      sys.stampCurrentSource(d, s, id);
      // also output resistance (channel modulation) — skip for simplicity
    } else {
      // linear: small resistor
      sys.stampConductance(d, s, 1 / ron);
    }
    // gate high-Z
    sys.stampConductance(g, s, 1e-12);
  },
  measure(params, terminals, sim) {
    const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
    const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
    const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
    return [
      { label: 'Vgs', value: (sim.nodeVoltage[g] - sim.nodeVoltage[s]).toFixed(3), unit: 'V' },
      { label: 'Vds', value: (sim.nodeVoltage[d] - sim.nodeVoltage[s]).toFixed(3), unit: 'V' },
    ];
  },
};

// ----- PMOS MOSFET -----
const pmos: ComponentPlugin = {
  type: 'pmos',
  name: 'PMOS MOSFET',
  category: 'semiconductor',
  description: 'P-channel enhancement MOSFET. Threshold model: on when Vgs < -Vth (i.e. Vsg > Vth).',
  symbol: 'PMOS',
  boundingBox: { width: 3, height: 4 },
  terminals: [
    { id: 's', label: 'S', position: { x: 3, y: 0 } },
    { id: 'g', label: 'G', position: { x: 0, y: 2 } },
    { id: 'd', label: 'D', position: { x: 3, y: 4 } },
  ],
  parameters: [
    { key: 'vth', label: 'Threshold |Vth|', type: 'number', default: 2.0, unit: 'V', min: 0.1, max: 10, step: 0.1 },
    { key: 'kp', label: 'Transconductance Kp', type: 'number', default: 0.1, unit: 'A/V²', min: 0.001, max: 10, step: 0.01 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 0.1, unit: 'Ω', min: 0.001, max: 1000, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize);
    ctx.lineTo(cellSize, 2 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cellSize, cellSize * 1.3);
    ctx.lineTo(cellSize, cellSize * 2.7);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.3, cellSize * 1.2);
    ctx.lineTo(cellSize * 1.3, cellSize * 2.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 0);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.moveTo(3 * cellSize, cellSize * 2.8);
    ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.3, cellSize * 1.5);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.moveTo(cellSize * 1.3, cellSize * 2);
    ctx.lineTo(3 * cellSize, cellSize * 2);
    ctx.moveTo(cellSize * 1.3, cellSize * 2.5);
    ctx.lineTo(3 * cellSize, cellSize * 2.8);
    ctx.stroke();
    // arrow on source (pointing OUTWARD for PMOS)
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, cellSize * 1.2);
    ctx.lineTo(2.7 * cellSize, cellSize * 1.4);
    ctx.lineTo(2.7 * cellSize, cellSize * 1.0);
    ctx.closePath();
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
    // small circle on gate to indicate PMOS
    ctx.beginPath();
    ctx.arc(cellSize * 1.15, 2 * cellSize, 2, 0, Math.PI * 2);
    ctx.stroke();
    drawLabel(ctx, `Vth=${params.vth}`, 1.8 * cellSize, 3.5 * cellSize);
  },
  getFlowPath() {
    // Source (3,0) -> channel (1.5,2) -> Drain (3,4) (PMOS: current flows S→D)
    return [
      { x: 3, y: 0 },
      { x: 1.5, y: 2 },
      { x: 3, y: 4 },
    ];
  },
  stamp(params, terminals, sys, sim) {
    const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
    const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
    const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
    const vth = params.vth as number;
    const ron = Math.max(0.001, params.ron as number);
    const vsg = sim.nodeVoltage[s] - sim.nodeVoltage[g];
    const vsd = sim.nodeVoltage[s] - sim.nodeVoltage[d];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `pmos_${s}_${g}_${d}`;
    const prevOn = st[key] ?? false;
    const on = prevOn ? vsg > vth - 0.2 : vsg > vth;
    st[key] = on;
    if (!on) {
      sys.stampConductance(s, d, 1e-9);
      sys.stampConductance(g, s, 1e-12);
      return;
    }
    const vov = vsg - vth;
    if (vsd > vov && vov > 0) {
      // saturation: Is = Kp * vov^2 (current from s to d)
      const kp = params.kp as number;
      const id = kp * vov * vov;
      sys.stampCurrentSource(s, d, id);
    } else {
      sys.stampConductance(s, d, 1 / ron);
    }
    sys.stampConductance(g, s, 1e-12);
  },
  measure(params, terminals, sim) {
    const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
    const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
    const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
    return [
      { label: 'Vsg', value: (sim.nodeVoltage[s] - sim.nodeVoltage[g]).toFixed(3), unit: 'V' },
      { label: 'Vsd', value: (sim.nodeVoltage[s] - sim.nodeVoltage[d]).toFixed(3), unit: 'V' },
    ];
  },
};

// ----- Op-Amp with Power Rails -----
const opampRails: ComponentPlugin = {
  type: 'opampRails',
  name: 'Op-Amp (real)',
  category: 'ic',
  description: 'Op-amp with V+ and V- power pins. Output clamps to rails. Use for realistic circuits.',
  symbol: 'OPR',
  boundingBox: { width: 4, height: 5 },
  terminals: [
    { id: 'in+', label: 'IN+', position: { x: 0, y: 1 } },
    { id: 'in-', label: 'IN-', position: { x: 0, y: 2 } },
    { id: 'v+', label: 'V+', position: { x: 2, y: 0 } },
    { id: 'v-', label: 'V-', position: { x: 2, y: 4 } },
    { id: 'out', label: 'OUT', position: { x: 4, y: 1.5 } },
  ],
  parameters: [
    { key: 'gain', label: 'Open-loop Gain', type: 'number', default: 1e5, unit: '', min: 1, max: 1e9, step: 100 },
    { key: 'railMargin', label: 'Rail Margin', type: 'number', default: 0.5, unit: 'V', min: 0, max: 5, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize * 1.2, cellSize);
    ctx.moveTo(0, 2 * cellSize);
    ctx.lineTo(cellSize * 1.2, 2 * cellSize);
    ctx.moveTo(2 * cellSize, 0);
    ctx.lineTo(2 * cellSize, cellSize * 0.6);
    ctx.moveTo(2 * cellSize, cellSize * 3.4);
    ctx.lineTo(2 * cellSize, 4 * cellSize);
    ctx.moveTo(cellSize * 2.8, 1.5 * cellSize);
    ctx.lineTo(4 * cellSize, 1.5 * cellSize);
    ctx.stroke();
    // triangle body
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 0.4);
    ctx.lineTo(cellSize * 1.2, cellSize * 3.6);
    ctx.lineTo(cellSize * 2.8, 1.5 * cellSize);
    ctx.closePath();
    ctx.fillStyle = '#fef3c7';
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, '+', cellSize * 1.5, cellSize);
    drawLabel(ctx, '−', cellSize * 1.5, 2 * cellSize);
    drawLabel(ctx, 'V+', 2 * cellSize + 6, cellSize * 0.3);
    drawLabel(ctx, 'V−', 2 * cellSize + 6, cellSize * 3.7);
  },
  stamp(params, terminals, sys, sim) {
    const gain = params.gain as number;
    const railMargin = params.railMargin as number;
    const inp = terminals.find((t) => t.terminalId === 'in+')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in-')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const vp = terminals.find((t) => t.terminalId === 'v+')!.nodeId;
    const vn = terminals.find((t) => t.terminalId === 'v-')!.nodeId;
    // Determine rails from V+/V- nodes (if connected to voltage sources, they have known voltages)
    const vPlus = sim.nodeVoltage[vp] || 12; // default 12V if not connected
    const vMinus = sim.nodeVoltage[vn] || -12;
    // Compute ideal output
    const vdiff = sim.nodeVoltage[inp] - sim.nodeVoltage[inn];
    const voutIdeal = gain * vdiff;
    // Clamp to rails
    const vHigh = vPlus - railMargin;
    const vLow = vMinus + railMargin;
    const vout = Math.max(vLow, Math.min(vHigh, voutIdeal));
    // Stamp as a voltage source (with limited gain -> just use the clamped value)
    sys.stampVoltageSource(out, 0, vout);
    // Power pins: high-Z
    sys.stampConductance(vp, 0, 1e-9);
    sys.stampConductance(vn, 0, 1e-9);
  },
  measure(params, terminals, sim) {
    const inp = terminals.find((t) => t.terminalId === 'in+')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in-')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const vp = terminals.find((t) => t.terminalId === 'v+')!.nodeId;
    return [
      { label: 'V+', value: sim.nodeVoltage[inp].toFixed(3), unit: 'V' },
      { label: 'V-', value: sim.nodeVoltage[inn].toFixed(3), unit: 'V' },
      { label: 'Vout', value: sim.nodeVoltage[out].toFixed(3), unit: 'V' },
      { label: 'Rail+', value: sim.nodeVoltage[vp].toFixed(1), unit: 'V' },
    ];
  },
};

// ----- 7-Segment Display -----
// 7-segment display with a-e, f, g, dp inputs.
// Segment layout:
//   _a_
// f|   |b
//   _g_
// e|   |c
//   _d_  dp
const segmentMap: Record<string, { x1: number; y1: number; x2: number; y2: number }> = {
  a: { x1: 0.25, y1: 0.05, x2: 0.75, y2: 0.05 },
  b: { x1: 0.85, y1: 0.1, x2: 0.85, y2: 0.45 },
  c: { x1: 0.85, y1: 0.55, x2: 0.85, y2: 0.9 },
  d: { x1: 0.25, y1: 0.95, x2: 0.75, y2: 0.95 },
  e: { x1: 0.15, y1: 0.55, x2: 0.15, y2: 0.9 },
  f: { x1: 0.15, y1: 0.1, x2: 0.15, y2: 0.45 },
  g: { x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 },
};

const sevenSegment: ComponentPlugin = {
  type: 'sevenSegment',
  name: '7-Segment',
  category: 'io',
  description: '7-segment display with a-g segment inputs (HIGH = on). Common cathode.',
  symbol: '7SEG',
  boundingBox: { width: 4, height: 6 },
  terminals: [
    { id: 'a', label: 'a', position: { x: 0, y: 0 } },
    { id: 'b', label: 'b', position: { x: 2, y: 0 } },
    { id: 'c', label: 'c', position: { x: 4, y: 0 } },
    { id: 'd', label: 'd', position: { x: 4, y: 6 } },
    { id: 'e', label: 'e', position: { x: 2, y: 6 } },
    { id: 'f', label: 'f', position: { x: 0, y: 6 } },
    { id: 'g', label: 'g', position: { x: 0, y: 3 } },
    { id: 'com', label: 'COM', position: { x: 4, y: 3 } },
  ],
  parameters: [
    { key: 'color', label: 'Color', type: 'select', default: 'red', options: [
      { label: 'Red', value: 'red' },
      { label: 'Green', value: 'green' },
      { label: 'Blue', value: 'blue' },
      { label: 'Yellow', value: 'yellow' },
      { label: 'White', value: 'white' },
    ] },
    { key: 'threshold', label: 'On Threshold', type: 'number', default: 2.0, unit: 'V', min: 0.1, max: 12, step: 0.1 },
  ],
  render(ctx, params, cellSize, sim) {
    const w = 4 * cellSize;
    const h = 6 * cellSize;
    // body
    ctx.fillStyle = '#0a0a0a';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(2, 2, w - 4, h - 4);
    ctx.fill();
    ctx.stroke();
    // segments
    const colorMap: Record<string, string> = {
      red: '#ff3333', green: '#33ff33', blue: '#3333ff', yellow: '#ffff33', white: '#ffffff',
    };
    const onColor = colorMap[params.color as string] ?? '#ff3333';
    const threshold = params.threshold as number;
    // pin labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = `${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pinLabels: { id: string; x: number; y: number; label: string }[] = [
      { id: 'a', x: 0, y: 0, label: 'a' },
      { id: 'b', x: 2 * cellSize, y: 0, label: 'b' },
      { id: 'c', x: 4 * cellSize, y: 0, label: 'c' },
      { id: 'd', x: 4 * cellSize, y: 6 * cellSize, label: 'd' },
      { id: 'e', x: 2 * cellSize, y: 6 * cellSize, label: 'e' },
      { id: 'f', x: 0, y: 6 * cellSize, label: 'f' },
      { id: 'g', x: 0, y: 3 * cellSize, label: 'g' },
      { id: 'com', x: 4 * cellSize, y: 3 * cellSize, label: 'COM' },
    ];
    for (const p of pinLabels) {
      ctx.fillStyle = '#64748b';
      ctx.fillText(p.label, p.x, p.y);
    }
    // draw each segment if its pin is HIGH
    // We don't have direct access to node voltages here without terminals; use sim.state if available
    // For now, store segment state in instance.simState from step()
    const segState = sim?.state?.__7seg as Record<string, boolean> | undefined;
    void threshold;
    for (const [seg, coords] of Object.entries(segmentMap)) {
      const on = segState?.[seg] ?? false;
      const x1 = coords.x1 * w;
      const y1 = coords.y1 * h;
      const x2 = coords.x2 * w;
      const y2 = coords.y2 * h;
      ctx.strokeStyle = on ? onColor : '#1f1f1f';
      ctx.lineWidth = on ? 4 : 3;
      ctx.shadowColor = on ? onColor : 'transparent';
      ctx.shadowBlur = on ? 8 : 0;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  },
  stamp(params, terminals, sys) {
    const threshold = params.threshold as number;
    // Each segment is a high-impedance input (we just sense voltage)
    const com = terminals.find((t) => t.terminalId === 'com')!.nodeId;
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const node = terminals.find((t) => t.terminalId === seg)!.nodeId;
      sys.stampConductance(node, com, 1e-9);
    }
    void threshold;
  },
  step(params, terminals, sim, instance) {
    const threshold = params.threshold as number;
    if (!instance.simState) instance.simState = {};
    if (!sim.state.__7seg) sim.state.__7seg = {};
    const segState: Record<string, boolean> = {};
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const node = terminals.find((t) => t.terminalId === seg)!.nodeId;
      segState[seg] = sim.nodeVoltage[node] > threshold;
    }
    sim.state.__7seg = segState;
  },
  measure(params, terminals, sim) {
    const segState = (sim.state.__7seg || {}) as Record<string, boolean>;
    const onSegs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter(s => segState[s]).join('');
    return [{ label: 'ON', value: onSegs || '—', unit: '' }];
  },
};

// ----- VCO (Voltage-Controlled Oscillator) -----
const vco: ComponentPlugin = {
  type: 'vco',
  name: 'VCO',
  category: 'ic',
  description: 'Voltage-controlled oscillator. Output frequency = baseFreq + sensitivity * V(in).',
  symbol: 'VCO',
  boundingBox: { width: 4, height: 3 },
  terminals: [
    { id: 'in', label: 'VIN', position: { x: 0, y: 1.5 } },
    { id: 'out', label: 'OUT', position: { x: 4, y: 1.5 } },
    { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 } },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 3 } },
  ],
  parameters: [
    { key: 'baseFreq', label: 'Base Frequency', type: 'number', default: 100, unit: 'Hz', min: 0.001, max: 1e6, step: 1 },
    { key: 'sensitivity', label: 'Sensitivity (Hz/V)', type: 'number', default: 1000, unit: 'Hz/V', min: 0, max: 1e6, step: 10 },
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, 1.5 * cellSize);
    ctx.lineTo(cellSize, 1.5 * cellSize);
    ctx.moveTo(3 * cellSize, 1.5 * cellSize);
    ctx.lineTo(4 * cellSize, 1.5 * cellSize);
    ctx.moveTo(2 * cellSize, 0);
    ctx.lineTo(2 * cellSize, cellSize * 0.6);
    ctx.moveTo(2 * cellSize, cellSize * 2.4);
    ctx.lineTo(2 * cellSize, 3 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(cellSize, cellSize * 0.6, 2 * cellSize, cellSize * 1.8);
    ctx.fillStyle = '#1e3a5f';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `bold ${Math.floor(cellSize * 0.7)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VCO', 2 * cellSize, 1.5 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const vccV = params.vcc as number;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const vin = terminals.find((t) => t.terminalId === 'in')!.nodeId;
    const vcc = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
    if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-9);
    sys.stampConductance(vin, gnd, 1e-9);
    // compute frequency
    const vIn = sim.nodeVoltage[vin];
    const freq = Math.max(0.001, (params.baseFreq as number) + (params.sensitivity as number) * vIn);
    const key = `vco_${out}`;
    const st = sim.state[key] ?? (sim.state[key] = { phase: 0 });
    // advance phase
    st.phase = (st.phase + freq * sim.dt) % 1;
    const high = st.phase < 0.5;
    if (out !== gnd) sys.stampVoltageSource(out, gnd, high ? vccV : 0);
  },
  measure(params, terminals, sim) {
    const vin = terminals.find((t) => t.terminalId === 'in')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const vIn = sim.nodeVoltage[vin];
    const freq = Math.max(0.001, (params.baseFreq as number) + (params.sensitivity as number) * vIn);
    return [
      { label: 'Vin', value: vIn.toFixed(3), unit: 'V' },
      { label: 'Vout', value: sim.nodeVoltage[out].toFixed(2), unit: 'V' },
      { label: 'Freq', value: freq >= 1000 ? `${(freq / 1000).toFixed(2)}k` : freq.toFixed(1), unit: 'Hz' },
    ];
  },
};

// ----- Crystal Oscillator (simplified: just emits a fixed-frequency square wave) -----
const crystal: ComponentPlugin = {
  type: 'crystal',
  name: 'Crystal Osc',
  category: 'ic',
  description: 'Crystal oscillator (simplified). Emits a square wave at the specified frequency.',
  symbol: 'XTAL',
  boundingBox: { width: 3, height: 2 },
  terminals: [
    { id: 'out', label: 'OUT', position: { x: 3, y: 1 } },
    { id: 'gnd', label: 'GND', position: { x: 0, y: 1 } },
  ],
  parameters: [
    { key: 'frequency', label: 'Frequency', type: 'number', default: 16000000, unit: 'Hz', min: 1, max: 1e9, step: 1 },
    { key: 'vcc', label: 'Output High (V)', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(2 * cellSize, cellSize);
    ctx.lineTo(3 * cellSize, cellSize);
    ctx.stroke();
    // crystal symbol: two vertical bars + enclosing rectangle
    ctx.translate(1.5 * cellSize, cellSize);
    ctx.beginPath();
    ctx.rect(-cellSize * 0.5, -8, cellSize, 16);
    ctx.strokeStyle = '#94a3b8';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-3, -8);
    ctx.lineTo(-3, 8);
    ctx.moveTo(3, -8);
    ctx.lineTo(3, 8);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e2e8f0';
    ctx.stroke();
    drawLabel(ctx, formatFreq(params.frequency as number), 0, -14);
  },
  stamp(params, terminals, sys, sim) {
    const freq = params.frequency as number;
    const vccV = params.vcc as number;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const key = `xtal_${out}`;
    const st = sim.state[key] ?? (sim.state[key] = { phase: 0 });
    st.phase = (st.phase + freq * sim.dt) % 1;
    const high = st.phase < 0.5;
    if (out !== gnd) sys.stampVoltageSource(out, gnd, high ? vccV : 0);
    if (gnd !== 0) sys.stampConductance(gnd, 0, 1e-9);
  },
  measure(params, terminals, sim) {
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    return [
      { label: 'Vout', value: sim.nodeVoltage[out].toFixed(2), unit: 'V' },
      { label: 'Freq', value: formatFreq(params.frequency as number), unit: 'Hz' },
    ];
  },
};

function formatFreq(f: number): string {
  if (f >= 1e9) return `${(f / 1e9).toFixed(2)}G`;
  if (f >= 1e6) return `${(f / 1e6).toFixed(2)}M`;
  if (f >= 1e3) return `${(f / 1e3).toFixed(2)}k`;
  return f.toFixed(0);
}

// ----- Transformer (1:1 ideal, configurable turns ratio) -----
const transformer: ComponentPlugin = {
  type: 'transformer',
  name: 'Transformer',
  category: 'passive',
  description: 'Ideal transformer with turns ratio N = Ns/Np. Two windings, galvanically isolated.',
  symbol: 'TR',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'p1', label: 'P1', position: { x: 0, y: 1 } },
    { id: 'p2', label: 'P2', position: { x: 0, y: 3 } },
    { id: 's1', label: 'S1', position: { x: 4, y: 1 } },
    { id: 's2', label: 'S2', position: { x: 4, y: 3 } },
  ],
  parameters: [
    { key: 'ratio', label: 'Turns Ratio (Ns/Np)', type: 'number', default: 1, unit: '', min: 0.001, max: 100, step: 0.1 },
    { key: 'lm', label: 'Magnetizing L', type: 'number', default: 0.01, unit: 'H', min: 1e-6, max: 100, step: 1e-3 },
  ],
  render(ctx, params, cellSize) {
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize * 1.5, cellSize);
    ctx.moveTo(0, 3 * cellSize);
    ctx.lineTo(cellSize * 1.5, 3 * cellSize);
    ctx.moveTo(cellSize * 2.5, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.moveTo(cellSize * 2.5, 3 * cellSize);
    ctx.lineTo(4 * cellSize, 3 * cellSize);
    ctx.stroke();
    // primary coil (left)
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const cy = cellSize + (i + 0.5) * (2 * cellSize / 4);
      ctx.arc(cellSize * 1.5, cy, cellSize * 0.2, Math.PI, 0, false);
    }
    ctx.stroke();
    // secondary coil (right)
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const cy = cellSize + (i + 0.5) * (2 * cellSize / 4);
      ctx.arc(cellSize * 2.5, cy, cellSize * 0.2, 0, Math.PI, false);
    }
    ctx.stroke();
    // core (two vertical lines)
    ctx.beginPath();
    ctx.moveTo(cellSize * 2, cellSize * 0.8);
    ctx.lineTo(cellSize * 2, 3 * cellSize * 1.0);
    ctx.moveTo(cellSize * 2.05, cellSize * 0.8);
    ctx.lineTo(cellSize * 2.05, 3 * cellSize * 1.0);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.stroke();
    drawLabel(ctx, `${params.ratio}:1`, 2 * cellSize, 3.5 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    // Simplified model: V_s1 - V_s2 = N * (V_p1 - V_p2)
    // And current mirrors. Use VCVS for voltage, CCCS for current.
    const n = params.ratio as number;
    const p1 = terminals.find((t) => t.terminalId === 'p1')!.nodeId;
    const p2 = terminals.find((t) => t.terminalId === 'p2')!.nodeId;
    const s1 = terminals.find((t) => t.terminalId === 's1')!.nodeId;
    const s2 = terminals.find((t) => t.terminalId === 's2')!.nodeId;
    // VCVS: V(s1) - V(s2) = N * (V(p1) - V(p2))
    sys.stampVCVS(s1, s2, p1, p2, n);
    // The corresponding primary current is N * secondary current.
    // We need to add a CCVS to capture secondary branch current, then CCCS on primary.
    // The VCVS above already added a branch index for the secondary current; capture it.
    // Unfortunately our API doesn't return the index from stampVCVS in a tracked way.
    // As a simpler approximation, also stamp a parallel magnetizing inductance on the primary
    // to give the primary a defined current path.
    const lm = Math.max(1e-6, params.lm as number);
    const dt = Math.max(sim.dt, 1e-12);
    sys.stampConductance(p1, p2, dt / lm);
  },
  measure(params, terminals, sim) {
    const p1 = terminals.find((t) => t.terminalId === 'p1')!.nodeId;
    const p2 = terminals.find((t) => t.terminalId === 'p2')!.nodeId;
    const s1 = terminals.find((t) => t.terminalId === 's1')!.nodeId;
    const s2 = terminals.find((t) => t.terminalId === 's2')!.nodeId;
    return [
      { label: 'Vp', value: (sim.nodeVoltage[p1] - sim.nodeVoltage[p2]).toFixed(3), unit: 'V' },
      { label: 'Vs', value: (sim.nodeVoltage[s1] - sim.nodeVoltage[s2]).toFixed(3), unit: 'V' },
    ];
  },
};

// ----- Speaker (modeled as 8Ω resistor + sound output indicator) -----
const speaker: ComponentPlugin = {
  type: 'speaker',
  name: 'Speaker',
  category: 'io',
  description: '8Ω speaker. Visual indicator shows when current flows. Will produce audio in future.',
  symbol: 'SPK',
  boundingBox: { width: 3, height: 2 },
  terminals: [
    { id: 'a', label: '+', position: { x: 0, y: 1 } },
    { id: 'b', label: '-', position: { x: 3, y: 1 } },
  ],
  parameters: [
    { key: 'impedance', label: 'Impedance', type: 'number', default: 8, unit: 'Ω', min: 1, max: 1000, step: 1 },
  ],
  render(ctx, params, cellSize, sim, instance) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.stroke();
    // speaker body (trapezoid)
    ctx.beginPath();
    ctx.moveTo(cellSize, cellSize - 4);
    ctx.lineTo(cellSize, cellSize + 4);
    ctx.lineTo(2 * cellSize, cellSize + 10);
    ctx.lineTo(2 * cellSize, cellSize - 10);
    ctx.closePath();
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
    // Get actual current through speaker from simState (set by canvas before render).
    // Physics: sound intensity ∝ electrical power = I²·R. We map current to a
    // 0..1 activity factor: activity = clamp(|I| / 100mA, 0, 1).
    // Only animate when simulation is running AND current is non-zero.
    const current = (instance?.simState?.__current as number) ?? 0;
    const absCurrent = Math.abs(current);
    const isSimRunning = sim != null && instance != null;
    const minCurrent = 0.0001; // 0.1 mA minimum
    const activity = isSimRunning && absCurrent > minCurrent
      ? Math.min(1, absCurrent / 0.1) // full activity at 100mA
      : 0;
    // sound waves — animated when active, amplitude scales with current
    const waveOffset = activity > 0.01 ? (sim!.time * 8) % 1 : 0;
    const waveAmp = activity; // 0..1
    ctx.strokeStyle = activity > 0.01 ? '#22d3ee' : '#475569';
    ctx.lineWidth = 1.5 + activity * 1.5;
    ctx.beginPath();
    const r1 = 5 + waveAmp * Math.sin(waveOffset * Math.PI * 2) * 2;
    const r2 = 9 + waveAmp * Math.sin(waveOffset * Math.PI * 2 + 1) * 2.5;
    ctx.arc(2 * cellSize, cellSize, r1, -Math.PI / 3, Math.PI / 3);
    ctx.moveTo(2 * cellSize + r2 * Math.cos(Math.PI / 3), cellSize - r2 * Math.sin(Math.PI / 3));
    ctx.arc(2 * cellSize, cellSize, r2, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
    if (activity > 0.01) {
      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 4 + activity * 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // wire to right
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, cellSize);
    ctx.lineTo(3 * cellSize, cellSize);
    ctx.strokeStyle = '#e2e8f0';
    ctx.stroke();
  },
  stamp(params, terminals, sys) {
    const r = Math.max(0.1, params.impedance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    sys.stampConductance(a, b, 1 / r);
  },
  measure(params, terminals, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    const r = Math.max(0.1, params.impedance as number);
    const i = v / r;
    const p = v * i;
    return [
      { label: 'V', value: v.toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(2), unit: 'mA' },
      { label: 'P', value: (p * 1000).toFixed(2), unit: 'mW' },
    ];
  },
};

// ----- Photoresistor (LDR) -----
const photoresistor: ComponentPlugin = {
  type: 'photoresistor',
  name: 'Photoresistor',
  category: 'passive',
  description: 'Light-dependent resistor. Resistance = darkR - (darkR - lightR) * light (0..1).',
  symbol: 'LDR',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'darkR', label: 'Dark Resistance', type: 'number', default: 1000000, unit: 'Ω', min: 1, max: 1e9, step: 1000 },
    { key: 'lightR', label: 'Light Resistance', type: 'number', default: 1000, unit: 'Ω', min: 0.1, max: 1e6, step: 100 },
    { key: 'light', label: 'Light Level', type: 'number', default: 0.5, unit: '', min: 0, max: 1, step: 0.05 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(3 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    // resistor body in dashed circle (LDR convention)
    ctx.beginPath();
    ctx.moveTo(-cellSize, 0);
    for (let i = 0; i < 6; i++) {
      const x = -cellSize + (i + 0.5) * (2 * cellSize / 6);
      const y = (i % 2 === 0 ? -1 : 1) * 6;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(cellSize, 0);
    ctx.stroke();
    // arrows pointing in (light)
    ctx.strokeStyle = '#fbbf24';
    ctx.beginPath();
    ctx.moveTo(-10, -14);
    ctx.lineTo(-4, -8);
    ctx.moveTo(-4, -8);
    ctx.lineTo(-7, -8);
    ctx.moveTo(-4, -8);
    ctx.lineTo(-4, -11);
    ctx.moveTo(-3, -16);
    ctx.lineTo(3, -10);
    ctx.moveTo(3, -10);
    ctx.lineTo(0, -10);
    ctx.moveTo(3, -10);
    ctx.lineTo(3, -13);
    ctx.stroke();
    drawLabel(ctx, `${((params.light as number) * 100).toFixed(0)}%`, 0, 14);
  },
  stamp(params, terminals, sys) {
    const darkR = params.darkR as number;
    const lightR = params.lightR as number;
    const light = Math.max(0, Math.min(1, params.light as number));
    const r = darkR + (lightR - darkR) * light;
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    sys.stampConductance(a, b, 1 / Math.max(1e-6, r));
  },
  measure(params, terminals, sim) {
    const darkR = params.darkR as number;
    const lightR = params.lightR as number;
    const light = Math.max(0, Math.min(1, params.light as number));
    const r = darkR + (lightR - darkR) * light;
    return [{ label: 'R', value: r >= 1000 ? `${(r / 1000).toFixed(2)}k` : r.toFixed(1), unit: 'Ω' }];
  },
};

registerPlugin(pnp);
registerPlugin(nmos);
registerPlugin(pmos);
registerPlugin(opampRails);
registerPlugin(sevenSegment);
registerPlugin(vco);
registerPlugin(crystal);
registerPlugin(transformer);
registerPlugin(speaker);
registerPlugin(photoresistor);

export { pnp, nmos, pmos, opampRails, sevenSegment, vco, crystal, transformer, speaker, photoresistor };
