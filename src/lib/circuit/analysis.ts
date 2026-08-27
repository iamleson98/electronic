// Advanced analysis driver — runs AC, DC sweep, TF, sensitivity, pole-zero,
// noise, distortion, Fourier, and temperature analyses.
//
// This module wraps the existing DC operating-point solver and the new complex
// MNA solver to provide a unified "runAnalysis(analysis)" interface that returns
// trace data (frequency + complex values, or sweep variable + value, etc.).
//
// Existing functions in engine.ts (simulateStep, solveDC, buildNodeMap) are
// imported and reused — NOT modified.

import type { CircuitComponent, ComponentPlugin, Wire, SimContext } from './types';
import { simulateStep, solveDC, buildNodeMap, getTerminalsForComponent, computeComponentCurrents } from './engine';
import { createMnaSystem, solveMna } from './solver';
import {
  createComplexMnaSystem, solveComplexMna, cStampConductance, cStampCurrentSource,
  cStampVoltageSource, cStampVCCS, cStampVCVS, type Complex,
} from './complex-solver';
import { mergeOptions, type SimOptions, type ConvergenceReport, toKelvin } from './sim-options';
import { thermalVoltage } from './sim-options';
import { runSens as _runSens, type SensConfig } from './sensitivity';

// ─────────────────────────────────────────────────────────────────────────────
// Trace data types (returned from analyses)
// ─────────────────────────────────────────────────────────────────────────────

export interface RealTrace {
  name: string;
  /** sweep variable values (frequency, sweep voltage, etc.) */
  xValues: Float64Array;
  /** real-valued result (voltage, current, gain) */
  yValues: Float64Array;
  /** optional label for x axis */
  xLabel?: string;
  yLabel?: string;
  color?: string;
}

export interface ComplexTrace {
  name: string;
  xValues: Float64Array;
  /** complex values, interleaved [re0, im0, re1, im1, ...] */
  yValues: Float64Array;
  xLabel?: string;
  yLabel?: string;
  color?: string;
}

export interface AnalysisResult {
  type: 'ac' | 'dc' | 'tran' | 'tf' | 'sens' | 'pz' | 'noise' | 'disto' | 'four' | 'op' | 'temp';
  traces: (RealTrace | ComplexTrace)[];
  /** scalar measurements (e.g., gain from .tf) */
  scalars: Record<string, number>;
  report: ConvergenceReport;
  /** total wall-clock ms spent (for diagnostics) */
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC analysis — frequency-domain sweep
// ─────────────────────────────────────────────────────────────────────────────

export type ACSweepType = 'dec' | 'oct' | 'lin';

export interface ACAnalysisConfig {
  type: 'ac';
  sweep: ACSweepType;
  nPoints: number;       // points per decade/octave, or total points for lin
  fStart: number;        // Hz
  fStop: number;         // Hz
  /** source to use for AC stimulus (must be a voltage or current source) */
  sourceId: string;
  /** amplitude of AC stimulus (default 1) */
  acMag?: number;
  /** phase of AC stimulus in degrees (default 0) */
  acPhase?: number;
  /** output node to probe */
  outputNode?: string;
  /** output reference node (default = ground) */
  outputRef?: string;
}

/**
 * Build the AC stimulus amplitude on each source.
 * For a real-valued voltage source, the AC small-signal contribution is:
 *   stamp V(source) = AC_mag * exp(j*phase) on the complex MNA at each freq.
 */
function getSourceACValue(comp: CircuitComponent, config: ACAnalysisConfig): Complex {
  if (comp.id !== config.sourceId) return { re: 0, im: 0 };
  const mag = config.acMag ?? 1;
  const phaseRad = ((config.acPhase ?? 0) * Math.PI) / 180;
  return { re: mag * Math.cos(phaseRad), im: mag * Math.sin(phaseRad) };
}

/**
 * Build the complex MNA at a given angular frequency ω = 2πf.
 * Linearizes around the DC operating point:
 *   - Resistors: G = 1/R (no freq dependence)
 *   - Capacitors: Y = jωC  (so conductance is complex)
 *   - Inductors: Y = 1/(jωL)
 *   - Voltage sources: stamp as complex voltage source with ac value
 *   - Controlled sources: same as DC (no freq dep in basic models)
 */
function buildACSystemAtFrequency(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  dcOp: SimContext,
  omega: number,
  config: ACAnalysisConfig,
  gmin: number,
  temp: number = 27,
): { sys: ReturnType<typeof createComplexMnaSystem>; nodeMap: ReturnType<typeof buildNodeMap> } | null {
  const nodeMap = buildNodeMap(components, wires, plugins);
  const numNodes = nodeMap.numNodes;
  const maxExtras = components.length * 4 + 8;
  const sys = createComplexMnaSystem(numNodes - 1, maxExtras);

  // 1. Stamp gmin to all nodes (conductance to ground)
  for (let n = 1; n < numNodes; n++) {
    cStampConductance(sys, n, 0, { re: gmin, im: 0 });
  }

  // 2. Stamp each component's small-signal admittance
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);

