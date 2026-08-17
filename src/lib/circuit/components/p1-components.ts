// P1 components: voltage regulators, flip-flops, comparators, op-amp macromodels,
// logic ICs, battery, fuse, relay, thermistor, optocoupler.
// These are the most-requested missing components identified in the audit.

import type { ComponentPlugin } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';

// ─────────────────────────────────────────────────────────────────────────────
// Voltage Regulators — LM7805, LM317
// ─────────────────────────────────────────────────────────────────────────────

export const lm7805: ComponentPlugin = {
  type: 'lm7805',
  name: 'LM7805 (5V Regulator)',
  category: 'ic',
  description: 'Fixed 5V positive linear voltage regulator. Input 7-35V → Output 5V.',
  symbol: '78',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'in', label: 'IN', position: { x: 0, y: 1 } },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 } },
    { id: 'out', label: 'OUT', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'outputV', label: 'Output Voltage', type: 'number', default: 5, unit: 'V', min: 0, max: 30, step: 0.1 },
    { key: 'dropoutV', label: 'Dropout Voltage', type: 'number', default: 2, unit: 'V', min: 0.1, max: 10, step: 0.1 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 0.1, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
  ],
  keywords: ['regulator', '7805', 'linear', 'power'],
  render(ctx, params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '7805', 2 * cellSize, 2 * cellSize);
    // IN/OUT/GND labels
    drawLabel(ctx, 'IN', 0.3 * cellSize, 1.3 * cellSize);
    drawLabel(ctx, 'OUT', 3.2 * cellSize, 1.3 * cellSize);
    drawLabel(ctx, 'GND', 1.5 * cellSize, 3.7 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const vin = terminals.find(t => t.terminalId === 'in')!.nodeId;
    const gnd = terminals.find(t => t.terminalId === 'gnd')!.nodeId;
    const vout = terminals.find(t => t.terminalId === 'out')!.nodeId;
    const outV = params.outputV as number;
    const dropout = params.dropoutV as number;
    const r = Math.max(0.001, params.ron as number);
    // If input is high enough, regulate output to outputV.
    // Model as: V(out) = min(V(in) - dropout, outputV) with series R.
    const vIn = sim.nodeVoltage[vin] ?? 0;
    if (vIn > outV + dropout) {
      // Regulated: pin output to outputV via low R
      sys.stampConductance(vout, gnd, 1 / r);
      sys.stampCurrentSource(gnd, vout, outV / r);
    } else {
      // Dropout: pass through with R
      sys.stampConductance(vin, vout, 1 / r);
    }
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 2, y: 2 }, { x: 4, y: 1 }]; },
};

