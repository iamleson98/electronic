// Sparse MNA solver — a real sparse LU for large circuits.
//
// The dense solver uses O(N²) memory and O(N³) time, which is fine for
// circuits up to a few hundred nodes but breaks down for larger designs
// (a 1000-node circuit would need 8MB for the matrix and ~1 billion
// floating-point operations per solve step).
//
// This module implements:
//   1. COO (triplet) stamping — O(nnz) memory, no dense array is ever built.
//      The stamp* methods have identical semantics to the dense solver, so
//      every existing plugin works unchanged.
//   2. CSR construction with duplicate merging (stamps that hit the same
//      (row, col) — e.g. two conductances on the same node pair — accumulate).
//   3. Right-looking sparse LU factorization with Markowitz ordering and
//      threshold partial pivoting (the classic SPICE/KLU recipe):
//        - columns are kept in count buckets so the pivot search can scan
//          the sparsest columns first,
//        - a pivot (r, c) is accepted when |A[r][c]| >= TAU * max|A[.][c]|
//          (TAU = 0.05 bounds every elimination multiplier by 1/TAU = 20),
//        - among acceptable candidates we minimize the Markowitz cost
//          (rownnz-1)*(colnnz-1), which upper-bounds the fill-in created.
//   4. Sparse triangular solves with the recorded row/column permutations.
//   5. A cheap residual check (O(nnz)) that turns any gross numerical
//      failure into a null result instead of silently wrong voltages.
//
// Complexity: factorization work is proportional to actual flop count
// (fill-in dependent), typically O(nnz * small) for circuit matrices —
// a 2000-node ladder factors in well under a millisecond, where the dense
// solver would need seconds.
//
// The API mirrors the dense solver: createSparseMnaSystem() returns a
// SparseMnaSystem with the same stamp* methods, and solveSparse() returns
// the solution vector (or null when singular/unstable).

import type { MnaSystem } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Growable COO (triplet) buffer used during stamping. */
export class TripletBuffer {
  row: Int32Array;
  col: Int32Array;
  val: Float64Array;
  count = 0;

  constructor(capacity = 256) {
    this.row = new Int32Array(capacity);
    this.col = new Int32Array(capacity);
    this.val = new Float64Array(capacity);
  }

  push(r: number, c: number, v: number): void {
    if (this.count === this.row.length) this.grow();
    this.row[this.count] = r;
    this.col[this.count] = c;
    this.val[this.count] = v;
    this.count++;
  }

  private grow(): void {
    const n = this.row.length * 2;
    const row = new Int32Array(n);
    const col = new Int32Array(n);
    const val = new Float64Array(n);
    row.set(this.row);
    col.set(this.col);
    val.set(this.val);
    this.row = row;
    this.col = col;
    this.val = val;
  }

  clear(): void {
    this.count = 0;
  }
}

