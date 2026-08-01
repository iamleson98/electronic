// Power symbols and net labels.
// These let users connect VCC, GND, +5V, +3.3V, etc. without drawing
// wires across the whole schematic. All power symbols with the same net
// name share the same electrical node.

import type { ComponentPlugin } from '../types';
import { registerPlugin } from '../registry';
import { drawLabel } from './draw';

function makePowerSymbol(
  type: string,
  name: string,
  netName: string,
  shape: 'gnd' | 'agnd' | 'vcc' | 'plus5' | 'plus3v3' | 'plus1v8' | 'plus2v5' | 'plus12' | 'minus12' | 'minus5' | 'avdd' | 'vbat' | 'flag',
  color: string,
  description: string,
): ComponentPlugin {
  return {
    type,
    name,
    category: 'source',
    description,
    symbol: name.charAt(0),
    boundingBox: { width: 2, height: 2 },
    terminals: [{ id: 'p', label: name, position: { x: 1, y: 0 } }],
    parameters: [
      { key: 'net', label: 'Net Name', type: 'string' as const, default: netName },
    ],
    render(ctx, params, cellSize) {
      const net = (params.net as string) || netName;
      ctx.beginPath();
      ctx.moveTo(cellSize, 0);
      ctx.lineTo(cellSize, cellSize * 0.5);
      ctx.stroke();
      ctx.save();
      ctx.translate(cellSize, cellSize * 0.5);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      if (shape === 'gnd') {
        const w = cellSize * 1.2;
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0);
        ctx.moveTo(-w * 0.35, cellSize * 0.4); ctx.lineTo(w * 0.35, cellSize * 0.4);
        ctx.moveTo(-w * 0.2, cellSize * 0.8); ctx.lineTo(w * 0.2, cellSize * 0.8);
        ctx.stroke();
      } else if (shape === 'agnd') {
        // Analog ground: triangle pointing down with a small "AG" mark
        const w = cellSize * 1.2;
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0);
        ctx.moveTo(-w * 0.35, cellSize * 0.4); ctx.lineTo(w * 0.35, cellSize * 0.4);
        // dashed center bar (distinguishes AGND from GND)
        ctx.setLineDash([2, 2]);
        ctx.moveTo(-w * 0.2, cellSize * 0.8); ctx.lineTo(w * 0.2, cellSize * 0.8);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (shape === 'vcc' || shape === 'plus5' || shape === 'plus3v3' ||
                 shape === 'plus1v8' || shape === 'plus2v5' || shape === 'plus12' ||
                 shape === 'avdd' || shape === 'vbat') {
        const w = cellSize * 1.2;
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0);
        ctx.moveTo(0, 0); ctx.lineTo(0, cellSize * 0.3);
        ctx.stroke();
      } else if (shape === 'minus12' || shape === 'minus5') {
        const w = cellSize * 1.2;
        ctx.beginPath();
        ctx.moveTo(-w / 2, cellSize * 0.5); ctx.lineTo(w / 2, cellSize * 0.5);
        ctx.moveTo(0, cellSize * 0.5); ctx.lineTo(0, cellSize * 0.2);
        ctx.stroke();
      } else if (shape === 'flag') {
        const w = cellSize * 1.2, h = cellSize * 0.9;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(0, h); ctx.lineTo(w, h);
        ctx.lineTo(w * 0.7, h * 0.5); ctx.lineTo(w, 0);
        ctx.closePath(); ctx.stroke();
      }
      drawLabel(ctx, net, 0, cellSize * 1.1, color);
      ctx.restore();
    },
    stamp(params, terminals, sys, sim) {
      const net = (params.net as string) || netName;
      const node = terminals.find((t) => t.terminalId === 'p')!.nodeId;
      if (net === 'GND' || net === 'gnd' || net === '0') return;
      const nominalV = parseFloat(netName.replace(/[^\d.+-]/g, '')) || 0;
      if (nominalV !== 0) {
        const gPull = 1e-6;
        sys.stampConductance(node, 0, gPull);
        sys.stampCurrentSource(0, node, nominalV * gPull);
      }
    },
    getFlowPath() { return [{ x: 1, y: 0 }, { x: 1, y: 1 }]; },
  };
}

