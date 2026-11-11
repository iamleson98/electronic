// Semiconductors & ICs: diode, NPN/PNP BJT, NMOS/PMOS MOSFET, ideal op-amp, 555 timer,
// logic gates, voltmeter, ammeter, oscilloscope.

import type { ComponentPlugin, CircuitComponent, SimContext } from '../types';
import { drawLabel } from './draw';
import { partOptions, defaultPart } from '../discrete-presets';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';
import { termNode } from '../terminal-lookup';
import { thermalVoltage } from '../sim-options';
import { stampBJT, stepBJT, measureBJT, stampSimpleDiode, stepSimpleDiode, simpleDiodeCurrent } from './advanced-semi';
import { stampOpamp, stepOpamp, specFromParams, type OpampPins } from './opamp-core';

function idealPins(terminals: { terminalId: string; nodeId: number }[]): OpampPins {
  return {
    inp: terminals.find((t) => t.terminalId === 'in+')!.nodeId,
    inn: terminals.find((t) => t.terminalId === 'in-')!.nodeId,
    out: terminals.find((t) => t.terminalId === 'out')!.nodeId,
    vcc: 0,
    vee: 0,
  };
}
/** Ideal op-amp: no pole/slew, ~0 Ω output, limited to [vmin, vmax]. */
function idealSpec(params: Record<string, any>) {
  const vmax = typeof params.vmax === 'number' ? params.vmax : 15;
  const vmin = typeof params.vmin === 'number' ? params.vmin : -15;
  return specFromParams({ gain: params.gain, rout: 1e-3, swingHigh: 0, swingLow: 0 }, { defVcc: vmax, defVee: vmin });
}

