// Semiconductors & ICs: diode, NPN/PNP BJT, NMOS/PMOS MOSFET, ideal op-amp, 555 timer,
// logic gates, voltmeter, ammeter, oscilloscope.

import type { ComponentPlugin } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';

// ----- Diode -----
const diode: ComponentPlugin = {
  type: 'diode',
  name: 'Diode',
  category: 'semiconductor',
  description: 'Diode with exponential I-V characteristic. Simplified to a threshold model.',
  symbol: '▷',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'k', label: 'K', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'forwardV', label: 'Forward Voltage', type: 'number', default: 0.7, unit: 'V', min: 0.1, max: 5, step: 0.05 },
    { key: 'onR', label: 'On Resistance', type: 'number', default: 1, unit: 'Ω', min: 0.001, max: 1e6, step: 0.1 },
    { key: 'offR', label: 'Off Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(2 * cellSize - 8, cellSize);
    ctx.moveTo(2 * cellSize + 8, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    // triangle (anode)
    ctx.beginPath();
    ctx.moveTo(-8, -8);
    ctx.lineTo(-8, 8);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.stroke();
    // bar (cathode)
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(0, 8);
    ctx.lineWidth = 2;
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    const vf = params.forwardV as number;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `diode_${a}_${k}`;
    const prevOn = st[key] ?? false;
    // simple threshold model with hysteresis to avoid oscillation
    const on = prevOn ? v > vf - 0.1 : v > vf;
    st[key] = on;
    if (on) {
      // Forward biased: Vf drop at 'a' in series with R.
      // Norton: G = 1/R, current source Vf/R from k to a externally
      // (diode absorbs power, current enters at a externally)
      const r = Math.max(0.001, params.onR as number);
      sys.stampConductance(a, k, 1 / r);
      sys.stampCurrentSource(k, a, vf / r);
    } else {
      // reverse biased: leak (1e-9 S wins against open switches in voltage divider)
      sys.stampConductance(a, k, 1e-9);
    }
  },
  getFlowPath() {
    // anode (0,1) through body to cathode (4,1)
    return [{ x: 0, y: 1 }, { x: 4, y: 1 }];
  },
  measure(params, terminals, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    return [{ label: 'V', value: v.toFixed(3), unit: 'V' }];
  },
};

// ----- NPN BJT -----
const npn: ComponentPlugin = {
  type: 'npn',
  name: 'NPN Transistor',
  category: 'semiconductor',
  description: 'NPN BJT with simple piecewise-linear model. Use as a switch.',
  symbol: 'NPN',
  boundingBox: { width: 3, height: 4 },
  terminals: [
    { id: 'c', label: 'C', position: { x: 3, y: 0 } },
    { id: 'b', label: 'B', position: { x: 0, y: 2 } },
    { id: 'e', label: 'E', position: { x: 3, y: 4 } },
  ],
  parameters: [
    { key: 'hfe', label: 'DC Gain (hFE)', type: 'number', default: 100, unit: '', min: 1, max: 1000, step: 1 },
    { key: 'vbe', label: 'VBE (on)', type: 'number', default: 0.7, unit: 'V', min: 0.1, max: 1.5, step: 0.05 },
    { key: 'satV', label: 'Vce(sat)', type: 'number', default: 0.2, unit: 'V', min: 0.01, max: 1, step: 0.05 },
  ],
  render(ctx, params, cellSize) {
    // base lead
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize);
    ctx.lineTo(cellSize * 1.2, 2 * cellSize);
    ctx.stroke();
    // collector & emitter leads
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
    // base -> collector (with arrowless line)
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 1.5);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.stroke();
    // base -> emitter (with arrow)
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 2.5);
    ctx.lineTo(3 * cellSize, cellSize * 2.8);
    ctx.stroke();
    // arrow on emitter (outward for NPN)
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, cellSize * 2.7);
    ctx.lineTo(3 * cellSize, cellSize * 2.8);
    ctx.lineTo(2.7 * cellSize, cellSize * 2.5);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, `β=${params.hfe}`, 1.8 * cellSize, 3.5 * cellSize);
  },
  getFlowPath() {
    // Collector (3,0) -> body center (1.5,2) -> Emitter (3,4)
    // Current flows C→E when on. Base is separate (small current).
    return [
      { x: 3, y: 0 },
      { x: 1.5, y: 2 },
      { x: 3, y: 4 },
    ];
  },
  stamp(params, terminals, sys, sim) {
    const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
    const hfe = params.hfe as number;
    const vbeOn = params.vbe as number;
    const vceSat = params.satV as number;

    const vbe = sim.nodeVoltage[b] - sim.nodeVoltage[e];
    const vce = sim.nodeVoltage[c] - sim.nodeVoltage[e];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `npn_${c}_${b}_${e}`;
    const prevOn = st[key] ?? false;
    const on = prevOn ? vbe > vbeOn - 0.1 : vbe > vbeOn;
    st[key] = on;
    if (!on) {
      // all off, just leak. Use 1e-9 S so we win the voltage divider against
      // any high-impedance sources (open switches etc.) and keep the base
      // pulled to a defined voltage.
      sys.stampConductance(c, e, 1e-9);
      sys.stampConductance(b, e, 1e-9);
      return;
    }
    // Forward-active OR saturated. Determine based on Vce.
    // If Vce > vceSat -> forward active: Ic = hfe * (Vb - Ve - vbeOn) / something
    // For simplicity, model as: B-E diode (Vsource vbeOn) and a CCCS from c->e of gain hfe.
    // B-E diode: stamp voltage source between b and e with value vbeOn; this creates a branch current I_b.
    const ibBranch = sys.stampVoltageSource(b, e, vbeOn);
    // Ic = hfe * Ib, current from c to e
    sys.stampCCCS(c, e, ibBranch, hfe);
    // saturation clamp: if Vce < vceSat, clamp. Approximate with conductance.
    if (vce < vceSat) {
      // conductance path that limits Vce
      sys.stampVoltageSource(c, e, vceSat);
    }
  },
  measure(params, terminals, sim) {
    const c = terminals.find((t) => t.terminalId === 'c')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const e = terminals.find((t) => t.terminalId === 'e')!.nodeId;
    return [
      { label: 'Vbe', value: (sim.nodeVoltage[b] - sim.nodeVoltage[e]).toFixed(3), unit: 'V' },
      { label: 'Vce', value: (sim.nodeVoltage[c] - sim.nodeVoltage[e]).toFixed(3), unit: 'V' },
    ];
  },
};

