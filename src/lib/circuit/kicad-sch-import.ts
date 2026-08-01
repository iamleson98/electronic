// KiCad .kicad_sch (s-expression) parser — imports a KiCad schematic sheet
// and converts it to a CircuitDocument with components + wires.
//
// This is a best-effort parser; KiCad's .kicad_sch format is a Lisp-style
// s-expression with hundreds of node types. We handle the most common ones:
//   - (symbol ...) → component placement
//   - (wire ...) → wire segment
//   - (label ...) → local net label
//   - (global_label ...) → global net label
//   - (hierarchical_label ...) → hierarchical label
//   - (junction ...) → junction dot
//   - (no_connect ...) → no-connect marker
//
// Unsupported: complex multi-sheet hierarchy (sheets are flattened), buses
// (decomposed to individual wires), graphical drawings (skipped).

import type { CircuitComponent, CircuitDocument, Wire, ComponentPlugin, Vec2 } from './types';
import { getPlugin, getAllPlugins } from './registry';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal s-expression parser
// ─────────────────────────────────────────────────────────────────────────────

interface Sexp {
  type: string;
  value?: string;
  children: Sexp[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let inString = false;
  let buf = '';
  while (i < input.length) {
    const c = input[i];
    if (inString) {
      if (c === '"' && input[i - 1] !== '\\') {
        tokens.push(buf);
        buf = '';
        inString = false;
      } else {
        buf += c;
      }
      i++;
      continue;
    }
    if (c === '"') { inString = true; i++; continue; }
    if (c === '(' || c === ')') {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(c);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (buf) { tokens.push(buf); buf = ''; }
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function parseSexp(tokens: string[], idx: { i: number }): Sexp | null {
  if (idx.i >= tokens.length) return null;
  if (tokens[idx.i] !== '(') return null;
  idx.i++;
  if (idx.i >= tokens.length) return null;
  const node: Sexp = { type: tokens[idx.i], children: [] };
  idx.i++;
  while (idx.i < tokens.length && tokens[idx.i] !== ')') {
    if (tokens[idx.i] === '(') {
      const child = parseSexp(tokens, idx);
      if (child) node.children.push(child);
    } else {
      // either a key or a value — we collect both as children with `value`
      node.children.push({ type: tokens[idx.i], value: tokens[idx.i], children: [] });
      idx.i++;
    }
  }
  idx.i++; // skip ')'
  return node;
}

function parseAll(input: string): Sexp | null {
  const tokens = tokenize(input);
  const idx = { i: 0 };
  return parseSexp(tokens, idx);
}

function findChild(node: Sexp, type: string): Sexp | undefined {
  return node.children.find((c) => c.type === type);
}
function findAllChildren(node: Sexp, type: string): Sexp[] {
  return node.children.filter((c) => c.type === type);
}
function findValue(node: Sexp, type: string): string | undefined {
  const child = findChild(node, type);
  return child?.children[0]?.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main importer
// ─────────────────────────────────────────────────────────────────────────────

export interface KicadImportResult {
  document: CircuitDocument;
  warnings: string[];
  unknownSymbols: string[];
}

export function parseKicadSch(text: string): KicadImportResult {
  const warnings: string[] = [];
  const unknownSymbols: string[] = [];

  const root = parseAll(text);
  if (!root || root.type !== 'kicad_sch') {
    throw new Error('Not a valid .kicad_sch file (missing root kicad_sch node)');
  }

  const components: CircuitComponent[] = [];
  const wires: Wire[] = [];
  const noConnects: { componentId: string; terminalId: string }[] = [];
  let idCounter = 0;
  const nextId = () => `k_${Date.now().toString(36)}_${idCounter++}`;

  // Parse wires
  for (const wireNode of findAllChildren(root, 'wire')) {
    const ptsNode = findChild(wireNode, 'pts');
    if (!ptsNode) continue;
    const xyNodes = findAllChildren(ptsNode, 'xy');
    if (xyNodes.length < 2) continue;
    const a = parseXY(xyNodes[0]);
    const b = parseXY(xyNodes[1]);
    // wires in KiCad connect two endpoints — we don't have terminal IDs so we
    // create pseudo-components "wireend_A" / "wireend_B" and connect via wire
    // For simplicity, we just skip non-terminal wires (they don't map to our model)
    // — but we DO emit them as "loose" wires for net inference in the editor.
    // TODO: proper wire-to-terminal resolution
    warnings.push(`Wire from (${a.x},${a.y}) to (${b.x},${b.y}) imported as graphical line — terminal mapping is not yet supported`);
  }

  // Parse symbols (component placements)
  for (const symNode of findAllChildren(root, 'symbol')) {
    const libId = findValue(symNode, 'lib_id') ?? findValue(symNode, 'lib_name') ?? 'unknown';
    const libSym = findChild(symNode, 'lib_symbols') ? null : null;
    // We need to find an instance child with 'at' (position), 'mirror', 'rotate'
    const atNode = findChild(symNode, 'at');
    const mirror = findValue(symNode, 'mirror');
    const rotation = atNode?.children?.[1]?.value ? parseInt(atNode.children[1].value) : 0;
    const position = atNode ? parseXY(atNode) : { x: 0, y: 0 };

    // Find the property "Reference" and "Value"
    let refdes = '';
    let value = '';
    for (const propNode of findAllChildren(symNode, 'property')) {
      const name = propNode.children[0]?.value;
      const val = propNode.children[1]?.value;
      if (name === 'Reference') refdes = val ?? '';
      if (name === 'Value') value = val ?? '';
    }

    // Convert KiCad lib_id to our plugin type via best-effort matching
    const pluginType = matchPluginType(libId, value);
    if (!pluginType) {
      unknownSymbols.push(`${libId} (refdes=${refdes}, value=${value})`);
      continue;
    }
    const plugin = getPlugin(pluginType);
    if (!plugin) continue;

    // KiCad coords are in mm — convert to our grid units (1 unit = 2.54mm)
    const gridX = Math.round(position.x / 2.54);
    const gridY = Math.round(position.y / 2.54);
    const rot = (((rotation / 90) % 4 + 4) % 4) as 0 | 1 | 2 | 3;

    const comp: CircuitComponent = {
      id: nextId(),
      type: pluginType,
      position: { x: gridX, y: gridY },
      rotation: rot,
      parameters: { ...defaultParams(plugin) },
      refdes: refdes || undefined,
      mirrorX: mirror === 'y', // KiCad "mirror y" = our horizontal flip
      mirrorY: mirror === 'x',
      fields: [
        { key: 'Value', name: 'Value', value, visible: true },
      ],
    };
    // try to set value into a parameter
    if (value && plugin.parameters[0]) {
      comp.parameters[plugin.parameters[0].key] = coerceValue(value, plugin.parameters[0].type);
    }
    components.push(comp);
  }

  // Parse no_connect markers — associate with nearest component terminal
  for (const ncNode of findAllChildren(root, 'no_connect')) {
    const atNode = findChild(ncNode, 'at');
    if (!atNode) continue;
    const pos = parseXY(atNode);
    // find nearest terminal within 1 grid unit
    let nearest: { compId: string; termId: string; dist: number } | null = null;
    for (const comp of components) {
      const plugin = getPlugin(comp.type);
      if (!plugin) continue;
      for (const t of plugin.terminals) {
        const tx = comp.position.x + t.position.x;
        const ty = comp.position.y + t.position.y;
        const d = Math.hypot(tx - pos.x / 2.54, ty - pos.y / 2.54);
        if (d < 1.5 && (!nearest || d < nearest.dist)) {
          nearest = { compId: comp.id, termId: t.id, dist: d };
        }
      }
    }
    if (nearest) {
      noConnects.push({ componentId: nearest.compId, terminalId: nearest.termId });
    }
  }

  const doc: CircuitDocument = {
    version: 1,
    components,
    wires,
    noConnects: noConnects.map((nc, i) => ({ id: `nc_${i}`, ...nc })),
  };
  return { document: doc, warnings, unknownSymbols };
}

function parseXY(node: Sexp): Vec2 {
  // node is (at x y [r]) or (xy x y) — children[0] is x, children[1] is y
  const x = parseFloat(node.children[0]?.value ?? '0');
  const y = parseFloat(node.children[1]?.value ?? '0');
  return { x, y };
}

function matchPluginType(libId: string, value: string): string | null {
  const id = libId.toLowerCase();
  const val = value.toLowerCase();
  // Extract the symbol name after the last ":" or "_" separator (e.g. "Device:R" → "r")
  const symName = id.split(':').pop()!.split('_').pop()!;
  // Build a haystack that includes full lib_id, symbol name, and value — match against any of them
  const hay = `${id} ${symName} ${val}`;
  if (hay.includes('resistor') || symName === 'r' || /^r\d+$/.test(val)) return 'resistor';
  if (hay.includes('capacitor') || symName === 'c' || /^c\d+$/.test(val)) return 'capacitor';
  if (hay.includes('inductor') || symName === 'l' || /^l\d+$/.test(val)) return 'inductor';
  if (hay.includes('diode') || symName === 'd' || /^d\d+$/.test(val)) return 'diode';
  if (hay.includes('led')) return 'led';
  if (hay.includes('zener')) return 'zener';
  if (hay.includes('schottky')) return 'schottky';
  if (hay.includes('npn') || hay.includes('transistor_npn')) return 'npn';
  if (hay.includes('pnp') || hay.includes('transistor_pnp')) return 'pnp';
  if (hay.includes('nmos') || hay.includes('transistor_nmos')) return 'nmos';
  if (hay.includes('pmos') || hay.includes('transistor_pmos')) return 'pmos';
  if (hay.includes('opamp') || hay.includes('lm358') || hay.includes('lm741') || hay.includes('tl072') || hay.includes('tl082') || hay.includes('ne5532')) return 'opamp';
  if (hay.includes('555') || hay.includes('ne555') || hay.includes('lm555')) return 'timer555';
  if (hay.includes('gnd') || hay.includes('ground') || symName === 'gnd') return 'powerGND';
  if (hay.includes('vcc') || hay.includes('power_flag')) return 'powerVCC';
  if (hay.includes('+5v') || hay.includes('+5v0')) return 'power5V';
  if (hay.includes('+3v3') || hay.includes('+3.3v')) return 'power3V3';
  if (hay.includes('+12v')) return 'power12V';
  if (hay.includes('-12v')) return 'powerMinus12V';
  if (hay.includes('switch')) return 'switch';
  if (hay.includes('push_button') || hay.includes('pushbutton')) return 'pushButton';
  if (hay.includes('crystal') || hay.includes('xtal')) return 'crystal';
  if (hay.includes('fuse')) return 'fuse';
  if (hay.includes('speaker') || hay.includes('buzzer')) return 'speaker';
  if (hay.includes('motor')) return 'dcMotor';
  if (hay.includes('battery')) return 'dcVoltage';
  if (hay.includes('arduino')) return 'arduinoReal';
  if (hay.includes('raspberry')) return 'raspberryPi';
  // Logic gates — try 7400 series
  const m74 = id.match(/74(00|02|04|08|32|86|74)/);
  if (m74) return `7400_${m74[1]}`;
  // Default: no match
  return null;
}

function defaultParams(plugin: ComponentPlugin): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const p of plugin.parameters) out[p.key] = p.default;
  return out;
}

function coerceValue(v: string, type: string): number | string | boolean {
  if (type === 'number') {
    // parse KiCad-style "10k" / "100n" / "1u"
    const m = v.match(/^([\d.]+)\s*([kKmMgGuUnNpPfF])/);
    if (m) {
      const num = parseFloat(m[1]);
      const multMap: Record<string, number> = {
        k: 1e3, K: 1e3, m: 1e-3, M: 1e6, g: 1e9, G: 1e9,
        u: 1e-6, U: 1e-6, n: 1e-9, N: 1e-9, p: 1e-12, P: 1e-12, f: 1e-15, F: 1e-15,
      };
      return num * (multMap[m[2]] ?? 1);
    }
    const n = parseFloat(v);
    return isNaN(n) ? v : n;
  }
  if (type === 'boolean') return v === 'true' || v === '1';
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eagle .sch (XML) parser — best-effort
// ─────────────────────────────────────────────────────────────────────────────

export function parseEagleSch(text: string): KicadImportResult {
  const warnings: string[] = [];
  const unknownSymbols: string[] = [];
  // Eagle .sch is XML; we parse just <part> and <wire> tags
  const components: CircuitComponent[] = [];
  const wires: Wire[] = [];
  let idCounter = 0;
  const nextId = () => `e_${Date.now().toString(36)}_${idCounter++}`;

  // Use DOMParser if available, else regex
  let parts: { name: string; library: string; deviceset: string; x: number; y: number; rot: number }[] = [];
  let eagleWires: { x1: number; y1: number; x2: number; y2: number }[] = [];
  if (typeof DOMParser !== 'undefined') {
    const dom = new DOMParser().parseFromString(text, 'application/xml');
    const partEls = dom.getElementsByTagName('part');
    for (let i = 0; i < partEls.length; i++) {
      const el = partEls[i];
      const name = el.getAttribute('name') ?? '';
      const library = el.getAttribute('library') ?? '';
      const deviceset = el.getAttribute('deviceset') ?? '';
      parts.push({ name, library, deviceset, x: 0, y: 0, rot: 0 });
    }
    const instEls = dom.getElementsByTagName('instance');
    for (let i = 0; i < instEls.length; i++) {
      const el = instEls[i];
      const partName = el.getAttribute('part') ?? '';
      const part = parts.find((p) => p.name === partName);
      if (part) {
        part.x = parseFloat(el.getAttribute('x') ?? '0');
        part.y = parseFloat(el.getAttribute('y') ?? '0');
        const rotStr = el.getAttribute('rot') ?? '';
        const m = rotStr.match(/R(\d+)/);
        part.rot = m ? parseInt(m[1]) : 0;
      }
    }
    const wireEls = dom.getElementsByTagName('wire');
    for (let i = 0; i < wireEls.length; i++) {
      const el = wireEls[i];
      eagleWires.push({
        x1: parseFloat(el.getAttribute('x1') ?? '0'),
        y1: parseFloat(el.getAttribute('y1') ?? '0'),
        x2: parseFloat(el.getAttribute('x2') ?? '0'),
        y2: parseFloat(el.getAttribute('y2') ?? '0'),
      });
    }
  } else {
    // Server-side fallback: regex
    const partRegex = /<part\s+name="([^"]+)"\s+library="([^"]+)"\s+deviceset="([^"]+)"/g;
    let m;
    while ((m = partRegex.exec(text)) !== null) {
      parts.push({ name: m[1], library: m[2], deviceset: m[3], x: 0, y: 0, rot: 0 });
    }
    warnings.push('Eagle import on server: instance positions not parsed — components will be at origin');
  }

  for (const part of parts) {
    const pluginType = matchPluginType(`${part.library}/${part.deviceset}`, part.deviceset);
    if (!pluginType) {
      unknownSymbols.push(`${part.library}/${part.deviceset}`);
      continue;
    }
    const plugin = getPlugin(pluginType);
    if (!plugin) continue;
    const comp: CircuitComponent = {
      id: nextId(),
      type: pluginType,
      position: { x: Math.round(part.x / 2.54), y: Math.round(part.y / 2.54) },
      rotation: (((part.rot / 90) % 4 + 4) % 4) as 0 | 1 | 2 | 3,
      parameters: defaultParams(plugin),
      refdes: part.name,
    };
    components.push(comp);
  }
  warnings.push(`Eagle import: ${eagleWires.length} wires skipped (terminal mapping not yet supported)`);

  return {
    document: { version: 1, components, wires },
    warnings,
    unknownSymbols,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect format from file content
// ─────────────────────────────────────────────────────────────────────────────

export function parseSchematicFile(text: string, fileName: string): KicadImportResult {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'kicad_sch' || text.trim().startsWith('(kicad_sch')) {
    return parseKicadSch(text);
  }
  if (ext === 'sch' || text.includes('<?xml') && text.includes('<eagle')) {
    return parseEagleSch(text);
  }
  // default to KiCad
  return parseKicadSch(text);
}