export const powerGND = makePowerSymbol('powerGND', 'GND (power)', 'GND', 'gnd', '#94a3b8', 'Power port: GND. All GND power symbols are connected to ground.');
export const powerAGND = makePowerSymbol('powerAGND', 'AGND (analog ground)', 'AGND', 'agnd', '#65a30d', 'Power port: Analog Ground. Use to separate analog and digital return paths.');
export const powerVCC = makePowerSymbol('powerVCC', 'VCC (power)', 'VCC', 'vcc', '#ef4444', 'Power port: VCC. All VCC power symbols share the same net.');
export const power5V = makePowerSymbol('power5V', '+5V (power)', '+5V', 'plus5', '#ef4444', 'Power port: +5V. All +5V power symbols share the same net.');
export const power3V3 = makePowerSymbol('power3V3', '+3.3V (power)', '+3.3V', 'plus3v3', '#22c55e', 'Power port: +3.3V.');
export const power1V8 = makePowerSymbol('power1V8', '+1.8V (power)', '+1.8V', 'plus1v8', '#06b6d4', 'Power port: +1.8V (low-voltage core supply).');
export const power2V5 = makePowerSymbol('power2V5', '+2.5V (power)', '+2.5V', 'plus2v5', '#0ea5e9', 'Power port: +2.5V.');
export const power12V = makePowerSymbol('power12V', '+12V (power)', '+12V', 'plus12', '#ef4444', 'Power port: +12V.');
export const powerMinus12V = makePowerSymbol('powerMinus12V', '-12V (power)', '-12V', 'minus12', '#3b82f6', 'Power port: -12V.');
export const powerMinus5V = makePowerSymbol('powerMinus5V', '-5V (power)', '-5V', 'minus5', '#3b82f6', 'Power port: -5V (dual supply negative rail).');
export const powerAVDD = makePowerSymbol('powerAVDD', 'AVDD (analog)', 'AVDD', 'avdd', '#f59e0b', 'Power port: Analog VDD. Separate from digital VDD for noise isolation.');
export const powerVBAT = makePowerSymbol('powerVBAT', 'VBAT (battery)', 'VBAT', 'vbat', '#a855f7', 'Power port: Battery backup supply (e.g. RTC battery).');