// ----- Ideal Op-Amp -----
const opamp: ComponentPlugin = {
  type: 'opamp',
  name: 'Op-Amp (ideal)',
  category: 'ic',
  description: 'Ideal op-amp with infinite gain (VCCS model). Power terminals omitted for simplicity.',
  symbol: 'OP',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'in+', label: '+', position: { x: 0, y: 1 } },
    { id: 'in-', label: '-', position: { x: 0, y: 3 } },
    { id: 'out', label: 'out', position: { x: 4, y: 2 } },
  ],
  parameters: [
    { key: 'gain', label: 'Open-loop Gain', type: 'number', default: 1e5, unit: '', min: 1, max: 1e9, step: 100 },
  ],
  render(ctx, params, cellSize) {
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize * 1.2, cellSize);
    ctx.moveTo(0, 3 * cellSize);
    ctx.lineTo(cellSize * 1.2, 3 * cellSize);
    ctx.moveTo(2.8 * cellSize, 2 * cellSize);
    ctx.lineTo(4 * cellSize, 2 * cellSize);
    ctx.stroke();
    // triangle body
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 0.4);
    ctx.lineTo(cellSize * 1.2, cellSize * 3.6);
    ctx.lineTo(cellSize * 2.8, cellSize * 2);
    ctx.closePath();
    ctx.fillStyle = '#fef3c7';
    ctx.fill();
    ctx.stroke();
    // + and -
    drawLabel(ctx, '+', cellSize * 1.5, cellSize);
    drawLabel(ctx, '−', cellSize * 1.5, 3 * cellSize);
  },
  stamp(params, terminals, sys) {
    const gain = params.gain as number;
    const inp = terminals.find((t) => t.terminalId === 'in+')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in-')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    // VCVS: V(out) - V(0) = gain * (V(inp) - V(inn))
    sys.stampVCVS(out, 0, inp, inn, gain);
  },
  measure(params, terminals, sim) {
    const inp = terminals.find((t) => t.terminalId === 'in+')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in-')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    return [
      { label: 'V+', value: sim.nodeVoltage[inp].toFixed(3), unit: 'V' },
      { label: 'V-', value: sim.nodeVoltage[inn].toFixed(3), unit: 'V' },
      { label: 'Vout', value: sim.nodeVoltage[out].toFixed(3), unit: 'V' },
    ];
  },
};

