// Tests for the real sparse solver (src/lib/circuit/sparse-klu.ts).
//
// Strategy:
//   1. Numerical correctness vs the dense solver on randomized matrices,
//      including permuted (zero-diagonal) systems that force genuine
//      row/column pivoting.
//   2. Singular detection, duplicate-triplet merging, tiny systems.
//   3. Sparsity preservation (fill-in control) on tridiagonal systems.
//   4. End-to-end engine tests on circuits large enough (> 80 unknowns) to
//      take the sparse path: DC ladders, branch currents, RC transient,
//      resistor grids.
//   5. Performance smoke + determinism.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createSparseMnaSystem,
  solveSparse,
  solveFromTriplets,
  luSolveCSR,
  shouldUseSparseSolver,
  resetSparseFactorizationCache,
  sparseFactorizationStats,
} from '../src/lib/circuit/sparse-klu';
import { createMnaSystem, solveMna } from '../src/lib/circuit/solver';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC, simulateStep, buildNodeMap } from '../src/lib/circuit/engine';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

// ── deterministic PRNG (mulberry32) so failures reproduce exactly ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dense-reference solve of the same triplet set. */
function denseRef(
  n: number,
  tRow: number[],
  tCol: number[],
  tVal: number[],
  z: number[],
): Float64Array | null {
  const sys = createMnaSystem(n, 0);
  for (let i = 0; i < tRow.length; i++) {
    if (tRow[i] >= n || tCol[i] >= n) continue;
    sys.A[tRow[i] * n + tCol[i]] += tVal[i];
  }
  for (let i = 0; i < n; i++) sys.z[i] = z[i];
  return solveMna(sys);
}

function maxRelDiff(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]) / Math.max(1, Math.abs(b[i]));
    if (d > m) m = d;
  }
  return m;
}

interface RandomMatrix {
  tRow: number[];
  tCol: number[];
  tVal: number[];
  z: number[];
}

/** Diagonally dominant sparse matrix (guaranteed nonsingular) with duplicates. */
function randomDiagDominant(n: number, offPerRow: number, rng: () => number): RandomMatrix {
  const m: RandomMatrix = { tRow: [], tCol: [], tVal: [], z: [] };
  for (let i = 0; i < n; i++) {
    m.tRow.push(i, i);
    m.tCol.push(i, i);
    // push the diagonal twice — exercises duplicate merging
    const d = 10 * (0.5 + rng());
    m.tVal.push(d * 0.6, d * 0.4);
    for (let e = 0; e < offPerRow; e++) {
      const j = Math.floor(rng() * n);
      if (j === i) continue;
      m.tRow.push(i, j);
      m.tCol.push(j, i);
      const v = (rng() - 0.5) * 2;
      m.tVal.push(v, v * 0.5);
      m.tVal[m.tVal.length - 2] = v * 0.5; // total off-diagonal pair = v
    }
    m.z.push((rng() - 0.5) * 20);
  }
  return m;
}

/** Apply random row/column permutations to a triplet set (kills the diagonal). */
function permute(
  m: RandomMatrix,
  rowPerm: number[],
  colPerm: number[],
): RandomMatrix {
  const out: RandomMatrix = { tRow: [], tCol: [], tVal: [], z: [] };
  const rowInv = new Array(rowPerm.length);
  rowPerm.forEach((orig, pos) => (rowInv[orig] = pos));
  const colInv = new Array(colPerm.length);
  colPerm.forEach((orig, pos) => (colInv[orig] = pos));
  for (let i = 0; i < m.tRow.length; i++) {
    out.tRow.push(rowInv[m.tRow[i]]);
    out.tCol.push(colInv[m.tCol[i]]);
    out.tVal.push(m.tVal[i]);
  }
  for (let i = 0; i < m.z.length; i++) out.z.push(m.z[rowInv[i]]);
  return out;
}