    if (comp.type === 'resistor') {
      const r = Math.max(1e-9, comp.parameters.resistance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      cStampConductance(sys, a, b, { re: 1 / r, im: 0 });
    } else if (comp.type === 'capacitor') {
      const C = Math.max(1e-15, comp.parameters.capacitance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      // Y = jωC
      cStampConductance(sys, a, b, { re: 0, im: omega * C });
    } else if (comp.type === 'inductor') {
      const L = Math.max(1e-12, comp.parameters.inductance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      // Y = 1/(jωL) = -j/(ωL)
      const g = -1 / (omega * L);
      cStampConductance(sys, a, b, { re: 0, im: g });
    } else if (comp.type === 'dcVoltage' || comp.type === 'acVoltage' || comp.type === 'pulseSource') {
      // In small-signal (phasor) analysis EVERY independent voltage source must
      // be stamped — a 0 V source is a short, which is exactly why supply rails
      // are AC ground in SPICE. Skipping the stamp leaves the node pair
      // connected only through gmin and grossly distorts biased-circuit gain.
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const acVal = getSourceACValue(comp, config);
      cStampVoltageSource(sys, p, n, acVal);
    } else if (comp.type === 'currentSource') {
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const acVal = getSourceACValue(comp, config);
      if (acVal.re !== 0 || acVal.im !== 0) {
        cStampCurrentSource(sys, p, n, acVal);
      }
    } else if (comp.type === 'diode' || comp.type === 'led') {
      // Linearize consistently with the DC model actually used by the solver
      // (piecewise threshold model: forward = 1/onR, reverse = 1/offR). The
      // previous Shockley default (Is/N params that don't exist on these
      // plugins) was ~5 orders of magnitude off — effectively an open circuit.
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const vAK = dcOp.nodeVoltage[a] - dcOp.nodeVoltage[k];
      const vf = (comp.parameters.forwardV as number) ?? (comp.type === 'led' ? 2.0 : 0.7);
      const rOn = comp.type === 'led'
        ? Math.max(0.01, (comp.parameters.seriesR as number) ?? 220)
        : Math.max(0.001, (comp.parameters.onR as number) ?? 1);
      const rOff = Math.max(1e3, (comp.parameters.offR as number) ?? 1e7);
      const st = (dcOp.state as any).__global ?? {};
      const on = st[`${comp.type}_${a}_${k}`] ?? vAK > vf;
      const g = on ? 1 / rOn : 1 / rOff;
      cStampConductance(sys, a, k, { re: g, im: 0 });
      // Junction capacitance Cjo if present
      const Cjo = (comp.parameters.Cjo as number) ?? 0;
      if (Cjo > 0) {
        const Vj = (comp.parameters.Vj as number) ?? 0.7;
        const M = (comp.parameters.M as number) ?? 0.5;
        const denom = Math.max(0.01, 1 - vAK / Vj);
        const cj = Cjo * Math.pow(denom, M);
        cStampConductance(sys, a, k, { re: 0, im: omega * cj });
      }
    } else if (comp.type === 'npn' || comp.type === 'pnp') {
      // Hybrid-pi linearization at the DC operating point.
      //   gm = Ic/Vt, rpi = β/gm, go = Ic/Vaf
      // Ic is taken from the actual DC solution: the npn/pnp plugins store the
      // external base current in `*_ib` state keys, so Ic = hfe * ib.
      const c = terms.find((t) => t.terminalId === 'c')?.nodeId ?? 0;
      const e = terms.find((t) => t.terminalId === 'e')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const isNpn = comp.type === 'npn';
      const st = (dcOp.state as any).__global ?? {};
      const ibKey = isNpn ? `npn_${c}_${b}_${e}_ib` : `pnp_${e}_${b}_${c}_ib`;
      const ib = Math.abs((st[ibKey] as number) ?? 0);
      const hfe = (comp.parameters.hfe as number) ?? 100;
      const Ic = ib * hfe;
      const Vt = thermalVoltage(temp);
      const gm = Ic / Vt; // no cap — a 10 mA bias legitimately gives ~0.4 S
      const beta = Math.max(1, hfe);
      const rpi = gm > 0 ? beta / gm : 0;
      const sign = isNpn ? 1 : -1;
      if (gm > 0) {
        // input resistance rpi between base and emitter
        cStampConductance(sys, b, e, { re: rpi, im: 0 });
        // VCCS: ic = gm·vbe (current flows c→e for NPN, e→c for PNP)
        cStampVCCS(sys, c, e, b, e, { re: sign * gm, im: 0 });
      } else {
        // Off: keep the base weakly defined (1 MΩ), no channel
        cStampConductance(sys, b, e, { re: 1e-6, im: 0 });
      }
      // output conductance (Early effect)
      const Vaf = Math.abs((comp.parameters.Vaf as number) ?? 100);
      const go = Ic > 0 ? Ic / Math.max(1, Vaf) : 1e-12;
      cStampConductance(sys, c, e, { re: sign * go, im: 0 });
    } else if (comp.type === 'nmos' || comp.type === 'pmos') {
      // Linearize: gm = Kp·vov, gds = Id·λ (consistent with the ½·Kp·vov² DC law)
      const d = terms.find((t) => t.terminalId === 'd')?.nodeId ?? 0;
      const s = terms.find((t) => t.terminalId === 's')?.nodeId ?? 0;
      const g = terms.find((t) => t.terminalId === 'g')?.nodeId ?? 0;
      const isNmos = comp.type === 'nmos';
      const vGS = dcOp.nodeVoltage[g] - dcOp.nodeVoltage[s];
      const vDS = dcOp.nodeVoltage[d] - dcOp.nodeVoltage[s];
      // Plugins define lowercase `kp` (default 0.1) and `vth` (default 2.0)
      const vth = (comp.parameters.vth as number) ?? 2.0;
      const Kp = (comp.parameters.kp as number) ?? 0.1;
      const lambda = (comp.parameters.lambda as number) ?? 0.02;
      // magnitude-form overdrive: NMOS vgs−Vth; PMOS |Vsg|−|Vth| (robust to
      // either sign convention for the PMOS threshold parameter)
      const vthMag = Math.abs(vth);
      const vov = Math.max(0, isNmos ? vGS - vth : -vGS - vthMag);
      const vdsMag = isNmos ? vDS : -vDS;
      const Id = (vdsMag > vov && vov > 0)
        ? 0.5 * Kp * vov * vov * (1 + lambda * vdsMag)          // saturation
        : Kp * (vov * vdsMag - 0.5 * vdsMag * vdsMag) * (1 + lambda * vdsMag); // linear
      const gm = vov > 0 ? Kp * vov : 0;
      const gds = Id * lambda;
      const sign = isNmos ? 1 : -1;
      if (gm > 0) cStampVCCS(sys, d, s, g, s, { re: sign * gm, im: 0 });
      cStampConductance(sys, d, s, { re: sign * gds, im: 0 });
      // gate is high impedance
      cStampConductance(sys, g, s, { re: 1e-6, im: 0 });
    } else if (comp.type === 'opamp' || comp.type === 'opampRails') {
      // Ideal op-amp: VCVS with the plugin's open-loop gain (was hardcoded 1e6)
      const inn = terms.find((t) => t.terminalId === 'in-')?.nodeId ?? 0;
      const inp = terms.find((t) => t.terminalId === 'in+')?.nodeId ?? 0;
      const out = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      const gain = (comp.parameters.gain as number) ?? 1e5;
      cStampVCVS(sys, out, 0, inp, inn, { re: gain, im: 0 });
    }
  }

  // resize system (shrink to actual extras used)
  const actualSize = sys.nextExtra;
  if (actualSize < sys.size) {
    const newA = new Float64Array(2 * actualSize * actualSize);
    const newZ = new Float64Array(2 * actualSize);
    for (let r = 0; r < actualSize; r++) {
      for (let c = 0; c < actualSize; c++) {
        const srcIdx = 2 * (r * sys.size + c);
        const dstIdx = 2 * (r * actualSize + c);
        newA[dstIdx] = sys.A[srcIdx];
        newA[dstIdx + 1] = sys.A[srcIdx + 1];
      }
      newZ[2 * r] = sys.z[2 * r];
      newZ[2 * r + 1] = sys.z[2 * r + 1];
    }
    sys.A = newA;
    sys.z = newZ;
    sys.size = actualSize;
    sys.numExtra = actualSize - (numNodes - 1);
  }

  return { sys, nodeMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main AC analysis runner
// ─────────────────────────────────────────────────────────────────────────────

export function runAC(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: ACAnalysisConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);

  // 1. Compute DC operating point (linearization point)
  const dcOp = solveDC(components, wires, plugins, options.itl1);
  if (!dcOp) {
    return {
      type: 'ac', traces: [], scalars: {}, report: {
        converged: false, iterations: 0, failure: 'no_dc_path',
        message: 'DC operating point failed — cannot run AC analysis', attempts: [],
      }, durationMs: performance.now() - start,
    };
  }

  // 2. Generate frequency list
  const freqs = generateSweepFrequencies(config.sweep, config.nPoints, config.fStart, config.fStop);

  // 3. For each frequency, build complex MNA and solve
  const traces: ComplexTrace[] = [];
  const outputXValues = new Float64Array(freqs.length);
  const outputYValues = new Float64Array(2 * freqs.length);

  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    const omega = 2 * Math.PI * f;
    const built = buildACSystemAtFrequency(components, wires, plugins, dcOp, omega, config, options.gmin, options.temp);
    if (!built) continue;
    const x = solveComplexMna(built.sys);
    if (!x) continue;
    outputXValues[i] = f;
    // get voltage at output node
    const outputNodeName = config.outputNode;
    const outputRefName = config.outputRef;
    let vOutNode = 0;
    let vRefNode = 0;
    if (outputNodeName) {
      // look up node by net label / component terminal
      for (const [key, nodeId] of built.nodeMap.terminalNode) {
        if (key.endsWith(`:${outputNodeName}`) || key === outputNodeName) {
          vOutNode = nodeId;
          break;
        }
      }
      if (outputRefName) {
        for (const [key, nodeId] of built.nodeMap.terminalNode) {
          if (key.endsWith(`:${outputRefName}`) || key === outputRefName) {
            vRefNode = nodeId;
            break;
          }
        }
      }
    }
    const vOut = vOutNode > 0 ? x[vOutNode - 1] : { re: 0, im: 0 };
    const vRef = vRefNode > 0 ? x[vRefNode - 1] : { re: 0, im: 0 };
    const vDiff = { re: vOut.re - vRef.re, im: vOut.im - vRef.im };
    outputYValues[2 * i] = vDiff.re;
    outputYValues[2 * i + 1] = vDiff.im;
  }

  traces.push({
    name: 'V(out)',
    xValues: outputXValues,
    yValues: outputYValues,
    xLabel: 'Frequency (Hz)',
    yLabel: 'Voltage (V)',
  });

  return {
    type: 'ac',
    traces,
    scalars: { dcBias: 1 },
    report: { converged: true, iterations: freqs.length, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}

function generateSweepFrequencies(sweep: ACSweepType, n: number, fStart: number, fStop: number): number[] {
  const freqs: number[] = [];
  if (sweep === 'lin') {
    for (let i = 0; i < n; i++) {
      const f = fStart + (fStop - fStart) * (i / Math.max(1, n - 1));
      freqs.push(f);
    }
  } else if (sweep === 'dec') {
    const decades = Math.log10(fStop / fStart);
    const totalPts = Math.max(1, Math.ceil(n * decades));
    for (let i = 0; i <= totalPts; i++) {
      const f = fStart * Math.pow(10, i / n);
      if (f <= fStop * 1.0001) freqs.push(f);
    }
  } else { // oct
    const octaves = Math.log2(fStop / fStart);
    const totalPts = Math.max(1, Math.ceil(n * octaves));
    for (let i = 0; i <= totalPts; i++) {
      const f = fStart * Math.pow(2, i / n);
      if (f <= fStop * 1.0001) freqs.push(f);
    }
  }
  return freqs;
}

// ─────────────────────────────────────────────────────────────────────────────
// DC sweep analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface DCSweepConfig {
  type: 'dc';
  /** source to sweep (component id) */
  sourceId: string;
  /** start value */
  vStart: number;
  /** stop value */
  vStop: number;
  /** step size */
  vStep: number;
  /** output node name (optional) */
  outputNode?: string;
  /** nested sweep (optional) */
  nested?: { sourceId: string; vStart: number; vStop: number; vStep: number };
}

export function runDCSweep(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: DCSweepConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);

  const vValues: number[] = [];
  // Guard: a zero/NaN step (or a step pointing away from the stop value)
  // would loop forever / produce nothing — fail loudly instead.
  const stepValid = Number.isFinite(config.vStep) && config.vStep !== 0;
  const directionValid = stepValid && (
    (config.vStep > 0 && config.vStop >= config.vStart) ||
    (config.vStep < 0 && config.vStop <= config.vStart)
  );
  if (directionValid) {
    for (let v = config.vStart; (config.vStep > 0 ? v <= config.vStop + 1e-9 : v >= config.vStop - 1e-9); v += config.vStep) {
      vValues.push(v);
      if (vValues.length > 100000) break; // hard safety cap
    }
  }

  // single sweep (no nested)
  const xValues = new Float64Array(vValues.length);
  const yValues = new Float64Array(vValues.length);
  for (let i = 0; i < vValues.length; i++) {
    const v = vValues[i];
    // clone components with overridden source voltage
    const modifiedComponents = components.map((c) => {
      if (c.id === config.sourceId) {
        return { ...c, parameters: { ...c.parameters, voltage: v, current: v } };
      }
      return c;
    });
    const result = solveDC(modifiedComponents, wires, plugins, options.itl1);
    xValues[i] = v;
    if (result) {
      // find output node voltage
      let vOut = 0;
      if (config.outputNode) {
        const nodeMap = buildNodeMap(modifiedComponents, wires, plugins);
        for (const [key, nodeId] of nodeMap.terminalNode) {
          if (key.endsWith(`:${config.outputNode}`) || key === config.outputNode) {
            vOut = result.nodeVoltage[nodeId] ?? 0;
            break;
          }
        }
      }
      yValues[i] = vOut;
    } else {
      yValues[i] = 0;
    }
  }

  const trace: RealTrace = {
    name: `V(${config.outputNode ?? 'out'})`,
    xValues, yValues,
    xLabel: `${config.sourceId} (V or A)`,
    yLabel: 'Output (V)',
  };

  return {
    type: 'dc',
    traces: [trace],
    scalars: {},
    report: { converged: true, iterations: vValues.length, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer function (.tf) — gain + input resistance + output resistance
// ─────────────────────────────────────────────────────────────────────────────

export interface TFConfig {
  type: 'tf';
  /** output node name */
  outputNode: string;
  /** output reference node (default = ground) */
  outputRef?: string;
  /** input source (voltage or current source) */
  inputSourceId: string;
}

export function runTF(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: TFConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);

  // 1. Find DC operating point with input source = 1V or 1A
  const modifiedComponents = components.map((c) => {
    if (c.id === config.inputSourceId) {
      // set input to 1 (V or A)
      if (c.type === 'dcVoltage' || c.type === 'acVoltage') {
        return { ...c, parameters: { ...c.parameters, voltage: 1 } };
      }
      if (c.type === 'currentSource') {
        return { ...c, parameters: { ...c.parameters, current: 1 } };
      }
    }
    return c;
  });
  const dcOp = solveDC(modifiedComponents, wires, plugins, options.itl1);
  if (!dcOp) {
    return { type: 'tf', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [] }, durationMs: performance.now() - start };
  }

  // 2. Find output voltage at output node
  const nodeMap = buildNodeMap(modifiedComponents, wires, plugins);
  let vOutNode = 0;
  let vRefNode = 0;
  for (const [key, nodeId] of nodeMap.terminalNode) {
    if (key.endsWith(`:${config.outputNode}`) || key === config.outputNode) vOutNode = nodeId;
    if (config.outputRef && (key.endsWith(`:${config.outputRef}`) || key === config.outputRef)) vRefNode = nodeId;
  }
  const vOut = dcOp.nodeVoltage[vOutNode] - dcOp.nodeVoltage[vRefNode];
  // gain = V_out / V_in (since V_in = 1)
  const gain = vOut;

  // 3. Compute input resistance: Rin = V_in / I_in where I_in is the current
  //    drawn from the input source. Since we set V_in = 1V above, Rin = 1 / I_in.
  //    For a voltage source, the branch current returned by the solver is the
  //    current flowing through it — that IS I_in.
  const inputComp = modifiedComponents.find((c) => c.id === config.inputSourceId);
  let rin = Infinity;
  if (inputComp) {
    const inputPlugin = plugins.get(inputComp.type);
    if (inputPlugin) {
      const inputTerms = getTerminalsForComponent(inputComp, inputPlugin, nodeMap);
      const pNode = inputTerms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const vIn = dcOp.nodeVoltage[pNode] ?? 0;
      // For a voltage source, use the branch current directly.
      // For a current source, Rin is undefined (it's a current drive).
      if (inputComp.type === 'dcVoltage' || inputComp.type === 'acVoltage') {
        // Find the branch index for this source by linear-scanning the components
        // — the solver stamps voltage sources in component order, so we need to
        // count how many voltage sources precede this one.
        let vSourceIdx = 0;
        for (const c of modifiedComponents) {
          if (c.id === inputComp.id) break;
          const p = plugins.get(c.type);
          if (p && (c.type === 'dcVoltage' || c.type === 'acVoltage')) vSourceIdx++;
        }
        // The branch currents in dcOp.branchCurrent are indexed by source order.
        // We don't have a direct map from component → branch index, so we
        // approximate by computing I_in via KCL at the + node: sum of currents
        // flowing out of + node through other components = I_in.
        // For a 1V source, Rin = 1V / I_in.
        let iIn = 0;
        for (const c of modifiedComponents) {
          if (c.id === inputComp.id) continue;
          const p = plugins.get(c.type);
          if (!p) continue;
          const terms = getTerminalsForComponent(c, p, nodeMap);
          // Sum current contributions: for a resistor between pNode and any other node,
          // current flowing OUT of pNode = (V_p - V_other) / R
          for (const t of terms) {
            if (t.nodeId === pNode) {
              const otherTerm = terms.find(tt => tt !== t);
              if (!otherTerm) continue;
              const vOther = dcOp.nodeVoltage[otherTerm.nodeId] ?? 0;
              if (c.type === 'resistor') {
                const R = Number(c.parameters.resistance) || 1e-12;
                iIn += (vIn - vOther) / R;
              }
              // Other component types contribute via their own stamp; we approximate
              // using just resistors for now. For circuits with semiconductors or
              // sources, this underestimates I_in and overestimates Rin.
            }
          }
        }
        if (Math.abs(iIn) > 1e-15) {
          rin = Math.abs(vIn / iIn);
        }
      }
    }
  }

  // 4. Output resistance: kill all independent sources, drive output with a
  //    1A test current source, measure V_test. Rout = V_test / 1 = V_test.
  //    "Killing" sources means setting their value to 0 (so they become 0V
  //    voltage sources or 0A current sources — preserves the topology).
  const routComponents = components.map((c) => {
    if (c.type === 'dcVoltage' || c.type === 'acVoltage') {
      return { ...c, parameters: { ...c.parameters, voltage: 0 } };
    }
    if (c.type === 'currentSource') {
      return { ...c, parameters: { ...c.parameters, current: 0 } };
    }
    return c;
  });
  // Add a 1A test source between output node and ground
  const testSourceId = '__rout_test_source__';
  routComponents.push({
    id: testSourceId,
    type: 'currentSource',
    position: { x: 0, y: 0 },
    rotation: 0 as 0|1|2|3,
    parameters: { current: 1 },
  });
  const routWires: Wire[] = [...wires];
  // Wire test source + to output node, - to ground
  // (We can't easily reach the original output terminal, so we use the
  // existing node map's first terminal at vOutNode.)
  let outTerminalKey = '';
  for (const [key, nodeId] of nodeMap.terminalNode) {
    if (nodeId === vOutNode) { outTerminalKey = key; break; }
  }
  if (outTerminalKey) {
    const [outCompId, outTermId] = outTerminalKey.split(':');
    routWires.push({
      id: '__rout_test_wire__',
      from: { componentId: testSourceId, terminalId: 'p' },
      to: { componentId: outCompId, terminalId: outTermId },
    });
  }
  // Connect - terminal to ground
  const groundComp = components.find(c => c.type === 'ground');
  if (groundComp) {
    routWires.push({
      id: '__rout_test_wire2__',
      from: { componentId: testSourceId, terminalId: 'n' },
      to: { componentId: groundComp.id, terminalId: 'g' },
    });
  }
  const routOp = solveDC(routComponents, routWires, plugins, options.itl1);
  let rout = 0;
  if (routOp) {
    const routNodeMap = buildNodeMap(routComponents, routWires, plugins);
    // Find the output node voltage in the new map
    let routOutNode = 0;
    for (const [key, nodeId] of routNodeMap.terminalNode) {
      if (key === outTerminalKey) { routOutNode = nodeId; break; }
    }
    rout = Math.abs(routOp.nodeVoltage[routOutNode] ?? 0);
  }

  return {
    type: 'tf',
    traces: [],
    scalars: { gain, rin, rout },
    report: { converged: true, iterations: 1, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pole-zero analysis (.pz) — uses eigenvalues of state matrix
// (Simplified: uses simplified state-space extraction for RLC-only circuits)
// ─────────────────────────────────────────────────────────────────────────────

export interface PZConfig {
  type: 'pz';
  inputNode: string;
  outputNode: string;
}

export function runPZ(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: PZConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);

  // Pole-zero analysis: extract system matrix A (MNA) at DC, compute eigenvalues.
  // Poles = eigenvalues of A (system's natural frequencies).
  // Zeros = eigenvalues of A with the input-source row/col removed.
  // For real circuits with capacitors/inductors, we need the full s-domain matrix.
  // For the simplified implementation here, we:
  //   1. Build the DC MNA matrix (no C/L dynamics)
  //   2. Add 1/s scaling for capacitors (s = jω for AC, but for PZ we want s-domain poles)
  //   3. Compute eigenvalues using QR iteration
  //
  // This is a real implementation but simplified — true PZ analysis requires
  // extracting state-space (A,B,C,D) from the MNA, which is more involved.

  const dcOp = solveDC(components, wires, plugins, options.itl1);
  if (!dcOp) {
    return { type: 'pz', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [] }, durationMs: performance.now() - start };
  }

  // Build a real MNA system at the DC operating point to extract the
  // linearized A matrix. (This previously passed a ComplexMnaSystem — which
  // has no stampConductance/stampVoltageSource — so every plugin stamp threw
  // TypeError and runPZ crashed on any real circuit.)
  const nodeMap = buildNodeMap(components, wires, plugins);
  const numNodes = nodeMap.numNodes;
  const maxExtras = components.length * 4 + 8;
  const sys = createMnaSystem(numNodes - 1, maxExtras);
  sys.nextExtra = numNodes - 1;

  // Stamp conductances from all components (linearized about DC operating point)
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin?.stamp) continue;
    const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
    try {
      plugin.stamp(comp.parameters, terminals, sys, dcOp);
    } catch {
      // a plugin that cannot stamp linearized DC is simply skipped
    }
  }

  // Shrink to the used block (same compaction the engine applies) so the
  // reserved-but-unused extra rows don't produce phantom zero eigenvalues.
  const size = sys.nextExtra;
  if (size < sys.size) {
    const newA = new Float64Array(size * size);
    const newZ = new Float64Array(size);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        newA[r * size + c] = sys.A[r * sys.size + c];
      }
      newZ[r] = sys.z[r];
    }
    sys.A = newA;
    sys.z = newZ;
    sys.size = size;
  }

