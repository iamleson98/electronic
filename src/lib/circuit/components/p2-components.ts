// P2 components: voltage references, ADC, DAC, motors.
import type { ComponentPlugin } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';

// ─────────────────────────────────────────────────────────────────────────────
// TL431 — Adjustable shunt voltage reference
// ─────────────────────────────────────────────────────────────────────────────

export const tl431: ComponentPlugin = {
  type: 'tl431',
  name: 'TL431 (Shunt Regulator)',
  category: 'ic',
  description: 'Adjustable precision shunt regulator. Maintains 2.495V reference between REF and GND.',
  symbol: 'TL',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'c', label: 'CATH', position: { x: 0, y: 1 } },
    { id: 'ref', label: 'REF', position: { x: 2, y: 4 } },
    { id: 'a', label: 'AN', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'refV', label: 'Reference Voltage', type: 'number', default: 2.495, unit: 'V', min: 1, max: 36, step: 0.001 },
    { key: 'minI', label: 'Min Cathode Current', type: 'number', default: 0.0004, unit: 'A', min: 0.0001, max: 0.01, step: 0.0001 },
    { key: 'onR', label: 'On Resistance', type: 'number', default: 0.5, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
    { key: 'offR', label: 'Off Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  keywords: ['tl431', 'reference', 'shunt', 'regulator', 'precision'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'TL431', 2 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const c = terminals.find(t => t.terminalId === 'c')!.nodeId;
    const ref = terminals.find(t => t.terminalId === 'ref')!.nodeId;
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const refV = params.refV as number;
    const refVoltage = sim.nodeVoltage[ref] ?? 0;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `tl431_${c}_${a}`;
    // If REF > refV, TL431 conducts (pulls cathode toward anode)
    const on = refVoltage > refV;
    st[key] = on;
    if (on) {
      const r = Math.max(0.001, params.onR as number);
      sys.stampConductance(c, a, 1 / r);
    } else {
      sys.stampConductance(c, a, 1 / (params.offR as number));
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LM385 — 1.2V voltage reference diode
// ─────────────────────────────────────────────────────────────────────────────

export const lm385: ComponentPlugin = {
  type: 'lm385',
  name: 'LM385 (1.2V Ref)',
  category: 'ic',
  description: 'Micropower voltage reference diode. Regulates at 1.235V when forward biased.',
  symbol: 'REF',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'k', label: 'K', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'refV', label: 'Reference Voltage', type: 'number', default: 1.235, unit: 'V', min: 0.5, max: 10, step: 0.001 },
    { key: 'onR', label: 'On Resistance', type: 'number', default: 1, unit: 'Ω', min: 0.001, max: 1e6, step: 0.1 },
    { key: 'offR', label: 'Off Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  keywords: ['lm385', 'reference', 'diode', 'precision', '1.2v'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.5 * cellSize, cellSize);
    ctx.moveTo(2.5 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    // Diode-like symbol with REF label
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, cellSize - 6);
    ctx.lineTo(1.5 * cellSize, cellSize + 6);
    ctx.lineTo(2.5 * cellSize, cellSize);
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, 'REF', 2 * cellSize, cellSize - 12);
  },
  stamp(params, terminals, sys, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    const refV = params.refV as number;
    const v = (sim.nodeVoltage[a] ?? 0) - (sim.nodeVoltage[k] ?? 0);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `lm385_${a}_${k}`;
    const on = v > refV;
    st[key] = on;
    if (on) {
      const r = Math.max(0.001, params.onR as number);
      sys.stampConductance(a, k, 1 / r);
      sys.stampCurrentSource(k, a, refV / r);
    } else {
      sys.stampConductance(a, k, 1 / (params.offR as number));
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ADC — 8-bit analog-to-digital converter (simplified)
// ─────────────────────────────────────────────────────────────────────────────

export const adc: ComponentPlugin = {
  type: 'adc',
  name: 'ADC (8-bit)',
  category: 'mcu',
  description: '8-bit analog-to-digital converter. Reads analog voltage on input, outputs 8-bit digital value.',
  symbol: 'ADC',
  boundingBox: { width: 6, height: 5 },
  terminals: [
    { id: 'vin', label: 'VIN', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'vref', label: 'VREF', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'd7', label: 'D7', position: { x: 6, y: 0.5 }, electricalType: 'output' as const },
    { id: 'd6', label: 'D6', position: { x: 6, y: 1.5 }, electricalType: 'output' as const },
    { id: 'd5', label: 'D5', position: { x: 6, y: 2.5 }, electricalType: 'output' as const },
    { id: 'd4', label: 'D4', position: { x: 6, y: 3.5 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 3, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 3, y: 5 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
  ],
  keywords: ['adc', 'analog', 'digital', 'converter', '8-bit'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 4 * cellSize, 4 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'ADC', 3 * cellSize, 2.5 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const vccV = params.vcc as number;
    const vin = sim.nodeVoltage[terminals.find(t => t.terminalId === 'vin')!.nodeId] ?? 0;
    const vref = sim.nodeVoltage[terminals.find(t => t.terminalId === 'vref')!.nodeId] ?? vccV;
    // Convert analog voltage to 8-bit value
    const ratio = Math.max(0, Math.min(1, vin / Math.max(0.001, vref)));
    const digitalValue = Math.round(ratio * 255);
    // Output 4 MSBs as digital signals (D7-D4)
    for (let bit = 0; bit < 4; bit++) {
      const isHigh = (digitalValue >> (7 - bit)) & 1;
      const term = terminals.find(t => t.terminalId === `d${7 - bit}`);
      if (term) sys.stampVoltageSource(term.nodeId, 0, isHigh ? vccV : 0);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DAC — 8-bit digital-to-analog converter (simplified)
// ─────────────────────────────────────────────────────────────────────────────

export const dac: ComponentPlugin = {
  type: 'dac',
  name: 'DAC (8-bit)',
  category: 'mcu',
  description: '8-bit digital-to-analog converter. 4 digital inputs → analog output voltage.',
  symbol: 'DAC',
  boundingBox: { width: 6, height: 5 },
  terminals: [
    { id: 'd3', label: 'D3', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'd2', label: 'D2', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'd1', label: 'D1', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'd0', label: 'D0', position: { x: 0, y: 4 }, electricalType: 'input' as const },
    { id: 'vout', label: 'VOUT', position: { x: 6, y: 2.5 }, electricalType: 'output' as const },
    { id: 'vref', label: 'VREF', position: { x: 3, y: 0 }, electricalType: 'input' as const },
    { id: 'gnd', label: 'GND', position: { x: 3, y: 5 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vref', label: 'Reference Voltage', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Logic Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['dac', 'digital', 'analog', 'converter', '8-bit'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 4 * cellSize, 4 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'DAC', 3 * cellSize, 2.5 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const vrefV = params.vref as number;
    const thresh = params.threshold as number;
    // Read 4 digital inputs (simplified 4-bit)
    let digitalValue = 0;
    for (let bit = 0; bit < 4; bit++) {
      const term = terminals.find(t => t.terminalId === `d${bit}`);
      if (term) {
        const v = sim.nodeVoltage[term.nodeId] ?? 0;
        if (v > thresh) digitalValue |= (1 << bit);
      }
    }
    // Convert to analog voltage (4-bit → 0..15, mapped to 0..VREF)
    const analogV = (digitalValue / 15) * vrefV;
    const vout = terminals.find(t => t.terminalId === 'vout')!.nodeId;
    sys.stampVoltageSource(vout, 0, analogV);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DC Motor
// ─────────────────────────────────────────────────────────────────────────────

export const dcMotor: ComponentPlugin = {
  type: 'dcMotor',
  name: 'DC Motor',
  category: 'io',
  description: 'DC motor. Resistance + back-EMF proportional to speed. Voltage drives rotation.',
  symbol: 'M',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'a', label: '+', position: { x: 0, y: 1 } },
    { id: 'b', label: '−', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'resistance', label: 'Winding Resistance', type: 'number', default: 5, unit: 'Ω', min: 0.1, max: 1000, step: 0.1 },
    { key: 'backEmf', label: 'Back-EMF Constant', type: 'number', default: 0.01, unit: 'V/(rad/s)', min: 0.001, max: 1, step: 0.001 },
    { key: 'inertia', label: 'Rotor Inertia', type: 'number', default: 0.001, unit: 'kg·m²', min: 0.0001, max: 1, step: 0.0001 },
  ],
  keywords: ['motor', 'dc', 'actuator', 'mechanical'],
  render(ctx, params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(2 * cellSize, 2 * cellSize, cellSize * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    drawLabel(ctx, 'M', 2 * cellSize, 2 * cellSize);
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.2 * cellSize, cellSize);
    ctx.moveTo(2.8 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const r = Math.max(0.001, params.resistance as number);
    // Simplified: motor = resistor (back-EMF ignored in DC steady state)
    sys.stampConductance(a, b, 1 / r);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
  measure(params, terminals, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const v = (sim.nodeVoltage[a] ?? 0) - (sim.nodeVoltage[b] ?? 0);
    const i = v / Math.max(0.001, params.resistance as number);
    return [
      { label: 'V', value: v.toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(1), unit: 'mA' },
    ];
  },
};

registerPlugin(tl431);
registerPlugin(lm385);
registerPlugin(adc);
registerPlugin(dac);
registerPlugin(dcMotor);