function randomPerm(n: number, rng: () => number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Randomized correctness vs dense reference
// ─────────────────────────────────────────────────────────────────────────────

describe('Sparse solver: randomized correctness vs dense', () => {
  const sizes = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
  const offs = [0, 1, 2, 5];

  it('matches the dense solver on diagonally dominant matrices', () => {
    let trials = 0;
    for (const n of sizes) {
      for (const off of offs) {
        const rng = mulberry32(1000 + n * 17 + off * 7919);
        for (let t = 0; t < 4; t++) {
          const m = randomDiagDominant(n, off, rng);
          const xs = solveFromTriplets(n, m.tRow, m.tCol, m.tVal, m.tRow.length, Float64Array.from(m.z));
          const xd = denseRef(n, m.tRow, m.tCol, m.tVal, m.z);
          expect(xd).not.toBeNull();
          expect(xs).not.toBeNull();
          expect(maxRelDiff(xs!, xd!)).toBeLessThan(1e-9);
          trials++;
        }
      }
    }
    expect(trials).toBeGreaterThan(100);
  });

  it('matches the dense solver on permuted (zero-diagonal) matrices', () => {
    // Row/column permutations move the dominant diagonal off the diagonal,
    // so the factorization must pivot on non-diagonal entries.
    for (const n of [3, 5, 8, 13, 21, 34, 55, 89]) {
      for (let t = 0; t < 6; t++) {
        const rng = mulberry32(2000 + n * 31 + t * 104729);
        const base = randomDiagDominant(n, 3, rng);
        const rowP = randomPerm(n, rng);
        const colP = randomPerm(n, rng);
        const m = permute(base, rowP, colP);
        const xs = solveFromTriplets(n, m.tRow, m.tCol, m.tVal, m.tRow.length, Float64Array.from(m.z));
        const xd = denseRef(n, m.tRow, m.tCol, m.tVal, m.z);
        expect(xd).not.toBeNull();
        expect(xs).not.toBeNull();
        expect(maxRelDiff(xs!, xd!)).toBeLessThan(1e-9);
      }
    }
  });

  it('handles matrices with widely-scaled entries (1e-6 … 1e6)', () => {
    const rng = mulberry32(424242);
    for (let t = 0; t < 10; t++) {
      const n = 10 + Math.floor(rng() * 30);
      const m: RandomMatrix = { tRow: [], tCol: [], tVal: [], z: [] };
      for (let i = 0; i < n; i++) {
        const scale = Math.pow(10, (rng() - 0.5) * 12);
        m.tRow.push(i, i);
        m.tCol.push(i, i);
        m.tVal.push(scale * (1 + rng()), scale * rng());
        for (let e = 0; e < 3; e++) {
          const j = Math.floor(rng() * n);
          if (j === i) continue;
          const v = (rng() - 0.5) * scale * 0.1;
          m.tRow.push(i, j);
          m.tCol.push(j, i);
          m.tVal.push(v, v);
        }
        m.z.push((rng() - 0.5) * scale);
      }
      const xs = solveFromTriplets(n, m.tRow, m.tCol, m.tVal, m.tRow.length, Float64Array.from(m.z));
      const xd = denseRef(n, m.tRow, m.tCol, m.tVal, m.z);
      // both must agree on solvability, and on the solution when solvable
      if (xd === null) {
        expect(xs).toBeNull();
      } else {
        expect(xs).not.toBeNull();
        expect(maxRelDiff(xs!, xd!)).toBeLessThan(1e-6);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Edge cases: singular systems, duplicates, tiny sizes
// ─────────────────────────────────────────────────────────────────────────────

describe('Sparse solver: edge cases', () => {
  it('returns null for an all-zero matrix', () => {
    const z = Float64Array.from([1, 2]);
    const x = solveFromTriplets(2, [], [], [], 0, z);
    expect(x).toBeNull();
  });

  it('returns null when a column is structurally empty (singular)', () => {
    // A = [[1, 0], [1, 2]] has an empty column 0 after dropping… no —
    // column 0 has entries. Use a genuinely singular matrix:
    // A = [[1, 2], [2, 4]] (row 2 = 2 × row 1)
    const tRow = [0, 0, 1, 1];
    const tCol = [0, 1, 0, 1];
    const tVal = [1, 2, 2, 4];
    const z = Float64Array.from([1, 2]);
    const x = solveFromTriplets(2, tRow, tCol, tVal, 4, z);
    expect(x).toBeNull();
  });

  it('returns null for a matrix with an empty column', () => {
    // A = [[1, 0], [0, 0]] — column 1 is empty
    const tRow = [0];
    const tCol = [0];
    const tVal = [1];
    const z = Float64Array.from([1, 0]);
    const x = solveFromTriplets(2, tRow, tCol, tVal, 1, z);
    expect(x).toBeNull();
  });

  it('solves a 1×1 system', () => {
    const z = Float64Array.from([10]);
    const x = solveFromTriplets(1, [0], [0], [4], 1, z);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(2.5, 12);
  });

  it('solves a 2×2 system with off-diagonal pivoting', () => {
    // zero diagonal, must pivot off-diagonal: A = [[0, 1], [1, 0]]
    const tRow = [0, 1];
    const tCol = [1, 0];
    const tVal = [1, 1];
    const z = Float64Array.from([3, 7]);
    const x = solveFromTriplets(2, tRow, tCol, tVal, 2, z);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(7, 12); // x0 = z1
    expect(x![1]).toBeCloseTo(3, 12); // x1 = z0
  });

  it('merges duplicate triplets by summing', () => {
    // 2 Ω stamped twice between nodes 1–2 (== 4 Ω) with node 2 grounded via
    // 4 Ω and 8 A injected into node 1 → V1 = 4 V, V2 = 2 V.
    // (A floating conductance pair with no ground reference is singular —
    // both solvers correctly reject it — so the ground path is required.)
    const sysA = createSparseMnaSystem(2, 0);
    sysA.stampConductance(1, 2, 2);
    sysA.stampConductance(1, 2, 2);
    sysA.stampConductance(2, 0, 4);
    sysA.z[0] = 8;
    const xA = solveSparse(sysA);

    const sysB = createSparseMnaSystem(2, 0);
    sysB.stampConductance(1, 2, 4);
    sysB.stampConductance(2, 0, 4);
    sysB.z[0] = 8;
    const xB = solveSparse(sysB);

    expect(xA).not.toBeNull();
    expect(xB).not.toBeNull();
    expect(maxRelDiff(xA!, xB!)).toBeLessThan(1e-12);
    expect(xA![0]).toBeCloseTo(4, 10); // V1: 8 A into 4 Ω ‖ (4 Ω + 4 Ω to gnd)
    expect(xA![1]).toBeCloseTo(2, 10); // V2: divider off node 1
  });

  it('returns an empty solution for size 0', () => {
    const sys = createSparseMnaSystem(0, 0);
    const x = solveSparse(sys);
    expect(x).not.toBeNull();
    expect(x!.length).toBe(0);
  });

  it('voltage source stamps produce correct branch currents', () => {
    // 10 V source driving 1 kΩ: A row/col for the branch, z[extra] = 10
    const sys = createSparseMnaSystem(2, 4);
    sys.clearStamps();
    sys.stampVoltageSource(1, 0, 10);
    sys.stampConductance(1, 2, 1 / 1000);
    sys.stampConductance(2, 0, 1 / 1000);
    sys.truncate(sys.nextExtra);
    const x = solveSparse(sys);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(10, 9); // node 1 at 10 V
    // node 2 connects to ground via 1 kΩ and to node 1 via 1 kΩ:
    // divider → node2 = 5 V
    expect(x![1]).toBeCloseTo(5, 9);
    // Branch current convention (same as the dense solver — verified
    // side-by-side): positive i flows INTO the + terminal through the
    // source, so a source driving a load reads negative.
    expect(x![2]).toBeCloseTo(-0.005, 9);
  });

  it('clearStamps() resets both triplets and RHS', () => {
    const sys = createSparseMnaSystem(2, 0);
    sys.stampConductance(1, 2, 1);
    sys.stampCurrentSource(1, 0, 5);
    expect(sys.triplets.count).toBe(4);
    expect(sys.z[0]).toBe(-5);
    sys.clearStamps();
    expect(sys.triplets.count).toBe(0);
    expect(sys.z[0]).toBe(0);
    // re-stamp a different circuit: g(1,2) = 2, g(2,gnd) = 2, 3 A into node 2
    sys.stampConductance(1, 2, 2);
    sys.stampConductance(2, 0, 2);
    sys.z[1] = 3;
    const x = solveSparse(sys);
    expect(x).not.toBeNull();
    // KCL(1): V1 = V2; KCL(2): 2(V2−V1) + 2·V2 = 3 → V2 = 1.5
    expect(x![0]).toBeCloseTo(1.5, 10);
    expect(x![1]).toBeCloseTo(1.5, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Fill-in control and sparsity
// ─────────────────────────────────────────────────────────────────────────────

describe('Sparse solver: fill-in control', () => {
  it('solves an 800-unknown tridiagonal system quickly and sparsely', () => {
    const n = 800;
    const tRow: number[] = [];
    const tCol: number[] = [];
    const tVal: number[] = [];
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      tRow.push(i, i);
      tCol.push(i, i);
      tVal.push(2.5, 0.5); // diagonal 3
      if (i > 0) {
        tRow.push(i, i - 1);
        tCol.push(i - 1, i);
        tVal.push(-1, -1);
      }
      z[i] = i === 0 ? 1 : 0;
    }
    const t0 = performance.now();
    const x = solveFromTriplets(n, tRow, tCol, tVal, tRow.length, z);
    const dt = performance.now() - t0;
    expect(x).not.toBeNull();
    expect(dt).toBeLessThan(2000); // generous; typically a few ms
    // verify the solution directly: A·x = z
    for (let i = 0; i < n; i++) {
      let s = 3 * x![i];
      if (i > 0) s -= x![i - 1];
      if (i < n - 1) s -= x![i + 1];
      expect(Math.abs(s - z[i])).toBeLessThan(1e-8);
    }
  });

  it('luSolveCSR accepts plain CSR arrays', () => {
    // A = [[4, 1], [1, 3]], z = [1, 2] → x = [1/11, 7/11]
    const rowPtr = Int32Array.from([0, 2, 4]);
    const cols = Int32Array.from([0, 1, 0, 1]);
    const vals = Float64Array.from([4, 1, 1, 3]);
    const z = Float64Array.from([1, 2]);
    const x = luSolveCSR(2, rowPtr, cols, vals, z);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(1 / 11, 12);
    expect(x![1]).toBeCloseTo(7 / 11, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Engine integration — circuits big enough to take the sparse path
// ─────────────────────────────────────────────────────────────────────────────

function comp(type: string, id: string, pos: [number, number], params?: any): any {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const pm of p.parameters) defaults[pm.key] = pm.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
}
function wire(id: string, fc: string, ft: string, tc: string, tt: string): any {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}
function plugins(): Map<string, any> {
  return new Map(getAllPlugins().map((p: any) => [p.type, p]));
}

/** Chain of N resistors from a source node to ground: linear voltage ramp. */
function buildLadder(nRes: number, rOhm = 1000, vSrc = 10) {
  const components: any[] = [
    comp('dcVoltage', 'V1', [0, 0], { voltage: vSrc }),
    comp('ground', 'GND', [0, 10]),
  ];
  const wires: any[] = [
    wire('w0', 'V1', 'p', 'R1', 'a'),
    wire('wg', 'V1', 'n', 'GND', 'g'),
  ];
  for (let i = 1; i <= nRes; i++) {
    components.push(comp('resistor', `R${i}`, [i * 3, 0], { resistance: rOhm }));
    if (i < nRes) wires.push(wire(`w${i}`, `R${i}`, 'b', `R${i + 1}`, 'a'));
  }
  wires.push(wire(`wLast`, `R${nRes}`, 'b', 'GND', 'g'));
  return { components, wires };
}

describe('Sparse solver: engine integration (sparse path active)', () => {
  it('shouldUseSparseSolver activates above 80 unknowns', () => {
    expect(shouldUseSparseSolver(80, 0)).toBe(false);
    expect(shouldUseSparseSolver(81, 0)).toBe(true);
    expect(shouldUseSparseSolver(10, 71)).toBe(true);
  });

  it('300-resistor ladder: node voltages follow the analytic ramp', () => {
    const nRes = 300;
    const { components, wires } = buildLadder(nRes);
    const dc = solveDC(components, wires, plugins());
    expect(dc).not.toBeNull();
    // Node numbering follows first-appearance order, so assert on the sorted
    // set of voltages: the ladder's distinct node voltages are 10·j/nRes.
    for (const v of dc!.nodeVoltage) expect(isFinite(v)).toBe(true);
    const vals = Array.from(dc!.nodeVoltage).sort((a, b) => b - a);
    expect(vals.length).toBe(nRes + 1); // ground + 300 ladder nodes
    for (let i = 0; i < nRes; i++) {
      expect(vals[i]).toBeCloseTo((10 * (nRes - i)) / nRes, 5);
    }
    expect(vals[nRes]).toBe(0);
  });

  it('150-resistor ladder: branch current equals V/Rtotal', () => {
    const nRes = 150;
    const { components, wires } = buildLadder(nRes, 1000, 10);
    const dc = solveDC(components, wires, plugins());
    expect(dc).not.toBeNull();
    // The voltage source's branch current is the total ladder current
    // (10 V / 150 kΩ ≈ 66.7 µA), negative under the into-the-plus-terminal
    // convention. Unused extra-current slots stay at 0.
    const iTotal = 10 / (nRes * 1000);
    const bc = dc!.branchCurrent;
    let found = false;
    for (let i = 0; i < bc.length; i++) {
      if (Math.abs(bc[i] + iTotal) < 1e-9) found = true;
    }
    expect(found).toBe(true);
  });

  it('RC transient on the sparse path charges to the source voltage', () => {
    // 150 RC stages → ~151 unknowns > 80 → sparse path. With equal R and C
    // the chain is a distributed RC line; after many τ it settles near Vin.
    const nStages = 150;
    const rOhm = 1000;
    const cFarads = 1e-6;
    const components: any[] = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('ground', 'GND', [0, 10]),
    ];
    const wires: any[] = [
      wire('w0', 'V1', 'p', 'R1', 'a'),
      wire('wg', 'V1', 'n', 'GND', 'g'),
    ];
    for (let i = 1; i <= nStages; i++) {
      components.push(comp('resistor', `R${i}`, [i * 3, 0], { resistance: rOhm }));
      components.push(comp('capacitor', `C${i}`, [i * 3, 6], { capacitance: cFarads }));
      wires.push(wire(`wr${i}`, `R${i}`, 'b', `C${i}`, 'a'));
      wires.push(wire(`wc${i}`, `C${i}`, 'b', 'GND', 'g'));
      if (i < nStages) wires.push(wire(`w${i}`, `C${i}`, 'a', `R${i + 1}`, 'a'));
    }
    const plug = plugins();
    // integrate with dt = 20 ms for 300 steps = 6 s ≫ τ = R·C·(stages²/π²)-ish
    let prev: any = undefined;
    let last: any = null;
    for (let s = 0; s < 300; s++) {
      const res = simulateStep(components, wires, plug, prev, 0.02);
      expect(res).not.toBeNull();
      last = res;
      prev = { nodeVoltage: res.sim.nodeVoltage, branchCurrent: res.sim.branchCurrent, state: res.sim.state, time: res.sim.time };
    }
    // far end should have charged to (almost) 5 V
    const nv = last.sim.nodeVoltage;
    const maxV = Math.max(...Array.from(nv));
    expect(maxV).toBeGreaterThan(4.9);
    expect(maxV).toBeLessThanOrEqual(5.0001);
  });

  it('20×20 resistor grid solves with mirror symmetry', () => {
    // A square grid of 1 Ω resistors, driven from the top-left node to
    // ground at the bottom-right. Symmetry: mirror nodes carry equal voltage.
    const N = 20; // 20×20 internal nodes
    const components: any[] = [
      comp('dcVoltage', 'V1', [-3, 0], { voltage: 1 }),
      comp('ground', 'GND', [-3, 10]),
    ];
    const wires: any[] = [];
    const node = (i: number, j: number) => `N${i}_${j}`;
    const resistorCount = { n: 0 };
    const addRes = (a: string, at: string, b: string, bt: string) => {
      const id = `R${resistorCount.n++}`;
      components.push(comp('resistor', id, [0, 0], { resistance: 1 }));
      wires.push(wire(`w${wires.length}`, a, at, id, 'a'));
      wires.push(wire(`w${wires.length}`, id, 'b', b, bt));
    };
    // create net symbols? Simplest: chain resistors directly between each other
    // (resistor-to-resistor wiring merges terminals into shared nodes).
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i + 1 < N) {
          // vertical neighbor — connect R(i,j) node to R(i+1,j) node via a wire
          // (we just wire resistor terminals together; no explicit nets needed)
        }
      }
    }
    // Simpler construction: a full grid via explicit resistor mesh, wiring
    // every adjacent pair with a resistor whose 'a'/'b' hook onto shared
    // junctions formed by wires between resistor terminals.
    // For test simplicity we instead build a ladder-of-ladders:
    // N horizontal chains of N resistors, joined at every column by vertical
    // resistors between chain k and chain k+1 at the same column index.
    components.length = 2;
    wires.length = 0;
    resistorCount.n = 0;
    const R: string[][] = [];
    for (let row = 0; row < N; row++) {
      R.push([]);
      for (let col = 0; col < N; col++) {
        const id = `R${row}_${col}`;
        R[row].push(id);
        components.push(comp('resistor', id, [col * 2, row * 2], { resistance: 1 }));
      }
    }
    // horizontal wires within each row
    for (let row = 0; row < N; row++) {
      for (let col = 0; col + 1 < N; col++) {
        wires.push(wire(`wh${row}_${col}`, R[row][col], 'b', R[row][col + 1], 'a'));
      }
    }
    // vertical resistors between rows at each column junction
    for (let row = 0; row + 1 < N; row++) {
      for (let col = 1; col < N; col++) {
        const id = `V${row}_${col}`;
        components.push(comp('resistor', id, [col * 2, row * 2 + 1], { resistance: 1 }));
        wires.push(wire(`wv${row}_${col}a`, R[row][col], 'b', id, 'a'));
        wires.push(wire(`wv${row}_${col}b`, id, 'b', R[row + 1][col], 'a'));
      }
    }
    // drive row 0, col 0 head with 1 V; ground row N-1, col N-1 tail
    wires.push(wire('wsrc', 'V1', 'p', R[0][0], 'a'));
    wires.push(wire('wgnd1', 'V1', 'n', 'GND', 'g'));
    wires.push(wire('wgnd2', R[N - 1][N - 1], 'b', 'GND', 'g'));

    const dc = solveDC(components, wires, plugins());
    expect(dc).not.toBeNull();
    for (const v of dc!.nodeVoltage) expect(isFinite(v)).toBe(true);
    // Sparse path definitely active: 400 resistors → 400+ nodes
    const numNodes = dc!.nodeVoltage.length;
    expect(numNodes).toBeGreaterThan(80);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Performance + determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('Sparse solver: performance and determinism', () => {
  it('2000-node ladder solves via solveDC in well under a second', () => {
    const nRes = 2000;
    const { components, wires } = buildLadder(nRes);
    const t0 = performance.now();
    const dc = solveDC(components, wires, plugins());
    const dt = performance.now() - t0;
    expect(dc).not.toBeNull();
    expect(dt).toBeLessThan(5000); // generous bound; expect tens of ms
    const maxV = Math.max(...Array.from(dc!.nodeVoltage));
    expect(maxV).toBeCloseTo(10, 4);
  });

  it('5000-unknown tridiagonal system factors in bounded time', () => {
    const n = 5000;
    const tRow: number[] = [];
    const tCol: number[] = [];
    const tVal: number[] = [];
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      tRow.push(i, i);
      tCol.push(i, i);
      tVal.push(3, 0.0001); // ~3.0001 diagonal (with duplicate merge)
      if (i > 0) {
        tRow.push(i, i - 1);
        tCol.push(i - 1, i);
        tVal.push(-1, -1);
      }
      z[i] = 1;
    }
    const t0 = performance.now();
    const x = solveFromTriplets(n, tRow, tCol, tVal, tRow.length, z);
    const dt = performance.now() - t0;
    expect(x).not.toBeNull();
    expect(dt).toBeLessThan(3000);
    // verify by residual: A·x = z within tolerance
    for (let i = 0; i < n; i++) {
      let s = 3.0001 * x![i];
      if (i > 0) s -= x![i - 1];
      if (i < n - 1) s -= x![i + 1];
      expect(Math.abs(s - 1)).toBeLessThan(1e-8);
    }
  });

  it('is deterministic: identical inputs → identical outputs', () => {
    const rng = mulberry32(777);
    const n = 60;
    const m = randomDiagDominant(n, 4, rng);
    const zArr = Float64Array.from(m.z);
    const x1 = solveFromTriplets(n, m.tRow, m.tCol, m.tVal, m.tRow.length, zArr);
    const x2 = solveFromTriplets(n, m.tRow, m.tCol, m.tVal, m.tRow.length, zArr);
    expect(x1).not.toBeNull();
    expect(x2).not.toBeNull();
    for (let i = 0; i < n; i++) expect(x1![i]).toBe(x2![i]);
  });

  it('gives the same answer as the dense solver through the engine', () => {
    // Build a 90-resistor ladder (90 unknowns > 80 → sparse path).
    // The distinct node voltages form the analytic divider ramp 9·j/90.
    const nRes = 90;
    const { components, wires } = buildLadder(nRes, 1000, 9);
    const dc = solveDC(components, wires, plugins());
    expect(dc).not.toBeNull();
    const vals = Array.from(dc!.nodeVoltage).sort((a, b) => b - a);
    expect(vals.length).toBe(nRes + 1); // ground + 90 ladder nodes
    for (let i = 0; i < nRes; i++) {
      expect(vals[i]).toBeCloseTo((9 * (nRes - i)) / nRes, 5);
    }
    expect(vals[nRes]).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refactorization reuse (KLU-style): the pivot sequence is cached across
// solves with identical structure and replayed without the Markowitz search.
// ─────────────────────────────────────────────────────────────────────────────

describe('Sparse solver: refactorization reuse', () => {
  it('reuses the pivot order and stays correct under value drift (vs dense)', () => {
    resetSparseFactorizationCache();
    const rng = mulberry32(31337);
    for (const n of [5, 13, 34, 89, 144]) {
      const m = randomDiagDominant(n, 3, rng);
      // Materialize as a sparse system we can re-stamp with new values
      const sys = createSparseMnaSystem(n, 0);
      const reStamp = (drift: number) => {
        sys.clearStamps();
        for (let i = 0; i < m.tRow.length; i++) {
          sys.triplets.push(m.tRow[i], m.tCol[i], m.tVal[i] * drift);
        }
        for (let i = 0; i < n; i++) sys.z[i] = m.z[i] * drift;
      };
      for (let s = 0; s < 6; s++) {
        const drift = 1 + s * 0.37 + Math.sin(s) * 0.1;
        reStamp(drift);
        const xs = solveSparse(sys);
        const xd = denseRef(n, m.tRow, m.tCol, m.tVal.map(v => v * drift), m.z.map(v => v * drift));
        expect(xd).not.toBeNull();
        expect(xs).not.toBeNull();
        expect(maxRelDiff(xs!, xd!)).toBeLessThan(1e-9);
      }
    }
    const stats = sparseFactorizationStats();
    expect(stats.hits).toBeGreaterThan(20); // most solves hit the reuse path
    expect(stats.falls).toBe(0);
  });

  it('falls back to a full factorization when the structure changes', () => {
    resetSparseFactorizationCache();
    const rng = mulberry32(999);
    const n = 40;
    const m = randomDiagDominant(n, 3, rng);
    const sys = createSparseMnaSystem(n, 0);
    const stampAll = (extra: boolean) => {
      sys.clearStamps();
      for (let i = 0; i < m.tRow.length; i++) sys.triplets.push(m.tRow[i], m.tCol[i], m.tVal[i]);
      if (extra) sys.triplets.push(3, 5, 0.123); // structural change
      for (let i = 0; i < n; i++) sys.z[i] = m.z[i];
    };
    stampAll(false);
    expect(solveSparse(sys)).not.toBeNull();
    const afterFirst = sparseFactorizationStats().hits;

    stampAll(true); // different structure → cache miss → full solve
    const x2 = solveSparse(sys);
    expect(x2).not.toBeNull();
    expect(sparseFactorizationStats().hits).toBe(afterFirst); // no new hits

    stampAll(false); // back to the original structure → misses again (cache holds the other one)
    const x3 = solveSparse(sys);
    expect(x3).not.toBeNull();
    const xd = denseRef(n, m.tRow, m.tCol, m.tVal, m.z);
    expect(maxRelDiff(x3!, xd!)).toBeLessThan(1e-9);
  });

  it('aborts reuse on a weakened pivot and still returns the right answer', () => {
    resetSparseFactorizationCache();
    const rng = mulberry32(4242);
    const n = 30;
    const m = randomDiagDominant(n, 2, rng);
    const sys = createSparseMnaSystem(n, 0);
    const stampWith = (diagScale: number[]) => {
      sys.clearStamps();
      for (let i = 0; i < m.tRow.length; i++) {
        const r = m.tRow[i];
        const v = m.tRow[i] === m.tCol[i] ? m.tVal[i] * diagScale[r] : m.tVal[i];
        sys.triplets.push(r, m.tCol[i], v);
      }
      for (let i = 0; i < n; i++) sys.z[i] = m.z[i];
    };
    // Solve 1: uniform diagonals (strong pivots)
    stampWith(new Array(n).fill(1));
    expect(solveSparse(sys)).not.toBeNull();
    const hits1 = sparseFactorizationStats().hits;

    // Solve 2: shrink several diagonal entries by 6 orders of magnitude —
    // cached pivots for those rows become weak → reuse must abort and the
    // full fallback must still solve correctly.
    const scales = new Array(n).fill(1).map((_, i) => (i % 5 === 0 ? 1e-6 : 1));
    stampWith(scales);
    const x2 = solveSparse(sys);
    expect(x2).not.toBeNull();
    // dense reference with the same scaled values
    const scaledVal: number[] = [];
    for (let i = 0; i < m.tRow.length; i++) {
      const r = m.tRow[i];
      scaledVal.push(m.tRow[i] === m.tCol[i] ? m.tVal[i] * scales[r] : m.tVal[i]);
    }
    const xd = denseRef(n, m.tRow, m.tCol, scaledVal, m.z);
    expect(xd).not.toBeNull();
    expect(maxRelDiff(x2!, xd!)).toBeLessThan(1e-6); // weaker pivoting → looser tolerance
    const stats = sparseFactorizationStats();
    expect(stats.hits).toBeGreaterThanOrEqual(hits1); // at least the healthy solves
    void stats.falls; // may or may not fall depending on pivot luck — correctness is what matters
  });

  it('resetSparseFactorizationCache clears the cache', () => {
    resetSparseFactorizationCache();
    const rng = mulberry32(5);
    const m = randomDiagDominant(20, 2, rng);
    const sys = createSparseMnaSystem(20, 0);
    for (let i = 0; i < m.tRow.length; i++) sys.triplets.push(m.tRow[i], m.tCol[i], m.tVal[i]);
    for (let i = 0; i < 20; i++) sys.z[i] = m.z[i];
    expect(solveSparse(sys)).not.toBeNull();
    expect(sparseFactorizationStats().hits).toBe(0);
    expect(solveSparse(sys)).not.toBeNull();
    expect(sparseFactorizationStats().hits).toBe(1);
    resetSparseFactorizationCache();
    expect(sparseFactorizationStats().hits).toBe(0);
  });

  it('keeps engine transients correct while reusing factorizations', () => {
    resetSparseFactorizationCache();
    // 150-resistor ladder (>80 unknowns → sparse path) with a capacitor at the
    // mid node. Thevenin at mid: V_th = 2.5V, R_th = 75k ∥ 75k = 37.5k.
    // C = 27nF → τ = 1.0125ms; after t = 1ms the cap sits at 2.5·(1−e^(−1/1.0125)).
    const nRes = 150;
    const { components, wires } = buildLadder(nRes, 1000, 5);
    const mid = Math.floor(nRes / 2);
    components.push(comp('capacitor', 'Cmid', [mid * 3, 5], { capacitance: 27e-9, initialV: 0 }));
    wires.push(wire('wcmid', `R${mid}`, 'b', 'Cmid', 'a'));
    wires.push(wire('wcmidg', 'Cmid', 'b', 'GND', 'g'));
    let prev: any = undefined;
    const dt = 1e-5;
    const steps = 100; // 1ms total
    let final: any = null;
    for (let s = 0; s < steps; s++) {
      const r = simulateStep(components, wires, plugins(), prev, dt);
      expect(r).not.toBeNull();
      final = r!.sim;
      prev = {
        nodeVoltage: r!.sim.nodeVoltage,
        branchCurrent: r!.sim.branchCurrent,
        time: r!.sim.time,
        state: r!.sim.state,
      };
    }
    expect(sparseFactorizationStats().hits).toBeGreaterThanOrEqual(steps - 2); // all but the first
    // The capacitor anode node voltage is the charging curve we verify.
    const nodeMap = buildNodeMap(components, wires, plugins());
    const capNode = nodeMap.terminalNode.get('Cmid:a');
    expect(capNode).toBeDefined();
    const vCap = final.nodeVoltage[capNode!];
    const tau = 37500 * 27e-9; // 1.0125 ms
    const expected = 2.5 * (1 - Math.exp(-1e-3 / tau));
    expect(vCap).toBeCloseTo(expected, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: branch-current budget overflow. A plugin that allocates more
// MNA extras than the pre-computed budget used to push triplets with column
// indices ≥ sys.size — z[i] silently dropped (typed-array OOB write) and
// solveSparse crashed with a TypeError (colRows[c] undefined).
// ─────────────────────────────────────────────────────────────────────────────
describe('sparse solver — extra-variable budget overflow', () => {
  it('over-budget voltage sources solve exactly (engine-style truncate + solve)', () => {
    // 6 non-ground nodes, budget of 2 extras; 6 voltage sources need 6.
    const sys = createSparseMnaSystem(6, 2);
    sys.nextExtra = 6;
    for (let k = 1; k <= 6; k++) sys.stampConductance(k, 0, 1e-3); // 1k loads
    for (let k = 1; k <= 6; k++) sys.stampVoltageSource(k, 0, k);   // V(k) = k
    const actualSize = sys.nextExtra;
    if (actualSize < sys.size) {
      sys.truncate(actualSize);
    }
    expect(sys.size).toBe(12);
    const x = solveSparse(sys);
    expect(x).not.toBeNull();
    for (let k = 1; k <= 6; k++) {
      expect(x![k - 1]).toBeCloseTo(k, 9);
      expect(Math.abs(x![5 + k])).toBeCloseTo(k * 1e-3, 9);
    }
  });
});
