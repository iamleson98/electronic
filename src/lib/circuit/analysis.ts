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
import { runSens as _runSens, type SensConfig, computeACModeSensitivity } from './sensitivity';
import { stateKey } from './state-keys';

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
    } else if (comp.type === 'transLineLossless' || comp.type === 'transLineLossy') {
      // Uniform transmission line — exact 2-port Y-matrix. Previously the
      // tlines fell through this chain entirely (only gmin connected them).
      //   γ = sqrt((R+jωL)(G+jωC)),  Z0 = sqrt((R+jωL)/(G+jωC))
      //   Y11 = Y22 = 1/(Z0·tanh(γl)),  Y12 = Y21 = −1/(Z0·sinh(γl))
      // (lossless: R=G=0 → γ=jω√(LC), Z0=√(L/C), purely imaginary tanh/sinh)
      const a1 = terms.find((t) => t.terminalId === 'a1')?.nodeId ?? 0;
      const a2 = terms.find((t) => t.terminalId === 'a2')?.nodeId ?? 0;
      const b1 = terms.find((t) => t.terminalId === 'b1')?.nodeId ?? 0;
      const b2 = terms.find((t) => t.terminalId === 'b2')?.nodeId ?? 0;
      let R = 0, L = 0, G = 0, C = 0, len = 0;
      if (comp.type === 'transLineLossless') {
        const Z0 = Math.max(1e-3, comp.parameters.Z0 as number);
        const Td = Math.max(1e-15, comp.parameters.Td as number);
        // Z0 = √(L/C) and Td = len·√(LC). With C=1 and L=Z0² we get
        // √(LC) = Z0, so the electrical length must be len = Td/Z0 to make
        // the one-way delay exactly Td (the old len = Td made the delay
        // scale with Z0 — 50 Ω/1 ns lines delayed 50 ns).
        L = Z0 * Z0; C = 1; len = Td / Z0;
      } else {
        R = Math.max(0, comp.parameters.RperLen as number);
        L = Math.max(0, comp.parameters.LperLen as number);
        G = Math.max(0, comp.parameters.GperLen as number);
        C = Math.max(0, comp.parameters.CperLen as number);
        len = Math.max(0, comp.parameters.length as number);
      }
      // Series impedance z = R + jωL; shunt admittance y = G + jωC.
      const zRe = R, zIm = omega * L;
      const yRe = G, yIm = omega * C;
      // γ = sqrt(z·y)
      const zyRe = zRe * yRe - zIm * yIm;
      const zyIm = zRe * yIm + zIm * yRe;
      const gammaMag = Math.sqrt(Math.sqrt(zyRe * zyRe + zyIm * zyIm));
      const gammaArg = Math.atan2(zyIm, zyRe) / 2;
      const gRe = gammaMag * Math.cos(gammaArg);
      const gIm = gammaMag * Math.sin(gammaArg);
      // γl
      const glRe = gRe * len, glIm = gIm * len;
      // Z0 = sqrt(z/y)
      const zyDivDen = yRe * yRe + yIm * yIm;
      const zOverYRe = (zRe * yRe + zIm * yIm) / (zyDivDen || 1e-30);
      const zOverYIm = (zIm * yRe - zRe * yIm) / (zyDivDen || 1e-30);
      const z0Mag = Math.sqrt(Math.sqrt(zOverYRe * zOverYRe + zOverYIm * zOverYIm));
      const z0Arg = Math.atan2(zOverYIm, zOverYRe) / 2;
      const z0Re = z0Mag * Math.cos(z0Arg);
      const z0Im = z0Mag * Math.sin(z0Arg);
      // tanh(γl) and sinh(γl) for complex γl = x + jy:
      //   tanh(x+jy) = [sinh(2x) + j·sin(2y)] / [cosh(2x) + cos(2y)]
      //   sinh(x+jy) = sinh(x)cos(y) + j·cosh(x)sin(y)
      const twoX = 2 * glRe, twoY = 2 * glIm;
      const tanhDen = Math.cosh(twoX) + Math.cos(twoY);
      let tanhRe = 0, tanhIm = 0, sinhRe = 0, sinhIm = 0;
      if (Math.abs(tanhDen) > 1e-300) {
        tanhRe = Math.sinh(twoX) / tanhDen;
        tanhIm = Math.sin(twoY) / tanhDen;
      }
      sinhRe = Math.sinh(glRe) * Math.cos(glIm);
      sinhIm = Math.cosh(glRe) * Math.sin(glIm);
      // Y11 = 1/(Z0·tanh(γl)); Y12 = −1/(Z0·sinh(γl))
      const div = (nRe: number, nIm: number, dRe: number, dIm: number) => {
        const den = dRe * dRe + dIm * dIm;
        if (den < 1e-300) return { re: 0, im: 0 };
        return { re: (nRe * dRe + nIm * dIm) / den, im: (nIm * dRe - nRe * dIm) / den };
      };
      const z0TanhRe = z0Re * tanhRe - z0Im * tanhIm;
      const z0TanhIm = z0Re * tanhIm + z0Im * tanhRe;
      const z0SinhRe = z0Re * sinhRe - z0Im * sinhIm;
      const z0SinhIm = z0Re * sinhIm + z0Im * sinhRe;
      const y11 = div(1, 0, z0TanhRe, z0TanhIm);
      const y12 = div(-1, 0, z0SinhRe, z0SinhIm);
      // Stamp the 2-port admittances:
      //   I_a1 = Y11·V_a1 + Y12·V_b1   (referenced to a2/b2)
      //   I_b1 = Y21·V_a1 + Y22·V_b1
      // cStampVCCS drives g·(V(c)−V(d)) from n1 to n2 — exactly the Y12 term.
      const g11 = y11, g12 = y12;
      // Port A self term
      cStampConductance(sys, a1, a2, g11);
      // Port B self term
      cStampConductance(sys, b1, b2, g11); // Y22 = Y11 for a uniform line
      // Coupling: I_a1 += Y12·(V_b1 − V_b2); I_b1 += Y12·(V_a1 − V_a2)
      cStampVCCS(sys, a1, a2, b1, b2, g12);
      cStampVCCS(sys, b1, b2, a1, a2, g12); // Y21 = Y12 (reciprocal)
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
      const on = st[stateKey(comp.type, comp, a, k)] ?? vAK > vf;
      const g = on ? 1 / rOn : 1 / rOff;
      cStampConductance(sys, a, k, { re: g, im: 0 });
      // Junction capacitance Cjo if present.
      // SPICE depletion law: Cj = Cjo / (1 - V/Vj)^M — forward bias WIDENS
      // the capacitance (denominator shrinks). The old Cjo*denom^+M shrank it.
      const Cjo = (comp.parameters.Cjo as number) ?? 0;
      if (Cjo > 0) {
        const Vj = (comp.parameters.Vj as number) ?? 0.7;
        const M = (comp.parameters.M as number) ?? 0.5;
        const denom = Math.max(0.01, 1 - vAK / Vj);
        const cj = Cjo / Math.pow(denom, M);
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
      const ibKey = stateKey(isNpn ? 'npn' : 'pnp', comp, isNpn ? c : e, b, isNpn ? e : c) + '_ib';
      const ib = Math.abs((st[ibKey] as number) ?? 0);
      const hfe = (comp.parameters.hfe as number) ?? 100;
      const Ic = ib * hfe;
      const Vt = thermalVoltage(temp);
      const gm = Ic / Vt; // no cap — a 10 mA bias legitimately gives ~0.4 S
      const beta = Math.max(1, hfe);
      const gpi = gm > 0 ? gm / beta : 0; // input conductance 1/rπ (rπ = β/gm is a RESISTANCE)
      if (gm > 0) {
        // input conductance 1/rpi between base and emitter (the old code
        // stamped rπ OHMS as SIEMENS — an effective short across the b-e
        // junction that destroyed the AC input impedance)
        cStampConductance(sys, b, e, { re: gpi, im: 0 });
        // VCCS: ic = gm·vbe — polarity-symmetric Jacobian: +gm for BOTH NPN
        // and PNP (the PNP's reversed current direction cancels its reversed
        // junction polarity), so no sign here.
        cStampVCCS(sys, c, e, b, e, { re: gm, im: 0 });
      } else {
        // Off: keep the base weakly defined (1 MΩ), no channel
        cStampConductance(sys, b, e, { re: 1e-6, im: 0 });
      }
      // output conductance (Early effect) — polarity-symmetric: +go for both
      const Vaf = Math.abs((comp.parameters.Vaf as number) ?? 100);
      const go = Ic > 0 ? Ic / Math.max(1, Vaf) : 1e-12;
      cStampConductance(sys, c, e, { re: go, im: 0 });
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
      const inSat = vdsMag > vov && vov > 0;
      const Id = inSat
        ? 0.5 * Kp * vov * vov * (1 + lambda * vdsMag)          // saturation
        : Kp * (vov * vdsMag - 0.5 * vdsMag * vdsMag) * (1 + lambda * vdsMag); // linear
      // Saturation: gm = dId/dVgs = Kp*vov*(1+lambda*Vds) (channel-length
      // modulation scales the transconductance too). Triode: gm = Kp*vdsMag,
      // gds = dId/dVds = Kp*(vov - vdsMag) (plus the lambda slope term).
      const gm = vov > 0
        ? (inSat ? Kp * vov * (1 + lambda * vdsMag) : Kp * vdsMag * (1 + lambda * vdsMag))
        : 0;
      const gds = inSat
        ? (0.5 * Kp * vov * vov * lambda)
        : (vov > 0 ? Kp * Math.max(0, vov - vdsMag) * (1 + lambda * vdsMag) + Id * lambda / Math.max(1e-12, 1 + lambda * vdsMag) : 0);
      // Polarity-symmetric Jacobian: +gm/+gds for BOTH N and P channels.
      if (gm > 0) cStampVCCS(sys, d, s, g, s, { re: gm, im: 0 });
      cStampConductance(sys, d, s, { re: gds, im: 0 });
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

  // 3. Resolve the probe nodes ONCE (the node map is identical at every
  //    frequency — resolving it inside the loop rescanned every terminal
  //    per point, O(freqs × terminals)).
  const probeNodeMap = buildNodeMap(components, wires, plugins);
  const outputNodeName = config.outputNode;
  const outputRefName = config.outputRef;
  let vOutNode = 0;
  let vRefNode = 0;
  if (outputNodeName) {
    // look up node by net label / component terminal
    for (const [key, nodeId] of probeNodeMap.terminalNode) {
      if (key.endsWith(`:${outputNodeName}`) || key === outputNodeName) {
        vOutNode = nodeId;
        break;
      }
    }
    if (outputRefName) {
      for (const [key, nodeId] of probeNodeMap.terminalNode) {
        if (key.endsWith(`:${outputRefName}`) || key === outputRefName) {
          vRefNode = nodeId;
          break;
        }
      }
    }
  }

  // 4. For each frequency, build complex MNA and solve
  const traces: ComplexTrace[] = [];
  const outputXValues = new Float64Array(freqs.length);
  const outputYValues = new Float64Array(2 * freqs.length);

  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    // A 0 Hz point (linear sweep starting at 0) would make the inductor
    // admittance −1/(ωL) = −Infinity and poison the whole complex solve with
    // NaN. Clamp ω the same way the log-sweep path clamps its start decade.
    const omega = 2 * Math.PI * Math.max(f, 1e-12);
    const built = buildACSystemAtFrequency(components, wires, plugins, dcOp, omega, config, options.gmin, options.temp);
    if (!built) continue;
    const x = solveComplexMna(built.sys);
    if (!x) continue;
    outputXValues[i] = f;
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
  } else {
    // Log sweeps need a strictly positive start: fStart = 0 makes
    // decades/octaves = +Infinity and the loop below pushes f = 0 points
    // forever (unbounded memory, UI hang). Clamp to the same floor the
    // standalone AC wrapper uses; NaN/negative bounds yield an empty sweep.
    const fs = Math.max(fStart, 1e-12);
    if (Number.isFinite(fs) && Number.isFinite(fStop) && fStop >= fs) {
      const ratio = fStop / fs;
      const total = sweep === 'dec' ? Math.log10(ratio) : Math.log2(ratio);
      const totalPts = Math.max(1, Math.ceil(n * total));
      for (let i = 0; i <= totalPts; i++) {
        const f = fs * Math.pow(sweep === 'dec' ? 10 : 2, i / n);
        if (f <= fStop * 1.0001) freqs.push(f);
      }
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

  const buildSweepValues = (vStart: number, vStop: number, vStep: number): number[] => {
    const vals: number[] = [];
    const stepValid = Number.isFinite(vStep) && vStep !== 0;
    const directionValid = stepValid && (
      (vStep > 0 && vStop >= vStart) ||
      (vStep < 0 && vStop <= vStart)
    );
    if (directionValid) {
      for (let v = vStart; (vStep > 0 ? v <= vStop + 1e-9 : v >= vStop - 1e-9); v += vStep) {
        vals.push(v);
        if (vals.length > 100000) break; // hard safety cap
      }
    }
    return vals;
  };

  const vValues = buildSweepValues(config.vStart, config.vStop, config.vStep);

  // Build the nested sweep's source-value list (when requested). Multiple
  // source overrides combine independently into the cloned components.
  const nestedValues = config.nested
    ? buildSweepValues(config.nested.vStart, config.nested.vStop, config.nested.vStep)
    : [];

  const solveAt = (overrides: Record<string, number>): number => {
    const modifiedComponents = components.map((c) => {
      const v = overrides[c.id];
      if (v === undefined) return c;
      return { ...c, parameters: { ...c.parameters, voltage: v, current: v } };
    });
    const result = solveDC(modifiedComponents, wires, plugins, options.itl1);
    if (!result) return 0;
    if (!config.outputNode) return 0;
    const nodeMap = buildNodeMap(modifiedComponents, wires, plugins);
    for (const [key, nodeId] of nodeMap.terminalNode) {
      if (key.endsWith(`:${config.outputNode}`) || key === config.outputNode) {
        return result.nodeVoltage[nodeId] ?? 0;
      }
    }
    return 0;
  };

  // Nesting: emit one trace per nested source value (the outer source still
  // drives the x axis), matching ngspice's family-of-curves output.
  const traces: RealTrace[] = [];
  if (nestedValues.length > 1) {
    for (const nv of nestedValues) {
      const xValues = new Float64Array(vValues.length);
      const yValues = new Float64Array(vValues.length);
      for (let i = 0; i < vValues.length; i++) {
        xValues[i] = vValues[i];
        yValues[i] = solveAt({ [config.sourceId]: vValues[i], [config.nested!.sourceId]: nv });
      }
      traces.push({
        name: `V(${config.outputNode ?? 'out'}) @ ${config.nested!.sourceId}=${nv}`,
        xValues, yValues,
        xLabel: `${config.sourceId} (V or A)`,
        yLabel: 'Output (V)',
      });
    }
  } else {
    const xValues = new Float64Array(vValues.length);
    const yValues = new Float64Array(vValues.length);
    for (let i = 0; i < vValues.length; i++) {
      xValues[i] = vValues[i];
      yValues[i] = solveAt({ [config.sourceId]: vValues[i] });
    }
    traces.push({
      name: `V(${config.outputNode ?? 'out'})`,
      xValues, yValues,
      xLabel: `${config.sourceId} (V or A)`,
      yLabel: 'Output (V)',
    });
  }

  return {
    type: 'dc',
    traces,
    scalars: {},
    report: { converged: true, iterations: vValues.length * Math.max(1, nestedValues.length), finalDelta: 0, attempts: [] },
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

  // 1. Find DC operating point at the circuit's NATURAL bias (SPICE .tf is a
  // small-signal analysis: gain = dVout/dVin linearized at the OP, not the
  // large-signal Vout(1V)/1V. Forcing the input to 1V re-biased every diode /
  // BJT / MOS stage and gave wrong gain on any nonlinear circuit).
  const dcOp = solveDC(components, wires, plugins, options.itl1);
  if (!dcOp) {
    return { type: 'tf', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [] }, durationMs: performance.now() - start };
  }

  // 2. Small-signal gain from the complex AC system at ~0 Hz (capacitors
  // open, inductors short): drive the input source with a 1V/1A phasor and
  // read the complex output — exact dVout/dVin at the operating point.
  const nodeMap = buildNodeMap(components, wires, plugins);
  let vOutNode = 0;
  let vRefNode = 0;
  for (const [key, nodeId] of nodeMap.terminalNode) {
    if (key.endsWith(`:${config.outputNode}`) || key === config.outputNode) vOutNode = nodeId;
    if (config.outputRef && (key.endsWith(`:${config.outputRef}`) || key === config.outputRef)) vRefNode = nodeId;
  }
  // Near-DC phasor solve: f = 1e-12 Hz keeps every reactive admittance finite
  // (Yc = jwC -> 0, Yl = 1/jwL -> large = short) while exercising the exact
  // same small-signal linearization the Bode plot uses.
  let gain = 0;
  {
    const omega = 2 * Math.PI * 1e-12;
    const built = buildACSystemAtFrequency(
      components, wires, plugins, dcOp, omega,
      { type: 'ac', sweep: 'lin', nPoints: 1, fStart: 1e-12, fStop: 1e-12, sourceId: config.inputSourceId, acMag: 1, acPhase: 0 },
      options.gmin, options.temp,
    );
    if (built) {
      const x = solveComplexMna(built.sys);
      if (x) {
        const vOut = vOutNode > 0 ? x[vOutNode - 1] : { re: 0, im: 0 };
        const vRef = vRefNode > 0 ? x[vRefNode - 1] : { re: 0, im: 0 };
        gain = Math.hypot(vOut.re - vRef.re, vOut.im - vRef.im);
        // Preserve sign for inverting stages: the near-DC imaginary part is
        // ~0, so the real part carries the polarity.
        if ((vOut.re - vRef.re) < 0) gain = -gain;
      }
    }
  }

  // 3. Compute input resistance: Rin = V_in / I_in where I_in is the current
  //    drawn from the input source at its natural DC bias (no more forced 1V).
  //    For a voltage source, the branch current returned by the solver is the
  //    current flowing through it — that IS I_in. We read it directly from the
  //    per-component currents (computeComponentCurrents handles every device
  //    type: resistors, semiconductors, capacitors, inductors, ...), so this
  //    is exact for any circuit — the old resistor-only KCL approximation
  //    underestimated I_in and overestimated Rin on circuits with transistors.
  const inputComp = components.find((c) => c.id === config.inputSourceId);
  let rin = Infinity;
  if (inputComp) {
    const inputPlugin = plugins.get(inputComp.type);
    if (inputPlugin) {
      const inputTerms = getTerminalsForComponent(inputComp, inputPlugin, nodeMap);
      const pNode = inputTerms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const nNode = inputTerms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const vIn = (dcOp.nodeVoltage[pNode] ?? 0) - (dcOp.nodeVoltage[nNode] ?? 0);
      if (inputComp.type === 'dcVoltage' || inputComp.type === 'acVoltage') {
        const compCurrents = computeComponentCurrents(components, wires, plugins, dcOp);
        // Convention: current through the source from p → n (positive when the
        // source supplies power into the circuit from its + terminal).
        const iIn = compCurrents.get(inputComp.id) ?? 0;
        if (Math.abs(iIn) > 1e-15) {
          rin = Math.abs(vIn / iIn);
        }
      }
      // For a current source input, Rin is undefined (ideal current drive) → Infinity.
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
// Pole-zero analysis (.pz) — generalized eigenvalues of the descriptor
// state-space det(G + s·C) = 0 (true s-domain poles, units s⁻¹).
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

  // Pole-zero analysis: generalized eigenvalues of the descriptor
  // state-space det(G + s·C) = 0 — the TRUE s-domain poles (units s⁻¹).
  // G = DC conductance MNA (resistors, linearized semis, source rows),
  // C = dynamic MNA (capacitors as C, inductors as 1/L in the dual block).
  // Zeros = finite zeros of H(s) fitted from the exact AC response.
  const dcOp = solveDC(components, wires, plugins, options.itl1);
  if (!dcOp) {
    return { type: 'pz', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [] }, durationMs: performance.now() - start };
  }

  const { poles, method } = computeDescriptorPoles(components, wires, plugins, dcOp);

  // Zeros: finite zeros of the input→output transfer function H(s) = N(s)/D(s).
  //
  // Method: probe the exact small-signal AC system (same builder runAC uses)
  // on a log frequency sweep and look at |H(jω)| directly:
  //   - each pole contributes −20 dB/dec of roll-off above its corner,
  //   - each zero contributes +20 dB/dec of lift above its corner.
  // Starting from the DC gain, we walk up in frequency; whenever the
  // magnitude slope flattens by ≈+20 dB/dec relative to the all-pole
  // prediction (−20 dB/dec per pole corner passed), a zero corner is recorded
  // at that frequency. A pure RC lowpass therefore correctly reports NO zeros
  // (the old code negated half the poles and invented zeros that don't exist).
  const zeros = fitTransferZerosFromACResponse(
    components, wires, plugins, dcOp, config, poles, options,
  );

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
    report: { converged: true, iterations: poles.length, finalDelta: 0, attempts: [method === 'generalized' ? 'QZ-lite (G+sC)' : 'QR iteration'] },
    durationMs: performance.now() - start,
  };
}

/**
 * Descriptor poles via det(G + s·C) = 0.
 *
 * G = DC MNA conductance block (resistors, linearized semis, source rows —
 * stamped by the real plugins at the DC operating point).
 * C = dynamic block: +C for each capacitor (a↔b), built from the same
 * companion topology the transient engine uses; inductors contribute via
 * their flux state (L in the dual block → 1/L admittance slope).
 *
 * Solved with a QZ-lite iteration: simultaneous QR on (G, C) with Givens
 * rotations applied to both (Moler–Stewart without explicit Q/Z
 * accumulation — eigenvalues only, which is all PZ needs). Falls back to
 * plain eig(G) when C is all zeros (purely resistive + source network).
 */
function computeDescriptorPoles(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  dcOp: SimContext,
): { poles: { real: number; imag: number; freq: number; Q: number }[]; method: string } {
  // Descriptor det(G + s·C) = 0 built from FIRST PRINCIPLES (not by
  // re-stamping the transient companions — those carry dt-dependent
  // conductances G=C/dt and G=dt/L that corrupt the DC block):
  //   G = DC MNA: resistors as 1/R, capacitors OPEN, inductors SHORT
  //       (voltage-source branch rows), linearized semis at the DC op point.
  //   C = dynamic block: +C(a,a)+C(b,b)−C(a,b)−C(b,a) per capacitor;
  //       +L on the diagonal of each inductor's OWN branch row.
  // Inductor branch rows are tracked exactly: each inductor allocates one
  // extra unknown via sys.addExtra() (its branch current), so the row index
  // is known — no scanning G for "source-like" rows (the old scan matched
  // the VOLTAGE SOURCE row first and put L there, giving garbage poles).
  const nodeMap = buildNodeMap(components, wires, plugins);
  const numNodes = nodeMap.numNodes;
  let declaredExtras = 0;
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (plugin?.extraVars) declaredExtras += plugin.extraVars(comp.parameters);
  }
  const maxExtras = components.length * 4 + 8 + declaredExtras;
  const sys = createMnaSystem(numNodes - 1, maxExtras);
  sys.nextExtra = numNodes - 1;
  // Inductor branch rows, in stamp order (parallel with the G stamp loop).
  const inductorBranchRows: number[] = [];
  const inductorLs: number[] = [];
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin?.stamp) continue;
    const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
    try {
      if (comp.type === 'inductor') {
        // DC steady state: inductor = SHORT = voltage source with V = 0.
        // Its branch row is the flux state: L·dI/dt = Va − Vb.
        const a = terminals.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
        const b = terminals.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
        const row = sys.stampVoltageSource(a, b, 0);
        inductorBranchRows.push(row);
        inductorLs.push(Math.max(1e-12, comp.parameters.inductance as number));
      } else if (comp.type === 'capacitor') {
        // DC steady state: capacitor = OPEN — stamp nothing.
        continue;
      } else {
        plugin.stamp(comp.parameters, terminals, sys, dcOp, comp);
      }
    } catch {
      // a plugin that cannot stamp linearized DC is simply skipped
    }
  }
  const size = sys.nextExtra;
  const G: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      G[r][c] = sys.A[r * sys.size + c] ?? 0;
    }
  }
  // C block: capacitors in the nodal rows, inductors on their own rows.
  const C: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  let hasDynamics = inductorBranchRows.length > 0;
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    if (comp.type !== 'capacitor') continue;
    const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
    const idx = (nodeId: number) => (nodeId > 0 ? nodeId - 1 : -1);
    const cap = Math.max(1e-15, comp.parameters.capacitance as number);
    const a = idx(terminals.find((t) => t.terminalId === 'a')?.nodeId ?? 0);
    const b = idx(terminals.find((t) => t.terminalId === 'b')?.nodeId ?? 0);
    if (a >= 0) C[a][a] += cap;
    if (b >= 0) C[b][b] += cap;
    if (a >= 0 && b >= 0) { C[a][b] -= cap; C[b][a] -= cap; }
    hasDynamics = true;
  }
  for (let k = 0; k < inductorBranchRows.length; k++) {
    const row = inductorBranchRows[k];
    // SIGN: the branch row's G part is the DC short constraint Va − Vb = 0;
    // the dynamic version is Va − Vb = s·L·I, i.e. Va − Vb − s·L·I = 0, so
    // the C-block entry is −L. Positive L solves s²LC+sLG−1=0 (a right-half-
    // plane pole for a passive circuit — exactly the +31k seen in testing).
    if (row >= 0 && row < size) C[row][row] -= inductorLs[k];
  }
  const cNorm = C.flat().reduce((a, v) => a + Math.abs(v), 0);
  if (cNorm < 1e-24 || !hasDynamics) {
    // No dynamics: plain eig(G) (resistive network — poles at infinity).
    const eig = qrEigenvalues(G);
    return {
      poles: eig.filter((p) => Math.abs(p.im) < 1e-6 || p.im > 0).map((p) => ({
        real: p.re, imag: p.im,
        freq: Math.hypot(p.re, p.im) / (2 * Math.PI),
        Q: Math.abs(p.re) > 1e-9 ? Math.abs(p.im) / (2 * Math.abs(p.re)) : 0,
      })),
      method: 'static-eig',
    };
  }
  // Descriptor solve. The C block is NOT diagonal in general — floating
  // capacitors stamp off-diagonal entries (C[a][b] = C[b][a] = −C). The
  // Schur/reverse-pencil solver below handles that exactly and falls back to
  // QZ-lite only when the reduced G is singular. (QZ-lite's implicit
  // iterations mistake algebraic rows for dynamics on some topologies.)
  const eig = schurReducedPoles(G, C);
  const polesRaw = eig.length > 0 ? eig : qzEigenvalues(G, C);
  return {
    // Keep finite poles; drop huge algebraic artifacts (|s| > 1e12 — source
    // rows and gmin leaks, not dynamics) and unstable-sign mirrors.
    poles: polesRaw.filter((p) => Number.isFinite(p.re) && Math.hypot(p.re, p.im) < 1e12 && (Math.abs(p.im) < 1e-6 || p.im > 0)).map((p) => ({
      real: p.re, imag: p.im,
      freq: Math.hypot(p.re, p.im) / (2 * Math.PI),
      Q: Math.abs(p.re) > 1e-9 ? Math.abs(p.im) / (2 * Math.abs(p.re)) : 0,
    })),
    method: 'generalized',
  };
}

