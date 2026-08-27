// Hall-effect sensors: A1302-style linear ratiometric sensor (hallLinear) and
// US1881-style digital Hall switch with hysteresis (hallSwitch).
//
// There is no magnetic field solver in this engine, so the applied flux
// density B is a user-settable parameter (`field`, in millitesla) — the
// sensor's "input", standing in for magnet presence/position. Positive field
// = south pole facing the branded face (the activating polarity for both
// parts). Conversions: 1 G = 0.1 mT, so the A1302's 2.5 mV/G = 25 mV/mT.
//
// Multi-stamp safety (solveDC re-stamps the same solution per Newton
// iteration): neither plugin keys any decision off a solved voltage that its
// own stamp influences. The linear sensor's output depends only on parameters
// and the supply rail (driven externally), and the switch's hysteresis state
// depends only on the static `field` parameter — threshold logic with a
// hysteresis band is idempotent under repeated stamps by construction.

import type { ComponentPlugin, ComponentCategory } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';

// 'sensor' is not in the ComponentCategory union (widening it would touch
// types.ts). Every runtime consumer already treats categories as arbitrary
// strings with fallbacks — registry ordering (`categoryOrder[x] ?? 99`),
// palette label/icon (`categoryLabels[x] ?? x` / `?? CircuitBoard`) — so the
// cast is safe and groups both parts under their own palette section.
const SENSOR = 'sensor' as ComponentCategory;

// Shared body drawing: DIP-style rectangle, part name, magnetic-field arrows
// entering the branded face from the left (pink, like the photodiode's light
// arrows), pin labels. `openDrain` adds the OC bar on the output pin.
function drawHallBody(
  ctx: CanvasRenderingContext2D,
  cellSize: number,
  part: string,
  openDrain: boolean,
): void {
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
  // leads: vcc (top), gnd (bottom), out (right)
  ctx.beginPath();
  ctx.moveTo(2 * cellSize, 0.75 * cellSize); ctx.lineTo(2 * cellSize, 0);
  ctx.moveTo(2 * cellSize, 3.25 * cellSize); ctx.lineTo(2 * cellSize, 4 * cellSize);
  ctx.moveTo(3.25 * cellSize, 2 * cellSize); ctx.lineTo(4 * cellSize, 2 * cellSize);
  ctx.stroke();
  // body
  ctx.beginPath();
  ctx.rect(0.75 * cellSize, 0.75 * cellSize, 2.5 * cellSize, 2.5 * cellSize);
  ctx.stroke();
  // open-collector/drain bar on the output lead
  if (openDrain) {
    ctx.beginPath();
    ctx.moveTo(3.35 * cellSize, 1.55 * cellSize);
    ctx.lineTo(3.35 * cellSize, 2.45 * cellSize);
    ctx.stroke();
  }
  // field arrows entering the branded face (left)
  ctx.strokeStyle = '#f472b6'; ctx.lineWidth = 1.2;
  for (let i = 0; i < 2; i++) {
    const y = (1.4 + i * 1.2) * cellSize;
    ctx.beginPath();
    ctx.moveTo(0.15 * cellSize, y);
    ctx.lineTo(0.55 * cellSize, y);
    ctx.moveTo(0.4 * cellSize, y - 3);
    ctx.lineTo(0.55 * cellSize, y);
    ctx.lineTo(0.4 * cellSize, y + 3);
    ctx.stroke();
  }
  drawLabel(ctx, part, 2.05 * cellSize, 2 * cellSize);
  drawLabel(ctx, 'VCC', 1.35 * cellSize, 0.35 * cellSize, '#64748b');
  drawLabel(ctx, 'GND', 1.35 * cellSize, 3.65 * cellSize, '#64748b');
  drawLabel(ctx, 'OUT', 2.95 * cellSize, 1.4 * cellSize, '#64748b');
}

// ─────────────────────────────────────────────────────────────────────────────
// A1302 — linear ratiometric Hall-effect sensor
// ─────────────────────────────────────────────────────────────────────────────