export interface SparseMnaSystem {
  /** number of non-ground nodes */
  numNodes: number;
  /** number of extra (branch current) unknowns */
  numExtra: number;
  /** total system size = numNodes + numExtra */
  size: number;
  /** triplet buffer — the matrix itself (row-major entries appended by stamps) */
  triplets: TripletBuffer;
  /** dense RHS vector (size) — the only dense per-unknown storage we keep */
  z: Float64Array;
  /** next available extra var index */
  nextExtra: number;
  /** reset the triplet buffer for re-stamping (called by the engine each step) */
  clearStamps: () => void;
  /** drop triplets/RHS entries outside the used [0, newSize) block */
  truncate: (newSize: number) => void;
  /** stamp conductance between two nodes */
  stampConductance: (n1: number, n2: number, g: number) => void;
  /** stamp a current source flowing from n1 to n2 (out of n1, into n2) */
  stampCurrentSource: (n1: number, n2: number, current: number) => void;
  /** stamp a voltage source between n1 and n2 with value V (Vn1 - Vn2 = V); returns branch current index */
  stampVoltageSource: (n1: number, n2: number, voltage: number) => number;
  /** stamp a VCVS: V(a)-V(b) = mu*(V(c)-V(d)) ; returns branch current index */
  stampVCVS: (a: number, b: number, c: number, d: number, mu: number) => number;
  /** stamp a VCCS: current from n1 to n2 = g*(V(c)-V(d)) */
  stampVCCS: (n1: number, n2: number, c: number, d: number, g: number) => void;
  /** stamp a CCCS: current from n1 to n2 = beta * I_branch(extraIndex) */
  stampCCCS: (n1: number, n2: number, extraIndex: number, beta: number) => void;
  /** stamp a CCVS: V(a)-V(b) = r * I_branch(extraIndex); returns new branch index */
  stampCCVS: (a: number, b: number, extraIndex: number, r: number) => number;
  /** allocate a new branch-current variable */
  addExtra: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sparse system factory — stamps append COO triplets; no dense matrix exists.
// The stamp math below is byte-for-byte the same as the dense solver's
// (row = nodeId − 1 for node unknowns, row = extra index for branch currents),
// so numerics are interchangeable with the dense path.
// ─────────────────────────────────────────────────────────────────────────────

export function createSparseMnaSystem(numNodes: number, numExtra: number): SparseMnaSystem {
  const size = numNodes + numExtra;
  const triplets = new TripletBuffer(Math.max(64, size * 4));
  const sys: SparseMnaSystem = {
    numNodes,
    numExtra,
    size,
    triplets,
    z: new Float64Array(size),
    nextExtra: numNodes,
    clearStamps: () => {
      triplets.clear();
      sys.z.fill(0);
    },
    truncate: (newSize: number) => {
      // Unused extra rows/cols were never stamped, so this is mostly
      // defensive; it also shrinks the RHS to the used block.
      const t = sys.triplets;
      let w = 0;
      for (let i = 0; i < t.count; i++) {
        if (t.row[i] < newSize && t.col[i] < newSize) {
          t.row[w] = t.row[i];
          t.col[w] = t.col[i];
          t.val[w] = t.val[i];
          w++;
        }
      }
      t.count = w;
      sys.z = sys.z.slice(0, newSize);
      sys.size = newSize;
    },
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

function stampConductance(sys: SparseMnaSystem, n1: number, n2: number, g: number) {
  if (g === 0) return;
  const t = sys.triplets;
  // KCL at n1: g*V(n1) − g*V(n2); same (transposed) at n2.
  if (n1 > 0 && n2 > 0) {
    t.push(n1 - 1, n2 - 1, -g);
    t.push(n2 - 1, n1 - 1, -g);
  }
  if (n1 > 0) t.push(n1 - 1, n1 - 1, g);
  if (n2 > 0) t.push(n2 - 1, n2 - 1, g);
}

function stampCurrentSource(sys: SparseMnaSystem, n1: number, n2: number, current: number) {
  // current flows OUT of n1, INTO n2
  if (n1 > 0) sys.z[n1 - 1] -= current;
  if (n2 > 0) sys.z[n2 - 1] += current;
}

function stampVoltageSource(sys: SparseMnaSystem, n1: number, n2: number, voltage: number): number {
  const i = sys.addExtra();
  const t = sys.triplets;
  if (n1 > 0) t.push(n1 - 1, i, 1);
  if (n2 > 0) t.push(n2 - 1, i, -1);
  if (n1 > 0) t.push(i, n1 - 1, 1);
  if (n2 > 0) t.push(i, n2 - 1, -1);
  sys.z[i] = voltage;
  return i;
}

function stampVCVS(sys: SparseMnaSystem, a: number, b: number, c: number, d: number, mu: number): number {
  const i = sys.addExtra();
  const t = sys.triplets;
  if (a > 0) t.push(a - 1, i, 1);
  if (b > 0) t.push(b - 1, i, -1);
  if (a > 0) t.push(i, a - 1, 1);
  if (b > 0) t.push(i, b - 1, -1);
  if (c > 0) t.push(i, c - 1, -mu);
  if (d > 0) t.push(i, d - 1, mu);
  sys.z[i] = 0;
  return i;
}

function stampVCCS(sys: SparseMnaSystem, n1: number, n2: number, c: number, d: number, g: number) {
  const t = sys.triplets;
  if (n1 > 0 && c > 0) t.push(n1 - 1, c - 1, -g);
  if (n1 > 0 && d > 0) t.push(n1 - 1, d - 1, g);
  if (n2 > 0 && c > 0) t.push(n2 - 1, c - 1, g);
  if (n2 > 0 && d > 0) t.push(n2 - 1, d - 1, -g);
}

function stampCCCS(sys: SparseMnaSystem, n1: number, n2: number, extraIndex: number, beta: number) {
  const t = sys.triplets;
  if (n1 > 0) t.push(n1 - 1, extraIndex, beta);
  if (n2 > 0) t.push(n2 - 1, extraIndex, -beta);
}

function stampCCVS(sys: SparseMnaSystem, a: number, b: number, extraIndex: number, r: number): number {
  const i = sys.addExtra();
  const t = sys.triplets;
  if (a > 0) t.push(a - 1, i, 1);
  if (b > 0) t.push(b - 1, i, -1);
  if (a > 0) t.push(i, a - 1, 1);
  if (b > 0) t.push(i, b - 1, -1);
  t.push(i, extraIndex, -r);
  sys.z[i] = 0;
  return i;
}

// ─────────────────────────────────────────────────────────────────────────────
// solveSparse — entry point used by the engine.
// ─────────────────────────────────────────────────────────────────────────────

export function solveSparse(sys: SparseMnaSystem): Float64Array | null {
  const n = sys.size;
  if (n === 0) return new Float64Array(0);
  const t = sys.triplets;
  return solveFromTriplets(n, t.row, t.col, t.val, t.count, sys.z);
}

/**
 * Solve a square system given as raw triplets (with duplicates — they are
 * merged). Exported for testing against the dense solver on arbitrary
 * matrices.
 */
export function solveFromTriplets(
  n: number,
  tRow: Int32Array | number[],
  tCol: Int32Array | number[],
  tVal: Float64Array | number[],
  count: number,
  z: Float64Array,
): Float64Array | null {
  if (n === 0) return new Float64Array(0);

  // ── 1. Sort triplets by (row, col) and merge duplicates ──
  // Int32Array#sort with a comparator is stable enough for our purpose —
  // duplicates of the same (row, col) are summed regardless of order.
  const idx = new Int32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  idx.sort((a, b) => tRow[a] - tRow[b] || tCol[a] - tCol[b]);

  const rowC: number[][] = new Array(n);
  const rowV: number[][] = new Array(n);
  for (let r = 0; r < n; r++) {
    rowC[r] = [];
    rowV[r] = [];
  }
  let i = 0;
  while (i < count) {
    const r = tRow[idx[i]];
    const c = tCol[idx[i]];
    let v = 0;
    let j = i;
    while (j < count && tRow[idx[j]] === r && tCol[idx[j]] === c) {
      v += tVal[idx[j]];
      j++;
    }
    i = j;
    // Structural zeros (e.g. a VCCS with g=0, or exact cancellation between
    // stamps) carry no information — drop them so pivot search stays tight.
    if (v !== 0) {
      rowC[r].push(c);
      rowV[r].push(v);
    }
  }

  // Flatten to CSR (needed for the residual check at the end).
  const rowPtr = new Int32Array(n + 1);
  let nnz = 0;
  for (let r = 0; r < n; r++) nnz += rowC[r].length;
  const cols = new Int32Array(nnz);
  const vals = new Float64Array(nnz);
  let p = 0;
  for (let r = 0; r < n; r++) {
    rowPtr[r] = p;
    for (let e = 0; e < rowC[r].length; e++) {
      cols[p] = rowC[r][e];
      vals[p] = rowV[r][e];
      p++;
    }
  }
  rowPtr[n] = p;

  return luSolveCSR(n, rowPtr, cols, vals, z, rowC, rowV);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: right-looking sparse LU with Markowitz ordering + threshold pivoting.
//
// Factorization: Pr · A · Pc = L · U
//   Pr (row permutation) and Pc (col permutation) are discovered on the fly:
//   at elimination step k the pivot (pr, pc) becomes permuted row/col k.
// The active submatrix is held as dynamic sparse rows (sorted column lists)
// plus per-column row lists so both Markowitz degrees are O(1) to read.
// ─────────────────────────────────────────────────────────────────────────────

/** relative pivot threshold — bounds elimination multipliers at 1/TAU */
const TAU = 0.05;
/** absolute floor on the column max (matches the dense solver's pivot test) */
const PIVOT_ABS_FLOOR = 1e-14;
/** how many sparsest columns the lazy Markowitz search examines per step */
const PIVOT_SEARCH_COLS = 4;
/** relative residual tolerance for the solution sanity check */
const RESIDUAL_TOL = 1e-4;

export function luSolveCSR(
  n: number,
  rowPtr: Int32Array,
  cols: Int32Array,
  vals: Float64Array,
  z: Float64Array,
  /** optional pre-split rows (rowC[r] = sorted cols, rowV[r] = values); when
   * omitted they are rebuilt from the CSR arrays */
  rowC?: number[][],
  rowV?: number[][],
): Float64Array | null {
  if (n === 0) return new Float64Array(0);

  // ── dynamic active-submatrix structures ──
  if (!rowC || !rowV) {
    rowC = new Array(n);
    rowV = new Array(n);
    for (let r = 0; r < n; r++) {
      rowC[r] = Array.from(cols.slice(rowPtr[r], rowPtr[r + 1]));
      rowV[r] = Array.from(vals.slice(rowPtr[r], rowPtr[r + 1]));
    }
  }
  // colRows[c] = active rows holding a nonzero in column c (unsorted).
  const colRows: number[][] = new Array(n);
  for (let c = 0; c < n; c++) colRows[c] = [];
  for (let r = 0; r < n; r++) {
    for (const c of rowC[r]) colRows[c].push(r);
  }

  // Column count buckets: buckets[cnt] holds the columns whose active count
  // is cnt. Lets the pivot search walk the sparsest columns first without
  // scanning all n columns every step. Columns whose count drops to 0 leave
  // the bucket structure entirely (they can never be pivoted) and re-enter
  // if later fill brings them back — this keeps the scan lists clean.
  const buckets: number[][] = new Array(n + 1);
  for (let b = 0; b <= n; b++) buckets[b] = [];
  const bucketIdx = new Int32Array(n); // current bucket (== active count)
  const bucketPos = new Int32Array(n); // position inside that bucket array
  const colInBucket = new Uint8Array(n);
  const bucketRemove = (c: number) => {
    const b = buckets[bucketIdx[c]];
    const pos = bucketPos[c];
    const last = b.length - 1;
    if (pos !== last) {
      b[pos] = b[last];
      bucketPos[b[last]] = pos;
    }
    b.pop();
    colInBucket[c] = 0;
  };
  const bucketAdd = (c: number, cnt: number) => {
    bucketIdx[c] = cnt;
    bucketPos[c] = buckets[cnt].length;
    buckets[cnt].push(c);
    colInBucket[c] = 1;
  };
  const bucketMove = (c: number, cnt: number) => {
    if (cnt === 0) {
      if (colInBucket[c]) bucketRemove(c);
      bucketIdx[c] = 0;
    } else if (!colInBucket[c]) {
      bucketAdd(c, cnt);
    } else if (bucketIdx[c] !== cnt) {
      bucketRemove(c);
      bucketAdd(c, cnt);
    }
  };
  for (let c = 0; c < n; c++) bucketAdd(c, colRows[c].length);

  const rowActive = new Uint8Array(n).fill(1);
  const colActive = new Uint8Array(n).fill(1);

  // permutations: step k used original row rowPerm[k] / column colPerm[k]
  const rowPerm = new Int32Array(n);
  const colPerm = new Int32Array(n);
  const rowPos = new Int32Array(n).fill(-1); // original row → its pivot step
  const colPos = new Int32Array(n).fill(-1); // original col → its pivot step

  // L (unit diagonal, strictly lower): per-step segments of (origRow, f).
  // U (upper incl. diagonal): per-step segments of (origCol, v).
  const lRow: number[] = [];
  const lVal: number[] = [];
  const lPtr: number[] = new Array(n + 1);
  const uCol: number[] = [];
  const uVal: number[] = [];
  const uPtr: number[] = new Array(n + 1);

  // value lookup: binary search in the (sorted) row
  const getVal = (r: number, c: number): number => {
    const rc = rowC[r];
    let lo = 0;
    let hi = rc.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const mc = rc[mid];
      if (mc === c) return rowV[r][mid];
      if (mc < c) lo = mid + 1;
      else hi = mid - 1;
    }
    return 0; // structurally absent (should not happen for maintained lists)
  };

  const removeFromArr = (arr: number[], v: number) => {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
  };

  for (let k = 0; k < n; k++) {
    lPtr[k] = lRow.length;
    uPtr[k] = uCol.length;

    // ── pivot search: lazy Markowitz ──
    // Scan columns in increasing active-count order; within a column pick
    // the sparsest numerically-acceptable row; keep the best (min Markowitz
    // cost) over the first few columns examined.
    let bestRow = -1;
    let bestCol = -1;
    let bestCost = Infinity;
    let scanned = 0;
    for (let cnt = 0; cnt <= n && scanned < PIVOT_SEARCH_COLS; cnt++) {
      const bkt = buckets[cnt];
      for (let bi = 0; bi < bkt.length && scanned < PIVOT_SEARCH_COLS; bi++) {
        const c = bkt[bi];
        if (!colActive[c]) continue;
        const rows = colRows[c];
        if (rows.length === 0) continue;
        let colMax = 0;
        for (const r of rows) {
          const v = Math.abs(getVal(r, c));
          if (v > colMax) colMax = v;
        }
        if (colMax < PIVOT_ABS_FLOOR || !isFinite(colMax)) continue; // numerically empty
        let candRow = -1;
        let candRC = Infinity;
        let candAbs = -1;
        for (const r of rows) {
          const v = Math.abs(getVal(r, c));
          if (v >= TAU * colMax) {
            const rc = rowC[r].length;
            if (rc < candRC || (rc === candRC && v > candAbs)) {
              candRow = r;
              candRC = rc;
              candAbs = v;
            }
          }
        }
        if (candRow < 0) continue;
        const cost = (candRC - 1) * (cnt - 1);
        if (cost < bestCost) {
          bestCost = cost;
          bestRow = candRow;
          bestCol = c;
        }
        scanned++;
        if (bestCost === 0) break;
      }
      if (bestCost === 0) break;
    }
    if (bestRow < 0) return null; // singular active submatrix

    // ── extract the pivot row ──
    const pr = bestRow;
    const pc = bestCol;
    const prowCols = rowC[pr];
    const prowVals = rowV[pr];
    const pIdx = prowCols.indexOf(pc);
    const pv = prowVals[pIdx];
    if (!isFinite(pv) || pv === 0) return null;

    // record U row k (entries keep original column indices for now)
    for (let e = 0; e < prowCols.length; e++) {
      uCol.push(prowCols[e]);
      uVal.push(prowVals[e]);
    }

    // pivot row minus the pivot column — elimination updates use this so the
    // pivot column is never re-inserted (its entry below the pivot is exactly
    // cancelled by the elimination, and must stay cancelled)
    const prowMergeCols: number[] = [];
    const prowMergeVals: number[] = [];
    for (let e = 0; e < prowCols.length; e++) {
      if (prowCols[e] !== pc) {
        prowMergeCols.push(prowCols[e]);
        prowMergeVals.push(prowVals[e]);
      }
    }

    // retire the pivot column first (while it is still in its bucket);
    // the pivot row itself must not appear in the elimination list
    removeFromArr(colRows[pc], pr);
    const rowsInPc = colRows[pc].slice();
    colRows[pc] = [];
    bucketRemove(pc);
    colActive[pc] = 0;

    rowPerm[k] = pr;
    colPerm[k] = pc;
    rowPos[pr] = k;
    colPos[pc] = k;

    // retire the pivot row from the active structures
    rowActive[pr] = 0;
    rowC[pr] = [];
    rowV[pr] = [];
    for (const c of prowCols) {
      if (c === pc) continue; // already retired
      removeFromArr(colRows[c], pr);
      bucketMove(c, colRows[c].length);
    }

    // ── eliminate: row_r := row_r − f · pivot_row, for rows holding pc ──
    for (const r of rowsInPc) {
      const rc = rowC[r];
      const rv = rowV[r];
      const ri = rc.indexOf(pc);
      const f = rv[ri] / pv;
      if (!isFinite(f)) return null;
      rc.splice(ri, 1);
      rv.splice(ri, 1);
      lRow.push(r);
      lVal.push(f);
      if (f === 0) continue; // structurally present but numerically zero

      // merge r's row with −f·pivotRow (both sorted, both without pc)
      const outC: number[] = [];
      const outV: number[] = [];
      let a = 0;
      let b = 0;
      while (a < rc.length && b < prowMergeCols.length) {
        const ca = rc[a];
        const cb = prowMergeCols[b];
        if (ca < cb) {
          outC.push(ca);
          outV.push(rv[a]);
          a++;
        } else if (ca > cb) {
          // fill-in at column cb
          const v = -f * prowMergeVals[b];
          outC.push(cb);
          outV.push(v);
          colRows[cb].push(r);
          bucketMove(cb, colRows[cb].length);
          b++;
        } else {
          const v = rv[a] - f * prowMergeVals[b];
          if (v !== 0) {
            outC.push(ca);
            outV.push(v);
          } else {
            // exact structural cancellation — keep the structure tight
            removeFromArr(colRows[ca], r);
            bucketMove(ca, colRows[ca].length);
          }
          a++;
          b++;
        }
      }
      while (a < rc.length) {
        outC.push(rc[a]);
        outV.push(rv[a]);
        a++;
      }
      while (b < prowMergeCols.length) {
        const cb = prowMergeCols[b];
        outC.push(cb);
        outV.push(-f * prowMergeVals[b]);
        colRows[cb].push(r);
        bucketMove(cb, colRows[cb].length);
        b++;
      }
      rowC[r] = outC;
      rowV[r] = outV;
    }
  }
  lPtr[n] = lRow.length;
  uPtr[n] = uCol.length;

  // map L/U entries into permuted coordinates
  const lRowPerm = new Int32Array(lRow.length);
  for (let s = 0; s < lRow.length; s++) lRowPerm[s] = rowPos[lRow[s]];
  const uColPerm = new Int32Array(uCol.length);
  for (let s = 0; s < uCol.length; s++) uColPerm[s] = colPos[uCol[s]];

  // ── solve L·U·x' = Pr·b ──
  const bp = new Float64Array(n);
  for (let k = 0; k < n; k++) bp[k] = z[rowPerm[k]];

  // forward substitution (L unit lower triangular, column-oriented)
  for (let k = 0; k < n; k++) {
    const yk = bp[k];
    if (yk === 0) continue;
    for (let s = lPtr[k]; s < lPtr[k + 1]; s++) {
      bp[lRowPerm[s]] -= lVal[s] * yk;
    }
  }

  // back substitution (U upper triangular, diagonal included in each row)
  const x2 = new Float64Array(n);
  for (let k = n - 1; k >= 0; k--) {
    let sum = bp[k];
    let diag = 0;
    let haveDiag = false;
    for (let s = uPtr[k]; s < uPtr[k + 1]; s++) {
      const cc = uColPerm[s];
      if (cc === k) {
        diag = uVal[s];
        haveDiag = true;
      } else {
        sum -= uVal[s] * x2[cc];
      }
    }
    if (!haveDiag || diag === 0 || !isFinite(diag)) return null;
    x2[k] = sum / diag;
    if (!isFinite(x2[k])) return null;
  }

  // undo the column permutation: x[colPerm[k]] = x2[k]
  const x = new Float64Array(n);
  for (let k = 0; k < n; k++) x[colPerm[k]] = x2[k];

  // ── residual sanity check (O(nnz)) ──
  // A well-implemented LU solve has tiny relative residual; a gross failure
  // here means pivoting went wrong, and a null result is far better than
  // silently wrong node voltages.
  let maxRes = 0;
  let maxAx = 0;
  let maxB = 0;
  for (let i = 0; i < n; i++) {
    const bAbs = Math.abs(z[i]);
    if (bAbs > maxB) maxB = bAbs;
  }
  for (let r = 0; r < n; r++) {
    let s = 0;
    for (let e = rowPtr[r]; e < rowPtr[r + 1]; e++) s += vals[e] * x[cols[e]];
    const axAbs = Math.abs(s);
    if (axAbs > maxAx) maxAx = axAbs;
    const res = Math.abs(s - z[r]);
    if (!isFinite(res)) return null;
    if (res > maxRes) maxRes = res;
  }
  const scale = Math.max(1, maxB, maxAx);
  if (maxRes > RESIDUAL_TOL * scale) return null;

  return x;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: should this circuit use the sparse solver?
// Below ~80 unknowns the dense solver's tight typed-array loops win; above,
// the O(flops) sparse factorization dominates. (Memory is O(nnz) either way
// for the sparse path — the dense path's O(n²) matrix is what stops scaling.)
// ─────────────────────────────────────────────────────────────────────────────

export function shouldUseSparseSolver(numNodes: number, numExtra: number): boolean {
  return numNodes + numExtra > 80;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge: hand a SparseMnaSystem to plugins that expect an MnaSystem.
//
// The two interfaces share every member plugins actually use (stamp* methods,
// addExtra, z, nextExtra, size, numNodes, numExtra). The sparse system has no
// dense `A`, but nothing on the plugin path reads `A` — verified across all
// component files. The engine is the only code that touches the system after
// stamping, and its post-stamp handling branches on which path it built.
//
// CRITICAL (historical): this must return the sparse system itself, NOT a
// copy — the engine mutates it after stamping (nextExtra reset, truncation).
// ─────────────────────────────────────────────────────────────────────────────

export function asMnaSystem(sparse: SparseMnaSystem): MnaSystem {
  return sparse as unknown as MnaSystem;
}