/**
 * Exact finite poles for det(G + s·C) = 0.
 *
 * The C block is NOT diagonal in general: a capacitor floating between two
 * non-ground nodes stamps C[a][a]+=C, C[b][b]+=C, C[a][b]−=C, C[b][a]−=C.
 * The previous implementation assumed diagonal C and divided rows by
 * diag(C) only — poles were ~2× wrong for ANY AC-coupled network (and the
 * no-algebraic branch contained a no-op ternary that computed the same
 * wrong quotient twice).
 *
 * Method:
 *   1. Split variables into dynamic (C row OR column nonzero) and algebraic
 *      (no dynamics anywhere). Eliminate the algebraic block via the Schur
 *      complement: Gred = G_dd − G_da·G_aa⁻¹·G_ad, Cred = C_dd. This is exact
 *      — the algebraic variables' columns in C are zero, so they carry no
 *      s-dependence and deflation preserves the finite pencil roots.
 *   2. Reverse-pencil transform on the reduced pencil det(Gred + s·Cred) = 0:
 *      for invertible Gred, det(I + s·Gred⁻¹·Cred) = 0, so the poles are
 *      s = −1/λ_i with λ_i = eig(Gred⁻¹·Cred). This handles off-diagonal AND
 *      singular Cred (a floating cap's common mode → λ = 0 → pole at
 *      infinity, filtered by the caller's |s| < 1e12 cap) and is identical
 *      to the old diagonal-scaled result when Cred happens to be diagonal.
 *   3. QZ-lite fallback when G_aa or Gred is singular.
 */
