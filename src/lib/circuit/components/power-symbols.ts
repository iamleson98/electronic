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
  shape: 'gnd' | 'vcc' | 'plus5' | 'plus3v3' | 'plus12' | 'minus12' | 'flag',
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
      } else if (shape === 'vcc' || shape === 'plus5' || shape === 'plus3v3' || shape === 'plus12') {
        const w = cellSize * 1.2;
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0);
        ctx.moveTo(0, 0); ctx.lineTo(0, cellSize * 0.3);
        ctx.stroke();
      } else if (shape === 'minus12') {
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
export const powerVCC = makePowerSymbol('powerVCC', 'VCC (power)', 'VCC', 'vcc', '#ef4444', 'Power port: VCC. All VCC power symbols share the same net.');
export const power5V = makePowerSymbol('power5V', '+5V (power)', '+5V', 'plus5', '#ef4444', 'Power port: +5V. All +5V power symbols share the same net.');
export const power3V3 = makePowerSymbol('power3V3', '+3.3V (power)', '+3.3V', 'plus3v3', '#22c55e', 'Power port: +3.3V.');
export const power12V = makePowerSymbol('power12V', '+12V (power)', '+12V', 'plus12', '#ef4444', 'Power port: +12V.');
export const powerMinus12V = makePowerSymbol('powerMinus12V', '-12V (power)', '-12V', 'minus12', '#3b82f6', 'Power port: -12V.');

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

registerPlugin(powerGND);
registerPlugin(powerVCC);
registerPlugin(power5V);
registerPlugin(power3V3);
registerPlugin(power12V);
registerPlugin(powerMinus12V);
registerPlugin(netLabel);
registerPlugin(bus);
registerPlugin(busLabel);