// ----- 555 Timer -----
const timer555: ComponentPlugin = {
  type: 'timer555',
  name: '555 Timer',
  category: 'ic',
  description: 'NE555 timer IC. Supports astable and monostable modes. Connect THR+TRIG together and DIS to a RC network for astable.',
  symbol: '555',
  boundingBox: { width: 6, height: 6 },
  terminals: [
    { id: 'gnd', label: 'GND', position: { x: 0, y: 1 } },
    { id: 'trig', label: 'TRIG', position: { x: 0, y: 2 } },
    { id: 'out', label: 'OUT', position: { x: 6, y: 1 } },
    { id: 'rst', label: 'RST', position: { x: 0, y: 3 } },
    { id: 'ctrl', label: 'CTRL', position: { x: 0, y: 4 } },
    { id: 'thr', label: 'THR', position: { x: 0, y: 5 } },
    { id: 'dis', label: 'DIS', position: { x: 6, y: 5 } },
    { id: 'vcc', label: 'VCC', position: { x: 6, y: 2 } },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    const w = 6 * cellSize;
    const h = 6 * cellSize;
    // body
    ctx.fillStyle = '#1e3a5f';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize * 0.2, cellSize * 0.2, w - cellSize * 0.4, h - cellSize * 0.4);
    ctx.fill();
    ctx.stroke();
    // label
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `bold ${Math.floor(cellSize * 1.1)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('555', 3 * cellSize, 3 * cellSize);
    ctx.font = `${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
    // pin labels
    const left = [
      { y: 1, label: 'GND' },
      { y: 2, label: 'TRIG' },
      { y: 3, label: 'RST' },
      { y: 4, label: 'CTRL' },
      { y: 5, label: 'THR' },
    ];
    const right = [
      { y: 1, label: 'OUT' },
      { y: 2, label: 'VCC' },
      { y: 5, label: 'DIS' },
    ];
    ctx.textAlign = 'left';
    for (const p of left) {
      ctx.fillText(p.label, cellSize * 0.3, p.y * cellSize);
    }
    ctx.textAlign = 'right';
    for (const p of right) {
      ctx.fillText(p.label, w - cellSize * 0.3, p.y * cellSize);
    }
  },
  stamp(params, terminals, sys, sim) {
    const vcc = params.vcc as number;
    const vccNode = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
    const gndNode = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    // VCC pin: high-impedance input (just a tiny conductance to ground to avoid floating)
    sys.stampConductance(vccNode, gndNode, 1e-9);
    // CTRL pin: typically 2/3 VCC; we provide it as a voltage source if nothing is connected
    // We can't easily detect "connected"; just make it a sense pin (high-Z).
  },
  step(params, terminals, sim, instance) {
    const vcc = params.vcc as number;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const dis = terminals.find((t) => t.terminalId === 'dis')!.nodeId;
    const thr = terminals.find((t) => t.terminalId === 'thr')!.nodeId;
    const trig = terminals.find((t) => t.terminalId === 'trig')!.nodeId;
    const rst = terminals.find((t) => t.terminalId === 'rst')!.nodeId;
    const ctrl = terminals.find((t) => t.terminalId === 'ctrl')!.nodeId;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;

    const st = instance.simState ?? (instance.simState = {});
    if (st.outHigh === undefined) {
      st.outHigh = false;
      st.ff = false; // internal flip-flop
    }
    const vThr = sim.nodeVoltage[thr];
    const vTrig = sim.nodeVoltage[trig];
    const vRst = sim.nodeVoltage[rst];
    const vCtrl = sim.nodeVoltage[ctrl];
    const vThresh = vCtrl > 0.1 ? vCtrl : (2 / 3) * vcc;
    const vTrigThresh = vCtrl > 0.1 ? vCtrl / 2 : (1 / 3) * vcc;
    // reset (active low)
    if (vRst < 0.4) {
      st.ff = false;
    } else {
      if (vThr > vThresh) st.ff = false;
      if (vTrig < vTrigThresh) st.ff = true;
    }
    // OUT pin: drive to VCC if ff, else 0
    st.outHigh = st.ff;
    // We can't directly drive the node here (this is post-solve). We need to drive it via stamping
    // a voltage source next step. We store the state and pick it up in stamp().
    // Save state.
    sim.state.__global = sim.state.__global || {};
  },
  // We need to drive OUT and DIS. Override stamp to do this:
  // But stamp() above doesn't have access to instance state. Let's restructure.
  // Actually we can read from sim.state which is keyed by component id - but our state map is keyed by instance.id
  // Let's rewrite stamp using instance lookup via sim.state map.
};