function schurReducedPoles(G: number[][], C: number[][]): { re: number; im: number }[] {
  const n = G.length;
  // Dynamic variables: C row OR column nonzero.
  const isDyn = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (Math.abs(C[i][j]) > 1e-300) { isDyn[i] = true; isDyn[j] = true; }
    }
  }
  const dyn: number[] = [];
  const alg: number[] = [];
  for (let i = 0; i < n; i++) (isDyn[i] ? dyn : alg).push(i);
  if (dyn.length === 0) return [];

  let Gred: number[][] = dyn.map((r) => dyn.map((c) => G[r][c]));
  const Cred: number[][] = dyn.map((r) => dyn.map((c) => C[r][c]));
  if (alg.length > 0) {
    const na = alg.length;
    // Gauss-Jordan on [G_aa | G_ad | I] → G_aa⁻¹·G_ad (and G_aa⁻¹ implicitly).
    const aug: number[][] = alg.map((r, i) => [
      ...alg.map((c) => G[r][c]),
      ...dyn.map((c) => G[r][c]),
      ...alg.map((_, k) => (k === i ? 1 : 0)),
    ]);
    let maxAbs = 0;
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) maxAbs = Math.max(maxAbs, Math.abs(aug[i][j]));
    for (let k = 0; k < na; k++) {
      let piv = k;
      let pivMag = 0;
      for (let i = k; i < na; i++) {
        const m = Math.abs(aug[i][k]);
        if (m > pivMag) { pivMag = m; piv = i; }
      }
      if (pivMag < 1e-13 * (1 + maxAbs)) return qzEigenvalues(G, C); // singular — QZ fallback
      if (piv !== k) [aug[k], aug[piv]] = [aug[piv], aug[k]];
      const d = aug[k][k];
      for (let j = 0; j < aug[k].length; j++) aug[k][j] /= d;
      for (let i = 0; i < na; i++) {
        if (i === k) continue;
        const f = aug[i][k];
        if (f === 0) continue;
        for (let j = 0; j < aug[i].length; j++) aug[i][j] -= f * aug[k][j];
      }
    }
    // Gred = G_dd − G_da·(G_aa⁻¹·G_ad); the solved block starts at col na.
    Gred = dyn.map((r) => dyn.map((c, j) => {
      let v = G[r][c];
      for (let k = 0; k < na; k++) v -= G[r][alg[k]] * aug[k][na + j];
      return v;
    }));
  }
  // Reverse pencil: M = Gred⁻¹·Cred → poles s = −1/λ(M).
  const Ginv = invertDense(Gred);
  if (!Ginv) return qzEigenvalues(G, C);
  const nd = dyn.length;
  const M: number[][] = Array.from({ length: nd }, () => new Array(nd).fill(0));
  for (let i = 0; i < nd; i++) {
    for (let j = 0; j < nd; j++) {
      let v = 0;
      for (let k = 0; k < nd; k++) v += Ginv[i][k] * Cred[k][j];
      M[i][j] = v;
    }
  }
  return qrEigenvalues(M)
    .filter((p) => {
      const mag2 = p.re * p.re + p.im * p.im;
      return mag2 > 1e-300; // λ = 0 → pole at infinity; caller's |s|<1e12 filter drops it
    })
    .map((p) => {
      const mag2 = p.re * p.re + p.im * p.im;
      // s = −1/λ = −conj(λ)/|λ|²
      return { re: -p.re / mag2, im: p.im / mag2 };
    });
}

