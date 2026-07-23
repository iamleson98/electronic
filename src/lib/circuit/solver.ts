// Modified Nodal Analysis (MNA) solver.
// Solves A * x = z where x = [node voltages; branch currents].
//
// We use LU decomposition with partial pivoting. For small circuits (< few hundred
// nodes) a dense solver is fast enough and far simpler than a sparse one.

import type { MnaSystem } from './types';

export function createMnaSystem(numNodes: number, numExtra: number): MnaSystem {
  const size = numNodes + numExtra;
  const sys: MnaSystem = {
    numNodes,
    numExtra,
    size,
    A: new Float64Array(size * size),
    z: new Float64Array(size),
    nextExtra: numNodes,
    addExtra: () => sys.nextExtra++,
    stampConductance: (n1, n2, g) => stampConductance(sys, n1, n2, g),
    stampCurrentSource: (n1, n2, current) => stampCurrentSource(sys, n1, n2, current),
    stampVoltageSource: (n1, n2, voltage) => stampVoltageSource(sys, n1, n2, voltage),
    stampVCVS: (a, b, c, d, mu) => stampVCVS(sys, a, b, c, d, mu),
    stampVCCS: (n1, n2, c, d, g) => stampVCCS(sys, n1, n2, c, d, g),
    stampCCCS: (n1, n2, extraIndex, beta) => stampCCCS(sys, n1, n2, extraIndex, beta),
    stampCCVS: (a, b, extraIndex, r) => stampCCVS(sys, a, b, extraIndex, r),
  };
  return sys;
}

function idx(r: number, c: number, size: number): number {
  return r * size + c;
}

function stampConductance(sys: MnaSystem, n1: number, n2: number, g: number) {
  if (g === 0) return;
  const s = sys.size;
  // For a conductance g between n1 and n2:
  //   KCL at n1: current leaving = g*(V(n1) - V(n2)) = g*V(n1) - g*V(n2)
  //   -> G[n1-1][n1-1] += g, G[n1-1][n2-1] -= g
  //   similarly for n2.
  if (n1 > 0 && n2 > 0) {
    sys.A[idx(n1 - 1, n2 - 1, s)] -= g;
    sys.A[idx(n2 - 1, n1 - 1, s)] -= g;
  }
  if (n1 > 0) sys.A[idx(n1 - 1, n1 - 1, s)] += g;
  if (n2 > 0) sys.A[idx(n2 - 1, n2 - 1, s)] += g;
}

function stampCurrentSource(sys: MnaSystem, n1: number, n2: number, current: number) {
  // current flows OUT of n1, INTO n2 (i.e. from n1 -> n2 through external source)
  if (n1 > 0) sys.z[n1 - 1] -= current;
  if (n2 > 0) sys.z[n2 - 1] += current;
}

function stampVoltageSource(sys: MnaSystem, n1: number, n2: number, voltage: number): number {
  // introduce a new branch current i, flowing from n1 to n2 through the source
  const i = sys.addExtra();
  const s = sys.size;
  // KCL at n1: +i ; at n2: -i
  if (n1 > 0) sys.A[idx(n1 - 1, i, s)] += 1;
  if (n2 > 0) sys.A[idx(n2 - 1, i, s)] -= 1;
  // branch equation: Vn1 - Vn2 = voltage
  if (n1 > 0) sys.A[idx(i, n1 - 1, s)] += 1;
  if (n2 > 0) sys.A[idx(i, n2 - 1, s)] -= 1;
  sys.z[i] = voltage;
  return i;
}

function stampVCVS(sys: MnaSystem, a: number, b: number, c: number, d: number, mu: number): number {
  // V(a) - V(b) = mu * (V(c) - V(d))
  const i = sys.addExtra();
  const s = sys.size;
  if (a > 0) sys.A[idx(a - 1, i, s)] += 1;
  if (b > 0) sys.A[idx(b - 1, i, s)] -= 1;
  if (a > 0) sys.A[idx(i, a - 1, s)] += 1;
  if (b > 0) sys.A[idx(i, b - 1, s)] -= 1;
  if (c > 0) sys.A[idx(i, c - 1, s)] -= mu;
  if (d > 0) sys.A[idx(i, d - 1, s)] += mu;
  sys.z[i] = 0;
  return i;
}