// Re-stamp 555 with state-aware OUT and DIS driving
timer555.stamp = (params, terminals, sys, sim) => {
  const vcc = params.vcc as number;
  const vccNode = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
  const gndNode = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
  // VCC high-Z
  sys.stampConductance(vccNode, gndNode, 1e-9);
  // CTRL: 2/3 VCC reference - we won't drive it, but if floating, give it a weak pull to 2/3 VCC
  // (we can't easily detect floating; rely on user connecting CTRL or leaving it)
};

// We need both stamp and step. The state lives in instance.simState, but we don't have the instance
// in stamp(). However, sim.state[instance.id] is the same object. Let's pass instance id via the
// sim.state map. To do this, we need the instance id. Easiest: use the `state` map keyed by a hash
// of the terminal nodes (which is stable for a given circuit topology).

// Override step & stamp using a state object on sim.state keyed by component position hash
function stateKey555(terminals: { terminalId: string; nodeId: number }[]): string {
  return 't555_' + terminals.map(t => `${t.terminalId}=${t.nodeId}`).join('_');
}

(timer555 as any).stamp = (params, terminals, sys, sim) => {
  const vcc = params.vcc as number;
  const vccNode = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
  const gndNode = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
  if (vccNode !== gndNode) sys.stampConductance(vccNode, gndNode, 1e-9);

  const key = stateKey555(terminals);
  const st = sim.state[key] ?? (sim.state[key] = { ff: false, outHigh: false });
  const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
  const dis = terminals.find((t) => t.terminalId === 'dis')!.nodeId;
  // Drive OUT as a voltage source (only if OUT is wired to a non-ground node)
  if (out !== gndNode) sys.stampVoltageSource(out, gndNode, st.outHigh ? vcc : 0);
  // Drive DIS: open collector -- if ff=0 (discharging), pull to ground via small R; else high-Z
  if (!st.ff) {
    if (dis !== gndNode) sys.stampConductance(dis, gndNode, 1 / 50); // ~50Ω discharge transistor
  } else {
    if (dis !== gndNode) sys.stampConductance(dis, gndNode, 1e-9);
  }
};

timer555.step = (params, terminals, sim, instance) => {
  const vcc = params.vcc as number;
  const thr = terminals.find((t) => t.terminalId === 'thr')!.nodeId;
  const trig = terminals.find((t) => t.terminalId === 'trig')!.nodeId;
  const rst = terminals.find((t) => t.terminalId === 'rst')!.nodeId;
  const ctrl = terminals.find((t) => t.terminalId === 'ctrl')!.nodeId;
  const key = stateKey555(terminals);
  const st = sim.state[key] ?? (sim.state[key] = { ff: false, outHigh: false });
  const vThr = sim.nodeVoltage[thr];
  const vTrig = sim.nodeVoltage[trig];
  const vRst = sim.nodeVoltage[rst];
  const vCtrl = sim.nodeVoltage[ctrl];
  const vThresh = vCtrl > 0.1 ? vCtrl : (2 / 3) * vcc;
  const vTrigThresh = vCtrl > 0.1 ? vCtrl / 2 : (1 / 3) * vcc;
  if (vRst < 0.4) {
    st.ff = false;
  } else {
    if (vThr > vThresh) st.ff = false;
    if (vTrig < vTrigThresh) st.ff = true;
  }
  st.outHigh = st.ff;
};

timer555.measure = (params, terminals, sim) => {
  const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
  const key = stateKey555(terminals);
  const st = sim.state[key];
  return [
    { label: 'Vout', value: sim.nodeVoltage[out].toFixed(3), unit: 'V' },
    { label: 'State', value: st?.outHigh ? 'HIGH' : 'LOW', unit: '' },
  ];
};