/** Dense matrix inverse via Gauss-Jordan with partial pivoting.
 *  Returns null when (near-)singular. */
function invertDense(M: number[][]): number[][] | null {
  const n = M.length;
  const aug: number[][] = M.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, k) => (k === i ? 1 : 0)),
  ]);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) maxAbs = Math.max(maxAbs, Math.abs(M[i][j]));
  for (let k = 0; k < n; k++) {
    let piv = k;
    let pivMag = 0;
    for (let i = k; i < n; i++) {
      const m = Math.abs(aug[i][k]);
      if (m > pivMag) { pivMag = m; piv = i; }
    }
    if (pivMag < 1e-13 * (1 + maxAbs)) return null; // (near-)singular
    if (piv !== k) [aug[k], aug[piv]] = [aug[piv], aug[k]];
    const d = aug[k][k];
    for (let j = 0; j < aug[k].length; j++) aug[k][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = aug[i][k];
      if (f === 0) continue;
      for (let j = 0; j < aug[i].length; j++) aug[i][j] -= f * aug[k][j];
    }
  }
  return aug.map((row) => row.slice(n));
}

/**
 * QZ-lite generalized eigenvalues for det(G + s·C) = 0 (Moler–Stewart
 * Hessenberg-triangular reduction + implicit QZ steps, eigenvalues only).
 * Returns s-plane poles (finite eigenvalues; infinite ones filtered by the
 * caller via Number.isFinite).
 */