// Net Label — names a node. Two net labels with the same name are connected.
export const netLabel: ComponentPlugin = {
  type: 'netLabel',
  name: 'Net Label',
  category: 'source',
  description: 'Names a node. All net labels with the same name are electrically connected.',
  symbol: 'N',
  boundingBox: { width: 4, height: 1 },
  terminals: [{ id: 'p', label: 'Net', position: { x: 0, y: 0 } }],
  parameters: [{ key: 'net', label: 'Net Name', type: 'string' as const, default: 'NET1' }],
  render(ctx, params, cellSize) {
    const net = (params.net as string) || 'NET1';
    ctx.save();
    ctx.strokeStyle = '#22d3ee'; ctx.fillStyle = 'rgba(34,211,238,0.1)';
    ctx.lineWidth = 1.5;
    const w = Math.max(net.length * cellSize * 0.35, cellSize * 1.5);
    const h = cellSize * 0.8;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, h); ctx.lineTo(w, h);
    ctx.lineTo(w * 0.75, h * 0.5); ctx.lineTo(w, 0); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#22d3ee';
    ctx.font = `bold ${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(net, cellSize * 0.2, h * 0.4);
    ctx.restore();
  },
  stamp() {},
  getFlowPath() { return [{ x: 0, y: 0 }]; },
};

// Hierarchical Label — connects to a matching sheet pin on the parent sheet.
// In KiCad, a hierLabel inside a sub-sheet with text "IN" becomes electrically
// connected to the sheet pin named "IN" on the parent sheet's sheet box.
//
// Visually, hierLabels are drawn as a green tag pointing in the direction of
// signal flow (left/right/up/down), distinct from the cyan netLabel.
export const hierLabel: ComponentPlugin = {
  type: 'hierLabel',
  name: 'Hierarchical Label',
  category: 'source',
  description: 'Hierarchical net label. Connects to a sheet pin of the same name on the parent sheet. Use inside sub-sheets to expose nets to the parent.',
  symbol: 'H',
  boundingBox: { width: 4, height: 1 },
  terminals: [{ id: 'p', label: 'Net', position: { x: 0, y: 0 } }],
  parameters: [
    { key: 'net', label: 'Label Name', type: 'string' as const, default: 'IN' },
    { key: 'direction', label: 'Direction', type: 'select' as const, default: 'right',
      options: [
        { label: '→ Right', value: 'right' },
        { label: '← Left', value: 'left' },
        { label: '↑ Up', value: 'up' },
        { label: '↓ Down', value: 'down' },
      ] },
  ],
  render(ctx, params, cellSize) {
    const text = (params.net as string) || 'IN';
    const dir = (params.direction as string) || 'right';
    ctx.save();
    // Hierarchical labels are green (distinct from cyan netLabels)
    ctx.strokeStyle = '#22c55e';
    ctx.fillStyle = 'rgba(34, 197, 94, 0.12)';
    ctx.lineWidth = 1.5;
    const w = Math.max(text.length * cellSize * 0.4, cellSize * 2);
    const h = cellSize * 0.9;
    // Draw a tag pointing in the signal direction
    const arrow = cellSize * 0.4;
    ctx.beginPath();
    switch (dir) {
      case 'right':
        ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w + arrow, h / 2); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
        break;
      case 'left':
        ctx.moveTo(arrow, 0); ctx.lineTo(w + arrow, 0); ctx.lineTo(w + arrow, h); ctx.lineTo(arrow, h); ctx.lineTo(0, h / 2); ctx.closePath();
        break;
      case 'up':
        ctx.moveTo(0, h); ctx.lineTo(w, h); ctx.lineTo(w, arrow); ctx.lineTo(w / 2, 0); ctx.lineTo(0, arrow); ctx.closePath();
        break;
      case 'down':
        ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h - arrow); ctx.lineTo(w / 2, h); ctx.lineTo(0, h - arrow); ctx.closePath();
        break;
    }
    ctx.fill();
    ctx.stroke();
    // Label text
    ctx.fillStyle = '#22c55e';
    ctx.font = `bold ${Math.floor(cellSize * 0.45)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = dir === 'left' || dir === 'right' ? (w + arrow) / 2 : w / 2;
    const cy = dir === 'up' ? h / 2 + arrow / 2 : h / 2;
    ctx.fillText(text, cx, cy);
    ctx.restore();
  },
  stamp() {},
  getFlowPath() { return [{ x: 0, y: 0 }]; },
};

// Bus component (thick line for multi-bit signals)
export const bus: ComponentPlugin = {
  type: 'bus',
  name: 'Bus',
  category: 'passive',
  description: 'Visual bus line for multi-bit signals. Use Bus Labels to extract individual bits.',
  symbol: '⎯',
  boundingBox: { width: 6, height: 1 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 0 } },
    { id: 'b', label: 'B', position: { x: 6, y: 0 } },
  ],
  parameters: [{ key: 'bits', label: 'Bit Width', type: 'number' as const, default: 8, min: 1, max: 32, step: 1 }],
  render(ctx, params, cellSize) {
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(6 * cellSize, 0); ctx.stroke();
    ctx.save();
    ctx.fillStyle = '#1e3a8a'; ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(2.5 * cellSize, -8, cellSize, 16, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#93c5fd';
    ctx.font = `bold ${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${params.bits}`, 3 * cellSize, 0);
    ctx.restore();
  },
  stamp() {},
  getFlowPath() { return [{ x: 0, y: 0 }, { x: 6, y: 0 }]; },
};

