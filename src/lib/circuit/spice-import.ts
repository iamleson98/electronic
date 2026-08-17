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
//
// Node 0 (or "gnd"/"ground") is treated as the ground node.
// Sub-circuits (.SUBCKT/.ENDS) and .MODEL cards are recognized and skipped
// (the components inside a .SUBCKT are flattened inline as plain elements).
// .TRAN, .AC, .DC, .OP, .END cards are recognized and skipped.
//
// Returns { doc: CircuitDocument | null, errors: string[], warnings: string[] }.
// On parse failure, doc is null and errors contains the messages.

import type { CircuitComponent, Wire, CircuitDocument } from './types';
import { getPlugin } from './registry';

// ─────────────────────────────────────────────────────────────────────────────
// Value parsing — handles SPICE engineering suffixes (case-insensitive)
// ─────────────────────────────────────────────────────────────────────────────

const SPICE_SUFFIXES: Record<string, number> = {
  // SPICE3 standard suffixes
  'f': 1e-15,
  'p': 1e-12,
  'n': 1e-9,
  'u': 1e-6,  // also "µ" but we accept ASCII
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
  const s = raw.trim().toLowerCase();
  if (s === '') return 0;

  // Plain scientific notation: 1e3, 4.7e3, 1.5e-9
  if (/^[+-]?[\d.]+(?:e[+-]?\d+)?$/.test(s)) return parseFloat(s);

  // Engineering suffix (longest match first: "meg" before "m")
  // Match pattern: number + optional suffix + optional trailing junk
  const m = s.match(/^([+-]?[\d.]+(?:e[+-]?\d+)?)([a-zµ%]*)/);
  if (!m) return parseFloat(s) || 0;
  const num = parseFloat(m[1]);
  let suffix = m[2];

  // Special case: "Hz" suffix in frequencies — strip
  if (suffix.endsWith('hz')) suffix = suffix.slice(0, -2);
  // Strip "ohm" / "ohms"
  if (suffix.endsWith('ohms')) suffix = suffix.slice(0, -4);
  else if (suffix.endsWith('ohm')) suffix = suffix.slice(0, -3);
  // Strip "f" / "h" / "r" unit letters when value is clearly numeric (e.g., "1uf" → 1u)
  // But "f" alone is femto, so handle order matters: try longest first.

  if (suffix === '') return num;
  // Try multi-char suffixes first (meg, mil)
  if (suffix.startsWith('meg')) return num * SPICE_SUFFIXES['meg'];
  if (suffix.startsWith('mil')) return num * SPICE_SUFFIXES['mil'];
  // Single char suffix
  const firstChar = suffix[0];
  if (SPICE_SUFFIXES[firstChar] !== undefined) return num * SPICE_SUFFIXES[firstChar];
  // Unknown suffix — strip and return the numeric part
  return num;
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
  private nameToId = new Map<string, number>();
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

  // Ensure components module is loaded so plugins are registered
  // (safe to call multiple times)
  try { require('./components'); } catch { /* may be ESM */ }

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

    // ── Dot commands ────────────────────────────────────────────────────
    if (first === '.SUBCKT') { inSubckt = true; continue; }
    if (first === '.ENDS' || first === '.ENDSUB') { inSubckt = false; continue; }
    if (first === '.END') break;  // end of netlist
    if (first.startsWith('.')) continue;  // .model, .tran, .ac, .dc, .op, etc.

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
          break;
        }
        case 'V': {  // Voltage source: V<name> n+ n- value [SINE(...)]
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: V card needs n+ n- value: "${line}"`);
            continue;
          }
          const id = tokens[0];
          // Look for SINE(...) or DC <value>
          const joined = tokens.slice(3).join(' ');
          const sineMatch = joined.match(/SINE\s*\(\s*([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i);
          if (sineMatch) {
            const voff = parseFloat(sineMatch[1]);
            const vamp = parseFloat(sineMatch[2]);
            const freq = parseFloat(sineMatch[3]);
            const plugin = getPlugin('acVoltage');
            const params: any = {};
            if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
            params.offset = voff;
            params.amplitude = vamp;
            params.frequency = freq;
            components.push({
              id, type: 'acVoltage', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
            });
          } else {
            const value = parseSpiceValue(tokens[3]);
            const plugin = getPlugin('dcVoltage');
            const params: any = {};
            if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
            params.voltage = value;
            components.push({
              id, type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
            });
          }
          registerTerminal(tokens[1], id, 'p');
          registerTerminal(tokens[2], id, 'n');
          break;
        }
        case 'I': {  // Current source: I<name> n+ n- value
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: I card needs n+ n- value: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const value = parseSpiceValue(tokens[3]);
          const plugin = getPlugin('currentSource');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.current = value;
          components.push({
            id, type: 'currentSource', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
          });
          registerTerminal(tokens[1], id, 'p');
          registerTerminal(tokens[2], id, 'n');
          break;
        }
        case 'D': {  // Diode: D<name> n+ n- model
          if (tokens.length < 4) {
            errors.push(`Line ${lineNum + 1}: D card needs n+ n- model: "${line}"`);
            continue;
          }
          const id = tokens[0];
          const plugin = getPlugin('diode');
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.modelName = tokens[3];
          components.push({
            id, type: 'diode', position: { x: 0, y: 0 }, rotation: 0, parameters: params,
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
          const isPnp = /pnp/i.test(modelName) || modelName.toUpperCase().startsWith('2N3906') || modelName.toUpperCase().startsWith('2N4403');
          const type = isPnp ? 'pnp' : 'npn';
          const plugin = getPlugin(type);
          const params: any = {};
          if (plugin) for (const p of plugin.parameters) params[p.key] = p.default;
          params.modelName = modelName;
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

  // If any net references ground (0/gnd), ensure a ground component exists.
  if (netMap.has('0') || netMap.has('gnd') || netMap.has('ground')) {
    ensureGround();
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

  return { doc, errors, warnings };
}
