// Advanced device primitives — KiCad/ngspice parity.
//
// New plugin types:
//   - bvSource / biSource  — Behavioral V/I sources with expression parser
//   - vcSwitch / ccSwitch  — Voltage/current-controlled switches (S, W elements)
//   - coupledInductor     — Coupled inductors (K statement, mutual M = k*L1*L2)
//   - transLineLossless   — Lossless transmission line (T element, delay)
//   - transLineLossy      — Lossy transmission line (LTRA, RLCG model)
//   - vcvsUser / vccsUser / ccvsUser / cccsUser  — User-placeable E/G/F/H
//   - opampReal           — Real op-amp macromodel with GBW, slew rate, offset, CMRR

import type { ComponentPlugin, SimContext } from '../types';
import { registerPlugin } from '../registry';
import { drawLabel } from './draw';
import { stateKey } from '../state-keys';
import { spiceSwitch, spiceMutual2 } from '../spice-devices';
import { stampOpamp, stepOpamp, measureOpamp, acStampOpamp, specFromParams, opampParamDefs, type OpampPins } from './opamp-core';

// ─────────────────────────────────────────────────────────────────────────────
// Expression parser for behavioral sources
//   Supports: V(node1, node2), I(source), +, -, *, /, ^, exp, log, sin, cos,
//   abs, sqrt, min, max, table, limit, if, time (variable)
// ─────────────────────────────────────────────────────────────────────────────

type Token =
  | { type: 'num'; value: string; num: number }
  | { type: 'op' | 'func' | 'paren' | 'var'; value: string }
  | { type: 'vi'; value: string; args: string[] };

