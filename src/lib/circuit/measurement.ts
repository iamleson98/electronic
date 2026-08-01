// Measurement (.meas) post-processor and waveform math utilities.
//
// Supports:
//   - .meas dc|ac|tran <name> FIND <expr> WHEN <expr> [TD=...] [CROSS=...] [RISE=...]
//   - .meas ... AVG|MIN|MAX|PP|RMS <expr> [FROM=t1 TO=t2]
//   - .meas ... TRIG <expr> VAL=<v> [TD=...] TARG <expr> VAL=<v> [TD=...]
//   - .meas ... PARAM <expr>
//
// Also: waveform math expressions, FFT, cursors, XY mode.

import type { RealTrace, ComplexTrace } from './analysis';

// re-export RealTrace and ComplexTrace so consumers can import them from here
export type { RealTrace, ComplexTrace } from './analysis';
import { runFour } from './analysis';

// ─────────────────────────────────────────────────────────────────────────────
// .meas parser
// ─────────────────────────────────────────────────────────────────────────────

export type MeasType = 'FIND' | 'WHEN' | 'AVG' | 'MIN' | 'MAX' | 'PP' | 'RMS' | 'DELAY' | 'PARAM';
export type MeasMode = 'dc' | 'ac' | 'tran';

export interface MeasCommand {
  mode: MeasMode;
  name: string;
  type: MeasType;
  /** main expression (e.g., V(out)) */
  expr: string;
  /** for FIND...WHEN: the WHEN expression */
  whenExpr?: string;
  /** for AVG/RMS: time range */
  fromTime?: number;
  toTime?: number;
  /** for TRIG/TARG mode: trigger expression and value */
  trigExpr?: string;
  trigVal?: number;
  targExpr?: string;
  targVal?: number;
  /** for cross/rise/fall counts */
  cross?: number;
  rise?: number;
  fall?: number;
}

export interface MeasResult {
  name: string;
  value: number;
  unit?: string;
}

/**
 * Parse a .meas line:
 *   .meas tran vout_avg AVG V(out) FROM=0 TO=1ms
 *   .meas tran t_delay WHEN V(out)=2.5
 *   .meas dc gain FIND V(out) WHEN V(in)=1
 *   .meas tran t_prop TRIG V(in)=2.5 TARG V(out)=2.5
 */
export function parseMeasLine(line: string): MeasCommand | null {
  // strip leading ".meas " and mode
  const m = line.match(/^\.meas\s+(dc|ac|tran)\s+(\w+)\s+(FIND|WHEN|AVG|MIN|MAX|PP|RMS|DELAY|PARAM)\s+(.+)$/i);
  if (!m) return null;
  const mode = m[1].toLowerCase() as MeasMode;
  const name = m[2];
  const type = m[3].toUpperCase() as MeasType;
  const rest = m[4];

  const cmd: MeasCommand = { mode, name, type, expr: rest };

  // Extract WHEN clause (for FIND...WHEN)
  const whenMatch = rest.match(/^(.+?)\s+WHEN\s+(.+)$/i);
  if (whenMatch) {
    cmd.expr = whenMatch[1].trim();
    cmd.whenExpr = whenMatch[2].trim();
  }

  // Extract FROM/TO
  const fromMatch = rest.match(/FROM\s*=\s*([\d.]+[munp]?)/i);
  if (fromMatch) cmd.fromTime = parseNumberWithSuffix(fromMatch[1]);
  const toMatch = rest.match(/TO\s*=\s*([\d.]+[munp]?)/i);
  if (toMatch) cmd.toTime = parseNumberWithSuffix(toMatch[1]);

  // Extract TRIG/TARG
  const trigMatch = rest.match(/TRIG\s+(\S+)\s*=\s*([\d.+-]+)/i);
  if (trigMatch) { cmd.trigExpr = trigMatch[1]; cmd.trigVal = parseFloat(trigMatch[2]); }
  const targMatch = rest.match(/TARG\s+(\S+)\s*=\s*([\d.+-]+)/i);
  if (targMatch) { cmd.targExpr = targMatch[1]; cmd.targVal = parseFloat(targMatch[2]); }

  // strip modifiers from expr
  cmd.expr = cmd.expr.split(/\s+(WHEN|FROM|TO|TRIG|TARG|CROSS|RISE|FALL)/i)[0].trim();
  return cmd;
}

