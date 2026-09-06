// Monte Carlo analysis — runs N simulations with normally-distributed component
// tolerances and computes yield statistics + histograms.
// ─────────────────────────────────────────────────────────────────────────────
// Each run:
//   1. Clones the circuit
//   2. For each "toleranced" component, perturbs its value by ±tol% using a
//      Gaussian distribution (mean=nominal, stddev = tol% / 3 so 99.7% of
//      samples fall within ±tol%)
//   3. Runs the configured measurement (DC voltage at a node, AC magnitude, etc.)
//   4. Records the measurement value
//
// After all runs:
//   - Computes mean, stddev, min, max
//   - Computes yield (% of runs passing the spec)
//   - Builds a histogram with `nBins` bins
//
// Uses a simple LCG (Linear Congruential Generator) for reproducibility —
// pass `config.seed` for deterministic results.

import { solveDC, buildNodeMap, computeComponentCurrents } from './engine';
import type { CircuitComponent, Wire, ComponentPlugin, CircuitDocument } from './types';

export interface MonteCarloTolerance {
  /** Component ID (must match a component in the doc) */
  componentId: string;
  /** Parameter key to perturb (e.g., 'resistance', 'capacitance') */
  param: string;
  /** Tolerance as a fraction (0.05 = ±5%) */
  tolerance: number;
  /** Distribution: 'gauss' (default) or 'uniform' */
  distribution?: 'gauss' | 'uniform';
}

export interface MonteCarloConfig {
  /** Number of runs (default 100) */
  runs?: number;
  /** Random seed for reproducibility (default 1) */
  seed?: number;
  /** Tolerances per component. When empty, per-part `tolerance` fields on the
   *  components themselves are used (with DEFAULT_TOLERANCES fallback). */
  tolerances?: MonteCarloTolerance[];
  /** Default tolerance fraction when neither config nor part specifies one */
  defaultTolerance?: number;
  /** Measurement: what to extract from each run */
  measurement: {
    /** Type: 'voltage' (node voltage) or 'current' (component current) */
    type: 'voltage' | 'current';
    /** For voltage: "componentId:terminalId" */
    node?: string;
    /** For current: component ID */
    componentId?: string;
  };
  /** Spec: pass/fail criteria for yield computation */
  spec?: {
    /** Minimum acceptable value (inclusive) */
    min?: number;
    /** Maximum acceptable value (inclusive) */
    max?: number;
  };
  /** Number of histogram bins (default 20) */
  nBins?: number;
}

export interface MonteCarloRun {
  /** Run index (0-based) */
  index: number;
  /** Measured value */
  value: number;
  /** Whether this run passed the spec */
  passed: boolean;
  /** Per-component perturbed values (for diagnostics) */
  perturbations: Array<{ componentId: string; param: string; original: number; perturbed: number }>;
}

export interface MonteCarloStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  minIdx: number;
  maxIdx: number;
}

