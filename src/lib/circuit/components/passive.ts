// Passive components: resistor, capacitor, inductor.
// Capacitor and inductor use companion models (backward Euler) for transient analysis.

import type { ComponentPlugin } from '../types';
import { drawResistorZigzag, drawCapacitor, drawInductor, drawLabel } from './draw';
import { registerPlugin } from '../registry';

// ----- Resistor -----
const resistor: ComponentPlugin = {
  type: 'resistor',
  name: 'Resistor',
  category: 'passive',
  description: 'Linear resistor. V = I·R.',
  symbol: 'R',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'resistance', label: 'Resistance', type: 'number', default: 1000, unit: 'Ω', min: 0.001, max: 1e9, step: 1 },
  ],
  render(ctx, params, cellSize) {
    const len = 4 * cellSize;
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(3 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    drawResistorZigzag(ctx, 2 * cellSize, 12);
    drawLabel(ctx, `${formatR(params.resistance as number)}`, 0, -16);
  },
  stamp(params, terminals, sys) {
    const r = Math.max(1e-9, params.resistance as number);
    const g = 1 / r;
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    sys.stampConductance(a, b, g);
  },
  getFlowPath() {
    // Straight line from terminal a (0,1) through the body to terminal b (4,1)
    return [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
    ];
  },
  measure(params, terminals, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    const r = params.resistance as number;
    const i = v / r;
    return [
      { label: 'V', value: v.toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(3), unit: 'mA' },
      { label: 'P', value: (v * i * 1000).toFixed(3), unit: 'mW' },
    ];
  },
};

function formatR(r: number): string {
  if (r >= 1e6) return `${(r / 1e6).toFixed(2)}MΩ`;
  if (r >= 1e3) return `${(r / 1e3).toFixed(2)}kΩ`;
  if (r >= 1) return `${r.toFixed(0)}Ω`;
  if (r >= 1e-3) return `${(r * 1e3).toFixed(2)}mΩ`;
  return `${r.toExponential(2)}Ω`;
}

