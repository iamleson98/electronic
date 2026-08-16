// AC analysis — frequency-domain sweep wrapper.
// ─────────────────────────────────────────────────────────────────────────────
// This is a thin convenience wrapper around the full-featured `runAC()` in
// analysis.ts. It produces a simple `{ points, operatingPoint }` shape that
// the older UI code (Bode plot viewers, etc.) expects.
//
// For full AC analysis with complex traces, use `runAC()` from analysis.ts.

import { solveDC, buildNodeMap, getTerminalsForComponent } from './engine';
import { getPlugin } from './registry';
import type { CircuitComponent, Wire, ComponentPlugin } from './types';

export interface ACPoint {
  frequency: number;    // Hz
  magnitude: number;     // |V_out / V_in| in linear scale
  magnitudeDb: number;   // 20 * log10(magnitude)
  phase: number;         // phase in degrees
  real: number;          // real part of V_out
  imag: number;          // imaginary part of V_out
}

export interface ACAnalysisResult {
  points: ACPoint[];
  operatingPoint: { nodeVoltage: Float64Array; branchCurrent: Float64Array; time: number; state: any } | null;
  cutoffFrequency: number | null;
}

export interface ACAnalysisOptions {
  components: CircuitComponent[];
  wires: Wire[];
  /** Plugins map; if absent, derived from components */
  plugins?: Map<string, ComponentPlugin>;
  /** Start frequency (Hz) */
  fStart: number;
  /** Stop frequency (Hz) */
  fStop: number;
  /** Number of points */
  nPoints: number;
  /** Sweep type: 'dec' | 'lin' */
  sweep?: 'dec' | 'lin';
  /** Source component ID (must be a V or I source) */
  sourceId: string;
  /** AC stimulus amplitude (default 1) */
  acMag?: number;
  /** Output node — specified as "componentId:terminalId" */
  outputNode: string;
  /** Reference node — defaults to ground (0) */
  outputRef?: string;
}

/**
 * Generate logarithmically-spaced frequencies (decade sweep).
 * `a` and `b` are log10 of start/stop values, `n` is number of points.
 */
export function logspace(a: number, b: number, n: number): number[] {
  if (n < 1) return [];
  if (n === 1) return [Math.pow(10, b)];
  const step = (b - a) / (n - 1);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.pow(10, a + i * step);
  return out;
}

/**
 * Find the -3dB cutoff frequency in a list of AC points.
 * Returns null if no point crosses the -3dB threshold.
 */
export function findCutoffFrequency(points: ACPoint[]): number | null {
  if (points.length === 0) return null;
  // Find the maximum magnitude (DC gain in linear scale)
  let maxMag = 0;
  for (const p of points) if (p.magnitude > maxMag) maxMag = p.magnitude;
  if (maxMag <= 0) return null;
  const threshold = maxMag / Math.SQRT2;  // -3dB = 1/√2 of max
  // Find the first point where magnitude drops below threshold (high-pass)
  // or the last point above threshold before dropping (low-pass)
  // Simple heuristic: first crossing of the threshold.
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].magnitude;
    const curr = points[i].magnitude;
    if ((prev >= threshold && curr < threshold) || (prev < threshold && curr >= threshold)) {
      // Linear interpolation in log-frequency space
      const f1 = Math.log10(points[i - 1].frequency);
      const f2 = Math.log10(points[i].frequency);
      const m1 = (prev - threshold) / (prev - curr);
      const fc = Math.pow(10, f1 + m1 * (f2 - f1));
      return fc;
    }
  }
  return null;
}

/**
 * Run an AC small-signal analysis.
 *
 * Linearizes the circuit at the DC operating point, then for each frequency:
 *   1. Replaces L with impedance jωL
 *   2. Replaces C with impedance 1/(jωC)
 *   3. Replaces the AC source with a complex stimulus of magnitude acMag
 *   4. Solves the complex MNA system
 *   5. Reads out the output node voltage (real + imaginary)
 *
 * Returns magnitude, phase, and the cutoff frequency if found.
 */
