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
    // base -> collector line
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 1.5);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.stroke();
    // base -> emitter line
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 2.5);
    ctx.lineTo(3 * cellSize, cellSize * 2.8);
    ctx.stroke();
    // arrow on emitter — NPN: arrow points OUTWARD (toward emitter terminal)
    // The emitter line goes from (1.2, 2.5) to (3, 2.8). The arrow is at the
    // emitter end (3, 2.8), pointing outward (away from body).
    // Direction vector: (3-1.2, 2.8-2.5) = (1.8, 0.3), normalized.
    const emDir = { x: 1.8, y: 0.3 };
    const emLen = Math.hypot(emDir.x, emDir.y);
    const emN = { x: emDir.x / emLen, y: emDir.y / emLen };
    // Arrow tip at emitter terminal
    const tipX = 3 * cellSize;
    const tipY = cellSize * 2.8;
    // Arrow base (perpendicular to direction, 8px back from tip)
    const arrowLen = 8;
    const arrowWid = 4;
    const baseX = tipX - emN.x * arrowLen;
    const baseY = tipY - emN.y * arrowLen;
    // Perpendicular vector
    const perp = { x: -emN.y, y: emN.x };
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX + perp.x * arrowWid, baseY + perp.y * arrowWid);
    ctx.lineTo(baseX - perp.x * arrowWid, baseY - perp.y * arrowWid);
    ctx.closePath();
    ctx.fillStyle = '#e2e8f0';
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
  description: 'Ideal op-amp with infinite gain (VCCS model). Power terminals omitted for simplicity. Press M to toggle De Morgan alternate body (rectangle form).',
  symbol: 'OP',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'in+', label: '+', position: { x: 0, y: 1 } },
    { id: 'in-', label: '-', position: { x: 0, y: 3 } },
    { id: 'out', label: 'out', position: { x: 4, y: 2 } },
  ],
  // Pin swap groups: the two inputs can be swapped (with sign inversion in the
  // external circuit, but for purely structural purposes they're swappable)
  pinSwapGroups: [['in+', 'in-']],
  hasAlternateBody: true,
  parameters: [
    { key: 'gain', label: 'Open-loop Gain', type: 'number', default: 1e5, unit: '', min: 1, max: 1e9, step: 100 },
  ],
  render(ctx, params, cellSize, _sim, instance) {
    // leads (common to both body styles)
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize * 1.2, cellSize);
    ctx.moveTo(0, 3 * cellSize);
    ctx.lineTo(cellSize * 1.2, 3 * cellSize);
    ctx.moveTo(2.8 * cellSize, 2 * cellSize);
    ctx.lineTo(4 * cellSize, 2 * cellSize);
    ctx.stroke();
    // De Morgan alternate body style: rectangular box (IEC convention)
    if (instance?.convert === 2) {
      ctx.fillStyle = '#fef3c7';
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(cellSize * 1.2, cellSize * 0.4, cellSize * 1.6, cellSize * 3.2);
      ctx.fill();
      ctx.stroke();
      // IEC op-mp symbol: ampersand-like character or "∞" for infinite gain
      ctx.fillStyle = '#0f172a';
      ctx.font = `bold ${Math.floor(cellSize * 0.7)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('∞', cellSize * 2, cellSize * 2);
      // + and - markers (smaller, inside the box)
      ctx.font = `${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
      ctx.fillText('+', cellSize * 1.4, cellSize);
      ctx.fillText('−', cellSize * 1.4, 3 * cellSize);
    } else {
      // Default triangle body
      ctx.beginPath();
      ctx.moveTo(cellSize * 1.2, cellSize * 0.4);
      ctx.lineTo(cellSize * 1.2, cellSize * 3.6);
      ctx.lineTo(cellSize * 2.8, cellSize * 2);
      ctx.closePath();
      ctx.fillStyle = '#fef3c7';
      ctx.fill();
      ctx.stroke();
      drawLabel(ctx, '+', cellSize * 1.5, cellSize);
      drawLabel(ctx, '−', cellSize * 1.5, 3 * cellSize);
    }
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
  // 555 timer: state-aware stamp and step using sim.state keyed by terminal topology.
  // The state (flip-flop, outHigh) persists across steps via sim.state[key].
  stamp(params, terminals, sys, sim) {
    const vcc = params.vcc as number;
    const vccNode = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
    const gndNode = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    if (vccNode !== gndNode) sys.stampConductance(vccNode, gndNode, 1e-9);

    // CTRL pin: if left unconnected, add weak pull to 2/3 VCC
    const ctrlNode = terminals.find((t) => t.terminalId === 'ctrl')!.nodeId;
    if (ctrlNode !== gndNode && ctrlNode !== vccNode) {
      const ctrlG = 1 / 5e6;
      sys.stampConductance(ctrlNode, gndNode, ctrlG);
      sys.stampCurrentSource(gndNode, ctrlNode, (2 / 3) * vcc * ctrlG);
    }

    const key = stateKey555(terminals);
    const st = sim.state[key] ?? (sim.state[key] = { ff: false, outHigh: false });
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const dis = terminals.find((t) => t.terminalId === 'dis')!.nodeId;
    if (out !== gndNode) sys.stampVoltageSource(out, gndNode, st.outHigh ? vcc : 0);
    if (!st.ff) {
      if (dis !== gndNode) sys.stampConductance(dis, gndNode, 1 / 50);
    } else {
      if (dis !== gndNode) sys.stampConductance(dis, gndNode, 1e-9);
    }
  },
  step(params, terminals, sim, instance) {
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
  },
  measure(params, terminals, sim) {
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const key = stateKey555(terminals);
    const st = sim.state[key];
    return [
      { label: 'Vout', value: sim.nodeVoltage[out].toFixed(3), unit: 'V' },
      { label: 'State', value: st?.outHigh ? 'HIGH' : 'LOW', unit: '' },
    ];
  },
};

// State key for 555 timer (stable across steps)
function stateKey555(terminals: { terminalId: string; nodeId: number }[]): string {
  return 't555_' + terminals.map(t => `${t.terminalId}=${t.nodeId}`).join('_');
}

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