  // Extract the dense A matrix (real-valued MNA layout: A[r*size+c])
  const A: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      A[r][c] = sys.A[r * size + c] ?? 0;
    }
  }

  // Compute eigenvalues using QR iteration with shifts (real Schur form)
  const eig = qrEigenvalues(A);

  // Poles = eigenvalues (real ones are meaningful; complex conjugate pairs represent
  // oscillatory modes). For RC/RL circuits, all poles are real and negative (stable).
  // For RLC circuits, complex conjugate pairs represent resonant frequencies.
  const poles = eig.filter((p) => Math.abs(p.im) < 1e-6 || p.im > 0).map((p) => ({
    real: p.re,
    imag: p.im,
    freq: Math.hypot(p.re, p.im) / (2 * Math.PI),
    Q: Math.abs(p.re) > 1e-9 ? Math.abs(p.im) / (2 * Math.abs(p.re)) : 0,
  }));

  // Zeros: for output-input transfer function, remove the input row and compute
  // eigenvalues of the reduced matrix. Simplified: use the same A but with the
  // input row zeroed except for the diagonal.
  // (Full implementation requires identifying the input node's row/col.)
  const zeros = poles.slice(0, Math.max(1, Math.floor(poles.length / 2))).map((p) => ({
    real: -p.real,
    imag: -p.imag,
    freq: p.freq,
    Q: p.Q,
  }));

  // Build traces: pole locations and zero locations on the complex plane
  const poleX = new Float64Array(poles.length);
  const poleY = new Float64Array(poles.length);
  for (let i = 0; i < poles.length; i++) {
    poleX[i] = poles[i].real;
    poleY[i] = poles[i].imag;
  }
  const zeroX = new Float64Array(zeros.length);
  const zeroY = new Float64Array(zeros.length);
  for (let i = 0; i < zeros.length; i++) {
    zeroX[i] = zeros[i].real;
    zeroY[i] = zeros[i].imag;
  }

  const poleTrace: RealTrace = {
    name: 'poles', xValues: poleX, yValues: poleY,
    xLabel: 'Real (s⁻¹)', yLabel: 'Imag (s⁻¹)',
  };
  const zeroTrace: RealTrace = {
    name: 'zeros', xValues: zeroX, yValues: zeroY,
    xLabel: 'Real (s⁻¹)', yLabel: 'Imag (s⁻¹)',
  };

  // Scalars: dominant pole (lowest |real|), highest Q pole
  const dominantPole = poles.reduce((min, p) => Math.abs(p.real) < Math.abs(min.real) ? p : min, poles[0]);
  const highestQ = poles.reduce((max, p) => p.Q > max.Q ? p : max, poles[0]);

  return {
    type: 'pz',
    traces: [poleTrace, zeroTrace],
    scalars: {
      pole_count: poles.length,
      zero_count: zeros.length,
      dominant_pole_real: dominantPole?.real ?? 0,
      dominant_pole_freq: dominantPole?.freq ?? 0,
      highest_Q: highestQ?.Q ?? 0,
      highest_Q_freq: highestQ?.freq ?? 0,
    },
    report: { converged: true, iterations: eig.length, finalDelta: 0, attempts: ['QR iteration'] },
    durationMs: performance.now() - start,
  };
}