function qzEigenvalues(G: number[][], C: number[][]): { re: number; im: number }[] {
  const n = G.length;
  if (n === 0) return [];
  if (n === 1) {
    const c = C[0][0];
    if (Math.abs(c) < 1e-30) return [];
    return [{ re: -G[0][0] / c, im: 0 }];
  }
  // Work copies.
  const A: number[][] = G.map((row) => row.slice());
  const B: number[][] = C.map((row) => row.slice());
  // Reduce B to upper triangular (Givens from the left), apply to A.
  for (let k = 0; k < n - 1; k++) {
    for (let i = k + 1; i < n; i++) {
      const a = B[k][k];
      const b = B[i][k];
      if (Math.abs(b) < 1e-15 * (Math.abs(a) + 1)) continue;
      const r = Math.hypot(a, b);
      const cs = a / r;
      const sn = b / r;
      for (let j = k; j < n; j++) {
        const t1 = B[k][j];
        const t2 = B[i][j];
        B[k][j] = cs * t1 + sn * t2;
        B[i][j] = -sn * t1 + cs * t2;
      }
      for (let j = 0; j < n; j++) {
        const t1 = A[k][j];
        const t2 = A[i][j];
        A[k][j] = cs * t1 + sn * t2;
        A[i][j] = -sn * t1 + cs * t2;
      }
    }
  }
  // Reduce A to Hessenberg below the first subdiagonal (Givens left+right,
  // right rotations also applied to B to preserve eigenvalues).
  for (let k = 0; k < n - 2; k++) {
    for (let i = k + 2; i < n; i++) {
      const a = A[k + 1][k];
      const b = A[i][k];
      if (Math.abs(b) < 1e-15 * (Math.abs(a) + 1)) continue;
      const r = Math.hypot(a, b);
      const cs = a / r;
      const sn = b / r;
      for (let j = k; j < n; j++) {
        const t1 = A[k + 1][j];
        const t2 = A[i][j];
        A[k + 1][j] = cs * t1 + sn * t2;
        A[i][j] = -sn * t1 + cs * t2;
      }
      for (let j = k; j < n; j++) {
        const t1 = B[k + 1][j];
        const t2 = B[i][j];
        B[k + 1][j] = cs * t1 + sn * t2;
        B[i][j] = -sn * t1 + cs * t2;
      }
      for (let j = 0; j < n; j++) {
        const t1 = A[j][k + 1];
        const t2 = A[j][i];
        A[j][k + 1] = cs * t1 + sn * t2;
        A[j][i] = -sn * t1 + cs * t2;
      }
      for (let j = 0; j < n; j++) {
        const t1 = B[j][k + 1];
        const t2 = B[j][i];
        B[j][k + 1] = cs * t1 + sn * t2;
        B[j][i] = -sn * t1 + cs * t2;
      }
    }
  }
  // Implicit QZ iterations (double-shift on A, applied to both).
  const MAX_ITER = 60 * n;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let converged = true;
    for (let i = 1; i < n; i++) {
      const tol = 1e-12 * (Math.abs(A[i - 1][i - 1]) + Math.abs(A[i][i]));
      if (Math.abs(A[i][i - 1]) > tol && Math.abs(B[i][i]) > 1e-300) {
        converged = false;
        break;
      }
    }
    if (converged) break;
    // Wilkinson shift from trailing 2×2 of (A, B) — Rayleigh quotient shift.
    const nn = n - 1;
    const bnn = B[nn][nn];
    const mu = Math.abs(bnn) > 1e-300 ? A[nn][nn] / bnn : A[nn][nn];
    let x = A[0][0] - mu * B[0][0];
    let y = A[1][0] - mu * B[1][0];
    for (let k = 0; k < n - 1; k++) {
      const r = Math.hypot(x, y);
      if (r < 1e-300) {
        x = k + 1 < n ? A[k + 1][k] : 0;
        y = k + 2 < n ? A[k + 2][k] : 0;
        continue;
      }
      const cs = x / r;
      const sn = y / r;
      for (let j = Math.max(0, k - 1); j < n; j++) {
        const t1 = A[k][j];
        const t2 = A[k + 1][j];
        A[k][j] = cs * t1 + sn * t2;
        A[k + 1][j] = -sn * t1 + cs * t2;
      }
      for (let j = Math.max(0, k - 1); j < n; j++) {
        const t1 = B[k][j];
        const t2 = B[k + 1][j];
        B[k][j] = cs * t1 + sn * t2;
        B[k + 1][j] = -sn * t1 + cs * t2;
      }
      for (let i = 0; i < Math.min(k + 3, n); i++) {
        const t1 = A[i][k];
        const t2 = A[i][k + 1];
        A[i][k] = cs * t1 + sn * t2;
        A[i][k + 1] = -sn * t1 + cs * t2;
      }
      for (let i = 0; i < Math.min(k + 3, n); i++) {
        const t1 = B[i][k];
        const t2 = B[i][k + 1];
        B[i][k] = cs * t1 + sn * t2;
        B[i][k + 1] = -sn * t1 + cs * t2;
      }
      if (k + 2 < n) {
        x = A[k + 1][k];
        y = A[k + 2][k];
      }
    }
  }
  // Extract: 1×1 blocks → s directly (we solve det(G + sC) = 0, so the
  // diagonal ratio already IS s = −A/B — no further negation).
  const eigs: { re: number; im: number }[] = [];
  let i = 0;
  while (i < n) {
    if (i === n - 1 || Math.abs(A[i + 1][i]) < 1e-10 * (Math.abs(A[i][i]) + Math.abs(A[i + 1][i + 1]) + 1e-300)) {
      const b = B[i][i];
      if (Math.abs(b) < 1e-300) {
        // Infinite eigenvalue (algebraic constraint, e.g. source row) — skip.
        i++;
        continue;
      }
      eigs.push({ re: -A[i][i] / b, im: 0 });
      i++;
    } else {
      // 2×2 generalized block: det(G + sC) = c2 s² + c1 s + c0 = 0 directly.
      const a11 = A[i][i], a12 = A[i][i + 1], a21 = A[i + 1][i], a22 = A[i + 1][i + 1];
      const b11 = B[i][i], b12 = B[i][i + 1], b21 = B[i + 1][i], b22 = B[i + 1][i + 1];
      const c2 = b11 * b22 - b12 * b21;
      const c1 = a11 * b22 + b11 * a22 - a12 * b21 - b12 * a21;
      const c0 = a11 * a22 - a12 * a21;
      if (Math.abs(c2) < 1e-300) {
        if (Math.abs(c1) > 1e-300) {
          eigs.push({ re: -c0 / c1, im: 0 });
        }
      } else {
        const disc = c1 * c1 - 4 * c2 * c0;
        if (disc < 0) {
          const im = Math.sqrt(-disc) / (2 * c2);
          eigs.push({ re: -c1 / (2 * c2), im });
          eigs.push({ re: -c1 / (2 * c2), im: -im });
        } else {
          const s = Math.sqrt(disc);
          eigs.push({ re: (-c1 + s) / (2 * c2), im: 0 });
          eigs.push({ re: (-c1 - s) / (2 * c2), im: 0 });
        }
      }
      i += 2;
    }
  }
  return eigs;
}