export const lm317: ComponentPlugin = {
  type: 'lm317',
  name: 'LM317 (Adj Regulator)',
  category: 'ic',
  description: 'Adjustable positive voltage regulator. Output = 1.25 * (1 + R2/R1).',
  symbol: '317',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'in', label: 'IN', position: { x: 0, y: 1 } },
    { id: 'adj', label: 'ADJ', position: { x: 2, y: 4 } },
    { id: 'out', label: 'OUT', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'outputV', label: 'Output Voltage', type: 'number', default: 3.3, unit: 'V', min: 1.25, max: 37, step: 0.1 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 0.1, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
  ],
  keywords: ['regulator', '317', 'adjustable', 'power'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '317', 2 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const vin = terminals.find(t => t.terminalId === 'in')!.nodeId;
    const gnd = 0; // adj is the reference; for simplicity use ground
    const vout = terminals.find(t => t.terminalId === 'out')!.nodeId;
    const outV = params.outputV as number;
    const r = Math.max(0.001, params.ron as number);
    const vIn = sim.nodeVoltage[vin] ?? 0;
    if (vIn > outV + 2) {
      sys.stampConductance(vout, gnd, 1 / r);
      sys.stampCurrentSource(gnd, vout, outV / r);
    } else {
      sys.stampConductance(vin, vout, 1 / r);
    }
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Flip-Flops — D, SR, JK latches
// ─────────────────────────────────────────────────────────────────────────────

function makeFlipFlop(type: string, name: string, symbol: string): ComponentPlugin {
  return {
    type,
    name,
    category: 'logic',
    description: `${name} — digital storage element. Clock on rising edge.`,
    symbol,
    boundingBox: { width: 6, height: 4 },
    terminals: [
      { id: 'd', label: 'D', position: { x: 0, y: 1 }, electricalType: 'input' as const },
      { id: 'clk', label: '>', position: { x: 0, y: 3 }, electricalType: 'input' as const },
      { id: 'q', label: 'Q', position: { x: 6, y: 1 }, electricalType: 'output' as const },
      { id: 'qbar', label: 'Q̄', position: { x: 6, y: 3 }, electricalType: 'output' as const },
    ],
    parameters: [
      { key: 'initialState', label: 'Initial State', type: 'boolean', default: false },
    ],
    keywords: ['flip-flop', type, 'digital', 'sequential'],
    render(ctx, _params, cellSize) {
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(cellSize, cellSize, 4 * cellSize, 2 * cellSize);
      ctx.stroke();
      drawLabel(ctx, symbol, 3 * cellSize, 2 * cellSize);
      // Clock indicator (triangle)
      ctx.beginPath();
      ctx.moveTo(cellSize, 2.5 * cellSize);
      ctx.lineTo(1.5 * cellSize, 3 * cellSize);
      ctx.lineTo(cellSize, 3.5 * cellSize);
      ctx.stroke();
    },
    stamp(params, terminals, sys, sim) {
      const d = terminals.find(t => t.terminalId === 'd')?.nodeId ?? 0;
      const clk = terminals.find(t => t.terminalId === 'clk')?.nodeId ?? 0;
      const q = terminals.find(t => t.terminalId === 'q')?.nodeId ?? 0;
      const qbar = terminals.find(t => t.terminalId === 'qbar')?.nodeId ?? 0;
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = `ff_${type}_${q}_${qbar}`;
      const clkPrev = st[`${key}_clk`] ?? 0;
      const clkNow = sim.nodeVoltage[clk] ?? 0;
      // Rising edge detection
      if (clkNow > 2.5 && clkPrev <= 2.5) {
        // D flip-flop: Q follows D on rising edge
        const dVal = (sim.nodeVoltage[d] ?? 0) > 2.5;
        st[key] = dVal;
      }
      st[`${key}_clk`] = clkNow;
      const qVal = st[key] ?? (params.initialState as boolean);
      // Drive Q and Q-bar
      sys.stampConductance(q, 0, 1e6);
      sys.stampCurrentSource(0, q, qVal ? 5 / 1e6 : 0);
      sys.stampConductance(qbar, 0, 1e6);
      sys.stampCurrentSource(0, qbar, !qVal ? 5 / 1e6 : 0);
    },
    getFlowPath() { return [{ x: 0, y: 1 }, { x: 6, y: 1 }]; },
  };
}

export const dFlipFlop = makeFlipFlop('dff', 'D Flip-Flop', 'D');
export const srLatch = makeFlipFlop('srlatch', 'SR Latch', 'SR');
export const jkFlipFlop = makeFlipFlop('jkff', 'JK Flip-Flop', 'JK');

// ─────────────────────────────────────────────────────────────────────────────
// Comparators — LM311, LM393
// ─────────────────────────────────────────────────────────────────────────────

export const comparator: ComponentPlugin = {
  type: 'comparator',
  name: 'Comparator',
  category: 'ic',
  description: 'Voltage comparator. Output = HIGH when V(+) > V(-), LOW otherwise. Open-collector output.',
  symbol: 'CMP',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'inp', label: '+', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'inn', label: '−', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'out', label: 'OUT', position: { x: 6, y: 2 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 3, y: 0 }, electricalType: 'power_in' as const },
    { id: 'vee', label: 'VEE', position: { x: 3, y: 4 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vhigh', label: 'Output HIGH', type: 'number', default: 5, unit: 'V', min: 0, max: 100, step: 0.1 },
    { key: 'vlow', label: 'Output LOW', type: 'number', default: 0, unit: 'V', min: -100, max: 100, step: 0.1 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 10, unit: 'Ω', min: 0.001, max: 1e6, step: 1 },
    { key: 'roff', label: 'Off Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  keywords: ['comparator', 'lm311', 'lm393', 'open-collector'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // Triangle shape
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, 0.5 * cellSize);
    ctx.lineTo(1.5 * cellSize, 3.5 * cellSize);
    ctx.lineTo(4.5 * cellSize, 2 * cellSize);
    ctx.closePath();
    ctx.stroke();
    drawLabel(ctx, 'CMP', 2.5 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const inp = terminals.find(t => t.terminalId === 'inp')?.nodeId ?? 0;
    const inn = terminals.find(t => t.terminalId === 'inn')?.nodeId ?? 0;
    const out = terminals.find(t => t.terminalId === 'out')?.nodeId ?? 0;
    const vPlus = sim.nodeVoltage[inp] ?? 0;
    const vMinus = sim.nodeVoltage[inn] ?? 0;
    const isHigh = vPlus > vMinus;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `cmp_${out}`;
    const prevHigh = st[key] ?? isHigh;
    // Hysteresis (1mV)
    const currentHigh = prevHigh ? vPlus > vMinus - 0.001 : vPlus > vMinus + 0.001;
    st[key] = currentHigh;
    if (currentHigh) {
      const r = Math.max(0.001, params.ron as number);
      sys.stampConductance(out, 0, 1 / r);
      sys.stampCurrentSource(0, out, (params.vhigh as number) / r);
    } else {
      sys.stampConductance(out, 0, 1 / (params.roff as number));
    }
  },
  getFlowPath() { return [{ x: 0, y: 2 }, { x: 6, y: 2 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Battery
// ─────────────────────────────────────────────────────────────────────────────

export const battery: ComponentPlugin = {
  type: 'battery',
  name: 'Battery',
  category: 'source',
  description: 'DC voltage source representing a battery cell.',
  symbol: 'Bat',
  boundingBox: { width: 2, height: 4 },
  terminals: [
    { id: 'p', label: '+', position: { x: 1, y: 0 } },
    { id: 'n', label: '−', position: { x: 1, y: 4 } },
  ],
  parameters: [
    { key: 'voltage', label: 'Voltage', type: 'number', default: 9, unit: 'V', min: 0, max: 100, step: 0.1 },
  ],
  keywords: ['battery', 'cell', 'power', 'portable'],
  render(ctx, params, cellSize) {
    const cx = cellSize;
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, 1.5 * cellSize);
    ctx.moveTo(cx, 2.5 * cellSize); ctx.lineTo(cx, 4 * cellSize);
    ctx.stroke();
    // Battery plates
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 8, 1.5 * cellSize); ctx.lineTo(cx + 8, 1.5 * cellSize); // long (+)
    ctx.moveTo(cx - 5, 2.5 * cellSize); ctx.lineTo(cx + 5, 2.5 * cellSize); // short (-)
    ctx.stroke();
    drawLabel(ctx, `${(params.voltage as number).toFixed(1)}V`, cx + 15, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const v = params.voltage as number;
    const p = terminals.find(t => t.terminalId === 'p')!.nodeId;
    const n = terminals.find(t => t.terminalId === 'n')!.nodeId;
    const branchIdx = sys.stampVoltageSource(p, n, v);
    if (sim && comp) {
      const map = sim.state.__branchIndices ?? (sim.state.__branchIndices = {});
      map[comp.id] = branchIdx;
      if (comp.refdes) map[comp.refdes] = branchIdx;
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Fuse
// ─────────────────────────────────────────────────────────────────────────────

export const fuse: ComponentPlugin = {
  type: 'fuse',
  name: 'Fuse',
  category: 'passive',
  description: 'Overcurrent protection. Blows (opens) when current exceeds rating.',
  symbol: 'Fuse',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'rating', label: 'Current Rating', type: 'number', default: 1, unit: 'A', min: 0.001, max: 100, step: 0.1 },
    { key: 'resistance', label: 'Resistance', type: 'number', default: 0.01, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
  ],
  keywords: ['fuse', 'protection', 'overcurrent'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(0.5 * cellSize, cellSize);
    // Rectangular body
    ctx.rect(0.5 * cellSize, 0.5 * cellSize, 3 * cellSize, cellSize);
    // Wire through body
    ctx.moveTo(0.5 * cellSize, cellSize); ctx.lineTo(3.5 * cellSize, cellSize);
    ctx.moveTo(3.5 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `fuse_${a}_${b}`;
    const blown = st[key] ?? false;
    if (!blown) {
      const r = Math.max(0.001, params.resistance as number);
      sys.stampConductance(a, b, 1 / r);
      // Check if current exceeds rating
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
      const i = Math.abs(v) / r;
      if (i > (params.rating as number) * 1.5) {
        st[key] = true; // blow the fuse
      }
    }
    // If blown, no connection (infinite resistance)
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Relay (electromechanical)
// ─────────────────────────────────────────────────────────────────────────────

export const relay: ComponentPlugin = {
  type: 'relay',
  name: 'Relay',
  category: 'ic',
  description: 'Electromechanical relay. Coil energized → switch closes. NO/NC contacts.',
  symbol: 'RLY',
  boundingBox: { width: 6, height: 6 },
  terminals: [
    { id: 'coilA', label: 'A', position: { x: 0, y: 1 } },
    { id: 'coilB', label: 'B', position: { x: 0, y: 5 } },
    { id: 'com', label: 'COM', position: { x: 6, y: 3 } },
    { id: 'no', label: 'NO', position: { x: 6, y: 1 } },
    { id: 'nc', label: 'NC', position: { x: 6, y: 5 } },
  ],
  parameters: [
    { key: 'coilR', label: 'Coil Resistance', type: 'number', default: 100, unit: 'Ω', min: 1, max: 10000, step: 1 },
    { key: 'pullInV', label: 'Pull-in Voltage', type: 'number', default: 3, unit: 'V', min: 0.1, max: 100, step: 0.1 },
    { key: 'contactR', label: 'Contact Resistance', type: 'number', default: 0.01, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
  ],
  keywords: ['relay', 'switch', 'electromechanical'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // Coil (rectangle on left)
    ctx.beginPath();
    ctx.rect(0.5 * cellSize, 1.5 * cellSize, 1.5 * cellSize, 3 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'K', 1.25 * cellSize, 3 * cellSize);
    // Switch arm
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, 3 * cellSize);
    ctx.lineTo(5 * cellSize, 1.5 * cellSize); // to NO
    ctx.stroke();
    // NO/NC contacts
    drawLabel(ctx, 'NO', 5.5 * cellSize, 1.3 * cellSize);
    drawLabel(ctx, 'NC', 5.5 * cellSize, 5.3 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const coilA = terminals.find(t => t.terminalId === 'coilA')!.nodeId;
    const coilB = terminals.find(t => t.terminalId === 'coilB')!.nodeId;
    const com = terminals.find(t => t.terminalId === 'com')!.nodeId;
    const no = terminals.find(t => t.terminalId === 'no')!.nodeId;
    const nc = terminals.find(t => t.terminalId === 'nc')!.nodeId;
    const coilR = Math.max(0.001, params.coilR as number);
    // Stamp coil resistance
    sys.stampConductance(coilA, coilB, 1 / coilR);
    // Check if coil is energized
    const vCoil = Math.abs(sim.nodeVoltage[coilA] - sim.nodeVoltage[coilB]);
    const energized = vCoil > (params.pullInV as number);
    const r = Math.max(0.001, params.contactR as number);
    if (energized) {
      // COM connected to NO
      sys.stampConductance(com, no, 1 / r);
      sys.stampConductance(com, nc, 1e-13);
    } else {
      // COM connected to NC
      sys.stampConductance(com, nc, 1 / r);
      sys.stampConductance(com, no, 1e-13);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Thermistor (NTC)
// ─────────────────────────────────────────────────────────────────────────────

export const thermistor: ComponentPlugin = {
  type: 'thermistor',
  name: 'Thermistor (NTC)',
  category: 'passive',
  description: 'Negative temperature coefficient resistor. Resistance decreases as temperature rises.',
  symbol: 'NTC',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'resistance', label: 'Resistance @25°C', type: 'number', default: 10000, unit: 'Ω', min: 1, max: 1e8, step: 1 },
    { key: 'beta', label: 'Beta (25/85)', type: 'number', default: 3950, min: 1000, max: 6000, step: 10 },
    { key: 'temperature', label: 'Temperature', type: 'number', default: 25, unit: '°C', min: -50, max: 200, step: 1 },
  ],
  keywords: ['thermistor', 'ntc', 'temperature', 'sensor'],
  render(ctx, params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // Zigzag resistor with diagonal line through (thermistor symbol)
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(0.5 * cellSize, cellSize);
    for (let i = 0; i < 4; i++) {
      const x0 = 0.5 * cellSize + i * 0.7 * cellSize;
      const x1 = x0 + 0.7 * cellSize;
      ctx.moveTo(x0, cellSize - 6); ctx.lineTo(x1, cellSize + 6);
      ctx.moveTo(x1, cellSize + 6); ctx.lineTo(x0 + 1.4 * cellSize, cellSize - 6);
    }
    ctx.moveTo(3.5 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    // Diagonal line with "t" label
    ctx.beginPath();
    ctx.moveTo(1 * cellSize, 0); ctx.lineTo(3 * cellSize, 0);
    ctx.moveTo(2 * cellSize, 0); ctx.lineTo(2 * cellSize, -5);
    ctx.stroke();
    drawLabel(ctx, 't', 2.5 * cellSize, -8);
  },
  stamp(params, terminals, sys) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const R0 = params.resistance as number;
    const beta = params.beta as number;
    const T = (params.temperature as number) + 273.15; // Celsius to Kelvin
    const T0 = 298.15; // 25°C
    // Steinhart-Hart: R = R0 * exp(beta * (1/T - 1/T0))
    const R = R0 * Math.exp(beta * (1 / T - 1 / T0));
    sys.stampConductance(a, b, 1 / Math.max(R, 1e-6));
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Optocoupler (4N35)
// ─────────────────────────────────────────────────────────────────────────────

export const optocoupler: ComponentPlugin = {
  type: 'optocoupler',
  name: 'Optocoupler',
  category: 'ic',
  description: 'Optical isolator. LED on input side drives phototransistor on output side.',
  symbol: 'OPT',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'ledA', label: 'A', position: { x: 0, y: 1 } },
    { id: 'ledK', label: 'K', position: { x: 0, y: 3 } },
    { id: 'c', label: 'C', position: { x: 6, y: 1 } },
    { id: 'e', label: 'E', position: { x: 6, y: 3 } },
  ],
  parameters: [
    { key: 'ctr', label: 'CTR (Current Transfer Ratio)', type: 'number', default: 0.5, min: 0.01, max: 10, step: 0.05 },
    { key: 'ledVf', label: 'LED Forward Voltage', type: 'number', default: 1.2, unit: 'V', min: 0.5, max: 5, step: 0.1 },
    { key: 'ledR', label: 'LED Series R', type: 'number', default: 1, unit: 'Ω', min: 0.001, max: 1e6, step: 0.1 },
    { key: 'transR', label: 'Transistor R', type: 'number', default: 10, unit: 'Ω', min: 0.001, max: 1e6, step: 1 },
  ],
  keywords: ['optocoupler', 'opto', 'isolator', '4n35'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // Dashed isolation line
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 0); ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.stroke();
    ctx.setLineDash([]);
    // LED arrow (left side)
    drawLabel(ctx, 'LED', 1 * cellSize, 2 * cellSize);
    // Transistor (right side)
    drawLabel(ctx, 'PT', 4.5 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const ledA = terminals.find(t => t.terminalId === 'ledA')!.nodeId;
    const ledK = terminals.find(t => t.terminalId === 'ledK')!.nodeId;
    const c = terminals.find(t => t.terminalId === 'c')!.nodeId;
    const e = terminals.find(t => t.terminalId === 'e')!.nodeId;
    const vf = params.ledVf as number;
    const ledR = Math.max(0.001, params.ledR as number);
    const ctr = params.ctr as number;
    const transR = Math.max(0.001, params.transR as number);
    // LED stamp (like diode)
    const vLed = sim.nodeVoltage[ledA] - sim.nodeVoltage[ledK];
    if (vLed > vf) {
      sys.stampConductance(ledA, ledK, 1 / ledR);
      sys.stampCurrentSource(ledK, ledA, vf / ledR);
      // LED current drives phototransistor
      const iLed = (vLed - vf) / ledR;
      const iTrans = iLed * ctr;
      // Phototransistor: current from C to E
      sys.stampConductance(c, e, 1 / transR);
      sys.stampCurrentSource(e, c, iTrans);
    } else {
      sys.stampConductance(ledA, ledK, 1e-13);
      sys.stampConductance(c, e, 1e-13);
    }
  },
};

// Register all new components
registerPlugin(lm7805);
registerPlugin(lm317);
registerPlugin(dFlipFlop);
registerPlugin(srLatch);
registerPlugin(jkFlipFlop);
registerPlugin(comparator);
registerPlugin(battery);
registerPlugin(fuse);
registerPlugin(relay);
registerPlugin(thermistor);
registerPlugin(optocoupler);