/** SPICE magnitude suffix → multiplier (case-insensitive; trailing unit letters ignored). */
function spiceSuffix(sfx: string): number {
  const s = sfx.toLowerCase();
  if (s.startsWith('meg')) return 1e6;
  if (s.startsWith('mil')) return 25.4e-6;
  switch (s[0]) {
    case 'f': return 1e-15;
    case 'p': return 1e-12;
    case 'n': return 1e-9;
    case 'u': return 1e-6;
    case 'm': return 1e-3;
    case 'k': return 1e3;
    case 'g': return 1e9;
    case 't': return 1e12;
    default: return 1;
  }
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(expr[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(expr.slice(i))!;
      i += m[0].length;
      let mult = 1;
      const sm = /^(?:µ|[a-zA-Z]+)/.exec(expr.slice(i));
      if (sm) {
        mult = sm[0][0] === 'µ' ? 1e-6 : spiceSuffix(sm[0]);
        i += sm[0].length;
      }
      tokens.push({ type: 'num', value: m[0], num: parseFloat(m[0]) * mult });
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let id = '';
      while (i < expr.length && /[a-zA-Z0-9_.$#]/.test(expr[i])) id += expr[i++];
      let j = i;
      while (j < expr.length && /\s/.test(expr[j])) j++;
      const isCall = expr[j] === '(';
      if (isCall && (id === 'V' || id === 'v' || id === 'I' || id === 'i')) {
        // capture the raw argument text up to the matching paren so node
        // names such as "R1:a" survive intact
        let depth = 0; let k = j; let raw = '';
        for (; k < expr.length; k++) {
          if (expr[k] === '(') { depth++; if (depth === 1) continue; }
          else if (expr[k] === ')') { depth--; if (depth === 0) break; }
          raw += expr[k];
        }
        i = k + 1;
        tokens.push({ type: 'vi', value: id.toUpperCase(), args: raw.split(',').map((x) => x.trim()) });
        continue;
      }
      tokens.push(isCall ? { type: 'func', value: id.toLowerCase() } : { type: 'var', value: id.toLowerCase() });
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === '**') { tokens.push({ type: 'op', value: '^' }); i += 2; continue; }
    if (two === '&&' || two === '||' || two === '>=' || two === '<=' || two === '==' || two === '!=') {
      tokens.push({ type: 'op', value: two }); i += 2; continue;
    }
    if (two === '<>') { tokens.push({ type: 'op', value: '!=' }); i += 2; continue; }
    if ('+-*/^%'.includes(c) || c === '>' || c === '<' || c === '!' || c === '?' || c === ':' || c === ',') {
      tokens.push({ type: 'op', value: c }); i++; continue;
    }
    if (c === '(' || c === ')') { tokens.push({ type: 'paren', value: c }); i++; continue; }
    i++; // ignore anything else (';', stray characters)
  }
  return tokens;
}

/**
 * Recursive-descent evaluator with C/ngspice precedence (low → high):
 *   ?:  <  ||  <  &&  <  == !=  <  < > <= >=  <  + -  <  * / %  <  unary - + !  <  ^ **
 * `^` is left-associative as in ngspice (2^3^2 = 64); unary minus binds looser
 * than `^` (-2^2 = -4, as ngspice), and a signed exponent (`2^-1`) works.
 */
class ExprEvaluator {
  private tokens: Token[];
  private pos = 0;
  /** function to resolve V(node1, node2) and I(source) */
  private resolver: (kind: 'V' | 'I', args: string[]) => number;
  private time: number;

  constructor(expr: string, resolver: (kind: 'V' | 'I', args: string[]) => number, time: number) {
    this.tokens = tokenize(expr);
    this.resolver = resolver;
    this.time = time;
  }

  peek(): Token | null { return this.tokens[this.pos] ?? null; }
  consume(): Token { return this.tokens[this.pos++]; }
  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return !!t && t.type === 'op' && ops.includes(t.value);
  }

  parse(): number {
    return this.parseTernary();
  }

  private parseTernary(): number {
    const c = this.parseOr();
    if (this.isOp('?')) {
      this.consume();
      const a = this.parseTernary();
      if (this.isOp(':')) this.consume();
      const b = this.parseTernary();
      return c !== 0 ? a : b;
    }
    return c;
  }

  private parseOr(): number {
    let l = this.parseAnd();
    while (this.isOp('||')) { this.consume(); const r = this.parseAnd(); l = (l !== 0 || r !== 0) ? 1 : 0; }
    return l;
  }

  private parseAnd(): number {
    let l = this.parseEq();
    while (this.isOp('&&')) { this.consume(); const r = this.parseEq(); l = (l !== 0 && r !== 0) ? 1 : 0; }
    return l;
  }

  private parseEq(): number {
    let l = this.parseRel();
    while (this.isOp('==', '!=')) {
      const op = this.consume().value;
      const r = this.parseRel();
      l = (op === '==' ? l === r : l !== r) ? 1 : 0;
    }
    return l;
  }

  private parseRel(): number {
    let l = this.parseExpr();
    while (this.isOp('>', '<', '>=', '<=')) {
      const op = this.consume().value;
      const r = this.parseExpr();
      switch (op) {
        case '>': l = l > r ? 1 : 0; break;
        case '<': l = l < r ? 1 : 0; break;
        case '>=': l = l >= r ? 1 : 0; break;
        default: l = l <= r ? 1 : 0; break;
      }
    }
    return l;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    while (this.isOp('+', '-')) {
      const op = this.consume().value;
      const right = this.parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseUnary();
    while (this.isOp('*', '/', '%')) {
      const op = this.consume().value;
      const right = this.parseUnary();
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }

  private parseUnary(): number {
    if (this.isOp('-')) { this.consume(); return -this.parseUnary(); }
    if (this.isOp('+')) { this.consume(); return this.parseUnary(); }
    if (this.isOp('!')) { this.consume(); return this.parseUnary() === 0 ? 1 : 0; }
    return this.parsePower();
  }

  private parsePower(): number {
    // Left-associative like ngspice (2^3^2 = 64); a signed exponent (2^-1) is allowed.
    let base = this.parsePrimary();
    while (this.isOp('^')) {
      this.consume();
      let sign = 1;
      while (this.isOp('-', '+')) { if (this.consume().value === '-') sign = -sign; }
      base = Math.pow(base, sign * this.parsePrimary());
    }
    return base;
  }

  private parsePrimary(): number {
    const tok = this.peek();
    if (!tok) return 0;
    if (tok.type === 'num') { this.consume(); return tok.num; }
    if (tok.type === 'vi') {
      this.consume();
      return this.resolver(tok.value as 'V' | 'I', tok.args);
    }
    if (tok.type === 'paren' && tok.value === '(') {
      this.consume();
      const v = this.parseTernary();
      if (this.peek()?.value === ')') this.consume();
      return v;
    }
    if (tok.type === 'func') {
      this.consume();
      if (this.peek()?.value === '(') this.consume();
      const args: number[] = [];
      while (this.peek() && this.peek()!.value !== ')') {
        args.push(this.parseTernary());
        if (this.peek()?.value === ',') this.consume();
        else if (this.peek()?.value !== ')') break;
      }
      if (this.peek()?.value === ')') this.consume();
      return applyFunc(tok.value, args);
    }
    if (tok.type === 'var') {
      this.consume();
      switch (tok.value) {
        case 'time': return this.time;
        case 'pi': return Math.PI;
        case 'e': return Math.E;
        default: return 0;  // unknown variable
      }
    }
    this.consume();
    return 0;
  }
}

function applyFunc(name: string, a: number[]): number {
  const x = a[0] ?? 0;
  switch (name) {
    case 'exp': return Math.exp(x);
    case 'ln': case 'log': return Math.log(x);
    case 'log10': return Math.log10(x);
    case 'sin': return Math.sin(x);
    case 'cos': return Math.cos(x);
    case 'tan': return Math.tan(x);
    case 'asin': return Math.asin(x);
    case 'acos': return Math.acos(x);
    case 'atan': return Math.atan(x);
    case 'atan2': return Math.atan2(x, a[1] ?? 0);
    case 'sinh': return Math.sinh(x);
    case 'cosh': return Math.cosh(x);
    case 'tanh': return Math.tanh(x);
    case 'asinh': return Math.asinh(x);
    case 'acosh': return Math.acosh(x);
    case 'atanh': return Math.atanh(x);
    case 'abs': return Math.abs(x);
    case 'sqrt': return Math.sqrt(x);
    case 'pow': return Math.pow(x, a[1] ?? 0);
    case 'pwr': return Math.sign(x) * Math.pow(Math.abs(x), a[1] ?? 0);
    case 'min': return Math.min(x, a[1] ?? x);
    case 'max': return Math.max(x, a[1] ?? x);
    case 'limit': return Math.max(a[1] ?? x, Math.min(x, a[2] ?? x));
    case 'u': return x > 0 ? 1 : 0;
    case 'uramp': return x > 0 ? x : 0;
    case 'sgn': case 'sign': return x > 0 ? 1 : x < 0 ? -1 : 0;
    case 'floor': return Math.floor(x);
    case 'ceil': return Math.ceil(x);
    case 'int': return Math.trunc(x);
    case 'nint': return Math.round(x);
    case 'if': case 'ternary_fcn': return x !== 0 ? (a[1] ?? 0) : (a[2] ?? 0);
    default: return 0;
  }
}

/**
 * Build the V(node)/I(source) resolution tables for a behavioral source
 * from the live SimContext.
 *
 * - V(name): resolves against net label names ("in", "VCC", ...), ground
 *   aliases ("0"/"gnd"), and full terminal keys ("R1:a") — in that order.
 * - I(name): resolves a voltage source's branch current by component id or
 *   refdes via the `__branchIndices` map registered by source stamps.
 *   `__branchIndices` stores ABSOLUTE row indices; `branchCurrent` is
 *   0-based on extras, so we offset by (numNodes − 1).
 */
export function buildBehavioralTables(sim: SimContext): {
  nodeNameToId: Map<string, number>;
  branchCurrents: Map<string, number>;
} {
  const nodeNameToId = new Map<string, number>();
  if (sim.netNames) {
    for (const [name, id] of sim.netNames) nodeNameToId.set(name, id);
  }
  const branchCurrents = new Map<string, number>();
  const idx = sim.state?.__branchIndices as Record<string, number> | undefined;
  if (idx) {
    const base = sim.nodeVoltage.length - 1; // absolute row of extra var 0
    for (const [name, absIdx] of Object.entries(idx)) {
      const extraIdx = absIdx - base;
      if (extraIdx >= 0 && extraIdx < sim.branchCurrent.length) {
        branchCurrents.set(name, sim.branchCurrent[extraIdx]);
      }
    }
  }
  return { nodeNameToId, branchCurrents };
}

/**
 * Evaluate a behavioral expression against the current sim context.
 * `lookupNode` is a function that converts a node name to its voltage.
 */
export function evalExpression(
  expr: string,
  nodeVoltage: Float64Array,
  nodeNameToId: Map<string, number>,
  time: number,
  branchCurrents: Map<string, number> = new Map(),
): number {
  const resolver = (kind: 'V' | 'I', args: string[]): number => {
    if (kind === 'V') {
      const n1 = args[0];
      const n2 = args[1] ?? '0';
      const v1 = n1 === '0' || n1.toLowerCase() === 'gnd' ? 0 : (nodeNameToId.get(n1) !== undefined ? nodeVoltage[nodeNameToId.get(n1)!] : 0);
      const v2 = n2 === '0' || n2.toLowerCase() === 'gnd' ? 0 : (nodeNameToId.get(n2) !== undefined ? nodeVoltage[nodeNameToId.get(n2)!] : 0);
      return v1 - v2;
    } else {
      // I(source) — look up branch current
      return branchCurrents.get(args[0]) ?? 0;
    }
  };
  try {
    const e = new ExprEvaluator(expr, resolver, time);
    return e.parse();
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral voltage source (BV)
//   V = expression — uses expression parser to compute voltage
// ─────────────────────────────────────────────────────────────────────────────

export const bvSource: ComponentPlugin = {
  type: 'bvSource',
  name: 'Behavioral V Source',
  category: 'source',
  description: 'Voltage source with arbitrary expression: V = expression. Use V(node1,node2), I(source), +, *, sin, exp, etc.',
  symbol: 'Bv',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'p', label: '+', position: { x: 0, y: 1 }, electricalType: 'output' },
    { id: 'n', label: '-', position: { x: 4, y: 1 }, electricalType: 'passive' },
  ],
  parameters: [
    { key: 'expr', label: 'Expression', type: 'string', default: 'V(in)' },
  ],
  keywords: ['behavioral', 'bv', 'expression'],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(2 * cellSize - 8, cellSize);
    ctx.moveTo(2 * cellSize + 8, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#22c55e';
    ctx.font = `bold ${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('B', 0, 0);
    drawLabel(ctx, (params.expr as string).slice(0, 15), 0, -22);
  },
  stamp(params, terminals, sys, sim) {
    const expr = params.expr as string;
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    // Resolve V(netname) against the engine's net-name map and I(source)
    // against registered voltage-source branch currents. The engine's
    // feedback iteration (plugins with feedback:true) re-stamps until the
    // node voltages the expression reads are self-consistent with the solve.
    try {
      const { nodeNameToId, branchCurrents } = buildBehavioralTables(sim);
      const v = evalExpression(expr, sim.nodeVoltage, nodeNameToId, sim.time, branchCurrents);
      sys.stampVoltageSource(p, n, v);
    } catch (e) {
      console.error('BV source stamp error:', e);
    }
  },
  // behavioral: engine iterates stamp↔solve so V(node) refs converge within
  // the same timestep instead of lagging one step behind.
  feedback: true,
  measure(params, terminals, sim, comp) {
    const p = terminals.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
    const n = terminals.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
    const v = sim.nodeVoltage[p] - sim.nodeVoltage[n];
    const st = sim.state.__global ?? (sim.state.__global = {});
    const i = (st[`bv_i_${comp?.id ?? `${p}_${n}`}`] as number | undefined) ?? 0;
    return [
      { label: 'V', value: v.toFixed(3), unit: 'V' },
      { label: 'I', value: i.toExponential(2), unit: 'A' },
    ];
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral current source (BI)
// ─────────────────────────────────────────────────────────────────────────────

export const biSource: ComponentPlugin = {
  type: 'biSource',
  name: 'Behavioral I Source',
  category: 'source',
  description: 'Current source with arbitrary expression: I = expression.',
  symbol: 'Bi',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'p', label: '+', position: { x: 0, y: 1 }, electricalType: 'output' },
    { id: 'n', label: '-', position: { x: 4, y: 1 }, electricalType: 'passive' },
  ],
  parameters: [{ key: 'expr', label: 'Expression', type: 'string', default: '0.01' }],
  keywords: ['behavioral', 'bi', 'expression'],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(2 * cellSize - 8, cellSize);
    ctx.moveTo(2 * cellSize + 8, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.strokeStyle = '#3b82f6';
    ctx.stroke();
    ctx.fillStyle = '#3b82f6';
    ctx.font = `bold ${Math.floor(cellSize * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('B', 0, 0);
    drawLabel(ctx, (params.expr as string).slice(0, 15), 0, -22);
  },
  stamp(params, terminals, sys, sim) {
    const expr = params.expr as string;
    const p = terminals.find((t) => t.terminalId === 'p')!.nodeId;
    const n = terminals.find((t) => t.terminalId === 'n')!.nodeId;
    try {
      const { nodeNameToId, branchCurrents } = buildBehavioralTables(sim);
      const i = evalExpression(expr, sim.nodeVoltage, nodeNameToId, sim.time, branchCurrents);
      sys.stampCurrentSource(p, n, i);
    } catch (e) {
      console.error('BI source stamp error:', e);
    }
  },
  // behavioral: engine iterates stamp↔solve so V(node)/I(source) refs
  // converge within the same timestep.
  feedback: true,
  measure(params, terminals, sim, comp) {
    const p = terminals.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
    const n = terminals.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const i = (st[`bi_i_${comp?.id ?? `${p}_${n}`}`] as number | undefined) ?? 0;
    return [{ label: 'I', value: i.toExponential(2), unit: 'A' }];
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Voltage-controlled switch (S element)
//   Conductance between terminals = 1/Ron when V(ctrl+) - V(ctrl-) > Vt + Vh,
//                                   1/Roff when V < Vt - Vh,
//                                   previous state in between (hysteresis).
// ─────────────────────────────────────────────────────────────────────────────

export const vcSwitch: ComponentPlugin = {
  type: 'vcSwitch',
  name: 'V-Controlled Switch',
  category: 'passive',
  description: 'Voltage-controlled switch (SPICE S element). Switches between Ron and Roff based on control voltage.',
  symbol: 'S',
  nonLinear: true,
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 }, electricalType: 'passive' },
    { id: 'b', label: 'B', position: { x: 6, y: 1 }, electricalType: 'passive' },
    { id: 'cp', label: 'C+', position: { x: 2, y: 4 }, electricalType: 'input' },
    { id: 'cn', label: 'C-', position: { x: 4, y: 4 }, electricalType: 'input' },
  ],
  parameters: [
    { key: 'vt', label: 'Threshold Voltage', type: 'number', default: 1.0, unit: 'V', step: 0.1 },
    { key: 'vh', label: 'Hysteresis', type: 'number', default: 0.1, unit: 'V', step: 0.05 },
    { key: 'ron', label: 'ON Resistance', type: 'number', default: 0.01, unit: 'Ω', min: 1e-6, max: 1000, step: 0.01 },
    { key: 'roff', label: 'OFF Resistance', type: 'number', default: 1e6, unit: 'Ω', min: 1, max: 1e9, step: 1000 },
  ],
  keywords: ['switch', 'voltage-controlled', 'spice', 's-element'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(5 * cellSize, cellSize); ctx.lineTo(6 * cellSize, cellSize);
    ctx.moveTo(2 * cellSize, 4 * cellSize); ctx.lineTo(2 * cellSize, 2 * cellSize);
    ctx.moveTo(4 * cellSize, 4 * cellSize); ctx.lineTo(4 * cellSize, 2 * cellSize);
    // switch arm
    ctx.moveTo(cellSize, cellSize); ctx.lineTo(5 * cellSize, cellSize * 0.5);
    ctx.stroke();
    drawLabel(ctx, 'S', 3 * cellSize, cellSize * 0.5 - 12);
  },
  // SPICE S-element semantics (shared core with spiceSwitch): ON when the
  // control voltage exceeds VT+VH, OFF below VT−VH, and the previous
  // COMMITTED state (step(), once per accepted timestep) inside the band —
  // real hysteresis, no sigmoid.
  stamp(params, terminals, sys, sim, comp) {
    spiceSwitch.stamp!(params, terminals, sys, sim, comp);
  },
  step(params, terminals, sim, comp) {
    spiceSwitch.step!(params, terminals, sim, comp);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 6, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Coupled inductors (K statement) — mutual inductance
//   L1 and L2 are the inductors' self-inductances, k is coupling (0..1).
//   Mutual M = k * sqrt(L1*L2)
//   Model: V1 = L1*dI1/dt + M*dI2/dt, V2 = M*dI1/dt + L2*dI2/dt
//   We model this with two coupled inductors + a CCCS in each.
// ─────────────────────────────────────────────────────────────────────────────

function coupledTerms(terminals: { terminalId: string; nodeId: number }[]) {
  const n = (id: string) => terminals.find((x) => x.terminalId === id)!.nodeId;
  return { p1: n('p1'), p2: n('p2'), s1: n('s1'), s2: n('s2') };
}
/**
 * L1, L2, M of a coupled pair. Circuits saved before L2/k were simulated
 * carry a turns `ratio` with L2 left equal to L1: honor that intent by
 * deriving L2 = L1/ratio² (N1:N2 = √(L1/L2)).
 */
function coupledL(params: Record<string, any>) {
  const L1 = Math.max(1e-12, params.L1 as number);
  let L2 = Math.max(1e-12, params.L2 as number);
  const ratio = params.ratio as number | undefined;
  if (typeof ratio === 'number' && ratio > 0 && ratio !== 1 && params.L2 === params.L1) L2 = L1 / (ratio * ratio);
  const k = Math.max(0, Math.min(0.9999, (params.k as number) ?? 0.99));
  return { L1, L2, M: k * Math.sqrt(L1 * L2) };
}

const MUTUAL_PIN: Record<string, string> = { p1: 'a1', p2: 'b1', s1: 'a2', s2: 'b2' };
const mutualTerminals = (terminals: { terminalId: string; nodeId: number }[]) =>
  terminals.map((t) => ({ terminalId: MUTUAL_PIN[t.terminalId] ?? t.terminalId, nodeId: t.nodeId }));
function mutualParams(params: Record<string, any>) {
  const { L1, L2, M } = coupledL(params);
  return { L1, L2, k12: M / Math.sqrt(L1 * L2) };
}

export const coupledInductor: ComponentPlugin = {
  type: 'coupledInductor',
  name: 'Coupled Inductors (Transformer)',
  category: 'passive',
  description: 'Two inductors with mutual coupling M = k·√(L1·L2) (SPICE K element). The turns ratio is √(L1/L2); k < 1 gives leakage inductance (1−k²)·L. Winding currents flow P1→P2 and S1→S2; dotted ends are P1 and S1.',
  symbol: 'T',
  boundingBox: { width: 4, height: 6 },
  terminals: [
    { id: 'p1', label: 'P1', position: { x: 0, y: 1 }, electricalType: 'passive' },
    { id: 'p2', label: 'P2', position: { x: 0, y: 3 }, electricalType: 'passive' },
    { id: 's1', label: 'S1', position: { x: 4, y: 1 }, electricalType: 'passive' },
    { id: 's2', label: 'S2', position: { x: 4, y: 3 }, electricalType: 'passive' },
  ],
  parameters: [
    { key: 'L1', label: 'Primary Inductance', type: 'number', default: 1e-3, unit: 'H', step: 1e-6 },
    { key: 'L2', label: 'Secondary Inductance', type: 'number', default: 1e-3, unit: 'H', step: 1e-6 },
    { key: 'k', label: 'Coupling Coeff', type: 'number', default: 0.99, min: 0, max: 0.9999, step: 0.01 },
  ],
  keywords: ['transformer', 'mutual', 'coupled', 'k'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // primary coils (left)
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(cellSize * 0.7, cellSize * (1 + i * 0.5), cellSize * 0.3, Math.PI, 0, false);
      ctx.stroke();
    }
    // secondary coils (right)
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(cellSize * 3.3, cellSize * (1 + i * 0.5), cellSize * 0.3, Math.PI, 0, false);
      ctx.stroke();
    }
    // primary leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(cellSize * 0.7, cellSize);
    ctx.moveTo(0, 3 * cellSize); ctx.lineTo(cellSize * 0.7, 3 * cellSize);
    // secondary leads
    ctx.moveTo(cellSize * 3.3, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.moveTo(cellSize * 3.3, 3 * cellSize); ctx.lineTo(4 * cellSize, 3 * cellSize);
    ctx.stroke();
    // core (two vertical lines)
    ctx.beginPath();
    ctx.moveTo(2 * cellSize - 4, cellSize); ctx.lineTo(2 * cellSize - 4, 3 * cellSize);
    ctx.moveTo(2 * cellSize + 4, cellSize); ctx.lineTo(2 * cellSize + 4, 3 * cellSize);
    ctx.stroke();
  },
  // Delegates to the SPICE K-element core (spiceMutual2): companion model on
  // the winding currents using the selected integration method (Euler /
  // trapezoidal / Gear-BDF2), exactly like capacitors and spiceMutual2.
  stamp(params, terminals, sys, sim, comp) {
    spiceMutual2.stamp!(mutualParams(params), mutualTerminals(terminals), sys, sim, comp);
  },
  step(params, terminals, sim, instance) {
    const mt = mutualTerminals(terminals);
    spiceMutual2.step!(mutualParams(params), mt, sim, instance);
    // Mirror the winding currents into the legacy xfmr keys that the engine's
    // wire-current display and measure() read.
    const t = coupledTerms(terminals);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const sk = `spk_${instance?.id ?? [t.p1, t.p2, t.s1, t.s2].join('_')}`;
    const s = st[sk] as { i: number[] } | undefined;
    const key = stateKey('xfmr', instance, t.p1, t.p2, t.s1, t.s2);
    if (s) { st[key] = s.i[0]; st[key + '_i2'] = s.i[1]; }
  },
  measure(params, terminals, sim, comp) {
    const t = coupledTerms(terminals);
    const st = sim.state.__global ?? {};
    const key = stateKey('xfmr', comp, t.p1, t.p2, t.s1, t.s2);
    const { L1, L2 } = coupledL(params);
    return [
      { label: 'V1', value: (sim.nodeVoltage[t.p1] - sim.nodeVoltage[t.p2]).toFixed(3), unit: 'V' },
      { label: 'V2', value: (sim.nodeVoltage[t.s1] - sim.nodeVoltage[t.s2]).toFixed(3), unit: 'V' },
      { label: 'I1', value: (((st[key] as number) ?? 0) * 1000).toFixed(3), unit: 'mA' },
      { label: 'I2', value: (((st[key + '_i2'] as number) ?? 0) * 1000).toFixed(3), unit: 'mA' },
      { label: 'N1:N2', value: Math.sqrt(L1 / L2).toFixed(3), unit: '' },
    ];
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 0, y: 3 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Lossless transmission line (SPICE T element) — Bergeron / method of
// characteristics (Dommel). Each port is stamped as its characteristic
// admittance Y0 = 1/Z0 in parallel with a history CURRENT source computed
// from the far port's voltage/current at t − Td:
//
//   i_a(t) = Y0·v_a(t) − J_a(t),   J_a(t) = Y0·v_b(t−Td) + i_b(t−Td)
//   i_b(t) = Y0·v_b(t) − J_b(t),   J_b(t) = Y0·v_a(t−Td) + i_a(t−Td)
//
// (i_a / i_b flow INTO the line at each port.) This models the full two-port
// physics: matched terminations show no reflection, mismatched loads reflect
// with Γ = (RL−Z0)/(RL+Z0), and an open far end doubles the incident voltage.
// The old model (ideal delayed voltage source + input shunt) had zero output
// impedance, no return path, and no reflections. History is interpolated at
// t − Td so the delay is not quantized to whole timesteps.
// ─────────────────────────────────────────────────────────────────────────────

interface TlineSample { t: number; va: number; ia: number; vb: number; ib: number }

function tlineHistoryAt(history: TlineSample[], t: number): TlineSample | null {
  // history is ordered by increasing t; find the sample at time `t` with
  // linear interpolation between the two bracketing samples.
  if (history.length === 0 || t < history[0].t) return null;
  let lo = 0;
  let hi = history.length - 1;
  if (t >= history[hi].t) return history[hi];
  // binary search for the bracketing pair
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (history[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = history[lo];
  const b = history[hi];
  const span = b.t - a.t;
  if (span <= 0) return a;
  const f = (t - a.t) / span;
  return {
    t,
    va: a.va + (b.va - a.va) * f,
    ia: a.ia + (b.ia - a.ia) * f,
    vb: a.vb + (b.vb - a.vb) * f,
    ib: a.ib + (b.ib - a.ib) * f,
  };
}

export const transLineLossless: ComponentPlugin = {
  type: 'transLineLossless',
  name: 'Lossless Transmission Line',
  category: 'passive',
  description: 'Ideal lossless transmission line (SPICE T element). Bergeron model: pure delay Td with characteristic impedance Z0 at both ports, full reflection physics.',
  symbol: 'T',
  boundingBox: { width: 6, height: 2 },
  terminals: [
    { id: 'a1', label: 'A1', position: { x: 0, y: 0 }, electricalType: 'passive' },
    { id: 'a2', label: 'A2', position: { x: 0, y: 2 }, electricalType: 'passive' },
    { id: 'b1', label: 'B1', position: { x: 6, y: 0 }, electricalType: 'passive' },
    { id: 'b2', label: 'B2', position: { x: 6, y: 2 }, electricalType: 'passive' },
  ],
  parameters: [
    { key: 'Z0', label: 'Characteristic Impedance', type: 'number', default: 50, unit: 'Ω', step: 1 },
    { key: 'Td', label: 'Delay Time', type: 'number', default: 1e-9, unit: 's', step: 1e-12 },
  ],
  keywords: ['transmission', 'line', 'tline', 'delay'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    // left side
    ctx.moveTo(0, 0); ctx.lineTo(2 * cellSize, 0);
    ctx.moveTo(0, 2 * cellSize); ctx.lineTo(2 * cellSize, 2 * cellSize);
    // right side
    ctx.moveTo(4 * cellSize, 0); ctx.lineTo(6 * cellSize, 0);
    ctx.moveTo(4 * cellSize, 2 * cellSize); ctx.lineTo(6 * cellSize, 2 * cellSize);
    // box
    ctx.rect(2 * cellSize, cellSize * 0.3, 2 * cellSize, cellSize * 1.4);
    ctx.stroke();
    drawLabel(ctx, 'T', 3 * cellSize, cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const a1 = terminals.find((t) => t.terminalId === 'a1')!.nodeId;
    const a2 = terminals.find((t) => t.terminalId === 'a2')!.nodeId;
    const b1 = terminals.find((t) => t.terminalId === 'b1')!.nodeId;
    const b2 = terminals.find((t) => t.terminalId === 'b2')!.nodeId;
    const Z0 = Math.max(1e-3, params.Z0 as number);
    const Td = Math.max(1e-15, params.Td as number);
    const Y0 = 1 / Z0;

    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('tline', comp, a1, b1);
    const history = (st[key] as TlineSample[] | undefined) ?? (st[key] = [] as TlineSample[]);

    // History sources from the far ports at t − Td (zero before any wave arrives).
    const old = tlineHistoryAt(history, sim.time - Td);
    const Ja = old ? Y0 * old.vb + old.ib : 0; // injects INTO a1
    const Jb = old ? Y0 * old.va + old.ia : 0; // injects INTO b1

    // Port A: Y0 from a1 to a2, source Ja from a2 to a1 (into a1)
    sys.stampConductance(a1, a2, Y0);
    sys.stampCurrentSource(a2, a1, Ja);
    // Port B: Y0 from b1 to b2, source Jb from b2 to b1 (into b1)
    sys.stampConductance(b1, b2, Y0);
    sys.stampCurrentSource(b2, b1, Jb);

    // Stash the history sources so step() can reconstruct this step's port
    // currents (i = Y0·v − J) from the FRESH solution.
    st[key + '_J'] = { Ja, Jb, t: sim.time };
  },
  step(params, terminals, sim, instance) {
    const a1 = terminals.find((t) => t.terminalId === 'a1')!.nodeId;
    const a2 = terminals.find((t) => t.terminalId === 'a2')!.nodeId;
    const b1 = terminals.find((t) => t.terminalId === 'b1')!.nodeId;
    const b2 = terminals.find((t) => t.terminalId === 'b2')!.nodeId;
    const Z0 = Math.max(1e-3, params.Z0 as number);
    const Td = Math.max(1e-15, params.Td as number);
    const Y0 = 1 / Z0;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('tline', instance, a1, b1);
    const history = (st[key] as TlineSample[] | undefined) ?? (st[key] = [] as TlineSample[]);
    const Jst = st[key + '_J'] as { Ja: number; Jb: number; t: number } | undefined;
    if (!Jst) return;

    // Record the solved port quantities for future delayed lookups.
    const va = sim.nodeVoltage[a1] - sim.nodeVoltage[a2];
    const vb = sim.nodeVoltage[b1] - sim.nodeVoltage[b2];
    history.push({ t: sim.time, va, ia: Y0 * va - Jst.Ja, vb, ib: Y0 * vb - Jst.Jb });
    // trim history that can never be looked up again (keep one sample below
    // t − Td for interpolation)
    const cutoff = sim.time - Td;
    let drop = 0;
    while (drop + 1 < history.length && history[drop + 1].t <= cutoff) drop++;
    if (drop > 0) history.splice(0, drop);
    // hard cap against unbounded growth (e.g. Td shorter than dt)
    if (history.length > 4096) history.splice(0, history.length - 4096);
  },
  measure(params, terminals, sim, comp) {
    const a1 = terminals.find((t) => t.terminalId === 'a1')!.nodeId;
    const a2 = terminals.find((t) => t.terminalId === 'a2')!.nodeId;
    const b1 = terminals.find((t) => t.terminalId === 'b1')!.nodeId;
    const b2 = terminals.find((t) => t.terminalId === 'b2')!.nodeId;
    const va = sim.nodeVoltage[a1] - sim.nodeVoltage[a2];
    const vb = sim.nodeVoltage[b1] - sim.nodeVoltage[b2];
    return [
      { label: 'Va', value: va.toFixed(3), unit: 'V' },
      { label: 'Vb', value: vb.toFixed(3), unit: 'V' },
      { label: 'Z0', value: (params.Z0 as number).toFixed(1), unit: 'Ω' },
      { label: 'Td', value: ((params.Td as number) * 1e9).toFixed(3), unit: 'ns' },
    ];
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 6, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Lossy transmission line — RLGC distributed model.
// Implements the SPICE LTRA (Lossy TRAnsmission line) model with:
//   - Series resistance R per unit length (conductor loss)
//   - Series inductance L per unit length
//   - Shunt conductance G per unit length (dielectric loss)
//   - Shunt capacitance C per unit length
//
// The line is discretized into N cascaded Π-sections: each segment has a
// series R+L branch (combined backward-Euler companion — the series R is
// folded into the inductor companion analytically, avoiding an internal
// node per segment) and shunt C+G at the junctions (C/2 at the ports,
// C per junction inside). The N−1 internal junction nodes are allocated as
// MNA extras (declared via `extraVars` so the engine sizes the matrix
// correctly). The return conductor (a2–b2) is ideal — per the SPICE LTRA
// convention R models the full loop resistance.
//
// The old stamp put R and L companions in PARALLEL between the same node
// pair, dropped every history source (a purely resistive ladder with no
// delay or charge storage), halved the DC resistance, and silently
// overflowed the pre-allocated matrix for segments > ~4·components.
// ─────────────────────────────────────────────────────────────────────────────

interface LossyTlineState {
  /** series-branch current per segment (previous step) */
  iSer: number[];
  /** junction voltages vs. return conductor (previous step), length N+1 */
  vSh: number[];
}

function lossyTlineParams(params: Record<string, any>) {
  const R = Math.max(0, (params.RperLen as number) ?? 0.1);
  const L = Math.max(0, (params.LperLen as number) ?? 250e-9);
  const G = Math.max(0, (params.GperLen as number) ?? 1e-9);
  const C = Math.max(0, (params.CperLen as number) ?? 100e-12);
  const length = Math.max(0, (params.length as number) ?? 0.1);
  const N = Math.max(1, Math.min(64, Math.floor((params.segments as number) ?? 8)));
  return { R, L, G, C, length, N };
}

export const transLineLossy: ComponentPlugin = {
  type: 'transLineLossy',
  name: 'Lossy Transmission Line (RLGC)',
  category: 'passive',
  description: 'Lossy transmission line with per-unit R, L, G, C parameters. Discretized into Π-sections for transient simulation. Models skin effect (R), dielectric loss (G), and dispersion.',
  symbol: 'TL',
  boundingBox: { width: 8, height: 2 },
  terminals: [
    { id: 'a1', label: 'A1', position: { x: 0, y: 0 }, electricalType: 'passive' },
    { id: 'a2', label: 'A2', position: { x: 0, y: 2 }, electricalType: 'passive' },
    { id: 'b1', label: 'B1', position: { x: 8, y: 0 }, electricalType: 'passive' },
    { id: 'b2', label: 'B2', position: { x: 8, y: 2 }, electricalType: 'passive' },
  ],
  parameters: [
    { key: 'RperLen', label: 'Resistance per length', type: 'number', default: 0.1, unit: 'Ω/m', step: 0.01 },
    { key: 'LperLen', label: 'Inductance per length', type: 'number', default: 250e-9, unit: 'H/m', step: 1e-9 },
    { key: 'GperLen', label: 'Conductance per length', type: 'number', default: 1e-9, unit: 'S/m', step: 1e-12 },
    { key: 'CperLen', label: 'Capacitance per length', type: 'number', default: 100e-12, unit: 'F/m', step: 1e-12 },
    { key: 'length', label: 'Length', type: 'number', default: 0.1, unit: 'm', step: 0.01 },
    { key: 'segments', label: 'Discretization segments', type: 'number', default: 8, unit: '', min: 1, max: 64, step: 1 },
  ],
  keywords: ['transmission', 'line', 'tline', 'lossy', 'rlgc', 'ltra'],
  render(ctx, params, cellSize) {
    const segs = (params.segments as number) ?? 8;
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    // left side
    ctx.moveTo(0, 0); ctx.lineTo(cellSize, 0);
    ctx.moveTo(0, 2 * cellSize); ctx.lineTo(cellSize, 2 * cellSize);
    // right side
    ctx.moveTo(7 * cellSize, 0); ctx.lineTo(8 * cellSize, 0);
    ctx.moveTo(7 * cellSize, 2 * cellSize); ctx.lineTo(8 * cellSize, 2 * cellSize);
    // body with segment marks (showing it's discretized)
    ctx.rect(cellSize, cellSize * 0.3, 6 * cellSize, cellSize * 1.4);
    ctx.stroke();
    // segment dividers
    for (let i = 1; i < segs; i++) {
      const x = cellSize + (6 * cellSize * i / segs);
      ctx.beginPath();
      ctx.moveTo(x, cellSize * 0.3);
      ctx.lineTo(x, cellSize * 1.7);
      ctx.stroke();
    }
    drawLabel(ctx, 'TL', 4 * cellSize, cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const a1 = terminals.find((t) => t.terminalId === 'a1')!.nodeId;
    const a2 = terminals.find((t) => t.terminalId === 'a2')!.nodeId;
    const b1 = terminals.find((t) => t.terminalId === 'b1')!.nodeId;
    const b2 = terminals.find((t) => t.terminalId === 'b2')!.nodeId;
    const { R, L, G, C, length, N } = lossyTlineParams(params);

    const rSeg = (R * length) / N;
    const lSeg = (L * length) / N;
    // Π-section shunts: half at each port, full at internal junctions.
    const cPort = (C * length) / (2 * N);
    const cJunction = (C * length) / N;
    const gPort = (G * length) / (2 * N);
    const gJunction = (G * length) / N;

    const dt = Math.max(sim.dt ?? 1e-4, 1e-12);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('tlineRLGC', comp, a1, b1);
    const state = (st[key] as LossyTlineState | undefined) ??
      (st[key] = { iSer: new Array<number>(N).fill(0), vSh: new Array<number>(N + 1).fill(0) } as LossyTlineState);

    // Series R+L combined companion (backward Euler):
    //   L·di/dt = v − R·i  →  i_n = (i_{n−1} + (dt/L)·v_n) / (1 + dt·R/L)
    //   Norton: gEq = (dt/L)/denom, iEq = i_{n−1}/denom
    const denom = 1 + (dt * rSeg) / Math.max(lSeg, 1e-18);
    const gSeries = lSeg > 0 ? dt / lSeg / denom : lSeg === 0 && rSeg > 0 ? 1 / rSeg : 0;
    // pure-R case (L=0): plain conductance; pure-L case (R=0): gEq = dt/L.

    // Junction node ids: 0 = a1 (real), 1..N−1 = internal extras, N = b1 (real).
    // addExtra() returns a MATRIX index; the stamp helpers take NODE ids and
    // subtract 1 internally — so a virtual junction node's id is extraIdx + 1
    // (pseudo ids start at numNodes, above every real node id, so they never
    // collide). Their solved voltages are readable in step() from
    // sim.branchCurrent at (pseudoId − 1 − numNonGround).
    const junctions: number[] = [a1];
    for (let i = 1; i < N; i++) junctions.push(sys.addExtra() + 1);
    junctions.push(b1);
    st[key + '_nodes'] = junctions;

    for (let i = 0; i < N; i++) {
      const p = junctions[i];
      const q = junctions[i + 1];
      // series branch (return current flows through the return conductor)
      sys.stampConductance(p, q, gSeries);
      sys.stampCurrentSource(p, q, (state.iSer[i] ?? 0) / denom);
      // shunt at junction i (port junctions get C/2, G/2)
      const cThis = i === 0 ? cPort : cJunction;
      const gThis = i === 0 ? gPort : gJunction;
      if (gThis > 0) sys.stampConductance(p, a2, gThis);
      if (cThis > 0) {
        const gC = cThis / dt;
        sys.stampConductance(p, a2, gC);
        // capacitor companion: injects (C/dt)·vPrev back into p
        sys.stampCurrentSource(a2, p, gC * (state.vSh[i] ?? 0));
      }
    }
    // final shunt at b1
    if (gPort > 0) sys.stampConductance(b1, a2, gPort);
    if (cPort > 0) {
      const gC = cPort / dt;
      sys.stampConductance(b1, a2, gC);
      sys.stampCurrentSource(a2, b1, gC * (state.vSh[N] ?? 0));
    }

    // Ideal return conductor (loop R lives in the series branches).
    sys.stampConductance(a2, b2, 1e6);
  },
  step(params, terminals, sim, instance) {
    const a1 = terminals.find((t) => t.terminalId === 'a1')!.nodeId;
    const a2 = terminals.find((t) => t.terminalId === 'a2')!.nodeId;
    const b1 = terminals.find((t) => t.terminalId === 'b1')!.nodeId;
    const { R, L, length, N } = lossyTlineParams(params);
    const rSeg = (R * length) / N;
    const lSeg = (L * length) / N;
    const dt = Math.max(sim.dt ?? 1e-4, 1e-12);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('tlineRLGC', instance, a1, b1);
    const state = (st[key] as LossyTlineState | undefined) ??
      (st[key] = { iSer: new Array<number>(N).fill(0), vSh: new Array<number>(N + 1).fill(0) } as LossyTlineState);
    const junctions = st[key + '_nodes'] as number[] | undefined;
    if (!junctions || junctions.length !== N + 1) return;

    // Same companion values used in stamp().
    const denom = 1 + (dt * rSeg) / Math.max(lSeg, 1e-18);
    const gSeries = lSeg > 0 ? dt / lSeg / denom : lSeg === 0 && rSeg > 0 ? 1 / rSeg : 0;

    // Junction voltages: ports are real nodes; internal junctions were
    // stamped as extras — their solved values live in sim.branchCurrent at
    // (pseudoId − 1 − numNonGround), mirroring the ammeter's indexing.
    const numNonGround = sim.nodeVoltage.length - 1;
    const vJunction = new Array<number>(N + 1);
    for (let i = 0; i <= N; i++) {
      if (i === 0 || i === N) {
        const node = i === 0 ? a1 : b1;
        vJunction[i] = sim.nodeVoltage[node] - sim.nodeVoltage[a2];
      } else {
        const rel = (junctions[i] - 1) - numNonGround;
        vJunction[i] = rel >= 0 && rel < sim.branchCurrent.length ? sim.branchCurrent[rel] : (state.vSh[i] ?? 0);
      }
    }

    // Series-branch currents from the solved voltages: i = gSeries·ΔV + iPrev/denom.
    const iSerNew = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      iSerNew[i] = gSeries * (vJunction[i] - vJunction[i + 1]) + (state.iSer[i] ?? 0) / denom;
    }
    state.vSh = vJunction;
    state.iSer = iSerNew;
  },
  measure(params, terminals, sim, comp) {
    const a1 = terminals.find((t) => t.terminalId === 'a1')!.nodeId;
    const a2 = terminals.find((t) => t.terminalId === 'a2')!.nodeId;
    const b1 = terminals.find((t) => t.terminalId === 'b1')!.nodeId;
    const b2 = terminals.find((t) => t.terminalId === 'b2')!.nodeId;
    const va = sim.nodeVoltage[a1] - sim.nodeVoltage[a2];
    const vb = sim.nodeVoltage[b1] - sim.nodeVoltage[b2];
    return [
      { label: 'Va', value: va.toFixed(3), unit: 'V' },
      { label: 'Vb', value: vb.toFixed(3), unit: 'V' },
      { label: 'Segs', value: String(lossyTlineParams(params).N), unit: '' },
    ];
  },
  extraVars(params) {
    const { N } = lossyTlineParams(params);
    return Math.max(0, N - 1);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 8, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// User-placeable controlled sources E/G/F/H
// ─────────────────────────────────────────────────────────────────────────────

export const vcvsUser: ComponentPlugin = {
  type: 'vcvsUser',
  name: 'VCVS (E)',
  category: 'source',
  description: 'Voltage-controlled voltage source (SPICE E element). V(out) = gain * V(in).',
  symbol: 'E',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'op', label: 'O+', position: { x: 6, y: 1 }, electricalType: 'output' },
    { id: 'on', label: 'O-', position: { x: 6, y: 3 }, electricalType: 'passive' },
    { id: 'ip', label: 'I+', position: { x: 0, y: 1 }, electricalType: 'input' },
    { id: 'in', label: 'I-', position: { x: 0, y: 3 }, electricalType: 'input' },
  ],
  parameters: [
    { key: 'gain', label: 'Gain', type: 'number', default: 1, step: 0.1 },
  ],
  keywords: ['vcvs', 'controlled', 'e-element'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(2 * cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(2 * cellSize, cellSize);
    ctx.moveTo(0, 3 * cellSize); ctx.lineTo(2 * cellSize, 3 * cellSize);
    ctx.moveTo(4 * cellSize, cellSize); ctx.lineTo(6 * cellSize, cellSize);
    ctx.moveTo(4 * cellSize, 3 * cellSize); ctx.lineTo(6 * cellSize, 3 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'E', 3 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys) {
    const op = terminals.find((t) => t.terminalId === 'op')!.nodeId;
    const on = terminals.find((t) => t.terminalId === 'on')!.nodeId;
    const ip = terminals.find((t) => t.terminalId === 'ip')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in')!.nodeId;
    const gain = params.gain as number;
    sys.stampVCVS(op, on, ip, inn, gain);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 6, y: 1 }]; },
};

export const vccsUser: ComponentPlugin = {
  type: 'vccsUser',
  name: 'VCCS (G)',
  category: 'source',
  description: 'Voltage-controlled current source (SPICE G element). I(out) = gm * V(in).',
  symbol: 'G',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'op', label: 'O+', position: { x: 6, y: 1 }, electricalType: 'output' },
    { id: 'on', label: 'O-', position: { x: 6, y: 3 }, electricalType: 'passive' },
    { id: 'ip', label: 'I+', position: { x: 0, y: 1 }, electricalType: 'input' },
    { id: 'in', label: 'I-', position: { x: 0, y: 3 }, electricalType: 'input' },
  ],
  parameters: [
    { key: 'gm', label: 'Transconductance', type: 'number', default: 0.01, unit: 'S', step: 0.001 },
  ],
  keywords: ['vccs', 'controlled', 'g-element'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(2 * cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(2 * cellSize, cellSize);
    ctx.moveTo(0, 3 * cellSize); ctx.lineTo(2 * cellSize, 3 * cellSize);
    ctx.moveTo(4 * cellSize, cellSize); ctx.lineTo(6 * cellSize, cellSize);
    ctx.moveTo(4 * cellSize, 3 * cellSize); ctx.lineTo(6 * cellSize, 3 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'G', 3 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys) {
    const op = terminals.find((t) => t.terminalId === 'op')!.nodeId;
    const on = terminals.find((t) => t.terminalId === 'on')!.nodeId;
    const ip = terminals.find((t) => t.terminalId === 'ip')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in')!.nodeId;
    const gm = params.gm as number;
    sys.stampVCCS(op, on, ip, inn, gm);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 6, y: 1 }]; },
};

export const cccsUser: ComponentPlugin = {
  type: 'cccsUser',
  name: 'CCCS (F)',
  category: 'source',
  description: 'Current-controlled current source (SPICE F element). I(out) = beta * I(Vsense).',
  symbol: 'F',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'op', label: 'O+', position: { x: 6, y: 1 }, electricalType: 'output' },
    { id: 'on', label: 'O-', position: { x: 6, y: 3 }, electricalType: 'passive' },
    { id: 'sp', label: 'S+', position: { x: 0, y: 1 }, electricalType: 'input' },
    { id: 'sn', label: 'S-', position: { x: 0, y: 3 }, electricalType: 'input' },
  ],
  parameters: [
    { key: 'beta', label: 'Current Gain', type: 'number', default: 1, step: 0.1 },
    { key: 'vsenseName', label: 'Sense Voltage Source', type: 'string', default: 'V1' },
  ],
  keywords: ['cccs', 'controlled', 'f-element'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(2 * cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'F', 3 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    // CCCS: I(out) = beta * I(Vsense)
    // The sense voltage source's branch index is stored in sim.state.__branchIndices
    // (registered when the V-source's stamp() ran earlier in the same step).
    const beta = params.beta as number;
    const vsenseName = params.vsenseName as string;
    if (!sim) return;
    const map = sim.state.__branchIndices;
    if (!map) return;
    const branchIdx = map[vsenseName];
    if (branchIdx === undefined) return;
    const op = terminals.find((t) => t.terminalId === 'op')?.nodeId ?? 0;
    const on = terminals.find((t) => t.terminalId === 'on')?.nodeId ?? 0;
    // stampCCCS: current from op to on = beta * I_branch(branchIdx)
    sys.stampCCCS(op, on, branchIdx, beta);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 6, y: 1 }]; },
};

export const ccvsUser: ComponentPlugin = {
  type: 'ccvsUser',
  name: 'CCVS (H)',
  category: 'source',
  description: 'Current-controlled voltage source (SPICE H element). V(out) = transimpedance * I(Vsense).',
  symbol: 'H',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'op', label: 'O+', position: { x: 6, y: 1 }, electricalType: 'output' },
    { id: 'on', label: 'O-', position: { x: 6, y: 3 }, electricalType: 'passive' },
    { id: 'sp', label: 'S+', position: { x: 0, y: 1 }, electricalType: 'input' },
    { id: 'sn', label: 'S-', position: { x: 0, y: 3 }, electricalType: 'input' },
  ],
  parameters: [
    { key: 'transimp', label: 'Transimpedance', type: 'number', default: 1, unit: 'Ω', step: 0.1 },
    { key: 'vsenseName', label: 'Sense Voltage Source', type: 'string', default: 'V1' },
  ],
  keywords: ['ccvs', 'controlled', 'h-element'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(2 * cellSize, cellSize, 2 * cellSize, 2 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'H', 3 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim) {
    // CCVS: V(out) = transimp * I(Vsense)
    const transimp = params.transimp as number;
    const vsenseName = params.vsenseName as string;
    if (!sim) return;
    const map = sim.state.__branchIndices;
    if (!map) return;
    const branchIdx = map[vsenseName];
    if (branchIdx === undefined) return;
    const op = terminals.find((t) => t.terminalId === 'op')?.nodeId ?? 0;
    const on = terminals.find((t) => t.terminalId === 'on')?.nodeId ?? 0;
    // stampCCVS: V(op) - V(on) = transimp * I_branch(branchIdx)
    sys.stampCCVS(op, on, branchIdx, transimp);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 6, y: 1 }]; },
};

// ─────────────────────────────────────────────────────────────────────────────
// Real op-amp macromodel (Boyle-style)
//   Includes: open-loop gain A0, GBW (gain-bandwidth product), slew rate,
//             input bias current, offset voltage, CMRR, PSRR, output resistance
// ─────────────────────────────────────────────────────────────────────────────

function realPins(terminals: { terminalId: string; nodeId: number }[]): OpampPins {
  return {
    inp: terminals.find((t) => t.terminalId === 'in+')!.nodeId,
    inn: terminals.find((t) => t.terminalId === 'in-')!.nodeId,
    out: terminals.find((t) => t.terminalId === 'out')!.nodeId,
    vcc: terminals.find((t) => t.terminalId === 'vcc')!.nodeId,
    vee: terminals.find((t) => t.terminalId === 'vee')!.nodeId,
  };
}
const realSpec = (params: Record<string, any>) => specFromParams(params, { defVcc: 15, defVee: -15 });

export const opampReal: ComponentPlugin = {
  type: 'opampReal',
  name: 'Op-amp (Boyle Macromodel)',
  category: 'ic',
  description: 'Real op-amp (741-class defaults): finite gain with a GBW dominant pole, slew-rate limit, offset, CMRR, input bias current, Rout with short-circuit current limit, output swing limited by the VCC/VEE rails, quiescent supply current.',
  // Smooth-limited Newton stamp (opamp-core.ts) — joins the re-stamp loop.
  nonLinear: true,
  opampModel: { spec: realSpec, pins: { inp: 'in+', inn: 'in-', out: 'out', vcc: 'vcc', vee: 'vee' } },
  symbol: 'A',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'in+', label: '+', position: { x: 0, y: 1 }, electricalType: 'input' },
    { id: 'in-', label: '-', position: { x: 0, y: 3 }, electricalType: 'input' },
    { id: 'out', label: 'OUT', position: { x: 6, y: 2 }, electricalType: 'output' },
    { id: 'vcc', label: 'VCC', position: { x: 3, y: 0 }, electricalType: 'power_in' },
    { id: 'vee', label: 'VEE', position: { x: 3, y: 4 }, electricalType: 'power_in' },
  ],
  parameters: opampParamDefs({
    gain: 1e5, gbw: 1e6, slewRate: 0.5, voffMv: 1, ibiasNa: 80, cmrrDb: 90, rout: 75,
    swingHigh: 1, swingLow: 1, iLimitMa: 25, iqMa: 1.7,
  }),
  keywords: ['opamp', 'boyle', 'macromodel', 'real', 'gbw'],
  defaultFootprint: 'DIP-8',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, 2 * cellSize);
    ctx.lineTo(2 * cellSize, 3 * cellSize);
    ctx.closePath();
    ctx.stroke();
    // input leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(2 * cellSize, cellSize);
    ctx.moveTo(0, 3 * cellSize); ctx.lineTo(2 * cellSize, 3 * cellSize);
    ctx.moveTo(4 * cellSize, 2 * cellSize); ctx.lineTo(6 * cellSize, 2 * cellSize);
    ctx.moveTo(3 * cellSize, 0); ctx.lineTo(3 * cellSize, cellSize);
    ctx.moveTo(3 * cellSize, 3 * cellSize); ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.stroke();
    drawLabel(ctx, '+', 2.3 * cellSize, cellSize);
    drawLabel(ctx, '-', 2.3 * cellSize, 3 * cellSize);
    drawLabel(ctx, '∞', 3 * cellSize, 2 * cellSize);
  },
  stamp(params, terminals, sys, sim, comp) {
    const pins = realPins(terminals);
    stampOpamp(realSpec(params), pins, sys, sim, stateKey('opampReal', comp, pins.out));
  },
  step(_params, terminals, sim, comp) {
    stepOpamp(sim, stateKey('opampReal', comp, realPins(terminals).out));
  },
  acStamp(params, terminals, sys, { dcOp, omega, comp }) {
    const pins = realPins(terminals);
    acStampOpamp(realSpec(params), pins, sys, dcOp, omega, stateKey('opampReal', comp, pins.out));
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 3, y: 2 }, { x: 6, y: 2 }]; },
  measure(params, terminals, sim, comp) {
    const pins = realPins(terminals);
    return measureOpamp(realSpec(params), pins, sim, stateKey('opampReal', comp, pins.out));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Register everything
// ─────────────────────────────────────────────────────────────────────────────

registerPlugin(bvSource);
registerPlugin(biSource);
registerPlugin(vcSwitch);
registerPlugin(coupledInductor);
registerPlugin(transLineLossless);
registerPlugin(transLineLossy);
registerPlugin(vcvsUser);
registerPlugin(vccsUser);
registerPlugin(cccsUser);
registerPlugin(ccvsUser);
registerPlugin(opampReal);