export function runACAnalysis(opts: ACAnalysisOptions): ACAnalysisResult {
  const components = opts.components;
  const wires = opts.wires;
  const plugins = opts.plugins ?? pluginsFor(components);
  const fStart = opts.fStart;
  const fStop = opts.fStop;
  const nPoints = Math.max(2, opts.nPoints | 0);
  const sweep = opts.sweep ?? 'dec';

  // 1. Compute DC operating point
  const dc = solveDC(components, wires, plugins);
  if (!dc) {
    return { points: [], operatingPoint: null, cutoffFrequency: null };
  }
  const nodeMap = buildNodeMap(components, wires, plugins);

  // 2. Generate frequency points
  let freqs: number[];
  if (sweep === 'dec') {
    const logStart = Math.log10(Math.max(fStart, 1e-12));
    const logStop = Math.log10(Math.max(fStop, fStart * 2));
    freqs = logspace(logStart, logStop, nPoints);
  } else {
    // linear sweep
    const step = (fStop - fStart) / (nPoints - 1);
    freqs = new Array(nPoints);
    for (let i = 0; i < nPoints; i++) freqs[i] = fStart + i * step;
  }

  // 3. For each frequency, build a simplified complex linear system using
  //    ReferenceSolver-style stamping. We avoid pulling in the full complex
  //    MNA solver from analysis.ts to keep this module standalone.
  const points: ACPoint[] = [];
  const acMag = opts.acMag ?? 1;

  // Find output node index
  const outKey = opts.outputNode;
  const outNode = nodeMap.terminalNode.get(outKey);
  const refNode = opts.outputRef ? (nodeMap.terminalNode.get(opts.outputRef) ?? 0) : 0;

  if (outNode === undefined) {
    return { points: [], operatingPoint: dc, cutoffFrequency: null };
  }

  // Find source component
  const source = components.find(c => c.id === opts.sourceId);
  if (!source) {
    return { points: [], operatingPoint: dc, cutoffFrequency: null };
  }

  // For each frequency, compute the output voltage using a simplified
  // frequency-domain model: V_out = H(jω) * V_in, where H is the transfer
  // function formed by the R/L/C network.
  //
  // For a simple RC low-pass: V_out/V_in = 1 / (1 + jωRC)
  // For a simple RL high-pass: V_out/V_in = jωL / (R + jωL)
  // For an LC band-pass: more complex
  //
  // We use a generic approach: build the complex admittance matrix and solve.
  // This is done using a simplified version of the complex MNA solver.

  for (const freq of freqs) {
    const omega = 2 * Math.PI * freq;
    const vOut = computeOutputVoltage(components, wires, plugins, nodeMap, source, outNode, refNode, omega, acMag);
    const mag = Math.hypot(vOut.re, vOut.im);
    const phase = Math.atan2(vOut.im, vOut.re) * 180 / Math.PI;
    points.push({
      frequency: freq,
      magnitude: mag,
      magnitudeDb: 20 * Math.log10(Math.max(mag, 1e-30)),
      phase,
      real: vOut.re,
      imag: vOut.im,
    });
  }

  return {
    points,
    operatingPoint: dc,
    cutoffFrequency: findCutoffFrequency(points),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a simplified complex MNA at a single frequency
// ─────────────────────────────────────────────────────────────────────────────

function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  const m = new Map<string, ComponentPlugin>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) m.set(c.type, p);
  }
  return m;
}

interface Complex { re: number; im: number; }

