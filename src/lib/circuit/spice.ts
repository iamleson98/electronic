// SPICE netlist parser. Converts a SPICE-style netlist into a CircuitDocument
// that can be loaded by the editor.
//
// Supported SPICE syntax (a subset of SPICE3):
//
//   * comment line
//   .title My Circuit        (optional, ignored)
//   .end                     (end of netlist)
//
//   R<name> n+ n- <value>           ; resistor
//   C<name> n+ n- <value>           ; capacitor
//   L<name> n+ n- <value>           ; inductor
//   V<name> n+ n- DC <value>        ; DC voltage source
//   V<name> n+ n- SINE(<offset> <amp> <freq> [<phase>])
//   V<name> n+ n- PULSE(<v1> <v2> <td> <tr> <tf> <pw> <period>)
//   I<name> n+ n- DC <value>        ; DC current source
//   D<name> n+ n- <model>           ; diode (uses default threshold model)
//   Q<name> nc nb ne [<model>]      ; BJT (auto-detect NPN/PNP from model name)
//   M<name> nd ng ns [<model>]      ; MOSFET (auto-detect NMOS/PMOS)
//   X<name> <pins...> <subckt>      ; sub-circuit call (flattened to known primitives)
//   .subckt <name> <pins...>        ; sub-circuit definition
//   .ends [<name>]
//   .model <name> <type> <params>   ; e.g. .model QN NPN(Is=10f N=1 Vaf=100)
//   .ic v(node)=value               ; initial condition (used as initial voltage for caps)
//   .tran <tstep> <tstop>           ; ignored (use simulator's own dt/speed)
//   .options ...                    ; ignored
//
// Value suffixes: T/G/M/K/(/m/u/n/p/f) — case-insensitive except M (mega) vs m (milli).
// SPICE's M = milli, Meg = mega. We honor that.
//
// Node "0" is ground.

import type { CircuitComponent, CircuitDocument, Wire } from './types';
import { getPlugin } from './registry';
import './components'; // register all built-in plugins

let idCounter = 1000;
function genId(prefix: string): string {
  idCounter++;
  return `spice_${prefix}_${idCounter}`;
}

function defaultsFor(type: string): Record<string, number | string | boolean> {
  const plugin = getPlugin(type);
  if (!plugin) return {};
  const defaults: Record<string, number | string | boolean> = {};
  for (const p of plugin.parameters) defaults[p.key] = p.default;
  return defaults;
}

/** Parse a SPICE value string like "1k", "10u", "2.2Meg", "100n" into a number.
 * Single canonical parser (spice-import.ts re-exports this): handles compound
 * unit suffixes ("1uF", "10nF", "2.2mH"), µ, mil, meg-vs-m, Hz/ohm stripping.
 */
export function parseSpiceValue(s: string): number {
  const str = s.trim().replace(/,/g, '');
  // Use a regex to split number from suffix (µ included)
  const m = str.match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)([a-zA-Zµ]*)$/);
  if (!m) return parseFloat(str) || 0;
  const num = parseFloat(m[1]);
  let suffix = m[2];
  if (!suffix) return num;
  // SPICE suffixes (case-insensitive, but Meg vs m distinction)
  const lower = suffix.toLowerCase();
  const multMap: Record<string, number> = {
    't': 1e12, 'g': 1e9, 'meg': 1e6, 'k': 1e3,
    'm': 1e-3, 'mil': 25.4e-6,
    'u': 1e-6, 'µ': 1e-6,
    'n': 1e-9, 'p': 1e-12,
    'hz': 1, 's': 1, 'v': 1, 'a': 1, 'ohm': 1, 'ohms': 1, 'f': 1e-15, 'h': 1,
  };
  // meg/mil first (multi-letter) to avoid falling into 'm'
  if (lower.startsWith('meg')) return num * 1e6;
  if (lower.startsWith('mil')) return num * 25.4e-6;
  // compound unit suffixes: leading scale letter + trailing unit (uF, nF, mH, kHz, ohms)
  const first = lower[0];
  if (multMap[first] !== undefined) return num * multMap[first];
  if (multMap[lower] !== undefined) return num * multMap[lower];
  // strip trailing unit suffixes (Hz, V, A, F, H, Ohms, S)
  const stripped = lower.replace(/(ohms?|hz|volts?|amps?|farads?|henries|henrys?|seconds?|sec|meters?|metres?)$/, '');
  if (stripped && multMap[stripped] !== undefined) return num * multMap[stripped];
  // unknown suffix - just return number
  return num;
}