export interface MonteCarloResult {
  runs: MonteCarloRun[];
  stats: MonteCarloStats;
  /** Percentage of runs that passed the spec (0..1) */
  yield: number;
  histogram: number[];
  histogramEdges: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// LCG (Linear Congruential Generator) — simple, deterministic, fast
// ─────────────────────────────────────────────────────────────────────────────

class LCG {
  private state: number;
  constructor(seed: number) {
    this.state = (seed | 0) || 1;
  }
  next(): number {
    // Numerical Recipes LCG constants
    this.state = (Math.imul(this.state, 1664525) + 1013904223) | 0;
    return (this.state >>> 0) / 4294967296;  // [0, 1)
  }
  /** Standard normal via Box-Muller transform */
  nextGauss(): number {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function runMonteCarlo(
  doc: CircuitDocument,
  config: MonteCarloConfig,
  plugins: Map<string, ComponentPlugin>,
  _spec?: any,
): MonteCarloResult {
  const nRuns = Math.max(1, config.runs ?? 100);
  const seed = config.seed ?? 1;
  const nBins = Math.max(1, config.nBins ?? 20);
  const rng = new LCG(seed);

  // Tolerance source: explicit config list, else per-part `tolerance` fields
  // (with type defaults: R/C/L 5%, semiconductors 10%), else defaultTolerance.
  const DEFAULT_TOL: Record<string, number> = {
    resistor: 0.05, capacitor: 0.05, inductor: 0.05, potentiometer: 0.1,
    led: 0.1, diode: 0.1, zener: 0.05,
  };
  // Auto-tolerance mapping: passives/semiconductors only. SOURCES are the
  // exact stimulus of the experiment — perturbing them by default measures
  // input variation, not component spread, and swamps the real tolerance
  // signal (a divider's output spread becomes the supply's ±5%, not the
  // resistors'). Users can still explicitly list a source in
  // config.tolerances to model an actual noisy supply.
  const PARAM_BY_TYPE: Record<string, string> = {
    resistor: 'resistance', capacitor: 'capacitance', inductor: 'inductance',
    potentiometer: 'resistance', led: 'seriesR', diode: 'onR', zener: 'zenerV',
  };
  const tolerances: MonteCarloTolerance[] = (config.tolerances && config.tolerances.length > 0)
    ? config.tolerances
    : doc.components.flatMap((c) => {
        const param = PARAM_BY_TYPE[c.type];
        if (!param || typeof c.parameters[param] !== 'number') return [];
        const tol = c.tolerance ?? DEFAULT_TOL[c.type] ?? config.defaultTolerance ?? 0.05;
        return [{ componentId: c.id, param, tolerance: tol, distribution: c.toleranceDist ?? 'gauss' as const }];
      });

  const runs: MonteCarloRun[] = [];
  const values: number[] = [];

  for (let run = 0; run < nRuns; run++) {
    // Clone the circuit and apply perturbations
    const clonedComponents: CircuitComponent[] = JSON.parse(JSON.stringify(doc.components));
    const perturbations: MonteCarloRun['perturbations'] = [];
    for (const tol of tolerances) {
      const comp = clonedComponents.find(c => c.id === tol.componentId);
      if (!comp) continue;
      const orig = Number(comp.parameters[tol.param]);
      if (!isFinite(orig)) continue;
      // Per-part distribution wins over the config default (a 1% C0G on
      // 'uniform' must not inherit a global 'gauss').
      const srcComp = doc.components.find((c) => c.id === tol.componentId);
      const dist = tol.distribution ?? srcComp?.toleranceDist ?? 'gauss';
      let factor: number;
      if (dist === 'uniform') {
        // Uniform in [-tol, +tol]
        factor = 1 + (rng.next() * 2 - 1) * tol.tolerance;
      } else {
        // Gaussian with stddev = tol/3 (so 99.7% within ±tol)
        factor = 1 + rng.nextGauss() * (tol.tolerance / 3);
      }
      const perturbed = orig * factor;
      comp.parameters[tol.param] = perturbed;
      perturbations.push({ componentId: tol.componentId, param: tol.param, original: orig, perturbed });
    }

    // Run the measurement
    const value = measure({ components: clonedComponents, wires: doc.wires }, plugins, config.measurement);
    if (!isFinite(value)) {
      // Record the failed run (with its perturbations) but exclude it from
      // the statistics — previously failed runs vanished entirely, so yield
      // was computed only over survivors (a circuit failing 90% of the time
      // could report 100% yield).
      runs.push({ index: run, value: NaN, passed: false, perturbations });
      continue;
    }

    // Check spec
    let passed = true;
    if (config.spec) {
      if (config.spec.min !== undefined && value < config.spec.min) passed = false;
      if (config.spec.max !== undefined && value > config.spec.max) passed = false;
    }

    runs.push({ index: run, value, passed, perturbations });
    values.push(value);
  }

  // Compute statistics
  const stats = computeStats(values);

  // Build histogram
  const { histogram, histogramEdges } = buildHistogram(values, nBins);

  // Compute yield
  const yieldCount = runs.filter(r => r.passed).length;
  const yieldPct = runs.length > 0 ? yieldCount / runs.length : 0;

  return { runs, stats, yield: yieldPct, histogram, histogramEdges };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worst-case analysis — runs 2^N simulations with each tolerance at its
// extreme (±tol). Returns all runs sorted by measurement value.
// ─────────────────────────────────────────────────────────────────────────────

export function runWorstCase(
  doc: CircuitDocument,
  config: { tolerances: MonteCarloTolerance[]; measurement: MonteCarloConfig['measurement'] },
  plugins: Map<string, ComponentPlugin>,
): Array<{ combo: number[]; value: number; perturbations: Array<{ componentId: string; param: string; value: number }> }> {
  const n = config.tolerances.length;
  if (n === 0) return [];
  if (n > 16) {
    // Too many combinations for the full 2^N sweep — fall back to the two
    // extreme corners (all-at-min and all-at-max) instead of returning
    // nothing at all.
    const corners: Array<{ combo: number[]; value: number; perturbations: Array<{ componentId: string; param: string; value: number }> }> = [];
    for (const sign of [-1, 1]) {
      const clonedComponents: CircuitComponent[] = JSON.parse(JSON.stringify(doc.components));
      const comboArr: number[] = [];
      const perturbations: Array<{ componentId: string; param: string; value: number }> = [];
      for (const tol of config.tolerances) {
        const comp = clonedComponents.find(c => c.id === tol.componentId);
        if (!comp) { comboArr.push(0); continue; }
        const orig = Number(comp.parameters[tol.param]);
        if (!isFinite(orig)) { comboArr.push(0); continue; }
        const perturbed = orig * (1 + sign * tol.tolerance);
        comp.parameters[tol.param] = perturbed;
        comboArr.push(sign);
        perturbations.push({ componentId: tol.componentId, param: tol.param, value: perturbed });
      }
      const value = measure({ components: clonedComponents, wires: doc.wires }, plugins, config.measurement);
      if (isFinite(value)) {
        corners.push({ combo: comboArr, value, perturbations });
      }
    }
    corners.sort((a, b) => a.value - b.value);
    return corners;
  }
  const totalCombos = 1 << n;  // 2^n
  const results: Array<{ combo: number[]; value: number; perturbations: Array<{ componentId: string; param: string; value: number }> }> = [];

  for (let combo = 0; combo < totalCombos; combo++) {
    const clonedComponents: CircuitComponent[] = JSON.parse(JSON.stringify(doc.components));
    const comboArr: number[] = [];
    const perturbations: Array<{ componentId: string; param: string; value: number }> = [];
    for (let i = 0; i < n; i++) {
      // bit i: 0 = -tol, 1 = +tol
      const sign = (combo >> i) & 1 ? 1 : -1;
      const tol = config.tolerances[i];
      const comp = clonedComponents.find(c => c.id === tol.componentId);
      if (!comp) { comboArr.push(0); continue; }
      const orig = Number(comp.parameters[tol.param]);
      if (!isFinite(orig)) { comboArr.push(0); continue; }
      const perturbed = orig * (1 + sign * tol.tolerance);
      comp.parameters[tol.param] = perturbed;
      comboArr.push(sign);
      perturbations.push({ componentId: tol.componentId, param: tol.param, value: perturbed });
    }
    const value = measure({ components: clonedComponents, wires: doc.wires }, plugins, config.measurement);
    if (isFinite(value)) {
      results.push({ combo: comboArr, value, perturbations });
    }
  }

  // Sort by value ascending
  results.sort((a, b) => a.value - b.value);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function measure(
  doc: { components: CircuitComponent[]; wires: Wire[] },
  plugins: Map<string, ComponentPlugin>,
  measurement: MonteCarloConfig['measurement'],
): number {
  const dc = solveDC(doc.components, doc.wires, plugins);
  if (!dc) return NaN;
  if (measurement.type === 'voltage' && measurement.node) {
    const nm = buildNodeMap(doc.components, doc.wires, plugins);
    const node = nm.terminalNode.get(measurement.node);
    if (node === undefined) return NaN;
    return dc.nodeVoltage[node];
  } else if (measurement.type === 'current' && measurement.componentId) {
    // Measure the component's current via the engine's per-component current
    // computation (handles resistors, diodes, sources, transistors, ...).
    // The old fallback indexed branchCurrent by the component's ARRAY index,
    // which has no relation to the extra-variable indices the solver assigns.
    const comp = doc.components.find(c => c.id === measurement.componentId);
    if (!comp) return NaN;
    const compCurrents = computeComponentCurrents(doc.components, doc.wires, plugins, dc);
    const i = compCurrents.get(comp.id);
    return i !== undefined ? i : NaN;
  }
  return NaN;
}

function computeStats(values: number[]): MonteCarloStats {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, minIdx: 0, maxIdx: 0 };
  }
  let sum = 0;
  let min = values[0], max = values[0];
  let minIdx = 0, maxIdx = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    if (v < min) { min = v; minIdx = i; }
    if (v > max) { max = v; maxIdx = i; }
  }
  const mean = sum / values.length;
  let sumSq = 0;
  for (const v of values) sumSq += (v - mean) * (v - mean);
  const stddev = Math.sqrt(sumSq / values.length);
  return { mean, stddev, min, max, minIdx, maxIdx };
}

function buildHistogram(values: number[], nBins: number): { histogram: number[]; histogramEdges: number[] } {
  if (values.length === 0 || nBins < 1) {
    return { histogram: [], histogramEdges: [] };
  }
  let min = values[0], max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    // Degenerate: all values equal — put them all in one bin
    return { histogram: [values.length], histogramEdges: [min, min] };
  }
  const binWidth = (max - min) / nBins;
  const histogram = new Array(nBins).fill(0);
  const histogramEdges: number[] = new Array(nBins + 1);
  for (let i = 0; i <= nBins; i++) histogramEdges[i] = min + i * binWidth;
  for (const v of values) {
    let binIdx = Math.floor((v - min) / binWidth);
    if (binIdx >= nBins) binIdx = nBins - 1;  // clamp to last bin
    if (binIdx < 0) binIdx = 0;
    histogram[binIdx]++;
  }
  return { histogram, histogramEdges };
}
