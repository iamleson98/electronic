// P1 remaining: Logic ICs, CD4000 CMOS, multiplexers/decoders.
// These are registered as sub-circuit-style components with behavioral stamps.

import type { ComponentPlugin } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';

// ─────────────────────────────────────────────────────────────────────────────
// 7400-series logic ICs — hex inverters, quad gates
// Each is a single gate; users place multiple for a full IC.
// ─────────────────────────────────────────────────────────────────────────────

function makeLogicIC(type: string, name: string, gateType: string, op: (a: boolean, b?: boolean) => boolean): ComponentPlugin {
  const isSingle = gateType === 'not' || gateType === 'buffer';
  return {
    type,
    name,
    category: 'logic',
    description: `${name} — ${gateType.toUpperCase()} gate (7400-series). Drives output to VCC or 0.`,
    symbol: gateType,
    boundingBox: { width: 4, height: 3 },
    terminals: isSingle
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
      { key: 'vcc', label: 'Logic High', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
      { key: 'threshold', label: 'Switch Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
    ],
    keywords: ['logic', 'ic', type, name.toLowerCase(), gateType],
    render(ctx, params, cellSize) {
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
      if (isSingle) {
        ctx.beginPath();
        ctx.moveTo(0, 1.5 * cellSize); ctx.lineTo(cellSize, 1.5 * cellSize);
        ctx.moveTo(3 * cellSize, 1.5 * cellSize); ctx.lineTo(4 * cellSize, 1.5 * cellSize);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cellSize, cellSize * 0.6);
        ctx.lineTo(cellSize, cellSize * 2.4);
        ctx.lineTo(2.7 * cellSize, 1.5 * cellSize);
        ctx.closePath();
        ctx.fillStyle = '#fce7f3';
        ctx.fill();
        ctx.stroke();
        if (gateType === 'not') {
          ctx.beginPath();
          ctx.arc(2.85 * cellSize, 1.5 * cellSize, 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
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
        if (type.startsWith('n')) {
          ctx.beginPath();
          ctx.arc(3.1 * cellSize, 1.5 * cellSize, 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      drawLabel(ctx, gateType.toUpperCase(), 2 * cellSize, 1.5 * cellSize);
    },
    stamp(params, terminals, sys, sim) {
      const vccV = params.vcc as number;
      const thresh = params.threshold as number;
      const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
      const b = terminals.find(t => t.terminalId === 'b')?.nodeId;
      const y = terminals.find(t => t.terminalId === 'y')!.nodeId;
      const gnd = terminals.find(t => t.terminalId === 'gnd')!.nodeId;
      const vcc = terminals.find(t => t.terminalId === 'vcc')!.nodeId;
      const inputPullDown = 1e-6;
      if (a !== gnd && a !== vcc) sys.stampConductance(a, gnd, inputPullDown);
      if (b !== undefined && b !== gnd && b !== vcc) sys.stampConductance(b, gnd, inputPullDown);
      if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
      const aHigh = (sim.nodeVoltage[a] ?? 0) > thresh;
      const bHigh = b !== undefined ? (sim.nodeVoltage[b] ?? 0) > thresh : undefined;
      const out = op(aHigh, bHigh);
      if (y !== gnd) sys.stampVoltageSource(y, gnd, out ? vccV : 0);
    },
    measure(params, terminals, sim) {
      const y = terminals.find(t => t.terminalId === 'y')!.nodeId;
      return [{ label: 'Y', value: (sim.nodeVoltage[y] ?? 0).toFixed(2), unit: 'V' }];
    },
  };
}

// 7400-series
registerPlugin(makeLogicIC('ic7402', '7402 (NOR)', 'nor', (a, b) => !(a || b)));
registerPlugin(makeLogicIC('ic7404', '7404 (NOT)', 'not', (a) => !a));
registerPlugin(makeLogicIC('ic7408', '7408 (AND)', 'and', (a, b) => !!(a && b)));
registerPlugin(makeLogicIC('ic7432', '7432 (OR)', 'or', (a, b) => !!(a || b)));
registerPlugin(makeLogicIC('ic7486', '7486 (XOR)', 'xor', (a, b) => !!(a !== b)));
registerPlugin(makeLogicIC('ic74125', '74125 (Buffer)', 'buffer', (a) => a));

// ─────────────────────────────────────────────────────────────────────────────
// CD4000-series CMOS — D flip-flop, JK flip-flop, decade counter, bilateral switch
// ─────────────────────────────────────────────────────────────────────────────

// CD4013 — Dual D Flip-Flop (single unit)
registerPlugin({
  type: 'cd4013',
  name: 'CD4013 (D Flip-Flop)',
  category: 'logic',
  description: 'CD4013 CMOS dual D flip-flop. Clock on rising edge. Has Set and Reset pins.',
  symbol: 'D',
  boundingBox: { width: 6, height: 5 },
  terminals: [
    { id: 'd', label: 'D', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'clk', label: 'CLK', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'set', label: 'SET', position: { x: 3, y: 0 }, electricalType: 'input' as const },
    { id: 'rst', label: 'RST', position: { x: 3, y: 5 }, electricalType: 'input' as const },
    { id: 'q', label: 'Q', position: { x: 6, y: 1 }, electricalType: 'output' as const },
    { id: 'qbar', label: 'Q̄', position: { x: 6, y: 3 }, electricalType: 'output' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 3, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Clock Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['cd4013', 'cmos', 'flip-flop', 'd', 'digital'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, cellSize, 4 * cellSize, 3 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '4013', 3 * cellSize, 2.5 * cellSize);
    ctx.beginPath();
    ctx.moveTo(cellSize, 3.5 * cellSize);
    ctx.lineTo(1.5 * cellSize, 3 * cellSize);
    ctx.lineTo(cellSize, 2.5 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim) {
    const d = terminals.find(t => t.terminalId === 'd')!.nodeId;
    const clk = terminals.find(t => t.terminalId === 'clk')!.nodeId;
    const set = terminals.find(t => t.terminalId === 'set')!.nodeId;
    const rst = terminals.find(t => t.terminalId === 'rst')!.nodeId;
    const q = terminals.find(t => t.terminalId === 'q')!.nodeId;
    const qbar = terminals.find(t => t.terminalId === 'qbar')!.nodeId;
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `cd4013_${q}_${qbar}`;
    const clkPrev = st[`${key}_clk`] ?? 0;
    const clkNow = sim.nodeVoltage[clk] ?? 0;
    if ((sim.nodeVoltage[set] ?? 0) > thresh) st[key] = true;
    else if ((sim.nodeVoltage[rst] ?? 0) > thresh) st[key] = false;
    else if (clkNow > thresh && clkPrev <= thresh) {
      st[key] = (sim.nodeVoltage[d] ?? 0) > thresh;
    }
    st[`${key}_clk`] = clkNow;
    const qVal = st[key] ?? false;
    sys.stampVoltageSource(q, 0, qVal ? vccV : 0);
    sys.stampVoltageSource(qbar, 0, !qVal ? vccV : 0);
  },
});

// CD4066 — Quad Bilateral Switch (single unit)
registerPlugin({
  type: 'cd4066',
  name: 'CD4066 (Bilateral Switch)',
  category: 'logic',
  description: 'CD4066 CMOS quad bilateral switch. When CTRL is HIGH, signal passes through.',
  symbol: 'SW',
  boundingBox: { width: 4, height: 3 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1.5 } },
    { id: 'ctrl', label: 'CTRL', position: { x: 2, y: 3 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1.5 } },
  ],
  parameters: [
    { key: 'ron', label: 'On Resistance', type: 'number', default: 50, unit: 'Ω', min: 1, max: 10000, step: 1 },
    { key: 'roff', label: 'Off Resistance', type: 'number', default: 1e9, unit: 'Ω', min: 1e6, max: 1e15, step: 1e6 },
    { key: 'threshold', label: 'Control Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['cd4066', 'cmos', 'switch', 'bilateral', 'analog'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 1.5 * cellSize); ctx.lineTo(1.5 * cellSize, 1.5 * cellSize);
    ctx.moveTo(2.5 * cellSize, 1.5 * cellSize); ctx.lineTo(4 * cellSize, 1.5 * cellSize);
    // Switch symbol
    ctx.beginPath();
    ctx.arc(2 * cellSize, 1.5 * cellSize, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, 1.5 * cellSize + 4); ctx.lineTo(2 * cellSize, 3 * cellSize);
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const ctrl = terminals.find(t => t.terminalId === 'ctrl')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const ctrlV = sim.nodeVoltage[ctrl] ?? 0;
    const thresh = params.threshold as number;
    if (ctrlV > thresh) {
      const r = Math.max(0.001, params.ron as number);
      sys.stampConductance(a, b, 1 / r);
    } else {
      sys.stampConductance(a, b, 1 / (params.roff as number));
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiplexer / Decoder
// ─────────────────────────────────────────────────────────────────────────────

// 74138 — 3-to-8 line decoder (active-low outputs)
registerPlugin({
  type: 'ic74138',
  name: '74138 (3-to-8 Decoder)',
  category: 'logic',
  description: '3-to-8 line decoder/demultiplexer. Selects one of 8 outputs based on 3 select lines.',
  symbol: '138',
  boundingBox: { width: 8, height: 8 },
  terminals: [
    { id: 's0', label: 'S0', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 's1', label: 'S1', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 's2', label: 'S2', position: { x: 0, y: 5 }, electricalType: 'input' as const },
    { id: 'y0', label: 'Y0', position: { x: 8, y: 0.5 }, electricalType: 'output' as const },
    { id: 'y1', label: 'Y1', position: { x: 8, y: 1.5 }, electricalType: 'output' as const },
    { id: 'y2', label: 'Y2', position: { x: 8, y: 2.5 }, electricalType: 'output' as const },
    { id: 'y3', label: 'Y3', position: { x: 8, y: 3.5 }, electricalType: 'output' as const },
    { id: 'y4', label: 'Y4', position: { x: 8, y: 4.5 }, electricalType: 'output' as const },
    { id: 'y5', label: 'Y5', position: { x: 8, y: 5.5 }, electricalType: 'output' as const },
    { id: 'y6', label: 'Y6', position: { x: 8, y: 6.5 }, electricalType: 'output' as const },
    { id: 'y7', label: 'Y7', position: { x: 8, y: 7.5 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 8 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Logic High', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['74138', 'decoder', 'demux', '3-to-8', 'digital'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 7 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '138', 4 * cellSize, 3.5 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const s0 = (sim.nodeVoltage[terminals.find(t => t.terminalId === 's0')!.nodeId] ?? 0) > thresh;
    const s1 = (sim.nodeVoltage[terminals.find(t => t.terminalId === 's1')!.nodeId] ?? 0) > thresh;
    const s2 = (sim.nodeVoltage[terminals.find(t => t.terminalId === 's2')!.nodeId] ?? 0) > thresh;
    const sel = (s2 ? 4 : 0) + (s1 ? 2 : 0) + (s0 ? 1 : 0);
    // 74138 outputs are active-low: selected output = 0, all others = VCC.
    // All 8 outputs (y0..y7) — the old loop only covered 6, so select
    // values 6 and 7 lit no output at all. Unconnected outputs (node 0)
    // are skipped like every other logic plugin — stamping them created an
    // all-zero matrix row and a singular system.
    for (let i = 0; i < 8; i++) {
      const yt = terminals.find(t => t.terminalId === `y${i}`);
      if (yt && yt.nodeId !== 0) sys.stampVoltageSource(yt.nodeId, 0, i === sel ? 0 : vccV);
    }
  },
});

// 74153 — Dual 4-to-1 multiplexer (single channel)
registerPlugin({
  type: 'ic74153',
  name: '74153 (4-to-1 MUX)',
  category: 'logic',
  description: 'Dual 4-to-1 data selector/multiplexer. Selects one of 4 inputs based on 2 select lines.',
  symbol: '153',
  boundingBox: { width: 8, height: 5 },
  terminals: [
    { id: 'd0', label: 'D0', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'd1', label: 'D1', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'd2', label: 'D2', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'd3', label: 'D3', position: { x: 0, y: 4 }, electricalType: 'input' as const },
    { id: 's0', label: 'S0', position: { x: 4, y: 5 }, electricalType: 'input' as const },
    { id: 's1', label: 'S1', position: { x: 6, y: 5 }, electricalType: 'input' as const },
    { id: 'y', label: 'Y', position: { x: 8, y: 2.5 }, electricalType: 'output' as const },
    { id: 'vcc', label: 'VCC', position: { x: 4, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 6, y: 0 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Logic High', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
  ],
  keywords: ['74153', 'mux', 'multiplexer', '4-to-1', 'selector', 'digital'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, 0.5 * cellSize, 6 * cellSize, 4 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '153', 4 * cellSize, 2.5 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    const vccV = params.vcc as number;
    const thresh = params.threshold as number;
    const s0 = (sim.nodeVoltage[terminals.find(t => t.terminalId === 's0')!.nodeId] ?? 0) > thresh;
    const s1 = (sim.nodeVoltage[terminals.find(t => t.terminalId === 's1')!.nodeId] ?? 0) > thresh;
    const sel = (s1 ? 2 : 0) + (s0 ? 1 : 0);
    const dNode = terminals.find(t => t.terminalId === `d${sel}`);
    const dVal = dNode ? (sim.nodeVoltage[dNode.nodeId] ?? 0) : 0;
    const y = terminals.find(t => t.terminalId === 'y')!.nodeId;
    // Output follows selected input (pass-through with threshold); skip an
    // unconnected output (node 0) — stamping it makes the matrix singular.
    if (y !== 0) sys.stampVoltageSource(y, 0, dVal > thresh ? vccV : 0);
  },
});