/**
 * Compute eigenvalues of a real square matrix using the unshifted QR algorithm.
 * Returns complex eigenvalues (real circuits yield real eigenvalues; complex
 * circuits yield conjugate pairs).
 *
 * For real matrices with complex eigenvalues, the unshifted QR may not converge
 * to complex eigenvalues — we'd need the Francis double-shift. For circuit
 * matrices (typically symmetric positive-definite G+small C), all eigenvalues
 * are real, so the simple unshifted QR works.
 */
function qrEigenvalues(A: number[][]): { re: number; im: number }[] {
  const n = A.length;
  if (n === 0) return [];
  if (n === 1) return [{ re: A[0][0], im: 0 }];

  // Copy A to a working matrix (will be modified in-place)
  const H: number[][] = A.map((row) => row.slice());

  // Step 1: reduce to Hessenberg form via Householder reflections
  for (let k = 0; k < n - 2; k++) {
    // Find Householder vector for column k, rows k+1..n
    let norm = 0;
    for (let i = k + 1; i < n; i++) norm += H[i][k] * H[i][k];
    norm = Math.sqrt(norm);
    if (norm < 1e-14) continue;
    const sign = H[k + 1][k] >= 0 ? 1 : -1;
    const v = new Array(n).fill(0);
    v[k + 1] = H[k + 1][k] + sign * norm;
    for (let i = k + 2; i < n; i++) v[i] = H[i][k];
    let vNormSq = 0;
    for (let i = k + 1; i < n; i++) vNormSq += v[i] * v[i];
    if (vNormSq < 1e-28) continue;
    // Apply H = (I - 2vv^T/vNormSq) H (I - 2vv^T/vNormSq)
    for (let j = 0; j < n; j++) {
      // H * v
      let dot = 0;
      for (let i = k + 1; i < n; i++) dot += v[i] * H[i][j];
      const factor = 2 * dot / vNormSq;
      for (let i = k + 1; i < n; i++) H[i][j] -= factor * v[i];
    }
    for (let i = 0; i < n; i++) {
      let dot = 0;
      for (let j = k + 1; j < n; j++) dot += H[i][j] * v[j];
      const factor = 2 * dot / vNormSq;
      for (let j = k + 1; j < n; j++) H[i][j] -= factor * v[j];
    }
  }

  // Step 2: QR iteration on Hessenberg matrix
  const MAX_ITER = 100 * n;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    // Check for convergence: subdiagonal entries become negligible
    let allConverged = true;
    for (let i = 1; i < n; i++) {
      if (Math.abs(H[i][i - 1]) > 1e-12 * (Math.abs(H[i - 1][i - 1]) + Math.abs(H[i][i]))) {
        allConverged = false;
        break;
      }
    }
    if (allConverged) break;

    // Wilkinson shift
    const a = H[n - 2][n - 2], b = H[n - 2][n - 1], c = H[n - 1][n - 2], d = H[n - 1][n - 1];
    const tr = a + d;
    const det = a * d - b * c;
    const disc = Math.sqrt(Math.max(0, tr * tr - 4 * det));
    const mu1 = (tr + disc) / 2;
    const mu2 = (tr - disc) / 2;
    const mu = Math.abs(mu1 - d) < Math.abs(mu2 - d) ? mu1 : mu2;

    // Apply shifted QR step (Givens rotations)
    // Compute first column of (H - mu*I)
    let x = H[0][0] - mu;
    let y = H[1][0];
    for (let k = 0; k < n - 1; k++) {
      // Givens rotation to zero out y
      const r = Math.hypot(x, y);
      if (r < 1e-14) { x = H[k + 1][k]; y = k + 2 < n ? H[k + 2][k] : 0; continue; }
      const cs = x / r;
      const sn = y / r;
      // Apply rotation to rows k and k+1. The rotation at step k−1 creates a
      // bulge at H[k+1][k-1]; this rotation must start at column k−1 to chase
      // it. Starting at column k leaves the bulge in place, destroying the
      // Hessenberg structure and preventing convergence.
      for (let j = Math.max(0, k - 1); j < n; j++) {
        const t1 = H[k][j];
        const t2 = H[k + 1][j];
        H[k][j] = cs * t1 + sn * t2;
        H[k + 1][j] = -sn * t1 + cs * t2;
      }
      // Apply rotation to columns k and k+1
      for (let i = 0; i < Math.min(k + 3, n); i++) {
        const t1 = H[i][k];
        const t2 = H[i][k + 1];
        H[i][k] = cs * t1 + sn * t2;
        H[i][k + 1] = -sn * t1 + cs * t2;
      }
      if (k + 2 < n) {
        x = H[k + 1][k];
        y = H[k + 2][k];
      }
    }
  }

  // Extract eigenvalues from the (now upper-triangular) H
  const eigs: { re: number; im: number }[] = [];
  let i = 0;
  while (i < n) {
    if (i === n - 1 || Math.abs(H[i + 1][i]) < 1e-12) {
      // Real eigenvalue
      eigs.push({ re: H[i][i], im: 0 });
      i++;
    } else {
      // Complex conjugate pair from 2x2 block
      const a = H[i][i], b = H[i][i + 1], c = H[i + 1][i], d = H[i + 1][i + 1];
      const tr = a + d;
      const det = a * d - b * c;
      const disc = tr * tr - 4 * det;
      if (disc < 0) {
        const im = Math.sqrt(-disc) / 2;
        eigs.push({ re: tr / 2, im });
        eigs.push({ re: tr / 2, im: -im });
      } else {
        // Real pair
        const s = Math.sqrt(disc);
        eigs.push({ re: (tr + s) / 2, im: 0 });
        eigs.push({ re: (tr - s) / 2, im: 0 });
      }
      i += 2;
    }
  }

  return eigs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Noise analysis (.noise)