/**
 * Locate finite transfer-function zeros from the exact AC magnitude response.
 *
 * Builds the small-signal AC system at each frequency of a log sweep
 * (1 Hz → 100 MHz, 40 pts/dec) with the first independent source as the
 * stimulus and measures |H(jω)| = |Vout/Vin|. Pole corners push the slope
 * down by −20 dB/dec each; a zero corner pushes it back up by +20 dB/dec.
 * Whenever the local slope rises ≥ +15 dB/dec above the all-pole prediction
 * (−20 dB/dec × poles-passed), a real zero is recorded at that frequency.
 * Returns an empty list when no such lift is observed (e.g. plain RC
 * lowpass) — correctly reporting "no finite zeros" instead of fabricating
 * values from the pole list.
 */
function fitTransferZerosFromACResponse(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  dcOp: SimContext,
  config: PZConfig,
  poles: { real: number; imag: number; freq: number; Q: number }[],
  options: SimOptions,
): { real: number; imag: number; freq: number; Q: number }[] {
  const zeros: { real: number; imag: number; freq: number; Q: number }[] = [];

  // Stimulus: first independent source; output from the PZ config.
  const stimulus = components.find((c) =>
    c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'currentSource' ||
    c.type === 'pulseSource' || c.type === 'sineSource' || c.type === 'acCurrent',
  );
  if (!stimulus) return zeros;

  const acConfig: ACAnalysisConfig = {
    type: 'ac', sweep: 'dec', nPoints: 40, fStart: 1, fStop: 1e8,
    sourceId: stimulus.id, acMag: 1, acPhase: 0,
    outputNode: config.outputNode,
  };

  const probeMap = buildNodeMap(components, wires, plugins);
  let vOutNode = 0;
  for (const [key, nodeId] of probeMap.terminalNode) {
    if (key.endsWith(`:${config.outputNode}`) || key === config.outputNode) { vOutNode = nodeId; break; }
  }
  if (vOutNode === 0) return zeros;

  const freqs: number[] = [];
  for (let d = 0; d < 8; d++) {
    for (let i = 0; i < 40; i++) freqs.push(Math.pow(10, d + i / 40));
  }
  const mags: number[] = [];
  for (const f of freqs) {
    const omega = 2 * Math.PI * f;
    const built = buildACSystemAtFrequency(components, wires, plugins, dcOp, omega, acConfig, options.gmin, options.temp);
    if (!built) { mags.push(NaN); continue; }
    const x = solveComplexMna(built.sys);
    if (!x) { mags.push(NaN); continue; }
    const v = x[vOutNode - 1] ?? { re: 0, im: 0 };
    mags.push(Math.hypot(v.re, v.im));
  }

  // Local slope in dB/dec via central differences on valid points.
  const slopes: number[] = new Array(freqs.length).fill(NaN);
  for (let i = 1; i < freqs.length - 1; i++) {
    const m0 = mags[i - 1], m1 = mags[i + 1];
    if (!(m0 > 0) || !(m1 > 0) || !Number.isFinite(m0) || !Number.isFinite(m1)) continue;
    const dDb = 20 * Math.log10(m1 / m0);
    const dDec = Math.log10(freqs[i + 1] / freqs[i - 1]);
    if (dDec > 0) slopes[i] = dDb / dDec;
  }

  // Pole corner frequencies (real-pole magnitude only — complex pairs share it).
  const poleCorners = poles
    .map((p) => Math.hypot(p.real, p.imag) / (2 * Math.PI))
    .filter((f) => Number.isFinite(f) && f > 0)
    .sort((a, b2) => a - b2);

  let lastZeroFreq = 0;
  for (let i = 1; i < freqs.length - 1; i++) {
    const s = slopes[i];
    if (!Number.isFinite(s)) continue;
    const f = freqs[i];
    const polesPassed = poleCorners.filter((pc) => pc < f).length;
    const expected = -20 * polesPassed;
    // A zero corner lifts the slope ≈ +20 dB/dec above the all-pole line.
    // Require a full octave of separation from the previous detection so a
    // single broad lift isn't counted twice.
    if (s - expected >= 15 && f > lastZeroFreq * 2) {
      lastZeroFreq = f;
      zeros.push({ real: -f * 2 * Math.PI, imag: 0, freq: f, Q: 0.5 });
    }
  }
  return zeros;
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

  // Compute DC operating point (bias currents for shot noise).
  const dcOp = solveDC(components, wires, plugins, options.itl1);
  if (!dcOp) {
    return { type: 'noise', traces: [], scalars: {}, report: { converged: false, iterations: 0, attempts: [] }, durationMs: performance.now() - start };
  }

  const kB = 1.380649e-23;
  const T = toKelvin(options.temp);
  const q = 1.602176634e-19;

  // Resolve output/reference node ids once.
  const nodeMap = buildNodeMap(components, wires, plugins);
  let vOutNode = 0;
  let vRefNode = 0;
  for (const [key, nodeId] of nodeMap.terminalNode) {
    if (key.endsWith(`:${config.outputNode}`) || key === config.outputNode) vOutNode = nodeId;
    if (config.outputRef && (key.endsWith(`:${config.outputRef}`) || key === config.outputRef)) vRefNode = nodeId;
  }

  // One-time bias-current lookup for shot-noise devices.
  const compCurrents = computeComponentCurrents(components, wires, plugins, dcOp);

  // Collect every noise source as an equivalent PARALLEL current source with a
  // uniform current-PSD density in A²/Hz. Referred to the output through the
  // (frequency-dependent) transfer impedance of the small-signal network.
  interface NoiseSource { n1: number; n2: number; psdA2Hz: number; }
  const sources: NoiseSource[] = [];

  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const nodeOf = (id: string) => terms.find((t) => t.terminalId === id)?.nodeId ?? 0;

    if (comp.type === 'resistor') {
      const R = Math.max(1e-9, comp.parameters.resistance as number);
      const a = nodeOf('a');
      const b = nodeOf('b');
      // Thermal noise as a Norton equivalent: i_n² = 4kT/R A²/Hz.
      if (a !== b) sources.push({ n1: a, n2: b, psdA2Hz: (4 * kB * T) / R });
    } else if (comp.type === 'diode' || comp.type === 'led') {
      const a = nodeOf('a');
      const k = nodeOf('k');
      const I = Math.abs(compCurrents.get(comp.id) ?? 0);
      if (a !== k && I > 0) sources.push({ n1: a, n2: k, psdA2Hz: 2 * q * I });
    } else if (comp.type === 'npn' || comp.type === 'pnp') {
      // Collector-emitter shot noise (base shot is much smaller and omitted).
      const c = nodeOf('c');
      const e = nodeOf('e');
      const Ic = Math.abs(compCurrents.get(comp.id) ?? 0);
      if (c !== e && Ic > 0) sources.push({ n1: c, n2: e, psdA2Hz: 2 * q * Ic });
    } else if (comp.type === 'nmos' || comp.type === 'pmos') {
      // Channel thermal noise approximated via the DC drain current
      // (I_D ≈ gm·V_ov/2 in saturation → 4kT·(2/3)·gm ≈ (8/3)·kT·gm).
      const d = nodeOf('d');
      const s = nodeOf('s');
      const Id = Math.abs(compCurrents.get(comp.id) ?? 0);
      // gm estimate from the same saturation law the AC linearization uses.
      const vth = (comp.parameters.vth as number) ?? 2.0;
      const Kp = (comp.parameters.kp as number) ?? 0.1;
      const gm = Id > 0 ? Math.sqrt(2 * Kp * Id) : 0;
      if (d !== s && gm > 0) sources.push({ n1: d, n2: s, psdA2Hz: (8 / 3) * kB * T * gm });
    }
  }

  const freqs = generateSweepFrequencies(config.sweep, config.nPoints, config.fStart, config.fStop);
  const xValues = new Float64Array(freqs.length);
  const yValues = new Float64Array(freqs.length);
  const inoiseValues = new Float64Array(freqs.length);
  const nfValues = new Float64Array(freqs.length);

  // A config whose no source carries AC excitation → the small-signal network
  // has zero independent stimulus, which is exactly what .noise wants (noise
  // sources are internal; the transfer function is computed per source).
  const acConfig = {
    type: 'ac' as const,
    sweep: config.sweep,
    nPoints: config.nPoints,
    fStart: config.fStart,
    fStop: config.fStop,
    sourceId: '__noise_none__',
    acMag: 0,
    acPhase: 0,
  };

  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    xValues[i] = f;
    const omega = 2 * Math.PI * Math.max(f, 1e-12);

    const built = buildACSystemAtFrequency(components, wires, plugins, dcOp, omega, acConfig, options.gmin, options.temp);
    if (!built) { yValues[i] = 0; continue; }
    const sys = built.sys;

    const nodeVoltage = (x: Complex[], nodeId: number): Complex =>
      nodeId > 0 ? (x[nodeId - 1] ?? { re: 0, im: 0 }) : { re: 0, im: 0 };

    let totalPowerV2Hz = 0;
    for (const src of sources) {
      // Inject a unit current source (1 A) between n1 and n2 and solve for the
      // output voltage → the transfer impedance Z (V/A) from that noise source
      // to the output. solveComplexMna copies A and z, so we can safely mutate
      // sys.z in place and restore it afterwards.
      const savedZ = Float64Array.from(sys.z);
      sys.z.fill(0);
      if (src.n1 > 0) sys.z[2 * (src.n1 - 1)] -= 1;
      if (src.n2 > 0) sys.z[2 * (src.n2 - 1)] += 1;
      const x = solveComplexMna(sys);
      sys.z.set(savedZ);
      if (!x) continue;
      const vOut = nodeVoltage(x, vOutNode);
      const vRef = nodeVoltage(x, vRefNode);
      const re = vOut.re - vRef.re;
      const im = vOut.im - vRef.im;
      const transferMag2 = re * re + im * im;
      totalPowerV2Hz += src.psdA2Hz * transferMag2;
    }

    yValues[i] = Math.sqrt(totalPowerV2Hz);
  }

  // Input-referred noise + noise figure: divide the output noise by the
  // small-signal gain |H| from the input source to the output at each
  // frequency (NF = 10·log10(1 + Vn,in²/Vn,source²), source = 50Ω thermal).
  {
    const gainConfig = {
      type: 'ac' as const,
      sweep: config.sweep,
      nPoints: config.nPoints,
      fStart: config.fStart,
      fStop: config.fStop,
      sourceId: config.inputSourceId,
      acMag: 1,
      acPhase: 0,
    };
    const kB = 1.380649e-23;
    const T = toKelvin(options.temp);
    const rSrc = 50;
    const vnSrc2 = 4 * kB * T * rSrc; // V²/Hz of a 50Ω source
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      const omega = 2 * Math.PI * Math.max(f, 1e-12);
      const built = buildACSystemAtFrequency(components, wires, plugins, dcOp, omega, gainConfig, options.gmin, options.temp);
      if (!built) { inoiseValues[i] = 0; nfValues[i] = 0; continue; }
      const x = solveComplexMna(built.sys);
      if (!x) { inoiseValues[i] = 0; nfValues[i] = 0; continue; }
      const vOut = vAt(x, vOutNode);
      const vRef = vAt(x, vRefNode);
      const gainMag = Math.hypot(vOut.re - vRef.re, vOut.im - vRef.im);
      const vOutNoise = yValues[i];
      const vInNoise = gainMag > 1e-30 ? vOutNoise / gainMag : 0;
      inoiseValues[i] = vInNoise;
      nfValues[i] = vInNoise > 0 ? 10 * Math.log10(1 + (vInNoise * vInNoise) / vnSrc2) : 0;
    }
  }
  function vAt(x: Complex[], nodeId: number): Complex {
    return nodeId > 0 ? (x[nodeId - 1] ?? { re: 0, im: 0 }) : { re: 0, im: 0 };
  }

  // Integrated output noise over the sweep band (trapezoidal on V²/Hz).
  let integratedV2 = 0;
  for (let i = 1; i < freqs.length; i++) {
    const df = freqs[i] - freqs[i - 1];
    integratedV2 += 0.5 * (yValues[i] * yValues[i] + yValues[i - 1] * yValues[i - 1]) * df;
  }

  return {
    type: 'noise',
    traces: [
      { name: 'onoise', xValues, yValues, xLabel: 'Frequency (Hz)', yLabel: 'Noise (V/√Hz)' },
      { name: 'inoise', xValues, yValues: inoiseValues, xLabel: 'Frequency (Hz)', yLabel: 'Noise (V/√Hz)' },
      { name: 'nf', xValues, yValues: nfValues, xLabel: 'Frequency (Hz)', yLabel: 'NF (dB)' },
    ],
    scalars: { integratedNoise_Vrms: Math.sqrt(Math.max(0, integratedV2)) },
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
    // period, which contains the startup settling transient). Hann window +
    // coherent-gain normalization (same as runFour) so leakage does not
    // inflate the harmonic bins; THD sums ALL harmonics >= 2 (SPICE .disto).
    const settleIdx = samples.findIndex(s => s.t >= period);
    const kept = settleIdx > 0 ? samples.slice(settleIdx) : samples;
    if (kept.length < 16) continue;
    const fftSize = nextPow2(kept.length);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const wsum = (kept.length - 1) / 2; // Hann coherent gain
    for (let n = 0; n < kept.length; n++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * n / (kept.length - 1)));
      re[n] = kept[n].v * w;
    }
    fft(re, im);
    // Find magnitude at f1, 2*f1, ... (bin = f·fftSize·dt)
    const binF1 = Math.round(f1 * fftSize * tStep);
    const magAt = (mult: number) => {
      const bin = binF1 * mult;
      return bin < fftSize / 2 ? Math.hypot(re[bin], im[bin]) * 2 / wsum : 0;
    };
    const mag1 = magAt(1);
    const mag2 = magAt(2);
    const mag3 = magAt(3);
    hd2[i] = mag1 > 1e-9 ? mag2 / mag1 : 0;
    hd3[i] = mag1 > 1e-9 ? mag3 / mag1 : 0;
    // Full THD over every harmonic bin that fits below Nyquist.
    let sumSq = 0;
    for (let h = 2; h * binF1 < fftSize / 2; h++) {
      const m = magAt(h);
      sumSq += m * m;
    }
    thd[i] = mag1 > 1e-9 ? Math.sqrt(sumSq) / mag1 : 0;
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

  // UIC (.tran UIC): skip the DC operating point entirely and start the
  // transient from a FRESH state — component initialV/initialI parameters
  // and .IC node voltages become the t=0 conditions. (Previously prev was
  // ALWAYS seeded from solveDC, so hasPrev was true on the first step and
  // the .IC block in simulateStep could never fire — UIC was dead config.)
  if (options.uic) {
    // Seed an empty prev: simulateStep's cold-start path applies .IC to the
    // node voltages and every reactive element reads its initial* parameter.
    const prevUic: SimContext = {
      nodeVoltage: new Float64Array(0),
      branchCurrent: new Float64Array(0),
      time: 0,
      state: {},
      dt: tStep,
    };
    return runTranSteps(components, wires, plugins, config, options, prevUic, start, true);
  }

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
  return runTranSteps(components, wires, plugins, config, options, prev, start, false);
}

