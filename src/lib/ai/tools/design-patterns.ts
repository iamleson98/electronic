// DESIGN PATTERNS — one-shot, parameterized circuit builders for the AI agent.
// ─────────────────────────────────────────────────────────────────────────────
// The core "super intelligence" primitive for complex designs: instead of the
// LLM issuing 30+ error-prone addComponent/addWire calls with hand-computed
// values and hand-picked coordinates, design.buildPattern constructs a
// complete, correctly-wired, correctly-valued sub-circuit in ONE tool call.
//
// Each pattern:
//   1. Computes component values from the user's spec via the design
//      calculators (exact math, E24 snapping).
//   2. Lays out components at clean relative coordinates, offset to the
//      first collision-free region of the canvas.
//   3. Wires everything following the same conventions as the built-in
//      examples (source left → chain right → ground bottom).
//   4. Returns a manifest (IDs, values, computed performance) so the AI can
//      refer to parts and report numbers to the user.
//
// The AI composes COMPLEX circuits by chaining patterns (e.g. a bench supply =
// power-supply pattern; a signal chain = rc-lowpass + opamp-inverting).

import type { Tool } from './types';
import type { ToolContext } from './types';
import type { CircuitComponent } from '@/lib/circuit/types';
import { createComponent, connect, groupPlacementOffset } from './layout-helpers';
import {
  calcLedResistor, calcVoltageDivider, calcRcFilter, calc555Astable,
  calc555Monostable, calcOpampGain, calcZenerResistor, calcBaseResistor,
  engFormat, nearestStandard,
} from './design-calculators';

interface PatternSpec {
  type: string;
  x: number; // relative to pattern anchor
  y: number;
  params: Record<string, any>;
  role: string; // human/AI-facing purpose
}

interface BuiltPart {
  id: string;
  type: string;
  role: string;
  params: Record<string, any>;
}

interface PatternResult {
  pattern: string;
  summary: string;
  parts: BuiltPart[];
  wires: number;
  computed: Record<string, number | string | boolean>;
  guidance: string[];
}

/** Place all pattern components at a collision-free offset, return them by role. */
function placePattern(
  ctx: ToolContext,
  spec: PatternSpec[],
  anchor: { x: number; y: number },
): Record<string, CircuitComponent> {
  const offset = groupPlacementOffset(ctx, spec.map(s => ({ x: s.x, y: s.y })), anchor);
  const byRole: Record<string, CircuitComponent> = {};
  for (const s of spec) {
    const comp = createComponent(ctx, s.type, offset.x + s.x, offset.y + s.y, s.params);
    byRole[s.role] = comp;
  }
  return byRole;
}