// ----- Diode -----
const diode: ComponentPlugin = {
  type: 'diode',
  name: 'Diode',
  category: 'semiconductor',
  description: 'Silicon diode with the Shockley (exponential) I-V curve: Forward Voltage is the drop at 1 mA (1N4148 ≈ 0.7 V), On Resistance the bulk series resistance, Off Resistance a parallel leakage.',
  symbol: '▷',
  nonLinear: true,
  pureStamp: true, // stamp() only rewrites idempotent topology keys; Newton memory lives in sim.newtonMemory
  pureStatePrefixes: ['dio_'],
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'k', label: 'K', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'forwardV', label: 'Forward Voltage (at 1 mA)', type: 'number', default: 0.7, unit: 'V', min: 0.1, max: 5, step: 0.05 },
    { key: 'onR', label: 'Series Resistance', type: 'number', default: 1, unit: 'Ω', min: 0.001, max: 1e6, step: 0.1 },
    { key: 'offR', label: 'Leakage Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
    { key: 'ratedCurrent', label: 'Max Forward Current', type: 'number', default: 0.3, unit: 'A', min: 0.001, max: 1000, step: 0.1, description: 'Absolute-maximum continuous If for the stress check. Defaults are a 1N4148 (300 mA / 100 V); 1N4007 = 1 A / 1000 V, 1N5819 = 1 A / 40 V.' },
    { key: 'ratedReverseV', label: 'Max Reverse Voltage', type: 'number', default: 100, unit: 'V', min: 1, max: 10000, step: 1 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(2 * cellSize - 8, cellSize);
    ctx.moveTo(2 * cellSize + 8, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    // triangle (anode)
    ctx.beginPath();
    ctx.moveTo(-8, -8);
    ctx.lineTo(-8, 8);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.stroke();
    // bar (cathode)
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(0, 8);
    ctx.lineWidth = 2;
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    stampSimpleDiode('diode', params, terminals, sys, sim, comp);
  },
  step(params, terminals, sim, comp) {
    stepSimpleDiode('diode', params, terminals, sim, comp);
  },
  getFlowPath() {
    // anode (0,1) through body to cathode (4,1)
    return [{ x: 0, y: 1 }, { x: 4, y: 1 }];
  },
  measure(_params, terminals, sim, comp) {
    const a = termNode(terminals, 'a', 0);
    const k = termNode(terminals, 'k', 1);
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    const i = comp ? simpleDiodeCurrent(comp, sim, a, k) : 0;
    return [{ label: 'V', value: v.toFixed(3), unit: 'V' }, { label: 'I', value: (i * 1000).toFixed(3), unit: 'mA' }];
  },
};

// ----- NPN BJT -----
/** Vendor SPICE capacitance / transit-time data of the preset parts (DC model is the hFE / VBE fit). */
const BJT_DYNAMICS: Record<string, Record<string, number>> = {
  '2N3904': { Cje: 4.493e-12, Mje: 0.2593, Vje: 0.75, Cjc: 3.638e-12, Mjc: 0.3085, Vjc: 0.75, Tf: 301.2e-12, Tr: 239.5e-9 },
  '2N2222A': { Cje: 22.01e-12, Mje: 0.377, Vje: 0.75, Cjc: 7.306e-12, Mjc: 0.3416, Vjc: 0.75, Tf: 411.1e-12, Tr: 46.91e-9 },
  'BC547B': { Cje: 13.58e-12, Mje: 0.3279, Vje: 0.65, Cjc: 3.728e-12, Mjc: 0.2955, Vjc: 0.3997, Tf: 439.1e-12, Tr: 1e-9 },
};
BJT_DYNAMICS['MMBT3904'] = BJT_DYNAMICS['2N3904'];
BJT_DYNAMICS['PN2222A'] = BJT_DYNAMICS['2N2222A'];
BJT_DYNAMICS['P2N2222A'] = BJT_DYNAMICS['2N2222A'];

/** Gummel-Poon parameters for the basic BJT parts: β = hFE, and Is set so
 *  that Vbe = "VBE (on)" at Ic = 1 mA. No Early effect / knee (the simple
 *  part has no parameters for them). For parts with known vendor models the
 *  junction capacitances and transit times (CJE/CJC/VJE/VJC/MJE/MJC/TF/TR)
 *  are added so switching speed and RF behaviour are realistic; they carry no
 *  DC current, so DC results are unchanged. */
export function simpleBjtModel(hfe: number, vOn: number, part?: unknown): Record<string, number> {
  const dyn = BJT_DYNAMICS[String(part ?? '')];
  return { Is: 1e-3 / Math.exp(vOn / thermalVoltage(27)), Bf: Math.max(1, hfe), Br: 1, Vaf: 1e6, Var: 1e6, Ikf: 1e6, ...dyn };
}

const npn: ComponentPlugin = {
  type: 'npn',
  name: 'NPN Transistor',
  category: 'semiconductor',
  description: 'NPN BJT — exponential (Ebers–Moll) junctions: β = hFE, Vbe = VBE(on) at 1 mA, real gm = Ic/Vt and natural saturation. Works as a switch and in linear amplifiers.',
  symbol: 'NPN',
  nonLinear: true,
  pureStamp: true, // stamp() only rewrites idempotent topology keys; Newton memory lives in sim.newtonMemory
  pureStatePrefixes: ['spq_'],
  boundingBox: { width: 3, height: 4 },
  terminals: [
    { id: 'c', label: 'C', position: { x: 3, y: 0 } },
    { id: 'b', label: 'B', position: { x: 0, y: 2 } },
    { id: 'e', label: 'E', position: { x: 3, y: 4 } },
  ],
  parameters: [
    { key: 'part', label: 'Part (loads datasheet values)', type: 'select', default: defaultPart('npn'), options: partOptions('npn') },
    { key: 'hfe', label: 'DC Gain (hFE)', type: 'number', default: 100, unit: '', min: 1, max: 1000, step: 1 },
    { key: 'vbe', label: 'VBE at 1 mA', type: 'number', default: 0.7, unit: 'V', min: 0.1, max: 1.5, step: 0.05 },
  ],
  render(ctx, params, cellSize) {
    // base lead
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize);
    ctx.lineTo(cellSize * 1.2, 2 * cellSize);
    ctx.stroke();
    // collector & emitter leads
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 0);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.moveTo(3 * cellSize, cellSize * 2.8);
    ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.stroke();
    // body vertical line
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 1.2);
    ctx.lineTo(cellSize * 1.2, cellSize * 2.8);
    ctx.lineWidth = 2;
    ctx.stroke();
    // base -> collector line
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 1.5);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.stroke();
    // base -> emitter line
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.2, cellSize * 2.5);
    ctx.lineTo(3 * cellSize, cellSize * 2.8);
    ctx.stroke();
    // arrow on emitter — NPN: arrow points OUTWARD (toward emitter terminal)
    // The emitter line goes from (1.2, 2.5) to (3, 2.8). The arrow is at the
    // emitter end (3, 2.8), pointing outward (away from body).
    // Direction vector: (3-1.2, 2.8-2.5) = (1.8, 0.3), normalized.
    const emDir = { x: 1.8, y: 0.3 };
    const emLen = Math.hypot(emDir.x, emDir.y);
    const emN = { x: emDir.x / emLen, y: emDir.y / emLen };
    // Arrow tip at emitter terminal
    const tipX = 3 * cellSize;
    const tipY = cellSize * 2.8;
    // Arrow base (perpendicular to direction, 8px back from tip)
    const arrowLen = 8;
    const arrowWid = 4;
    const baseX = tipX - emN.x * arrowLen;
    const baseY = tipY - emN.y * arrowLen;
    // Perpendicular vector
    const perp = { x: -emN.y, y: emN.x };
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX + perp.x * arrowWid, baseY + perp.y * arrowWid);
    ctx.lineTo(baseX - perp.x * arrowWid, baseY - perp.y * arrowWid);
    ctx.closePath();
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, `β=${params.hfe}`, 1.8 * cellSize, 3.5 * cellSize);
  },
  getFlowPath() {
    // Collector (3,0) -> body center (1.5,2) -> Emitter (3,4)
    // Current flows C→E when on. Base is separate (small current).
    return [
      { x: 3, y: 0 },
      { x: 1.5, y: 2 },
      { x: 3, y: 4 },
    ];
  },
  // Exponential junctions (shared Gummel-Poon core). The old model held the
  // B-E junction at a fixed vbeOn: its transconductance was effectively
  // infinite (later 100 S through a 1 Ω series R) instead of Ic/Vt ≈ 40 mS at
  // 1 mA, so every un-degenerated stage — a bypassed common-emitter amp — had
  // absurd gain and clipped.
  stamp(params, terminals, sys, sim, comp) {
    stampBJT(simpleBjtModel(params.hfe as number, params.vbe as number, params.part), terminals, sys, sim, comp, true);
  },
  step(params, terminals, sim, instance) {
    stepBJT(simpleBjtModel(params.hfe as number, params.vbe as number, params.part), terminals, sim, instance, true);
  },
  measure(params, terminals, sim, comp) {
    return measureBJT(simpleBjtModel(params.hfe as number, params.vbe as number, params.part), terminals, sim, comp, true);
  },
};

