// P3 analog/discrete components: LM324 & NE5532 op-amp macromodels, LM311 &
// LM393 comparators, LM1117 & LT3045 LDO regulators, IGBT, current-regulator
// diode (JFET CRD), PTC thermistor, MOV varistor, solid-state relay.
// Behavioral stamps follow the P1 patterns (p1-components.ts): every region /
// state decision reads previous-step node voltages (sim.nodeVoltage) so the
// fixed-point iterations inside solveDC converge instead of oscillating.

import type { ComponentPlugin, MnaSystem, SimContext } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';

// ─────────────────────────────────────────────────────────────────────────────
// Op-amp macromodels — LM324, NE5532
// ─────────────────────────────────────────────────────────────────────────────

// Copied from the P1 makeOpampMacromodel factory with one extra field:
// `voutMargin` — the top-rail output swing margin. The P1 factory hardcoded
// 0.5V from either rail, which is wrong for parts like the LM324 (single
// supply, output only swings to Vcc−1.4V but pulls to within millivolts of
// V−) or the NE5532 (±13V on ±15V rails). `voutMarginLow` covers the
// bottom rail and defaults to the symmetric value.
function makeOpampMacromodel(type: string, name: string, params: {
  gain: number; gbw: number; slewRate: number; voff: number; ibias: number; cmrr: number; rout: number;
  vccMin: number; veeMax: number;
  voutMargin: number;
  voutMarginLow?: number;
}): ComponentPlugin {
  const mLow = params.voutMarginLow ?? params.voutMargin;
  // A single-supply part (veeMax === 0) assumes a 0V V− rail when the pin is
  // left open; dual-supply parts default to ±15V supplies.
  const defVee = params.veeMax === 0 ? 0 : -15;
  return {
    type,
    name,
    category: 'ic',
    description: `${name} — real op-amp macromodel. GBW=${params.gbw}Hz, slew=${params.slewRate}V/µs, CMRR=${params.cmrr}dB, output swings to V+−${params.voutMargin}V.`,
    symbol: 'A',
    boundingBox: { width: 6, height: 4 },
    terminals: [
      { id: 'inp', label: '+', position: { x: 0, y: 1 }, electricalType: 'input' as const },
      { id: 'inn', label: '−', position: { x: 0, y: 3 }, electricalType: 'input' as const },
      { id: 'out', label: 'OUT', position: { x: 6, y: 2 }, electricalType: 'output' as const },
      { id: 'vcc', label: 'V+', position: { x: 3, y: 0 }, electricalType: 'power_in' as const },
      { id: 'vee', label: 'V−', position: { x: 3, y: 4 }, electricalType: 'power_in' as const },
    ],
    parameters: [
      { key: 'gain', label: 'Open-loop Gain', type: 'number', default: params.gain, step: 1000 },
      { key: 'gbw', label: 'Gain-Bandwidth (Hz)', type: 'number', default: params.gbw, step: 10000 },
      { key: 'slewRate', label: 'Slew Rate (V/µs)', type: 'number', default: params.slewRate, step: 0.1 },
      { key: 'voff', label: 'Offset Voltage (mV)', type: 'number', default: params.voff, step: 0.1 },
      { key: 'ibias', label: 'Bias Current (nA)', type: 'number', default: params.ibias, step: 5 },
      { key: 'cmrr', label: 'CMRR (dB)', type: 'number', default: params.cmrr, step: 5 },
      { key: 'rout', label: 'Output Resistance (Ω)', type: 'number', default: params.rout, step: 5 },
      { key: 'voutMargin', label: 'Output Swing Margin (V)', type: 'number', default: params.voutMargin, unit: 'V', min: 0, max: 10, step: 0.1 },
    ],
    keywords: ['opamp', 'operational', 'amplifier', type, name.toLowerCase()],
    render(ctx, _p, cellSize) {
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(1.5 * cellSize, 0.5 * cellSize);
      ctx.lineTo(1.5 * cellSize, 3.5 * cellSize);
      ctx.lineTo(4.5 * cellSize, 2 * cellSize);
      ctx.closePath();
      ctx.stroke();
      drawLabel(ctx, name, 2.5 * cellSize, 2 * cellSize);
      // + and − signs
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('+', 1.6 * cellSize, 1.3 * cellSize);
      ctx.fillText('−', 1.6 * cellSize, 3.3 * cellSize);
    },
    stamp(p, terminals, sys, sim, comp) {
      const inp = terminals.find(t => t.terminalId === 'inp')!.nodeId;
      const inn = terminals.find(t => t.terminalId === 'inn')!.nodeId;
      const out = terminals.find(t => t.terminalId === 'out')!.nodeId;
      const vcc = terminals.find(t => t.terminalId === 'vcc')!.nodeId;
      const vee = terminals.find(t => t.terminalId === 'vee')!.nodeId;
      const Av = p.gain as number;
      const rOut = Math.max(0.001, p.rout as number);
      const vOff = (p.voff as number) / 1000; // mV → V
      const mTop = Math.max(0.05, (p.voutMargin as number) ?? params.voutMargin);
      // Rail voltages (previous iterate). Unconnected power pins fall back to
      // the part's typical supplies.
      const vccV = vcc > 0 ? (sim.nodeVoltage[vcc] ?? 15) : 15;
      const veeV = vee > 0 ? (sim.nodeVoltage[vee] ?? defVee) : defVee;
      const vHi = vccV - mTop; // highest achievable output
      const vLo = veeV + mLow; // lowest achievable output
      const vPlus = sim.nodeVoltage[inp] ?? 0;
      const vMinus = sim.nodeVoltage[inn] ?? 0;
      // Open-loop output prediction from the previous-iterate inputs. It is
      // used ONLY to pick the operating region: the linear region stamps a
      // true VCCS (Boyle-style gm model), so the closed-loop fixed point is
      // reached exactly. The P1 factory's full-gain Thevenin source overshoots
      // by Av× every iteration and oscillates rail-to-rail in any feedback
      // circuit, never converging.
      const vRaw = Av * (vPlus - vMinus + vOff);
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey(`opamp_${type}`, comp, out);
      // region: 0 = linear, +1 = saturated high, −1 = saturated low.
      // Saturation always exits THROUGH the linear region — jumping straight
      // to the opposite rail re-triggers the overshoot and never settles.
      let region = (st[key] as number | undefined) ?? 0;
      if (region === 0) {
        if (vRaw > vHi) region = 1;
        else if (vRaw < vLo) region = -1;
      } else if (region === 1) {
        if (vRaw < vHi) region = 0;
      } else {
        if (vRaw > vLo) region = 0;
      }
      st[key] = region;
      // gmin-style input leak (1GΩ) keeps floating input nets solvable
      sys.stampConductance(inp, 0, 1e-9);
      sys.stampConductance(inn, 0, 1e-9);
      if (out === 0) return; // unconnected output — nothing to drive
      if (region === 0) {
        // Linear: I(out) = gm·(V+ − V− + Voff) delivered into 1/rout.
        // gm·rout = Av reproduces the open-loop gain; the VCCS makes the
        // closed-loop solve a purely linear (one-shot) problem.
        // stampVCCS(0, out, inp, inn, gm): current from ground into out =
        // gm·(V+−V−) — the op-amp output sources the transconductance current.
        const gm = Av / rOut;
        sys.stampConductance(out, 0, 1 / rOut);
        sys.stampVCCS(0, out, inp, inn, gm);
        sys.stampCurrentSource(0, out, gm * vOff);
      } else {
        // Saturated: Thevenin at the rail-limited level through rout (the
        // series resistance also models output droop under heavy load).
        const vSat = region > 0 ? vHi : vLo;
        sys.stampConductance(out, 0, 1 / rOut);
        sys.stampCurrentSource(0, out, vSat / rOut);
      }
    },
    getFlowPath() { return [{ x: 0, y: 2 }, { x: 6, y: 2 }]; },
    measure(p, terminals, sim) {
      const inp = terminals.find(t => t.terminalId === 'inp')!.nodeId;
      const inn = terminals.find(t => t.terminalId === 'inn')!.nodeId;
      const out = terminals.find(t => t.terminalId === 'out')!.nodeId;
      return [
        { label: 'V+', value: (sim.nodeVoltage[inp] ?? 0).toFixed(3), unit: 'V' },
        { label: 'V−', value: (sim.nodeVoltage[inn] ?? 0).toFixed(3), unit: 'V' },
        { label: 'Vout', value: (sim.nodeVoltage[out] ?? 0).toFixed(3), unit: 'V' },
      ];
    },
  };
}