function parseNumberWithSuffix(s: string): number {
  const m = s.match(/^([\d.]+)([munp]?s?)$/i);
  if (!m) return parseFloat(s);
  const num = parseFloat(m[1]);
  const suf = m[2].toLowerCase();
  const mult: Record<string, number> = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
  if (suf === '') return num;
  if (mult[suf[0]]) return num * mult[suf[0]];
  return num;
}

// ─────────────────────────────────────────────────────────────────────────────
// .meas executor — operates on stored traces
// ─────────────────────────────────────────────────────────────────────────────

export function execMeas(
  cmd: MeasCommand,
  trace: RealTrace,
): MeasResult {
  switch (cmd.type) {
    case 'AVG': {
      const [avg] = sliceTrace(trace, cmd.fromTime, cmd.toTime);
      const sum = avg.reduce((a, b) => a + b, 0);
      return { name: cmd.name, value: avg.length > 0 ? sum / avg.length : 0, unit: trace.yLabel };
    }
    case 'MIN': {
      const [vals] = sliceTrace(trace, cmd.fromTime, cmd.toTime);
      return { name: cmd.name, value: vals.length > 0 ? Math.min(...vals) : 0, unit: trace.yLabel };
    }
    case 'MAX': {
      const [vals] = sliceTrace(trace, cmd.fromTime, cmd.toTime);
      return { name: cmd.name, value: vals.length > 0 ? Math.max(...vals) : 0, unit: trace.yLabel };
    }
    case 'PP': {
      const [vals] = sliceTrace(trace, cmd.fromTime, cmd.toTime);
      if (vals.length === 0) return { name: cmd.name, value: 0 };
      return { name: cmd.name, value: Math.max(...vals) - Math.min(...vals), unit: trace.yLabel };
    }
    case 'RMS': {
      const [vals] = sliceTrace(trace, cmd.fromTime, cmd.toTime);
      const sumSq = vals.reduce((a, b) => a + b * b, 0);
      return { name: cmd.name, value: Math.sqrt(sumSq / Math.max(1, vals.length)), unit: trace.yLabel };
    }
    case 'FIND': {
      // Find V(out) at the time when whenExpr is true (first crossing)
      // Simplified: assume whenExpr is V(node)=value
      const m = cmd.whenExpr?.match(/V\((\w+)\)\s*=\s*([\d.+-]+)/);
      if (!m) return { name: cmd.name, value: 0 };
      const target = parseFloat(m[2]);
      // find first crossing
      for (let i = 1; i < trace.yValues.length; i++) {
        if ((trace.yValues[i - 1] < target && trace.yValues[i] >= target) ||
            (trace.yValues[i - 1] > target && trace.yValues[i] <= target)) {
          // interpolate
          const t0 = trace.xValues[i - 1];
          const t1 = trace.xValues[i];
          const v0 = trace.yValues[i - 1];
          const v1 = trace.yValues[i];
          const frac = (target - v0) / (v1 - v0);
          const tCross = t0 + frac * (t1 - t0);
          // for FIND...WHEN, the FIND expr is the value AT the WHEN crossing
          // Simplified: return the trace value at that time
          const idx = Math.floor(frac + (i - 1));
          return { name: cmd.name, value: trace.yValues[idx] ?? 0, unit: trace.yLabel };
        }
      }
      return { name: cmd.name, value: 0 };
    }
    case 'WHEN': {
      // Return the time when expr crosses a value (simplified)
      const m = cmd.expr.match(/V\((\w+)\)\s*=\s*([\d.+-]+)/);
      if (!m) return { name: cmd.name, value: 0, unit: 's' };
      const target = parseFloat(m[2]);
      for (let i = 1; i < trace.yValues.length; i++) {
        if ((trace.yValues[i - 1] < target && trace.yValues[i] >= target) ||
            (trace.yValues[i - 1] > target && trace.yValues[i] <= target)) {
          const t0 = trace.xValues[i - 1];
          const t1 = trace.xValues[i];
          const v0 = trace.yValues[i - 1];
          const v1 = trace.yValues[i];
          const frac = (target - v0) / (v1 - v0);
          return { name: cmd.name, value: t0 + frac * (t1 - t0), unit: 's' };
        }
      }
      return { name: cmd.name, value: 0, unit: 's' };
    }
    case 'DELAY': {
      // Time between trig crossing and targ crossing
      // (simplified — needs trig and targ traces)
      return { name: cmd.name, value: 0, unit: 's' };
    }
    case 'PARAM': {
      // Evaluate a parameter expression (e.g., 2*gain)
      const v = parseFloat(cmd.expr);
      return { name: cmd.name, value: isNaN(v) ? 0 : v };
    }
  }
}

