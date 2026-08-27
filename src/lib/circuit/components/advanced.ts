// Meters, oscilloscope, and MCU/SoC stubs (Arduino, Raspberry Pi).
// MCU/SoC plugins are intentionally simplified: they expose configurable digital
// I/O pins and act as voltage sources / sinks based on a user-defined truth table
// or a simple "blink" sketch. Real firmware simulation is out of scope; the plugin
// interface makes it easy to add a real emulator later.

import type { ComponentPlugin } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';

// ----- Voltmeter -----
const voltmeter: ComponentPlugin = {
  type: 'voltmeter',
  name: 'Voltmeter',
  category: 'meter',
  description: 'Measures voltage difference between + and - terminals. Infinite impedance.',
  symbol: 'V',
  boundingBox: { width: 2, height: 3 },
  terminals: [
    { id: 'p', label: '+', position: { x: 0, y: 1.5 } },
    { id: 'n', label: '-', position: { x: 2, y: 1.5 } },
  ],
  parameters: [],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, 1.5 * cellSize);
    ctx.lineTo(cellSize * 0.7, 1.5 * cellSize);
    ctx.moveTo(cellSize * 1.3, 1.5 * cellSize);
    ctx.lineTo(2 * cellSize, 1.5 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cellSize, 1.5 * cellSize, 0.5 * cellSize, 0, Math.PI * 2);
    ctx.fillStyle = '#f1f5f9';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
    drawLabel(ctx, 'V', cellSize, 1.5 * cellSize);
  },
  stamp(params, terminals, sys) {
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    // high impedance
    sys.stampConductance(p, n, 1e-12);
  },
  measure(params, terminals, sim) {
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    return [{ label: 'V', value: (sim.nodeVoltage[p] - sim.nodeVoltage[n]).toFixed(4), unit: 'V' }];
  },
};

// ----- Ammeter -----
const ammeter: ComponentPlugin = {
  type: 'ammeter',
  name: 'Ammeter',
  category: 'meter',
  description: 'Measures current flowing through it (from + to -). Near-zero impedance.',
  symbol: 'A',
  boundingBox: { width: 2, height: 3 },
  terminals: [
    { id: 'p', label: '+', position: { x: 0, y: 1.5 } },
    { id: 'n', label: '-', position: { x: 2, y: 1.5 } },
  ],
  parameters: [],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, 1.5 * cellSize);
    ctx.lineTo(cellSize * 0.7, 1.5 * cellSize);
    ctx.moveTo(cellSize * 1.3, 1.5 * cellSize);
    ctx.lineTo(2 * cellSize, 1.5 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cellSize, 1.5 * cellSize, 0.5 * cellSize, 0, Math.PI * 2);
    ctx.fillStyle = '#f1f5f9';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
    drawLabel(ctx, 'A', cellSize, 1.5 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    // 0V voltage source acts as short circuit with measurable current
    const branchIdx = sys.stampVoltageSource(p, n, 0);
    // Store branch index on sim.state for later retrieval in measure()
    const st = sim.state.__global ?? (sim.state.__global = {});
    st[`ammeter_${p}_${n}`] = branchIdx;
  },
  measure(params, terminals, sim) {
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    const st = sim.state.__global ?? {};
    const branchIdx = st[`ammeter_${p}_${n}`];
    // stampVoltageSource returns the RAW matrix index of the extra variable;
    // sim.branchCurrent is indexed RELATIVE to the first extra variable
    // (branchCurrent[i] = x[numNodes-1+i]). Convert before reading, like the
    // npn/pnp plugins do — the old code read an unrelated slot (or nothing).
    if (branchIdx !== undefined) {
      const numNonGround = sim.nodeVoltage.length - 1;
      const relIdx = (branchIdx as number) - numNonGround;
      if (relIdx >= 0 && relIdx < sim.branchCurrent.length) {
        const i = sim.branchCurrent[relIdx];
        return [{ label: 'I', value: (i * 1000).toFixed(3), unit: 'mA' }];
      }
    }
    return [{ label: 'I', value: '0.000', unit: 'mA' }];
  },
};