// Bus Label — names a single bit on a bus
export const busLabel: ComponentPlugin = {
  type: 'busLabel',
  name: 'Bus Label',
  category: 'source',
  description: 'Labels a single bit on a bus (e.g., D0, D1). All bus labels with the same name are connected.',
  symbol: 'BL',
  boundingBox: { width: 3, height: 1 },
  terminals: [{ id: 'p', label: 'Bit', position: { x: 0, y: 0 } }],
  parameters: [{ key: 'net', label: 'Bit Name', type: 'string' as const, default: 'D0' }],
  render(ctx, params, cellSize) {
    const net = (params.net as string) || 'D0';
    ctx.save();
    ctx.strokeStyle = '#a855f7'; ctx.fillStyle = 'rgba(168,85,247,0.15)'; ctx.lineWidth = 1.5;
    const w = Math.max(net.length * cellSize * 0.35, cellSize * 1.2);
    const h = cellSize * 0.7;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(w * 0.2, -h / 2); ctx.lineTo(w, -h / 2);
    ctx.lineTo(w, h / 2); ctx.lineTo(w * 0.2, h / 2); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c084fc';
    ctx.font = `bold ${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(net, cellSize * 0.3, 0);
    ctx.restore();
  },
  stamp() {},
  getFlowPath() { return [{ x: 0, y: 0 }]; },
};

/**
 * Bus Vector Label — names a multi-bit bus with vector syntax "D[0..7]".
 *
 * Unlike the single-bit `busLabel`, this component exposes one terminal per
 * bit. The engine's `buildNodeMap` recognizes the `[start..end]` syntax and
 * assigns each terminal to the corresponding bit's shared node (D0, D1, …, D7).
 *
 * The number of terminals is dynamic — set via the `bits` parameter. The
 * plugin generates terminals 0..bits-1 at runtime via a custom terminal
 * generator. (For simplicity, we expose 8 terminals by default; users adjust
 * the `bits` parameter to control how many are active.)
 */
export const busVectorLabel: ComponentPlugin = {
  type: 'busVectorLabel',
  name: 'Bus Vector Label',
  category: 'source',
  description: 'Names a multi-bit bus with vector syntax (e.g. D[0..7] creates 8 nets D0..D7). Each terminal is one bit. Use a bus wire to connect.',
  symbol: 'BV',
  boundingBox: { width: 4, height: 9 }, // tall enough for 8 bits
  // 8 fixed terminals — engine assigns each to a bit from expandBusVector()
  terminals: Array.from({ length: 8 }, (_, i) => ({
    id: `b${i}`, label: `${i}`, position: { x: 0, y: i + 1 },
  })),
  parameters: [
    { key: 'net', label: 'Bus Name', type: 'string' as const, default: 'D[0..7]' },
    { key: 'bits', label: 'Bit Count', type: 'number' as const, default: 8, min: 1, max: 32, step: 1 },
  ],
  render(ctx, params, cellSize) {
    const net = (params.net as string) || 'D[0..7]';
    const bits = (params.bits as number) || 8;
    ctx.save();
    ctx.strokeStyle = '#a855f7'; ctx.fillStyle = 'rgba(168,85,247,0.12)'; ctx.lineWidth = 1.5;
    // header tag
    const w = Math.max(net.length * cellSize * 0.4, cellSize * 2);
    const h = cellSize * 0.7;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(w * 0.2, -h / 2); ctx.lineTo(w, -h / 2);
    ctx.lineTo(w, h / 2); ctx.lineTo(w * 0.2, h / 2); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c084fc';
    ctx.font = `bold ${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(net, cellSize * 0.3, 0);
    // bit terminals
    ctx.font = `${Math.floor(cellSize * 0.35)}px ui-monospace, monospace`;
    ctx.fillStyle = '#a78bfa';
    for (let i = 0; i < bits && i < 8; i++) {
      const y = (i + 1) * cellSize;
      // small filled square
      ctx.fillStyle = '#a855f7';
      ctx.fillRect(-3, y - 3, 6, 6);
      ctx.fillStyle = '#a78bfa';
      ctx.fillText(`b${i}`, cellSize * 0.3, y);
    }
    ctx.restore();
  },
  stamp() {},
  getFlowPath() { return [{ x: 0, y: 0 }]; },
};

registerPlugin(powerGND);
registerPlugin(powerAGND);
registerPlugin(powerVCC);
registerPlugin(power5V);
registerPlugin(power3V3);
registerPlugin(power1V8);
registerPlugin(power2V5);
registerPlugin(power12V);
registerPlugin(powerMinus12V);
registerPlugin(powerMinus5V);
registerPlugin(powerAVDD);
registerPlugin(powerVBAT);
registerPlugin(netLabel);
registerPlugin(bus);
registerPlugin(busLabel);
registerPlugin(busVectorLabel);
registerPlugin(hierLabel);
