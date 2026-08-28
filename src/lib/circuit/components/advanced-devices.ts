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

// ─────────────────────────────────────────────────────────────────────────────
// Expression parser for behavioral sources
//   Supports: V(node1, node2), I(source), +, -, *, /, ^, exp, log, sin, cos,
//   abs, sqrt, min, max, table, limit, if, time (variable)
// ─────────────────────────────────────────────────────────────────────────────

type Token = { type: 'num' | 'op' | 'func' | 'paren' | 'var'; value: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let num = '';
      while (i < expr.length && /[0-9.eE+-]/.test(expr[i])) {
        if ((expr[i] === '+' || expr[i] === '-') && !/[eE]/.test(expr[i - 1] ?? '')) break;
        num += expr[i++];
      }
      tokens.push({ type: 'num', value: num });
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let id = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) id += expr[i++];
      tokens.push(/(exp|log|ln|log10|sin|cos|tan|abs|sqrt|min|max|table|limit|if|V|I|time|pi)/.test(id)
        ? { type: 'func', value: id } : { type: 'var', value: id });
      continue;
    }
    if ('+-*/^()'.includes(c)) {
      tokens.push({ type: c === '(' || c === ')' ? 'paren' : 'op', value: c });
      i++; continue;
    }
    if (c === ',') {
      // Commas are real tokens: the V(n1,n2)/I(src) raw-argument collector
      // splits on them, and the math-function arg loop consumes them.
      // (The old tokenizer silently dropped commas, which glued V(a,b)'s
      // arguments together into a single bogus node name "ab".)
      tokens.push({ type: 'op', value: ',' });
      i++; continue;
    }
    // comparison operators (two-char first)
    const two = expr.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '<>') {
      tokens.push({ type: 'op', value: two === '<>' ? '!=' : two });
      i += 2; continue;
    }
    if (c === '>' || c === '<') {
      tokens.push({ type: 'op', value: c });
      i++; continue;
    }
    if (c === ';' || c === '!') { i++; continue; }
    i++;
  }
  return tokens;
}

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

  parse(): number {
    return this.parseComparison();
  }

  /** Lowest precedence: comparisons → 1/0 (ngspice parity for if()/soft clamps) */
  private parseComparison(): number {
    let left = this.parseExpr();
    while (this.peek()?.type === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(this.peek()!.value)) {
      const op = this.consume().value;
      const right = this.parseExpr();
      switch (op) {
        case '>': left = left > right ? 1 : 0; break;
        case '<': left = left < right ? 1 : 0; break;
        case '>=': left = left >= right ? 1 : 0; break;
        case '<=': left = left <= right ? 1 : 0; break;
        case '==': left = left === right ? 1 : 0; break;
        case '!=': left = left !== right ? 1 : 0; break;
      }
    }
    return left;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    while (this.peek()?.type === 'op' && (this.peek()!.value === '+' || this.peek()!.value === '-')) {
      const op = this.consume().value;
      const right = this.parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseFactor();
    while (this.peek()?.type === 'op' && (this.peek()!.value === '*' || this.peek()!.value === '/')) {
      const op = this.consume().value;
      const right = this.parseFactor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  private parseFactor(): number {
    let left = this.parseUnary();
    if (this.peek()?.type === 'op' && this.peek()!.value === '^') {
      this.consume();
      const right = this.parseFactor();
      left = Math.pow(left, right);
    }
    return left;
  }

  private parseUnary(): number {
    if (this.peek()?.type === 'op' && this.peek()!.value === '-') {
      this.consume();
      return -this.parseUnary();
    }
    if (this.peek()?.type === 'op' && this.peek()!.value === '+') {
      this.consume();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const tok = this.peek();
    if (!tok) return 0;
    if (tok.type === 'num') { this.consume(); return parseFloat(tok.value); }
    if (tok.type === 'paren' && tok.value === '(') {
      this.consume();
      const v = this.parseComparison();
      if (this.peek()?.value === ')') this.consume();
      return v;
    }
    if (tok.type === 'func') {
      this.consume();
      if (tok.value === 'time') return this.time;
      if (tok.value === 'pi') return Math.PI;
      // function call: expect (
      if (this.peek()?.value === '(') {
        this.consume();
        const args: number[] = [];
        const argStrs: string[] = [];
        // for V/I, we need raw string args; for math functions, parse as expressions
        if (tok.value === 'V' || tok.value === 'I') {
          // collect raw tokens until matching )
          let depth = 1;
          let raw = '';
          while (this.pos < this.tokens.length && depth > 0) {
            const t = this.consume();
            if (t.value === '(') depth++;
            else if (t.value === ')') { depth--; if (depth === 0) break; }
            raw += t.value;
          }
          // split on comma at top level
          const parts = raw.split(',').map((s) => s.trim());
          argStrs.push(...parts);
          return this.resolver(tok.value as 'V' | 'I', argStrs);
        }
        // math functions — each argument may itself contain comparisons
        // (e.g. if(V(a)>1, 5, -5)); parsing args with parseExpr would let the
        // stray '>' be consumed as a junk primary and shift the arg list.
        while (this.peek() && this.peek()!.value !== ')') {
          args.push(this.parseComparison());
          if (this.peek()?.value === ',') this.consume();
        }
        if (this.peek()?.value === ')') this.consume();
        switch (tok.value) {
          case 'exp': return Math.exp(args[0]);
          case 'log': return Math.log(args[0]);
          case 'ln': return Math.log(args[0]);
          case 'log10': return Math.log10(args[0]);
          case 'sin': return Math.sin(args[0]);
          case 'cos': return Math.cos(args[0]);
          case 'tan': return Math.tan(args[0]);
          case 'abs': return Math.abs(args[0]);
          case 'sqrt': return Math.sqrt(args[0]);
          case 'min': return Math.min(args[0], args[1]);
          case 'max': return Math.max(args[0], args[1]);
          case 'limit': return Math.max(args[1], Math.min(args[0], args[2]));
          case 'if': return args[0] !== 0 ? args[1] : args[2];
          default: return 0;
        }
      }
    }
    if (tok.type === 'var') { this.consume(); return 0; }  // unknown variable
    this.consume();
    return 0;
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
//   Conductance between terminals = Ron when V(ctrl+) - V(ctrl-) > Vt + Vh,
//                                  Roff when V < Vt - Vh,
//                                  interpolated in between.
// ─────────────────────────────────────────────────────────────────────────────

export const vcSwitch: ComponentPlugin = {
  type: 'vcSwitch',
  name: 'V-Controlled Switch',
  category: 'passive',
  description: 'Voltage-controlled switch (SPICE S element). Switches between Ron and Roff based on control voltage.',
  symbol: 'S',
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
  stamp(params, terminals, sys, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const cp = terminals.find((t) => t.terminalId === 'cp')!.nodeId;
    const cn = terminals.find((t) => t.terminalId === 'cn')!.nodeId;
    const vt = params.vt as number;
    const vh = params.vh as number;
    const ron = Math.max(1e-9, params.ron as number);
    const roff = Math.max(1, params.roff as number);
    const vCtrl = sim.nodeVoltage[cp] - sim.nodeVoltage[cn];
    // Smooth switch model: conductance interpolates between 1/ron and 1/roff
    // based on sigmoid around vt with hysteresis vh.
    const x = (vCtrl - vt) / (2 * vh + 1e-9);
    const sigmoid = 1 / (1 + Math.exp(-x * 5));  // 0..1
    const r = ron + (roff - ron) * (1 - sigmoid);
    sys.stampConductance(a, b, 1 / r);
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

export const coupledInductor: ComponentPlugin = {
  type: 'coupledInductor',
  name: 'Coupled Inductors (Transformer)',
  category: 'passive',
  description: 'Two inductors with mutual coupling M = k*sqrt(L1*L2). Primary/secondary with turns ratio.',
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
    { key: 'k', label: 'Coupling Coeff', type: 'number', default: 0.99, min: 0, max: 1, step: 0.01 },
    { key: 'ratio', label: 'Turns Ratio (N1:N2)', type: 'number', default: 1, min: 0.01, max: 100, step: 0.1 },
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
  stamp(params, terminals, sys, sim, comp) {
    const p1 = terminals.find((t) => t.terminalId === 'p1')!.nodeId;
    const p2 = terminals.find((t) => t.terminalId === 'p2')!.nodeId;
    const s1 = terminals.find((t) => t.terminalId === 's1')!.nodeId;
    const s2 = terminals.find((t) => t.terminalId === 's2')!.nodeId;
    const L1 = Math.max(1e-12, params.L1 as number);
    const L2 = Math.max(1e-12, params.L2 as number);
    const k = Math.max(0, Math.min(1, params.k as number));
    const ratio = params.ratio as number;
    const M = k * Math.sqrt(L1 * L2);
    void L2; void M;
    // Ideal transformer: V2 = V1/ratio. The VCVS branch current i flows s1→s2
    // INSIDE the source; when the secondary delivers power, i < 0. Power
    // conservation fixes the reflected primary current: I(p1→p2 internal) =
    // −i·(V2/V1) = −i/ratio. The old comment claimed the reflection was
    // "implicit in KCL" — it is not: without this CCCS the secondary delivered
    // power the primary never drew (energy from nothing).
    const vcvsIdx = sys.stampVCVS(s1, s2, p1, p2, 1 / ratio);
    if (vcvsIdx >= 0) {
      sys.stampCCCS(p1, p2, vcvsIdx, -1 / ratio);
    }
    // Record the branch index for the primary-current readout
    const stR = sim.state.__global ?? (sim.state.__global = {});
    stR[`xfmr_branch_${comp?.id ?? `${p1}_${p2}`}`] = vcvsIdx;
    // Primary self-/magnetizing inductance (companion model, backward Euler)
    const dt = Math.max(sim.dt, 1e-12);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('xfmr', comp, p1, p2, s1, s2);
    const i1Prev = st[key] ?? 0;
    const g1 = dt / L1;
    sys.stampConductance(p1, p2, g1);
    sys.stampCurrentSource(p1, p2, i1Prev);
    // Update i1 in step()
  },
  step(params, terminals, sim, instance) {
    const p1 = terminals.find((t) => t.terminalId === 'p1')!.nodeId;
    const p2 = terminals.find((t) => t.terminalId === 'p2')!.nodeId;
    const s1 = terminals.find((t) => t.terminalId === 's1')!.nodeId;
    const s2 = terminals.find((t) => t.terminalId === 's2')!.nodeId;
    const L1 = Math.max(1e-12, params.L1 as number);
    const dt = Math.max(sim.dt, 1e-12);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('xfmr', instance, p1, p2, s1, s2);
    const i1Prev = st[key] ?? 0;
    const v = sim.nodeVoltage[p1] - sim.nodeVoltage[p2];
    st[key] = i1Prev + (v / L1) * dt;
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

export const opampReal: ComponentPlugin = {
  type: 'opampReal',
  name: 'Op-amp (Boyle Macromodel)',
  category: 'ic',
  description: 'Real op-amp with finite gain, GBW, slew rate, offset, CMRR, output resistance.',
  symbol: 'A',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'in+', label: '+', position: { x: 0, y: 1 }, electricalType: 'input' },
    { id: 'in-', label: '-', position: { x: 0, y: 3 }, electricalType: 'input' },
    { id: 'out', label: 'OUT', position: { x: 6, y: 2 }, electricalType: 'output' },
    { id: 'vcc', label: 'VCC', position: { x: 3, y: 0 }, electricalType: 'power_in' },
    { id: 'vee', label: 'VEE', position: { x: 3, y: 4 }, electricalType: 'power_in' },
  ],
  parameters: [
    { key: 'gain', label: 'Open-loop Gain', type: 'number', default: 1e5, step: 1000 },
    { key: 'gbw', label: 'Gain-Bandwidth (Hz)', type: 'number', default: 1e6, step: 10000 },
    { key: 'slewRate', label: 'Slew Rate (V/µs)', type: 'number', default: 0.5, step: 0.1 },
    { key: 'voff', label: 'Offset Voltage (mV)', type: 'number', default: 1, step: 0.1 },
    { key: 'ibias', label: 'Bias Current (nA)', type: 'number', default: 80, step: 5 },
    { key: 'cmrr', label: 'CMRR (dB)', type: 'number', default: 90, step: 5 },
    { key: 'rout', label: 'Output Resistance (Ω)', type: 'number', default: 75, step: 5 },
  ],
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
  stamp(params, terminals, sys, sim) {
    const inp = terminals.find((t) => t.terminalId === 'in+')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in-')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    const gain = params.gain as number;
    const rout = Math.max(1, params.rout as number);
    const voff = (params.voff as number) / 1000; // mV to V
    // Thevenin output stage: the VCVS drives an INTERNAL node (a pseudo-node
    // built from an extra unknown) and rout connects it to the real output.
    // The old code stamped rout from out to ground in parallel with the VCVS —
    // the VCVS still pinned V(out) exactly, so rout had no effect whatsoever
    // (a 75 Ω load didn't change V(out) at all).
    const internal = sys.addExtra() + 1; // pseudo-node id (extra index + 1)
    const vcvsIdx = sys.stampVCVS(internal, 0, inp, inn, gain);
    // Input-referred offset: V(internal) = gain·(v+ − v− + voff). The VCVS
    // row is V(internal) − gain·(v+ − v−) = z[vcvsIdx]; setting that RHS to
    // gain·voff folds the offset into the gain equation. (The old code
    // injected a meaningless voff·gain/1M amp current into the inverting
    // node, which did nothing when that node was grounded.)
    if (vcvsIdx >= 0 && voff !== 0) {
      sys.z[vcvsIdx] += gain * voff;
    }
    // Series output resistance between the internal node and the output
    sys.stampConductance(internal, out, 1 / rout);
    // Input bias path (prevents floating inputs, like the ideal op-amp)
    sys.stampConductance(inp, 0, 1e-6);
    sys.stampConductance(inn, 0, 1e-6);
    void sim;
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 3, y: 2 }, { x: 6, y: 2 }]; },
  measure(params, terminals, sim) {
    const inp = terminals.find((t) => t.terminalId === 'in+')!.nodeId;
    const inn = terminals.find((t) => t.terminalId === 'in-')!.nodeId;
    const out = terminals.find((t) => t.terminalId === 'out')!.nodeId;
    return [
      { label: 'V+', value: sim.nodeVoltage[inp].toFixed(4), unit: 'V' },
      { label: 'V-', value: sim.nodeVoltage[inn].toFixed(4), unit: 'V' },
      { label: 'Vout', value: sim.nodeVoltage[out].toFixed(4), unit: 'V' },
      { label: 'Gain', value: (params.gain as number).toExponential(2), unit: '' },
    ];
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
