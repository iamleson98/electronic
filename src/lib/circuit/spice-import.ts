// SPICE netlist importer — parses a SPICE netlist string into a CircuitDocument.
// ─────────────────────────────────────────────────────────────────────────────
// Supports the most common SPICE element cards:
//   R<name>  n+ n- <value>                — resistor (1k, 4.7k, 1Meg, 100, 1e3)
//   C<name>  n+ n- <value>                — capacitor (1u, 100n, 1e-9)
//   L<name>  n+ n- <value>                — inductor (1m, 10u, 1e-3)
//   V<name>  n+ n- <value> [SINE(...)]     — voltage source (DC or AC sine)
//   I<name>  n+ n- <value>                 — current source
//   D<name>  n+ n- <model>                 — diode
//   Q<name>  c b e <model>                 — BJT (NPN/PNP inferred from .model)
//   M<name>  d g s <model>                 — MOSFET (NMOS/PMOS inferred from .model)
//   S<name>  n+ n- nc+ nc- <model> [on|off] — voltage-controlled switch
//   T<name>  a1 a2 b1 b2 Z0=<z> TD=<t>   — lossless transmission line
//   O<name>  a1 a2 b1 b2 <model>          — lossy line (LTRA .model R/L/G/C/LEN)
//   B<name>  n+ n- V=expr | I=expr        — behavioral source
//
// Node 0 (or "gnd"/"ground") is treated as the ground node.
// Sub-circuits (.SUBCKT/.ENDS) are recognized and skipped
// (the components inside a .SUBCKT are flattened inline as plain elements).
// .MODEL cards are parsed for LTRA (lossy-line) parameters; other model types
// are skipped (transistors infer NPN/PNP/NMOS/PMOS from model-name heuristics).
// .TRAN, .AC, .DC, .OP, .END cards are recognized and skipped.
//
// Returns { doc: CircuitDocument | null, errors: string[], warnings: string[] }.
// On parse failure, doc is null and errors contains the messages.

import type { CircuitComponent, Wire, CircuitDocument } from './types';
import { getPlugin } from './registry';
import './components'; // register all built-in plugins (idempotent)
import { parseSpiceValue as canonicalParseSpiceValue } from './spice';
import { fromSpiceExpr } from './spice-expr';
import './spice-devices'; // registers the SPICE-faithful device plugins (spiceNpn, spiceDiode, spiceSwitch, spiceMutual*, spiceV/I)

// ─────────────────────────────────────────────────────────────────────────────
// Value parsing — handles SPICE engineering suffixes (case-insensitive)
// ─────────────────────────────────────────────────────────────────────────────

const SPICE_SUFFIXES: Record<string, number> = {
  // SPICE3 standard suffixes
  'f': 1e-15,
  'p': 1e-12,
  'n': 1e-9,
  'u': 1e-6,  // also "µ" but we accept ASCII
  'µ': 1e-6,
  'm': 1e-3,
  'k': 1e3,
  'meg': 1e6,
  'g': 1e9,
  't': 1e12,
  // SPICE3 also accepts these (less common)
  'mil': 25.4e-6,  // 1 mil = 25.4 microns
};

