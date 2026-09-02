// Additional semiconductors: PNP BJT, NMOS/PMOS MOSFETs, op-amp with power rails,
// 7-segment display, VCO, crystal oscillator, transformer, speaker, photoresistor.

import type { ComponentPlugin, CircuitComponent } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';

// ----- PNP BJT (mirror of NPN) -----
const pnp: ComponentPlugin = {
  type: 'pnp',
  name: 'PNP Transistor',
  category: 'semiconductor',
  description: 'PNP BJT with simple piecewise-linear model. Use as a switch (high-side).',
  symbol: 'PNP',
  nonLinear: true,
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
  stamp(params, terminals, sys, sim, comp) {
    const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
    const hfe = params.hfe as number;
    const vebOn = params.veb as number;
    const vecSat = params.satV as number;

    const veb = sim.nodeVoltage[e] - sim.nodeVoltage[b];
    const vec = sim.nodeVoltage[e] - sim.nodeVoltage[c];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('pnp', comp, e, b, c);
    const prevOn = st[key] ?? false;
    // Previous step's actual base current (through the e-b voltage source).
    // Used to detect when external drive is removed (see NPN comment).
    const prevIb = (st[key + '_ib'] as number) ?? 0;
    const on = prevOn
      ? (veb > vebOn - 0.1 && prevIb > 1e-9)
      : (veb > vebOn);
    st[key] = on;
    if (!on) {
      sys.stampConductance(c, e, 1e-13);
      sys.stampConductance(b, e, 1e-13);
      st[key + '_ib'] = 0;
      st[key + '_branch'] = -1;
      return;
    }
    // On: E-B diode (Vsource vebOn) and CCCS from e→c of gain hfe.
    // When external base drive stops, the branch current → 0, so I_C → 0
    // even though V_EB stays at vebOn.
    const ibBranch = sys.stampVoltageSource(e, b, vebOn);
    sys.stampCCCS(e, c, ibBranch, hfe);
    st[key + '_branch'] = ibBranch;
    // Saturation clamp: only when there's actual collector current.
    const prevIc = hfe * prevIb;
    if (prevIc > 1e-9 && vec < vecSat) {
      sys.stampConductance(e, c, 100);
    }
    // Reverse-Vec protection (mirror of NPN fix): if Vec goes negative
    // (collector above emitter — PNP reverse-active region), clamp so the
    // collector node can't run away to hundreds of volts.
    if (vec < -vecSat) {
      sys.stampConductance(c, e, 10);
    }
  },
  step(params, terminals, sim, instance) {
    const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('pnp', instance, e, b, c);
    const branchIdx = st[key + '_branch'] as number;
    if (branchIdx == null || branchIdx < 0) {
      st[key + '_ib'] = 0;
      return;
    }
    const numNonGround = sim.nodeVoltage.length - 1;
    const relIdx = branchIdx - numNonGround;
    if (relIdx < 0 || relIdx >= sim.branchCurrent.length) {
      st[key + '_ib'] = 0;
      return;
    }
    st[key + '_ib'] = sim.branchCurrent[relIdx];
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
  nonLinear: true,
  boundingBox: { width: 3, height: 4 },
  terminals: [
    { id: 'd', label: 'D', position: { x: 3, y: 0 } },
    { id: 'g', label: 'G', position: { x: 0, y: 2 } },
    { id: 's', label: 'S', position: { x: 3, y: 4 } },
  ],
  parameters: [
    { key: 'vth', label: 'Threshold Vth', type: 'number', default: 2.0, unit: 'V', min: 0.1, max: 10, step: 0.1 },
    { key: 'kp', label: 'Transconductance Kp', type: 'number', default: 0.1, unit: 'A/V²', min: 0.001, max: 10, step: 0.01 },
    { key: 'lambda', label: 'Channel-Length Mod (λ)', type: 'number', default: 0.02, unit: 'V⁻¹', min: 0, max: 1, step: 0.005 },
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
  stamp(params, terminals, sys, sim, comp) {
    const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
    const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
    const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
    const vth = params.vth as number;
    const ron = Math.max(0.001, params.ron as number);
    const vgs = sim.nodeVoltage[g] - sim.nodeVoltage[s];
    const vds = sim.nodeVoltage[d] - sim.nodeVoltage[s];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('nmos', comp, d, g, s);
    const prevOn = st[key] ?? false;
    const on = prevOn ? vgs > vth - 0.2 : vgs > vth;
    st[key] = on;
    if (!on) {
      sys.stampConductance(d, s, 1e-13);
      // gate is high-Z
      sys.stampConductance(g, s, 1e-6);
      return;
    }
    // On: if vds > (vgs - vth): saturation -> current source Id = ½·Kp·(vgs−vth)²
    // Else: linear region -> approximately a small resistor (ron)
    // Pick based on vds.
    const vov = vgs - vth;
    if (vds > vov && vov > 0) {
      // saturation: Id = ½·Kp·vov² (SPICE Level-1 square law — the ½ was
      // missing, doubling every saturation current)
      const kp = params.kp as number;
      const lambda = (params.lambda as number) ?? 0.02; // default 0.02 V^-1
      const id = 0.5 * kp * vov * vov;
      sys.stampCurrentSource(d, s, id);
      // Output conductance: gds = lambda * Id (limits gain in amplifiers)
      const gds = lambda * Math.abs(id);
      sys.stampConductance(d, s, Math.max(gds, 1e-12));
    } else {
      // linear: small resistor
      sys.stampConductance(d, s, 1 / ron);
    }
    // gate high-Z
    sys.stampConductance(g, s, 1e-6);
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
  nonLinear: true,
  boundingBox: { width: 3, height: 4 },
  terminals: [
    { id: 's', label: 'S', position: { x: 3, y: 0 } },
    { id: 'g', label: 'G', position: { x: 0, y: 2 } },
    { id: 'd', label: 'D', position: { x: 3, y: 4 } },
  ],
  parameters: [
    { key: 'vth', label: 'Threshold |Vth|', type: 'number', default: 2.0, unit: 'V', min: 0.1, max: 10, step: 0.1 },
    { key: 'kp', label: 'Transconductance Kp', type: 'number', default: 0.1, unit: 'A/V²', min: 0.001, max: 10, step: 0.01 },
    { key: 'lambda', label: 'Channel-Length Mod (λ)', type: 'number', default: 0.02, unit: 'V⁻¹', min: 0, max: 1, step: 0.005 },
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
  stamp(params, terminals, sys, sim, comp) {
    const s = terminals.find((t) => t.terminalId === 's')!.nodeId;
    const g = terminals.find((t) => t.terminalId === 'g')!.nodeId;
    const d = terminals.find((t) => t.terminalId === 'd')!.nodeId;
    // Use |Vth| as the threshold magnitude: the plugin's default is +2.0 but
    // SPICE imports carry a negative PMOS Vto — a raw `vsg > vth` with a
    // negative vth made the device conduct even with gate = source.
    const vthMag = Math.abs(params.vth as number);
    const ron = Math.max(0.001, params.ron as number);
    const vsg = sim.nodeVoltage[s] - sim.nodeVoltage[g];
    const vsd = sim.nodeVoltage[s] - sim.nodeVoltage[d];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('pmos', comp, s, g, d);
    const prevOn = st[key] ?? false;
    const on = prevOn ? vsg > vthMag - 0.2 : vsg > vthMag;
    st[key] = on;
    if (!on) {
      sys.stampConductance(s, d, 1e-13);
      sys.stampConductance(g, s, 1e-6);
      return;
    }
    const vov = vsg - vthMag;
    if (vsd > vov && vov > 0) {
      // saturation: Is = ½·Kp·vov² (current from s to d) — SPICE Level-1
      // square law with the ½ factor (was missing, doubling the current)
      const kp = params.kp as number;
      const lambda = (params.lambda as number) ?? 0.02;
      const id = 0.5 * kp * vov * vov;
      sys.stampCurrentSource(s, d, id);
      // Output conductance (channel modulation / Early effect)
      const gds = lambda * Math.abs(id);
      sys.stampConductance(s, d, Math.max(gds, 1e-12));
    } else {
      sys.stampConductance(s, d, 1 / ron);
    }
    sys.stampConductance(g, s, 1e-6);
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
    { key: 'rout', label: 'Output Resistance', type: 'number', default: 100, unit: 'Ω', min: 0.01, max: 1e6, step: 1 },
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
  stamp(params, terminals, sys, sim, comp) {
    const gain = params.gain as number;
    const railMargin = params.railMargin as number;
    const rOut = Math.max(0.01, (params.rout as number) ?? 100);
    const inp = terminals.find((t) => t.terminalId === 'in+')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in-')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const vp = terminals.find((t) => t.terminalId === 'v+')!.nodeId;
    const vn = terminals.find((t) => t.terminalId === 'v-')!.nodeId;
    // Determine rails from the V+/V− node voltages. An unconnected pin maps
    // to node 0 (0 V) in this engine — indistinguishable from a grounded pin
    // by voltage alone. Heuristic: if BOTH pins sit at node 0, treat them as
    // unconnected and use the ±12 V defaults; if only one is at node 0 it is
    // a deliberate ground (e.g. a single-supply op-amp) and must be honored —
    // the old `|| 12` turned every grounded V− into −12 V.
    const bothRailsFloating = vp === 0 && vn === 0;
    const vPlus = bothRailsFloating ? 12 : (sim.nodeVoltage[vp] ?? 12);
    const vMinus = bothRailsFloating ? -12 : (sim.nodeVoltage[vn] ?? -12);
    const vHigh = vPlus - railMargin;
    const vLow = vMinus + railMargin;
    // Boyle-style macromodel (same structure as the P3 LM324/NE5532):
    //   linear region  → VCCS gm·(V+ − V−) into out, || 1/rout to ground.
    //     gm·rout = gain reproduces the open-loop gain, and because the gm
    //     term is stamped INTO the matrix the closed-loop solve is a purely
    //     linear one-shot problem — the previous-voltage voltage-source
    //     stamp diverged rail-to-rail every step in any feedback circuit
    //     (gain 1e5 × per-step relaxation = oscillator, not amplifier).
    //   saturated      → Thevenin at the rail-limited level through rout.
    // Region selection uses the previous-iterate open-loop prediction ONLY
    // to pick the region; saturation always exits THROUGH the linear region
    // so the output can never jump straight from one rail to the other.
    const vRaw = gain * (sim.nodeVoltage[inp] - sim.nodeVoltage[inn]);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('opampRails', comp, out);
    let region = (st[key] as number | undefined) ?? 0; // 0 linear, +1 hi, −1 lo
    if (region === 0) {
      if (vRaw > vHigh) region = 1;
      else if (vRaw < vLow) region = -1;
    } else if (region === 1) {
      if (vRaw < vHigh) region = 0;
    } else {
      if (vRaw > vLow) region = 0;
    }
    st[key] = region;
    // gmin-style input leak (1GΩ) keeps floating input nets solvable
    sys.stampConductance(inp, 0, 1e-9);
    sys.stampConductance(inn, 0, 1e-9);
    if (out === 0) return; // unconnected output — nothing to drive
    if (region === 0) {
      // Linear: I(out) = gm·(V+ − V−) delivered into 1/rout.
      // stampVCCS(0, out, inp, inn, gm): current from ground into out =
      // gm·(V+−V−) — the op-amp output sources the transconductance current.
      const gm = gain / rOut;
      sys.stampConductance(out, 0, 1 / rOut);
      sys.stampVCCS(0, out, inp, inn, gm);
    } else {
      // Saturated: Thevenin at the rail-limited level through rout.
      const vSat = region > 0 ? vHigh : vLow;
      sys.stampConductance(out, 0, 1 / rOut);
      sys.stampCurrentSource(0, out, vSat / rOut);
    }
    // Power pins: high-Z
    sys.stampConductance(vp, 0, 1e-13);
    sys.stampConductance(vn, 0, 1e-13);
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
  render(ctx, params, cellSize, sim, instance) {
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
    // Use per-instance state set by step()
    const segState = (instance?.simState?.__7seg as Record<string, boolean> | undefined);
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
  stamp(params, terminals, sys, sim, comp) {
    const threshold = params.threshold as number;
    const com = terminals.find((t) => t.terminalId === 'com')!.nodeId;
    const comV = sim.nodeVoltage[com] ?? 0;
    const rSeg = 220; // internal segment resistance (Ω)
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('7seg', comp, ...terminals.map(t => t.nodeId));
    if (!st[key]) st[key] = {};
    const segStates = st[key] as Record<string, boolean>;

    // Multiplexing support: when com is HIGH (≥ VCC/2), the display is INACTIVE.
    // Retain the last latched segment states (don't update). This allows
    // multiplexed displays to hold their values between refreshes.
    // When com is LOW (< VCC/2), the display is ACTIVE — update segment states.
    const vccApprox = 5; // typical VCC
    const isActive = comV < vccApprox * 0.5;

    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const node = terminals.find((t) => t.terminalId === seg)!.nodeId;
      if (isActive) {
        const v = sim.nodeVoltage[node] - sim.nodeVoltage[com];
        const prevOn = segStates[seg] ?? false;
        const on = prevOn ? v > threshold * 0.5 : v > threshold;
        segStates[seg] = on;
        if (on) {
          sys.stampConductance(node, com, 1 / rSeg);
        } else {
          sys.stampConductance(node, com, 1e-13);
        }
      } else {
        // Inactive: high impedance, keep latched state
        sys.stampConductance(node, com, 1e-13);
      }
    }
  },
  step(params, terminals, sim, instance) {
    if (!instance.simState) instance.simState = {};
    // stamp() (which runs before the solve) already computed the segment
    // states with the authoritative rule: com-referenced segment voltage,
    // threshold hysteresis, and multiplex latching. Reuse it — the old step()
    // recomputed with a DIFFERENT rule (ground-referenced, no hysteresis)
    // into a different store, so the rendered digit could disagree with the
    // electrical loading stamped into the matrix.
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('7seg', instance, ...terminals.map(t => t.nodeId));
    instance.simState.__7seg = (st[key] ?? {}) as Record<string, boolean>;
  },
  measure(params, terminals, sim, comp) {
    const st = (sim.state as any).__global ?? {};
    const key = stateKey('7seg', comp, ...terminals.map(t => t.nodeId));
    const segState = (st[key] || {}) as Record<string, boolean>;
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
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const vin = terminals.find((t) => t.terminalId === 'in')!.nodeId;
    const vcc = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
    if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    sys.stampConductance(vin, gnd, 1e-6);
    // compute frequency
    const vIn = sim.nodeVoltage[vin];
    const freq = Math.max(0.001, (params.baseFreq as number) + (params.sensitivity as number) * vIn);
    const key = stateKey('vco', comp, out);
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
  stamp(params, terminals, sys, sim, comp) {
    const freq = params.frequency as number;
    const vccV = params.vcc as number;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const key = stateKey('xtal', comp, out);
    const st = sim.state[key] ?? (sim.state[key] = { phase: 0 });
    st.phase = (st.phase + freq * sim.dt) % 1;
    const high = st.phase < 0.5;
    if (out !== gnd) sys.stampVoltageSource(out, gnd, high ? vccV : 0);
    if (gnd !== 0) sys.stampConductance(gnd, 0, 1e-13);
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

// State key for the CD4026 counter — keyed by component id (survives node
// renumbering); terminal-id/node-id fallback only for hand-built stamps.
function cd4026Key(terminals: { terminalId: string; nodeId: number }[], comp?: CircuitComponent): string {
  if (comp?.id) return `cd4026_${comp.id}`;
  return 'cd4026_' + terminals.map(t => `${t.terminalId}=${t.nodeId}`).join('_');
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
  stamp(params, terminals, sys, sim, comp) {
    // Ideal transformer: V(s1)−V(s2) = N·(V(p1)−V(p2)) and the reflected
    // primary current I(p1→p2) = −N·I(s1→s2, inside the source) — power
    // conserving. Plus a parallel magnetizing conductance on the primary.
    const n = params.ratio as number;
    const p1 = terminals.find((t) => t.terminalId === 'p1')!.nodeId;
    const p2 = terminals.find((t) => t.terminalId === 'p2')!.nodeId;
    const s1 = terminals.find((t) => t.terminalId === 's1')!.nodeId;
    const s2 = terminals.find((t) => t.terminalId === 's2')!.nodeId;
    // VCVS: V(s1) - V(s2) = N * (V(p1) - V(p2)); its branch current is the
    // secondary current flowing s1→s2 through the source.
    const vcvsIdx = sys.stampVCVS(s1, s2, p1, p2, n);
    // Reflect the secondary current into the primary. Without this CCCS the
    // secondary delivered power that the primary never drew — the transformer
    // created energy from nothing (10 W out, 0.01 W in).
    if (vcvsIdx >= 0) {
      sys.stampCCCS(p1, p2, vcvsIdx, -n);
    }
    // Record the branch index so computeComponentCurrents can add the
    // reflected current to the primary current readout.
    const stR = sim.state.__global ?? (sim.state.__global = {});
    stR[`xfmr_branch_${comp?.id ?? `${p1}_${p2}`}`] = vcvsIdx;
    // Magnetizing inductance across the primary — full backward-Euler
    // companion: G = dt/Lm in PARALLEL with the history current source
    // i_prev (the plain conductance alone was a lossy resistor that never
    // integrated the magnetizing current and dissipated real power).
    const lm = Math.max(1e-6, params.lm as number);
    const dt = Math.max(sim.dt ?? 1e-4, 1e-12);
    const stL = sim.state.__global ?? (sim.state.__global = {});
    const keyL = stateKey('xfmr_lm', comp, p1, p2);
    const iLprev = (stL[keyL + '_i'] as number | undefined) ?? 0;
    sys.stampConductance(p1, p2, dt / lm);
    if (iLprev !== 0) sys.stampCurrentSource(p1, p2, iLprev);
  },
  step(params, terminals, sim, comp) {
    // integrate the magnetizing current: i_n = (dt/Lm)·v_n + i_{n−1}
    const p1 = terminals.find((t) => t.terminalId === 'p1')!.nodeId;
    const p2 = terminals.find((t) => t.terminalId === 'p2')!.nodeId;
    const lm = Math.max(1e-6, params.lm as number);
    const dt = Math.max(sim.dt ?? 1e-4, 1e-12);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('xfmr_lm', comp, p1, p2);
    const iPrev = (st[key + '_i'] as number | undefined) ?? 0;
    const v = (sim.nodeVoltage[p1] ?? 0) - (sim.nodeVoltage[p2] ?? 0);
    st[key + '_i'] = (dt / lm) * v + iPrev;
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

// ─────────────────────────────────────────────────────────────────────────────
// CD4026 — Decade Counter with 7-Segment Decoder
//
// A classic CMOS IC that:
//   - Counts 0 to (maxCount-1) on each rising edge of CLK
//   - Drives 7 segment outputs (a-g) directly to drive a 7-seg display
//   - Outputs a carry signal (CO) that goes HIGH for the first half of the count
//     cycle, clocking the next CD4026 on its rising edge (when this wraps to 0)
//   - Has an active-high reset (RST) that forces count to 0
//
// Used in clock circuits: chain 6 of them (sec-ones → sec-tens → min-ones → ... → hr-tens)
// with maxCount=6 for tens digits and maxCount=10 for ones digits.
// ─────────────────────────────────────────────────────────────────────────────

// 7-segment patterns for digits 0-9 (1 = ON, 0 = OFF)
// Segment order: a, b, c, d, e, f, g
const SEG_PATTERNS: Record<number, number[]> = {
  0: [1, 1, 1, 1, 1, 1, 0],
  1: [0, 1, 1, 0, 0, 0, 0],
  2: [1, 1, 0, 1, 1, 0, 1],
  3: [1, 1, 1, 1, 0, 0, 1],
  4: [0, 1, 1, 0, 0, 1, 1],
  5: [1, 0, 1, 1, 0, 1, 1],
  6: [1, 0, 1, 1, 1, 1, 1],
  7: [1, 1, 1, 0, 0, 0, 0],
  8: [1, 1, 1, 1, 1, 1, 1],
  9: [1, 1, 1, 1, 0, 1, 1],
};

const cd4026: ComponentPlugin = {
  type: 'cd4026',
  name: 'CD4026 Counter',
  category: 'ic',
  description: 'Decade counter with built-in 7-segment decoder. Counts on CLK rising edge, drives a-g outputs directly. CO carries to next stage. Set maxCount=6 for tens digits (0-5), maxCount=10 for ones (0-9).',
  symbol: '4026',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 1, y: 0 }, electricalType: 'power_in' },
    { id: 'gnd', label: 'GND', position: { x: 5, y: 0 }, electricalType: 'power_in' },
    { id: 'clk', label: 'CLK', position: { x: 0, y: 1 }, electricalType: 'input' },
    { id: 'rst', label: 'RST', position: { x: 0, y: 3 }, electricalType: 'input' },
    { id: 'co', label: 'CO', position: { x: 6, y: 2 }, electricalType: 'output' },
    // Segment outputs (a-g) on the bottom, driving the 7-seg display directly
    { id: 'a', label: 'a', position: { x: 0, y: 4 }, electricalType: 'output' },
    { id: 'b', label: 'b', position: { x: 1, y: 4 }, electricalType: 'output' },
    { id: 'c', label: 'c', position: { x: 2, y: 4 }, electricalType: 'output' },
    { id: 'd', label: 'd', position: { x: 3, y: 4 }, electricalType: 'output' },
    { id: 'e', label: 'e', position: { x: 4, y: 4 }, electricalType: 'output' },
    { id: 'f', label: 'f', position: { x: 5, y: 4 }, electricalType: 'output' },
    { id: 'g', label: 'g', position: { x: 6, y: 4 }, electricalType: 'output' },
  ],
  parameters: [
    { key: 'maxCount', label: 'Max Count', type: 'number', default: 10, min: 2, max: 16, step: 1 },
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    const w = 6 * cellSize;
    const h = 4 * cellSize;
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize * 0.2, cellSize * 0.2, w - cellSize * 0.4, h - cellSize * 0.4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `bold ${Math.floor(cellSize * 0.6)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('4026', 3 * cellSize, 2 * cellSize);
    ctx.font = `${Math.floor(cellSize * 0.35)}px ui-monospace, monospace`;
    // pin labels
    const labels: { x: number; y: number; label: string }[] = [
      { x: 1, y: 0.5, label: 'VCC' },
      { x: 5, y: 0.5, label: 'GND' },
      { x: 0.5, y: 1, label: 'CLK' },
      { x: 0.5, y: 3, label: 'RST' },
      { x: 5.5, y: 2, label: 'CO' },
    ];
    ctx.textAlign = 'left';
    for (const l of labels) {
      ctx.fillText(l.label, l.x * cellSize, l.y * cellSize);
    }
    // segment output labels
    ctx.textAlign = 'center';
    ctx.fillStyle = '#94a3b8';
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const i = s.charCodeAt(0) - 97;
      ctx.fillText(s, i * cellSize, (h / cellSize - 0.3) * cellSize);
    }
  },
  stamp(params, terminals, sys, sim, comp) {
    const vccV = params.vcc as number;
    const maxCount = params.maxCount as number;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const vcc = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
    // Power: weak pull-up on vcc to gnd (avoid floating)
    if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);

    // Add weak pull-down on CLK and RST input pins.
    const clkPin = terminals.find((t) => t.terminalId === 'clk')?.nodeId;
    const rstPin = terminals.find((t) => t.terminalId === 'rst')?.nodeId;
    const inputPullDown = 1e-6;
    if (clkPin !== undefined && clkPin !== gnd && clkPin !== vcc) {
      sys.stampConductance(clkPin, gnd, inputPullDown);
    }
    if (rstPin !== undefined && rstPin !== gnd && rstPin !== vcc) {
      sys.stampConductance(rstPin, gnd, inputPullDown);
    }

    // Persistent state for this counter instance
    const key = cd4026Key(terminals, comp);
    const st = sim.state[key] ?? (sim.state[key] = { count: 0, prevClkV: -1 });

    // Read clock and reset inputs (from previous step's solution)
    const clkNode = terminals.find((t) => t.terminalId === 'clk')!.nodeId;
    const rstNode = terminals.find((t) => t.terminalId === 'rst')?.nodeId ?? 0;
    const clkV = sim.nodeVoltage[clkNode] ?? 0;
    const rstV = sim.nodeVoltage[rstNode] ?? 0;
    const clkHigh = clkV > vccV * 0.5;
    const rstHigh = rstV > vccV * 0.5;

    // Edge detection. The prevClkV === -1 sentinel marks the very FIRST
    // stamp, which sees all-zero (pre-solve) voltages — record the level and
    // count no edge. From the second stamp on, voltages are real solver
    // output and every rising edge counts. (The old `initialized` flag only
    // latched once the clock exceeded 0.01V, so for a clock idling LOW it
    // swallowed the FIRST genuine rising edge — every circuit's counter
    // started one pulse late.)
    if (st.prevClkV === -1) {
      st.prevClkV = clkV;
    } else {
      const prevClkHigh = st.prevClkV > vccV * 0.5;
      if (rstHigh) {
        st.count = 0;
      } else if (clkHigh && !prevClkHigh) {
        // Rising edge of clock: increment.
        st.count = (st.count + 1) % maxCount;
      }
      st.prevClkV = clkV;
    }

    // Drive segment outputs based on current count
    const pattern = SEG_PATTERNS[st.count] ?? [0, 0, 0, 0, 0, 0, 0];
    const segIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (let i = 0; i < 7; i++) {
      const segNode = terminals.find((t) => t.terminalId === segIds[i])!.nodeId;
      if (segNode !== gnd) {
        sys.stampVoltageSource(segNode, gnd, pattern[i] ? vccV : 0);
      }
    }

    // Carry out: HIGH for first half of count cycle (0 to maxCount/2 - 1)
    // This produces a rising edge on CO exactly when the count wraps to 0,
    // clocking the next CD4026 at the right time.
    const coNode = terminals.find((t) => t.terminalId === 'co')!.nodeId;
    const coHigh = st.count < maxCount / 2;
    if (coNode !== gnd) {
      sys.stampVoltageSource(coNode, gnd, coHigh ? vccV : 0);
    }
  },
  measure(params, terminals, sim, comp) {
    const key = cd4026Key(terminals, comp);
    const st = sim.state[key] ?? { count: 0, prevClk: false };
    return [
      { label: 'Count', value: String(st.count), unit: '' },
      { label: 'Max', value: String(params.maxCount), unit: '' },
    ];
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
registerPlugin(cd4026);

export { pnp, nmos, pmos, opampRails, sevenSegment, vco, crystal, transformer, speaker, photoresistor, cd4026 };
