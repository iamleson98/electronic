// KiCad-parity schematic plugins:
//   - No-Connect marker (red X)
//   - Bus entry (diagonal stub from wire to bus)
//   - Hierarchical sheet (box pointing to a sub-sheet)
//   - Hierarchical label (label that propagates to parent sheet via sheet pin)
//   - Global label (label visible across all sheets, regardless of hierarchy)
//   - Power Flag (PWR_FLAG — tells ERC that a power net is externally driven)
//   - Custom Power Rail (user-defined power symbol)
//   - 7400-series multi-unit sample (Quad 2-input NAND with units A, B, C, D)

import type { ComponentPlugin } from '../types';
import { registerPlugin } from '../registry';
import { drawLabel } from './draw';

// ─────────────────────────────────────────────────────────────────────────────
// No-Connect marker — KiCad's red X on intentionally unused pins
//   (placed at a terminal to tell ERC "yes, this pin is intentionally left open")
// ─────────────────────────────────────────────────────────────────────────────

export const noConnectMarker: ComponentPlugin = {
  type: 'noConnect',
  name: 'No-Connect Flag',
  category: 'passive',
  description: 'Marks a pin as intentionally unconnected (suppresses ERC unconnected-pin error).',
  symbol: '✕',
  boundingBox: { width: 1, height: 1 },
  terminals: [{ id: 'p', label: '', position: { x: 0, y: 0 }, electricalType: 'nc' }],
  parameters: [],
  keywords: ['noconnect', 'nc', 'unconnected'],
  render(ctx, _params, cellSize) {
    const s = cellSize * 0.4;
    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-s, -s); ctx.lineTo(s, s);
    ctx.moveTo(s, -s); ctx.lineTo(-s, s);
    ctx.stroke();
    ctx.restore();
  },
  stamp() { /* no-op — purely graphical */ },
  getFlowPath() { return []; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bus entry — diagonal stub connecting a wire to a bus
// ─────────────────────────────────────────────────────────────────────────────

export const busEntry: ComponentPlugin = {
  type: 'busEntry',
  name: 'Bus Entry',
  category: 'passive',
  description: 'Diagonal stub connecting a single-bit wire to a multi-bit bus.',
  symbol: '╱',
  boundingBox: { width: 2, height: 2 },
  terminals: [
    { id: 'wire', label: 'Wire', position: { x: 0, y: 2 }, electricalType: 'passive' },
    { id: 'bus', label: 'Bus', position: { x: 2, y: 0 }, electricalType: 'passive' },
  ],
  parameters: [],
  render(ctx, _params, cellSize) {
    ctx.save();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize);
    ctx.lineTo(2 * cellSize, 0);
    ctx.stroke();
    ctx.restore();
  },
  stamp() { /* bus entry is just a wire — node identity handled by wire graph */ },
  getFlowPath() { return [{ x: 0, y: 2 }, { x: 2, y: 0 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Power Flag — tells ERC that a power net is externally driven
//   (KiCad equivalent of PWR_FLAG — saves you from "Power net not driven" warnings)
// ─────────────────────────────────────────────────────────────────────────────

export const powerFlag: ComponentPlugin = {
  type: 'powerFlag',
  name: 'PWR_FLAG',
  category: 'source',
  description: 'Tells ERC that a power net is externally driven (suppresses "power undriven" warning).',
  symbol: '⚡',
  boundingBox: { width: 2, height: 2 },
  terminals: [{ id: 'p', label: 'PWR_FLAG', position: { x: 1, y: 0 }, electricalType: 'power_out' }],
  parameters: [
    { key: 'net', label: 'Net Name', type: 'string', default: 'VCC' },
  ],
  render(ctx, params, cellSize) {
    const net = (params.net as string) || 'VCC';
    ctx.save();
    ctx.strokeStyle = '#facc15';
    ctx.fillStyle = '#facc15';
    ctx.lineWidth = 1.5;
    // flag pole
    ctx.beginPath();
    ctx.moveTo(cellSize, 0);
    ctx.lineTo(cellSize, cellSize * 0.5);
    ctx.stroke();
    // flag triangle
    ctx.translate(cellSize, cellSize * 0.5);
    const w = cellSize * 1.2, h = cellSize * 0.9;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, h); ctx.lineTo(w, h);
    ctx.lineTo(w * 0.7, h * 0.5); ctx.lineTo(w, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // label
    ctx.fillStyle = '#facc15';
    ctx.font = `bold ${Math.floor(cellSize * 0.35)}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('P', w * 0.5, h * 0.65);
    drawLabel(ctx, net, 0, cellSize * 1.1, '#facc15');
    ctx.restore();
  },
  stamp() { /* purely declarative for ERC */ },
  getFlowPath() { return []; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Custom Power Rail — user-defined power symbol (any net name, any voltage)
// ─────────────────────────────────────────────────────────────────────────────

export const customPower: ComponentPlugin = {
  type: 'customPower',
  name: 'Custom Power Rail',
  category: 'source',
  description: 'User-defined power symbol — specify net name and nominal voltage.',
  symbol: 'P',
  boundingBox: { width: 2, height: 2 },
  terminals: [{ id: 'p', label: 'PWR', position: { x: 1, y: 0 }, electricalType: 'power_out' }],
  parameters: [
    { key: 'net', label: 'Net Name', type: 'string', default: 'VDD' },
    { key: 'voltage', label: 'Nominal Voltage', type: 'number', default: 3.3, unit: 'V', min: -100, max: 100, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    const net = (params.net as string) || 'VDD';
    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.fillStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    // vertical stub
    ctx.beginPath();
    ctx.moveTo(cellSize, 0); ctx.lineTo(cellSize, cellSize * 0.5);
    ctx.stroke();
    ctx.translate(cellSize, cellSize * 0.5);
    // arrow-up symbol
    const w = cellSize * 1.2;
    ctx.beginPath();
    ctx.moveTo(-w / 2, cellSize * 0.4);
    ctx.lineTo(w / 2, cellSize * 0.4);
    ctx.lineTo(0, -cellSize * 0.4);
    ctx.closePath();
    ctx.stroke();
    drawLabel(ctx, net, 0, cellSize * 1.1, '#ef4444');
    ctx.restore();
  },
  stamp(params, terminals, sys) {
    const net = (params.net as string) || 'VDD';
    const voltage = (params.voltage as number) ?? 0;
    const node = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    if (net === 'GND' || net === 'gnd' || net === '0') return;
    if (voltage !== 0) {
      const gPull = 1e-6;
      sys.stampConductance(node, 0, gPull);
      sys.stampCurrentSource(0, node, voltage * gPull);
    }
  },
  getFlowPath() { return [{ x: 1, y: 0 }, { x: 1, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchical label — label that propagates up to parent sheet via sheet pin
// ─────────────────────────────────────────────────────────────────────────────

export const hierarchicalLabel: ComponentPlugin = {
  type: 'hierLabel',
  name: 'Hierarchical Label',
  category: 'source',
  description: 'Label visible in the parent sheet as a sheet pin. Connects across sheet boundaries.',
  symbol: 'H',
  boundingBox: { width: 4, height: 1 },
  terminals: [{ id: 'p', label: 'Net', position: { x: 0, y: 0 }, electricalType: 'passive' }],
  parameters: [
    { key: 'net', label: 'Net Name', type: 'string', default: 'NET1' },
    {
      key: 'direction', label: 'Direction', type: 'select', default: 'input',
      options: [
        { label: 'Input', value: 'input' },
        { label: 'Output', value: 'output' },
        { label: 'Bidirectional', value: 'bidirectional' },
        { label: 'Tri-state', value: 'tri_state' },
        { label: 'Passive', value: 'passive' },
      ],
    },
  ],
  render(ctx, params, cellSize) {
    const net = (params.net as string) || 'NET1';
    const dir = (params.direction as string) || 'input';
    ctx.save();
    const colorMap: Record<string, string> = {
      input: '#22c55e', output: '#ef4444',
      bidirectional: '#a855f7', tri_state: '#f59e0b', passive: '#94a3b8',
    };
    const color = colorMap[dir] ?? '#22d3ee';
    ctx.strokeStyle = color; ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1.5;
    const w = Math.max(net.length * cellSize * 0.32, cellSize * 1.5);
    const h = cellSize * 0.7;
    // Pentagon tag: input points INTO the sheet (left), output points OUT
    // (right), everything else is a plain rectangle.
    ctx.beginPath();
    if (dir === 'output') {
      ctx.moveTo(0, -h / 2); ctx.lineTo(w, -h / 2);
      ctx.lineTo(w + h * 0.5, 0);
      ctx.lineTo(w, h / 2); ctx.lineTo(0, h / 2);
    } else if (dir === 'input') {
      ctx.moveTo(0, 0);
      ctx.lineTo(h * 0.5, -h / 2);
      ctx.lineTo(w + h * 0.5, -h / 2);
      ctx.lineTo(w + h * 0.5, h / 2);
      ctx.lineTo(h * 0.5, h / 2);
    } else {
      ctx.rect(0, -h / 2, w, h);
    }
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(net, cellSize * 0.3, 0);
    ctx.restore();
  },
  stamp() {},
  getFlowPath() { return [{ x: 0, y: 0 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Global label — label visible across ALL sheets regardless of hierarchy
// ─────────────────────────────────────────────────────────────────────────────

export const globalLabel: ComponentPlugin = {
  type: 'globalLabel',
  name: 'Global Label',
  category: 'source',
  description: 'Label visible across all sheets (no sheet-pin boundary). All global labels with the same name are connected.',
  symbol: 'G',
  boundingBox: { width: 4, height: 1 },
  terminals: [{ id: 'p', label: 'Net', position: { x: 0, y: 0 }, electricalType: 'passive' }],
  parameters: [
    { key: 'net', label: 'Net Name', type: 'string', default: 'GNET1' },
    {
      key: 'shape', label: 'Shape', type: 'select', default: 'pentagon',
      options: [
        { label: 'Pentagon', value: 'pentagon' },
        { label: 'Circle', value: 'circle' },
        { label: 'Banner', value: 'banner' },
      ],
    },
  ],
  render(ctx, params, cellSize) {
    const net = (params.net as string) || 'GNET1';
    const shape = (params.shape as string) || 'pentagon';
    ctx.save();
    ctx.strokeStyle = '#f472b6'; ctx.fillStyle = 'rgba(244,114,182,0.1)'; ctx.lineWidth = 1.5;
    const w = Math.max(net.length * cellSize * 0.32, cellSize * 1.5);
    const h = cellSize * 0.7;
    if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(w / 2, 0, Math.max(w, h) / 2, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    } else if (shape === 'banner') {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w * 0.1, -h / 2);
      ctx.lineTo(w, -h / 2);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(w * 0.1, h / 2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    } else {
      // pentagon (default)
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w * 0.2, -h / 2);
      ctx.lineTo(w + w * 0.2, -h / 2);
      ctx.lineTo(w + w * 0.5, 0);
      ctx.lineTo(w + w * 0.2, h / 2);
      ctx.lineTo(w * 0.2, h / 2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = '#f472b6';
    ctx.font = `bold ${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(net, cellSize * 0.3, 0);
    ctx.restore();
  },
  stamp() {},
  getFlowPath() { return [{ x: 0, y: 0 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchical sheet (box pointing to a sub-sheet)
//   When placed, it creates a child sheet with empty content. Sheet pins are
//   added by clicking on the box edges.
// ─────────────────────────────────────────────────────────────────────────────

export const hierarchicalSheet: ComponentPlugin = {
  type: 'hierSheet',
  name: 'Hierarchical Sheet',
  category: 'ic',
  description: 'Places a sub-sheet instance. Sub-sheet content is opened by double-clicking the box.',
  symbol: '□',
  boundingBox: { width: 10, height: 6 },
  terminals: [],  // sheet pins are dynamic, not pre-defined
  parameters: [
    { key: 'sheetName', label: 'Sheet Name', type: 'string', default: 'subsheet' },
    { key: 'fileName', label: 'File Name', type: 'string', default: 'subsheet.kicad_sch' },
  ],
  render(ctx, params, cellSize) {
    const sheetName = (params.sheetName as string) || 'subsheet';
    const fileName = (params.fileName as string) || 'subsheet.kicad_sch';
    ctx.save();
    ctx.strokeStyle = '#3b82f6';
    ctx.fillStyle = 'rgba(59,130,246,0.05)';
    ctx.lineWidth = 1.5;
    const w = 10 * cellSize, h = 6 * cellSize;
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.fill(); ctx.stroke();
    // sheet name (top)
    ctx.fillStyle = '#3b82f6';
    ctx.font = `bold ${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(sheetName, cellSize * 0.3, cellSize * 0.3);
    // file name (bottom)
    ctx.fillStyle = '#64748b';
    ctx.font = `${Math.floor(cellSize * 0.35)}px ui-monospace, monospace`;
    ctx.fillText(fileName, cellSize * 0.3, h - cellSize * 0.5);
    ctx.restore();
  },
  stamp() { /* sheet pins are flattened at simulation time via subcircuit.ts */ },
  getFlowPath() { return []; },
};

// ─────────────────────────────────────────────────────────────────────────────
// 7400-series multi-unit sample — Quad 2-input NAND gate (units A, B, C, D)
//   Each unit is a separate component instance with same refdes but different unit.
//   The plugin declares units=['A','B','C','D'] and 3 terminals per unit.
// ─────────────────────────────────────────────────────────────────────────────

function makeNandGateUnit(unitLabel: string): ComponentPlugin {
  return {
    type: `7400_${unitLabel}`,
    name: `7400 NAND Gate (Unit ${unitLabel})`,
    category: 'logic',
    description: `Quad 2-input NAND gate, unit ${unitLabel}. Place all 4 units to form a 7400.`,
    symbol: '&',
    boundingBox: { width: 4, height: 4 },
    units: ['A', 'B', 'C', 'D'],
    terminals: [
      { id: 'in1', label: 'A', position: { x: 0, y: 1 }, electricalType: 'input', number: '1' },
      { id: 'in2', label: 'B', position: { x: 0, y: 3 }, electricalType: 'input', number: '2' },
      { id: 'out', label: 'Y', position: { x: 4, y: 2 }, electricalType: 'output', number: '3' },
      // hidden power pins (auto-connected by net name VCC/GND)
      { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 }, electricalType: 'power_in', number: '14', hidden: true },
      { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in', number: '7', hidden: true },
    ],
    parameters: [],
    keywords: ['nand', '7400', 'logic', 'gate'],
    defaultFootprint: 'DIP-14',
    datasheet: 'https://www.ti.com/lit/ds/symlink/sn74ls00.pdf',
    pinSwapGroups: [['in1', 'in2']], // the two inputs are swappable
    render(ctx, _params, cellSize) {
      ctx.save();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      // AND gate body (D-shape)
      const w = 4 * cellSize, h = 4 * cellSize;
      const r = h * 0.4;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w * 0.55, 0);
      ctx.arc(w * 0.55, h / 2, r, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.stroke();
      // bubble (inverter)
      ctx.beginPath();
      ctx.arc(w * 0.55 + r + cellSize * 0.15, h / 2, cellSize * 0.15, 0, Math.PI * 2);
      ctx.stroke();
      // input leads
      ctx.beginPath();
      ctx.moveTo(0, cellSize); ctx.lineTo(-cellSize * 0.3, cellSize);
      ctx.moveTo(0, h - cellSize); ctx.lineTo(-cellSize * 0.3, h - cellSize);
      ctx.stroke();
      // output lead
      ctx.beginPath();
      ctx.moveTo(w * 0.55 + r + cellSize * 0.3, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      ctx.restore();
    },
    stamp(params, terminals, sys, sim) {
      const in1 = terminals.find((t) => t.terminalId === 'in1')!.nodeId;
      const in2 = terminals.find((t) => t.terminalId === 'in2')!.nodeId;
      const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
      // simple NAND: out = !(in1 > 2.5 && in2 > 2.5) ? 5 : 0
      const v1 = sim.nodeVoltage[in1] ?? 0;
      const v2 = sim.nodeVoltage[in2] ?? 0;
      const outV = (v1 > 2.5 && v2 > 2.5) ? 0 : 5;
      sys.stampVoltageSource(out, 0, outV);
    },
    getFlowPath() { return [{ x: 0, y: 2 }, { x: 4, y: 2 }]; },
  };
}

export const nandGateA = makeNandGateUnit('A');
export const nandGateB = makeNandGateUnit('B');
export const nandGateC = makeNandGateUnit('C');
export const nandGateD = makeNandGateUnit('D');

// ─────────────────────────────────────────────────────────────────────────────
// Register everything
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin(noConnectMarker);
registerPlugin(busEntry);
registerPlugin(powerFlag);
registerPlugin(customPower);
registerPlugin(hierarchicalLabel);
registerPlugin(globalLabel);
registerPlugin(hierarchicalSheet);
registerPlugin(nandGateA);
registerPlugin(nandGateB);
registerPlugin(nandGateC);
registerPlugin(nandGateD);
