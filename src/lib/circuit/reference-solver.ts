// Independent reference MNA solver for cross-validation.
export interface ReferenceSolveResult {
  voltages: Map<string, number>;
  currents: Map<string, number>;
  branchCurrents: Map<string, number>;
  ok: boolean;
  error?: string;
}

export class ReferenceSolver {
  private nodeIds = new Map<string, number>();
  private stamps: any[] = [];
  private nextNodeId = 1;

  addNode(name: string): number {
    if (name === '0' || name === 'gnd') return 0;
    if (this.nodeIds.has(name)) return this.nodeIds.get(name)!;
    const id = this.nextNodeId++;
    this.nodeIds.set(name, id);
    return id;
  }

  nodeId(name: string): number {
    if (name === '0' || name === 'gnd') return 0;
    return this.nodeIds.get(name) ?? 0;
  }

  get numNodes(): number { return this.nextNodeId; }

  stampR(n1: string, n2: string, r: number) {
    if (r === 0) r = 1e-12;
    this.stamps.push({ type: 'R', nodes: [n1, n2], value: r });
  }
  stampV(n1: string, n2: string, voltage: number, name: string) {
    this.stamps.push({ type: 'V', nodes: [n1, n2], value: voltage, name });
  }
  stampI(n1: string, n2: string, current: number) {
    this.stamps.push({ type: 'I', nodes: [n1, n2], value: current });
  }
  stampVCCS(n1: string, n2: string, c1: string, c2: string, gm: number) {
    this.stamps.push({ type: 'VCCS', nodes: [n1, n2, c1, c2], value: gm });
  }
  stampVCVS(n1: string, n2: string, c1: string, c2: string, mu: number, name: string) {
    this.stamps.push({ type: 'VCVS', nodes: [n1, n2, c1, c2], value: mu, name });
  }
  stampCCCS(n1: string, n2: string, ctrlBranch: string, beta: number) {
    this.stamps.push({ type: 'CCCS', nodes: [n1, n2, ctrlBranch], value: beta });
  }
  stampCCVS(n1: string, n2: string, ctrlBranch: string, r: number, name: string) {
    this.stamps.push({ type: 'CCVS', nodes: [n1, n2, ctrlBranch], value: r, name });
  }