function parseModelParams(paramsStr: string): Record<string, number> {
  const result: Record<string, number> = {};
  // split on whitespace, but parameters come as key=value
  const parts = paramsStr.match(/(\w+)\s*=\s*([^\s]+)/g) || [];
  for (const part of parts) {
    const [k, v] = part.split('=').map(s => s.trim());
    result[k.toLowerCase()] = parseSpiceValue(v);
  }
  return result;
}

interface SpiceModel {
  name: string;
  type: string; // NPN, PNP, NMOS, PMOS, D, etc.
  params: Record<string, number>;
}

/**
 * Find the .model name in a Q/M card. The model token position is ambiguous
 * (Q/M may have an extra substrate/bulk node, and M allows trailing L=/W=
 * inline params), so prefer a token that is a KNOWN model name and fall back
 * to the first non-key=value token after the required nodes. Previously this
 * took tokens[tokens.length-1], which misread "M1 d g s MOD L=5u W=20u" as
 * model "W=20u" (silently losing the model card).
 */
function findModelName(
  tokens: string[],
  startIdx: number,
  models: Map<string, SpiceModel>,
): string | undefined {
  let fallback: string | undefined;
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (models.has(t.toLowerCase())) return t;
    if (fallback === undefined && !/=/.test(t)) fallback = t;
  }
  return fallback;
}

interface SubCkt {
  name: string;
  pins: string[];
  body: string[]; // raw lines
}

/** Tokenize a SPICE line into tokens, honoring parens. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    // skip whitespace
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    // handle parentheses: group everything inside one token if it starts with ( and ends with )
    if (line[i] === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < line.length && depth > 0) {
        if (line[j] === '(') depth++;
        else if (line[j] === ')') depth--;
        if (depth === 0) break;
        j++;
      }
      const inner = line.slice(i + 1, j);
      tokens.push(`(${inner})`);
      i = j + 1;
      continue;
    }
    // regular token: until whitespace or (
    let j = i;
    while (j < line.length && !/\s/.test(line[j]) && line[j] !== '(') j++;
    tokens.push(line.slice(i, j));
    i = j;
  }
  return tokens;
}

/**
 * Parse a SPICE netlist string into a CircuitDocument.
 * Throws on parse errors.
 */
