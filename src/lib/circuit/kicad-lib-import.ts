// ─── KiCad symbol-library importer ───────────────────────────────────────────
// Parses KiCad 6/7/8 `.kicad_sym` symbol libraries (and the embedded
// `lib_symbols` section of `.kicad_sch` sheets) and converts each symbol into
// a SymbolDesign — the same format the WYSIWYG Symbol Editor produces — so
// imported symbols become live palette plugins with full pin geometry.
//
// Scope: the electrical subset of the format — pins (position, angle,
// length, electrical type, shape, name, number), rectangles, polylines,
// circles (approximated as 16-segment polygons), arcs (sampled through the
// mid point) and text. Multi-unit symbols are merged into one symbol (with a
// warning); De Morgan alternate styles (style ≠ 1) are skipped.
//
// Geometry notes (the classic gotcha, verified against Device:R):
//  - KiCad library coordinates: +x right, +y UP. Our grid: +y down. Every
//    y is therefore negated (`ourY = -kicadY / 2.54`).
//  - Pin `(at X Y ANG)`: X,Y is the CONNECTION END; ANG is the direction the
//    stub extends FROM the end TOWARD the body (0°=east, 90°=north in the
//    y-up frame). Body→end direction (= our SymbolPin.direction) is thus:
//    0°→'left', 90°→'down', 180°→'right', 270°→'up' (the y-flip maps the
//    lib compass onto the same screen compass).
//  - Units are mm; our grid unit is 2.54 mm (same convention the schematic
//    importer uses).

import type { SymbolDesign, SymbolPin, SymbolRect, SymbolLine, SymbolText, PinDirection } from './symbol-editor-types';
import { computeDesignBoundingBox } from './symbol-editor-types';
import type { PinElecType, PinShape } from './types';

// ─── Minimal s-expression parser (same contract as kicad-sch-import) ────────

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

function parseSexpNode(tokens: string[], idx: { i: number }): Sexp | null {
  if (idx.i >= tokens.length) return null;
  if (tokens[idx.i] !== '(') return null;
  idx.i++;
  if (idx.i >= tokens.length) return null;
  const node: Sexp = { type: tokens[idx.i], children: [] };
  idx.i++;
  while (idx.i < tokens.length && tokens[idx.i] !== ')') {
    if (tokens[idx.i] === '(') {
      const child = parseSexpNode(tokens, idx);
      if (child) node.children.push(child);
    } else {
      node.children.push({ type: tokens[idx.i], value: tokens[idx.i], children: [] });
      idx.i++;
    }
  }
  idx.i++; // skip ')'
  return node;
}