// ----- Ideal Op-Amp -----
const opamp: ComponentPlugin = {
  type: 'opamp',
  name: 'Op-Amp (ideal)',
  category: 'ic',
  description: 'Ideal op-amp: very high gain, no bandwidth limit, near-zero output resistance. Power terminals omitted — the output is limited to the Max/Min Output voltages (±15 V by default), like a real op-amp on ±15 V rails. Press M to toggle De Morgan alternate body (rectangle form).',
  // smooth output limiting (opamp-core.ts) — Newton re-stamp loop
  nonLinear: true,
  opampModel: { spec: idealSpec, pins: { inp: 'in+', inn: 'in-', out: 'out' }, rin: 1e6 },
  symbol: 'OP',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'in+', label: '+', position: { x: 0, y: 1 } },
    { id: 'in-', label: '-', position: { x: 0, y: 3 } },
    { id: 'out', label: 'out', position: { x: 4, y: 2 } },
  ],
  // Pin swap groups: the two inputs can be swapped (with sign inversion in the
  // external circuit, but for purely structural purposes they're swappable)
  pinSwapGroups: [['in+', 'in-']],
  hasAlternateBody: true,
  parameters: [
    { key: 'gain', label: 'Open-loop Gain', type: 'number', default: 1e5, unit: '', min: 1, max: 1e9, step: 100 },
    { key: 'vmax', label: 'Max Output', type: 'number', default: 15, unit: 'V', min: -1000, max: 1000, step: 0.5 },
    { key: 'vmin', label: 'Min Output', type: 'number', default: -15, unit: 'V', min: -1000, max: 1000, step: 0.5 },
  ],
  render(ctx, params, cellSize, _sim, instance) {
    // leads (common to both body styles)
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize * 1.2, cellSize);
    ctx.moveTo(0, 3 * cellSize);
    ctx.lineTo(cellSize * 1.2, 3 * cellSize);
    ctx.moveTo(2.8 * cellSize, 2 * cellSize);
    ctx.lineTo(4 * cellSize, 2 * cellSize);
    ctx.stroke();
    // De Morgan alternate body style: rectangular box (IEC convention)
    if (instance?.convert === 2) {
      ctx.fillStyle = '#fef3c7';
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(cellSize * 1.2, cellSize * 0.4, cellSize * 1.6, cellSize * 3.2);
      ctx.fill();
      ctx.stroke();
      // IEC op-mp symbol: ampersand-like character or "∞" for infinite gain
      ctx.fillStyle = '#0f172a';
      ctx.font = `bold ${Math.floor(cellSize * 0.7)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('∞', cellSize * 2, cellSize * 2);
      // + and - markers (smaller, inside the box)
      ctx.font = `${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
      ctx.fillText('+', cellSize * 1.4, cellSize);
      ctx.fillText('−', cellSize * 1.4, 3 * cellSize);
    } else {
      // Default triangle body
      ctx.beginPath();
      ctx.moveTo(cellSize * 1.2, cellSize * 0.4);
      ctx.lineTo(cellSize * 1.2, cellSize * 3.6);
      ctx.lineTo(cellSize * 2.8, cellSize * 2);
      ctx.closePath();
      ctx.fillStyle = '#fef3c7';
      ctx.fill();
      ctx.stroke();
      drawLabel(ctx, '+', cellSize * 1.5, cellSize);
      drawLabel(ctx, '−', cellSize * 1.5, 3 * cellSize);
    }
  },
  stamp(params, terminals, sys, sim, comp) {
    const pins = idealPins(terminals);
    // high-impedance input bias (1 MΩ to GND) on both input pins
    sys.stampConductance(pins.inp, 0, 1e-6);
    sys.stampConductance(pins.inn, 0, 1e-6);
    stampOpamp(idealSpec(params), pins, sys, sim, stateKey('opampIdeal', comp, pins.out));
  },
  step(_params, terminals, sim, comp) {
    stepOpamp(sim, stateKey('opampIdeal', comp, idealPins(terminals).out));
  },
  measure(params, terminals, sim) {
    const inp = terminals.find((t) => t.terminalId === 'in+')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in-')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    return [
      { label: 'V+', value: sim.nodeVoltage[inp].toFixed(3), unit: 'V' },
      { label: 'V-', value: sim.nodeVoltage[inn].toFixed(3), unit: 'V' },
      { label: 'Vout', value: sim.nodeVoltage[out].toFixed(3), unit: 'V' },
    ];
  },
};