/** Shared transient stepping loop for runTran (DC-seeded and UIC variants). */
function runTranSteps(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  config: TranConfig,
  options: SimOptions,
  prevSeed: SimContext,
  start: number,
  uic: boolean,
): AnalysisResult {
  const { tStop, tStep, probes = [] } = config;

  // Collect traces: one per probe node
  const nm = buildNodeMap(components, wires, plugins);
  const probeNodes = probes.map(p => ({
    key: p,
    nodeId: nm.terminalNode.get(p) ?? 0,
  }));
  const timeValues: number[] = [];
  const traceData: Record<string, number[]> = {};
  for (const pn of probeNodes) traceData[pn.key] = [];

  let simState = prevSeed;
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
      // .IC applies on the cold-start first step (UIC mode only).
      initialConditions: uic ? options.initialConditions : undefined,
      nodeSets: options.nodeSets,
      // Integration method from SimOptions — the DC operating point (when
      // used) always runs backward Euler (standard SPICE behavior),
      // transient steps honor the user's trap/gear choice.
      method: options.method,
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

  // Trapezoidal ringing guard telemetry: the per-element detectors in
  // passive.ts count every suppression in state.__global.__trapRingCount.
  // Surface it on the report (and scalars) so users can see when the guard
  // engaged — a large count hints the timestep is too coarse for the circuit.
  const trapRingCount = options.method === 'trap'
    ? ((simState.state as any)?.__global?.__trapRingCount as number | undefined) ?? 0
    : undefined;

  return {
    type: 'tran',
    traces,
    scalars: {
      steps: stepCount,
      finalTime: simState.time,
      ...(trapRingCount !== undefined ? { trapRings: trapRingCount } : {}),
    },
    report: {
      converged: true,
      iterations: stepCount,
      finalDelta: 0,
      attempts: [],
      ...(trapRingCount !== undefined ? { trapRings: trapRingCount } : {}),
    },
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