// ----- Logic gates (AND, OR, NOT, NAND, NOR, XOR) -----
function makeLogicGate(type: string, name: string, symbol: string, op: (a: boolean, b?: boolean) => boolean): ComponentPlugin {
  return {
    type,
    name,
    category: 'logic',
    description: `${name} logic gate. Drives output to VCC (logic 1) or 0 (logic 0).`,
    symbol,
    boundingBox: { width: 4, height: 3 },
    terminals: type === 'not'
      ? [
          { id: 'a', label: 'A', position: { x: 0, y: 1.5 } },
          { id: 'y', label: 'Y', position: { x: 4, y: 1.5 } },
          { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 } },
          { id: 'gnd', label: 'GND', position: { x: 2, y: 3 } },
        ]
      : [
          { id: 'a', label: 'A', position: { x: 0, y: 1 } },
          { id: 'b', label: 'B', position: { x: 0, y: 2 } },
          { id: 'y', label: 'Y', position: { x: 4, y: 1.5 } },
          { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 } },
          { id: 'gnd', label: 'GND', position: { x: 2, y: 3 } },
        ],
    parameters: [
      { key: 'vcc', label: 'Logic High (VCC)', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
      { key: 'threshold', label: 'Switch Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
    ],
    render(ctx, params, cellSize) {
      // leads
      if (type === 'not') {
        ctx.beginPath();
        ctx.moveTo(0, 1.5 * cellSize);
        ctx.lineTo(cellSize, 1.5 * cellSize);
        ctx.moveTo(3 * cellSize, 1.5 * cellSize);
        ctx.lineTo(4 * cellSize, 1.5 * cellSize);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cellSize, cellSize * 0.6);
        ctx.lineTo(cellSize, cellSize * 2.4);
        ctx.lineTo(2.7 * cellSize, 1.5 * cellSize);
        ctx.closePath();
        ctx.fillStyle = '#fce7f3';
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(2.85 * cellSize, 1.5 * cellSize, 4, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(0, cellSize);
        ctx.lineTo(cellSize, cellSize);
        ctx.moveTo(0, 2 * cellSize);
        ctx.lineTo(cellSize, 2 * cellSize);
        ctx.moveTo(3 * cellSize, 1.5 * cellSize);
        ctx.lineTo(4 * cellSize, 1.5 * cellSize);
        ctx.stroke();
        // D-shape body
        ctx.beginPath();
        ctx.moveTo(cellSize, cellSize * 0.5);
        ctx.lineTo(cellSize, cellSize * 2.5);
        ctx.lineTo(2 * cellSize, cellSize * 2.5);
        ctx.arc(2 * cellSize, 1.5 * cellSize, cellSize, Math.PI / 2, -Math.PI / 2, true);
        ctx.closePath();
        ctx.fillStyle = '#fce7f3';
        ctx.fill();
        ctx.stroke();
        if (type.startsWith('n')) {
          ctx.beginPath();
          ctx.arc(3.1 * cellSize, 1.5 * cellSize, 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      drawLabel(ctx, symbol, 2 * cellSize, 1.5 * cellSize);
    },
    stamp(params, terminals, sys, sim) {
      const vccV = params.vcc as number;
      const thresh = params.threshold as number;
      const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')?.nodeId;
      const y = terminals.find((t) => t.terminalId === 'y')!.nodeId;
      const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
      const key = `gate_${y}`;
      const st = sim.state[key] ?? (sim.state[key] = { out: false });
      const aHigh = sim.nodeVoltage[a] > thresh;
      const bHigh = b !== undefined ? sim.nodeVoltage[b] > thresh : undefined;
      st.out = op(aHigh, bHigh);
      // Drive output as a voltage source (only if Y is wired to a non-ground node)
      if (y !== gnd) sys.stampVoltageSource(y, gnd, st.out ? vccV : 0);
    },
    step(params, terminals, sim) {
      // nothing; stamp does the work each iteration
    },
    measure(params, terminals, sim) {
      const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')?.nodeId;
      const y = terminals.find((t) => t.terminalId === 'y')!.nodeId;
      return [
        { label: 'A', value: sim.nodeVoltage[a].toFixed(2), unit: 'V' },
        ...(b !== undefined ? [{ label: 'B', value: sim.nodeVoltage[b].toFixed(2), unit: 'V' as const }] : []),
        { label: 'Y', value: sim.nodeVoltage[y].toFixed(2), unit: 'V' },
      ];
    },
  };
}

registerPlugin(makeLogicGate('and', 'AND', '&', (a, b) => !!(a && b)));
registerPlugin(makeLogicGate('or', 'OR', '≥1', (a, b) => !!(a || b)));
registerPlugin(makeLogicGate('nand', 'NAND', '&', (a, b) => !(a && b)));
registerPlugin(makeLogicGate('nor', 'NOR', '≥1', (a, b) => !(a || b)));
registerPlugin(makeLogicGate('xor', 'XOR', '=1', (a, b) => !!(a !== b)));
registerPlugin(makeLogicGate('not', 'NOT', '1', (a) => !a));

registerPlugin(diode);
registerPlugin(npn);
registerPlugin(opamp);
registerPlugin(timer555);

export { diode, npn, opamp, timer555 };