function manifest(
  pattern: string,
  ctx: ToolContext,
  partsByRole: Record<string, CircuitComponent>,
  spec: PatternSpec[],
  wireCount: number,
  computed: Record<string, number | string | boolean>,
  summary: string,
  guidance: string[],
): PatternResult {
  return {
    pattern,
    summary,
    parts: spec.map(s => {
      const comp = partsByRole[s.role];
      const shown: Record<string, any> = {};
      // Only surface non-default interesting params (values + key settings)
      for (const [k, v] of Object.entries(comp.parameters)) {
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') shown[k] = v;
      }
      return { id: comp.id, type: comp.type, role: s.role, params: shown };
    }),
    wires: wireCount,
    computed,
    guidance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern builders
// ─────────────────────────────────────────────────────────────────────────────

function buildLedDriver(ctx: ToolContext, args: any): PatternResult {
  const supplyV = args.supplyV ?? 5;
  const vf = args.vf ?? 2.0;
  const targetI = args.targetI ?? 0.015;
  const color = args.color ?? 'red';
  const calc = calcLedResistor(supplyV, vf, targetI);
  const r = calc.outputs.rStandard as number;

  const spec: PatternSpec[] = [
    { type: 'dcVoltage', x: 0, y: 8, params: { voltage: supplyV }, role: 'source' },
    { type: 'resistor', x: 8, y: 8, params: { resistance: r }, role: 'currentLimit' },
    { type: 'led', x: 16, y: 8, params: { color, forwardV: vf, seriesR: 1 }, role: 'led' },
    { type: 'ground', x: 8, y: 16, params: {}, role: 'ground' },
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 4, y: args.y ?? 4 });
  const wires = [
    connect(ctx, p.source, 'p', p.currentLimit, 'a'),
    connect(ctx, p.currentLimit, 'b', p.led, 'a'),
    connect(ctx, p.led, 'k', p.ground, 'g'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
  ].length;

  return manifest('led-driver', ctx, p, spec, wires, {
    resistor: r, resistorLabel: calc.outputs.rLabel,
    actualCurrent: calc.outputs.actualCurrent, powerResistor: calc.outputs.powerResistor,
  }, `LED driver: ${engFormat(supplyV, 'V')} supply → ${engFormat(r, 'Ω')} → ${color} LED (Vf ${vf}V). ${calc.explanation}`, calc.notes || []);
}

function buildVoltageDivider(ctx: ToolContext, args: any): PatternResult {
  const vin = args.vin ?? 5;
  const targetVout = args.vout ?? 3.3;
  const rTotal = args.rTotal ?? 10000;
  const calc = calcVoltageDivider(vin, undefined, undefined, targetVout, rTotal);
  const r1 = calc.outputs.r1 as number;
  const r2 = calc.outputs.r2 as number;

  const spec: PatternSpec[] = [
    { type: 'dcVoltage', x: 0, y: 6, params: { voltage: vin }, role: 'source' },
    { type: 'resistor', x: 8, y: 2, params: { resistance: r1 }, role: 'rTop' },
    { type: 'resistor', x: 8, y: 10, params: { resistance: r2 }, role: 'rBottom' },
    { type: 'ground', x: 8, y: 18, params: {}, role: 'ground' },
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 4, y: args.y ?? 4 });
  const wires = [
    connect(ctx, p.source, 'p', p.rTop, 'a'),
    connect(ctx, p.rTop, 'b', p.rBottom, 'a'),
    connect(ctx, p.rBottom, 'b', p.ground, 'g'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
  ].length;

  return manifest('voltage-divider', ctx, p, spec, wires, {
    r1, r2, voutActual: calc.outputs.voutActual, dividerCurrent: calc.outputs.dividerCurrent,
  }, `Voltage divider: ${vin}V → ${targetVout}V. ${calc.explanation}. Output is the junction of the two resistors (rTop.b / rBottom.a).`, [
    'The output node (rTop.b–rBottom.a) is intentionally unwired — probe it with a voltmeter or connect your load there.',
    ...(calc.notes || []),
  ]);
}

function buildRcFilter(ctx: ToolContext, args: any): PatternResult {
  const kind = args.kind === 'highpass' ? 'highpass' : 'lowpass';
  const fc = args.fc ?? 1000;
  const c = args.c ?? 100e-9;
  const amplitude = args.amplitude ?? 1;
  const calc = calcRcFilter(undefined, c, fc);
  const r = calc.outputs.rStandard as number;

  // lowpass: source → R → [out] → C → gnd.  highpass: source → C → [out] → R → gnd.
  const seriesSpec: PatternSpec = kind === 'lowpass'
    ? { type: 'resistor', x: 8, y: 8, params: { resistance: r }, role: 'series' }
    : { type: 'capacitor', x: 8, y: 8, params: { capacitance: c, initialV: 0 }, role: 'series' };
  const shuntSpec: PatternSpec = kind === 'lowpass'
    ? { type: 'capacitor', x: 16, y: 10, params: { capacitance: c, initialV: 0 }, role: 'shunt' }
    : { type: 'resistor', x: 16, y: 10, params: { resistance: r }, role: 'shunt' };

  const spec: PatternSpec[] = [
    { type: 'acVoltage', x: 0, y: 8, params: { amplitude, frequency: fc, offset: 0 }, role: 'source' },
    seriesSpec,
    shuntSpec,
    { type: 'ground', x: 8, y: 16, params: {}, role: 'ground' },
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 4, y: args.y ?? 4 });
  const wires = [
    connect(ctx, p.source, 'p', p.series, 'a'),
    connect(ctx, p.series, 'b', p.shunt, 'a'),
    connect(ctx, p.shunt, 'b', p.ground, 'g'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
  ].length;

  return manifest(`rc-${kind}`, ctx, p, spec, wires, {
    r, c, fcActual: calc.outputs.fcActual, tau: calc.outputs.tau,
  }, `RC ${kind} @ ${engFormat(fc, 'Hz')}: ${calc.explanation}. Output is the series.b–shunt.a junction.`, [
    `The AC source frequency is preset to the cutoff (${engFormat(fc, 'Hz')}) — sweep it to see the −3 dB point.`,
    'The output node is intentionally unwired — add a load, voltmeter, or oscilloscope there.',
    'First-order: −20 dB/decade rolloff, −45° phase at fc.',
  ]);
}

function build555Astable(ctx: ToolContext, args: any): PatternResult {
  const f = args.f ?? 1;
  const duty = args.duty ?? 0.6;
  const c = args.c ?? 1e-6;
  const vcc = args.vcc ?? 5;
  const withLed = args.withLed !== false;
  const calc = calc555Astable(undefined, undefined, c, f, duty);
  const r1 = calc.outputs.r1 as number;
  const r2 = calc.outputs.r2 as number;

  const spec: PatternSpec[] = [
    { type: 'dcVoltage', x: 0, y: 8, params: { voltage: vcc }, role: 'source' },
    { type: 'ground', x: 2, y: 20, params: {}, role: 'ground' },
    { type: 'timer555', x: 12, y: 8, params: { vcc, astable: true, r1, r2, c }, role: 'timer' },
    { type: 'resistor', x: 6, y: 2, params: { resistance: r1 }, role: 'ra' },
    { type: 'resistor', x: 20, y: 2, params: { resistance: r2 }, role: 'rb' },
    { type: 'capacitor', x: 20, y: 14, params: { capacitance: c, initialV: 0 }, role: 'ctiming' },
    ...(withLed ? [{ type: 'led', x: 24, y: 8, params: { color: 'green', forwardV: 2.0, seriesR: 220 }, role: 'led' as string }] : []),
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 4, y: args.y ?? 4 });
  const wires = [
    connect(ctx, p.source, 'p', p.timer, 'vcc'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
    connect(ctx, p.timer, 'gnd', p.ground, 'g'),
    connect(ctx, p.source, 'p', p.timer, 'rst'),
    connect(ctx, p.source, 'p', p.ra, 'a'),
    connect(ctx, p.ra, 'b', p.timer, 'dis'),
    connect(ctx, p.timer, 'dis', p.rb, 'a'),
    connect(ctx, p.rb, 'b', p.timer, 'thr'),
    connect(ctx, p.timer, 'thr', p.timer, 'trig'),
    connect(ctx, p.timer, 'thr', p.ctiming, 'a'),
    connect(ctx, p.ctiming, 'b', p.ground, 'g'),
    ...(withLed ? [
      connect(ctx, p.timer, 'out', p.led, 'a'),
      connect(ctx, p.led, 'k', p.ground, 'g'),
    ] : []),
  ].length;

  return manifest('555-astable', ctx, p, spec, wires, {
    r1, r2, c, fActual: calc.outputs.fActual, dutyActual: calc.outputs.dutyActual,
    tHigh: calc.outputs.tHigh, tLow: calc.outputs.tLow,
  }, `555 astable oscillator: ${calc.explanation}${withLed ? '; LED on OUT blinks at the set frequency' : ''}.`, [
    ...(calc.notes || []),
    'The 555 model drives timing from its internal R1/R2/C parameters (astable=true) — the external RC network is wired for authenticity.',
    'Start the transient simulation to see the output square wave; probe the OUT node.',
    'CTRL pin is left open (internally biased to ⅔ VCC); add a 10nF cap from CTRL to GND for noise immunity.',
  ]);
}

function build555Monostable(ctx: ToolContext, args: any): PatternResult {
  const pulseWidth = args.pulseWidth ?? 0.5;
  const c = args.c ?? 10e-6;
  const vcc = args.vcc ?? 5;
  const calc = calc555Monostable(undefined, c, pulseWidth);
  const r = calc.outputs.rStandard as number;

  const spec: PatternSpec[] = [
    { type: 'dcVoltage', x: 0, y: 8, params: { voltage: vcc }, role: 'source' },
    { type: 'ground', x: 2, y: 20, params: {}, role: 'ground' },
    { type: 'timer555', x: 12, y: 8, params: { vcc, astable: false, r1: 47000, r2: 47000, c: 1e-6 }, role: 'timer' },
    { type: 'resistor', x: 6, y: 2, params: { resistance: r }, role: 'rtiming' },
    { type: 'capacitor', x: 20, y: 14, params: { capacitance: c, initialV: 0 }, role: 'ctiming' },
    { type: 'pushButton', x: 4, y: 14, params: {}, role: 'trigger' },
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 4, y: args.y ?? 4 });
  const wires = [
    connect(ctx, p.source, 'p', p.timer, 'vcc'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
    connect(ctx, p.timer, 'gnd', p.ground, 'g'),
    connect(ctx, p.source, 'p', p.timer, 'rst'),
    connect(ctx, p.source, 'p', p.rtiming, 'a'),
    connect(ctx, p.rtiming, 'b', p.timer, 'thr'),
    connect(ctx, p.timer, 'thr', p.ctiming, 'a'),
    connect(ctx, p.ctiming, 'b', p.ground, 'g'),
    connect(ctx, p.timer, 'trig', p.trigger, 'a'),
    connect(ctx, p.trigger, 'b', p.ground, 'g'),
  ].length;

  return manifest('555-monostable', ctx, p, spec, wires, {
    r, c, pulseWidthActual: calc.outputs.pulseWidthActual,
  }, `555 monostable one-shot: ${calc.explanation}. Press the button to trigger a single output pulse.`, [
    'RST is tied high, THR+CT form the timing ramp, TRIG fires on the push button.',
    'The output (OUT) goes high for T = ln(3)·R·C when the button pulls TRIG below ⅓ VCC.',
  ]);
}

function buildTransistorSwitch(ctx: ToolContext, args: any): PatternResult {
  const vcc = args.vcc ?? 5;
  const driveV = args.driveV ?? 5;
  const loadKind = args.load === 'led' ? 'led' : 'resistor';
  const loadR = args.loadR ?? 470;
  const icTarget = args.icTarget ?? 0.01;
  const hfeMin = args.hfeMin ?? 100;
  const vbe = 0.7;
  const calc = calcBaseResistor(driveV, vbe, icTarget, hfeMin);
  const rb = calc.outputs.rStandard as number;
  // LED load resistance so the collector current ≈ icTarget: (vcc − vf − Vce_sat)/icTarget
  const ledSeriesR = Math.max(10, (vcc - 2.0 - 0.2) / icTarget);

  const loadSpec: PatternSpec = loadKind === 'led'
    ? { type: 'led', x: 8, y: 12, params: { color: 'red', forwardV: 2.0, seriesR: ledSeriesR }, role: 'load' }
    : { type: 'resistor', x: 8, y: 12, params: { resistance: loadR }, role: 'load' };

  const spec: PatternSpec[] = [
    { type: 'dcVoltage', x: 0, y: 4, params: { voltage: driveV }, role: 'drive' },
    { type: 'resistor', x: 8, y: 4, params: { resistance: rb }, role: 'rbase' },
    { type: 'npn', x: 16, y: 4, params: { hfe: hfeMin * 2, vbe: 0.7, satV: 0.2 }, role: 'transistor' },
    { type: 'dcVoltage', x: 0, y: 12, params: { voltage: vcc }, role: 'source' },
    loadSpec,
    { type: 'ground', x: 16, y: 18, params: {}, role: 'ground' },
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 4, y: args.y ?? 4 });
  // The load's "output" terminal differs by part: resistors use b, LEDs use k.
  const loadOut = loadKind === 'led' ? 'k' : 'b';
  const wires = [
    connect(ctx, p.drive, 'p', p.rbase, 'a'),
    connect(ctx, p.rbase, 'b', p.transistor, 'b'),
    connect(ctx, p.drive, 'n', p.ground, 'g'),
    connect(ctx, p.source, 'p', p.load, 'a'),
    connect(ctx, p.load, loadOut as any, p.transistor, 'c'),
    connect(ctx, p.transistor, 'e', p.ground, 'g'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
  ].length;

  return manifest('transistor-switch', ctx, p, spec, wires, {
    baseResistor: rb, baseCurrent: calc.outputs.ibActual, icCapable: calc.outputs.icCapable, ledSeriesR,
  }, `NPN low-side switch: ${calc.explanation}. ${loadKind === 'led' ? `LED load (series ${engFormat(ledSeriesR, 'Ω')}) from VCC to collector.` : `Resistive load ${engFormat(loadR, 'Ω')} from VCC to collector.`}`, [
    ...(calc.notes || []),
    'Drive source high → transistor saturates → load current flows. Drive low/off → load disconnected.',
    'For inductive loads (relay, motor), ALWAYS add a flyback diode across the load.',
    'The transistor model hfe is set to 2×hfeMin so the switch saturates with the computed base drive.',
  ]);
}

function buildOpampAmplifier(ctx: ToolContext, args: any): PatternResult {
  const kind = args.kind === 'noninverting' ? 'noninverting' : 'inverting';
  const gain = args.gain ?? (kind === 'inverting' ? -10 : 11);
  const targetMag = kind === 'inverting' ? Math.abs(Number(gain)) : Number(gain);
  const rin = args.rin ?? 1000;
  const amplitude = args.amplitude ?? 0.1;
  const calc = calcOpampGain(kind, rin, undefined, targetMag);
  const rf = calc.outputs.rf as number;

  // inverting: source → Rin → in−; Rf in−→out; in+ → gnd
  // non-inverting: source → in+; Rg in−→gnd; Rf in−→out
  const spec: PatternSpec[] = kind === 'inverting' ? [
    { type: 'acVoltage', x: 0, y: 8, params: { amplitude, frequency: 1000, offset: 0 }, role: 'source' },
    { type: 'resistor', x: 7, y: 8, params: { resistance: rin }, role: 'rin' },
    { type: 'resistor', x: 12, y: 2, params: { resistance: rf }, role: 'rf' },
    { type: 'opamp', x: 18, y: 6, params: { gain: 1e5 }, role: 'opamp' },
    { type: 'ground', x: 2, y: 16, params: {}, role: 'ground' },
  ] : [
    { type: 'acVoltage', x: 0, y: 8, params: { amplitude, frequency: 1000, offset: 0 }, role: 'source' },
    { type: 'resistor', x: 7, y: 12, params: { resistance: rin }, role: 'rg' },
    { type: 'resistor', x: 12, y: 2, params: { resistance: rf }, role: 'rf' },
    { type: 'opamp', x: 18, y: 6, params: { gain: 1e5 }, role: 'opamp' },
    { type: 'ground', x: 2, y: 16, params: {}, role: 'ground' },
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 4, y: args.y ?? 4 });
  const wires = kind === 'inverting' ? [
    connect(ctx, p.source, 'p', p.rin, 'a'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
    connect(ctx, p.rin, 'b', p.opamp, 'in-'),
    connect(ctx, p.rf, 'a', p.opamp, 'in-'),
    connect(ctx, p.rf, 'b', p.opamp, 'out'),
    connect(ctx, p.opamp, 'in+', p.ground, 'g'),
  ] : [
    connect(ctx, p.source, 'p', p.opamp, 'in+'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
    connect(ctx, p.opamp, 'in-', p.rg, 'a'),
    connect(ctx, p.rg, 'b', p.ground, 'g'),
    connect(ctx, p.rf, 'a', p.opamp, 'in-'),
    connect(ctx, p.rf, 'b', p.opamp, 'out'),
  ];

  return manifest(`opamp-${kind}`, ctx, p, spec, wires.length, {
    rf, gainActual: calc.outputs.gainActual, gainDb: calc.outputs.gainDb,
  }, `${kind === 'inverting' ? 'Inverting' : 'Non-inverting'} op-amp amplifier: ${calc.explanation}. Output is opamp.out.`, [
    'The ideal op-amp model needs no power rails — output swings are unlimited; for realistic clipping use the opampReal/LM358 parts.',
    'Probe opamp.out with an oscilloscope and compare against the input to verify the gain.',
    ...(calc.notes || []),
  ]);
}

function buildZenerRegulator(ctx: ToolContext, args: any): PatternResult {
  const vin = args.vin ?? 12;
  const vz = args.vz ?? 5.1;
  const iLoad = args.iLoad ?? 0.005;
  const withLoad = args.withLoad !== false;
  const calc = calcZenerResistor(vin, vz, iLoad);
  const r = calc.outputs.rStandard as number;
  const rLoad = nearestStandard(vz / iLoad, 'E24');

  const spec: PatternSpec[] = [
    { type: 'dcVoltage', x: 0, y: 8, params: { voltage: vin }, role: 'source' },
    { type: 'resistor', x: 8, y: 8, params: { resistance: r }, role: 'rseries' },
    { type: 'zener', x: 16, y: 10, params: { zenerV: vz }, role: 'zener' },
    ...(withLoad ? [{ type: 'resistor', x: 22, y: 6, params: { resistance: rLoad }, role: 'rload' as string }] : []),
    { type: 'ground', x: 8, y: 18, params: {}, role: 'ground' },
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 4, y: args.y ?? 4 });
  const wires = [
    connect(ctx, p.source, 'p', p.rseries, 'a'),
    connect(ctx, p.rseries, 'b', p.zener, 'k'),
    connect(ctx, p.zener, 'a', p.ground, 'g'),
    connect(ctx, p.source, 'n', p.ground, 'g'),
    ...(withLoad ? [
      connect(ctx, p.rseries, 'b', p.rload, 'a'),
      connect(ctx, p.rload, 'b', p.ground, 'g'),
    ] : []),
  ].length;

  return manifest('zener-regulator', ctx, p, spec, wires, {
    seriesR: r, powerZenerWorstCase: calc.outputs.powerZenerWorstCase, powerResistor: calc.outputs.powerResistor, rLoad,
  }, `Zener shunt regulator: ${calc.explanation}. Regulated output is the rseries.b–zener.k node.`, calc.notes || []);
}

function buildPowerSupply(ctx: ToolContext, args: any): PatternResult {
  const vacRms = args.vacRms ?? 12; // transformer secondary RMS
  const freq = args.freq ?? 50;
  const outputV = args.outputV ?? 5;
  const iLoad = args.iLoad ?? 0.1;
  const regType = outputV === 5 ? 'lm7805' : 'lm7805'; // lm7805 has outputV param
  const rippleTarget = 0.5; // Vpp
  // Smoothing cap: C = I/(2·f·ΔV) for full-wave
  const cSmooth = Math.max(iLoad / (2 * freq * rippleTarget), 470e-6);
  const cSmoothStd = nearestStandard(cSmooth * 1e6, 'E6') / 1e6;
  const peakV = vacRms * Math.SQRT2 - 1.4; // bridge drop
  const dropout = 2;
  const headroom = peakV - outputV - dropout;

  const spec: PatternSpec[] = [
    // acVoltage.amplitude is the PEAK of the sine (V = offset + amplitude·sin),
    // so the user-facing vacRms (RMS secondary voltage) must be scaled by √2.
    // The old code passed RMS as the amplitude while computing the rectified
    // peak as RMS·√2 − 1.4 — every reported number was ~41% above the actual
    // circuit, and low-vacRms builds silently ran the regulator in dropout.
    { type: 'acVoltage', x: 0, y: 8, params: { amplitude: vacRms * Math.SQRT2, frequency: freq, offset: 0 }, role: 'mains' },
    { type: 'transformer', x: 6, y: 8, params: { ratio: 1 }, role: 'transformer' },
    { type: 'diode', x: 12, y: 1, params: { forwardV: 0.7 }, role: 'd1' },
    { type: 'diode', x: 12, y: 15, params: { forwardV: 0.7 }, role: 'd2' },
    { type: 'diode', x: 18, y: 1, params: { forwardV: 0.7 }, role: 'd3' },
    { type: 'diode', x: 18, y: 15, params: { forwardV: 0.7 }, role: 'd4' },
    { type: 'capacitor', x: 24, y: 8, params: { capacitance: cSmoothStd, initialV: 0 }, role: 'cSmooth' },
    { type: regType, x: 29, y: 8, params: { outputV, dropoutV: dropout }, role: 'regulator' },
    { type: 'capacitor', x: 34, y: 12, params: { capacitance: 10e-6, initialV: 0 }, role: 'cOut' },
    { type: 'resistor', x: 29, y: 18, params: { resistance: nearestStandard(outputV / iLoad, 'E24') }, role: 'rload' },
    { type: 'ground', x: 6, y: 20, params: {}, role: 'ground' },
  ];
  const p = placePattern(ctx, spec, { x: args.x ?? 2, y: args.y ?? 2 });
  const wires = [
    // Primary
    connect(ctx, p.mains, 'p', p.transformer, 'p1'),
    connect(ctx, p.mains, 'n', p.transformer, 'p2'),
    // Bridge: s1 → d1.a, d3.k; s2 → d2.a, d4.k
    connect(ctx, p.transformer, 's1', p.d1, 'a'),
    connect(ctx, p.transformer, 's1', p.d3, 'k'),
    connect(ctx, p.transformer, 's2', p.d2, 'a'),
    connect(ctx, p.transformer, 's2', p.d4, 'k'),
    // + rail: d1.k + d2.k → cSmooth.a → regulator.in
    connect(ctx, p.d1, 'k', p.cSmooth, 'a'),
    connect(ctx, p.d2, 'k', p.cSmooth, 'a'),
    connect(ctx, p.cSmooth, 'a', p.regulator, 'in'),
    // − rail: d3.a + d4.a → ground
    connect(ctx, p.d3, 'a', p.ground, 'g'),
    connect(ctx, p.d4, 'a', p.ground, 'g'),
    connect(ctx, p.cSmooth, 'b', p.ground, 'g'),
    // Regulator out
    connect(ctx, p.regulator, 'gnd', p.ground, 'g'),
    connect(ctx, p.regulator, 'out', p.cOut, 'a'),
    connect(ctx, p.cOut, 'b', p.ground, 'g'),
    connect(ctx, p.regulator, 'out', p.rload, 'a'),
    connect(ctx, p.rload, 'b', p.ground, 'g'),
  ].length;

  const guidance = [
    `Full-wave bridge + ${engFormat(cSmoothStd, 'F')} smoothing (~${rippleTarget.toFixed(1)}Vpp ripple at ${engFormat(iLoad, 'A')}) + ${outputV}V linear regulator.`,
    'Transformer ratio is 1:1 — set `ratio` to step the secondary voltage up/down (secondary = primary × ratio).',
    `AC source: ${vacRms}V RMS secondary (amplitude ${(vacRms * Math.SQRT2).toFixed(1)}V peak) at ${freq}Hz.`,
  ];
  if (headroom < 0) {
    guidance.push(`⚠️ Peak secondary (${peakV.toFixed(1)}V after bridge drop) is below ${outputV} + ${dropout}V dropout — the regulator will drop out at the ripple valleys. Increase vacRms or the transformer ratio.`);
  } else {
    guidance.push(`Headroom: peak rectified ${peakV.toFixed(1)}V vs ${outputV}+${dropout}V needed → ${headroom.toFixed(1)}V margin at no load.`);
  }

  return manifest('power-supply', ctx, p, spec, wires, {
    cSmooth: cSmoothStd, peakRectified: peakV, headroom,
    rLoad: spec.find(s => s.role === 'rload')!.params.resistance,
  }, `Linear bench supply: ${vacRms}V AC → bridge rectifier → ${engFormat(cSmoothStd, 'F')} → ${outputV}V regulator → load.`, guidance);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern registry + tool
// ─────────────────────────────────────────────────────────────────────────────

const PATTERNS: Record<string, {
  label: string;
  description: string;
  params: string;
  build: (ctx: ToolContext, args: any) => PatternResult;
}> = {
  'led-driver': {
    label: 'LED driver',
    description: 'DC supply + current-limiting resistor + LED. Inputs: supplyV (5), vf (2.0), targetI (0.015 A), color (red), x, y.',
    params: 'supplyV, vf, targetI, color',
    build: buildLedDriver,
  },
  'voltage-divider': {
    label: 'Voltage divider',
    description: 'Two resistors from Vin to ground producing a target Vout. Inputs: vin (5), vout (3.3), rTotal (10k), x, y.',
    params: 'vin, vout, rTotal',
    build: buildVoltageDivider,
  },
  'rc-lowpass': {
    label: 'RC low-pass filter',
    description: 'Series R + shunt C, −3 dB at fc. Inputs: fc (1000 Hz), c (100nF), amplitude (1V), x, y.',
    params: 'fc, c, amplitude',
    build: (ctx, args) => buildRcFilter(ctx, { ...args, kind: 'lowpass' }),
  },
  'rc-highpass': {
    label: 'RC high-pass filter',
    description: 'Series C + shunt R, −3 dB at fc. Inputs: fc (1000 Hz), c (100nF), amplitude (1V), x, y.',
    params: 'fc, c, amplitude',
    build: (ctx, args) => buildRcFilter(ctx, { ...args, kind: 'highpass' }),
  },
  '555-astable': {
    label: '555 astable oscillator',
    description: 'Classic LED blinker: 555 + R1/R2/C timing network + optional LED. Inputs: f (1 Hz), duty (0.6), c (1µF), vcc (5), withLed (true), x, y.',
    params: 'f, duty, c, vcc, withLed',
    build: build555Astable,
  },
  '555-monostable': {
    label: '555 monostable one-shot',
    description: '555 + timing RC + push-button trigger; OUT high for T = 1.1·R·C. Inputs: pulseWidth (0.5 s), c (10µF), vcc (5), x, y.',
    params: 'pulseWidth, c, vcc',
    build: build555Monostable,
  },
  'transistor-switch': {
    label: 'NPN transistor switch',
    description: 'Low-side NPN switch with computed base resistor. Inputs: vcc (5), driveV (5), load (resistor|led), loadR (470), icTarget (0.01), hfeMin (100), x, y.',
    params: 'vcc, driveV, load, loadR, icTarget, hfeMin',
    build: buildTransistorSwitch,
  },
  'opamp-inverting': {
    label: 'Inverting op-amp amplifier',
    description: 'Rin/Rf feedback network, G = −Rf/Rin. Inputs: gain (−10 magnitude 10), rin (1k), amplitude (0.1V), x, y.',
    params: 'gain, rin, amplitude',
    build: (ctx, args) => buildOpampAmplifier(ctx, { ...args, kind: 'inverting' }),
  },
  'opamp-noninverting': {
    label: 'Non-inverting op-amp amplifier',
    description: 'Rg/Rf feedback network, G = 1 + Rf/Rg. Inputs: gain (11), rin (1k, = Rg), amplitude (0.1V), x, y.',
    params: 'gain, rin, amplitude',
    build: (ctx, args) => buildOpampAmplifier(ctx, { ...args, kind: 'noninverting' }),
  },
  'zener-regulator': {
    label: 'Zener shunt regulator',
    description: 'Series R + zener + optional load. Inputs: vin (12), vz (5.1), iLoad (0.005), withLoad (true), x, y.',
    params: 'vin, vz, iLoad, withLoad',
    build: buildZenerRegulator,
  },
  'power-supply': {
    label: 'Linear power supply',
    description: 'AC source → transformer → bridge rectifier (4 diodes) → smoothing cap → LM7805 → load. Inputs: vacRms (12), freq (50), outputV (5), iLoad (0.1), x, y.',
    params: 'vacRms, freq, outputV, iLoad',
    build: buildPowerSupply,
  },
};

const designBuildPatternTool: Tool = {
  name: 'design.buildPattern',
  category: 'AI Diagnosis & Teaching',
  description:
    'Build a complete, correctly-wired sub-circuit in ONE call. Values are computed from your spec (exact math + E24 standard parts) and components are auto-placed without overlapping. Use this INSTEAD of many addComponent/addWire calls whenever the target matches a pattern — then compose complex circuits by chaining patterns at different x/y anchors. Patterns: ' +
    Object.entries(PATTERNS).map(([k, p]) => `${k} — ${p.description}`).join(' | '),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', enum: Object.keys(PATTERNS), description: 'Which circuit pattern to build.' },
      x: { type: 'number', description: 'Optional anchor X on the grid (auto-placed nearby, default 4).' },
      y: { type: 'number', description: 'Optional anchor Y on the grid (default 4).' },
      args: { type: 'object', description: 'Pattern spec inputs (see pattern list). Numbers in SI units (V, A, Ω, F, Hz, s).', additionalProperties: true },
    },
    required: ['pattern'],
  },
  execute(rawArgs: { pattern: string; x?: number; y?: number; args?: Record<string, any> }, ctx) {
    const def = PATTERNS[rawArgs.pattern];
    if (!def) {
      return { ok: false, error: `Unknown pattern "${rawArgs.pattern}". Available: ${Object.keys(PATTERNS).join(', ')}` };
    }
    try {
      const args = { ...(rawArgs.args || {}), x: rawArgs.x, y: rawArgs.y };
      const result = def.build(ctx, args);
      return {
        ok: true,
        result: {
          ...result,
          note: 'Pattern built and wired. Verify with simulate.run + simulate.validatePhysics, then report the computed values to the user.',
        },
      };
    } catch (e) {
      return { ok: false, error: `Pattern "${rawArgs.pattern}" failed: ${(e as Error).message}` };
    }
  },
};

export { designBuildPatternTool, PATTERNS };