/** Parse ALL top-level s-expressions (a .kicad_sym has one root; be liberal). */
function parseTopLevel(input: string): Sexp[] {
  const tokens = tokenize(input);
  const nodes: Sexp[] = [];
  const idx = { i: 0 };
  while (idx.i < tokens.length) {
    if (tokens[idx.i] === '(') {
      const n = parseSexpNode(tokens, idx);
      if (n) nodes.push(n);
    } else {
      idx.i++;
    }
  }
  return nodes;
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

// ─── Pin type maps ──────────────────────────────────────────────────────────

const ELEC_TYPE_MAP: Record<string, PinElecType> = {
  input: 'input',
  output: 'output',
  bidirectional: 'bidirectional',
  tri_state: 'tri_state',
  passive: 'passive',
  power_in: 'power_in',
  power_out: 'power_out',
  open_collector: 'open_collector',
  open_emitter: 'open_emitter',
  unconnected: 'unconnected',
  nc: 'nc',
  free: 'free',
  unspecified: 'unspecified',
};

const PIN_SHAPE_MAP: Record<string, PinShape> = {
  line: 'line',
  inverted: 'inverted',
  clock: 'clock',
  inverted_clock: 'inverted_clock',
  input_low: 'input_low',
  clock_low: 'clock_low',
  falling_edge: 'falling_edge',
  non_logic: 'non_logic',
};

const ANGLE_TO_DIRECTION: Record<string, PinDirection> = {
  '0': 'left',
  '90': 'down',
  '180': 'right',
  '270': 'up',
};

// ─── Unit conversion ────────────────────────────────────────────────────────

const MM_PER_GRID = 2.54;

function gx(mm: number): number {
  return mm / MM_PER_GRID;
}
function gy(mm: number): number {
  return -mm / MM_PER_GRID; // y-up library frame → y-down screen frame
}

// ─── Import result ──────────────────────────────────────────────────────────

export interface KicadLibImportResult {
  designs: SymbolDesign[];
  warnings: string[];
  /** symbol names that could not be converted at all */
  skipped: string[];
}

// ─── Symbol body conversion ─────────────────────────────────────────────────

interface RawGeom {
  rects: SymbolRect[];
  lines: SymbolLine[];
  texts: SymbolText[];
  pins: SymbolPin[];
}

let elemCounter = 0;
const nextElemId = (kind: string) => `kicad_${kind}_${(elemCounter++).toString(36)}`;

function convertRect(node: Sexp, off: { x: number; y: number }): void {
  const startN = findChild(node, 'start');
  const endN = findChild(node, 'end');
  if (!startN || !endN) return;
  const x1 = parseFloat(startN.children[0]?.value ?? '0');
  const y1 = parseFloat(startN.children[1]?.value ?? '0');
  const x2 = parseFloat(endN.children[0]?.value ?? '0');
  const y2 = parseFloat(endN.children[1]?.value ?? '0');
  if (![x1, y1, x2, y2].every(isFinite)) return;
  const ax = gx(x1) + off.x;
  const ay = gy(y1) + off.y;
  const bx = gx(x2) + off.x;
  const by = gy(y2) + off.y;
  GEOM.rects.push({
    id: nextElemId('rect'),
    position: { x: Math.min(ax, bx), y: Math.min(ay, by) },
    size: { width: Math.abs(bx - ax), height: Math.abs(by - ay) },
    strokeColor: '#94a3b8',
    fillColor: 'transparent',
  });
}

function convertPolyline(node: Sexp, off: { x: number; y: number }): void {
  const ptsN = findChild(node, 'pts');
  if (!ptsN) return;
  const pts = findAllChildren(ptsN, 'xy').map((xy) => {
    const x = parseFloat(xy.children[0]?.value ?? '0');
    const y = parseFloat(xy.children[1]?.value ?? '0');
    return { x: gx(x) + off.x, y: gy(y) + off.y };
  });
  if (pts.length < 2 || !pts.every((p) => isFinite(p.x) && isFinite(p.y))) return;
  for (let i = 1; i < pts.length; i++) {
    GEOM.lines.push({
      id: nextElemId('line'),
      from: pts[i - 1],
      to: pts[i],
      color: '#94a3b8',
      width: 1.5,
    });
  }
}

function convertCircle(node: Sexp, off: { x: number; y: number }): void {
  const centerN = findChild(node, 'center');
  const radius = parseFloat(findValue(node, 'radius') ?? '0');
  if (!centerN || !isFinite(radius) || radius <= 0) return;
  const cx = gx(parseFloat(centerN.children[0]?.value ?? '0')) + off.x;
  const cy = gy(parseFloat(centerN.children[1]?.value ?? '0')) + off.y;
  if (!isFinite(cx) || !isFinite(cy)) return;
  const r = radius / MM_PER_GRID;
  // approximate with a 16-segment polygon
  const SEG = 16;
  let prev: { x: number; y: number } | null = null;
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const p = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    if (prev) {
      GEOM.lines.push({ id: nextElemId('line'), from: prev, to: p, color: '#94a3b8', width: 1.5 });
    }
    prev = p;
  }
}