  solve(): ReferenceSolveResult {
    for (const s of this.stamps) {
      for (const n of s.nodes) {
        if (typeof n === 'string' && n !== '0' && n !== 'gnd') this.addNode(n);
      }
    }
    const n = this.nextNodeId - 1;
    let branchCount = 0;
    const branchNames: string[] = [];
    const branchIndices = new Map<string, number>();
    for (const s of this.stamps) {
      if (s.type === 'V' || s.type === 'VCVS' || s.type === 'CCVS') {
        const idx = branchCount++;
        branchNames.push(s.name);
        branchIndices.set(s.name, idx);
      }
    }
    const m = branchCount;
    const size = n + m;
    if (size === 0) return { voltages: new Map([['0', 0]]), currents: new Map(), branchCurrents: new Map(), ok: true };
    const A: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
    const z: number[] = new Array(size).fill(0);
    const idx = (r: number, c: number) => r * size + c;

    for (const s of this.stamps) {
      const i1 = this.nodeId(s.nodes[0]);
      const i2 = this.nodeId(s.nodes[1]);
      if (s.type === 'R') {
        const g = 1 / s.value;
        if (i1 > 0) { A[i1-1][i1-1] += g; if (i2 > 0) A[i1-1][i2-1] -= g; }
        if (i2 > 0) { A[i2-1][i2-1] += g; if (i1 > 0) A[i2-1][i1-1] -= g; }
      } else if (s.type === 'I') {
        // Same convention as solver.ts stampCurrentSource: current flows OUT
        // of n1 and INTO n2 (KCL: z[n1] -= I, z[n2] += I).
        if (i1 > 0) z[i1-1] -= s.value;
        if (i2 > 0) z[i2-1] += s.value;
      } else if (s.type === 'V') {
        const bIdx = branchIndices.get(s.name)!;
        const col = n + bIdx;
        if (i1 > 0) { A[i1-1][col] += 1; A[col][i1-1] += 1; }
        if (i2 > 0) { A[i2-1][col] -= 1; A[col][i2-1] -= 1; }
        z[col] = s.value;
      } else if (s.type === 'VCCS') {
        // current from n1 to n2 (through the element) = gm * (V(c1) - V(c2))
        // (SPICE G-element convention — matches the main solver's stampVCCS)
        const ic1 = this.nodeId(s.nodes[2]);
        const ic2 = this.nodeId(s.nodes[3]);
        const gm = s.value;
        if (i1 > 0) { if (ic1 > 0) A[i1-1][ic1-1] += gm; if (ic2 > 0) A[i1-1][ic2-1] -= gm; }
        if (i2 > 0) { if (ic1 > 0) A[i2-1][ic1-1] -= gm; if (ic2 > 0) A[i2-1][ic2-1] += gm; }
      } else if (s.type === 'VCVS') {
        const ic1 = this.nodeId(s.nodes[2]);
        const ic2 = this.nodeId(s.nodes[3]);
        const bIdx = branchIndices.get(s.name)!;
        const col = n + bIdx;
        const mu = s.value;
        if (i1 > 0) { A[i1-1][col] += 1; A[col][i1-1] += 1; }
        if (i2 > 0) { A[i2-1][col] -= 1; A[col][i2-1] -= 1; }
        if (ic1 > 0) A[col][ic1-1] -= mu;
        if (ic2 > 0) A[col][ic2-1] += mu;
      } else if (s.type === 'CCCS') {
        // Current-controlled current source: I(n1→n2) = beta · I(ctrlBranch),
        // where the control variable is the current through the named branch
        // (a voltage source or CCVS). The control current is MNA extra-variable
        // x[ctrlCol], so we inject beta * x[ctrlCol] into the KCL of n1/n2.
        const ctrlCol = branchIndices.get(s.ctrlBranch);
        if (ctrlCol === undefined) continue; // control branch never registered → skip
        const col = n + ctrlCol;
        const beta = s.value;
        if (i1 > 0) A[i1-1][col] += beta;
        if (i2 > 0) A[i2-1][col] -= beta;
      } else if (s.type === 'CCVS') {
        // Current-controlled voltage source: V(n1)−V(n2) = r · I(ctrlBranch).
        // Adds an extra branch variable (the CCVS current) AND a KVL constraint
        // tying V(n1)−V(n2) to r·x[ctrlCol].
        const ctrlCol = branchIndices.get(s.ctrlBranch);
        const bIdx = branchIndices.get(s.name)!;
        const col = n + bIdx;
        const r = s.value;
        if (i1 > 0) { A[i1-1][col] += 1; A[col][i1-1] += 1; }
        if (i2 > 0) { A[i2-1][col] -= 1; A[col][i2-1] -= 1; }
        if (ctrlCol !== undefined) {
          const cc = n + ctrlCol;
          A[col][cc] -= r;
        }
      }
    }
    // Gaussian elimination
    for (let k = 0; k < size; k++) {
      let maxRow = k; let maxVal = Math.abs(A[k][k]);
      for (let i = k+1; i < size; i++) { const v = Math.abs(A[i][k]); if (v > maxVal) { maxVal = v; maxRow = i; } }
      if (maxVal < 1e-14) return { voltages: new Map([['0',0]]), currents: new Map(), branchCurrents: new Map(), ok: false, error: `singular at col ${k}` };
      if (maxRow !== k) { [A[k], A[maxRow]] = [A[maxRow], A[k]]; [z[k], z[maxRow]] = [z[maxRow], z[k]]; }
      const pivot = A[k][k];
      for (let i = k+1; i < size; i++) { const f = A[i][k] / pivot; if (f === 0) continue; for (let j = k; j < size; j++) A[i][j] -= f * A[k][j]; z[i] -= f * z[k]; }
    }
    const x = new Array(size).fill(0);
    for (let k = size-1; k >= 0; k--) { let sum = z[k]; for (let j = k+1; j < size; j++) sum -= A[k][j] * x[j]; x[k] = sum / A[k][k]; }
    const voltages = new Map<string, number>([['0', 0]]);
    for (const [name, id] of this.nodeIds) voltages.set(name, id > 0 ? x[id-1] : 0);
    const currents = new Map<string, number>();
    for (let i = 0; i < m; i++) { currents.set(branchNames[i], x[n+i]); }
    return { voltages, currents, branchCurrents: currents, ok: true };
  }
  reset() { this.nodeIds.clear(); this.stamps = []; this.nextNodeId = 1; }
}