// LM324: single-supply quad op-amp. Output swings to Vcc−1.4V (VOH) and to
// within ~50mV of V− (VOL, light load) — hence the asymmetric margins.
export const lm324 = makeOpampMacromodel('lm324', 'LM324', {
  gain: 1e5, gbw: 1.2e6, slewRate: 0.5, voff: 3, ibias: 45, cmrr: 85, rout: 300,
  vccMin: 3, veeMax: 0, voutMargin: 1.4, voutMarginLow: 0.05,
});

// NE5532: audio dual op-amp. ±13V output swing on ±15V rails (symmetric
// 2V margins), low output impedance.
export const ne5532 = makeOpampMacromodel('ne5532', 'NE5532', {
  gain: 1e5, gbw: 1e7, slewRate: 9, voff: 0.5, ibias: 200, cmrr: 100, rout: 10,
  vccMin: 6, veeMax: -6, voutMargin: 2,
});

// ─────────────────────────────────────────────────────────────────────────────
// Comparators — LM311 (with STROBE), LM393
// ─────────────────────────────────────────────────────────────────────────────

// Open-collector comparators. The output transistor is ON (pulls OUT down to
// `vlow` above the GND pin through `ron`) when (V+ − V−) exceeds the input
// hysteresis — an inverting transfer (OUT low for V+ > V−). When the
// transistor is OFF the output floats (leakage only): the external pull-up
// resistor sets the high level, exactly like the real open-collector part.
// The LM311 adds an active-low STROBE pin: pulling it below ~0.8V forces the
// output transistor off regardless of the input (high impedance). Tie STROBE
// high (e.g. to VCC) for normal operation — an unconnected pin reads 0V in
// this simulator and therefore disables the output.
function makeOpenCollectorComparator(type: string, name: string, opts: {
  voff: number; ibias?: number; strobe: boolean;
}): ComponentPlugin {
  const hasStrobe = opts.strobe;
  return {
    type,
    name,
    category: 'ic',
    description: hasStrobe
      ? `${name} — open-collector comparator with active-low STROBE. Output transistor pulls LOW when V(+) > V(−); pull STROBE low to force the output off (high-Z).`
      : `${name} — open-collector comparator. Output transistor pulls LOW when V(+) > V(−); output level when off is set by the external pull-up.`,
    symbol: type.slice(-3).toUpperCase(),
    boundingBox: { width: 6, height: 4 },
    terminals: [
      { id: 'inp', label: '+', position: { x: 0, y: 1 }, electricalType: 'input' as const },
      { id: 'inn', label: '−', position: { x: 0, y: 3 }, electricalType: 'input' as const },
      { id: 'out', label: 'OUT', position: { x: 6, y: 2 }, electricalType: 'open_collector' as const },
      ...(hasStrobe
        ? [{ id: 'strobe', label: 'STROBE', position: { x: 4, y: 4 }, electricalType: 'input' as const }]
        : []),
      { id: 'vcc', label: 'VCC', position: { x: 3, y: 0 }, electricalType: 'power_in' as const },
      { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    ],
    parameters: [
      { key: 'voff', label: 'Offset Voltage (mV)', type: 'number', default: opts.voff, unit: 'mV', min: 0, max: 50, step: 0.1 },
      ...(opts.ibias !== undefined
        ? [{ key: 'ibias', label: 'Bias Current (nA)', type: 'number' as const, default: opts.ibias, unit: 'nA', min: 0, max: 1000, step: 1 }]
        : []),
      { key: 'hysteresis', label: 'Hysteresis (mV)', type: 'number', default: 1, unit: 'mV', min: 0, max: 500, step: 0.1 },
      { key: 'vlow', label: 'Output LOW (V)', type: 'number', default: 0.2, unit: 'V', min: 0, max: 5, step: 0.05 },
      { key: 'ron', label: 'On Resistance', type: 'number', default: 10, unit: 'Ω', min: 0.001, max: 1e6, step: 1 },
      { key: 'roff', label: 'Off Leakage (Ω)', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
    ],
    keywords: ['comparator', type, name.toLowerCase(), 'open-collector', ...(hasStrobe ? ['strobe'] : [])],
    render(ctx, _params, cellSize) {
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
      // Triangle body
      ctx.beginPath();
      ctx.moveTo(1.5 * cellSize, 0.5 * cellSize);
      ctx.lineTo(1.5 * cellSize, 3.5 * cellSize);
      ctx.lineTo(4.5 * cellSize, 2 * cellSize);
      ctx.closePath();
      ctx.stroke();
      drawLabel(ctx, type.toUpperCase(), 2.5 * cellSize, 2 * cellSize);
      // Open-collector bar on the output
      ctx.beginPath();
      ctx.moveTo(4.5 * cellSize, 2.7 * cellSize);
      ctx.lineTo(5.5 * cellSize, 2.7 * cellSize);
      ctx.stroke();
      if (hasStrobe) drawLabel(ctx, 'STR', 4 * cellSize, 3.6 * cellSize);
    },
    stamp(params, terminals, sys, sim, comp) {
      const inp = terminals.find(t => t.terminalId === 'inp')?.nodeId ?? 0;
      const inn = terminals.find(t => t.terminalId === 'inn')?.nodeId ?? 0;
      const out = terminals.find(t => t.terminalId === 'out')?.nodeId ?? 0;
      const gnd = terminals.find(t => t.terminalId === 'gnd')?.nodeId ?? 0;
      const strobe = terminals.find(t => t.terminalId === 'strobe')?.nodeId;
      const vPlus = sim.nodeVoltage[inp] ?? 0;
      const vMinus = sim.nodeVoltage[inn] ?? 0;
      // Offset voltage shifts the trip point: effectively compares
      // (V+ − V− − voff) against the hysteresis window.
      const diff = vPlus - vMinus - (params.voff as number) / 1000;
      const hyst = (params.hysteresis as number) / 1000;
      const st = sim.state.__global ?? (sim.state.__global = {});
      const key = stateKey('cmp', comp, out);
      const prevHigh = st[key] ?? diff > 0;
      // 1mV-style hysteresis (same pattern as the generic comparator)
      const currentHigh = prevHigh ? diff > -hyst : diff > hyst;
      st[key] = currentHigh;
      // STROBE is active-low: below ~0.8V the output stage is disabled.
      let strobed = false;
      if (strobe !== undefined) strobed = (sim.nodeVoltage[strobe] ?? 0) < 0.8;
      // Transistor ON only when the comparison is asserted AND not strobed off
      const on = currentHigh && !strobed;
      if (out === 0) return; // unconnected output — nothing to pull
      const rOn = Math.max(0.001, params.ron as number);
      if (on) {
        // ON: Thevenin at vlow above the GND (emitter) pin through ron
        sys.stampConductance(out, gnd, 1 / rOn);
        sys.stampCurrentSource(gnd, out, (params.vlow as number) / rOn);
      } else {
        // OFF: leakage only — the external pull-up sets the level
        sys.stampConductance(out, gnd, 1 / (params.roff as number));
      }
    },
    getFlowPath() { return [{ x: 0, y: 2 }, { x: 6, y: 2 }]; },
  };
}

// LM311: single comparator, STROBE pin, 250ns response.
export const lm311 = makeOpenCollectorComparator('lm311', 'LM311', {
  voff: 2, strobe: true,
});

// LM393: dual comparator (single instance modeled), 250nA/quiescent.
export const lm393 = makeOpenCollectorComparator('lm393', 'LM393', {
  voff: 1, ibias: 25, strobe: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// LDO regulators — LM1117, LT3045
// ─────────────────────────────────────────────────────────────────────────────

// Behavioral LDO model (LM7805 pattern, plus a dropout offset and a
// quiescent ground current):
//   Vin > Vout + dropout → regulated: Thevenin at Vout between OUT and GND
//   Vin ≤ Vout + dropout → dropout:  series element, I = (Vin − Vout − dropout)/ron
// so the output tracks Vin − dropout instead of Vin (a bare series resistor
// would let the output rise above the setpoint just below regulation).
function stampLdo(
  params: Record<string, any>,
  terminals: { terminalId: string; nodeId: number }[],
  sys: MnaSystem,
  sim: SimContext,
  outV: number,
): void {
  const vin = terminals.find(t => t.terminalId === 'in')!.nodeId;
  const gnd = terminals.find(t => t.terminalId === 'gnd')!.nodeId;
  const vout = terminals.find(t => t.terminalId === 'out')!.nodeId;
  const dropout = params.dropoutV as number;
  const r = Math.max(0.001, params.ron as number);
  const iq = params.iq as number;
  // Quiescent current always flows from IN to GND (chip bias / ground pin).
  if (vin !== gnd) sys.stampCurrentSource(vin, gnd, iq);
  const vIn = sim.nodeVoltage[vin] ?? 0;
  if (vIn > outV + dropout) {
    // Regulated: pin the output at outV through ron
    if (vout !== 0) {
      sys.stampConductance(vout, gnd, 1 / r);
      sys.stampCurrentSource(gnd, vout, outV / r);
    }
  } else {
    // Dropout: series pass element with the dropout voltage in series.
    // Element current (in → out) = (Vin − Vout − dropout)/ron
    sys.stampConductance(vin, vout, 1 / r);
    sys.stampCurrentSource(vout, vin, dropout / r);
  }
}

export const lm1117: ComponentPlugin = {
  type: 'lm1117',
  name: 'LM1117 (LDO Regulator)',
  category: 'ic',
  description: '800mA LDO linear regulator. Output selectable 1.8/2.5/3.3/5V, ~1.1V dropout, 5mA quiescent current.',
  symbol: '1117',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'in', label: 'IN', position: { x: 0, y: 1 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    { id: 'out', label: 'OUT', position: { x: 4, y: 1 }, electricalType: 'power_out' as const },
  ],
  parameters: [
    {
      key: 'outputV', label: 'Output Voltage', type: 'select', default: '3.3',
      options: [
        { label: '1.8V', value: '1.8' },
        { label: '2.5V', value: '2.5' },
        { label: '3.3V', value: '3.3' },
        { label: '5.0V', value: '5.0' },
      ],
    },
    { key: 'dropoutV', label: 'Dropout Voltage', type: 'number', default: 1.1, unit: 'V', min: 0.1, max: 3, step: 0.05 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 0.15, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
    { key: 'iq', label: 'Quiescent Current', type: 'number', default: 0.005, unit: 'A', min: 0, max: 0.1, step: 0.001 },
  ],
  keywords: ['regulator', 'ldo', '1117', 'linear', 'power'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '1117', 2 * cellSize, 2 * cellSize);
    drawLabel(ctx, 'IN', 0.3 * cellSize, 1.3 * cellSize);
    drawLabel(ctx, 'OUT', 3.2 * cellSize, 1.3 * cellSize);
    drawLabel(ctx, 'GND', 1.5 * cellSize, 3.7 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    stampLdo(params, terminals, sys, sim, Number(params.outputV ?? 3.3));
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 2, y: 2 }, { x: 4, y: 1 }]; },
};

export const lt3045: ComponentPlugin = {
  type: 'lt3045',
  name: 'LT3045 (Ultra-Low-Noise LDO)',
  category: 'ic',
  description: '500mA ultra-low-noise LDO. Vout = 100µA·RSET in reality — modeled directly as the outputVoltage parameter. 0.35V dropout, 2mA quiescent.',
  symbol: '3045',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'in', label: 'IN', position: { x: 0, y: 1 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    { id: 'out', label: 'OUT', position: { x: 4, y: 1 }, electricalType: 'power_out' as const },
  ],
  parameters: [
    { key: 'outputV', label: 'Output Voltage', type: 'number', default: 3.3, unit: 'V', min: 0.3, max: 15, step: 0.1 },
    { key: 'dropoutV', label: 'Dropout Voltage', type: 'number', default: 0.35, unit: 'V', min: 0.1, max: 2, step: 0.05 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 0.05, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
    { key: 'iq', label: 'Quiescent Current', type: 'number', default: 0.002, unit: 'A', min: 0, max: 0.1, step: 0.001 },
  ],
  keywords: ['regulator', 'ldo', 'lt3045', 'low-noise', 'power'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '3045', 2 * cellSize, 2 * cellSize);
    drawLabel(ctx, 'IN', 0.3 * cellSize, 1.3 * cellSize);
    drawLabel(ctx, 'OUT', 3.2 * cellSize, 1.3 * cellSize);
    drawLabel(ctx, 'GND', 1.5 * cellSize, 3.7 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    stampLdo(params, terminals, sys, sim, (params.outputV as number) ?? 3.3);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 2, y: 2 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// IGBT (N-channel)
// ─────────────────────────────────────────────────────────────────────────────

// MOS-gated bipolar transistor, behavioral model following the NMOS pattern:
//  - V_GE < vth          → off (leakage 1/roff between collector and emitter)
//  - V_CE > V_GE − vth   → active region: I_C ≈ kp·(V_GE − vth)², stamped as
//                           its Newton linearization around the previous-
//                           iterate V_GE (VCCS of slope 2·kp·vov + offset
//                           source), so the fixed-point iteration converges
//  - V_CE ≤ V_GE − vth   → ohmic region: fully enhanced channel ≈ ron
// The region decision uses previous-step voltages, exactly like the NMOS.
export const igbt: ComponentPlugin = {
  type: 'igbt',
  name: 'IGBT (N-channel)',
  category: 'semiconductor',
  description: 'Insulated-gate bipolar transistor. VGE > Vth turns the channel on; IGBTs combine MOS gate drive with bipolar conduction (low VCE(sat)).',
  symbol: 'IGBT',
  boundingBox: { width: 3, height: 4 },
  terminals: [
    { id: 'c', label: 'C', position: { x: 3, y: 0 }, electricalType: 'passive' as const },
    { id: 'g', label: 'G', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'e', label: 'E', position: { x: 3, y: 4 }, electricalType: 'passive' as const },
  ],
  parameters: [
    { key: 'vth', label: 'Gate Threshold Vth', type: 'number', default: 4.5, unit: 'V', min: 0.1, max: 20, step: 0.1 },
    { key: 'kp', label: 'Transconductance Kp', type: 'number', default: 2, unit: 'A/V²', min: 0.001, max: 100, step: 0.1 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 0.05, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
    { key: 'roff', label: 'Off Resistance', type: 'number', default: 1e9, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  keywords: ['igbt', 'insulated', 'gate', 'bipolar', 'transistor', 'power', 'switch'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // gate lead + plate
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize);
    ctx.lineTo(cellSize, 2 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cellSize, cellSize * 1.3);
    ctx.lineTo(cellSize, cellSize * 2.7);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1.5;
    // body line
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.3, cellSize * 1.2);
    ctx.lineTo(cellSize * 1.3, cellSize * 2.8);
    ctx.stroke();
    // collector & emitter leads
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 0);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.moveTo(3 * cellSize, cellSize * 2.8);
    ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.stroke();
    // channel segments
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.3, cellSize * 1.5);
    ctx.lineTo(3 * cellSize, cellSize * 1.2);
    ctx.moveTo(cellSize * 1.3, cellSize * 2.5);
    ctx.lineTo(3 * cellSize, cellSize * 2.8);
    ctx.stroke();
    // IGBT saturation "bridge" (channel-to-emitter short bar)
    ctx.beginPath();
    ctx.moveTo(cellSize * 1.3, cellSize * 2);
    ctx.lineTo(3 * cellSize, cellSize * 2);
    ctx.stroke();
    drawLabel(ctx, 'IGBT', 1.6 * cellSize, 3.6 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const c = terminals.find(t => t.terminalId === 'c')!.nodeId;
    const g = terminals.find(t => t.terminalId === 'g')!.nodeId;
    const e = terminals.find(t => t.terminalId === 'e')!.nodeId;
    const vth = params.vth as number;
    const kp = params.kp as number;
    const ron = Math.max(0.001, params.ron as number);
    const roff = Math.max(1, params.roff as number);
    const vge = (sim.nodeVoltage[g] ?? 0) - (sim.nodeVoltage[e] ?? 0);
    const vce = (sim.nodeVoltage[c] ?? 0) - (sim.nodeVoltage[e] ?? 0);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('igbt', comp, c, g, e);
    const prevOn = st[key] ?? false;
    // 200mV of gate hysteresis (NMOS-style) keeps the on/off decision stable
    const on = prevOn ? vge > vth - 0.2 : vge > vth;
    st[key] = on;
    // MOS gate: high impedance (1MΩ leak keeps floating gates solvable)
    sys.stampConductance(g, e, 1e-6);
    if (!on) {
      // Off: only collector-emitter leakage
      sys.stampConductance(c, e, 1 / roff);
      return;
    }
    const vov = vge - vth; // gate overdrive
    if (vce > vov) {
      // Active region: I_C = kp·vov², linearized around the previous V_GE:
      //   I_C ≈ kp·vov² + 2·kp·vov·(V_GE − V_GE_prev)
      //      = gm·V_GE + (kp·vov² − gm·V_GE_prev)
      // exact at the operating point, first-order correct nearby.
      const vgePrev = vge;
      const iSat = kp * vov * vov;
      const gm = Math.max(0, 2 * kp * vov);
      // stampVCCS(c, e, g, e, gm): current c→e = gm·Vge — draws the
      // collector current out of c and delivers it into e (the IGBT's
      // collector sinks, emitter sources).
      sys.stampVCCS(c, e, g, e, gm);
      sys.stampCurrentSource(c, e, iSat - gm * vgePrev);
    } else {
      // Ohmic region: fully enhanced — small on-resistance
      sys.stampConductance(c, e, 1 / ron);
    }
  },
  getFlowPath() { return [{ x: 3, y: 0 }, { x: 1.5, y: 2 }, { x: 3, y: 4 }]; },
  measure(_params, terminals, sim) {
    const c = terminals.find(t => t.terminalId === 'c')!.nodeId;
    const g = terminals.find(t => t.terminalId === 'g')!.nodeId;
    const e = terminals.find(t => t.terminalId === 'e')!.nodeId;
    return [
      { label: 'Vge', value: ((sim.nodeVoltage[g] ?? 0) - (sim.nodeVoltage[e] ?? 0)).toFixed(3), unit: 'V' },
      { label: 'Vce', value: ((sim.nodeVoltage[c] ?? 0) - (sim.nodeVoltage[e] ?? 0)).toFixed(3), unit: 'V' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Current-regulator diode (JFET CRD) — 1N5305-style
// ─────────────────────────────────────────────────────────────────────────────

// Two-terminal current source: a JFET with the gate tied to the source.
// Below the knee voltage it behaves like a resistor (g = ip/vknee, which
// makes the I-V curve continuous at the knee); above it, it regulates at ip
// with a parallel output leakage of 1/roff.
export const crd: ComponentPlugin = {
  type: 'crd',
  name: 'Current-Regulator Diode',
  category: 'semiconductor',
  description: 'Two-terminal current regulator (JFET with gate shorted, 1N5305-style). Regulates at ip once V(AK) exceeds the knee voltage.',
  symbol: 'CRD',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'passive' as const },
    { id: 'k', label: 'K', position: { x: 4, y: 1 }, electricalType: 'passive' as const },
  ],
  parameters: [
    { key: 'ip', label: 'Regulated Current', type: 'number', default: 0.001, unit: 'A', min: 1e-6, max: 0.1, step: 1e-4 },
    { key: 'vknee', label: 'Knee Voltage', type: 'number', default: 3, unit: 'V', min: 0.5, max: 50, step: 0.5 },
    { key: 'roff', label: 'Output Leakage (Ω)', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  keywords: ['crd', 'current', 'regulator', 'diode', 'jfet', 'current source', '1n5305'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.5 * cellSize, cellSize);
    ctx.moveTo(2.5 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    // Diode triangle pointing anode → cathode
    ctx.beginPath();
    ctx.moveTo(1.5 * cellSize, cellSize - 7);
    ctx.lineTo(1.5 * cellSize, cellSize + 7);
    ctx.lineTo(2.5 * cellSize, cellSize);
    ctx.closePath();
    ctx.stroke();
    // Cathode bar
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, cellSize - 7);
    ctx.lineTo(2.5 * cellSize, cellSize + 7);
    ctx.stroke();
    // Gate-short bar (the JFET tell) under the symbol
    ctx.beginPath();
    ctx.moveTo(1.7 * cellSize, cellSize + 11);
    ctx.lineTo(2.3 * cellSize, cellSize + 11);
    ctx.stroke();
    drawLabel(ctx, 'CRD', 2 * cellSize, cellSize - 13);
  },
  stamp(params, terminals, sys, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const k = terminals.find(t => t.terminalId === 'k')!.nodeId;
    const ip = params.ip as number;
    const vknee = Math.max(0.001, params.vknee as number);
    const roff = Math.max(1, params.roff as number);
    const vAK = (sim.nodeVoltage[a] ?? 0) - (sim.nodeVoltage[k] ?? 0);
    if (vAK > vknee) {
      // Regulating: constant current a → k, with parallel leakage
      sys.stampCurrentSource(a, k, ip);
      sys.stampConductance(a, k, 1 / roff);
    } else {
      // Below the knee: linear ramp g = ip/vknee (continuous at the knee,
      // where V·g = ip)
      sys.stampConductance(a, k, ip / vknee);
    }
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Thermistor (PTC)
// ─────────────────────────────────────────────────────────────────────────────

// Same exponential law as the NTC thermistor with the exponent sign flipped
// (positive temperature coefficient): R rises with temperature.
//   R = R25 · exp(beta·(1/298.15 − 1/(T+273.15)))
// With beta = 1500, R(85°C) ≈ 2.3·R25 — silistor-like behavior for sensing.
export const ptc: ComponentPlugin = {
  type: 'ptc',
  name: 'Thermistor (PTC)',
  category: 'passive',
  description: 'Positive temperature coefficient resistor. Resistance increases as temperature rises (mirrors the NTC law with positive exponent).',
  symbol: 'PTC',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'passive' as const },
    { id: 'b', label: 'B', position: { x: 4, y: 1 }, electricalType: 'passive' as const },
  ],
  parameters: [
    { key: 'r25', label: 'Resistance @25°C', type: 'number', default: 1000, unit: 'Ω', min: 1, max: 1e8, step: 1 },
    { key: 'beta', label: 'Beta (positive)', type: 'number', default: 1500, min: 100, max: 6000, step: 10 },
    { key: 'tempC', label: 'Temperature', type: 'number', default: 25, unit: '°C', min: -50, max: 250, step: 1 },
  ],
  keywords: ['thermistor', 'ptc', 'temperature', 'sensor', 'positive'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // Zigzag resistor body
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(0.5 * cellSize, cellSize);
    for (let i = 0; i < 4; i++) {
      const x0 = 0.5 * cellSize + i * 0.7 * cellSize;
      const x1 = x0 + 0.7 * cellSize;
      ctx.moveTo(x0, cellSize - 6); ctx.lineTo(x1, cellSize + 6);
      ctx.moveTo(x1, cellSize + 6); ctx.lineTo(x0 + 1.4 * cellSize, cellSize - 6);
    }
    ctx.moveTo(3.5 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    // Line with "t°" label above (thermistor marker)
    ctx.beginPath();
    ctx.moveTo(1 * cellSize, 0); ctx.lineTo(3 * cellSize, 0);
    ctx.moveTo(2 * cellSize, 0); ctx.lineTo(2 * cellSize, -5);
    ctx.stroke();
    drawLabel(ctx, 't°', 2.5 * cellSize, -8);
  },
  stamp(params, terminals, sys) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const R0 = params.r25 as number;
    const beta = params.beta as number;
    const T = (params.tempC as number) + 273.15; // Celsius → Kelvin
    const T0 = 298.15; // 25°C
    // Positive-coefficient exponential law (NTC formula with the sign flipped)
    const R = R0 * Math.exp(beta * (1 / T0 - 1 / T));
    sys.stampConductance(a, b, 1 / Math.max(R, 1e-6));
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// MOV (metal-oxide varistor)
// ─────────────────────────────────────────────────────────────────────────────

// Bidirectional voltage clamp. Below the clamping voltage it leaks
// (1/rleak); above it, the Norton equivalent of the clamped segment:
//   I = (V_AB − sign(V_AB)·vc)/ron
// i.e. conductance 1/ron in parallel with a −sign(V_AB)·vc/ron source from
// a to b, so the I−V curve passes exactly through (±vc, ±vc/ron). The sign
// is chosen against the solver's current convention
// (stampCurrentSource(n1,n2,I) leaves n1 with I).
export const mov: ComponentPlugin = {
  type: 'mov',
  name: 'MOV (Varistor)',
  category: 'passive',
  description: 'Metal-oxide varistor. Bidirectional clamp: below vc it leaks; above vc it conducts hard, limiting the voltage to ≈ vc + I·ron. Used for surge protection.',
  symbol: 'MOV',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'passive' as const },
    { id: 'b', label: 'B', position: { x: 4, y: 1 }, electricalType: 'passive' as const },
  ],
  parameters: [
    { key: 'vc', label: 'Clamping Voltage', type: 'number', default: 130, unit: 'V', min: 5, max: 1000, step: 1 },
    { key: 'ron', label: 'Clamped Resistance', type: 'number', default: 1, unit: 'Ω', min: 0.001, max: 1000, step: 0.1 },
    { key: 'rleak', label: 'Leakage Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
  ],
  keywords: ['mov', 'varistor', 'surge', 'protection', 'clamp', 'transient'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.2 * cellSize, cellSize);
    ctx.moveTo(2.8 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    // Varistor body: rectangle with a diagonal strike (IEC varistor symbol)
    ctx.beginPath();
    ctx.rect(1.2 * cellSize, cellSize - 8, 1.6 * cellSize, 16);
    ctx.moveTo(1.2 * cellSize, cellSize + 8);
    ctx.lineTo(2.8 * cellSize, cellSize - 8);
    ctx.stroke();
    drawLabel(ctx, 'MOV', 2 * cellSize, cellSize - 15);
  },
  stamp(params, terminals, sys, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const vc = params.vc as number;
    const ron = Math.max(0.001, params.ron as number);
    const rleak = Math.max(1, params.rleak as number);
    const vAB = (sim.nodeVoltage[a] ?? 0) - (sim.nodeVoltage[b] ?? 0);
    if (Math.abs(vAB) <= vc) {
      // Not clamping: leakage only
      sys.stampConductance(a, b, 1 / rleak);
    } else {
      // Clamping: Norton equivalent of the (±vc, ±vc/ron) segment
      sys.stampConductance(a, b, 1 / ron);
      sys.stampCurrentSource(a, b, -Math.sign(vAB) * vc / ron);
    }
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Solid-state relay (SSR)
// ─────────────────────────────────────────────────────────────────────────────

// LED input optically coupled to a bidirectional output switch. The input is
// modeled exactly like the optocoupler's LED (Vf + series resistor), the LED
// current triggers the output:
//   Iin = max(0, (V(in+) − V(in−) − ledVf)/rled)
//   conducting = Iin > iTrigger && !(zeroCross && |V(out1−out2)| > 10)
// With zero-crossing enabled the output waits for the load voltage to come
// near zero before closing — at DC that moment never arrives, so a zero-cross
// SSR correctly never turns on for a DC load.
export const ssr: ComponentPlugin = {
  type: 'ssr',
  name: 'Solid-State Relay',
  category: 'ic',
  description: 'Solid-state relay: LED input (in+/in−) drives an isolated bidirectional output switch (out1/out2). zeroCross=1 waits for a voltage zero-crossing before closing (stays open at DC).',
  symbol: 'SSR',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'inp', label: 'IN+', position: { x: 0, y: 1 }, electricalType: 'passive' as const },
    { id: 'inn', label: 'IN−', position: { x: 0, y: 3 }, electricalType: 'passive' as const },
    { id: 'out1', label: 'OUT1', position: { x: 6, y: 1 }, electricalType: 'passive' as const },
    { id: 'out2', label: 'OUT2', position: { x: 6, y: 3 }, electricalType: 'passive' as const },
  ],
  parameters: [
    { key: 'ledVf', label: 'LED Forward Voltage', type: 'number', default: 1.2, unit: 'V', min: 0.5, max: 5, step: 0.1 },
    { key: 'rled', label: 'LED Series R', type: 'number', default: 350, unit: 'Ω', min: 1, max: 1e6, step: 10 },
    { key: 'iTrigger', label: 'Trigger Current', type: 'number', default: 0.002, unit: 'A', min: 1e-6, max: 0.1, step: 1e-4 },
    { key: 'ron', label: 'On Resistance', type: 'number', default: 0.1, unit: 'Ω', min: 0.001, max: 100, step: 0.01 },
    { key: 'roff', label: 'Off Resistance', type: 'number', default: 1e7, unit: 'Ω', min: 1e3, max: 1e12, step: 1e5 },
    { key: 'zeroCross', label: 'Zero-Cross Switching (0/1)', type: 'number', default: 1, min: 0, max: 1, step: 1 },
  ],
  keywords: ['ssr', 'solid', 'state', 'relay', 'optical', 'isolated', 'zero-cross'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // Dashed isolation barrier down the middle
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 0); ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.stroke();
    ctx.setLineDash([]);
    // Input LED
    drawLabel(ctx, 'LED', 1 * cellSize, 2 * cellSize);
    // Output switch
    drawLabel(ctx, 'SW', 4.5 * cellSize, 2 * cellSize);
    drawLabel(ctx, 'SSR', 3 * cellSize, -6);
  },
  stamp(params, terminals, sys, sim) {
    const inp = terminals.find(t => t.terminalId === 'inp')!.nodeId;
    const inn = terminals.find(t => t.terminalId === 'inn')!.nodeId;
    const out1 = terminals.find(t => t.terminalId === 'out1')!.nodeId;
    const out2 = terminals.find(t => t.terminalId === 'out2')!.nodeId;
    const vf = params.ledVf as number;
    const rled = Math.max(0.001, params.rled as number);
    const iTrig = params.iTrigger as number;
    const ron = Math.max(0.001, params.ron as number);
    const roff = Math.max(1, params.roff as number);
    const zc = (params.zeroCross as number) !== 0;
    const vIn = (sim.nodeVoltage[inp] ?? 0) - (sim.nodeVoltage[inn] ?? 0);
    // Input side: LED + series resistor (optocoupler pattern). Forward
    // current from the previous iterate decides whether the output triggers.
    let iin = 0;
    if (vIn > vf) {
      sys.stampConductance(inp, inn, 1 / rled);
      sys.stampCurrentSource(inn, inp, vf / rled);
      iin = (vIn - vf) / rled;
    } else {
      sys.stampConductance(inp, inn, 1e-13);
    }
    const vOut = Math.abs((sim.nodeVoltage[out1] ?? 0) - (sim.nodeVoltage[out2] ?? 0));
    // Zero-cross parts only close when the load voltage is near zero at the
    // moment of triggering (|V| < 10V); once closed the on-resistance
    // collapses the voltage, keeping the condition satisfied.
    const conducting = iin > iTrig && !(zc && vOut > 10);
    sys.stampConductance(out1, out2, conducting ? 1 / ron : 1 / roff);
  },
  getFlowPath() { return [{ x: 0, y: 2 }, { x: 6, y: 2 }]; },
};

// Register all P3 analog/discrete components
registerPlugin(lm324);
registerPlugin(ne5532);
registerPlugin(lm311);
registerPlugin(lm393);
registerPlugin(lm1117);
registerPlugin(lt3045);
registerPlugin(igbt);
registerPlugin(crd);
registerPlugin(ptc);
registerPlugin(mov);
registerPlugin(ssr);