export function parseSpiceValue(raw: string): number {
  if (typeof raw !== 'string') return Number(raw) || 0;
  // Single canonical parser lives in spice.ts (compound suffixes, µ, mil,
  // meg-vs-m). This wrapper keeps the old import path working.
  // Static ESM import: the lazy require() below broke under ESM test runners
  // (vitest: "require is not defined") — spice.ts does not import this file,
  // so there is no cycle to avoid.
  return canonicalParseSpiceValue(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer — splits a SPICE line into tokens, handling quoted strings and
// parentheses-grouped arguments (e.g., SINE(0 5 1k))
// ─────────────────────────────────────────────────────────────────────────────

function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = line.length;
  while (i < len) {
    // skip whitespace and commas
    while (i < len && (/\s/.test(line[i]) || line[i] === ',')) i++;
    if (i >= len) break;
    // comment starts with semicolon — rest of line is comment
    if (line[i] === ';') break;
    // Quoted string (single or double): keep verbatim INCLUDING spaces and
    // commas — B-element expressions like V='if(V(in) > 2, 5, 0)' must
    // survive tokenization as one token.
    if (line[i] === "'" || line[i] === '"') {
      const quote = line[i];
      let j = i + 1;
      while (j < len && line[j] !== quote) j++;
      tokens.push(line.slice(i, j + 1)); // include the quotes
      i = j + 1;
      continue;
    }
    // read token until whitespace, comma, or end — but allow parentheses groups
    let token = '';
    while (i < len && !/\s/.test(line[i]) && line[i] !== ',') {
      token += line[i];
      i++;
    }
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Net-name → numeric node id mapping
// ─────────────────────────────────────────────────────────────────────────────

class NetMap {
  nameToId = new Map<string, number>();
  private nextId = 1;
  // Always reserve 0 for ground
  constructor() {
    this.nameToId.set('0', 0);
    this.nameToId.set('gnd', 0);
    this.nameToId.set('ground', 0);
  }
  get(name: string): number {
    const n = name.toLowerCase();
    if (!this.nameToId.has(n)) {
      this.nameToId.set(n, this.nextId++);
    }
    return this.nameToId.get(n)!;
  }
  has(name: string): boolean {
    return this.nameToId.has(name.toLowerCase());
  }
  size(): number { return this.nextId; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component placement — lay components out left-to-right with 5-unit spacing
// ─────────────────────────────────────────────────────────────────────────────

function placeComponents(components: CircuitComponent[]): void {
  // Place at y=10, spaced 5 grid units apart on the x axis.
  // Components placed first go leftmost.
  const startX = 5;
  const stepX = 6;
  // Ground stays at origin (it's typically drawn below)
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (c.type === 'ground') {
      c.position = { x: startX + i * stepX, y: 18 };
    } else {
      c.position = { x: startX + i * stepX, y: 10 };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build wires from SPICE node assignments
// ─────────────────────────────────────────────────────────────────────────────

interface PendingWire { from: { componentId: string; terminalId: string }; net: number; }
interface NetMember { componentId: string; terminalId: string; }

function buildWiresFromNets(netMembers: Map<number, NetMember[]>): Wire[] {
  const wires: Wire[] = [];
  let wireCount = 0;
  for (const [netId, members] of netMembers) {
    if (netId === 0) continue;  // ground net — handled by ground component terminal
    if (members.length < 2) continue;
    // Connect all members of this net in a chain: m0-m1, m1-m2, ...
    for (let i = 1; i < members.length; i++) {
      wires.push({
        id: `w${wireCount++}`,
        from: { componentId: members[i - 1].componentId, terminalId: members[i - 1].terminalId },
        to: { componentId: members[i].componentId, terminalId: members[i].terminalId },
      });
    }
  }
  return wires;
}

// Connect any component terminal that lies on the ground net to the ground component.
function connectGroundNets(
  netMembers: Map<number, NetMember[]>,
  components: CircuitComponent[],
  groundId: string,
): Wire[] {
  const wires: Wire[] = [];
  let wireCount = 0;
  const groundMembers = netMembers.get(0) || [];
  // For every member on the ground net that's NOT the ground component itself,
  // wire it to the ground component's 'g' terminal.
  for (const m of groundMembers) {
    if (m.componentId === groundId) continue;
    wires.push({
      id: `wg${wireCount++}`,
      from: { componentId: m.componentId, terminalId: m.terminalId },
      to: { componentId: groundId, terminalId: 'g' },
    });
  }
  return wires;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────────────────────────

export interface SpiceImportResult {
  doc: CircuitDocument | null;
  errors: string[];
  warnings: string[];
  /**
   * SPICE net name (lower-case) → one component terminal sitting on that net
   * (ground nets map to the ground component). Lets callers probe a node by
   * its netlist name: `nodeMap.terminalNode.get(`${componentId}:${terminalId}`)`.
   */
  nets?: Map<string, { componentId: string; terminalId: string }>;
  /** the .tran / .ac / .op cards of the deck, parsed (numbers in SI) */
  analyses?: { tran?: { tstep: number; tstop: number }; ac?: { sweep: 'dec' | 'oct' | 'lin'; n: number; fstart: number; fstop: number }; op?: boolean };
}

export function importSpiceNetlist(netlist: string): SpiceImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!netlist || typeof netlist !== 'string') {
    return { doc: null, errors: ['Empty netlist'], warnings };
  }

  // Pre-process: join continuation lines (lines starting with '+')
  const rawLines = netlist.split(/\r?\n/);
  const lines: string[] = [];
  for (const raw of rawLines) {
    // strip inline comment (everything after ';')
    const noComment = raw.split(';')[0];
    if (/^\s*\+/.test(noComment) && lines.length > 0) {
      lines[lines.length - 1] += ' ' + noComment.replace(/^\s*\+/, '').trim();
    } else {
      lines.push(noComment);
    }
  }

  if (lines.length === 0) {
    return { doc: null, errors: ['Netlist is empty'], warnings };
  }

  const netMap = new NetMap();
  const components: CircuitComponent[] = [];
  const netMembers = new Map<number, NetMember[]>();
  let groundId: string | null = null;
  let inSubckt = false;
  // Preserved control cards (.tran/.ac/.dc/.op/.options/.temp/.step/.mc /
  // .worst/.ic/.nodeset/.save/.print/.meas/...) for the directive editor +
  // simOptions round-trip (previously dropped silently).
  const directiveCards: string[] = [];
  const directiveOptions: Record<string, number | string | boolean> = {};
  let directiveTemp: number | undefined;
  const initialConditions: Record<string, number> = {};
  const nodeSets: Record<string, number> = {};

  // ── Pre-scan: collect .model definitions (for LTRA lossy lines) ────────
  // SPICE allows forward references (an O card may appear before its .model),
  // so models are gathered in a full pass before any element is parsed.
  const modelDefs = new Map<string, { type: string; params: Map<string, number> }>();
  for (const raw of lines) {
    const l = raw.trim();
    if (!l.startsWith('.')) continue;
    const m = l.match(/^\.model\s+(\S+)\s+([A-Za-z]+)\s*\(?([^)]*)\)?/i);
    if (!m) continue;
    const params = new Map<string, number>();
    for (const tok of m[3].split(/[\s,]+/)) {
      const pm = tok.match(/^([A-Za-z_][\w]*)\s*=\s*(.+)$/);
      if (pm) params.set(pm[1].toLowerCase(), parseSpiceValue(pm[2]));
    }
    modelDefs.set(m[1].toLowerCase(), { type: m[2].toUpperCase(), params });
  }

  // .tran / .ac / .op cards (SI numbers) and K couplings / L cards, resolved after the element pass
  const analyses: NonNullable<SpiceImportResult['analyses']> = {};
  const kCards: { name: string; ls: string[]; k: number }[] = [];
  const lInfo = new Map<string, { n1: string; n2: string; value: number }>();
  for (const raw of lines) {
    const t = tokenizeLine(raw.trim());
    const f = (t[0] ?? '').toUpperCase();
    if (f === '.TRAN' && t.length >= 3) analyses.tran = { tstep: parseSpiceValue(t[1]), tstop: parseSpiceValue(t[2]) };
    else if (f === '.AC' && t.length >= 5) {
      analyses.ac = { sweep: t[1].toLowerCase() as 'dec' | 'oct' | 'lin', n: parseSpiceValue(t[2]), fstart: parseSpiceValue(t[3]), fstop: parseSpiceValue(t[4]) };
    } else if (f === '.OP') analyses.op = true;
  }
  const modelOf = (name: string | undefined, ...types: string[]) => {
    const md = name ? modelDefs.get(name.toLowerCase()) : undefined;
    return md && types.includes(md.type) ? md : undefined;
  };
  const mp = (md: { params: Map<string, number> }, ...keys: string[]): number | undefined => {
    for (const k of keys) if (md.params.has(k)) return md.params.get(k);
    return undefined;
  };

  // Helper: ensure a ground component exists
  function ensureGround(): string {
    if (groundId) return groundId;
    const gid = 'GND';
    components.push({
      id: gid,
      type: 'ground',
      position: { x: 0, y: 18 },
      rotation: 0,
      parameters: {},
    });
    groundId = gid;
    return gid;
  }

  // Helper: register a net membership for a component terminal
  function registerTerminal(netName: string, componentId: string, terminalId: string): number {
    const nid = netMap.get(netName);
    if (!netMembers.has(nid)) netMembers.set(nid, []);
    // Avoid duplicate entries on the same terminal
    const arr = netMembers.get(nid)!;
    if (!arr.some(m => m.componentId === componentId && m.terminalId === terminalId)) {
      arr.push({ componentId, terminalId });
    }
    return nid;
  }

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();
    if (line === '') continue;
    if (line.startsWith('*')) continue;  // comment

    const tokens = tokenizeLine(line);
    if (tokens.length === 0) continue;

    const first = tokens[0].toUpperCase();

    // ── SPICE title convention ──────────────────────────────────────────
    // The FIRST line of a netlist is always the title, never an element. A
    // title that doesn't start with '*' (e.g. "T-line delay test" exported
    // by ngspice) would otherwise be misparsed as an element card. Fixture
    // netlists that have no title (first line IS a real element) keep
    // working: only skip when the line can't possibly be a well-formed card
    // (unknown element letter, or too few tokens for that card type).
    if (lineNum === 0 && !line.startsWith('*') && !first.startsWith('.')) {
      const MIN_TOKENS: Record<string, number> = {
        R: 4, C: 4, L: 4, V: 4, I: 4, B: 4, D: 4, Q: 5, M: 5, S: 6,
        T: 5, O: 6, X: 4, E: 5, F: 5, G: 5, H: 5, K: 4, W: 4, Z: 4, N: 4, P: 4,
      };
      const letter = tokens[0][0].toUpperCase();
      const min = MIN_TOKENS[letter];
      if (min === undefined || tokens.length < min) {
        continue; // title line
      }
    }

    // ── Dot commands ────────────────────────────────────────────────────
    if (first === '.SUBCKT') { inSubckt = true; directiveCards.push(line); continue; }
    if (first === '.ENDS' || first === '.ENDSUB') { inSubckt = false; directiveCards.push(line); continue; }
    if (first === '.END') break;  // end of netlist
    if (first === '.OPTIONS') {
      for (const tok of tokens.slice(1)) {
        const kv = tok.match(/^(\w+)\s*=\s*(.+)$/);
        if (kv) {
          const num = parseSpiceValue(kv[2]);
          directiveOptions[kv[1].toLowerCase()] = Number.isFinite(num) ? num : kv[2];
          if (kv[1].toLowerCase() === 'temp' && Number.isFinite(num)) directiveTemp = num;
        }
      }
      directiveCards.push(line);
      continue;
    }
    if (first === '.TEMP') {
      const num = tokens.length > 1 ? parseSpiceValue(tokens[1]) : NaN;
      if (Number.isFinite(num)) directiveTemp = num;
      directiveCards.push(line);
      continue;
    }
    if (first === '.IC' || first === '.NODESET') {
      for (const tok of tokens.slice(1)) {
        const m = tok.match(/^v\(([^)]+)\)\s*=\s*(.+)$/i);
        if (m) {
          const target = first === '.IC' ? initialConditions : nodeSets;
          target[m[1]] = parseSpiceValue(m[2]);
        }
      }
      directiveCards.push(line);
      continue;
    }
    if (first === '.TRAN' || first === '.AC' || first === '.DC' || first === '.OP' ||
        first === '.STEP' || first === '.MC' || first === '.WORST' || first === '.PROBE' ||
        first === '.SAVE' || first === '.PRINT' || first === '.MEAS' || first === '.FOUR' ||
        first === '.TF' || first === '.PZ' || first === '.NOISE' || first === '.DISTO' ||
        first === '.SENS' || first === '.MODEL') {
      directiveCards.push(line);
      continue;  // control/model cards preserved, not instantiated
    }
    if (first.startsWith('.')) continue;  // any other dot command

    // Inside a subckt definition, we still want to parse the elements so the
    // netlist round-trips — but in practice the simulator treats them as a
    // macro. For simplicity, we just import them as flat elements.
    if (inSubckt) {
      // Continue parsing — flatten the subckt
    }

    const cardType = tokens[0][0].toUpperCase();

    try {
      switch (cardType) {
        case 'R': {  // Resistor: R<name> n+ n- value
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: R card needs n+ n- value: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const n1 = tokens[1], n2 = tokens[2];
          const value = parseSpiceValue(tokens[3]);
          const plugin = getPlugin('resistor');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.resistance = value;
          components.push({
            id, type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(n1, id, 'a');
          registerTerminal(n2, id, 'b');
          break;
        }
        case 'C': {  // Capacitor: C<name> n+ n- value
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: C card needs n+ n- value: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const value = parseSpiceValue(tokens[3]);
          const plugin = getPlugin('capacitor');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.capacitance = value;
          components.push({
            id, type: 'capacitor', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'a');
          registerTerminal(tokens[2], id, 'b');
          break;
        }
        case 'L': {  // Inductor: L<name> n+ n- value
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: L card needs n+ n- value: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const value = parseSpiceValue(tokens[3]);
          const plugin = getPlugin('inductor');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.inductance = value;
          components.push({
            id, type: 'inductor', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'a');
          registerTerminal(tokens[2], id, 'b');
          lInfo.set(id.toLowerCase(), { n1: tokens[1], n2: tokens[2], value });
          break;
        }
        case 'V':    // Voltage source: V<name> n+ n- [DC] value [AC mag [phase]] [SIN|PULSE|PWL|EXP(...)]
        case 'I': {  // Current source: I<name> n+ n- value (same syntax)
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: ${cardType} card needs n+ n- value: "${line}"`);
            continue;
          }
          const isV = cardType === 'V';
          const id = tokens[0];
          const joined = tokens.slice(3).join(' ');
          const spec = parseSourceSpec(joined, analyses.tran);
          // Library-part fast paths (kept for the simple cases the UI edits directly)
          const simpleSine = /\bSINE\s*\(/i.test(joined) && !/\bAC\s/i.test(joined);
          const sineMatch = joined.match(/SINE\s*\(\s*([^\s)]+)\s+([^\s)]+)\s+([^\s)]+)/i);
          if (isV && simpleSine && sineMatch && !spec.hasAc && spec.waveArgs.length <= 3) {
            const plugin = getPlugin('acVoltage');
            const params: any = {};
            if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
            params.offset = parseSpiceValue(sineMatch[1]);
            params.amplitude = parseSpiceValue(sineMatch[2]);
            params.frequency = parseSpiceValue(sineMatch[3]);
            components.push({ id, type: 'acVoltage', position: { x: 0, y: 0 }, rotation: 0, parameters: params });
          } else if (spec.wave || spec.hasAc) {
            const type = isV ? 'spiceV' : 'spiceI';
            const plugin = getPlugin(type);
            const params: any = {};
            if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
            params.dc = spec.dc; params.dcSet = spec.dcGiven;
            params.acMag = spec.acMag; params.acPhase = spec.acPhase;
            params.wave = spec.wave ?? '';
            components.push({ id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: params });
          } else {
            const type = isV ? 'dcVoltage' : 'currentSource';
            const plugin = getPlugin(type);
            const params: any = {};
            if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
            params[isV ? 'voltage' : 'current'] = spec.dc;
            components.push({ id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: params });
          }
          registerTerminal(tokens[1], id, 'p');
          registerTerminal(tokens[2], id, 'n');
          break;
        }
        case 'E':    // VCVS: E<name> n+ n- nc+ nc- gain
        case 'G': {  // VCCS: G<name> n+ n- nc+ nc- gm
          if (tokens.length < 6) {
            errors.push(`Line ${lineNum + 1}: ${cardType} card needs n+ n- nc+ nc- value: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const type = cardType === 'E' ? 'vcvsUser' : 'vccsUser';
          const plugin = getPlugin(type);
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          const valTok = tokens[5].toUpperCase() === 'VALUE' || tokens[5].includes('=') ? tokens[6] : tokens[5];
          params[cardType === 'E' ? 'gain' : 'gm'] = parseSpiceValue(valTok ?? '0');
          components.push({ id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: params });
          registerTerminal(tokens[1], id, 'op');
          registerTerminal(tokens[2], id, 'on');
          registerTerminal(tokens[3], id, 'ip');
          registerTerminal(tokens[4], id, 'in');
          break;
        }
        case 'K': {  // mutual inductance: K<name> L1 L2 [L3 …] k
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: K card needs L1 L2 k: "${line}"`);
            continue;
          }
          kCards.push({ name: tokens[0], ls: tokens.slice(1, -1), k: parseSpiceValue(tokens[tokens.length - 1]) });
          break;
        }
        case 'B': {  // Behavioral source: B<name> n+ n- V=expr | I=expr
          // ngspice syntax: B1 out 0 V=3*V(in)  (or I=..., possibly quoted).
          // Parse from the RAW line — the expression can contain spaces and
          // commas that tokenization would mangle.
          const bMatch = line.match(/^B\w+\s+(\S+)\s+(\S+)\s+(.+)$/i);
          if (!bMatch) {
            errors.push(`Line ${lineNum + 1}: B card needs n+ n- V=expr: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const rest = bMatch[3];
          const bvMatch = rest.match(/V\s*=\s*['"]?([^'"]+)['"]?/i);
          const biMatch = rest.match(/I\s*=\s*['"]?([^'"]+)['"]?/i);
          const isCurrent = !bvMatch && !!biMatch;
          const expr = (bvMatch ?? biMatch)?.[1]?.trim();
          if (!expr) {
            errors.push(`Line ${lineNum + 1}: B card needs a V= or I= expression: "${line}"`);
            continue;
          }
          const type = isCurrent ? 'biSource' : 'bvSource';
          const plugin = getPlugin(type);
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.expr = fromSpiceExpr(plainNumbers(expr));
          components.push({
            id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(bMatch[1], id, 'p');
          registerTerminal(bMatch[2], id, 'n');
          break;
        }
        case 'D': {  // Diode: D<name> n+ n- model
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: D card needs n+ n- model: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const dm = modelOf(tokens[3], 'D');
          const plugin = getPlugin(dm ? 'spiceDiode' : 'diode');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.modelName = tokens[3];
          if (dm) {
            const set = (k: string, ...names: string[]) => { const v = mp(dm, ...names); if (v !== undefined) params[k] = v; };
            set('Is', 'is'); set('N', 'n'); set('Rs', 'rs'); set('Cjo', 'cjo', 'cj0', 'cj'); set('Vj', 'vj', 'pb'); set('M', 'm', 'mj');
            set('Fc', 'fc'); set('Tt', 'tt'); set('Bv', 'bv');
            const area = tokens[4] && /^[-+.\d]/.test(tokens[4]) ? parseSpiceValue(tokens[4]) : 1;
            params.area = area;
          }
          components.push({
            id, type: dm ? 'spiceDiode' : 'diode', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'a');
          registerTerminal(tokens[2], id, 'k');
          break;
        }
        case 'Q': {  // BJT: Q<name> c b e model [area]
          if (tokens.length < 5) {
            errors.push(`Line ${lineNum + 1}: Q card needs c b e model: "${line}"`);
            continue;
          }
          const id = tokens[0];
          // We can't easily know NPN vs PNP without parsing .MODEL — default to NPN
          // (the model name is preserved so a later pass could swap the type).
          const modelName = tokens[4] || '2N3904';
          const qm = modelOf(modelName, 'NPN', 'PNP');
          const isPnp = qm ? qm.type === 'PNP' : /pnp/i.test(modelName) || modelName.toUpperCase().startsWith('2N3906') || modelName.toUpperCase().startsWith('2N4403');
          const type = qm ? (isPnp ? 'spicePnp' : 'spiceNpn') : isPnp ? 'pnp' : 'npn';
          const plugin = getPlugin(type);
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.modelName = modelName;
          if (qm) {
            const set = (k: string, ...names: string[]) => { const v = mp(qm, ...names); if (v !== undefined) params[k] = v; };
            set('Is', 'is'); set('Nf', 'nf'); set('Nr', 'nr'); set('Bf', 'bf'); set('Br', 'br');
            set('Ise', 'ise', 'c2'); set('Ne', 'ne'); set('Isc', 'isc', 'c4'); set('Nc', 'nc');
            set('Vaf', 'vaf', 'va'); set('Var', 'var', 'vb'); set('Ikf', 'ikf', 'ik'); set('Ikr', 'ikr');
            set('Rb', 'rb'); set('Rc', 'rc'); set('Re', 're');
            set('Cje', 'cje'); set('Vje', 'vje', 'pe'); set('Mje', 'mje', 'me');
            set('Cjc', 'cjc'); set('Vjc', 'vjc', 'pc'); set('Mjc', 'mjc', 'mc'); set('Fc', 'fc');
            set('Tf', 'tf'); set('Tr', 'tr');
            params.area = tokens[5] && /^[-+.\d]/.test(tokens[5]) ? parseSpiceValue(tokens[5]) : 1;
          }
          components.push({
            id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'c');
          registerTerminal(tokens[2], id, 'b');
          registerTerminal(tokens[3], id, 'e');
          break;
        }
        case 'M': {  // MOSFET: M<name> d g s model
          if (tokens.length < 5) {
            errors.push(`Line ${lineNum + 1}: M card needs d g s model: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const modelName = tokens[4] || '2N7000';
          const isPmos = /pmos/i.test(modelName) || modelName.toUpperCase().startsWith('BS250') || modelName.toUpperCase().startsWith('IRF95');
          const type = isPmos ? 'pmos' : 'nmos';
          const plugin = getPlugin(type);
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.modelName = modelName;
          components.push({
            id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'd');
          registerTerminal(tokens[2], id, 'g');
          registerTerminal(tokens[3], id, 's');
          break;
        }
        case 'S': {  // Voltage-controlled switch: S<name> n+ n- nc+ nc- model [on|off]
          if (tokens.length < 6) {
            // Try push-button switch with 2 terminals
            if (tokens.length >= 4) {
              const id = tokens[0];
              const plugin = getPlugin('switch');
              const params: any = {};
              if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
              params.closed = true;
              components.push({
                id, type: 'switch', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
              });
              registerTerminal(tokens[1], id, 'a');
              registerTerminal(tokens[2], id, 'b');
              break;
            }
            errors.push(`Line ${lineNum + 1}: S card needs n+ n- nc+ nc- model: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const sm = modelOf(tokens[5], 'SW');
          if (sm) {
            // ngspice voltage-controlled switch: RON/ROFF/VT/VH with hysteresis
            const plugin = getPlugin('spiceSwitch');
            const params: any = {};
            if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
            params.vt = mp(sm, 'vt') ?? 0; params.vh = mp(sm, 'vh') ?? 0;
            params.ron = mp(sm, 'ron') ?? 1; params.roff = mp(sm, 'roff') ?? 1e12;
            params.initialOn = /^on$/i.test(tokens[6] || '');
            components.push({ id, type: 'spiceSwitch', position: { x: 0, y: 0 }, rotation: 0, parameters: params });
            registerTerminal(tokens[1], id, 'a');
            registerTerminal(tokens[2], id, 'b');
            registerTerminal(tokens[3], id, 'cp');
            registerTerminal(tokens[4], id, 'cn');
            break;
          }
          const plugin = getPlugin('switch');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.closed = /on/i.test(tokens[6] || '') || tokens.length === 6;
          components.push({
            id, type: 'switch', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'a');
          registerTerminal(tokens[2], id, 'b');
          break;
        }
        case 'X': {  // Sub-circuit call — parse as a generic component with net connections
          if (tokens.length < 4) {
            warnings.push(`Line ${lineNum + 1}: X card needs at least nodes + model: "${line}"`);
            continue;
          }
          const id = tokens[0];
          // Last token is the subckt name, middle tokens are nodes
          const nodeTokens = tokens.slice(1, -1);
          const subcktName = tokens[tokens.length - 1];
          // Create a generic component — the subckt's internal components are
          // not expanded, but the external nodes are wired as terminals.
          const plugin = getPlugin('connector');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.resistance = 0.001; // near-zero resistance passthrough
          params.label = subcktName;
          components.push({
            id, type: 'connector', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          // Wire first two nodes as a/b terminals (simplified)
          if (nodeTokens.length >= 2) {
            registerTerminal(nodeTokens[0], id, 'a');
            registerTerminal(nodeTokens[1], id, 'b');
          }
          warnings.push(`Line ${lineNum + 1}: sub-circuit "${subcktName}" imported as passthrough connector (nodes: ${nodeTokens.join(', ')})`);
          continue;
        }
        case 'T': {  // Lossless transmission line: T<name> a1 a2 b1 b2 [Z0=.. TD=..]
          if (tokens.length < 5) {
            errors.push(`Line ${lineNum + 1}: T card needs 4 nodes + Z0/TD params: "${line}"`);
            continue;
          }
          const id = tokens[0];
          // Params after the 4 nodes: Z0= (or ZO=) and TD= (case-insensitive).
          let Z0 = 50, Td = 0, sawZ0 = false, sawTd = false, sawFreqForm = false;
          for (let k = 5; k < tokens.length; k++) {
            const pm = tokens[k].match(/^([A-Za-z_][\w]*)\s*=\s*(.+)$/);
            if (!pm) continue;
            const key = pm[1].toLowerCase();
            if (key === 'z0' || key === 'zo') { Z0 = parseSpiceValue(pm[2]); sawZ0 = true; }
            else if (key === 'td') { Td = parseSpiceValue(pm[2]); sawTd = true; }
            else if (key === 'f') sawFreqForm = true; // F=/NL= normalized-frequency form
          }
          if (!sawTd && sawFreqForm) {
            warnings.push(`Line ${lineNum + 1}: T card "${id}" uses the F=/NL= frequency form — TD is required; imported with TD=${Td}s. Convert F/NL to TD = NL/F manually.`);
          } else if (!sawTd) {
            warnings.push(`Line ${lineNum + 1}: T card "${id}" has no TD= — imported as a zero-delay line.`);
          }
          if (!sawZ0) warnings.push(`Line ${lineNum + 1}: T card "${id}" has no Z0= — defaulting to 50 Ω.`);
          const plugin = getPlugin('transLineLossless');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.Z0 = Z0;
          params.Td = Td;
          components.push({
            id, type: 'transLineLossless', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'a1');
          registerTerminal(tokens[2], id, 'a2');
          registerTerminal(tokens[3], id, 'b1');
          registerTerminal(tokens[4], id, 'b2');
          break;
        }
        case 'O': {  // Lossy line (ngspice LTRA): O<name> a1 a2 b1 b2 <model>
          if (tokens.length < 6) {
            errors.push(`Line ${lineNum + 1}: O card needs 4 nodes + model name: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const modelName = tokens[5];
          const model = modelDefs.get(modelName.toLowerCase());
          if (!model || model.type !== 'LTRA') {
            warnings.push(`Line ${lineNum + 1}: O card "${id}" references model "${modelName}" which is not a defined LTRA model — using default RLGC parameters.`);
          }
          const mp = model?.params;
          const plugin = getPlugin('transLineLossy');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          if (mp?.has('r')) params.RperLen = mp.get('r');
          if (mp?.has('l')) params.LperLen = mp.get('l');
          if (mp?.has('g')) params.GperLen = mp.get('g');
          if (mp?.has('c')) params.CperLen = mp.get('c');
          if (mp?.has('len')) params.length = mp.get('len');
          components.push({
            id, type: 'transLineLossy', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'a1');
          registerTerminal(tokens[2], id, 'a2');
          registerTerminal(tokens[3], id, 'b1');
          registerTerminal(tokens[4], id, 'b2');
          break;
        }
        default:
          // Unknown card — warn but continue
          warnings.push(`Line ${lineNum + 1}: unknown card type "${cardType}" in "${line}"`);
          continue;
      }
    } catch (e) {
      errors.push(`Line ${lineNum + 1}: parse error: ${(e as Error).message}`);
      continue;
    }
  }

  if (components.length === 0) {
    errors.push('No components found in netlist');
    return { doc: null, errors, warnings };
  }

  // ── K couplings: fold the coupled L cards into one multi-winding component ──
  if (kCards.length > 0) {
    const parent = new Map<string, string>();
    const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
    for (const kc of kCards) for (const l of kc.ls) if (!parent.has(l.toLowerCase())) parent.set(l.toLowerCase(), l.toLowerCase());
    for (const kc of kCards) { const r0 = find(kc.ls[0].toLowerCase()); for (const l of kc.ls.slice(1)) parent.set(find(l.toLowerCase()), r0); }
    const groups = new Map<string, string[]>();
    for (const l of parent.keys()) { const r = find(l); (groups.get(r) ?? groups.set(r, []).get(r)!).push(l); }
    let gi = 0;
    for (const members of groups.values()) {
      const infos = members.map((m) => ({ m, info: lInfo.get(m) }));
      if (infos.some((x) => !x.info)) { warnings.push(`K card references unknown inductor(s) in group ${members.join(',')} — coupling ignored.`); continue; }
      if (members.length > 3) { warnings.push(`K coupling group ${members.join(',')} has more than 3 windings — only the first 3 are coupled.`); members.length = 3; infos.length = 3; }
      const n = members.length as 2 | 3;
      const type = n === 2 ? 'spiceMutual2' : 'spiceMutual3';
      const plugin = getPlugin(type);
      const params: any = {};
      if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
      const ordered = infos.map((x, j) => ({ ...x, j }));
      const origIds = ordered.map((x) => components.find((c) => c.id.toLowerCase() === x.m)!.id);
      ordered.forEach((x, j) => { params[`L${j + 1}`] = x.info!.value; });
      for (const key of Object.keys(params)) if (/^k\d\d$/.test(key)) params[key] = 0;
      for (const kc of kCards) {
        const idx = kc.ls.map((l) => members.indexOf(l.toLowerCase())).filter((i) => i >= 0);
        for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
          const lo = Math.min(idx[a], idx[b]) + 1, hi = Math.max(idx[a], idx[b]) + 1;
          params[`k${lo}${hi}`] = kc.k;
        }
      }
      const id = `K_${origIds.join('_')}`.slice(0, 40) + (gi++ ? `_${gi}` : '');
      // remove the plain inductors and their net registrations
      for (const oid of origIds) {
        const ci = components.findIndex((c) => c.id === oid);
        if (ci >= 0) components.splice(ci, 1);
        for (const arr of netMembers.values()) for (let q = arr.length - 1; q >= 0; q--) if (arr[q].componentId === oid) arr.splice(q, 1);
      }
      components.push({ id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: params });
      ordered.forEach((x, j) => { registerTerminal(x.info!.n1, id, `a${j + 1}`); registerTerminal(x.info!.n2, id, `b${j + 1}`); });
    }
  }

  // If any net references ground (0/gnd), ensure a ground component exists.
  if (netMap.has('0') || netMap.has('gnd') || netMap.has('ground')) {
    ensureGround();
  }

  // Behavioral sources reference nets by NAME inside their expressions
  // (V(in), V(a,b)). The engine resolves those through netLabel components,
  // so for every V(name) reference attach a netLabel to one terminal of that
  // net — otherwise the imported expression silently reads 0V.
  const behavSources = components.filter(c => c.type === 'bvSource' || c.type === 'biSource');
  if (behavSources.length > 0) {
    // Preserve the expression's exact case — netNames lookup is case-sensitive.
    const referenced = new Map<string, string>(); // lowercase → as-written
    for (const b of behavSources) {
      const expr = String(b.parameters.expr ?? '');
      for (const m of expr.matchAll(/V\s*\(\s*([A-Za-z_][\w]*)/g)) {
        if (m[1]) referenced.set(m[1].toLowerCase(), m[1]);
      }
    }
    let labelCount = 0;
    for (const [lower, asWritten] of referenced) {
      if (lower === '0' || lower === 'gnd' || lower === 'ground') continue; // ground alias
      const nid = netMap.get(lower);
      const members = netMembers.get(nid);
      if (!members || members.length === 0) {
        warnings.push(`Behavioral expression references unknown net "${asWritten}" — it will read 0V.`);
        continue;
      }
      const plugin = getPlugin('netLabel');
      const params: any = {};
      if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
      params.net = asWritten;
      const labelId = `NL${labelCount++}`;
      components.push({
        id: labelId, type: 'netLabel', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
      });
      members.push({ componentId: labelId, terminalId: 'p' });
    }
  }

  // Build wires
  placeComponents(components);
  const wires: Wire[] = [];
  wires.push(...buildWiresFromNets(netMembers));
  if (groundId) {
    wires.push(...connectGroundNets(netMembers, components, groundId));
  }

  const doc: CircuitDocument = {
    version: 1,
    components,
    wires,
  };
  // Attach preserved control cards so the directive editor + sim options
  // round-trip imported netlists (previously dropped on the floor).
  (doc as unknown as { simOptions: unknown }).simOptions = {
    initialConditions,
    nodeSets,
    saveNodes: [],
    printNodes: [],
    directives: directiveOptions,
    temp: directiveTemp,
    cards: directiveCards,
  };

  const nets = new Map<string, { componentId: string; terminalId: string }>();
  for (const [name, id] of (netMap as unknown as { nameToId: Map<string, number> }).nameToId) {
    const members = (netMembers.get(id) ?? []).filter((m) => m.componentId !== groundId);
    if (id === 0 || name === '0' || name === 'gnd' || name === 'ground') { if (groundId) nets.set(name, { componentId: groundId, terminalId: 'g' }); }
    else if (members.length > 0) nets.set(name, members[0]);
  }
  return { doc, errors, warnings, nets, analyses };
}

/** ngspice B-source expressions accept engineering suffixes (30m, 1k, 2.2u, 1meg); the app's evaluator wants plain numbers. */
export function plainNumbers(expr: string): string {
  return expr.replace(/(?<![\w.])(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)(meg|mil|[tgkmunpfTGKMUNPF])(?![\w(])/gi, (_m, n: string, suf: string) => String(parseSpiceValue(n + suf)));
}

/** Split "[DC] v [AC mag [phase]] [SIN|PULSE|PWL|EXP(...)]" into numeric fields; waveform args are SI numbers. */
function parseSourceSpec(joined: string, tran?: { tstep: number; tstop: number }) {
  let rest = joined;
  let wave: string | undefined;
  let waveKind: string | undefined;
  let waveArgs: number[] = [];
  const wm = rest.match(/\b(SINE?|PULSE|PWL|EXP)\s*\(([^)]*)\)/i);
  if (wm) {
    waveKind = wm[1].toLowerCase() === 'sine' ? 'sin' : wm[1].toLowerCase();
    waveArgs = wm[2].trim().split(/[\s,]+/).filter(Boolean).map(parseSpiceValue);
    if (waveKind === 'pulse' && tran) {
      // SPICE defaults: TR = TF = TSTEP, PW = PER = TSTOP
      while (waveArgs.length < 7) waveArgs.push(NaN);
      if (!Number.isFinite(waveArgs[2])) waveArgs[2] = 0;
      if (!Number.isFinite(waveArgs[3])) waveArgs[3] = tran.tstep;
      if (!Number.isFinite(waveArgs[4])) waveArgs[4] = tran.tstep;
      if (!Number.isFinite(waveArgs[5])) waveArgs[5] = tran.tstop;
      if (!Number.isFinite(waveArgs[6])) waveArgs[6] = tran.tstop;
    }
    wave = `${waveKind.toUpperCase()}(${waveArgs.join(' ')})`;
    rest = rest.replace(wm[0], ' ');
  }
  let acMag = 0, acPhase = 0, hasAc = false;
  const am = rest.match(/\bAC\s+([^\s]+)(?:\s+([-+.\d][^\s]*))?/i);
  if (am) {
    hasAc = true; acMag = parseSpiceValue(am[1]); acPhase = am[2] ? parseSpiceValue(am[2]) : 0;
    rest = rest.replace(am[0], ' ');
  }
  let dc = 0, dcGiven = false;
  const dm = rest.match(/(?:\bDC\s+)?([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[a-zA-Zµ]*)/i);
  if (dm && !/^\s*$/.test(rest)) { dc = parseSpiceValue(dm[1]); dcGiven = true; }
  return { dc, dcGiven, acMag, acPhase, hasAc, wave, waveKind, waveArgs };
}