function computeOutputVoltage(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  nodeMap: ReturnType<typeof buildNodeMap>,
  source: CircuitComponent,
  outNode: number,
  refNode: number,
  omega: number,
  acMag: number,
): Complex {
  // Simplified approach: build a complex nodal admittance matrix Y (n x n)
  // and current source vector I (n), then solve Y * V = I.
  //
  // For each component:
  //   - Resistor R: g = 1/R (real)
  //   - Capacitor C: g = jωC (imaginary, positive)
  //   - Inductor L: g = 1/(jωL) = -j/(ωL) (imaginary, negative)
  //   - Voltage source: replace with a Thevenin equivalent (voltage on its + node,
  //     referenced to its - node)
  //   - Current source: stamp I directly
  //
  // This is a simplified model that doesn't handle coupled sources, op-amps, or
  // non-linear devices. For complex circuits, use the full runAC() in analysis.ts.

  // Determine the number of nodes (excluding ground = 0)
  let maxNode = 0;
  for (const [, n] of nodeMap.terminalNode) {
    if (n > maxNode) maxNode = n;
  }
  const N = maxNode;
  if (N === 0) return { re: 0, im: 0 };

  // Build admittance matrix (interleaved complex: 2 * N * N entries)
  // Y[i][j] = Y[2*(i*N + j)] (real) + Y[2*(i*N + j) + 1] (imag)
  const Yre = new Float64Array(N * N);
  const Yim = new Float64Array(N * N);
  const Ire = new Float64Array(N);
  const Iim = new Float64Array(N);

  // For nodes connected to a fixed-voltage source, we need to "fix" them.
  // Simplest approach: use large conductance (1e12) to pin the node.
  // This is a "penalty" method — not numerically optimal but robust.
  const PIN_G = 1e12;

  for (const c of components) {
    const plugin = plugins.get(c.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(c, plugin, nodeMap);
    if (!terms || terms.length < 2) continue;

    const n1 = terms[0].nodeId;
    const n2 = terms[1].nodeId;
    // Convert to 0-indexed
    const i1 = n1 > 0 ? n1 - 1 : -1;
    const i2 = n2 > 0 ? n2 - 1 : -1;

    if (c.type === 'resistor') {
      const R = Number(c.parameters.resistance) || 1e-12;
      if (R === 0) continue;
      const g = 1 / R;
      stampY(Yre, Yim, i1, i2, N, g, 0);
    } else if (c.type === 'capacitor') {
      const C = Number(c.parameters.capacitance) || 0;
      const g = omega * C;  // imaginary: jωC
      stampY(Yre, Yim, i1, i2, N, 0, g);
    } else if (c.type === 'inductor') {
      const L = Number(c.parameters.inductance) || 1e-12;
      const g = -1 / (omega * L);  // -j/(ωL)
      stampY(Yre, Yim, i1, i2, N, 0, g);
    } else if (c.type === 'dcVoltage' || c.type === 'acVoltage') {
      // Pin the + terminal to the source voltage (penalty method)
      if (c.id === source.id) {
        const v = acMag;  // AC amplitude
        if (i1 >= 0) {
          Yre[i1 * N + i1] += PIN_G;
          Ire[i1] += PIN_G * v;
        }
      } else if (c.type === 'dcVoltage') {
        const v = Number(c.parameters.voltage) || 0;
        if (i1 >= 0) {
          Yre[i1 * N + i1] += PIN_G;
          Ire[i1] += PIN_G * v;
        }
      }
    } else if (c.type === 'currentSource') {
      const I = Number(c.parameters.current) || 0;
      if (c.id === source.id) {
        if (i1 >= 0) Ire[i1] += acMag;
        if (i2 >= 0) Ire[i2] -= acMag;
      } else {
        if (i1 >= 0) Ire[i1] += I;
        if (i2 >= 0) Ire[i2] -= I;
      }
    } else if (c.type === 'diode' || c.type === 'led') {
      // Approximate as a small-signal resistance at DC operating point.
      // For simplicity, treat as a 1kΩ resistor in AC.
      const g = 1e-3;
      stampY(Yre, Yim, i1, i2, N, g, 0);
    } else if (c.type === 'ground') {
      // Ground node is implicit (we don't include row/col 0)
    }
    // Other types (transistors, op-amps, etc.) are not handled in AC analysis
    // — they need the full runAC() in analysis.ts which linearizes them
    // around the operating point.
  }

  // Solve the complex linear system Y * V = I using Cramer's rule via Gaussian
  // elimination with partial pivoting. The matrix is small (N typically < 100).
  const Vre = new Float64Array(N);
  const Vim = new Float64Array(N);
  const ok = solveComplex(Yre, Yim, Ire, Iim, Vre, Vim, N);
  if (!ok) return { re: 0, im: 0 };

  // V_out = V[outNode] - V[refNode]
  const vOutIdx = outNode - 1;
  const vRefIdx = refNode > 0 ? refNode - 1 : -1;
  const outRe = Vre[vOutIdx] - (vRefIdx >= 0 ? Vre[vRefIdx] : 0);
  const outIm = Vim[vOutIdx] - (vRefIdx >= 0 ? Vim[vRefIdx] : 0);
  return { re: outRe, im: outIm };
}

function stampY(Yre: Float64Array, Yim: Float64Array, i1: number, i2: number, N: number, gre: number, gim: number): void {
  // Symmetric stamping: Y[i1][i1] += g, Y[i2][i2] += g, Y[i1][i2] -= g, Y[i2][i1] -= g
  if (i1 >= 0) {
    Yre[i1 * N + i1] += gre;
    Yim[i1 * N + i1] += gim;
  }
  if (i2 >= 0) {
    Yre[i2 * N + i2] += gre;
    Yim[i2 * N + i2] += gim;
  }
  if (i1 >= 0 && i2 >= 0) {
    Yre[i1 * N + i2] -= gre;
    Yim[i1 * N + i2] -= gim;
    Yre[i2 * N + i1] -= gre;
    Yim[i2 * N + i1] -= gim;
  }
}

// In-place Gaussian elimination for complex matrices (interleaved).
function solveComplex(Are: Float64Array, Aim: Float64Array, bre: Float64Array, bim: Float64Array, xre: Float64Array, xim: Float64Array, n: number): boolean {
  // Copy to working arrays
  const Wre = Float64Array.from(Are);
  const Wim = Float64Array.from(Aim);
  const yre = Float64Array.from(bre);
  const yim = Float64Array.from(bim);

  for (let k = 0; k < n; k++) {
    // Pivot: find row with max |A[i][k]|
    let maxRow = k;
    let maxMag = 0;
    for (let i = k; i < n; i++) {
      const mag = Wre[i * n + k] * Wre[i * n + k] + Wim[i * n + k] * Wim[i * n + k];
      if (mag > maxMag) { maxMag = mag; maxRow = i; }
    }
    if (maxMag < 1e-30) return false;  // singular

    // Swap rows k and maxRow
    if (maxRow !== k) {
      for (let j = 0; j < n; j++) {
        const tr = Wre[k * n + j]; Wre[k * n + j] = Wre[maxRow * n + j]; Wre[maxRow * n + j] = tr;
        const ti = Wim[k * n + j]; Wim[k * n + j] = Wim[maxRow * n + j]; Wim[maxRow * n + j] = ti;
      }
      const tr2 = yre[k]; yre[k] = yre[maxRow]; yre[maxRow] = tr2;
      const ti2 = yim[k]; yim[k] = yim[maxRow]; yim[maxRow] = ti2;
    }

    // Eliminate
    const pivotRe = Wre[k * n + k];
    const pivotIm = Wim[k * n + k];
    const pivotMag2 = pivotRe * pivotRe + pivotIm * pivotIm;
    if (pivotMag2 < 1e-30) return false;

    for (let i = k + 1; i < n; i++) {
      // factor = A[i][k] / A[k][k]
      const are = Wre[i * n + k];
      const aim = Wim[i * n + k];
      const factorRe = (are * pivotRe + aim * pivotIm) / pivotMag2;
      const factorIm = (aim * pivotRe - are * pivotIm) / pivotMag2;
      for (let j = k; j < n; j++) {
        Wre[i * n + j] -= factorRe * Wre[k * n + j] - factorIm * Wim[k * n + j];
        Wim[i * n + j] -= factorRe * Wim[k * n + j] + factorIm * Wre[k * n + j];
      }
      yre[i] -= factorRe * yre[k] - factorIm * yim[k];
      yim[i] -= factorRe * yim[k] + factorIm * yre[k];
    }
  }

  // Back-substitution
  for (let i = n - 1; i >= 0; i--) {
    let sumRe = yre[i];
    let sumIm = yim[i];
    for (let j = i + 1; j < n; j++) {
      sumRe -= Wre[i * n + j] * xre[j] - Wim[i * n + j] * xim[j];
      sumIm -= Wre[i * n + j] * xim[j] + Wim[i * n + j] * xre[j];
    }
    // x = sum / A[i][i]
    const dre = Wre[i * n + i];
    const dim = Wim[i * n + i];
    const dmag2 = dre * dre + dim * dim;
    if (dmag2 < 1e-30) return false;
    xre[i] = (sumRe * dre + sumIm * dim) / dmag2;
    xim[i] = (sumIm * dre - sumRe * dim) / dmag2;
  }
  return true;
}