// V(out) = Q·(Vcc/5) + S·(Vcc/5)·B  when ratiometric (both the quiescent
// level and the sensitivity track the actual supply — the defining property
// of ratiometric parts), otherwise Q + S·B. S is in mV/mT, B in mT. The
// output saturates 0.05 V from either rail. Stamped as a 1 Ω Thevenin source
// (conductance + current source, the LDO/comparator pattern): holds under
// load while modeling the part's finite output drive, and needs no extra
// MNA variable.
export const hallLinear: ComponentPlugin = {
  type: 'hallLinear',
  name: 'A1302 (Linear Hall Sensor)',
  category: SENSOR,
  description: 'Linear ratiometric Hall-effect sensor (A1302-style). Vout = quiescent·Vcc/5 + sensitivity·Vcc/5·B; set the field parameter (mT) to simulate a magnet. 2.5 mV/G = 25 mV/mT, output clamps 0.05V from either rail.',
  symbol: '1302',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    { id: 'out', label: 'OUT', position: { x: 4, y: 2 }, electricalType: 'output' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
    { key: 'sensitivity', label: 'Sensitivity (mV/mT)', type: 'number', default: 25, unit: 'mV/mT', min: 0.1, max: 100, step: 0.5 },
    { key: 'quiescent', label: 'Quiescent Output (V)', type: 'number', default: 2.5, unit: 'V', min: 0, max: 18, step: 0.05 },
    { key: 'field', label: 'Magnetic Field B (mT)', type: 'number', default: 0, unit: 'mT', min: -500, max: 500, step: 1 },
    { key: 'ratiometric', label: 'Ratiometric Output', type: 'boolean', default: true },
  ],
  keywords: ['hall', 'sensor', 'magnetic', 'magnet', 'field', 'a1302', 'linear', 'ratiometric', 'position'],
  datasheet: 'https://www.allegromicro.com/-/media/files/datasheets/a1302-datasheet.pdf',
  render(ctx, _params, cellSize) {
    drawHallBody(ctx, cellSize, 'A1302', false);
  },
  stamp(params, terminals, sys, sim) {
    const vcc = terminals.find(t => t.terminalId === 'vcc')!.nodeId;
    const gnd = terminals.find(t => t.terminalId === 'gnd')!.nodeId;
    const out = terminals.find(t => t.terminalId === 'out')!.nodeId;
    const vccNom = params.vcc as number;
    // Actual supply (previous iterate). An unwired VCC pin falls back to the
    // nominal parameter — same convention as the op-amp macromodels.
    const vccActual = vcc > 0 ? Math.max(0, sim.nodeVoltage[vcc] ?? vccNom) : vccNom;
    const ratio = (params.ratiometric as boolean) ? vccActual / 5 : 1;
    const sensEff = (params.sensitivity as number) * ratio;   // mV/mT
    const vQuies = (params.quiescent as number) * ratio;      // V
    const vRaw = vQuies + sensEff * (params.field as number) / 1000;
    // Output saturation: 0.05 V from either rail (rail guard for tiny supplies)
    const vHi = Math.max(0.05, vccActual - 0.05);
    const vOut = Math.min(vHi, Math.max(0.05, vRaw));
    // Power-pin leak keeps a wired-but-otherwise-idle supply net solvable.
    if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    if (gnd !== 0) sys.stampConductance(gnd, 0, 1e-13);
    if (out === 0) return; // unwired output maps to node 0 — nothing to drive
    // 1 Ω Thevenin output stage referenced to the sensor's own GND pin.
    const ROUT = 1;
    sys.stampConductance(out, gnd, 1 / ROUT);
    sys.stampCurrentSource(gnd, out, vOut / ROUT);
    // 1 µS output leakage to GND (spec'd): a probed but otherwise unloaded
    // output node can never float, even if the source stamp is bypassed.
    sys.stampConductance(out, gnd, 1e-6);
  },
  getFlowPath() { return [{ x: 2, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 2 }]; },
  measure(params, terminals, sim) {
    const out = terminals.find(t => t.terminalId === 'out')!.nodeId;
    const vcc = terminals.find(t => t.terminalId === 'vcc')!.nodeId;
    const vccActual = vcc > 0 ? Math.max(0, sim.nodeVoltage[vcc] ?? (params.vcc as number)) : (params.vcc as number);
    const ratio = (params.ratiometric as boolean) ? vccActual / 5 : 1;
    return [
      { label: 'Vout', value: (sim.nodeVoltage[out] ?? 0).toFixed(3), unit: 'V' },
      { label: 'B', value: (params.field as number).toFixed(1), unit: 'mT' },
      { label: 'Sens', value: ((params.sensitivity as number) * ratio).toFixed(2), unit: 'mV/mT' },
      { label: 'Vcc', value: vccActual.toFixed(3), unit: 'V' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// US1881 — digital Hall-effect switch (hysteresis, open-drain output)
// ─────────────────────────────────────────────────────────────────────────────

// Unipolar switch: B ≥ Bop (south pole) operates the output transistor,
// B ≤ Brp releases it; in between, the previous state is kept (hysteresis =
// Bop − Brp). The output is open-drain — ON pulls OUT to GND through ron,
// OFF is leakage only, so the high level comes from an external pull-up
// (or the optional internal 10 kΩ convenience pull-up to the VCC pin).
// The on/off state lives in sim.state.__global under stateKey('hallsw', comp)
// so it survives node renumbering and persists across chained steps.
export const hallSwitch: ComponentPlugin = {
  type: 'hallSwitch',
  name: 'US1881 (Hall Switch)',
  category: SENSOR,
  description: 'Digital Hall-effect switch (US1881-style) with hysteresis and open-drain output. Field ≥ Bop (south pole) pulls OUT low through ron; field ≤ Brp releases it. Needs an external pull-up — or enable internalPullup (10kΩ to VCC).',
  symbol: '1881',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    { id: 'out', label: 'OUT', position: { x: 4, y: 2 }, electricalType: 'open_collector' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 5, unit: 'V', min: 3, max: 24, step: 0.1 },
    { key: 'field', label: 'Magnetic Field B (mT)', type: 'number', default: 0, unit: 'mT', min: -500, max: 500, step: 1 },
    { key: 'bop', label: 'Bop Operate Point (mT)', type: 'number', default: 10, unit: 'mT', min: -200, max: 200, step: 0.5 },
    { key: 'brp', label: 'Brp Release Point (mT)', type: 'number', default: 5, unit: 'mT', min: -200, max: 200, step: 0.5 },
    { key: 'ron', label: 'On Resistance (Ω)', type: 'number', default: 25, unit: 'Ω', min: 0.001, max: 1e4, step: 1 },
    { key: 'internalPullup', label: 'Internal 10kΩ Pull-up', type: 'boolean', default: false },
  ],
  keywords: ['hall', 'sensor', 'magnetic', 'magnet', 'field', 'us1881', 'switch', 'digital', 'hysteresis', 'open-drain', 'open-collector'],
  render(ctx, _params, cellSize) {
    drawHallBody(ctx, cellSize, 'US1881', true);
  },
  stamp(params, terminals, sys, sim, comp) {
    const vcc = terminals.find(t => t.terminalId === 'vcc')!.nodeId;
    const gnd = terminals.find(t => t.terminalId === 'gnd')!.nodeId;
    const out = terminals.find(t => t.terminalId === 'out')!.nodeId;
    const field = params.field as number;
    const bop = params.bop as number;
    const brp = params.brp as number;
    // Hysteresis state. `field` is a parameter, not a solved voltage, so it
    // is constant for the whole solve: the band logic below is idempotent
    // under solveDC's repeated re-stamps of the same solution.
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('hallsw', comp, out);
    let on = (st[key] as boolean | undefined) ?? false;
    if (field >= bop) on = true;        // strong enough south pole → operate
    else if (field <= brp) on = false;  // below release → off
    // between Brp and Bop: keep the previous state (hysteresis band)
    st[key] = on;
    // Power-pin leaks keep wired-but-otherwise-idle nets solvable.
    if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
    if (gnd !== 0) sys.stampConductance(gnd, 0, 1e-13);
    // Optional internal 10 kΩ pull-up from OUT to the VCC pin (simulation
    // convenience — the real part is open-drain).
    if (params.internalPullup && vcc !== 0 && out !== 0) {
      sys.stampConductance(out, vcc, 1 / 10000);
    }
    if (out === 0) return; // unwired output maps to node 0 — nothing to pull
    if (on) {
      // Output transistor ON: open-drain pulls OUT to GND through ron.
      sys.stampConductance(out, gnd, 1 / Math.max(0.001, params.ron as number));
    } else {
      // OFF: leakage only (1e-9 S) — the external pull-up sets the level.
      sys.stampConductance(out, gnd, 1e-9);
    }
  },
  getFlowPath() { return [{ x: 4, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 4 }]; },
  measure(params, terminals, sim, comp) {
    const out = terminals.find(t => t.terminalId === 'out')!.nodeId;
    const st = (sim.state.__global ?? {}) as Record<string, unknown>;
    const on = (st[stateKey('hallsw', comp, out)] as boolean | undefined) ?? false;
    const bop = params.bop as number;
    const brp = params.brp as number;
    return [
      { label: 'State', value: on ? 'ON' : 'OFF', unit: '' },
      { label: 'B', value: (params.field as number).toFixed(1), unit: 'mT' },
      { label: 'Hyst', value: (bop - brp).toFixed(1), unit: 'mT' },
      { label: 'Vout', value: (sim.nodeVoltage[out] ?? 0).toFixed(3), unit: 'V' },
    ];
  },
};

// Register Hall-effect sensors
registerPlugin(hallLinear);
registerPlugin(hallSwitch);