// ----- Capacitor -----
const capacitor: ComponentPlugin = {
  type: 'capacitor',
  name: 'Capacitor',
  category: 'passive',
  description: 'Linear capacitor. Q = C·V. Uses companion model for transient analysis.',
  symbol: 'C',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: '+', position: { x: 0, y: 1 } },
    { id: 'b', label: '-', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'capacitance', label: 'Capacitance', type: 'number', default: 1e-6, unit: 'F', min: 1e-15, max: 1, step: 1e-9 },
    { key: 'initialV', label: 'Initial Voltage', type: 'number', default: 0, unit: 'V', min: -1000, max: 1000, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(2 * cellSize - 3, cellSize);
    ctx.moveTo(2 * cellSize + 3, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    drawCapacitor(ctx, 6, 18);
    drawLabel(ctx, `${formatC(params.capacitance as number)}`, 0, -16);
  },
  stamp(params, terminals, sys, sim, comp) {
    const C = Math.max(1e-15, params.capacitance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `cap_${comp?.id ?? `${a}_${b}`}`;
    const vPrev = st[key] ?? (params.initialV as number);
    // companion model (backward Euler): G_eq = C/dt, I_eq = C/dt * vPrev
    // The Norton current source I_eq flows INTO node a (the positive plate),
    // representing the capacitor's stored charge pushing current out.
    // stampCurrentSource(b, a, iEq) injects into a and extracts from b.
    const dt = Math.max(sim.dt, 1e-12);
    const g = C / dt;
    const iEq = (C / dt) * vPrev;
    sys.stampConductance(a, b, g);
    sys.stampCurrentSource(b, a, iEq);  // FIXED: was (a, b) — wrong direction
  },
  getFlowPath() {
    // Straight through the capacitor plates
    return [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
    ];
  },
  step(params, terminals, sim, comp) {
    const C = Math.max(1e-15, params.capacitance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `cap_${comp?.id ?? `${a}_${b}`}`;
    const dt = Math.max(sim.dt, 1e-12);
    const vPrev = st[key] ?? (params.initialV as number);
    const vCurr = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    // Compute and store the current BEFORE updating vPrev.
    // I = C × dV/dt = (C/dt) × (V_curr - V_prev)
    // This must be done HERE because after we update st[key], the old vPrev
    // is lost and computeComponentCurrents would compute I = (C/dt) × 0 = 0.
    st[key + '_i'] = (C / dt) * (vCurr - vPrev);
    // Now update vPrev for the next step's stamp()
    st[key] = vCurr;
  },
  measure(params, terminals, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    return [{ label: 'V', value: v.toFixed(3), unit: 'V' }];
  },
};

function formatC(c: number): string {
  if (c >= 1) return `${c.toFixed(2)}F`;
  if (c >= 1e-3) return `${(c * 1e3).toFixed(2)}mF`;
  if (c >= 1e-6) return `${(c * 1e6).toFixed(2)}µF`;
  if (c >= 1e-9) return `${(c * 1e9).toFixed(2)}nF`;
  return `${(c * 1e12).toFixed(2)}pF`;
}

// ----- Inductor -----
const inductor: ComponentPlugin = {
  type: 'inductor',
  name: 'Inductor',
  category: 'passive',
  description: 'Linear inductor. V = L·dI/dt. Uses companion model for transient analysis.',
  symbol: 'L',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'inductance', label: 'Inductance', type: 'number', default: 1e-3, unit: 'H', min: 1e-9, max: 100, step: 1e-6 },
    { key: 'initialI', label: 'Initial Current', type: 'number', default: 0, unit: 'A', min: -100, max: 100, step: 0.01 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(3 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    drawInductor(ctx, 2 * cellSize, 4);
    drawLabel(ctx, `${formatL(params.inductance as number)}`, 0, -16);
  },
  stamp(params, terminals, sys, sim, comp) {
    const L = Math.max(1e-12, params.inductance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    // Use component ID for unique key — parallel inductors between the same
    // node pair must have independent state (different currents).
    const key = `ind_${comp?.id ?? `${a}_${b}`}`;
    const iPrev = st[key] ?? (params.initialI as number);
    // companion model (backward Euler):
    //   V = L * (I - iPrev) / dt   ->   V = (L/dt) * I - (L/dt) * iPrev
    //   stamp as voltage source with V = -L/dt * iPrev and series resistance R = L/dt
    // Equivalent: Thevenin: V_th = -(L/dt) * iPrev, R = L/dt
    //   -> stamp as conductance G = dt/L in parallel with current source I = iPrev
    const dt = Math.max(sim.dt, 1e-12);
    const g = dt / L;
    sys.stampConductance(a, b, g);
    sys.stampCurrentSource(a, b, iPrev);
  },
  getFlowPath() {
    // Straight through the inductor coils
    return [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
    ];
  },
  step(params, terminals, sim, comp) {
    const L = Math.max(1e-12, params.inductance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `ind_${comp?.id ?? `${a}_${b}`}`;
    const dt = Math.max(sim.dt, 1e-12);
    const iPrev = st[key] ?? (params.initialI as number);
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    const iCurr = iPrev + (v / L) * dt;
    // Store the current BEFORE updating iPrev.
    // I = iCurr (the inductor's state variable IS its current)
    // This must be done HERE because after we update st[key], the old iPrev
    // is lost and computeComponentCurrents would compute a stale current.
    st[key + '_i'] = iCurr;
    // Now update iPrev for the next step's stamp()
    st[key] = iCurr;
  },
  measure(params, terminals, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `ind_${a}_${b}`;
    const i = st[key] ?? 0;
    return [
      { label: 'V', value: (sim.nodeVoltage[a] - sim.nodeVoltage[b]).toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(3), unit: 'mA' },
    ];
  },
};

function formatL(l: number): string {
  if (l >= 1) return `${l.toFixed(2)}H`;
  if (l >= 1e-3) return `${(l * 1e3).toFixed(2)}mH`;
  if (l >= 1e-6) return `${(l * 1e6).toFixed(2)}µH`;
  return `${(l * 1e9).toFixed(2)}nH`;
}

// ----- Ground -----
const ground: ComponentPlugin = {
  type: 'ground',
  name: 'Ground',
  category: 'source',
  description: 'Reference 0V node. Required for any circuit.',
  symbol: 'GND',
  boundingBox: { width: 2, height: 2 },
  terminals: [
    { id: 'g', label: 'GND', position: { x: 1, y: 0 } },
  ],
  parameters: [],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(cellSize, 0);
    ctx.lineTo(cellSize, cellSize);
    ctx.stroke();
    ctx.translate(cellSize, cellSize);
    // ground symbol: three horizontal lines
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(8, 0);
    ctx.moveTo(-5, 4);
    ctx.lineTo(5, 4);
    ctx.moveTo(-2, 8);
    ctx.lineTo(2, 8);
    ctx.stroke();
  },
};

// ----- Wire / Node (just a junction dot) -----
const junction: ComponentPlugin = {
  type: 'junction',
  name: 'Junction',
  category: 'passive',
  description: 'Visual wire junction. Connects all attached terminals electrically.',
  symbol: '•',
  boundingBox: { width: 1, height: 1 },
  terminals: [
    { id: 'a', label: '', position: { x: 0, y: 0 } },
  ],
  parameters: [],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
  },
  stamp() {
    // no-op; node identity handled by wire graph
  },
};

registerPlugin(resistor);
registerPlugin(capacitor);
registerPlugin(inductor);
registerPlugin(ground);
registerPlugin(junction);

export { resistor, capacitor, inductor, ground, junction };
