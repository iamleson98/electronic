// P2 components: voltage references, ADC, DAC, motors.
import type { ComponentPlugin } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';

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
  stamp(params, terminals, sys, sim, comp) {
    const c = terminals.find(t => t.terminalId === 'c')!.nodeId;
    const ref = terminals.find(t => t.terminalId === 'ref')!.nodeId;
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const refV = params.refV as number;
    const refVoltage = sim.nodeVoltage[ref] ?? 0;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('tl431', comp, c, a);
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
  stamp(params, terminals, sys, sim, comp) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    const refV = params.refV as number;
    // The LM385 is a REVERSE-biased (zener-style) shunt reference: it
    // regulates when the cathode is above the anode by refV. The old code
    // modeled a FORWARD diode, so it never regulated in the correct
    // orientation (mirror the lm336/icl8069 stamps in this file).
    const v = (sim.nodeVoltage[k] ?? 0) - (sim.nodeVoltage[a] ?? 0);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('lm385', comp, a, k);
    const prevOn = st[key] ?? false;
    const on = prevOn ? v > refV - 0.05 : v > refV;
    st[key] = on;
    if (on) {
      const r = Math.max(0.001, params.onR as number);
      sys.stampConductance(a, k, 1 / r);
      sys.stampCurrentSource(a, k, refV / r);
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
    const vinNode = terminals.find(t => t.terminalId === 'vin')!.nodeId;
    const vrefNode = terminals.find(t => t.terminalId === 'vref')!.nodeId;
    const vin = sim.nodeVoltage[vinNode] ?? 0;
    // An unconnected terminal maps to node 0 and reads 0 V — the `?? vccV`
    // fallback could never fire. Detect the unconnected VREF explicitly and
    // default it to VCC (an unconnected VREF previously read 0 V, saturating
    // the converter to 255).
    const vref = vrefNode !== 0 ? (sim.nodeVoltage[vrefNode] ?? vccV) : vccV;
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
    // Mechanical: ω = (V − I·R) / K_emf  (back-EMF model)
    const K = params.backEmf as number;
    const omega = Math.max(0, (v - i * (params.resistance as number)) / Math.max(0.0001, K));
    const rpm = omega * 60 / (2 * Math.PI);
    return [
      { label: 'V', value: v.toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(1), unit: 'mA' },
      { label: 'ω', value: omega.toFixed(1), unit: 'rad/s' },
      { label: 'RPM', value: rpm.toFixed(0), unit: 'rpm' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LM336 — 2.5V precision voltage reference diode
// ─────────────────────────────────────────────────────────────────────────────

export const lm336: ComponentPlugin = {
  type: 'lm336',
  name: 'LM336 (2.5V Ref)',
  category: 'ic',
  description: 'Micropower 2.5V precision voltage reference diode. Regulates at 2.49V when reverse-biased.',
  symbol: 'Z',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'k', label: 'K', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'refV', label: 'Reference Voltage', type: 'number', default: 2.49, unit: 'V', min: 1, max: 10, step: 0.001 },
    { key: 'onR', label: 'On Resistance', type: 'number', default: 1, unit: 'Ω', min: 0.001, max: 1e6, step: 0.1 },
    { key: 'offR', label: 'Off Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  keywords: ['lm336', 'reference', 'diode', '2.5v', 'precision'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.5 * cellSize, cellSize);
    ctx.moveTo(2.5 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    // Zener-style symbol
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, cellSize - 6);
    ctx.lineTo(1.5 * cellSize, cellSize + 6);
    ctx.lineTo(2.5 * cellSize, cellSize);
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.stroke();
    // Zener "wings"
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, cellSize - 6);
    ctx.lineTo(2.8 * cellSize, cellSize - 6);
    ctx.moveTo(2.5 * cellSize, cellSize + 6);
    ctx.lineTo(2.2 * cellSize, cellSize + 6);
    ctx.stroke();
    drawLabel(ctx, '2.5V', 2 * cellSize, cellSize - 12);
  },
  stamp(params, terminals, sys, sim, comp) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    const refV = params.refV as number;
    const v = (sim.nodeVoltage[k] ?? 0) - (sim.nodeVoltage[a] ?? 0);  // reverse-biased
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('lm336', comp, a, k);
    const on = v > refV;
    st[key] = on;
    if (on) {
      const r = Math.max(0.001, params.onR as number);
      sys.stampConductance(a, k, 1 / r);
      sys.stampCurrentSource(a, k, refV / r);
    } else {
      sys.stampConductance(a, k, 1 / (params.offR as number));
    }
  },
  measure(params, terminals, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    const v = (sim.nodeVoltage[k] ?? 0) - (sim.nodeVoltage[a] ?? 0);
    return [{ label: 'V', value: v.toFixed(3), unit: 'V' }];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ICL8069 — 1.2V micropower voltage reference
// ─────────────────────────────────────────────────────────────────────────────

export const icl8069: ComponentPlugin = {
  type: 'icl8069',
  name: 'ICL8069 (1.2V Ref)',
  category: 'ic',
  description: '1.2V micropower voltage reference diode. Low-noise, low-drift bandgap reference.',
  symbol: 'Z',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'k', label: 'K', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'refV', label: 'Reference Voltage', type: 'number', default: 1.23, unit: 'V', min: 1.0, max: 1.5, step: 0.001 },
    { key: 'onR', label: 'On Resistance', type: 'number', default: 1, unit: 'Ω', min: 0.001, max: 1e6, step: 0.1 },
    { key: 'offR', label: 'Off Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  keywords: ['icl8069', 'reference', 'diode', '1.2v', 'bandgap'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.5 * cellSize, cellSize);
    ctx.moveTo(2.5 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    // Zener-style symbol
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, cellSize - 6);
    ctx.lineTo(1.5 * cellSize, cellSize + 6);
    ctx.lineTo(2.5 * cellSize, cellSize);
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, cellSize - 6);
    ctx.lineTo(2.8 * cellSize, cellSize - 6);
    ctx.moveTo(2.5 * cellSize, cellSize + 6);
    ctx.lineTo(2.2 * cellSize, cellSize + 6);
    ctx.stroke();
    drawLabel(ctx, '1.2V', 2 * cellSize, cellSize - 12);
  },
  stamp(params, terminals, sys, sim, comp) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    const refV = params.refV as number;
    const v = (sim.nodeVoltage[k] ?? 0) - (sim.nodeVoltage[a] ?? 0);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('icl8069', comp, a, k);
    const on = v > refV;
    st[key] = on;
    if (on) {
      const r = Math.max(0.001, params.onR as number);
      sys.stampConductance(a, k, 1 / r);
      sys.stampCurrentSource(a, k, refV / r);
    } else {
      sys.stampConductance(a, k, 1 / (params.offR as number));
    }
  },
  measure(params, terminals, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    const v = (sim.nodeVoltage[k] ?? 0) - (sim.nodeVoltage[a] ?? 0);
    return [{ label: 'V', value: v.toFixed(3), unit: 'V' }];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Stepper Motor — bipolar, 2-coil
// ─────────────────────────────────────────────────────────────────────────────

export const stepperMotor: ComponentPlugin = {
  type: 'stepperMotor',
  name: 'Stepper Motor (Bipolar)',
  category: 'io',
  description: 'Bipolar 2-coil stepper motor. Energize A+/A- then B+/B- in sequence to rotate. Winding = resistor + inductor.',
  symbol: 'M',
  boundingBox: { width: 6, height: 6 },
  terminals: [
    { id: 'ap', label: 'A+', position: { x: 0, y: 1 } },
    { id: 'an', label: 'A−', position: { x: 0, y: 3 } },
    { id: 'bp', label: 'B+', position: { x: 6, y: 1 } },
    { id: 'bn', label: 'B−', position: { x: 6, y: 3 } },
  ],
  parameters: [
    { key: 'resistance', label: 'Winding Resistance', type: 'number', default: 10, unit: 'Ω', min: 0.1, max: 1000, step: 0.1 },
    { key: 'inductance', label: 'Winding Inductance', type: 'number', default: 0.005, unit: 'H', min: 0.0001, max: 1, step: 0.0001 },
    { key: 'stepsPerRev', label: 'Steps per Revolution', type: 'number', default: 200, unit: '', min: 4, max: 1000, step: 1 },
  ],
  keywords: ['stepper', 'motor', 'bipolar', 'actuator'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // Two coils on left and right, motor circle in middle
    ctx.beginPath();
    ctx.arc(3 * cellSize, 2 * cellSize, cellSize * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    drawLabel(ctx, 'STEPPER', 3 * cellSize, 4.5 * cellSize);
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(2.3 * cellSize, 2 * cellSize);
    ctx.moveTo(0, 3 * cellSize); ctx.lineTo(2.3 * cellSize, 2 * cellSize);
    ctx.moveTo(3.7 * cellSize, 2 * cellSize); ctx.lineTo(6 * cellSize, cellSize);
    ctx.moveTo(3.7 * cellSize, 2 * cellSize); ctx.lineTo(6 * cellSize, 3 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, _sim) {
    const ap = terminals.find(t => t.terminalId === 'ap')!.nodeId;
    const an = terminals.find(t => t.terminalId === 'an')!.nodeId;
    const bp = terminals.find(t => t.terminalId === 'bp')!.nodeId;
    const bn = terminals.find(t => t.terminalId === 'bn')!.nodeId;
    const r = Math.max(0.001, params.resistance as number);
    // Both windings are just resistors (DC steady state)
    sys.stampConductance(ap, an, 1 / r);
    sys.stampConductance(bp, bn, 1 / r);
  },
  measure(params, terminals, sim) {
    const ap = terminals.find(t => t.terminalId === 'ap')!.nodeId;
    const an = terminals.find(t => t.terminalId === 'an')!.nodeId;
    const bp = terminals.find(t => t.terminalId === 'bp')!.nodeId;
    const bn = terminals.find(t => t.terminalId === 'bn')!.nodeId;
    const vA = (sim.nodeVoltage[ap] ?? 0) - (sim.nodeVoltage[an] ?? 0);
    const vB = (sim.nodeVoltage[bp] ?? 0) - (sim.nodeVoltage[bn] ?? 0);
    const r = Math.max(0.001, params.resistance as number);
    const iA = vA / r;
    const iB = vB / r;
    return [
      { label: 'V_A', value: vA.toFixed(2), unit: 'V' },
      { label: 'V_B', value: vB.toFixed(2), unit: 'V' },
      { label: 'I_A', value: (iA * 1000).toFixed(0), unit: 'mA' },
      { label: 'I_B', value: (iB * 1000).toFixed(0), unit: 'mA' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Servo Motor — PWM-controlled
// ─────────────────────────────────────────────────────────────────────────────

export const servoMotor: ComponentPlugin = {
  type: 'servoMotor',
  name: 'Servo Motor (PWM)',
  category: 'io',
  description: 'Hobby servo motor. PWM signal on CTRL (1ms = 0°, 2ms = 180°, 50Hz repetition). VCC/GND power.',
  symbol: 'S',
  boundingBox: { width: 4, height: 6 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 0, y: 1 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 0, y: 5 }, electricalType: 'power_in' as const },
    { id: 'ctrl', label: 'CTRL', position: { x: 0, y: 3 }, electricalType: 'input' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 3, max: 7, step: 0.1 },
    { key: 'threshold', label: 'PWM Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 7, step: 0.1 },
    { key: 'loadR', label: 'Internal Load', type: 'number', default: 1000, unit: 'Ω', min: 1, max: 1e6, step: 10 },
  ],
  keywords: ['servo', 'motor', 'pwm', 'actuator', 'hobby'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, cellSize, 3 * cellSize, 4 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'SERVO', 2.5 * cellSize, 2 * cellSize);
    drawLabel(ctx, 'PWM', 2.5 * cellSize, 3 * cellSize);
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(0, 3 * cellSize); ctx.lineTo(cellSize, 3 * cellSize);
    ctx.moveTo(0, 5 * cellSize); ctx.lineTo(cellSize, 5 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, _sim) {
    const vcc = terminals.find(t => t.terminalId === 'vcc')!.nodeId;
    const gnd = terminals.find(t => t.terminalId === 'gnd')!.nodeId;
    // Internal load between VCC and GND (always-on idle current)
    const r = Math.max(0.001, params.loadR as number);
    sys.stampConductance(vcc, gnd, 1 / r);
  },
  measure(params, terminals, sim) {
    const vcc = terminals.find(t => t.terminalId === 'vcc')!.nodeId;
    const gnd = terminals.find(t => t.terminalId === 'gnd')!.nodeId;
    const ctrl = terminals.find(t => t.terminalId === 'ctrl')!.nodeId;
    const vVcc = (sim.nodeVoltage[vcc] ?? 0) - (sim.nodeVoltage[gnd] ?? 0);
    const vCtrl = (sim.nodeVoltage[ctrl] ?? 0) - (sim.nodeVoltage[gnd] ?? 0);
    const isHigh = vCtrl > (params.threshold as number);
    const angle = isHigh ? 90 : 0;  // simplified: 50% duty = 90°
    return [
      { label: 'VCC', value: vVcc.toFixed(2), unit: 'V' },
      { label: 'CTRL', value: vCtrl.toFixed(2), unit: 'V' },
      { label: 'θ', value: angle.toFixed(0), unit: '°' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Photodiode — light-controlled current source (reverse-biased mode)
// ─────────────────────────────────────────────────────────────────────────────

export const photodiode: ComponentPlugin = {
  type: 'photodiode',
  name: 'Photodiode',
  category: 'semiconductor',
  description: 'Photodiode (photoconductive mode). Reverse-biased; light generates current proportional to illuminance. Set illuminance in lux.',
  symbol: 'PD',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'k', label: 'K', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'responsivity', label: 'Responsivity', type: 'number', default: 0.5, unit: 'A/W', min: 0.01, max: 2, step: 0.01 },
    { key: 'illuminance', label: 'Illuminance', type: 'number', default: 1000, unit: 'lux', min: 0, max: 100000, step: 10 },
    { key: 'activeArea', label: 'Active Area', type: 'number', default: 7.45e-6, unit: 'm²', min: 1e-9, max: 1e-3, step: 1e-7 },
    { key: 'darkCurrent', label: 'Dark Current', type: 'number', default: 2e-9, unit: 'A', min: 0, max: 1e-6, step: 1e-10 },
  ],
  keywords: ['photodiode', 'light', 'optical', 'sensor'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.5 * cellSize, cellSize);
    ctx.moveTo(2.5 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    // Diode triangle
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, cellSize - 6);
    ctx.lineTo(1.5 * cellSize, cellSize + 6);
    ctx.lineTo(2.5 * cellSize, cellSize);
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.stroke();
    // Cathode bar
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, cellSize - 6);
    ctx.lineTo(2.5 * cellSize, cellSize + 6);
    ctx.stroke();
    // Light arrows pointing INTO the diode
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 2; i++) {
      const y = cellSize - 4 + i * 8;
      ctx.beginPath();
      ctx.moveTo(2 * cellSize + 4, y - 8);
      ctx.lineTo(2 * cellSize, y);
      ctx.moveTo(2 * cellSize + 4, y - 1);
      ctx.lineTo(2 * cellSize, y);
      ctx.stroke();
    }
  },
  stamp(params, terminals, sys, sim, comp) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    // Photo-current flows from cathode → anode internally (i.e., conventional current from anode to cathode externally when reverse-biased).
    // We model this as a current source pushing current FROM k TO a (i.e., into a, out of k).
    const responsivity = params.responsivity as number;
    const lux = params.illuminance as number;
    const area = params.activeArea as number;
    // Irradiance ≈ lux / 683 (lm/W conversion at 555nm).
    // The photocurrent is responsivity·E·area — the old code multiplied by
    // 1000 "for visible effect", inflating the current a thousandfold
    // (1000 lux → 5.5 mA instead of the physical 5.5 µA).
    const irradiance = lux / 683;
    const photocurrent = responsivity * irradiance * area;
    const dark = params.darkCurrent as number;
    const totalCurrent = photocurrent + dark;
    // High impedance when not conducting — add parallel leak so node isn't floating
    sys.stampConductance(a, k, 1e-9);
    sys.stampCurrentSource(k, a, totalCurrent);
    // Record state for measure
    const st = sim.state.__global ?? (sim.state.__global = {});
    st[stateKey('pd', comp, a, k)] = { photocurrent: totalCurrent, lux };
  },
  measure(params, terminals, sim, comp) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    const v = (sim.nodeVoltage[k] ?? 0) - (sim.nodeVoltage[a] ?? 0);
    const st = sim.state.__global ?? {};
    const key = stateKey('pd', comp, a, k);
    const i = (st[key]?.photocurrent ?? 0) as number;
    return [
      { label: 'V_R', value: v.toFixed(2), unit: 'V' },
      { label: 'I_ph', value: (i * 1e6).toFixed(2), unit: 'µA' },
      { label: 'lux', value: ((params.illuminance as number)).toFixed(0), unit: 'lx' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Phototransistor — NPN with light-driven base current
// ─────────────────────────────────────────────────────────────────────────────

export const phototransistor: ComponentPlugin = {
  type: 'phototransistor',
  name: 'Phototransistor (NPN)',
  category: 'semiconductor',
  description: 'NPN phototransistor. Light on the base-collector junction acts as base current, multiplied by hFE. Higher sensitivity than photodiode.',
  symbol: 'PT',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'c', label: 'C', position: { x: 4, y: 0 } },
    { id: 'e', label: 'E', position: { x: 4, y: 4 } },
  ],
  parameters: [
    { key: 'hfe', label: 'DC Current Gain (hFE)', type: 'number', default: 100, unit: '', min: 1, max: 1000, step: 1 },
    { key: 'illuminance', label: 'Illuminance', type: 'number', default: 1000, unit: 'lux', min: 0, max: 100000, step: 10 },
    { key: 'photoGain', label: 'Photo-current Gain', type: 'number', default: 1e-6, unit: 'A/klx', min: 1e-9, max: 1e-3, step: 1e-7 },
  ],
  keywords: ['phototransistor', 'light', 'optical', 'sensor', 'npn'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // Circle for transistor body
    ctx.beginPath();
    ctx.arc(2 * cellSize, 2 * cellSize, cellSize * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    // Vertical base line
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, 1.2 * cellSize);
    ctx.lineTo(1.5 * cellSize, 2.8 * cellSize);
    ctx.stroke();
    // Collector lead
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, 1.5 * cellSize);
    ctx.lineTo(4 * cellSize, 0);
    ctx.stroke();
    // Emitter lead with arrow
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, 2.5 * cellSize);
    ctx.lineTo(4 * cellSize, 4 * cellSize);
    ctx.stroke();
    // Arrow head on emitter
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 3.3 * cellSize);
    ctx.lineTo(3.4 * cellSize, 3.1 * cellSize);
    ctx.lineTo(3.2 * cellSize, 3.5 * cellSize);
    ctx.closePath();
    ctx.fill();
    // Light arrows pointing into the base
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 2; i++) {
      const y = 1.5 * cellSize + i * cellSize;
      ctx.beginPath();
      ctx.moveTo(0.5 * cellSize, y - 8);
      ctx.lineTo(1.3 * cellSize, y);
      ctx.moveTo(0.5 * cellSize, y - 1);
      ctx.lineTo(1.3 * cellSize, y);
      ctx.stroke();
    }
  },
  stamp(params, terminals, sys, sim, comp) {
    const c = terminals.find(t => t.terminalId === 'c')!.nodeId;
    const e = terminals.find(t => t.terminalId === 'e')!.nodeId;
    const hfe = params.hfe as number;
    const lux = params.illuminance as number;
    const photoGain = params.photoGain as number;
    // Photo-current into base (≈ photoGain × lux/1000)
    const iBase = photoGain * (lux / 1000);
    // Collector current = hFE × iBase (treated as current source from C to E)
    const iC = hfe * iBase;
    // Output impedance (Early effect approximation)
    sys.stampConductance(c, e, 1e-6);
    sys.stampCurrentSource(c, e, iC);
    const st = sim.state.__global ?? (sim.state.__global = {});
    st[stateKey('pt', comp, c, e)] = { iC, iBase, lux };
  },
  measure(params, terminals, sim, comp) {
    const c = terminals.find(t => t.terminalId === 'c')!.nodeId;
    const e = terminals.find(t => t.terminalId === 'e')!.nodeId;
    const v = (sim.nodeVoltage[c] ?? 0) - (sim.nodeVoltage[e] ?? 0);
    const st = sim.state.__global ?? {};
    const key = stateKey('pt', comp, c, e);
    const iC = (st[key]?.iC ?? 0) as number;
    return [
      { label: 'V_CE', value: v.toFixed(2), unit: 'V' },
      { label: 'I_C', value: (iC * 1e6).toFixed(2), unit: 'µA' },
      { label: 'lux', value: (params.illuminance as number).toFixed(0), unit: 'lx' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Solar cell — photovoltaic source
// ─────────────────────────────────────────────────────────────────────────────

export const solarCell: ComponentPlugin = {
  type: 'solarCell',
  name: 'Solar Cell',
  category: 'source',
  description: 'Photovoltaic solar cell. Generates a voltage proportional to illuminance. Series resistance models internal losses.',
  symbol: 'PV',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'p', label: '+', position: { x: 0, y: 2 } },
    { id: 'n', label: '−', position: { x: 4, y: 2 } },
  ],
  parameters: [
    { key: 'voc', label: 'Open-circuit Voltage', type: 'number', default: 0.6, unit: 'V', min: 0.1, max: 5, step: 0.01 },
    { key: 'illuminance', label: 'Illuminance', type: 'number', default: 1000, unit: 'lux', min: 0, max: 100000, step: 10 },
    { key: 'isc', label: 'Short-circuit Current', type: 'number', default: 0.05, unit: 'A', min: 0.001, max: 10, step: 0.001 },
    { key: 'seriesR', label: 'Series Resistance', type: 'number', default: 0.5, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
  ],
  keywords: ['solar', 'photovoltaic', 'pv', 'cell', 'renewable'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // PV panel — two parallel plates with arrow
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(1 * cellSize, 1 * cellSize, 2 * cellSize, 2 * cellSize);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(1 * cellSize, 1 * cellSize, 2 * cellSize, 2 * cellSize);
    // leads
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize); ctx.lineTo(1 * cellSize, 2 * cellSize);
    ctx.moveTo(3 * cellSize, 2 * cellSize); ctx.lineTo(4 * cellSize, 2 * cellSize);
    ctx.stroke();
    // + and − markers
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', 0.5 * cellSize, 2 * cellSize - 8);
    ctx.fillText('−', 3.5 * cellSize, 2 * cellSize - 8);
    // Sun symbol
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(2 * cellSize, 0.5 * cellSize, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(2 * cellSize + Math.cos(a) * 5, 0.5 * cellSize + Math.sin(a) * 5);
      ctx.lineTo(2 * cellSize + Math.cos(a) * 8, 0.5 * cellSize + Math.sin(a) * 8);
      ctx.stroke();
    }
  },
  stamp(params, terminals, sys, sim, comp) {
    const p = terminals.find(t => t.terminalId === 'p')!.nodeId;
    const n = terminals.find(t => t.terminalId === 'n')!.nodeId;
    // Voltage scales with sqrt(lux/1000) — typical PV characteristic
    const lux = params.illuminance as number;
    const voc = params.voc as number;
    const isc = params.isc as number;
    const seriesR = Math.max(0.001, params.seriesR as number);
    // Effective voltage / short-circuit current at current illuminance
    const vEffective = voc * Math.sqrt(Math.max(0, lux) / 1000);
    const iscEff = Math.max(0, isc) * Math.max(0, lux) / 1000;
    // Thevenin equivalent with a REAL series resistance: an ideal source
    // pinned directly across the terminals made the old parallel conductance
    // do nothing (a 1 mΩ load still saw the full ~0.6 V). The source drives
    // an internal pseudo-node; R_th = vEff/isc (so the short-circuit current
    // is the rated Isc) plus the user's series resistance.
    const rTh = iscEff > 1e-12 ? vEffective / iscEff : 1e9; // ~open when dark
    const rTotal = Math.max(0.001, rTh + seriesR);
    const m = sys.addExtra() + 1; // pseudo-node id (extra index + 1)
    sys.stampVoltageSource(m, n, vEffective); // V(m) − V(n) = vEff
    sys.stampConductance(p, m, 1 / rTotal);   // series R between p and the internal node
    const st = sim.state.__global ?? (sim.state.__global = {});
    st[stateKey('solar', comp, p, n)] = { vEffective, iMax: iscEff, lux };
  },
  measure(params, terminals, sim, comp) {
    const p = terminals.find(t => t.terminalId === 'p')!.nodeId;
    const n = terminals.find(t => t.terminalId === 'n')!.nodeId;
    const v = (sim.nodeVoltage[p] ?? 0) - (sim.nodeVoltage[n] ?? 0);
    const st = sim.state.__global ?? {};
    const key = stateKey('solar', comp, p, n);
    const vEff = (st[key]?.vEffective ?? 0) as number;
    return [
      { label: 'V_out', value: v.toFixed(3), unit: 'V' },
      { label: 'V_eff', value: vEff.toFixed(3), unit: 'V' },
      { label: 'lux', value: (params.illuminance as number).toFixed(0), unit: 'lx' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Active Crystal Oscillator — 4-pin self-contained module
// ─────────────────────────────────────────────────────────────────────────────

export const crystalOscillator: ComponentPlugin = {
  type: 'crystalOscillator',
  name: 'Crystal Oscillator (Active, 4-pin)',
  category: 'ic',
  description: 'Active 4-pin crystal oscillator module. Self-contained: VCC/GND + output + enable. Generates a square wave at the rated frequency.',
  symbol: 'OSC',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 0, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 0, y: 4 }, electricalType: 'power_in' as const },
    { id: 'out', label: 'OUT', position: { x: 6, y: 2 }, electricalType: 'output' as const },
    { id: 'en', label: 'EN', position: { x: 0, y: 2 }, electricalType: 'input' as const },
  ],
  parameters: [
    { key: 'frequency', label: 'Frequency', type: 'number', default: 16000000, unit: 'Hz', min: 1, max: 1e9, step: 1 },
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 1.8, max: 18, step: 0.1 },
    { key: 'threshold', label: 'EN Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
    { key: 'voh', label: 'Output High Voltage', type: 'number', default: 5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
    { key: 'vol', label: 'Output Low Voltage', type: 'number', default: 0, unit: 'V', min: 0, max: 18, step: 0.1 },
  ],
  keywords: ['crystal', 'oscillator', 'active', 'clock', '4-pin', 'square', 'wave'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 4 * cellSize, 3 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'OSC', 3 * cellSize, 1.5 * cellSize);
    drawLabel(ctx, '4-PIN', 3 * cellSize, 2.5 * cellSize);
    // leads
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(cellSize, 0.5 * cellSize);
    ctx.moveTo(0, 2 * cellSize); ctx.lineTo(cellSize, 2 * cellSize);
    ctx.moveTo(0, 4 * cellSize); ctx.lineTo(cellSize, 3.5 * cellSize);
    ctx.moveTo(5 * cellSize, 2 * cellSize); ctx.lineTo(6 * cellSize, 2 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    const vcc = terminals.find(t => t.terminalId === 'vcc')!.nodeId;
    const gnd = terminals.find(t => t.terminalId === 'gnd')!.nodeId;
    const out = terminals.find(t => t.terminalId === 'out')!.nodeId;
    const en = terminals.find(t => t.terminalId === 'en')!.nodeId;
    const vccV = params.vcc as number;
    const threshold = params.threshold as number;
    const freq = params.frequency as number;
    const voh = params.voh as number;
    const vol = params.vol as number;
    // EN has an internal 1 MΩ pull-up to VCC (like real active oscillator
    // modules): unconnected EN → enabled, grounded EN → disabled. The old
    // `sim.nodeVoltage[en] ?? vccV` fallback could never fire because an
    // unconnected pin reads 0 V (node 0), leaving the oscillator disabled.
    sys.stampConductance(en, gnd, 1e-6);
    sys.stampCurrentSource(gnd, en, vccV * 1e-6);
    const enV = (sim.nodeVoltage[en] ?? 0) - (sim.nodeVoltage[gnd] ?? 0);
    const enabled = enV > threshold;
    // Square wave: 50% duty cycle at the rated frequency
    const t = sim.time;
    const period = 1 / Math.max(1e-9, freq);
    const phase = (t % period) / period;
    const vOut = enabled ? (phase < 0.5 ? voh : vol) : vol;
    sys.stampVoltageSource(out, 0, vOut);
    // Minimal VCC load
    sys.stampConductance(vcc, gnd, 1e-6);
    const st = sim.state.__global ?? (sim.state.__global = {});
    st[stateKey('osc', comp, out)] = { freq, enabled, vOut };
  },
  measure(params, terminals, sim, comp) {
    const out = terminals.find(t => t.terminalId === 'out')!.nodeId;
    const v = sim.nodeVoltage[out] ?? 0;
    const st = sim.state.__global ?? {};
    const key = stateKey('osc', comp, out);
    const enabled = (st[key]?.enabled ?? false) as boolean;
    const freq = params.frequency as number;
    const freqStr = freq >= 1e6 ? `${(freq / 1e6).toFixed(2)} MHz` :
                    freq >= 1e3 ? `${(freq / 1e3).toFixed(2)} kHz` :
                    `${freq.toFixed(1)} Hz`;
    return [
      { label: 'V_out', value: v.toFixed(2), unit: 'V' },
      { label: 'f', value: freqStr, unit: '' },
      { label: 'EN', value: enabled ? 'ON' : 'OFF', unit: '' },
    ];
  },
};

registerPlugin(tl431);
registerPlugin(lm385);
registerPlugin(lm336);
registerPlugin(icl8069);
registerPlugin(adc);
registerPlugin(dac);
registerPlugin(dcMotor);
registerPlugin(stepperMotor);
registerPlugin(servoMotor);
registerPlugin(photodiode);
registerPlugin(phototransistor);
registerPlugin(solarCell);
registerPlugin(crystalOscillator);