// ----- Oscilloscope Probe -----
const oscilloscope: ComponentPlugin = {
  type: 'oscilloscope',
  name: 'Oscilloscope',
  category: 'meter',
  description: 'Records voltage over time. Click the scope panel to view the waveform.',
  symbol: '~',
  boundingBox: { width: 2, height: 2 },
  terminals: [
    { id: 'p', label: '+', position: { x: 0, y: 1 } },
    { id: 'n', label: '-', position: { x: 2, y: 1 } },
  ],
  parameters: [
    { key: 'color', label: 'Trace Color', type: 'color', default: '#22d3ee' },
    { key: 'label', label: 'Trace Label', type: 'string', default: 'CH1' },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cellSize, cellSize, 0.5 * cellSize, 0, Math.PI * 2);
    ctx.fillStyle = (params.color as string) + '33';
    ctx.fill();
    ctx.strokeStyle = params.color as string;
    ctx.lineWidth = 2;
    ctx.stroke();
    drawLabel(ctx, params.label as string, cellSize, cellSize);
  },
  stamp(params, terminals, sys) {
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    sys.stampConductance(p, n, 1e-12);
  },
  measure(params, terminals, sim) {
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    return [{ label: 'V', value: (sim.nodeVoltage[p] - sim.nodeVoltage[n]).toFixed(4), unit: 'V' }];
  },
};