function sliceTrace(trace: RealTrace, from?: number, to?: number): [number[], number[]] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < trace.xValues.length; i++) {
    const x = trace.xValues[i];
    if ((from === undefined || x >= from) && (to === undefined || x <= to)) {
      xs.push(x);
      ys.push(trace.yValues[i]);
    }
  }
  return [ys, xs];
}

// ─────────────────────────────────────────────────────────────────────────────
// Waveform math — evaluate expressions on traces
// ─────────────────────────────────────────────────────────────────────────────

export class TraceMath {
  static add(a: RealTrace, b: RealTrace): RealTrace {
    const n = Math.min(a.yValues.length, b.yValues.length);
    const yValues = new Float64Array(n);
    for (let i = 0; i < n; i++) yValues[i] = a.yValues[i] + b.yValues[i];
    return { name: `${a.name}+${b.name}`, xValues: a.xValues.subarray(0, n), yValues, xLabel: a.xLabel, yLabel: a.yLabel };
  }

  static sub(a: RealTrace, b: RealTrace): RealTrace {
    const n = Math.min(a.yValues.length, b.yValues.length);
    const yValues = new Float64Array(n);
    for (let i = 0; i < n; i++) yValues[i] = a.yValues[i] - b.yValues[i];
    return { name: `${a.name}-${b.name}`, xValues: a.xValues.subarray(0, n), yValues, xLabel: a.xLabel, yLabel: a.yLabel };
  }

  static mul(a: RealTrace, b: RealTrace): RealTrace {
    const n = Math.min(a.yValues.length, b.yValues.length);
    const yValues = new Float64Array(n);
    for (let i = 0; i < n; i++) yValues[i] = a.yValues[i] * b.yValues[i];
    return { name: `${a.name}*${b.name}`, xValues: a.xValues.subarray(0, n), yValues, xLabel: a.xLabel, yLabel: a.yLabel };
  }

  static scale(a: RealTrace, factor: number): RealTrace {
    const yValues = new Float64Array(a.yValues.length);
    for (let i = 0; i < a.yValues.length; i++) yValues[i] = a.yValues[i] * factor;
    return { name: `${factor}*${a.name}`, xValues: a.xValues, yValues, xLabel: a.xLabel, yLabel: a.yLabel };
  }

  static db20(a: RealTrace): RealTrace {
    // 20*log10(|y|)
    const yValues = new Float64Array(a.yValues.length);
    for (let i = 0; i < a.yValues.length; i++) {
      yValues[i] = 20 * Math.log10(Math.abs(a.yValues[i]) + 1e-30);
    }
    return { name: `dB(${a.name})`, xValues: a.xValues, yValues, xLabel: a.xLabel, yLabel: 'dB' };
  }

  static db10(a: RealTrace): RealTrace {
    const yValues = new Float64Array(a.yValues.length);
    for (let i = 0; i < a.yValues.length; i++) {
      yValues[i] = 10 * Math.log10(Math.abs(a.yValues[i]) + 1e-30);
    }
    return { name: `dB(${a.name})`, xValues: a.xValues, yValues, xLabel: a.xLabel, yLabel: 'dB' };
  }

  static abs(a: RealTrace): RealTrace {
    const yValues = new Float64Array(a.yValues.length);
    for (let i = 0; i < a.yValues.length; i++) yValues[i] = Math.abs(a.yValues[i]);
    return { name: `|${a.name}|`, xValues: a.xValues, yValues, xLabel: a.xLabel, yLabel: a.yLabel };
  }

  static integrate(a: RealTrace): RealTrace {
    const yValues = new Float64Array(a.yValues.length);
    let acc = 0;
    for (let i = 0; i < a.yValues.length; i++) {
      if (i > 0) {
        const dt = a.xValues[i] - a.xValues[i - 1];
        acc += a.yValues[i] * dt;
      }
      yValues[i] = acc;
    }
    return { name: `∫${a.name}`, xValues: a.xValues, yValues, xLabel: a.xLabel, yLabel: a.yLabel };
  }

