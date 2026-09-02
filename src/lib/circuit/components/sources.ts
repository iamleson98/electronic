// Sources, switches, and I/O: DC voltage source, AC source, current source,
// push button, SPST switch, SPDT switch, LED, lamp, potentiometer.

import type { ComponentPlugin } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';

// ----- DC Voltage Source -----
const dcVoltage: ComponentPlugin = {
  type: 'dcVoltage',
  name: 'DC Voltage',
  category: 'source',
  description: 'Ideal DC voltage source. Maintains a fixed voltage between + and - terminals.',
  symbol: 'V',
  boundingBox: { width: 2, height: 4 },
  terminals: [
    { id: 'p', label: '+', position: { x: 1, y: 0 } },
    { id: 'n', label: '-', position: { x: 1, y: 4 } },
  ],
  parameters: [
    { key: 'voltage', label: 'Voltage', type: 'number', default: 5, unit: 'V', min: -1000, max: 1000, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    const cx = cellSize;
    // leads
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, cellSize * 1.4);
    ctx.moveTo(cx, cellSize * 2.6);
    ctx.lineTo(cx, 4 * cellSize);
    ctx.stroke();
    // body circle
    ctx.beginPath();
    ctx.arc(cx, 2 * cellSize, 0.7 * cellSize, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // + and - marks
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 5, 2 * cellSize - 8);
    ctx.lineTo(cx + 5, 2 * cellSize - 8);
    ctx.moveTo(cx, 2 * cellSize - 13);
    ctx.lineTo(cx, 2 * cellSize - 3);
    ctx.moveTo(cx - 5, 2 * cellSize + 8);
    ctx.lineTo(cx + 5, 2 * cellSize + 8);
    ctx.stroke();
    drawLabel(ctx, `${(params.voltage as number).toFixed(1)}V`, cx + 20, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const v = params.voltage as number;
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    const branchIdx = sys.stampVoltageSource(p, n, v);
    // Record the branch index so CCCS/CCVS components can reference it.
    // The map is keyed by component id (and refdes as fallback).
    if (sim && comp) {
      const map = sim.state.__branchIndices ?? (sim.state.__branchIndices = {});
      map[comp.id] = branchIdx;
      if (comp.refdes) map[comp.refdes] = branchIdx;
    }
  },
  // No getFlowPath — current flow dots should NOT animate through power sources
  measure(params, terminals, sim) {
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    return [{ label: 'V', value: (sim.nodeVoltage[p] - sim.nodeVoltage[n]).toFixed(3), unit: 'V' }];
  },
};

// ----- AC Voltage Source -----
const acVoltage: ComponentPlugin = {
  type: 'acVoltage',
  name: 'AC Voltage',
  category: 'source',
  description: 'Sinusoidal voltage source. V(t) = offset + amplitude·sin(2π·f·t).',
  symbol: '~',
  boundingBox: { width: 2, height: 4 },
  terminals: [
    { id: 'p', label: '+', position: { x: 1, y: 0 } },
    { id: 'n', label: '-', position: { x: 1, y: 4 } },
  ],
  parameters: [
    { key: 'amplitude', label: 'Amplitude', type: 'number', default: 5, unit: 'V', min: 0, max: 1000, step: 0.1 },
    { key: 'frequency', label: 'Frequency', type: 'number', default: 50, unit: 'Hz', min: 0.001, max: 1e9, step: 1 },
    { key: 'offset', label: 'DC Offset', type: 'number', default: 0, unit: 'V', min: -1000, max: 1000, step: 0.1 },
    { key: 'phase', label: 'Phase', type: 'number', default: 0, unit: '°', min: -360, max: 360, step: 1 },
  ],
  render(ctx, params, cellSize) {
    const cx = cellSize;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, cellSize * 1.4);
    ctx.moveTo(cx, cellSize * 2.6);
    ctx.lineTo(cx, 4 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, 2 * cellSize, 0.7 * cellSize, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // sine wave inside
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x = cx - 0.5 * cellSize + t * cellSize;
      const y = 2 * cellSize - Math.sin(t * Math.PI * 2) * 6;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    drawLabel(ctx, `${(params.amplitude as number).toFixed(1)}V ${(params.frequency as number).toFixed(0)}Hz`, cx + 20, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const amp = params.amplitude as number;
    const f = params.frequency as number;
    const offset = params.offset as number;
    const phase = (params.phase as number) * Math.PI / 180;
    const v = offset + amp * Math.sin(2 * Math.PI * f * sim.time + phase);
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    const branchIdx = sys.stampVoltageSource(p, n, v);
    if (sim && comp) {
      const map = sim.state.__branchIndices ?? (sim.state.__branchIndices = {});
      map[comp.id] = branchIdx;
      if (comp.refdes) map[comp.refdes] = branchIdx;
    }
  },
  // No getFlowPath — no dots through power sources
};

// ----- Pulse Source -----
const pulseSource: ComponentPlugin = {
  type: 'pulseSource',
  name: 'Pulse',
  category: 'source',
  description: 'Square wave generator with configurable period and duty cycle.',
  symbol: '⊓',
  boundingBox: { width: 2, height: 4 },
  terminals: [
    { id: 'p', label: '+', position: { x: 1, y: 0 } },
    { id: 'n', label: '-', position: { x: 1, y: 4 } },
  ],
  parameters: [
    { key: 'high', label: 'High Voltage', type: 'number', default: 5, unit: 'V', min: -1000, max: 1000, step: 0.1 },
    { key: 'low', label: 'Low Voltage', type: 'number', default: 0, unit: 'V', min: -1000, max: 1000, step: 0.1 },
    { key: 'frequency', label: 'Frequency', type: 'number', default: 1, unit: 'Hz', min: 0.001, max: 1e9, step: 1 },
    { key: 'duty', label: 'Duty Cycle', type: 'number', default: 50, unit: '%', min: 0.1, max: 99.9, step: 1 },
  ],
  render(ctx, params, cellSize) {
    const cx = cellSize;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, cellSize * 1.4);
    ctx.moveTo(cx, cellSize * 2.6);
    ctx.lineTo(cx, 4 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, 2 * cellSize, 0.7 * cellSize, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // square wave inside
    ctx.beginPath();
    const r = 0.5 * cellSize;
    ctx.moveTo(cx - r, 2 * cellSize + 5);
    ctx.lineTo(cx - r, 2 * cellSize - 5);
    ctx.lineTo(cx, 2 * cellSize - 5);
    ctx.lineTo(cx, 2 * cellSize + 5);
    ctx.lineTo(cx + r, 2 * cellSize + 5);
    ctx.stroke();
    drawLabel(ctx, `${(params.frequency as number).toFixed(0)}Hz`, cx + 20, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const f = params.frequency as number;
    const duty = (params.duty as number) / 100;
    const t = (sim.time * f) % 1;
    const v = t < duty ? params.high : params.low;
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    sys.stampVoltageSource(p, n, v as number);
  },
  // No getFlowPath — no dots through power sources
};

// ----- Current Source -----
const currentSource: ComponentPlugin = {
  type: 'currentSource',
  name: 'DC Current',
  category: 'source',
  description: 'Ideal DC current source. Current flows through the source in the arrow direction (+ to −, SPICE convention) — the external circuit carries it out of the − terminal and back into +.',
  symbol: 'I',
  boundingBox: { width: 2, height: 4 },
  terminals: [
    { id: 'p', label: '+', position: { x: 1, y: 0 } },
    { id: 'n', label: '-', position: { x: 1, y: 4 } },
  ],
  parameters: [
    { key: 'current', label: 'Current', type: 'number', default: 0.01, unit: 'A', min: -100, max: 100, step: 0.001 },
  ],
  render(ctx, params, cellSize) {
    const cx = cellSize;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, cellSize * 1.4);
    ctx.moveTo(cx, cellSize * 2.6);
    ctx.lineTo(cx, 4 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, 2 * cellSize, 0.7 * cellSize, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // arrow pointing down (from p to n)
    ctx.beginPath();
    ctx.moveTo(cx, 2 * cellSize - 8);
    ctx.lineTo(cx, 2 * cellSize + 8);
    ctx.moveTo(cx - 4, 2 * cellSize + 3);
    ctx.lineTo(cx, 2 * cellSize + 8);
    ctx.lineTo(cx + 4, 2 * cellSize + 3);
    ctx.stroke();
    drawLabel(ctx, `${((params.current as number) * 1000).toFixed(1)}mA`, cx + 20, 2 * cellSize);
  },
  stamp(params, terminals, sys) {
    const i = params.current as number;
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    sys.stampCurrentSource(p, n, i);
  },
  // No getFlowPath — no dots through power sources
};

// ----- Push Button -----
const pushButton: ComponentPlugin = {
  type: 'pushButton',
  name: 'Push Button',
  category: 'io',
  description: 'Momentary switch. Closes when the "Pressed" parameter is true.',
  symbol: '⎚',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'pressed', label: 'Pressed', type: 'boolean', default: false },
    { key: 'resistance_on', label: 'On Resistance', type: 'number', default: 0.01, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
    { key: 'resistance_off', label: 'Off Resistance', type: 'number', default: 1e15, unit: 'Ω', min: 1e9, max: 1e18, step: 1e6 },
  ],
  render(ctx, params, cellSize) {
    const pressed = params.pressed as boolean;
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(3 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    // switch contact
    if (pressed) {
      ctx.beginPath();
      ctx.moveTo(-cellSize, 0);
      ctx.lineTo(cellSize, 0);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-cellSize, 0);
      ctx.lineTo(cellSize * 0.7, -cellSize * 0.5);
      ctx.stroke();
    }
    // button cap
    ctx.beginPath();
    ctx.arc(0, -cellSize * 0.8, 5, 0, Math.PI * 2);
    ctx.fillStyle = pressed ? '#22c55e' : '#94a3b8';
    ctx.fill();
    ctx.stroke();
  },
  stamp(params, terminals, sys) {
    const r = params.pressed ? (params.resistance_on as number) : (params.resistance_off as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    sys.stampConductance(a, b, 1 / Math.max(1e-12, r));
  },
  getFlowPath(params) {
    // Only show flow when pressed (closed)
    return params.pressed ? [{ x: 0, y: 1 }, { x: 4, y: 1 }] : [];
  },
};

// ----- SPST Switch -----
const spstSwitch: ComponentPlugin = {
  type: 'switch',
  name: 'Switch (SPST)',
  category: 'io',
  description: 'Single-pole single-throw switch. Toggle the "Closed" parameter.',
  symbol: '⇋',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'closed', label: 'Closed', type: 'boolean', default: true },
  ],
  render(ctx, params, cellSize) {
    const closed = params.closed as boolean;
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(3 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    if (closed) {
      ctx.beginPath();
      ctx.moveTo(-cellSize, 0);
      ctx.lineTo(cellSize, 0);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-cellSize, 0);
      ctx.lineTo(cellSize * 0.7, -cellSize * 0.5);
      ctx.stroke();
    }
  },
  stamp(params, terminals, sys) {
    const r = params.closed ? 0.01 : 1e15;
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    sys.stampConductance(a, b, 1 / Math.max(1e-12, r));
  },
  getFlowPath(params) {
    // Only show flow when closed
    return params.closed ? [{ x: 0, y: 1 }, { x: 4, y: 1 }] : [];
  },
};

// ----- LED -----
const led: ComponentPlugin = {
  type: 'led',
  name: 'LED',
  category: 'io',
  description: 'Light-emitting diode with series resistance. Color parameter controls glow color.',
  symbol: 'LED',
  nonLinear: true,
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'k', label: 'K', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'color', label: 'Color', type: 'select', default: 'red', options: [
      { label: 'Red', value: 'red' },
      { label: 'Green', value: 'green' },
      { label: 'Blue', value: 'blue' },
      { label: 'Yellow', value: 'yellow' },
      { label: 'White', value: 'white' },
    ] },
    { key: 'forwardV', label: 'Forward Voltage', type: 'number', default: 2.0, unit: 'V', min: 0.1, max: 10, step: 0.1 },
    { key: 'seriesR', label: 'Series Resistance', type: 'number', default: 220, unit: 'Ω', min: 0.1, max: 1e6, step: 1 },
  ],
  render(ctx, params, cellSize, sim, instance) {
    const colorMap: Record<string, string> = {
      red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#eab308', white: '#f8fafc',
    };
    const color = colorMap[params.color as string] ?? '#ef4444';
    // Get the actual current through this LED from the instance's simState.
    // The canvas attaches __current before calling render (only when sim is running).
    // Physics: LED brightness ∝ forward current I_F. Typical LEDs are rated for
    // 20mA at full brightness. We map current to a 0..1 brightness factor:
    //   brightness = clamp(I_F / 20mA, 0, 1)
    // When simulation is not running (or no current), brightness = 0 (LED off).
    const current = (instance?.simState?.__current as number) ?? 0;
    const absCurrent = Math.abs(current);
    const isSimRunning = sim != null && instance != null;
    // Only show glow if simulation is active AND current exceeds the LED's
    // threshold (forwardV / seriesR gives the minimum conduction current).
    const vf = (params.forwardV as number) ?? 2.0;
    const seriesR = Math.max(0.01, (params.seriesR as number) ?? 220);
    const minConductionCurrent = 0.0001; // 0.1 mA minimum to visible glow
    const brightness = isSimRunning && absCurrent > minConductionCurrent
      ? Math.min(1, absCurrent / 0.02) // full brightness at 20mA
      : 0;
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(2 * cellSize - 8, cellSize);
    ctx.moveTo(2 * cellSize + 8, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    // Glow effect — intensity proportional to current (physics: brightness ∝ I_F)
    if (brightness > 0.01) {
      ctx.save();
      const glowRadius = cellSize * (1.0 + brightness * 1.5); // grows with brightness
      const gradient = ctx.createRadialGradient(
        2 * cellSize, cellSize, 2,
        2 * cellSize, cellSize, glowRadius,
      );
      // Opacity scales with brightness
      const alphaInner = Math.round(brightness * 0xcc).toString(16).padStart(2, '0');
      const alphaMid = Math.round(brightness * 0x44).toString(16).padStart(2, '0');
      gradient.addColorStop(0, color + alphaInner);
      gradient.addColorStop(0.5, color + alphaMid);
      gradient.addColorStop(1, color + '00');
      ctx.fillStyle = gradient;
      ctx.fillRect(2 * cellSize - glowRadius, cellSize - glowRadius, glowRadius * 2, glowRadius * 2);
      ctx.restore();
    }
    ctx.translate(2 * cellSize, cellSize);
    // triangle (anode side) — opacity scales with brightness
    ctx.beginPath();
    ctx.moveTo(-8, -8);
    ctx.lineTo(-8, 8);
    ctx.lineTo(0, 0);
    ctx.closePath();
    const triAlpha = Math.round(0x88 + brightness * 0x77).toString(16).padStart(2, '0');
    ctx.fillStyle = color + triAlpha;
    ctx.fill();
    ctx.stroke();
    // bar (cathode)
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(0, 8);
    ctx.lineWidth = 2;
    ctx.stroke();
    // arrows (light emission) — brighter and thicker with more current
    ctx.strokeStyle = brightness > 0.01 ? color : '#94a3b8';
    ctx.lineWidth = 1.5 + brightness * 1.5;
    ctx.beginPath();
    ctx.moveTo(2, -10);
    ctx.lineTo(8, -16);
    ctx.moveTo(8, -16);
    ctx.lineTo(5, -15);
    ctx.moveTo(8, -16);
    ctx.lineTo(7, -13);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(5, -10);
    ctx.lineTo(11, -16);
    ctx.moveTo(11, -16);
    ctx.lineTo(8, -15);
    ctx.moveTo(11, -16);
    ctx.lineTo(10, -13);
    ctx.stroke();
    void vf; void seriesR;
  },
  stamp(params, terminals, sys, sim, comp) {
    const vf = params.forwardV as number;
    const r = Math.max(0.01, params.seriesR as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('led', comp, a, k);
    const prevOn = st[key] ?? false;
    void prevOn;
    // Current-aware threshold model (see diode): the on-state Thevenin makes
    // v > vf exactly "forward current flowing" — a hysteresis margin latches
    // the LED on through reverse current (rectifier-style failures).
    const on = v > vf;
    st[key] = on;
    if (on) {
      // Forward biased: model as V_th = Vf at 'a' in series with R.
      // Thevenin -> Norton: G = 1/R in parallel with current source I_N = Vf/R.
      // Direction: I_N flows externally from k to a (the LED absorbs power, current
      // enters at 'a' externally and leaves at 'k'). So stamp current source from k to a.
      sys.stampConductance(a, k, 1 / r);
      sys.stampCurrentSource(k, a, vf / r);
    } else {
      // reverse biased: leak (1e-9 S wins against open switches in voltage divider)
      sys.stampConductance(a, k, 1e-13);
    }
  },
  getFlowPath(params, sim) {
    // Only show flow when LED is forward-biased (on).
    // We need to check the on state from sim.state, but we don't have node ids here.
    // Use the sim context's global state if available.
    // For simplicity, always return the path; the renderer will use current magnitude
    // to decide whether to draw dots (0 current = no dots).
    void sim;
    void params;
    return [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
    ];
  },
  measure(params, terminals, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const k = terminals.find((t) => t.terminalId === 'k')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    const r = Math.max(0.01, params.seriesR as number);
    const i = v >= (params.forwardV as number) ? (v - (params.forwardV as number)) / r : 0;
    return [
      { label: 'V', value: v.toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(2), unit: 'mA' },
    ];
  },
};

registerPlugin(dcVoltage);
registerPlugin(acVoltage);
registerPlugin(pulseSource);
registerPlugin(currentSource);
registerPlugin(pushButton);
registerPlugin(spstSwitch);
registerPlugin(led);

export { dcVoltage, acVoltage, pulseSource, currentSource, pushButton, spstSwitch, led };