// ----- Arduino Uno (stub) -----
const arduino: ComponentPlugin = {
  type: 'arduino',
  name: 'Arduino Uno',
  category: 'mcu',
  description: 'Arduino Uno (ATmega328P) stub. D2-D13 are digital I/O; A0-A5 analog. Runs a simple "blink" sketch by default. Add your own sketch via the `sketch` parameter.',
  symbol: 'ARD',
  boundingBox: { width: 8, height: 6 },
  terminals: [
    { id: '5v', label: '5V', position: { x: 0, y: 1 } },
    { id: 'gnd', label: 'GND', position: { x: 0, y: 2 } },
    { id: 'd2', label: 'D2', position: { x: 8, y: 1 } },
    { id: 'd3', label: 'D3', position: { x: 8, y: 2 } },
    { id: 'd4', label: 'D4', position: { x: 8, y: 3 } },
    { id: 'd5', label: 'D5', position: { x: 8, y: 4 } },
    { id: 'a0', label: 'A0', position: { x: 0, y: 4 } },
    { id: 'a1', label: 'A1', position: { x: 0, y: 5 } },
  ],
  parameters: [
    { key: 'sketch', label: 'Sketch', type: 'select', default: 'blink', options: [
      { label: 'Blink D2 (1Hz)', value: 'blink' },
      { label: 'Button: A0 -> D3', value: 'button' },
      { label: 'PWM fade on D3', value: 'pwm' },
    ] },
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 1, max: 12, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    const w = 8 * cellSize;
    const h = 6 * cellSize;
    ctx.fillStyle = '#16a34a';
    ctx.strokeStyle = '#064e3b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize * 0.2, cellSize * 0.2, w - cellSize * 0.4, h - cellSize * 0.4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#dcfce7';
    ctx.font = `bold ${Math.floor(cellSize * 1)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ARDUINO', 4 * cellSize, 2.5 * cellSize);
    ctx.font = `${Math.floor(cellSize * 0.55)}px ui-monospace, monospace`;
    ctx.fillText('UNO', 4 * cellSize, 3.3 * cellSize);
    // pin labels
    ctx.textAlign = 'left';
    ctx.font = `${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
    ['5V', 'GND', 'A0', 'A1'].forEach((p, i) => {
      const y = [1, 2, 4, 5][i];
      ctx.fillText(p, cellSize * 0.3, y * cellSize);
    });
    ctx.textAlign = 'right';
    ['D2', 'D3', 'D4', 'D5'].forEach((p, i) => {
      const y = [1, 2, 3, 4][i];
      ctx.fillText(p, w - cellSize * 0.3, y * cellSize);
    });
  },
  stamp(params, terminals, sys, sim) {
    const vccV = params.vcc as number;
    const sketch = params.sketch as string;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const five = terminals.find((t) => t.terminalId === '5v')!.nodeId;
    // 5V pin: voltage source at vccV (only if the pin is actually wired to a non-ground node)
    if (five !== gnd) {
      sys.stampVoltageSource(five, gnd, vccV);
    }
    // A0, A1: inputs (high-Z, weak pull-down to avoid floating node)
    ['a0', 'a1'].forEach((tid) => {
      const node = terminals.find((t) => t.terminalId === tid)!.nodeId;
      if (node !== gnd) sys.stampConductance(node, gnd, 1e-6);
    });
    // sketch
    const key = 'arduino_' + terminals.find((t) => t.terminalId === 'd2')!.nodeId;
    const st = sim.state[key] ?? (sim.state[key] = { outHigh: false });
    if (sketch === 'blink') {
      const period = 1; // 1s
      const phase = (sim.time % period) / period;
      st.outHigh = phase < 0.5;
      const d2 = terminals.find((t) => t.terminalId === 'd2')!.nodeId;
      if (d2 !== gnd) sys.stampVoltageSource(d2, gnd, st.outHigh ? vccV : 0);
    } else if (sketch === 'button') {
      // read A0; if > 2.5V, drive D3 high
      const a0 = terminals.find((t) => t.terminalId === 'a0')!.nodeId;
      const d3 = terminals.find((t) => t.terminalId === 'd3')!.nodeId;
      const a0v = sim.nodeVoltage[a0];
      if (d3 !== gnd) sys.stampVoltageSource(d3, gnd, a0v > 2.5 ? vccV : 0);
    } else if (sketch === 'pwm') {
      // PWM on D3: 1kHz, duty cycle 50%
      const freq = 1000;
      const duty = 0.5;
      const phase = (sim.time * freq) % 1;
      const d3 = terminals.find((t) => t.terminalId === 'd3')!.nodeId;
      if (d3 !== gnd) sys.stampVoltageSource(d3, gnd, phase < duty ? vccV : 0);
    }
  },
  measure(params, terminals, sim) {
    const d2 = terminals.find((t) => t.terminalId === 'd2')!.nodeId;
    const d3 = terminals.find((t) => t.terminalId === 'd3')!.nodeId;
    const a0 = terminals.find((t) => t.terminalId === 'a0')!.nodeId;
    return [
      { label: 'D2', value: sim.nodeVoltage[d2].toFixed(2), unit: 'V' },
      { label: 'D3', value: sim.nodeVoltage[d3].toFixed(2), unit: 'V' },
      { label: 'A0', value: sim.nodeVoltage[a0].toFixed(2), unit: 'V' },
    ];
  },
};

// ----- Raspberry Pi (stub) -----
const raspberryPi: ComponentPlugin = {
  type: 'raspberryPi',
  name: 'Raspberry Pi',
  category: 'mcu',
  description: 'Raspberry Pi GPIO stub. Exposes 3.3V, GND, and 4 GPIO pins. Drives a blink pattern by default.',
  symbol: 'RPi',
  boundingBox: { width: 8, height: 6 },
  terminals: [
    { id: '3v3', label: '3V3', position: { x: 0, y: 1 } },
    { id: 'gnd', label: 'GND', position: { x: 0, y: 2 } },
    { id: 'gpio2', label: 'GPIO2', position: { x: 8, y: 1 } },
    { id: 'gpio3', label: 'GPIO3', position: { x: 8, y: 2 } },
    { id: 'gpio4', label: 'GPIO4', position: { x: 8, y: 3 } },
    { id: 'gpio17', label: 'GPIO17', position: { x: 8, y: 4 } },
  ],
  parameters: [
    { key: 'pattern', label: 'Pattern', type: 'select', default: 'blink', options: [
      { label: 'Blink GPIO4 (0.5Hz)', value: 'blink' },
      { label: 'All GPIOs high', value: 'all_high' },
      { label: 'Inputs only (high-Z)', value: 'inputs' },
    ] },
  ],
  render(ctx, params, cellSize) {
    const w = 8 * cellSize;
    const h = 6 * cellSize;
    ctx.fillStyle = '#7c2d12';
    ctx.strokeStyle = '#431407';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize * 0.2, cellSize * 0.2, w - cellSize * 0.4, h - cellSize * 0.4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fed7aa';
    ctx.font = `bold ${Math.floor(cellSize * 1)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Raspberry Pi', 4 * cellSize, 2.5 * cellSize);
    ctx.font = `${Math.floor(cellSize * 0.55)}px ui-monospace, monospace`;
    ctx.fillText('GPIO Header', 4 * cellSize, 3.3 * cellSize);
    ctx.textAlign = 'left';
    ctx.font = `${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
    ['3V3', 'GND'].forEach((p, i) => {
      const y = [1, 2][i];
      ctx.fillText(p, cellSize * 0.3, y * cellSize);
    });
    ctx.textAlign = 'right';
    ['GP2', 'GP3', 'GP4', 'GP17'].forEach((p, i) => {
      const y = [1, 2, 3, 4][i];
      ctx.fillText(p, w - cellSize * 0.3, y * cellSize);
    });
  },
  stamp(params, terminals, sys, sim) {
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const three = terminals.find((t) => t.terminalId === '3v3')!.nodeId;
    if (three !== gnd) sys.stampVoltageSource(three, gnd, 3.3);
    const pattern = params.pattern as string;
    if (pattern === 'blink') {
      const period = 2;
      const phase = (sim.time % period) / period;
      const high = phase < 0.5;
      const gp4 = terminals.find((t) => t.terminalId === 'gpio4')!.nodeId;
      if (gp4 !== gnd) sys.stampVoltageSource(gp4, gnd, high ? 3.3 : 0);
    } else if (pattern === 'all_high') {
      ['gpio2', 'gpio3', 'gpio4', 'gpio17'].forEach((tid) => {
        const node = terminals.find((t) => t.terminalId === tid)!.nodeId;
        if (node !== gnd) sys.stampVoltageSource(node, gnd, 3.3);
      });
    } else {
      ['gpio2', 'gpio3', 'gpio4', 'gpio17'].forEach((tid) => {
        const node = terminals.find((t) => t.terminalId === tid)!.nodeId;
        if (node !== gnd) sys.stampConductance(node, gnd, 1e-6);
      });
    }
  },
  measure(params, terminals, sim) {
    const gp4 = terminals.find((t) => t.terminalId === 'gpio4')!.nodeId;
    const gp17 = terminals.find((t) => t.terminalId === 'gpio17')!.nodeId;
    return [
      { label: 'GPIO4', value: sim.nodeVoltage[gp4].toFixed(2), unit: 'V' },
      { label: 'GPIO17', value: sim.nodeVoltage[gp17].toFixed(2), unit: 'V' },
    ];
  },
};

// ----- Potentiometer -----
const potentiometer: ComponentPlugin = {
  type: 'potentiometer',
  name: 'Potentiometer',
  category: 'passive',
  description: 'Variable resistor. Use the slider parameter to change wiper position.',
  symbol: 'POT',
  boundingBox: { width: 4, height: 3 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1.5 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1.5 } },
    { id: 'w', label: 'W', position: { x: 2, y: 0 } },
  ],
  parameters: [
    { key: 'resistance', label: 'Total Resistance', type: 'number', default: 10000, unit: 'Ω', min: 1, max: 1e7, step: 100 },
    { key: 'wiper', label: 'Wiper Position', type: 'number', default: 50, unit: '%', min: 0, max: 100, step: 1 },
  ],
  render(ctx, params, cellSize) {
    // leads
    ctx.beginPath();
    ctx.moveTo(0, 1.5 * cellSize);
    ctx.lineTo(cellSize, 1.5 * cellSize);
    ctx.moveTo(3 * cellSize, 1.5 * cellSize);
    ctx.lineTo(4 * cellSize, 1.5 * cellSize);
    ctx.moveTo(2 * cellSize, 0);
    ctx.lineTo(2 * cellSize, cellSize);
    ctx.stroke();
    // box body
    ctx.beginPath();
    ctx.rect(cellSize, cellSize, 2 * cellSize, cellSize);
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();
    ctx.stroke();
    // arrow (wiper)
    const w = (params.wiper as number) / 100;
    const wx = cellSize + w * 2 * cellSize;
    ctx.beginPath();
    ctx.moveTo(wx, cellSize);
    ctx.lineTo(wx - 4, cellSize - 6);
    ctx.lineTo(wx + 4, cellSize - 6);
    ctx.closePath();
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.stroke();
  },
  stamp(params, terminals, sys) {
    const r = Math.max(0.001, params.resistance as number);
    const w = Math.max(0, Math.min(1, (params.wiper as number) / 100));
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const wp = terminals.find((t) => t.terminalId === 'w')!.nodeId;
    const ra = r * w;
    const rb = r * (1 - w);
    sys.stampConductance(a, wp, 1 / Math.max(1e-9, ra));
    sys.stampConductance(b, wp, 1 / Math.max(1e-9, rb));
  },
  measure(params, terminals, sim) {
    const wp = terminals.find((t) => t.terminalId === 'w')!.nodeId;
    return [{ label: 'Vw', value: sim.nodeVoltage[wp].toFixed(3), unit: 'V' }];
  },
};

registerPlugin(voltmeter);
registerPlugin(ammeter);
registerPlugin(oscilloscope);
registerPlugin(arduino);
registerPlugin(raspberryPi);
registerPlugin(potentiometer);

export { voltmeter, ammeter, oscilloscope, arduino, raspberryPi, potentiometer };