  static derivative(a: RealTrace): RealTrace {
    const yValues = new Float64Array(a.yValues.length);
    for (let i = 1; i < a.yValues.length; i++) {
      const dx = a.xValues[i] - a.xValues[i - 1];
      yValues[i] = (a.yValues[i] - a.yValues[i - 1]) / Math.max(dx, 1e-15);
    }
    return { name: `d(${a.name})/dt`, xValues: a.xValues, yValues, xLabel: a.xLabel, yLabel: a.yLabel };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FFT — Fourier transform of a real-valued trace
// ─────────────────────────────────────────────────────────────────────────────

export function computeFFT(trace: RealTrace): RealTrace {
  const N = trace.yValues.length;
  if (N < 2) return { name: 'FFT', xValues: new Float64Array(0), yValues: new Float64Array(0) };

  // Apply Hann window
  const windowed = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    windowed[i] = trace.yValues[i] * w;
  }

  // Zero-pad to next power of 2
  const fftSize = nextPow2(N);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < N; i++) re[i] = windowed[i];
  fft(re, im);

  // Compute magnitude spectrum (one-sided)
  const halfSize = fftSize / 2;
  const xValues = new Float64Array(halfSize);
  const yValues = new Float64Array(halfSize);
  const dt = trace.xValues[1] - trace.xValues[0];
  const fs = 1 / dt;
  for (let i = 0; i < halfSize; i++) {
    xValues[i] = i * fs / fftSize;
    yValues[i] = 2 * Math.hypot(re[i], im[i]) / N;
  }
  return {
    name: `FFT(${trace.name})`,
    xValues, yValues,
    xLabel: 'Frequency (Hz)',
    yLabel: 'Magnitude',
  };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k], aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe; im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe; im[i + k + len / 2] = aIm - bIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC trace conversion: complex → magnitude + phase
// ─────────────────────────────────────────────────────────────────────────────

export function complexToMagnitude(trace: ComplexTrace): RealTrace {
  const yValues = new Float64Array(trace.xValues.length);
  for (let i = 0; i < trace.xValues.length; i++) {
    const re = trace.yValues[2 * i];
    const im = trace.yValues[2 * i + 1];
    yValues[i] = Math.hypot(re, im);
  }
  return { name: `|${trace.name}|`, xValues: trace.xValues, yValues, xLabel: trace.xLabel, yLabel: 'Magnitude' };
}

export function complexToPhase(trace: ComplexTrace): RealTrace {
  const yValues = new Float64Array(trace.xValues.length);
  for (let i = 0; i < trace.xValues.length; i++) {
    const re = trace.yValues[2 * i];
    const im = trace.yValues[2 * i + 1];
    yValues[i] = (Math.atan2(im, re) * 180) / Math.PI;
  }
  return { name: `∠${trace.name}`, xValues: trace.xValues, yValues, xLabel: trace.xLabel, yLabel: 'Phase (°)' };
}

export function complexToDb(trace: ComplexTrace): RealTrace {
  const yValues = new Float64Array(trace.xValues.length);
  for (let i = 0; i < trace.xValues.length; i++) {
    const re = trace.yValues[2 * i];
    const im = trace.yValues[2 * i + 1];
    yValues[i] = 20 * Math.log10(Math.hypot(re, im) + 1e-30);
  }
  return { name: `dB(${trace.name})`, xValues: trace.xValues, yValues, xLabel: trace.xLabel, yLabel: 'dB' };
}

// ─────────────────────────────────────────────────────────────────────────────
// XY mode — plot trace A vs trace B (like oscilloscope XY mode)
// ─────────────────────────────────────────────────────────────────────────────