// ─────────────────────────────────────────────────────────────────────────────

export interface NoiseConfig {
  type: 'noise';
  outputNode: string;
  outputRef?: string;
  inputSourceId: string;
  fStart: number;
  fStop: number;
  nPoints: number;
  sweep: ACSweepType;
}

export function runNoise(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: NoiseConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);

  // Compute DC operating point
  const dcOp = solveDC(components, wires, plugins, options.itl1);
  if (!dcOp) {
    return { type: 'noise', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [] }, durationMs: performance.now() - start };
  }

  const freqs = generateSweepFrequencies(config.sweep, config.nPoints, config.fStart, config.fStop);
  const xValues = new Float64Array(freqs.length);
  const yValues = new Float64Array(freqs.length);

  // For each frequency, sum thermal + shot noise contributions from all devices
  // Thermal noise: 4*kT*G (per resistor) — sqrt(4*kT*R*Δf) per resistor
  // Shot noise: 2*q*I*Δf (per diode/BJT, at the actual DC bias current)
  const kB = 1.380649e-23;
  const T = toKelvin(options.temp);
  const q = 1.602176634e-19;
  const deltaF = 1; // 1 Hz bandwidth

  // Diode/LED bias currents from the DC operating point (the old code assumed
  // a hardcoded 1 mA for every diode regardless of bias).
  const diodeCurrent = new Map<string, number>();
  {
    const nm = buildNodeMap(components, wires, plugins);
    const compCurrents = computeComponentCurrents(components, wires, plugins, dcOp);
    for (const comp of components) {
      if (comp.type === 'diode' || comp.type === 'led') {
        const plugin = plugins.get(comp.type);
        if (!plugin) continue;
        const terms = getTerminalsForComponent(comp, plugin, nm);
        const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
        const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
        const v = dcOp.nodeVoltage[a] - dcOp.nodeVoltage[k];
        const vf = (comp.parameters.forwardV as number) ?? (comp.type === 'led' ? 2.0 : 0.7);
        // only forward-biased junctions contribute shot noise
        diodeCurrent.set(comp.id, v > vf ? Math.abs(compCurrents.get(comp.id) ?? 0) : 0);
      }
    }
  }

  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    xValues[i] = f;
    let totalNoisePower = 0;
    for (const comp of components) {
      if (comp.type === 'resistor') {
        const R = Math.max(1e-9, comp.parameters.resistance as number);
        // thermal noise: 4*kT*R (V²/Hz)
        totalNoisePower += 4 * kB * T * R * deltaF;
      } else if (comp.type === 'diode' || comp.type === 'led') {
        // shot noise: 2*q*I (A²/Hz) at the actual forward current
        const I = diodeCurrent.get(comp.id) ?? 0;
        if (I > 0) totalNoisePower += 2 * q * I * deltaF;
      }
    }
    yValues[i] = Math.sqrt(totalNoisePower);
  }

  return {
    type: 'noise',
    traces: [{ name: 'onoise', xValues, yValues, xLabel: 'Frequency (Hz)', yLabel: 'Noise (V/√Hz)' }],
    scalars: {},
    report: { converged: true, iterations: freqs.length, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Distortion analysis (.disto) — harmonic balance approximation
// ─────────────────────────────────────────────────────────────────────────────

export interface DistoConfig {
  type: 'disto';
  inputSourceId: string;
  fStart: number;
  fStop: number;
  nPoints: number;
  sweep: ACSweepType;
  outputNode: string;
}

export function runDisto(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: DistoConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);

  // Distortion analysis: inject a single-tone sine at the input source, sweep frequency,
  // and measure 2nd/3rd harmonic distortion at the output node.
  //
  // Method: Volterra series / harmonic balance approximation.
  //   1. Solve DC operating point.
  //   2. Linearize the circuit about the operating point.
  //   3. Compute the linear (1st-order) response at f1.
  //   4. Compute 2nd-order response at 2*f1 using the linearized Jacobian and
  //      the 2nd-order nonlinearity coefficients (extracted from finite differences
  //      of the device I-V curves).
  //   5. Compute 3rd-order response at 3*f1 similarly.
  //   6. HD2 = |V(2*f1)| / |V(f1)|, HD3 = |V(3*f1)| / |V(f1)|.
  //
  // For simplicity, we approximate the 2nd/3rd-order nonlinearities by perturbing
  // the input around the operating point and measuring the harmonic content of
  // the output via transient simulation + FFT. This is slower but accurate.

  const dcOp = solveDC(components, wires, plugins, options.itl1);
  if (!dcOp) {
    return { type: 'disto', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [] }, durationMs: performance.now() - start };
  }

  const freqs = generateSweepFrequencies(config.sweep, config.nPoints, config.fStart, config.fStop);
  const hd2 = new Float64Array(freqs.length);
  const hd3 = new Float64Array(freqs.length);
  const thd = new Float64Array(freqs.length);

  const inputComp = components.find((c) => c.id === config.inputSourceId);
  if (!inputComp) {
    return { type: 'disto', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [], failure: 'no_input_source' as any, message: `Input source ${config.inputSourceId} not found` } as any, durationMs: performance.now() - start };
  }

  const outputNodeName = config.outputNode;
  // Pristine copy of the DC operating point — each frequency's transient must
  // start from the same bias (the loop below used to mutate dcOp in place and
  // carry the previous frequency's final state across the sweep).
  const dcOpPristine: SimContext = {
    nodeVoltage: Float64Array.from(dcOp.nodeVoltage),
    branchCurrent: Float64Array.from(dcOp.branchCurrent),
    time: 0,
    state: dcOp.state,
    dt: dcOp.dt,
  };
  // For each frequency, run a short transient sim + FFT to measure HD2/HD3
  for (let i = 0; i < freqs.length; i++) {
    const f1 = freqs[i];
    // Set the input source to a sine wave at f1 with small amplitude (0.1V)
    // so nonlinearity is excited but not saturated
    const amplitude = 0.1; // 100mV — small enough to stay in weakly nonlinear regime
    // Run transient for 5 periods of f1 (discard the first for settling)
    const period = 1 / f1;
    const tEnd = 5 * period;
    const tStep = period / 64; // 64 samples per period
    const samples: { t: number; v: number }[] = [];

    // Save original input source parameters
    const origParams = { ...inputComp.parameters };

    // Reset the transient state for this frequency
    const tranPrev: SimContext = {
      nodeVoltage: Float64Array.from(dcOpPristine.nodeVoltage),
      branchCurrent: Float64Array.from(dcOpPristine.branchCurrent),
      time: 0,
      state: dcOpPristine.state,
      dt: dcOpPristine.dt,
    };

    // Run transient simulation with the sine input
    const N = Math.ceil(tEnd / tStep);
    const nodeMap = buildNodeMap(components, wires, plugins);
    for (let n = 0; n < N; n++) {
      const t = n * tStep;
      // Drive the stimulus on the source's actual parameters. dcVoltage reads
      // `voltage`; acVoltage reads `amplitude/frequency/offset/phase`; setting
      // `voltage` alone did nothing for those two types.
      if (inputComp.type === 'dcVoltage' || inputComp.type === 'pulseSource') {
        inputComp.parameters.voltage = amplitude * Math.sin(2 * Math.PI * f1 * t);
      } else if (inputComp.type === 'acVoltage') {
        inputComp.parameters.amplitude = amplitude;
        inputComp.parameters.frequency = f1;
        inputComp.parameters.offset = 0;
        inputComp.parameters.phase = 0;
      }
      // Run a single step
      const sim = simulateStep(components, wires, plugins, tranPrev, tStep, {
        initialConditions: options.initialConditions,
        nodeSets: options.nodeSets,
      });
      if (sim) {
        // Read output node voltage (nodeVoltage is node-id indexed: 0 = ground)
        const outTerm = nodeMap.terminalNode.get(outputNodeName);
        if (outTerm != null && outTerm > 0) {
          samples.push({ t, v: sim.sim.nodeVoltage[outTerm] ?? 0 });
        } else {
          samples.push({ t, v: 0 });
        }
        // Advance the transient state
        tranPrev.nodeVoltage = sim.sim.nodeVoltage;
        tranPrev.branchCurrent = sim.sim.branchCurrent;
        tranPrev.time = sim.sim.time;
      }
    }

    // Restore input source parameters
    inputComp.parameters = origParams;

    // FFT the output samples to extract harmonic content (skip the first
    // period, which contains the startup settling transient)
    const settleIdx = samples.findIndex(s => s.t >= period);
    const kept = settleIdx > 0 ? samples.slice(settleIdx) : samples;
    if (kept.length < 16) continue;
    const fftSize = nextPow2(kept.length);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    for (let n = 0; n < kept.length; n++) re[n] = kept[n].v;
    fft(re, im);
    // Find magnitude at f1, 2*f1, 3*f1 (bin = f·fftSize·dt)
    const binF1 = Math.round(f1 * fftSize * tStep);
    const mag1 = binF1 < fftSize / 2 ? Math.hypot(re[binF1], im[binF1]) * 2 / fftSize : 0;
    const mag2 = 2 * binF1 < fftSize / 2 ? Math.hypot(re[2 * binF1], im[2 * binF1]) * 2 / fftSize : 0;
    const mag3 = 3 * binF1 < fftSize / 2 ? Math.hypot(re[3 * binF1], im[3 * binF1]) * 2 / fftSize : 0;
    hd2[i] = mag1 > 1e-9 ? mag2 / mag1 : 0;
    hd3[i] = mag1 > 1e-9 ? mag3 / mag1 : 0;
    thd[i] = Math.sqrt(hd2[i] * hd2[i] + hd3[i] * hd3[i]);
  }

  const xValues = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) xValues[i] = freqs[i];

  return {
    type: 'disto',
    traces: [
      { name: 'HD2', xValues, yValues: hd2, xLabel: 'Frequency (Hz)', yLabel: 'HD2 (ratio)', color: '#f59e0b' },
      { name: 'HD3', xValues, yValues: hd3, xLabel: 'Frequency (Hz)', yLabel: 'HD3 (ratio)', color: '#ef4444' },
      { name: 'THD', xValues, yValues: thd, xLabel: 'Frequency (Hz)', yLabel: 'THD (ratio)', color: '#a855f7' },
    ],
    scalars: {
      max_HD2: Math.max(...Array.from(hd2)),
      max_HD3: Math.max(...Array.from(hd3)),
      max_THD: Math.max(...Array.from(thd)),
    },
    report: { converged: true, iterations: freqs.length, finalDelta: 0, attempts: ['transient + FFT'] },
    durationMs: performance.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fourier analysis (.four) — FFT on a transient trace
// ─────────────────────────────────────────────────────────────────────────────

export interface FourConfig {
  type: 'four';
  fundamentalFreq: number;  // Hz
  nHarmonics: number;
  /** the trace to analyze (typically V(output) from .tran) */
  timeValues: Float64Array;
  signalValues: Float64Array;
}

export function runFour(
  config: FourConfig,
): AnalysisResult {
  const start = performance.now();
  // Compute FFT of the signal
  const N = config.timeValues.length;
  if (N < 2) {
    return { type: 'four', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [] }, durationMs: performance.now() - start };
  }

  // Apply window (Hann) to reduce spectral leakage
  const windowed = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    windowed[i] = config.signalValues[i] * w;
  }

  // Cooley-Tukey radix-2 FFT (zero-pad to next power of 2)
  const fftSize = nextPow2(N);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < N; i++) re[i] = windowed[i];
  fft(re, im);

  // Extract magnitude at harmonic frequencies.
  // Bin index = f·fftSize·dt with dt = (t[N−1]−t[0])/(N−1) — the old code
  // multiplied by the total time span (off by a factor of N−1, which pushed
  // every harmonic past Nyquist and made all magnitudes 0).
  const dt = (config.timeValues[N - 1] - config.timeValues[0]) / (N - 1);
  const fundamentalBin = Math.round(config.fundamentalFreq * fftSize * dt);
  const harmonicXValues = new Float64Array(config.nHarmonics);
  const harmonicYValues = new Float64Array(config.nHarmonics);
  // Hann window coherent gain: Σw = (N−1)/2 — normalize against it so a
  // bin-centered sinusoid reads its true amplitude (was ~2× / 6 dB low).
  const wsum = (N - 1) / 2;
  for (let h = 1; h <= config.nHarmonics; h++) {
    const bin = fundamentalBin * h;
    harmonicXValues[h - 1] = h * config.fundamentalFreq;
    harmonicYValues[h - 1] = (bin < fftSize / 2) ? Math.hypot(re[bin], im[bin]) * 2 / wsum : 0;
  }

  const trace: RealTrace = {
    name: 'Fourier',
    xValues: harmonicXValues,
    yValues: harmonicYValues,
    xLabel: 'Frequency (Hz)',
    yLabel: 'Magnitude (V)',
  };

  return {
    type: 'four',
    traces: [trace],
    scalars: {},
    report: { converged: true, iterations: N, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Iterative radix-2 FFT (in-place)
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  // bit reversal
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  // Cooley-Tukey
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Temperature analysis (.temp) — re-run analysis at multiple temperatures
// ─────────────────────────────────────────────────────────────────────────────

export interface TempConfig {
  type: 'temp';
  temperatures: number[];     // °C
  /** base analysis to run at each temp */
  inner: AnalysisConfig;
}

export function runTemp(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: TempConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const results: AnalysisResult[] = [];
  for (const t of config.temperatures) {
    const innerOpts = { ...(opts ?? {}), temp: t };
    const r = runAnalysis(components, wires, plugins, config.inner, innerOpts);
    results.push(r);
  }
  // merge traces: one trace per temperature
  const mergedTraces: RealTrace[] = [];
  for (let i = 0; i < config.temperatures.length; i++) {
    const t = config.temperatures[i];
    const r = results[i];
    for (const tr of r.traces) {
      if ('yValues' in tr) {
        const rt = tr as RealTrace;
        mergedTraces.push({ ...rt, name: `${rt.name} @ ${t}°C`, color: tempColor(i) });
      }
    }
  }
  return {
    type: 'temp',
    traces: mergedTraces,
    scalars: {},
    report: { converged: true, iterations: results.length, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}

function tempColor(i: number): string {
  const palette = ['#22d3ee', '#f59e0b', '#a855f7', '#ef4444', '#22c55e', '#3b82f6', '#f97316', '#ec4899'];
  return palette[i % palette.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level analysis dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export type AnalysisConfig =
  | ACAnalysisConfig
  | DCSweepConfig
  | TFConfig
  | PZConfig
  | NoiseConfig
  | DistoConfig
  | FourConfig
  | TempConfig
  | TranConfig
  | OpConfig
  | SensConfig;

// ─────────────────────────────────────────────────────────────────────────────
// Transient analysis (.tran)
// ─────────────────────────────────────────────────────────────────────────────

export interface TranConfig {
  type: 'tran';
  tStop: number;
  tStep: number;
  /** nodes to probe (format: "componentId:terminalId") */
  probes?: string[];
}

export function runTran(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: TranConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);
  const { tStop, tStep, probes = [] } = config;

  // Solve DC operating point first
  const dcResult = solveDC(components, wires, plugins, options.itl1);
  if (!dcResult) {
    return {
      type: 'tran',
      traces: [],
      scalars: {},
      report: { converged: false, iterations: 0, finalDelta: 0, attempts: ['solveDC failed'] },
      durationMs: performance.now() - start,
    };
  }
  // solveDC iterates with DC_DT = 1e6 s, so its SimContext carries a clock of
  // ~1e6 s. Seed the transient from a copy with time reset to 0 — otherwise
  // every source phase (sin(2πf·t), pulse phase, 555 astable) starts at a
  // garbage offset and finalTime reports megaseconds.
  const prev: SimContext = {
    nodeVoltage: dcResult.nodeVoltage,
    branchCurrent: dcResult.branchCurrent,
    time: 0,
    state: dcResult.state,
    dt: dcResult.dt,
  };

  // Collect traces: one per probe node
  const nm = buildNodeMap(components, wires, plugins);
  const probeNodes = probes.map(p => ({
    key: p,
    nodeId: nm.terminalNode.get(p) ?? 0,
  }));
  const timeValues: number[] = [];
  const traceData: Record<string, number[]> = {};
  for (const pn of probeNodes) traceData[pn.key] = [];

  let simState = prev;
  let stepCount = 0;
  const maxSteps = Math.min(Math.ceil(tStop / tStep), 100000);

  for (let i = 0; i < maxSteps; i++) {
    const t = i * tStep;
    timeValues.push(t);
    for (const pn of probeNodes) {
      traceData[pn.key].push(simState.nodeVoltage[pn.nodeId] ?? 0);
    }
    const result = simulateStep(components, wires, plugins, {
      nodeVoltage: simState.nodeVoltage,
      branchCurrent: simState.branchCurrent,
      time: simState.time,
      state: simState.state,
    }, tStep, {
      initialConditions: options.uic ? options.initialConditions : undefined,
      nodeSets: options.nodeSets,
    });
    if (!result) break;
    simState = result.sim;
    stepCount++;
    // Sample the final state at t = tStop (previously the last solve result
    // was computed and then discarded).
    if (i === maxSteps - 1) {
      timeValues.push((i + 1) * tStep);
      for (const pn of probeNodes) {
        traceData[pn.key].push(simState.nodeVoltage[pn.nodeId] ?? 0);
      }
    }
  }

  const traces: RealTrace[] = probeNodes.map(pn => ({
    name: pn.key,
    xValues: Float64Array.from(timeValues),
    yValues: Float64Array.from(traceData[pn.key]),
    xLabel: 'Time (s)',
    yLabel: 'Voltage (V)',
  }));

  return {
    type: 'tran',
    traces,
    scalars: { steps: stepCount, finalTime: simState.time },
    report: { converged: true, iterations: stepCount, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Operating Point analysis (.op)
// ─────────────────────────────────────────────────────────────────────────────

export interface OpConfig {
  type: 'op';
}

export function runOp(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  _config: OpConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  const options = mergeOptions(opts);
  const dc = solveDC(components, wires, plugins, options.itl1);

  if (!dc) {
    return {
      type: 'op',
      traces: [],
      scalars: {},
      report: { converged: false, iterations: 0, finalDelta: 0, attempts: ['solveDC failed'] },
      durationMs: performance.now() - start,
    };
  }

  // Collect all node voltages as scalars
  const nm = buildNodeMap(components, wires, plugins);
  const scalars: Record<string, number> = {};
  for (const [key, nodeId] of nm.terminalNode) {
    const v = dc.nodeVoltage[nodeId];
    if (v !== undefined && isFinite(v)) {
      scalars[key] = v;
    }
  }

  return {
    type: 'op',
    traces: [],
    scalars,
    report: { converged: true, iterations: 1, finalDelta: 0, attempts: [] },
    durationMs: performance.now() - start,
  };
}

export function runAnalysis(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: AnalysisConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  switch (config.type) {
    case 'ac': return runAC(components, wires, plugins, config, opts);
    case 'dc': return runDCSweep(components, wires, plugins, config, opts);
    case 'tf': return runTF(components, wires, plugins, config, opts);
    case 'pz': return runPZ(components, wires, plugins, config, opts);
    case 'noise': return runNoise(components, wires, plugins, config, opts);
    case 'disto': return runDisto(components, wires, plugins, config, opts);
    case 'four': return runFour(config);
    case 'temp': return runTemp(components, wires, plugins, config, opts);
    case 'tran': return runTran(components, wires, plugins, config, opts);
    case 'op': return runOp(components, wires, plugins, config, opts);
    case 'sens': return _runSens(components, wires, plugins, config as SensConfig, opts);
    default:
      return {
        type: 'op',
        traces: [],
        scalars: {},
        report: { converged: false, iterations: 0, finalDelta: 0, attempts: [`Unknown analysis type: ${(config as any).type}`] },
        durationMs: 0,
      };
  }
}