/** Fit a circle through 3 points and sample an arc from start→end through mid. */
function convertArc(node: Sexp, off: { x: number; y: number }): void {
  const startN = findChild(node, 'start');
  const midN = findChild(node, 'mid');
  const endN = findChild(node, 'end');
  if (!startN || !midN || !endN) return;
  const p = (n: Sexp) => ({
    x: gx(parseFloat(n.children[0]?.value ?? '0')) + off.x,
    y: gy(parseFloat(n.children[1]?.value ?? '0')) + off.y,
  });
  const a = p(startN);
  const b = p(midN);
  const c = p(endN);
  if (![a, b, c].every((q) => isFinite(q.x) && isFinite(q.y))) return;
  // Circumcircle of the three points
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return; // collinear
  const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - ux, a.y - uy);
  if (!isFinite(r) || r <= 0 || r > 200) return;
  const ang = (q: { x: number; y: number }) => Math.atan2(q.y - uy, q.x - ux);
  const a0 = ang(a);
  const aMid = ang(b);
  const a1 = ang(c);
  // Choose the sweep direction that passes through mid
  const norm = (x: number) => {
    let v = x;
    while (v < 0) v += Math.PI * 2;
    while (v >= Math.PI * 2) v -= Math.PI * 2;
    return v;
  };
  const ccw = norm(aMid - a0) < norm(a1 - a0);
  const SEG = 12;
  let prev: { x: number; y: number } | null = null;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const angle = ccw ? a0 + t * norm(a1 - a0) : a0 - t * norm(a0 - a1);
    const q = { x: ux + r * Math.cos(angle), y: uy + r * Math.sin(angle) };
    if (prev) {
      GEOM.lines.push({ id: nextElemId('line'), from: prev, to: q, color: '#94a3b8', width: 1.5 });
    }
    prev = q;
  }
}

function convertText(node: Sexp, off: { x: number; y: number }): void {
  const text = node.children[0]?.value;
  if (!text) return;
  const atN = findChild(node, 'at');
  const x = atN ? gx(parseFloat(atN.children[0]?.value ?? '0')) + off.x : 0;
  const y = atN ? gy(parseFloat(atN.children[1]?.value ?? '0')) + off.y : 0;
  if (!isFinite(x) || !isFinite(y)) return;
  GEOM.texts.push({
    id: nextElemId('text'),
    position: { x, y },
    text,
    color: '#94a3b8',
    fontSize: 12,
  });
}

/** Parser scratch state — convert* helpers append here. */
let GEOM: RawGeom = { rects: [], lines: [], texts: [], pins: [] };

function convertPin(node: Sexp, off: { x: number; y: number }): void {
  // (pin <elecType> <shape> (at X Y ANG) (length L) (name "..." ...) (number "..." ...))
  const elecRaw = node.children[0]?.value ?? 'passive';
  const shapeRaw = node.children[1]?.value ?? 'line';
  const atN = findChild(node, 'at');
  const lengthMm = parseFloat(findValue(node, 'length') ?? '2.54');
  if (!atN || !isFinite(lengthMm)) return;
  const x = parseFloat(atN.children[0]?.value ?? '0');
  const y = parseFloat(atN.children[1]?.value ?? '0');
  const angle = Math.round(parseFloat(atN.children[2]?.value ?? '0'));
  if (![x, y].every(isFinite) || !isFinite(angle)) return;
  const nameNode = findChild(node, 'name');
  const numberNode = findChild(node, 'number');
  const name = (nameNode?.children[0]?.value ?? '~') || '';
  const number = (numberNode?.children[0]?.value ?? '') || '';
  const direction = ANGLE_TO_DIRECTION[String(((angle % 360) + 360) % 360)] ?? 'left';
  const length = lengthMm / MM_PER_GRID;
  const pos = { x: gx(x) + off.x, y: gy(y) + off.y };
  // Terminal id: pin number is the most stable key; fall back to name/index.
  const id = (number || name || `p${GEOM.pins.length}`).replace(/[^\w]/g, '_') || `p${GEOM.pins.length}`;
  GEOM.pins.push({
    id,
    position: pos,
    label: number || name || id,
    name: name === '~' ? '' : name,
    number,
    electricalType: ELEC_TYPE_MAP[elecRaw] ?? 'passive',
    shape: PIN_SHAPE_MAP[shapeRaw] ?? 'line',
    length: Math.max(0.2, length),
    direction,
  });
}