// ----- 555 Timer -----
/** Supply across the VCC/GND pins; falls back to the legacy `vcc` param only when VCC is unwired (maps to ground). */
function supply555(
  params: Record<string, any>,
  terminals: { terminalId: string; nodeId: number }[],
  sim: SimContext,
): number {
  const vccNode = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
  const gndNode = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
  if (vccNode === gndNode) return typeof params.vcc === 'number' ? params.vcc : 5;
  return (sim.nodeVoltage[vccNode] ?? 0) - (sim.nodeVoltage[gndNode] ?? 0);
}

const timer555: ComponentPlugin = {
  type: 'timer555',
  nonLinear: true, // output stage / thresholds follow node voltages
  name: '555 Timer',
  category: 'ic',
  description: 'NE555 timer IC. Supports astable and monostable modes. Connect THR+TRIG together and DIS to a RC network for astable.',
  symbol: '555',
  boundingBox: { width: 6, height: 6 },
  terminals: [
    { id: 'gnd', label: 'GND', position: { x: 0, y: 1 } },
    { id: 'trig', label: 'TRIG', position: { x: 0, y: 2 } },
    { id: 'out', label: 'OUT', position: { x: 6, y: 1 } },
    { id: 'rst', label: 'RST', position: { x: 0, y: 3 } },
    { id: 'ctrl', label: 'CTRL', position: { x: 0, y: 4 } },
    { id: 'thr', label: 'THR', position: { x: 0, y: 5 } },
    { id: 'dis', label: 'DIS', position: { x: 6, y: 5 } },
    { id: 'vcc', label: 'VCC', position: { x: 6, y: 2 } },
  ],
  parameters: [
    { key: 'vcc', label: 'VCC (only if VCC pin unwired)', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
    { key: 'astable', label: 'Astable Mode', type: 'boolean', default: false },
    { key: 'r1', label: 'R1 (Ω)', type: 'number', default: 47000, unit: 'Ω', min: 1, max: 1e9, step: 1000 },
    { key: 'r2', label: 'R2 (Ω)', type: 'number', default: 47000, unit: 'Ω', min: 1, max: 1e9, step: 1000 },
    { key: 'c', label: 'C (F)', type: 'number', default: 1e-5, unit: 'F', min: 1e-12, max: 1, step: 1e-6 },
  ],
  render(ctx, params, cellSize) {
    const w = 6 * cellSize;
    const h = 6 * cellSize;
    // body
    ctx.fillStyle = '#1e3a5f';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize * 0.2, cellSize * 0.2, w - cellSize * 0.4, h - cellSize * 0.4);
    ctx.fill();
    ctx.stroke();
    // label
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `bold ${Math.floor(cellSize * 1.1)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('555', 3 * cellSize, 3 * cellSize);
    ctx.font = `${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
    // pin labels
    const left = [
      { y: 1, label: 'GND' },
      { y: 2, label: 'TRIG' },
      { y: 3, label: 'RST' },
      { y: 4, label: 'CTRL' },
      { y: 5, label: 'THR' },
    ];
    const right = [
      { y: 1, label: 'OUT' },
      { y: 2, label: 'VCC' },
      { y: 5, label: 'DIS' },
    ];
    ctx.textAlign = 'left';
    for (const p of left) {
      ctx.fillText(p.label, cellSize * 0.3, p.y * cellSize);
    }
    ctx.textAlign = 'right';
    for (const p of right) {
      ctx.fillText(p.label, w - cellSize * 0.3, p.y * cellSize);
    }
  },
  // 555 timer: state-aware stamp and step using sim.state keyed by terminal topology.
  // The state (flip-flop, outHigh) persists across steps via sim.state[key].
  //
  // Two modes:
  //   1. Normal mode (astable=false): uses the external RC network — REAL
  //      physics. The capacitor charges/discharges through R1+R2 / R2 at the
  //      actual timestep, so the period is exactly 0.693·(R1+2·R2)·C in
  //      sim.time. (The old in-stamp "fast-forward" that jumped sim.time
  //      ahead of the capacitor's integration was removed: it desynchronized
  //      sim.time from the RC state and stretched the period ~dt/jump×.)
  //   2. Astable mode (astable=true): computes output directly from sim.time
  //      using R1/R2/C parameters. Bypasses the slow RC simulation so the
  //      555 oscillates at visible speed (store-level digital fast-forward
  //      advances the clock). The external RC components are still wired
  //      (for visual authenticity) but the 555 uses its internal timing model.
  stamp(params, terminals, sys, sim, comp) {
    const vccNode = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;
    const gndNode = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    // Supply is what is WIRED between the VCC and GND pins (param is only the
    // fallback for an unwired VCC pin, which maps to ground).
    const vs = supply555(params, terminals, sim);
    const vg = sim.nodeVoltage[gndNode] ?? 0;
    // Quiescent supply current ≈ Vcc/1.5 kΩ (TI NE555: 3 mA @ 5 V, 10 mA @ 15 V)
    if (vccNode !== gndNode) sys.stampConductance(vccNode, gndNode, 1 / 1500);

    // CTRL pin: the internal 3×5 kΩ divider holds it at 2/3 Vcc (Thevenin
    // 3.33 kΩ); an external source/divider overrides it.
    const ctrlNode = terminals.find((t) => t.terminalId === 'ctrl')!.nodeId;
    if (ctrlNode !== gndNode && ctrlNode !== vccNode) {
      const ctrlG = 1 / 3333;
      sys.stampConductance(ctrlNode, gndNode, ctrlG);
      sys.stampCurrentSource(gndNode, ctrlNode, (vg + (2 / 3) * vs) * ctrlG);
    }

    // Add weak pull-down on THR, TRIG input pins (1 MΩ to GND).
    // RST pin: pull UP to VCC (active-low).
    const thrPin = terminals.find((t) => t.terminalId === 'thr')?.nodeId;
    const trigPin = terminals.find((t) => t.terminalId === 'trig')?.nodeId;
    const rstPin = terminals.find((t) => t.terminalId === 'rst')?.nodeId;
    const inputPullDown = 1e-6;
    if (thrPin !== undefined && thrPin !== gndNode && thrPin !== vccNode) {
      sys.stampConductance(thrPin, gndNode, inputPullDown);
    }
    if (trigPin !== undefined && trigPin !== gndNode && trigPin !== vccNode) {
      sys.stampConductance(trigPin, gndNode, inputPullDown);
    }
    if (rstPin !== undefined && rstPin !== gndNode && rstPin !== vccNode) {
      sys.stampConductance(rstPin, vccNode, inputPullDown);
    }

    const key = stateKey555(terminals, comp);
    const st = sim.state[key] ?? (sim.state[key] = { ff: false, outHigh: false, prevV: 0, prevT: -1 });
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const dis = terminals.find((t) => t.terminalId === 'dis')!.nodeId;

    // ── Astable mode: compute output directly from sim.time ────────────
    if (params.astable) {
      const r1 = (params.r1 as number) || 47000;
      const r2 = (params.r2 as number) || 47000;
      const c = (params.c as number) || 1e-5;
      // 555 astable formula:
      //   t_high = 0.693 * (R1 + R2) * C
      //   t_low  = 0.693 * R2 * C
      //   period = t_high + t_low = 0.693 * (R1 + 2*R2) * C
      const tHigh = 0.693 * (r1 + r2) * c;
      const tLow = 0.693 * r2 * c;
      const period = tHigh + tLow;
      const phase = (sim.time % period);
      st.outHigh = phase < tHigh;
      st.ff = st.outHigh;
    }

    // ── Totem-pole output stage (TI NE555 datasheet) ───────────────────
    //   HIGH: Voh = Vcc − 1.0 V at light load, ≈ 7 Ω slope
    //         (13.3 V @ 100 mA and 12.5 V @ 200 mA on Vcc = 15 V)
    //   LOW : Vol = 0.02 V + 8 Ω·Isink  (0.1 V @ 10 mA)
    //   both limited to ≈ 200 mA. A supply below ~1 V is a dead chip.
    // Norton companion, linearised against the previous Newton iterate.
    if (out !== gndNode) {
      const alive = vs > 1.0;
      const high = st.outHigh && alive;
      const rBase = high ? 7 : 8;
      const vTh = high ? Math.max(0, vs - 1.0) : 0.02;
      const vOutPrev = (sim.nodeVoltage[out] ?? 0) - vg;
      // Current limit ≈ 200 mA: stretch the Thevenin resistance so the
      // previous iterate's current never exceeds iMax (always a valid
      // finite-conductance stamp, so an unloaded output still converges).
      const iMax = 0.2;
      const rOut = alive ? Math.max(rBase, Math.abs(vTh - vOutPrev) / iMax) : rBase;
      if (!alive) {
        sys.stampConductance(out, gndNode, 1 / 1e5);
      } else {
        sys.stampConductance(out, gndNode, 1 / rOut);
        sys.stampCurrentSource(gndNode, out, vTh / rOut);
      }
    }
    // DIS pin: open-collector transistor conducts to GND when the output is LOW
    if (!st.ff) {
      if (dis !== gndNode) sys.stampConductance(dis, gndNode, 1 / 50);
    } else {
      if (dis !== gndNode) sys.stampConductance(dis, gndNode, 1e-13);
    }
  },
  step(params, terminals, sim, instance) {
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const thr = terminals.find((t) => t.terminalId === 'thr')!.nodeId;
    const trig = terminals.find((t) => t.terminalId === 'trig')!.nodeId;
    const rst = terminals.find((t) => t.terminalId === 'rst')!.nodeId;
    const ctrl = terminals.find((t) => t.terminalId === 'ctrl')!.nodeId;
    const key = stateKey555(terminals, instance);
    const st = sim.state[key] ?? (sim.state[key] = { ff: false, outHigh: false });
    const vs = supply555(params, terminals, sim);
    const vg = sim.nodeVoltage[gnd] ?? 0;
    const vThr = (sim.nodeVoltage[thr] ?? 0) - vg;
    const vTrig = (sim.nodeVoltage[trig] ?? 0) - vg;
    const vRst = (sim.nodeVoltage[rst] ?? 0) - vg;
    const vCtrl = (sim.nodeVoltage[ctrl] ?? 0) - vg;
    // thresholds are 2/3 and 1/3 of the WIRED supply; a driven CTRL overrides
    const vThresh = vCtrl > 0.1 ? vCtrl : (2 / 3) * vs;
    const vTrigThresh = vCtrl > 0.1 ? vCtrl / 2 : (1 / 3) * vs;
    if (vRst < 0.4) {
      st.ff = false;
    } else {
      if (vThr > vThresh) st.ff = false;
      if (vTrig < vTrigThresh) st.ff = true;
    }
    st.outHigh = st.ff;
  },
  measure(params, terminals, sim, comp) {
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const key = stateKey555(terminals, comp);
    const st = sim.state[key];
    return [
      { label: 'Vout', value: sim.nodeVoltage[out].toFixed(3), unit: 'V' },
      { label: 'State', value: st?.outHigh ? 'HIGH' : 'LOW', unit: '' },
    ];
  },
};

// State key for 555 timer (stable across steps).
// Keyed by component id so state survives node renumbering on topology edits;
// the terminal-id/node-id fallback only applies to hand-built stamps without
// a component reference (legacy tests).
function stateKey555(terminals: { terminalId: string; nodeId: number }[], comp?: CircuitComponent): string {
  if (comp?.id) return `t555_${comp.id}`;
  return 't555_' + terminals.map(t => `${t.terminalId}=${t.nodeId}`).join('_');
}

// ----- Logic gates (AND, OR, NOT, NAND, NOR, XOR) -----
function makeLogicGate(type: string, name: string, symbol: string, op: (a: boolean, b?: boolean) => boolean): ComponentPlugin {
  return {
    type,
    name,
    category: 'logic',
    description: `${name} logic gate. Drives output to VCC (logic 1) or 0 (logic 0).`,
    // Region-switching stamp (output level follows the input threshold), so
    // the engine must run the Newton subiteration loop — otherwise cascaded
    // gates lag one timestep per stage and latches/loops mis-converge.
    nonLinear: true,
    symbol,
    boundingBox: { width: 4, height: 3 },
    terminals: type === 'not'
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
      { key: 'vcc', label: 'Logic High (VCC)', type: 'number', default: 5, unit: 'V', min: 1, max: 18, step: 0.1 },
      { key: 'threshold', label: 'Switch Threshold', type: 'number', default: 2.5, unit: 'V', min: 0.1, max: 18, step: 0.1 },
    ],
    render(ctx, params, cellSize) {
      // leads
      if (type === 'not') {
        ctx.beginPath();
        ctx.moveTo(0, 1.5 * cellSize);
        ctx.lineTo(cellSize, 1.5 * cellSize);
        ctx.moveTo(3 * cellSize, 1.5 * cellSize);
        ctx.lineTo(4 * cellSize, 1.5 * cellSize);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cellSize, cellSize * 0.6);
        ctx.lineTo(cellSize, cellSize * 2.4);
        ctx.lineTo(2.7 * cellSize, 1.5 * cellSize);
        ctx.closePath();
        ctx.fillStyle = '#fce7f3';
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(2.85 * cellSize, 1.5 * cellSize, 4, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(0, cellSize);
        ctx.lineTo(cellSize, cellSize);
        ctx.moveTo(0, 2 * cellSize);
        ctx.lineTo(cellSize, 2 * cellSize);
        ctx.moveTo(3 * cellSize, 1.5 * cellSize);
        ctx.lineTo(4 * cellSize, 1.5 * cellSize);
        ctx.stroke();
        // D-shape body
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
      drawLabel(ctx, symbol, 2 * cellSize, 1.5 * cellSize);
    },
    stamp(params, terminals, sys, sim, comp) {
      const vccV = params.vcc as number;
      const thresh = params.threshold as number;
      const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')?.nodeId;
      const y = terminals.find((t) => t.terminalId === 'y')!.nodeId;
      const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
      const vcc = terminals.find((t) => t.terminalId === 'vcc')!.nodeId;

      // Add weak pull-down resistors on input pins (1 MΩ to GND).
      // Prevents floating input nodes when button is open → singular matrix.
      const inputPullDown = 1e-6;  // 1 MΩ = 1e-6 S
      if (a !== gnd && a !== vcc) sys.stampConductance(a, gnd, inputPullDown);
      if (b !== undefined && b !== gnd && b !== vcc) sys.stampConductance(b, gnd, inputPullDown);
      // Power pin: ultra-tiny leak for matrix conditioning.
      if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);

      const key = stateKey('gate', comp, y);
      const st = sim.state[key] ?? (sim.state[key] = { out: false });
      const aHigh = sim.nodeVoltage[a] > thresh;
      const bHigh = b !== undefined ? sim.nodeVoltage[b] > thresh : undefined;
      st.out = op(aHigh, bHigh);
      // Drive output as a voltage source (only if Y is wired to a non-ground node)
      if (y !== gnd) sys.stampVoltageSource(y, gnd, st.out ? vccV : 0);
    },
    step(params, terminals, sim) {
      // nothing; stamp does the work each iteration
    },
    measure(params, terminals, sim) {
      const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
      const b = terminals.find((t) => t.terminalId === 'b')?.nodeId;
      const y = terminals.find((t) => t.terminalId === 'y')!.nodeId;
      return [
        { label: 'A', value: sim.nodeVoltage[a].toFixed(2), unit: 'V' },
        ...(b !== undefined ? [{ label: 'B', value: sim.nodeVoltage[b].toFixed(2), unit: 'V' as const }] : []),
        { label: 'Y', value: sim.nodeVoltage[y].toFixed(2), unit: 'V' },
      ];
    },
  };
}

