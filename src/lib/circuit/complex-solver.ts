// Complex-valued MNA solver for AC small-signal analysis.
//
// AC analysis linearizes the circuit around its DC operating point, then
// solves A·x = z in the complex domain at each frequency. The DC operating
// point provides the linearization point (gm, gds, etc.) for non-linear devices.
//
// This module is independent of the real-valued solver.ts and does NOT modify
// any existing code. The existing real MNA stays untouched.

import type { MnaSystem } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Complex number helpers (Float64Array-based — interleaved re/im)
// We avoid using JS `complex` libraries to keep this standalone + dependency-free.
// ─────────────────────────────────────────────────────────────────────────────

export interface Complex {
  re: number;
  im: number;
}

export function cAdd(a: Complex, b: Complex): Complex { return { re: a.re + b.re, im: a.im + b.im }; }
export function cSub(a: Complex, b: Complex): Complex { return { re: a.re - b.re, im: a.im - b.im }; }
export function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
export function cDiv(a: Complex, b: Complex): Complex {
  const denom = b.re * b.re + b.im * b.im;
  if (denom === 0) return { re: 0, im: 0 };
  return { re: (a.re * b.re + a.im * b.im) / denom, im: (a.im * b.re - a.re * b.im) / denom };
}
export function cAbs(a: Complex): number { return Math.hypot(a.re, a.im); }
export function cPhase(a: Complex): number { return Math.atan2(a.im, a.re); }
export function cFromPolar(mag: number, phase: number): Complex {
  return { re: mag * Math.cos(phase), im: mag * Math.sin(phase) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Complex MNA system (interleaved re/im storage)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplexMnaSystem {
  numNodes: number;
  numExtra: number;
  size: number;
  /** A matrix (size*size, interleaved re/im — 2 * size * size entries) */
  A: Float64Array;
  /** z vector (size, interleaved — 2 * size entries) */
  z: Float64Array;
  nextExtra: number;
}

export function createComplexMnaSystem(numNodes: number, numExtra: number): ComplexMnaSystem {
  const size = numNodes + numExtra;
  return {
    numNodes,
    numExtra,
    size,
    A: new Float64Array(2 * size * size),
    z: new Float64Array(2 * size),
    nextExtra: numNodes,
  };
}

function cidx(r: number, c: number, size: number): number {
  // returns the index into the interleaved complex A array for (r, c)
  return 2 * (r * size + c);
}

function addComplex(sys: ComplexMnaSystem, r: number, c: number, v: Complex) {
  if (r < 0 || c < 0) return;
  const i = cidx(r, c, sys.size);
  sys.A[i] += v.re;
  sys.A[i + 1] += v.im;
}

function addComplexZ(sys: ComplexMnaSystem, r: number, v: Complex) {
  if (r < 0) return;
  sys.z[2 * r] += v.re;
  sys.z[2 * r + 1] += v.im;
}

// Stamping functions (mirror the real MNA but with complex values)

export function cStampConductance(sys: ComplexMnaSystem, n1: number, n2: number, g: Complex) {
  if (g.re === 0 && g.im === 0) return;
  if (n1 > 0 && n2 > 0) {
    addComplex(sys, n1 - 1, n2 - 1, { re: -g.re, im: -g.im });
    addComplex(sys, n2 - 1, n1 - 1, { re: -g.re, im: -g.im });
  }
  if (n1 > 0) addComplex(sys, n1 - 1, n1 - 1, g);
  if (n2 > 0) addComplex(sys, n2 - 1, n2 - 1, g);
}

export function cStampCurrentSource(sys: ComplexMnaSystem, n1: number, n2: number, current: Complex) {
  // current flows OUT of n1, INTO n2
  if (n1 > 0) addComplexZ(sys, n1 - 1, { re: -current.re, im: -current.im });
  if (n2 > 0) addComplexZ(sys, n2 - 1, current);
}

export function cStampVoltageSource(sys: ComplexMnaSystem, n1: number, n2: number, voltage: Complex): number {
  const i = sys.nextExtra++;
  if (n1 > 0) {
    addComplex(sys, n1 - 1, i, { re: 1, im: 0 });
    addComplex(sys, i, n1 - 1, { re: 1, im: 0 });
  }
  if (n2 > 0) {
    addComplex(sys, n2 - 1, i, { re: -1, im: 0 });
    addComplex(sys, i, n2 - 1, { re: -1, im: 0 });
  }
  addComplexZ(sys, i, voltage);
  return i;
}

export function cStampVCCS(sys: ComplexMnaSystem, n1: number, n2: number, c: number, d: number, g: Complex) {
  if (n1 > 0 && c > 0) addComplex(sys, n1 - 1, c - 1, { re: -g.re, im: -g.im });
  if (n1 > 0 && d > 0) addComplex(sys, n1 - 1, d - 1, g);
  if (n2 > 0 && c > 0) addComplex(sys, n2 - 1, c - 1, g);
  if (n2 > 0 && d > 0) addComplex(sys, n2 - 1, d - 1, { re: -g.re, im: -g.im });
}

export function cStampVCVS(sys: ComplexMnaSystem, a: number, b: number, c: number, d: number, mu: Complex): number {
  const i = sys.nextExtra++;
  if (a > 0) { addComplex(sys, a - 1, i, { re: 1, im: 0 }); addComplex(sys, i, a - 1, { re: 1, im: 0 }); }
  if (b > 0) { addComplex(sys, b - 1, i, { re: -1, im: 0 }); addComplex(sys, i, b - 1, { re: -1, im: 0 }); }
  if (c > 0) addComplex(sys, i, c - 1, { re: -mu.re, im: -mu.im });
  if (d > 0) addComplex(sys, i, d - 1, mu);
  return i;
}

// ─────────────────────────────────────────────────────────────────────────────
// Complex LU solver with partial pivoting (uses |z| for pivot selection)
// ─────────────────────────────────────────────────────────────────────────────

export function solveComplexMna(sys: ComplexMnaSystem): Complex[] | null {
  const n = sys.size;
  if (n === 0) return [];

  // work on copies
  const A = Float64Array.from(sys.A);
  const z = Float64Array.from(sys.z);
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;

  for (let k = 0; k < n; k++) {
    // find pivot by magnitude |A[i][k]|
    let maxRow = k;
    let maxVal = 0;
    for (let i = k; i < n; i++) {
      const pi = piv[i];
      const re = A[cidx(pi, k, n)];
      const im = A[cidx(pi, k, n) + 1];
      const mag = re * re + im * im;
      if (mag > maxVal) {
        maxVal = mag;
        maxRow = i;
      }
    }
    if (maxVal < 1e-28) return null;  // singular

    if (maxRow !== k) {
      const tmp = piv[k];
      piv[k] = piv[maxRow];
      piv[maxRow] = tmp;
    }

    const pk = piv[k];
    const pivotRe = A[cidx(pk, k, n)];
    const pivotIm = A[cidx(pk, k, n) + 1];
    const pivotMag = pivotRe * pivotRe + pivotIm * pivotIm;

    for (let i = k + 1; i < n; i++) {
      const pi = piv[i];
      // f = A[pi][k] / pivot
      const ar = A[cidx(pi, k, n)];
      const ai = A[cidx(pi, k, n) + 1];
      const fRe = (ar * pivotRe + ai * pivotIm) / pivotMag;
      const fIm = (ai * pivotRe - ar * pivotIm) / pivotMag;
      if (fRe === 0 && fIm === 0) continue;
      // A[pi][j] -= f * A[pk][j]
      for (let j = k; j < n; j++) {
        const jIdx = cidx(pi, j, n);
        const kIdx = cidx(pk, j, n);
        const bre = A[kIdx];
        const bim = A[kIdx + 1];
        // product f * b
        const prodRe = fRe * bre - fIm * bim;
        const prodIm = fRe * bim + fIm * bre;
        A[jIdx] -= prodRe;
        A[jIdx + 1] -= prodIm;
      }
      // z[pi] -= f * z[pk]
      const zr = z[2 * pk];
      const zi = z[2 * pk + 1];
      z[2 * pi] -= fRe * zr - fIm * zi;
      z[2 * pi + 1] -= fRe * zi + fIm * zr;
    }
  }

  // back-substitution
  const x: Complex[] = new Array(n).fill(0).map(() => ({ re: 0, im: 0 }));
  for (let k = n - 1; k >= 0; k--) {
    const pk = piv[k];
    let sumRe = z[2 * pk];
    let sumIm = z[2 * pk + 1];
    for (let j = k + 1; j < n; j++) {
      const are = A[cidx(pk, j, n)];
      const aim = A[cidx(pk, j, n) + 1];
      sumRe -= are * x[j].re - aim * x[j].im;
      sumIm -= are * x[j].im + aim * x[j].re;
    }
    const pivotRe = A[cidx(pk, k, n)];
    const pivotIm = A[cidx(pk, k, n) + 1];
    const pivotMag = pivotRe * pivotRe + pivotIm * pivotIm;
    x[k].re = (sumRe * pivotRe + sumIm * pivotIm) / pivotMag;
    x[k].im = (sumIm * pivotRe - sumRe * pivotIm) / pivotMag;
  }

  return x;
}