function convertGeomNode(node: Sexp, off: { x: number; y: number }): void {
  switch (node.type) {
    case 'rectangle': convertRect(node, off); break;
    case 'polyline': convertPolyline(node, off); break;
    case 'circle': convertCircle(node, off); break;
    case 'arc': convertArc(node, off); break;
    case 'text': convertText(node, off); break;
    case 'pin': convertPin(node, off); break;
    default: break;
  }
}

// ─── Type-id sanitization ───────────────────────────────────────────────────

/** "MCU_STM32:STM32F103C8Tx" → "kicad_stm32f103c8tx". Prefixed to guarantee no
 *  collision with built-in plugin types (user symbols are re-registered at
 *  every startup and built-ins must win). */
export function symbolNameToTypeId(libName: string): string {
  const base = libName.split(':').pop() ?? libName;
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'n$1'); // type ids must start with a letter
  return `kicad_${cleaned || 'symbol'}`;
}

// ─── Main entry points ──────────────────────────────────────────────────────

/** Collect the top-level `(symbol ...)` library nodes from any parsed input:
 *  .kicad_sym roots, or the `(lib_symbols ...)` block inside a .kicad_sch. */
function collectSymbolNodes(text: string): Sexp[] {
  const roots = parseTopLevel(text);
  const out: Sexp[] = [];
  for (const root of roots) {
    if (root.type === 'symbol') {
      out.push(root);
    } else if (root.type === 'kicad_symbol' || root.type === 'kicad_sch') {
      // .kicad_sym root or a schematic — look one level in (lib_symbols)
      const libSymbols = findChild(root, 'lib_symbols');
      if (libSymbols) {
        out.push(...findAllChildren(libSymbols, 'symbol'));
      } else {
        out.push(...findAllChildren(root, 'symbol').filter((s) => findChild(s, 'pin') || s.children.some((c) => c.type === 'symbol')));
      }
    }
  }
  return out;
}

/**
 * Convert ONE library symbol node into a SymbolDesign. `nameOverride` lets a
 * .kicad_sch import disambiguate; otherwise the node's own name is used.
 */