export function xyMode(a: RealTrace, b: RealTrace): { x: Float64Array; y: Float64Array } {
  const n = Math.min(a.yValues.length, b.yValues.length);
  return { x: a.yValues.subarray(0, n), y: b.yValues.subarray(0, n) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw-file export (ngspice binary format — header + double-precision data)
// ─────────────────────────────────────────────────────────────────────────────

export function exportRawFile(traces: RealTrace[], title: string = 'Circuit'): string {
  // ngspice raw file format — text header followed by binary data
  const header = [
    `Title: ${title}`,
    `Date: ${new Date().toISOString()}`,
    `Plotname: Transient Analysis`,
    `Flags: real`,
    `No. Variables: ${traces.length + 1}`,
    `No. Points: ${traces[0]?.yValues.length ?? 0}`,
    `Variables:`,
    `  0 time time`,
  ];
  for (let i = 0; i < traces.length; i++) {
    header.push(`  ${i + 1} ${traces[i].name} voltage`);
  }
  header.push('Values:');
  // values — text mode for simplicity (binary is more compact but harder to emit)
  const N = traces[0]?.yValues.length ?? 0;
  for (let i = 0; i < N; i++) {
    header.push(`${i}\t${traces[0].xValues[i]}`);
    for (let j = 0; j < traces.length; j++) {
      header.push(`\t${traces[j].yValues[i]}`);
    }
  }
  return header.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Stimuli editor — generate waveform stimulus definitions
// ─────────────────────────────────────────────────────────────────────────────

export type StimulusType = 'sine' | 'pulse' | 'pwl' | 'exp' | 'sffm';

export interface Stimulus {
  type: StimulusType;
  params: Record<string, number | number[]>;
}

export function stimulusToSPICE(stimulus: Stimulus, refdes: string): string {
  switch (stimulus.type) {
    case 'sine': {
      const { voff = 0, vamp = 1, freq = 50, td = 0, theta = 0, phase = 0 } = stimulus.params as any;
      return `${refdes} SINE(${voff} ${vamp} ${freq} ${td} ${theta} ${phase})`;
    }
    case 'pulse': {
      const { v1 = 0, v2 = 5, td = 0, tr = 1e-9, tf = 1e-9, pw = 5e-3, per = 10e-3 } = stimulus.params as any;
      return `${refdes} PULSE(${v1} ${v2} ${td} ${tr} ${tf} ${pw} ${per})`;
    }
    case 'pwl': {
      const points = (stimulus.params.points as number[]) ?? [];
      const pairs: string[] = [];
      for (let i = 0; i < points.length; i += 2) {
        pairs.push(`${points[i]} ${points[i + 1]}`);
      }
      return `${refdes} PWL(${pairs.join(' ')})`;
    }
    case 'exp': {
      const { v1 = 0, v2 = 5, td1 = 0, tau1 = 1e-3, td2 = 1e-3, tau2 = 1e-3 } = stimulus.params as any;
      return `${refdes} EXP(${v1} ${v2} ${td1} ${tau1} ${td2} ${tau2})`;
    }
    case 'sffm': {
      const { voff = 0, vamp = 1, fc = 1000, mdi = 5, fs = 100 } = stimulus.params as any;
      return `${refdes} SFFM(${voff} ${vamp} ${fc} ${mdi} ${fs})`;
    }
  }
}

/**
 * Sample a stimulus definition to produce a time-domain trace.
 */
export function sampleStimulus(stimulus: Stimulus, times: Float64Array): Float64Array {
  const out = new Float64Array(times.length);
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    switch (stimulus.type) {
      case 'sine': {
        const { voff = 0, vamp = 1, freq = 50, td = 0, theta = 0, phase = 0 } = stimulus.params as any;
        if (t < td) { out[i] = voff; break; }
        const tt = t - td;
        out[i] = voff + vamp * Math.exp(-theta * tt) * Math.sin(2 * Math.PI * freq * tt + phase);
        break;
      }
      case 'pulse': {
        const { v1 = 0, v2 = 5, td = 0, tr = 1e-9, tf = 1e-9, pw = 5e-3, per = 10e-3 } = stimulus.params as any;
        if (per > 0) {
          const phase = (t - td) % per;
          if (phase < 0) out[i] = v1;
          else if (phase < tr) out[i] = v1 + (v2 - v1) * (phase / tr);
          else if (phase < tr + pw) out[i] = v2;
          else if (phase < tr + pw + tf) out[i] = v2 + (v1 - v2) * ((phase - tr - pw) / tf);
          else out[i] = v1;
        } else {
          out[i] = v1;
        }
        break;
      }
      case 'pwl': {
        const pts = (stimulus.params.points as number[]) ?? [];
        // find segment
        for (let j = 0; j < pts.length - 2; j += 2) {
          if (t >= pts[j] && t <= pts[j + 2]) {
            const t0 = pts[j], t1 = pts[j + 2];
            const v0 = pts[j + 1], v1 = pts[j + 3];
            const frac = (t - t0) / Math.max(t1 - t0, 1e-15);
            out[i] = v0 + frac * (v1 - v0);
            break;
          }
        }
        break;
      }
      case 'exp': {
        const { v1 = 0, v2 = 5, td1 = 0, tau1 = 1e-3, td2 = 1e-3, tau2 = 1e-3 } = stimulus.params as any;
        if (t < td1) out[i] = v1;
        else if (t < td2) out[i] = v1 + (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1));
        else out[i] = v2 + (v1 - v2) * (1 - Math.exp(-(t - td2) / tau2));
        break;
      }
      case 'sffm': {
        const { voff = 0, vamp = 1, fc = 1000, mdi = 5, fs = 100 } = stimulus.params as any;
        out[i] = voff + vamp * Math.sin(2 * Math.PI * fc * t + mdi * Math.sin(2 * Math.PI * fs * t));
        break;
      }
    }
  }
  return out;
}