function stampVCCS(sys: MnaSystem, n1: number, n2: number, c: number, d: number, g: number) {
  // current from n1 to n2 = g * (V(c) - V(d))
  const s = sys.size;
  if (n1 > 0 && c > 0) sys.A[idx(n1 - 1, c - 1, s)] -= g;
  if (n1 > 0 && d > 0) sys.A[idx(n1 - 1, d - 1, s)] += g;
  if (n2 > 0 && c > 0) sys.A[idx(n2 - 1, c - 1, s)] += g;
  if (n2 > 0 && d > 0) sys.A[idx(n2 - 1, d - 1, s)] -= g;
}

function stampCCCS(sys: MnaSystem, n1: number, n2: number, extraIndex: number, beta: number) {
  // current from n1 to n2 = beta * I_branch(extraIndex)
  const s = sys.size;
  if (n1 > 0) sys.A[idx(n1 - 1, extraIndex, s)] += beta;
  if (n2 > 0) sys.A[idx(n2 - 1, extraIndex, s)] -= beta;
}

function stampCCVS(sys: MnaSystem, a: number, b: number, extraIndex: number, r: number): number {
  // V(a) - V(b) = r * I_branch(extraIndex)
  const i = sys.addExtra();
  const s = sys.size;
  if (a > 0) sys.A[idx(a - 1, i, s)] += 1;
  if (b > 0) sys.A[idx(b - 1, i, s)] -= 1;
  if (a > 0) sys.A[idx(i, a - 1, s)] += 1;
  if (b > 0) sys.A[idx(i, b - 1, s)] -= 1;
  sys.A[idx(i, extraIndex, s)] -= r;
  sys.z[i] = 0;
  return i;
}

/**
 * Solve A * x = z using LU decomposition with partial pivoting.
 * Returns the solution vector x, or null if singular.
 */
export function solveMna(sys: MnaSystem): Float64Array | null {
  const n = sys.size;
  if (n === 0) return new Float64Array(0);
  // copy A and z so the original stamps are preserved (we re-stamp every step anyway,
  // but copying lets us reuse the system object if needed)
  const A = Float64Array.from(sys.A);
  const z = Float64Array.from(sys.z);
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;

  for (let k = 0; k < n; k++) {
    // find pivot
    let maxRow = k;
    let maxVal = Math.abs(A[piv[k] * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[piv[i] * n + k]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = i;
      }
    }
    if (maxVal < 1e-14) {
      // singular - bail
      return null;
    }
    if (maxRow !== k) {
      const tmp = piv[k];
      piv[k] = piv[maxRow];
      piv[maxRow] = tmp;
    }
    const pk = piv[k];
    const pivot = A[pk * n + k];
    for (let i = k + 1; i < n; i++) {
      const pi = piv[i];
      const f = A[pi * n + k] / pivot;
      if (f === 0) continue;
      for (let j = k; j < n; j++) {
        A[pi * n + j] -= f * A[pk * n + j];
      }
      A[pi * n + k] = 0;
      z[pi] -= f * z[pk];
    }
  }

  // back-substitution
  const x = new Float64Array(n);
  for (let k = n - 1; k >= 0; k--) {
    const pk = piv[k];
    let sum = z[pk];
    for (let j = k + 1; j < n; j++) {
      sum -= A[pk * n + j] * x[j];
    }
    x[k] = sum / A[pk * n + k];
  }

  // x is indexed by [0..n-1] but pivot reorders rows; we need to remap.
  // Actually, we used `piv` to track row permutation; result x[k] corresponds to
  // the k-th column unknown (which is what we want since columns are NOT permuted).
  return x;
}
