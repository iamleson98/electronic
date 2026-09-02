// AC analysis — frequency-domain sweep wrapper.
// ─────────────────────────────────────────────────────────────────────────────
// A self-contained simplified complex-nodal AC solver producing the
// `{ points, operatingPoint }` shape the older UI code (Bode viewers) and
// the AI analysis tools expect. It linearizes diodes/BJTs at the DC
// operating point and stamps R/C/L/small-signal devices directly into a
// nodal admittance matrix (voltage sources via a large-conductance pin).
// The full complex-MNA engine with transmission lines, MOSFET small-signal
// models and complex traces is `runAC()` in analysis.ts.

import { solveDC, buildNodeMap, getTerminalsForComponent, computeComponentCurrents } from './engine';
import { getPlugin } from './registry';
import { stateKey } from './state-keys';
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
  // Per-component DC currents — used to bias the BJT small-signal model at
  // the real operating point instead of a hardcoded 1 mA.
  const dcCurrents = computeComponentCurrents(components, wires, plugins, dc);

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
    // Clamp ω away from zero: a linear sweep starting at 0 Hz would make the
    // inductor admittance −1/(ωL) = −Infinity and poison the solve with NaN
    // (the log-sweep path already clamps its start frequency the same way).
    const omega = 2 * Math.PI * Math.max(freq, 1e-12);
    const vOut = computeOutputVoltage(components, wires, plugins, nodeMap, source, outNode, refNode, omega, acMag, dc, dcCurrents);
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
  dcOp?: { nodeVoltage: Float64Array; state: any } | null,
  dcCurrents?: Map<string, number>,
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
    } else if (c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'pulseSource') {
      // Voltage sources in small-signal phasor analysis:
      //   stimulus      → pin V(+) − V(−) to the AC phasor acMag·e^{jφ}
      //   everything else → 0V = AC SHORT (this is why supply rails are AC
      //     ground in SPICE). The old code pinned non-stimulus DC sources to
      //     their DC VALUE — injecting a spurious second stimulus into every
      //     biased circuit (an RC low-pass read 6× too high), and left
      //     non-stimulus AC sources completely unstamped (an AC open).
      //     pulseSource belongs here too: a pulse train's small-signal value
      //     is 0 V = short — leaving it unstamped made every node behind it
      //     float on gmin alone.
      let vRe = 0, vIm = 0;
      if (c.id === source.id) {
        const phaseDeg = Number(c.parameters?.phase) || 0;
        const phaseRad = (phaseDeg * Math.PI) / 180;
        vRe = acMag * Math.cos(phaseRad);
        vIm = acMag * Math.sin(phaseRad);
      }
      // Pin the DIFFERENCE V(i1) − V(i2) to the phasor (penalty method).
      // For a grounded − terminal this reduces to pinning V(i1) alone.
      if (i1 >= 0) {
        Yre[i1 * N + i1] += PIN_G;
        Ire[i1] += PIN_G * vRe;
        Iim[i1] += PIN_G * vIm;
        if (i2 >= 0) {
          Yre[i1 * N + i2] -= PIN_G;
          Yim[i1 * N + i2] -= 0;
        }
      }
      if (i2 >= 0) {
        Yre[i2 * N + i2] += PIN_G;
        Ire[i2] -= PIN_G * vRe;
        Iim[i2] -= PIN_G * vIm;
        if (i1 >= 0) {
          Yre[i2 * N + i1] -= PIN_G;
        }
      }
    } else if (c.type === 'currentSource') {
      // SPICE convention (matches the engine's stampCurrentSource(p, n, i)):
      // current flows THROUGH the source from + to −, i.e. it is DRAWN OUT of
      // the + node and INJECTED into the − node. The old stamp injected into
      // + — a 180° phase error in every current-source-stimulated transfer
      // function.
      // Superposition: non-stimulus sources contribute ZERO AC current (a DC
      // current source is an AC open for signals). The old code injected the
      // non-stimulus source's DC value as a phasor — a spurious second
      // stimulus that inflated every transfer function of any circuit
      // containing one (same bug class as the DC-supply pinning fixed above).
      let iRe = 0, iIm = 0;
      if (c.id === source.id) {
        const phaseDeg = Number(c.parameters?.phase) || 0;
        const phaseRad = (phaseDeg * Math.PI) / 180;
        iRe = acMag * Math.cos(phaseRad);
        iIm = acMag * Math.sin(phaseRad);
      }
      if (iRe !== 0 || iIm !== 0) {
        if (i1 >= 0) { Ire[i1] -= iRe; Iim[i1] -= iIm; }
        if (i2 >= 0) { Ire[i2] += iRe; Iim[i2] += iIm; }
      }
    } else if (c.type === 'diode' || c.type === 'led') {
      // Linearize at the ACTUAL DC operating point, consistent with the
      // engine's piecewise model (forward = 1/onR, reverse = 1/offR) and with
      // runAC() in analysis.ts. The old fixed 1 kΩ was ~4 decades off in
      // reverse (leakage read as a 1 mA/V path) and off by the real dynamic
      // resistance in forward — the Bode plot silently changed character
      // depending on which solver path produced it.
      const a = terms.find(t => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find(t => t.terminalId === 'k')?.nodeId ?? 0;
      const vAK = dcOp ? dcOp.nodeVoltage[a] - dcOp.nodeVoltage[k] : 0;
      const vf = (c.parameters.forwardV as number) ?? (c.type === 'led' ? 2.0 : 0.7);
      const rOn = c.type === 'led'
        ? Math.max(0.01, (c.parameters.seriesR as number) ?? 220)
        : Math.max(0.001, (c.parameters.onR as number) ?? 1);
      const rOff = Math.max(1e3, (c.parameters.offR as number) ?? 1e7);
      const st = dcOp?.state?.__global ?? {};
      const on = st[stateKey(c.type, c, a, k)] ?? vAK > vf;
      const ai = a > 0 ? a - 1 : -1;
      const ki = k > 0 ? k - 1 : -1;
      stampY(Yre, Yim, ai, ki, N, on ? 1 / rOn : 1 / rOff, 0);
    } else if (c.type === 'ground') {
      // Ground node is implicit (we don't include row/col 0)
    } else if (c.type === 'npn' || c.type === 'pnp') {
      // BJT hybrid-pi model, biased at the ACTUAL DC operating point:
      //   gm = I_C / V_T, r_pi = β / gm, (r_o ignored)
      // I_C comes from computeComponentCurrents at the DC solution — the old
      // code hardcoded a 1 mA bias regardless of the real operating point.
      const V_T = 0.02585; // thermal voltage at 300K
      const beta = (c.parameters.hfe as number) ?? 100;
      const cTerm = terms.find(t => t.terminalId === 'c');
      const bTerm = terms.find(t => t.terminalId === 'b');
      const eTerm = terms.find(t => t.terminalId === 'e');
      if (!cTerm || !bTerm || !eTerm) continue;
      const cNodeIdx = cTerm.nodeId > 0 ? cTerm.nodeId - 1 : -1;
      const bNodeIdx = bTerm.nodeId > 0 ? bTerm.nodeId - 1 : -1;
      const eNodeIdx = eTerm.nodeId > 0 ? eTerm.nodeId - 1 : -1;
      const iC = Math.abs(dcCurrents?.get(c.id) ?? 0);
      if (iC <= 1e-12) {
        // Device is off: 1 MΩ b-e, no controlled source
        stampY(Yre, Yim, bNodeIdx, eNodeIdx, N, 1e-6, 0);
        continue;
      }
      const gm = Math.max(iC / V_T, 1e-9);
      const r_pi = beta / gm;
      // r_pi between base and emitter
      stampY(Yre, Yim, bNodeIdx, eNodeIdx, N, 1 / r_pi, 0);
      // VCCS: i_c = gm * (v_b - v_e), current flows c→e (NPN) or e→c (PNP).
      // A VCCS is NON-RECIPROCAL: only these four terms belong in the matrix.
      // (The old stamp added transposed entries to force matrix symmetry —
      //  a phantom reciprocal coupling with no physical meaning.)
      const g = (c.type === 'npn' ? 1 : -1) * gm;
      if (cNodeIdx >= 0 && bNodeIdx >= 0) Yre[cNodeIdx * N + bNodeIdx] += g;
      if (cNodeIdx >= 0 && eNodeIdx >= 0) Yre[cNodeIdx * N + eNodeIdx] -= g;
      if (eNodeIdx >= 0 && bNodeIdx >= 0) Yre[eNodeIdx * N + bNodeIdx] -= g;
      if (eNodeIdx >= 0) Yre[eNodeIdx * N + eNodeIdx] += g;
      void dcOp;
    } else if (c.type === 'opamp' || c.type === 'lm358' || c.type === 'lm741' || c.type === 'tl072') {
      // Op-amp small-signal model (Thevenin output):
      //   i_leaving(out) = (v_out − A·(v_+ − v_−)) / r_out
      // => Y[out][out] += 1/r_out, Y[out][in+] −= A/r_out, Y[out][in−] += A/r_out.
      // (The old stamp flipped the controlled-source signs — modeling an
      //  op-amp with INVERTED open-loop polarity: comparators came out 180°
      //  wrong and open-loop phase was flipped.)
      const A = (c.parameters.gain as number) ?? 1e5;
      const rIn = 1e6;
      const rOut = 100;
      const inPlus = terms.find(t => t.terminalId === 'in+')?.nodeId ?? 0;
      const inMinus = terms.find(t => t.terminalId === 'in-')?.nodeId ?? 0;
      const outT = terms.find(t => t.terminalId === 'out')?.nodeId ?? 0;
      const inPlusIdx = inPlus > 0 ? inPlus - 1 : -1;
      const inMinusIdx = inMinus > 0 ? inMinus - 1 : -1;
      const outIdx = outT > 0 ? outT - 1 : -1;
      // Input resistance between in+ and in-
      stampY(Yre, Yim, inPlusIdx, inMinusIdx, N, 1 / rIn, 0);
      const g = A / rOut;
      if (outIdx >= 0) Yre[outIdx * N + outIdx] += 1 / rOut;
      if (outIdx >= 0 && inPlusIdx >= 0) Yre[outIdx * N + inPlusIdx] -= g;
      if (outIdx >= 0 && inMinusIdx >= 0) Yre[outIdx * N + inMinusIdx] += g;
    }
    // Other types are not handled — they contribute nothing to the AC matrix
  }

  // ── Floating-node guard (gmin) ────────────────────────────────────────────
  // A node whose ONLY members are unwired annotation pins (netLabel's spare
  // terminal, an unconnected IC pin, …) gets an all-zero row/column in Y →
  // the complex solve is SINGULAR and every frequency returns garbage
  // (-600 dB flat). Real circuits don't care: 1e-12 S is 1 TΩ to ground.
  const GMIN = 1e-12;
  for (let i = 0; i < N; i++) {
    if (Yre[i * N + i] === 0 && Yim[i * N + i] === 0) {
      Yre[i * N + i] += GMIN;
    }
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