function convertSymbolNode(node: Sexp, warnings: string[], skipped: string[]): SymbolDesign | null {
  const rawName = node.children[0]?.value;
  if (!rawName || !rawName.trim()) return null;
  const name = rawName.trim();

  // Value property (nicer display name) — optional
  const displayValue = name.split(':').pop() ?? name;

  // Collect unit children: (symbol "NAME_unit_style" ...)
  const unitNodes: { node: Sexp; unit: number; style: number }[] = [];
  for (const child of findAllChildren(node, 'symbol')) {
    const cname = child.children[0]?.value ?? '';
    const m = cname.match(/_(\d+)_(\d+)$/);
    if (m) {
      unitNodes.push({ node: child, unit: parseInt(m[1]), style: parseInt(m[2]) });
    } else {
      // A nested symbol without the _unit_style suffix: treat as unit 0 style 1
      unitNodes.push({ node: child, unit: 0, style: 1 });
    }
  }

  // Merge every unit's style-1 body (unit 0 = common graphics + all gate
  // units — a 7400's four gates carry different pin numbers, so one merged
  // symbol with every package pin is the honest, usable conversion). De
  // Morgan alternate styles (style ≠ 1) are skipped.
  const merged = unitNodes.filter((u) => u.style === 1);
  const otherUnits = new Set(unitNodes.filter((u) => u.unit > 1).map((u) => u.unit));
  if (merged.length === 0) {
    skipped.push(name);
    return null;
  }
  if (otherUnits.size > 0) {
    warnings.push(`${name}: ${otherUnits.size + 1} units merged into one symbol`);
  }
  const alternates = unitNodes.filter((u) => u.style !== 1).length;
  if (alternates > 0) {
    warnings.push(`${name}: De Morgan alternate body skipped`);
  }

  // Geometry pass 1: raw conversion around the origin
  GEOM = { rects: [], lines: [], texts: [], pins: [] };
  for (const u of merged) {
    for (const g of u.node.children) {
      if (g.type === 'symbol') continue;
      convertGeomNode(g, { x: 0, y: 0 });
    }
  }

  // Pass 2: normalize so all coordinates are ≥ 0 (shift by the min)
  let minX = Infinity;
  let minY = Infinity;
  const consider = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  };
  for (const r of GEOM.rects) consider(r.position.x, r.position.y);
  for (const l of GEOM.lines) { consider(l.from.x, l.from.y); consider(l.to.x, l.to.y); }
  for (const t of GEOM.texts) consider(t.position.x, t.position.y);
  for (const p of GEOM.pins) consider(p.position.x, p.position.y);
  if (minX === Infinity) { minX = 0; minY = 0; }
  const off = { x: -minX, y: -minY };

  const design: SymbolDesign = {
    name: displayValue,
    type: symbolNameToTypeId(name),
    description: `Imported from KiCad library symbol "${name}"`,
    boundingBox: { width: 2, height: 2 }, // replaced by the real fit below
    pins: GEOM.pins.map((p) => ({ ...p, position: { x: p.position.x + off.x, y: p.position.y + off.y } })),
    rects: GEOM.rects.map((r) => ({ ...r, position: { x: r.position.x + off.x, y: r.position.y + off.y } })),
    lines: GEOM.lines.map((l) => ({
      ...l,
      from: { x: l.from.x + off.x, y: l.from.y + off.y },
      to: { x: l.to.x + off.x, y: l.to.y + off.y },
    })),
    texts: GEOM.texts.map((t) => ({ ...t, position: { x: t.position.x + off.x, y: t.position.y + off.y } })),
  };
  design.boundingBox = computeDesignBoundingBox(design);

  if (design.pins.length === 0) {
    // Graphical-only symbols (titles, logos) are useless as components.
    skipped.push(name);
    return null;
  }

  // de-duplicate pin ids (number collisions across units)
  const seen = new Set<string>();
  for (const p of design.pins) {
    if (seen.has(p.id)) {
      p.id = `${p.id}_${seen.size}`;
    }
    seen.add(p.id);
  }

  return design;
}

/**
 * Parse a `.kicad_sym` library (or a `.kicad_sch` sheet — its embedded
 * `lib_symbols` are extracted) into SymbolDesigns ready for
 * `symbolDesignToPlugin()` + `saveUserDesign()`.
 */
export function parseKicadSymbolLibrary(text: string): KicadLibImportResult {
  const warnings: string[] = [];
  const skipped: string[] = [];
  const designs: SymbolDesign[] = [];

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { designs, warnings: ['File is empty'], skipped };
  }
  // Legacy KiCad 5 .lib format ("EESchema-LIBRARY Version 2.x") is a flat
  // text format, not s-expressions — not supported.
  if (/^EESchema-LIBRARY/i.test(trimmed)) {
    return { designs, warnings: ['Legacy KiCad 5 .lib format is not supported — export as .kicad_sym from KiCad 6+'], skipped };
  }

  const symbolNodes = collectSymbolNodes(text);
  if (symbolNodes.length === 0) {
    return { designs, warnings: ['No symbols found — expected a .kicad_sym library or a .kicad_sch schematic'], skipped };
  }

  const seenTypes = new Set<string>();
  for (const node of symbolNodes) {
    try {
      const design = convertSymbolNode(node, warnings, skipped);
      if (!design) continue;
      if (seenTypes.has(design.type)) continue; // duplicate name in same file
      seenTypes.add(design.type);
      designs.push(design);
    } catch (err) {
      skipped.push(`<error: ${(err as Error).message}>`);
    }
  }

  if (designs.length === 0) {
    warnings.push('No convertible symbols (graphical-only or unsupported geometry)');
  }
  return { designs, warnings, skipped };
}