registerPlugin(makeLogicGate('and', 'AND', '&', (a, b) => !!(a && b)));
registerPlugin(makeLogicGate('or', 'OR', '≥1', (a, b) => !!(a || b)));
registerPlugin(makeLogicGate('nand', 'NAND', '&', (a, b) => !(a && b)));
registerPlugin(makeLogicGate('nor', 'NOR', '≥1', (a, b) => !(a || b)));
registerPlugin(makeLogicGate('xor', 'XOR', '=1', (a, b) => !!(a !== b)));
registerPlugin(makeLogicGate('not', 'NOT', '1', (a) => !a));

registerPlugin(diode);

// ----- Zener Diode -----
// Previously this type was referenced by netlist-export.ts but no plugin
// registered it — a phantom type that would crash on export.
const zener: ComponentPlugin = {
  type: 'zener',
  name: 'Zener Diode',
  category: 'semiconductor',
  description: 'Zener diode (Shockley junction with SPICE-style breakdown): Zener Voltage is the reverse drop at Izt = 5 mA, Forward Voltage the forward drop at 1 mA.',
  symbol: 'Z',
  nonLinear: true,
  pureStamp: true, // stamp() only rewrites idempotent topology keys; Newton memory lives in sim.newtonMemory
  pureStatePrefixes: ['dio_'],
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'k', label: 'K', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'zenerV', label: 'Zener Voltage (at 5 mA)', type: 'number', default: 3.3, unit: 'V', min: 0.1, max: 100, step: 0.1 },
    { key: 'forwardV', label: 'Forward Voltage (at 1 mA)', type: 'number', default: 0.7, unit: 'V', min: 0.1, max: 5, step: 0.05 },
    { key: 'onR', label: 'Series Resistance', type: 'number', default: 1, unit: 'Ω', min: 0.001, max: 1e6, step: 0.1 },
    { key: 'offR', label: 'Leakage Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
    { key: 'ratedPower', label: 'Power Rating', type: 'number', default: 0.5, unit: 'W', min: 0.01, max: 100, step: 0.1, description: 'Absolute-maximum dissipation for the stress check (BZX55 / 1N52xx = 0.5 W, 1N47xx = 1 W).' },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(2 * cellSize - 8, cellSize);
    ctx.moveTo(2 * cellSize + 8, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    // triangle (anode)
    ctx.beginPath();
    ctx.moveTo(-8, -8);
    ctx.lineTo(-8, 8);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.stroke();
    // bar (cathode) — zener has "wings" on the bar
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(0, 8);
    ctx.lineWidth = 2;
    ctx.stroke();
    // zener wings
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(-4, -12);
    ctx.moveTo(0, 8);
    ctx.lineTo(4, 12);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  },
  stamp(params, terminals, sys, sim, comp) {
    stampSimpleDiode('zener', params, terminals, sys, sim, comp);
  },
  step(params, terminals, sim, comp) {
    stepSimpleDiode('zener', params, terminals, sim, comp);
  },
  getFlowPath() {
    return [{ x: 0, y: 1 }, { x: 4, y: 1 }];
  },
  measure(_params, terminals, sim, comp) {
    const a = termNode(terminals, 'a', 0);
    const k = termNode(terminals, 'k', 1);
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
    const i = comp ? simpleDiodeCurrent(comp, sim, a, k) : 0;
    return [{ label: 'V', value: v.toFixed(3), unit: 'V' }, { label: 'I', value: (i * 1000).toFixed(3), unit: 'mA' }];
  },
};
registerPlugin(zener);
registerPlugin(npn);
registerPlugin(opamp);
registerPlugin(timer555);

export { diode, npn, opamp, timer555 };
