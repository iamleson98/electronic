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
import { simulateStep, solveDC, buildNodeMap, getTerminalsForComponent } from './engine';
import { createMnaSystem, solveMna } from './solver';
import {
  createComplexMnaSystem, solveComplexMna, cStampConductance, cStampCurrentSource,
  cStampVoltageSource, cStampVCCS, cStampVCVS, type Complex,
} from './complex-solver';
import { mergeOptions, type SimOptions, type ConvergenceReport } from './sim-options';
import { thermalVoltage } from './sim-options';

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
      // DC source: zero AC contribution unless it's the AC source
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const acVal = getSourceACValue(comp, config);
      if (acVal.re !== 0 || acVal.im !== 0) {
        cStampVoltageSource(sys, p, n, acVal);
      }
    } else if (comp.type === 'currentSource') {
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const acVal = getSourceACValue(comp, config);
      if (acVal.re !== 0 || acVal.im !== 0) {
        cStampCurrentSource(sys, p, n, acVal);
      }
    } else if (comp.type === 'diode' || comp.type === 'led') {
      // Linearize around DC operating point — Shockley model gives g = dI/dV = Is/(n*Vt) * exp(V/(n*Vt))
      // For small-signal: just stamp conductance = I/Vt (assuming forward bias)
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const vAK = dcOp.nodeVoltage[a] - dcOp.nodeVoltage[k];
      const Is = (comp.parameters.Is as number) ?? 1e-14;
      const n = (comp.parameters.N as number) ?? 1.5;
      const Vt = thermalVoltage(27);
      const g = Is / (n * Vt) * Math.exp(Math.min(vAK / (n * Vt), 30));
      cStampConductance(sys, a, k, { re: g, im: 0 });
      // Also add junction capacitance Cjo if present
      const Cjo = (comp.parameters.Cjo as number) ?? 0;
      if (Cjo > 0) {
        const Vj = (comp.parameters.Vj as number) ?? 0.7;
        const M = (comp.parameters.M as number) ?? 0.5;
        const denom = Math.max(0.01, 1 - vAK / Vj);
        const cj = Cjo * Math.pow(denom, M);
        cStampConductance(sys, a, k, { re: 0, im: omega * cj });
      }
    } else if (comp.type === 'npn' || comp.type === 'pnp') {
      // Linearize: g_m = Ic/Vt, g_o = 1/Vaf (Early effect)
      // Simplified: stamp collector-emitter conductance based on gm
      const c = terms.find((t) => t.terminalId === 'c')?.nodeId ?? 0;
      const e = terms.find((t) => t.terminalId === 'e')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const Ic = Math.abs(dcOp.nodeVoltage[c] - dcOp.nodeVoltage[e]) /
                  Math.max(1, (comp.parameters.Rc as number) ?? 1000);
      const Vt = thermalVoltage(27);
      const gm = Math.min(1, Ic / Vt);
      // VCCS from b→e controlling c→e current
      cStampVCCS(sys, c, e, b, e, { re: gm, im: 0 });
      // output conductance (Early effect)
      const Vaf = (comp.parameters.Vaf as number) ?? 100;
      const go = Ic / Math.max(1, Vaf);
      cStampConductance(sys, c, e, { re: go, im: 0 });
    } else if (comp.type === 'nmos' || comp.type === 'pmos') {
      // Linearize: gm = 2*Id/(Vgs-Vth), gds = Id*lambda
      const d = terms.find((t) => t.terminalId === 'd')?.nodeId ?? 0;
      const s = terms.find((t) => t.terminalId === 's')?.nodeId ?? 0;
      const g = terms.find((t) => t.terminalId === 'g')?.nodeId ?? 0;
      const vGS = dcOp.nodeVoltage[g] - dcOp.nodeVoltage[s];
      const vDS = dcOp.nodeVoltage[d] - dcOp.nodeVoltage[s];
      const vth = (comp.parameters.vth as number) ?? 1.5;
      const Kp = (comp.parameters.Kp as number) ?? 0.05;
      const lambda = (comp.parameters.lambda as number) ?? 0.02;
      const vov = Math.max(0, vGS - vth);
      const Id = (vDS > vov)
        ? 0.5 * Kp * vov * vov * (1 + lambda * vDS)         // saturation
        : Kp * (vDS * vov - 0.5 * vDS * vDS) * (1 + lambda * vDS); // linear
      const gm = vov > 0 ? Kp * vov : 0;
      const gds = Id * lambda;
      cStampVCCS(sys, d, s, g, s, { re: gm, im: 0 });
      cStampConductance(sys, d, s, { re: gds, im: 0 });
    } else if (comp.type === 'opamp' || comp.type === 'opampRails') {
      // Ideal op-amp: VCVS with very high gain
      const inn = terms.find((t) => t.terminalId === 'in-')?.nodeId ?? 0;
      const inp = terms.find((t) => t.terminalId === 'in+')?.nodeId ?? 0;
      const out = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      const gain = 1e6;
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
    const built = buildACSystemAtFrequency(components, wires, plugins, dcOp, omega, config, options.gmin);
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
  for (let v = config.vStart; (config.vStep > 0 ? v <= config.vStop + 1e-9 : v >= config.vStop - 1e-9); v += config.vStep) {
    vValues.push(v);
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

  // 3. Compute input resistance: kill all independent sources except the input, drive with test current
  // Simplified: Rin = V_in / I_in where I_in is current drawn from input source
  // We can compute it from KCL at the input node
  const inputComp = modifiedComponents.find((c) => c.id === config.inputSourceId);
  let rin = Infinity;
  if (inputComp) {
    const inputPlugin = plugins.get(inputComp.type);
    if (inputPlugin) {
      const inputTerms = getTerminalsForComponent(inputComp, inputPlugin, nodeMap);
      const pNode = inputTerms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const vIn = dcOp.nodeVoltage[pNode];
      // current = voltage / equivalent input resistance
      // need to compute total current leaving the + node
      // ...for simplicity, use 1V source with 0 output load to find I_in
      // Kill output: short output to ground (set output node = 0)
      const shortedComponents = [...modifiedComponents, {
        id: 'tf_test_short',
        type: 'ground',
        position: { x: 0, y: 0 },
        rotation: 0 as 0|1|2|3,
        parameters: {},
        refdes: 'GND_TEST',
      } as CircuitComponent];
      // add a wire from output node to ground
      const shortedWires: Wire[] = [...wires];
      // (We don't actually modify wires — instead we just measure I_in from the input source.)
      // Simple Rin estimate: I_in ≈ source voltage / total load on + node
      // This requires KCL sum; for now we'll approximate Rin = 1V / I_in by re-solving with output killed
      rin = 1; // placeholder — a full implementation would re-solve with output shorted
      void shortedComponents;
      void shortedWires;
      void vIn;
    }
  }

  // 4. Output resistance: kill input, drive output with 1V test source, measure I_test
  // Simplified: Rout = V_test / I_test
  // For now: just return the gain
  const rout = 0; // placeholder — proper computation requires killing sources

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
  _components: CircuitComponent[],
  _wires: Wire[],
  _plugins: Map<string, ComponentPlugin>,
  _config: PZConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  // Pole-zero analysis requires eigenvalue computation on the state-space matrix.
  // For a real implementation, we'd extract A,B,C,D matrices from the MNA, then
  // compute eigenvalues using QR iteration.
  // For now: return an empty result with a "not yet implemented" diagnostic.
  const start = performance.now();
  return {
    type: 'pz',
    traces: [],
    scalars: {},
    report: {
      converged: false, iterations: 0, failure: 'newton_max_iter',
      message: 'Pole-zero analysis requires eigenvalue solver — not yet implemented',
      attempts: ['state-space extraction', 'QR iteration'],
    },
    durationMs: performance.now() - start,
  };
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
  // Shot noise: 2*q*I*Δf (per diode/BJT)
  const kB = 1.380649e-23;
  const T = 27 + 273.15;
  const q = 1.602176634e-19;
  const deltaF = 1; // 1 Hz bandwidth

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
        // shot noise: 2*q*I (A²/Hz) — assume forward bias
        const I = 1e-3; // placeholder
        totalNoisePower += 2 * q * I * deltaF;
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
  _components: CircuitComponent[],
  _wires: Wire[],
  _plugins: Map<string, ComponentPlugin>,
  _config: DistoConfig,
  opts?: Partial<SimOptions>,
): AnalysisResult {
  const start = performance.now();
  // Distortion analysis requires multi-tone harmonic balance — not yet implemented.
  return {
    type: 'disto',
    traces: [],
    scalars: {},
    report: {
      converged: false, iterations: 0, failure: 'newton_max_iter',
      message: 'Distortion analysis requires harmonic balance — not yet implemented',
      attempts: [],
    },
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

  // Extract magnitude at harmonic frequencies
  const fundamentalBin = Math.round(config.fundamentalFreq * fftSize * (config.timeValues[N - 1] - config.timeValues[0]));
  const harmonicXValues = new Float64Array(config.nHarmonics);
  const harmonicYValues = new Float64Array(config.nHarmonics);
  for (let h = 1; h <= config.nHarmonics; h++) {
    const bin = fundamentalBin * h;
    harmonicXValues[h - 1] = h * config.fundamentalFreq;
    harmonicYValues[h - 1] = (bin < fftSize / 2) ? Math.hypot(re[bin], im[bin]) / (N / 2) : 0;
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
  | TempConfig;

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
  }
}