export function parseSpiceNetlist(netlist: string): CircuitDocument {
  // 0. Pre-process: join continuation lines (lines starting with '+')
  const rawLines = netlist.split(/\r?\n/);
  const lines: string[] = [];
  for (const raw of rawLines) {
    const line = raw.trim();
    if (line.startsWith('+')) {
      if (lines.length > 0) {
        lines[lines.length - 1] += ' ' + line.slice(1).trim();
      }
      continue;
    }
    lines.push(line);
  }

  // 1. First pass: collect .subckt definitions, .model statements, .ic, .nodeset, .save, .print
  const models = new Map<string, SpiceModel>();
  const subckts = new Map<string, SubCkt>();
  let currentSubckt: SubCkt | null = null;
  const initialConditions: Record<string, number> = {};
  const nodeSets: Record<string, number> = {};
  const saveNodes: string[] = [];
  const printNodes: string[] = [];
  // Full simulation-control directives (previously ignored): .options fields
  // map onto SimOptions, .temp sets temperature, .tran/.ac/.dc/.step/.mc /
  // .worst/.probe are preserved verbatim for the directive editor + export.
  const directiveOptions: Record<string, number | string | boolean> = {};
  let directiveTemp: number | undefined;
  const directiveCards: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith('*') || line.startsWith(';')) continue;
    const tokens = tokenize(line);
    if (tokens.length === 0) continue;
    const head = tokens[0].toLowerCase();

    // .IC v(node)=value [v(node2)=value2 ...]
    if (head === '.ic') {
      for (let i = 1; i < tokens.length; i++) {
        const m = tokens[i].match(/^v\(([^)]+)\)\s*=\s*(.+)$/i);
        if (m) initialConditions[m[1]] = parseSpiceValue(m[2]);
      }
      continue;
    }
    // .NODESET v(node)=value
    if (head === '.nodeset') {
      for (let i = 1; i < tokens.length; i++) {
        const m = tokens[i].match(/^v\(([^)]+)\)\s*=\s*(.+)$/i);
        if (m) nodeSets[m[1]] = parseSpiceValue(m[2]);
      }
      continue;
    }
    // .SAVE v(node) [v(node2) ...]
    if (head === '.save') {
      for (let i = 1; i < tokens.length; i++) {
        const m = tokens[i].match(/^v\(([^)]+)\)$/i);
        if (m) saveNodes.push(m[1]);
      }
      continue;
    }
    // .PRINT TRAN v(node) [v(node2) ...]
    if (head === '.print') {
      for (let i = 2; i < tokens.length; i++) {
        const m = tokens[i].match(/^v\(([^)]+)\)$/i);
        if (m) printNodes.push(m[1]);
      }
      directiveCards.push(line);
      continue;
    }
    // .OPTIONS key=value ... (RELTOL, VNTOL, ABSTOL, GMIN, ITL1, METHOD, TEMP...)
    if (head === '.options') {
      for (let i = 1; i < tokens.length; i++) {
        const kv = tokens[i].match(/^(\w+)\s*=\s*(.+)$/);
        if (kv) {
          const key = kv[1].toLowerCase();
          const raw = kv[2];
          const num = parseSpiceValue(raw);
          directiveOptions[key] = /^(uic|true)$/i.test(raw) ? true : (/^false$/i.test(raw) ? false : num);
          if (key === 'temp' && Number.isFinite(num)) directiveTemp = num;
        }
      }
      directiveCards.push(line);
      continue;
    }
    // .TEMP value — simulation temperature in °C
    if (head === '.temp') {
      const num = tokens.length > 1 ? parseSpiceValue(tokens[1]) : NaN;
      if (Number.isFinite(num)) directiveTemp = num;
      directiveCards.push(line);
      continue;
    }
    // Analysis + sweep cards: preserved verbatim (directive editor + export)
    if (head === '.tran' || head === '.ac' || head === '.dc' || head === '.op' ||
        head === '.step' || head === '.mc' || head === '.worst' || head === '.probe' ||
        head === '.save' || head === '.meas' || head === '.four' || head === '.tf' ||
        head === '.pz' || head === '.noise' || head === '.disto' || head === '.sens') {
      directiveCards.push(line);
      continue;
    }

    if (head === '.subckt') {
      const name = tokens[1];
      const pins = tokens.slice(2);
      currentSubckt = { name, pins, body: [] };
      subckts.set(name.toLowerCase(), currentSubckt);
      continue;
    }
    if (head === '.ends') {
      currentSubckt = null;
      continue;
    }
    if (currentSubckt) {
      currentSubckt.body.push(line);
      continue;
    }
    if (head === '.model') {
      const name = tokens[1];
      const type = tokens[2]?.toLowerCase() || '';
      const paramsStr = tokens.slice(3).join(' ');
      const params = parseModelParams(paramsStr);
      models.set(name.toLowerCase(), { name, type, params });
      continue;
    }
  }

  // 2. Second pass: instantiate components
  // SPICE node names -> our grid positions. We auto-layout components in a row.
  // Map SPICE node name -> our wire graph (we'll create "junction" components at each node).
  const components: CircuitComponent[] = [];
  const wires: Wire[] = [];
  // Track each component instance and its terminal->spiceNode map
  const compTermNodes: { compId: string; termToNode: Record<string, string> }[] = [];

  // Layout: place each component at increasing x position
  let cursorX = 4;
  let cursorY = 6;
  const placedPerRow = 6;
  let placedCount = 0;

  function nextPosition() {
    const pos = { x: cursorX, y: cursorY };
    placedCount++;
    cursorX += 8;
    if (placedCount >= placedPerRow) {
      cursorX = 4;
      cursorY += 6;
      placedCount = 0;
    }
    return pos;
  }

  function addComponent(
    type: string,
    spiceName: string,
    terminalNodes: { terminalId: string; node: string }[],
    params?: Record<string, number | string | boolean>,
  ): CircuitComponent | null {
    const plugin = getPlugin(type);
    if (!plugin) return null;
    const id = genId(spiceName.charAt(0).toLowerCase() || 'x');
    const comp: CircuitComponent = {
      id,
      type,
      position: nextPosition(),
      rotation: 0,
      parameters: { ...defaultsFor(type), ...params },
    };
    components.push(comp);
    const termMap: Record<string, string> = {};
    for (const t of terminalNodes) termMap[t.terminalId] = t.node;
    compTermNodes.push({ compId: id, termToNode: termMap });
    return comp;
  }

  // Track all node names -> we'll create junction components for each non-ground node
  // and wire them. Actually simpler: store node names and create wires after all
  // components are placed, using the compTermNodes array.
  const allNodes = new Set<string>();

  // SPICE title-line heuristic (same convention as spice-import.ts): the first
  // line of a netlist is always the title. Only skip it when it can't possibly
  // be a well-formed element card, so fixture netlists whose first line IS a
  // real element (e.g. "V1 1 0 5") keep working.
  const MIN_CARD_TOKENS: Record<string, number> = {
    R: 4, C: 4, L: 4, V: 4, I: 4, B: 4, D: 4, Q: 5, M: 5, S: 6,
    T: 5, O: 6, X: 4, E: 5, F: 5, G: 5, H: 5, K: 4, W: 4, Z: 4, N: 4, P: 4,
  };
  function isTitleLine(line: string): boolean {
    if (line.startsWith('*') || line.startsWith(';') || line.startsWith('.')) return false;
    const tokens = tokenize(line);
    if (tokens.length === 0) return false;
    const letter = tokens[0][0].toUpperCase();
    const min = MIN_CARD_TOKENS[letter];
    return min === undefined || tokens.length < min;
  }
  let sawFirstCard = false;

  // Sub-circuit expansion: flatten X-calls (iteratively, so nested .subckt
  // calls — an X card whose body contains another X call — expand too).
  // For each X<name> <pins...> <subcktName>, expand the subckt's body lines
  // with pin name substitution.
  //
  // Renamed elements keep their DEVICE letter first (`R1_X1`, not `X1_R1`)
  // so the card-type switch below still recognizes them — the old X-prefixed
  // names made every expanded element look like an X card and it was skipped.
  function expandOnce(input: string[]): { out: string[]; expanded: boolean } {
    const out: string[] = [];
    let expanded = false;
    let inSubcktDef = false;
    for (let li = 0; li < input.length; li++) {
      const line = input[li];
      if (!line || line.startsWith('*') || line.startsWith(';')) continue;
      const tokens = tokenize(line);
      if (tokens.length === 0) continue;
      const head = tokens[0];
      const headLower = head.toLowerCase();
      if (headLower === '.subckt') { inSubcktDef = true; continue; }
      if (headLower === '.ends') { inSubcktDef = false; continue; }
      // Lines INSIDE a .subckt definition must NOT be instantiated at top
      // level — they only exist through X-call expansion. The old code leaked
      // them through as top-level elements on the subckt's FORMAL pin names.
      if (inSubcktDef) continue;
      if (headLower === '.model') continue;
      if (headLower.startsWith('.option') || headLower.startsWith('.tran') ||
          headLower.startsWith('.dc') || headLower.startsWith('.ac') || headLower.startsWith('.ic') ||
          headLower.startsWith('.end')) {
        // skip simulation control (note: .ic will be handled separately below)
        continue;
      }
      if (!sawFirstCard) {
        sawFirstCard = true;
        if (isTitleLine(line)) continue;
      }
      if (head[0] === 'X' || head[0] === 'x') {
        // subckt call: X<name> <pin1> <pin2> ... <subcktName>
        const subcktName = tokens[tokens.length - 1].toLowerCase();
        const pins = tokens.slice(1, -1);
        const sub = subckts.get(subcktName);
        if (!sub) {
          throw new Error(`Unknown subcircuit: ${subcktName}`);
        }
        // map subckt's formal pins to actual pins (SPICE is case-insensitive)
        const pinMap: Record<string, string> = {};
        sub.pins.forEach((formal, i) => {
          pinMap[formal.toLowerCase()] = pins[i] || '0';
        });
        // expand body, substituting node names
        for (const bodyLine of sub.body) {
          const bTokens = tokenize(bodyLine);
          if (bTokens.length === 0) continue;
          // rename: keep the device letter first (R1_X1), substitute nodes
          const newName = `${bTokens[0]}_${head}`;
          const newTokens = [newName];
          for (let i = 1; i < bTokens.length; i++) {
            const t = bTokens[i];
            // if it's a node name (matches a formal pin), substitute
            const mapped = pinMap[t.toLowerCase()];
            if (mapped !== undefined) newTokens.push(mapped);
            else newTokens.push(t);
          }
          out.push(newTokens.join(' '));
          expanded = true;
        }
        continue;
      }
      out.push(line);
    }
    return { out, expanded };
  }
  let expandedLines = lines;
  {
    const first = expandOnce(lines);
    expandedLines = first.out;
    // Nested subckts: keep expanding until no X cards remain (depth-capped so
    // a recursive .subckt definition can't loop forever).
    for (let depth = 0; depth < 10 && first.expanded; depth++) {
      const next = expandOnce(expandedLines);
      expandedLines = next.out;
      if (!next.expanded) break;
    }
  }

  // Process .ic v(node)=value (initial conditions) for capacitors
  const icMap: Record<string, number> = {};
  for (const line of lines) {
    if (!line) continue;
    const tokens = tokenize(line);
    if (tokens[0]?.toLowerCase() === '.ic') {
      // .ic V(n1)=5 V(n2)=3.3
      for (let i = 1; i < tokens.length; i++) {
        const m = tokens[i].match(/^v\(([^)]+)\)\s*=\s*(.+)$/i);
        if (m) {
          icMap[m[1].toLowerCase()] = parseSpiceValue(m[2]);
        }
      }
    }
  }

  // Process expanded lines
  for (const line of expandedLines) {
    const tokens = tokenize(line);
    if (tokens.length === 0) continue;
    const name = tokens[0];
    const first = name[0].toUpperCase();

    switch (first) {
      case 'R': {
        const n1 = tokens[1], n2 = tokens[2];
        const value = parseSpiceValue(tokens[3]);
        allNodes.add(n1); allNodes.add(n2);
        addComponent('resistor', name, [
          { terminalId: 'a', node: n1 },
          { terminalId: 'b', node: n2 },
        ], { resistance: value });
        break;
      }
      case 'C': {
        const n1 = tokens[1], n2 = tokens[2];
        const value = parseSpiceValue(tokens[3]);
        allNodes.add(n1); allNodes.add(n2);
        // initial voltage from .ic
        const ic = icMap[n1.toLowerCase()] !== undefined
          ? Math.abs(icMap[n1.toLowerCase()])
          : (icMap[n2.toLowerCase()] !== undefined ? Math.abs(icMap[n2.toLowerCase()]) : 0);
        addComponent('capacitor', name, [
          { terminalId: 'a', node: n1 },
          { terminalId: 'b', node: n2 },
        ], { capacitance: value, initialV: ic });
        break;
      }
      case 'L': {
        const n1 = tokens[1], n2 = tokens[2];
        const value = parseSpiceValue(tokens[3]);
        allNodes.add(n1); allNodes.add(n2);
        addComponent('inductor', name, [
          { terminalId: 'a', node: n1 },
          { terminalId: 'b', node: n2 },
        ], { inductance: value });
        break;
      }
      case 'V': {
        const n1 = tokens[1], n2 = tokens[2];
        allNodes.add(n1); allNodes.add(n2);
        // Look at rest of tokens: DC <val> | SINE(...) | PULSE(...) | just <val>
        const rest = tokens.slice(3);
        if (rest.length === 0) break;
        const kind = rest[0].toUpperCase();
        if (kind === 'DC') {
          const v = parseSpiceValue(rest[1] || '0');
          // Check if there's also a SINE/PULSE after the DC value (mixed form: DC 0 SINE(...))
          const sineIdx = rest.findIndex(t => t.toUpperCase().startsWith('SINE'));
          const pulseIdx = rest.findIndex(t => t.toUpperCase().startsWith('PULSE'));
          if (sineIdx >= 0) {
            // DC 0 SINE(offset amp freq) — create AC source
            const argsStr = rest[sineIdx].slice(rest[sineIdx].indexOf('(') + 1, -1) ||
                           (rest[sineIdx + 1] || '').slice(1, -1) || '';
            const args = argsStr.split(/\s+/).filter(Boolean);
            addComponent('acVoltage', name, [
              { terminalId: 'p', node: n1 },
              { terminalId: 'n', node: n2 },
            ], {
              offset: parseSpiceValue(args[0] || '0'),
              amplitude: parseSpiceValue(args[1] || '1'),
              frequency: parseSpiceValue(args[2] || '1'),
              phase: parseSpiceValue(args[3] || '0'),
            });
          } else if (pulseIdx >= 0) {
            // DC 0 PULSE(...) — create pulse source
            const argsStr = rest[pulseIdx].slice(rest[pulseIdx].indexOf('(') + 1, -1) ||
                           (rest[pulseIdx + 1] || '').slice(1, -1) || '';
            const args = argsStr.split(/\s+/).filter(Boolean);
            addComponent('pulseSource', name, [
              { terminalId: 'p', node: n1 },
              { terminalId: 'n', node: n2 },
            ], {
              low: parseSpiceValue(args[0] || '0'),
              high: parseSpiceValue(args[1] || '5'),
              frequency: parseSpiceValue(args[7] || '100'),
              duty: 50,
            });
          } else {
            addComponent('dcVoltage', name, [
              { terminalId: 'p', node: n1 },
              { terminalId: 'n', node: n2 },
            ], { voltage: v });
          }
        } else if (kind.startsWith('SINE') || kind === 'SINE') {
          // (offset amp freq [phase])
          const argsStr = rest.find(t => t.startsWith('('))?.slice(1, -1) || '';
          const args = argsStr.split(/\s+/).filter(Boolean);
          addComponent('acVoltage', name, [
            { terminalId: 'p', node: n1 },
            { terminalId: 'n', node: n2 },
          ], {
            offset: parseSpiceValue(args[0] || '0'),
            amplitude: parseSpiceValue(args[1] || '1'),
            frequency: parseSpiceValue(args[2] || '1'),
            phase: parseSpiceValue(args[3] || '0'),
          });
        } else if (kind.startsWith('PULSE') || kind === 'PULSE') {
          const argsStr = rest.find(t => t.startsWith('('))?.slice(1, -1) || '';
          const args = argsStr.split(/\s+/).filter(Boolean);
          // PULSE(v1 v2 td tr tf pw per)
          const v1 = parseSpiceValue(args[0] || '0');
          const v2 = parseSpiceValue(args[1] || '5');
          const pw = parseSpiceValue(args[5] || '0.5');
          const per = parseSpiceValue(args[6] || '1');
          const duty = per > 0 ? (pw / per) * 100 : 50;
          const freq = per > 0 ? 1 / per : 1;
          addComponent('pulseSource', name, [
            { terminalId: 'p', node: n1 },
            { terminalId: 'n', node: n2 },
          ], { high: v2, low: v1, frequency: freq, duty });
        } else {
          // bare number
          const v = parseSpiceValue(rest[0]);
          addComponent('dcVoltage', name, [
            { terminalId: 'p', node: n1 },
            { terminalId: 'n', node: n2 },
          ], { voltage: v });
        }
        break;
      }
      case 'I': {
        const n1 = tokens[1], n2 = tokens[2];
        allNodes.add(n1); allNodes.add(n2);
        const rest = tokens.slice(3);
        const kind = rest[0]?.toUpperCase();
        if (kind === 'DC' || rest.length === 1) {
          const i = parseSpiceValue(rest.length === 1 ? rest[0] : rest[1]);
          addComponent('currentSource', name, [
            { terminalId: 'p', node: n1 },
            { terminalId: 'n', node: n2 },
          ], { current: i });
        }
        break;
      }
      case 'D': {
        const na = tokens[1], nk = tokens[2];
        const modelName = tokens[3];
        const model = models.get(modelName?.toLowerCase());
        allNodes.add(na); allNodes.add(nk);
        const vf = model?.params['bv'] ? 0.7 : 0.7; // default
        addComponent('diode', name, [
          { terminalId: 'a', node: na },
          { terminalId: 'k', node: nk },
        ], { forwardV: vf });
        break;
      }
      case 'Q': {
        // Q<name> nc nb ne [ns] <model> [area/off params]
        const nc = tokens[1], nb = tokens[2], ne = tokens[3];
        const modelName = findModelName(tokens, 4, models);
        const model = models.get((modelName ?? '').toLowerCase());
        const type = model?.type || 'npn';
        allNodes.add(nc); allNodes.add(nb); allNodes.add(ne);
        const pluginType = type === 'pnp' ? 'pnp' : 'npn';
        // Apply ALL model parameters as component parameters (full .MODEL card support)
        // Common BJT params: Bf (hfe), Is, Vaf, Nf, Ikf, Ise, Ne, Br, Var, Nc, Ikr, Isc, Nc, Rb, Rc, Re, Cje, Cjc, Cjs, Mje, Mjc, Mjs, Vje, Vjc, Vjs, Tf, Xtf, Itf, Vtf, Tr)
        const params: Record<string, number> = {
          hfe: model?.params['bf'] ?? 100,
          is: model?.params['is'] ?? 1e-14,
          vaf: model?.params['vaf'] ?? 0,
          nf: model?.params['nf'] ?? 1,
          ikf: model?.params['ikf'] ?? 0,
          br: model?.params['br'] ?? 1,
          var: model?.params['var'] ?? 0,
          rb: model?.params['rb'] ?? 0,
          rc: model?.params['rc'] ?? 0,
          re: model?.params['re'] ?? 0,
          cje: model?.params['cje'] ?? 0,
          cjc: model?.params['cjc'] ?? 0,
          cjs: model?.params['cjs'] ?? 0,
          tf: model?.params['tf'] ?? 0,
          tr: model?.params['tr'] ?? 0,
        };
        addComponent(pluginType, name, [
          { terminalId: 'c', node: nc },
          { terminalId: 'b', node: nb },
          { terminalId: 'e', node: ne },
        ], params);
        break;
      }
      case 'M': {
        // M<name> nd ng ns [nb] <model> [L=...] [W=...]
        const nd = tokens[1], ng = tokens[2], ns = tokens[3];
        const modelName = findModelName(tokens, 4, models);
        const model = models.get((modelName ?? '').toLowerCase());
        const type = model?.type || 'nmos';
        allNodes.add(nd); allNodes.add(ng); allNodes.add(ns);
        const pluginType = type === 'pmos' ? 'pmos' : 'nmos';
        // Apply ALL model parameters (full .MODEL card support)
        // Common MOSFET params: Vto, Kp, Gamma, Phi, Lambda, Rd, Rs, Cbd, Cbs, Cgso, Cgdo, Is, N, Pb, Mj, Cj, Cjsw, Mjsw, Tox, U0, Vmax, L, W)
        const params: Record<string, number> = {
          Vto: model?.params['vto'] ?? (type === 'pmos' ? -1 : 1),
          Kp: model?.params['kp'] ?? 0.05,
          Gamma: model?.params['gamma'] ?? 0.5,
          Phi: model?.params['phi'] ?? 0.7,
          Lambda: model?.params['lambda'] ?? 0.02,
          Rd: model?.params['rd'] ?? 0,
          Rs: model?.params['rs'] ?? 0,
          Cbd: model?.params['cbd'] ?? 0,
          Cbs: model?.params['cbs'] ?? 0,
          Cgso: model?.params['cgso'] ?? 0,
          Cgdo: model?.params['cgdo'] ?? 0,
          W: model?.params['w'] ?? 100e-6,
          L: model?.params['l'] ?? 10e-6,
          Is: model?.params['is'] ?? 1e-14,
          N: model?.params['n'] ?? 1,
          Tox: model?.params['tox'] ?? 4e-9,
          U0: model?.params['u0'] ?? 670,
        };
        // Also parse inline L=/W= from the M line itself
        for (let i = 4; i < tokens.length; i++) {
          const m = tokens[i].match(/^([LW])=(.+)$/i);
          if (m) {
            params[m[1].toUpperCase()] = parseSpiceValue(m[2]);
          }
        }
        addComponent(pluginType, name, [
          { terminalId: 'd', node: nd },
          { terminalId: 'g', node: ng },
          { terminalId: 's', node: ns },
        ], params);
        break;
      }
      case 'X': {
        // already expanded - shouldn't reach here
        break;
      }
      default:
        // unknown device - skip
        break;
    }
  }

  // 3. Create a ground component for node "0" (or its aliases gnd/ground —
  // ngspice maps those to 0; KiCad netlists use GND) if any component
  // references it. (We do this implicitly via the wire graph: any terminal
  // whose node is a ground alias gets a ground added and wired.)
  const isGroundNode = (n: string | undefined): boolean =>
    n === '0' || n?.toLowerCase() === 'gnd' || n?.toLowerCase() === 'ground';
  const needsGround = Array.from(allNodes).some(isGroundNode);
  let groundId: string | null = null;
  if (needsGround) {
    const g = addComponent('ground', 'gnd', []);
    if (g) groundId = g.id;
  }

  // 4. Build wires. For each unique non-ground node, we need to connect all
  // terminals that share it. We do this by picking the first terminal as the
  // "hub" and wiring every other terminal to it. For ground, wire to ground.
  const nodesToTerminals = new Map<string, { compId: string; terminalId: string }[]>();
  for (const { compId, termToNode } of compTermNodes) {
    for (const [termId, node] of Object.entries(termToNode)) {
      if (!nodesToTerminals.has(node)) nodesToTerminals.set(node, []);
      nodesToTerminals.get(node)!.push({ compId, terminalId: termId });
    }
  }

  for (const [node, terminals] of nodesToTerminals) {
    if (isGroundNode(node) && groundId) {
      // connect each terminal to ground
      for (const t of terminals) {
        const wire: Wire = {
          id: genId('w'),
          from: { componentId: t.compId, terminalId: t.terminalId },
          to: { componentId: groundId, terminalId: 'g' },
        };
        wires.push(wire);
      }
      continue;
    }
    // non-ground node: connect terminals pairwise (chain)
    if (terminals.length < 2) continue;
    for (let i = 1; i < terminals.length; i++) {
      const wire: Wire = {
        id: genId('w'),
        from: { componentId: terminals[0].compId, terminalId: terminals[0].terminalId },
        to: { componentId: terminals[i].compId, terminalId: terminals[i].terminalId },
      };
      wires.push(wire);
    }
  }

  return {
    version: 1,
    components,
    wires,
    // SPICE directives attached for the engine to consume
    simOptions: {
      initialConditions,
      nodeSets,
      saveNodes,
      printNodes,
      // Parsed control directives: method/reltol/gmin/itl*/temp/uic flow
      // into mergeOptions via the directive editor; `cards` round-trips the
      // verbatim analysis cards (.tran/.ac/.step/...) for export.
      directives: directiveOptions,
      temp: directiveTemp,
      cards: directiveCards,
    },
  } as any;
}
