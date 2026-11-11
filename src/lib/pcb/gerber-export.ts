// Gerber (RS-274X), Excellon drill, and Pick-and-Place export.
// Generates industry-standard manufacturing files from the PCB layout.

import type { Footprint, Trace, Via, BoardOutline, Pad } from './types';
import type { CircuitComponent } from '../circuit/types';
import { isPhysicalType, isMechanicalType } from './footprints';

/**
 * Standard aperture template for a pad, grown (or shrunk) by `grow` mm per
 * side: C (circle), R (rectangle) or O (obround — oval pads; they used to be
 * fabricated as rectangles). Returns the template body for %ADDnn<body>*%.
 */
function padApertureBody(pad: Pick<Pad, 'shape' | 'size'>, grow = 0): string {
  const w = Math.max(0.01, pad.size.width + 2 * grow);
  const h = Math.max(0.01, pad.size.height + 2 * grow);
  if (pad.shape === 'circle') return `C,${Math.max(w, h).toFixed(4)}`;
  if (pad.shape === 'oval') return `O,${w.toFixed(4)}X${h.toFixed(4)}`;
  return `R,${w.toFixed(4)}X${h.toFixed(4)}`;
}
import type { CopperPour } from './copper-pour';
import { strokeText, strokeTextWidth } from './silk-font';

/**
 * Board space is Y-DOWN (the editor's screen frame: pin 1 of a DIP at the
 * top-left, pins numbered counter-clockwise as seen from above). Gerber,
 * Excellon and pick-and-place files are Y-UP. Every exported Y is negated
 * (KiCad does the same) — writing board Y unchanged fabricated the MIRROR
 * IMAGE of the layout, which no part rotation can undo: every IC and
 * transistor would have been wired backwards.
 */
export const fabY = (y: number) => (y === 0 ? 0 : -y);
/** Editor rotation (+θ = clockwise on screen) → fab rotation (CCW-positive). */
export const fabRotation = (deg: number) => ((-deg % 360) + 360) % 360;

/**
 * Generate a Gerber file (RS-274X format) for a copper layer.
 * Returns the Gerber file content as a string.
 *
 * Aperture note: pads/traces/vias get EXACT-size apertures (a `%ADDxxC,D*%`
 * circle or `%ADDxxR,WxH%` rect generated per unique size). The previous
 * fixed-aperture table snapped every feature to the nearest of 9 preset
 * sizes — e.g. every 1.5×0.8mm SMD pad was exported as a 1.8×1.8mm square
 * and 0.6mm vias as 0.8mm circles, silently changing the manufactured
 * geometry.
 */
export function exportGerberCopper(
  layer: 'top' | 'bottom' | 'inner1' | 'inner2' | 'inner3' | 'inner4',
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  pours?: CopperPour[],
  teardrops?: { position: { x: number; y: number }; points: { x: number; y: number }[] }[],
): string {
  const lines: string[] = [];
  const fmt = (n: number) => {
    // Sign-aware X26Y26 coordinate (2 int + 6 dec digits). A naive
    // padStart would inject a zero BETWEEN the minus sign and the digits
    // for small negative coordinates (e.g. -0.5mm → "0-500000").
    const mag = (Math.abs(n) * 1e6).toFixed(0).padStart(10, '0');
    return n < 0 ? `-${mag}` : mag;
  };

  // Header
  lines.push('%FSLAX46Y46*%');  // Format: 4 integer + 6 decimal digits (2.6 capped boards at 99.999 mm)
  lines.push('%MOMM*%');        // Units: millimeters
  lines.push(`%LPD*%`);         // Layer polarity: dark
  lines.push(`G04 Layer: ${layer.toUpperCase()}_COPPER*`); // LN (load name) is deprecated since Gerber rev. I4 (2013); CAM tools may reject it
  lines.push('G01*');           // linear interpolation (must be set before the first D01)

  // ── Dynamic aperture allocator ─────────────────────────────────────────
  // Aperture numbers 10..999 are allocated on demand per unique size so
  // every feature is drawn at its exact dimensions.
  let nextAp = 10;
  const circleAps = new Map<string, number>();
  const rectAps = new Map<string, number>();
  const apDefs: string[] = [];
  const getCircleAp = (d: number): number => {
    const key = d.toFixed(4);
    let ap = circleAps.get(key);
    if (ap === undefined) {
      ap = nextAp++;
      circleAps.set(key, ap);
      apDefs.push(`%ADD${ap}C,${d.toFixed(4)}*%`);
    }
    return ap;
  };
  const getRectAp = (w: number, h: number): number => {
    const key = `${w.toFixed(4)}x${h.toFixed(4)}`;
    let ap = rectAps.get(key);
    if (ap === undefined) {
      ap = nextAp++;
      rectAps.set(key, ap);
      apDefs.push(`%ADD${ap}R,${w.toFixed(4)}X${h.toFixed(4)}*%`);
    }
    return ap;
  };
  const bodyAps = new Map<string, number>();
  const getPadAp = (pad: Pad): number => {
    const body = padApertureBody(pad);
    if (body.startsWith('C,')) return getCircleAp(parseFloat(body.slice(2)));
    if (body.startsWith('R,')) return getRectAp(pad.size.width, pad.size.height);
    let ap = bodyAps.get(body);
    if (ap === undefined) {
      ap = nextAp++;
      bodyAps.set(body, ap);
      apDefs.push(`%ADD${ap}${body}*%`);
    }
    return ap;
  };

  // Reserve the outline aperture up-front (D10) so the numbering is stable
  const outlineAp = getCircleAp(0.15);

  /** Pad layer filter: THT pads (drill > 0) exist on every copper layer. */
  const padOnLayer = (pad: Pad, fp: Footprint, l: string): boolean =>
    pad.plated !== false && ((pad.drill ?? 0) > 0 || pad.layer === l || fp.side === l);

  // Pre-scan: allocate every aperture first so all definitions can be
  // emitted BEFORE any of them is selected (Gerber requires def-before-use).
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (!padOnLayer(pad, fp, layer)) continue;
      getPadAp(pad);
    }
  }
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    getCircleAp(trace.width);
  }
  for (const via of vias) {
    getCircleAp(via.diameter);
  }
  // Copper pours on this layer — merged horizontal cell runs as exact rect
  // apertures (the pour model is a grid of filled cells; runs keep the flash
  // count low while reproducing the exact fill geometry).
  const layerPours = (pours ?? []).filter((p) => p.layer === layer)
    .map((p) => ({ net: p.net, runs: pourRuns(p) }));

  for (const { runs } of layerPours) {
    for (const run of runs) getRectAp(run.w, run.h);
  }

  // Emit all aperture definitions (must precede their first use)
  lines.push(...apDefs);

  // The board outline is NOT drawn on copper (it lives in Edge.Cuts only):
  // a copper line on the board edge is milled through by the fab — exposed,
  // burred copper that violates every copper-to-edge rule.
  void outlineAp;

  // Draw pads
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (!padOnLayer(pad, fp, layer)) continue;
      const ap = getPadAp(pad);
      lines.push(`G54D${ap}*`);
      lines.push(`X${fmt(pad.position.x)}Y${fmt(fabY(pad.position.y))}D03*`);
    }
  }

  // Draw traces — one exact-width circular aperture per unique width
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    const ap = getCircleAp(trace.width);
    lines.push(`G54D${ap}*`);
    for (const seg of trace.segments) {
      lines.push(`X${fmt(seg.start.x)}Y${fmt(fabY(seg.start.y))}D02*`);
      lines.push(`X${fmt(seg.end.x)}Y${fmt(fabY(seg.end.y))}D01*`);
    }
  }

  // Draw vias — exact outer diameter
  for (const via of vias) {
    const ap = getCircleAp(via.diameter);
    lines.push(`G54D${ap}*`);
    lines.push(`X${fmt(via.position.x)}Y${fmt(fabY(via.position.y))}D03*`);
  }

  // Draw copper pours — filled polygon regions as rect aperture flashes
  // (X1 Gerber has no net attributes → pours export as plain copper)
  for (const { runs } of layerPours) {
    for (const run of runs) {
      const ap = getRectAp(run.w, run.h);
      lines.push(`G54D${ap}*`);
      lines.push(`X${fmt(run.cx)}Y${fmt(fabY(run.cy))}D03*`);
    }
  }

  // Teardrops — polygon flashes (G36 region) on this layer.
  for (const td of teardrops ?? []) {
    if (!td.points || td.points.length < 3) continue;
    lines.push('G36*');
    td.points.forEach((p, i) => {
      lines.push(`X${fmt(p.x)}Y${fmt(fabY(p.y))}D0${i === 0 ? 2 : 1}*`);
    });
    lines.push('G37*');
  }

  // End
  lines.push('M02*');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fab constants + Gerber X2 file attributes
// ─────────────────────────────────────────────────────────────────────────────

/** Solder-mask expansion per side (mm). */
export const MASK_EXPANSION = 0.05;
/** Silkscreen stroke width (mm) — JLC minimum legible line is 0.15. */
export const SILK_LINE_WIDTH = 0.15;
/** JLC pad-to-silk rule: silk must stay ≥ 0.15 mm from exposed pad (mask opening). */
export const SILK_PAD_CLEARANCE = 0.15;
/** Centre-line distance silk strokes keep from pad COPPER: 0.15 clearance +
 *  0.05 mask expansion + half the stroke width. */
export const SILK_CENTER_CLEARANCE = SILK_PAD_CLEARANCE + MASK_EXPANSION + SILK_LINE_WIDTH / 2;

const fmtCoord = (n: number) => {
  // Sign-aware X46Y46 coordinate (4 int + 6 dec digits): a naive padStart would
  // put a zero BETWEEN the minus sign and the digits (-0.5mm → "0-500000").
  const mag = (Math.abs(n) * 1e6).toFixed(0).padStart(10, '0');
  return n < 0 ? `-${mag}` : mag;
};

/** X2 metadata of one Gerber file (%TF.* attributes). */
export interface X2Meta {
  /** e.g. 'Copper,L1,Top', 'Soldermask,Top', 'Paste,Bot', 'Legend,Top', 'Profile,NP' */
  fileFunction: string;
  polarity: 'Positive' | 'Negative';
  /** shared by every file of the bundle */
  projectId?: { name: string; guid: string; rev: string };
  /** ISO 8601 with offset, shared by every file of the bundle */
  date?: string;
}

/** Deterministic RFC-4122-shaped GUID (v4 layout) from a seed string: every
 *  file of one bundle shares it, a different board gets a different one. */
export function projectGuid(seed: string): string {
  const h: number[] = [];
  for (let k = 0; k < 4; k++) {
    let x = 0x811c9dc5 ^ (k * 0x9e3779b1);
    for (let i = 0; i < seed.length; i++) { x ^= seed.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    h.push(x >>> 0);
  }
  const hex = h.map((v) => v.toString(16).padStart(8, '0')).join('');
  const variant = (8 + (parseInt(hex[16], 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function boardSeed(footprints: Footprint[], board: BoardOutline): string {
  return `${board.width}x${board.height}|${footprints.map((f) => f.refdes).join(',')}`;
}

/** ISO 8601 with an explicit offset, no milliseconds (Gerber TF.CreationDate). */
function x2Date(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function x2Header(meta: X2Meta | undefined, footprints: Footprint[], board: BoardOutline): string[] {
  if (!meta) return [];
  const pid = meta.projectId ?? { name: 'CircuitLab-PCB', guid: projectGuid(boardSeed(footprints, board)), rev: 'rev1' };
  return [
    '%TF.GenerationSoftware,CircuitLab,CircuitLab Web EDA,1.0*%',
    `%TF.CreationDate,${meta.date ?? x2Date()}*%`,
    `%TF.ProjectId,${pid.name},${pid.guid},${pid.rev}*%`,
    '%TF.SameCoordinates,Original*%',
    `%TF.FileFunction,${meta.fileFunction}*%`,
    `%TF.FilePolarity,${meta.polarity}*%`,
  ];
}

/** Attribute values may not contain , * % — net names like "Net-(U1,2)" are cleaned. */
const attrText = (s: string) => s.replace(/[,*%\r\n]/g, '_');

/**
 * Generate a Gerber solder mask file.
 */
export function exportGerberSolderMask(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  board: BoardOutline,
  x2?: X2Meta,
): string {
  const lines: string[] = [];
  lines.push(...x2Header(x2, footprints, board));
  lines.push('%FSLAX46Y46*%');
  lines.push('%MOMM*%');
  // Dark polarity: on a solder-mask layer the drawn image IS the set of
  // openings (X2: FilePolarity Negative tells CAM the file is a negative of
  // the mask). (This file used %LPC% — clear objects on an empty image erase
  // nothing, so the mask had NO openings and every pad would be covered.)
  lines.push('%LPD*%');
  lines.push(`G04 Layer: ${layer.toUpperCase()}_SOLDERMASK*`);
  lines.push('G01*');

  const maskAps = new Map<string, number>();
  let nextMaskAp = 10;
  // Open solder mask openings at each pad (slightly larger than pad).
  // THT pads need openings on BOTH mask layers (the hole spans the board);
  // SMD pads only on their own side.
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) <= 0 && pad.layer !== layer && fp.side !== layer) continue;
      // Opening = the pad's own shape grown by the mask expansion. (Every
      // opening used to be a circle of the pad's LARGEST dimension: a
      // 1.5×0.6 mm SOIC pad got a 1.7 mm hole overlapping its neighbours —
      // no solder dam, bridged pins.)
      const body = padApertureBody(pad, MASK_EXPANSION);
      let apNum = maskAps.get(body);
      if (apNum === undefined) {
        apNum = nextMaskAp++;
        maskAps.set(body, apNum);
        lines.push(`%ADD${apNum}${body}*%`);
      }
      lines.push(`G54D${apNum}*`);
      lines.push(`X${fmtCoord(pad.position.x)}Y${fmtCoord(fabY(pad.position.y))}D03*`);
    }
  }

  // (no outline: a mask-layer draw is an OPENING — Edge.Cuts carries it)

  lines.push('M02*');
  return lines.join('\n');
}

/**
 * Generate a Gerber paste-mask file (solder-paste stencil openings).
 * SMD pads only — THT pads are wave-soldered and must NOT appear on paste.
 * Openings are shrunk ~10% (min 0.05mm per side) so paste stays on the pad.
 */
export function exportGerberPaste(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  board: BoardOutline,
  x2?: X2Meta,
): string {
  const lines: string[] = [];
  lines.push(...x2Header(x2, footprints, board));
  lines.push('%FSLAX46Y46*%');
  lines.push('%MOMM*%');
  lines.push('%LPD*%');
  lines.push(`G04 Layer: ${layer.toUpperCase()}_PASTE*`);
  lines.push('G01*');
  let nextAp = 10;
  const apDefs = new Map<string, number>();
  const defs: string[] = [];
  const flashes: string[] = [];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) > 0) continue; // THT / NPTH: no paste
      if (pad.layer !== layer && fp.side !== layer) continue;
      // shrink ~10% per side for stencil relief
      const w = Math.max(0.1, pad.size.width - 0.1);
      const h = Math.max(0.1, pad.size.height - 0.1);
      const key = padApertureBody({ shape: pad.shape, size: { width: w, height: h } });
      let ap = apDefs.get(key);
      if (ap === undefined) {
        ap = nextAp++;
        apDefs.set(key, ap);
        if (x2) defs.push('%TA.AperFunction,SMDPad,CuDef*%');
        defs.push(`%ADD${ap}${key}*%`);
        if (x2) defs.push('%TD.AperFunction*%');
      }
      flashes.push(`G54D${ap}*`);
      flashes.push(`X${fmtCoord(pad.position.x)}Y${fmtCoord(fabY(pad.position.y))}D03*`);
    }
  }
  lines.push(...defs);
  lines.push(...flashes);
  // (no outline: a paste-layer draw is a stencil APERTURE — it would print
  // solder paste along the whole board edge; Edge.Cuts carries the outline)
  lines.push('M02*');
  return lines.join('\n');
}

/**
 * Generate the board-outline (Edge.Cuts) Gerber file. Fabs read the outline
 * from this layer — drawing it only as a copper stroke left it ambiguous.
 */
export function exportGerberEdgeCuts(board: BoardOutline, x2?: X2Meta): string {
  return [
    ...x2Header(x2, [], board),
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%LPD*%',
    'G04 Layer: EDGE_CUTS*',
    ...(x2 ? ['%TA.AperFunction,Profile*%'] : []),
    '%ADD10C,0.100*%',
    ...(x2 ? ['%TD.AperFunction*%'] : []),
    'G01*',
    'G54D10*',
    `X${fmtCoord(0)}Y${fmtCoord(fabY(0))}D02*`,
    `X${fmtCoord(board.width)}Y${fmtCoord(fabY(0))}D01*`,
    `X${fmtCoord(board.width)}Y${fmtCoord(fabY(board.height))}D01*`,
    `X${fmtCoord(0)}Y${fmtCoord(fabY(board.height))}D01*`,
    `X${fmtCoord(0)}Y${fmtCoord(fabY(0))}D01*`,
    'M02*',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Silkscreen: body outline + designator + pin-1 marker, clipped to the JLC
// pad-to-silk rule
// ─────────────────────────────────────────────────────────────────────────────

interface Pt { x: number; y: number }
interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface SilkGeometry {
  /** silkscreen strokes (width SILK_LINE_WIDTH), board space (Y down) */
  segments: [Pt, Pt][];
  /** pin-1 dots (filled circles), board space */
  dots: { x: number; y: number; r: number }[];
}

/** Pin-1 dot radius (mm): the D11 flash aperture is 0.5 mm. */
const SILK_DOT_R = 0.25;

/** Polarised / orientation-critical part: ICs & transistors (≥ 3 pads), diodes,
 *  LEDs, input headers. Resistors / ceramic caps are symmetric — no marker. */
export function needsPin1Marker(fp: Pick<Footprint, 'componentType' | 'pads'>): boolean {
  if (!fp.pads.some((p) => p.number === '1')) return false;
  if (fp.pads.length >= 3) return true;
  return /diode|led|zener|schottky|tvs|electrolytic|polar|tantalum|battery|dcvoltage|acvoltage|pulsesource|currentsource|solarcell/i.test(fp.componentType);
}

/** Pad copper as an axis-aligned rect (pad sizes are already rotated with the part). */
const padRect = (p: Pad): Rect => ({
  x0: p.position.x - p.size.width / 2, y0: p.position.y - p.size.height / 2,
  x1: p.position.x + p.size.width / 2, y1: p.position.y + p.size.height / 2,
});

/** Everything on `layer` that silk must keep clear of: SMD pads of this side +
 *  every through-hole (plated or not — the fab does not print over holes). */
function silkObstacles(footprints: Footprint[], layer: string): Rect[] {
  const out: Rect[] = [];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const hole = (pad.drill ?? 0) > 0;
      if (!hole && pad.layer !== layer && fp.side !== layer) continue;
      out.push(padRect(pad));
    }
  }
  return out;
}

const growRect = (r: Rect, g: number): Rect => ({ x0: r.x0 - g, y0: r.y0 - g, x1: r.x1 + g, y1: r.y1 + g });

/** Distance from a point to a rect (0 inside). */
function distPointRect(p: Pt, r: Rect): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
  const dy = Math.max(r.y0 - p.y, 0, p.y - r.y1);
  return Math.hypot(dx, dy);
}

/** Minimum distance from segment a–b to a rect (0 when they touch/cross). */
export function distSegmentRect(a: Pt, b: Pt, r: Rect): number {
  // inside / crossing?
  const [t0, t1] = clipParam(a, b, r);
  if (t1 > t0) return 0;
  // else the minimum is at an endpoint of the segment or at a rect corner
  let best = Math.min(distPointRect(a, r), distPointRect(b, r));
  const corners: Pt[] = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  for (const c of corners) {
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y));
  }
  return best;
}

/** Liang–Barsky: parameter interval of segment a→b strictly inside rect r ([0,0] when none). */
function clipParam(a: Pt, b: Pt, r: Rect): [number, number] {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const edges: [number, number][] = [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dy, a.y - r.y0], [dy, r.y1 - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q <= 0) return [0, 0]; continue; } // parallel & on/outside the boundary
    const t = q / p;
    if (p < 0) { if (t > t1) return [0, 0]; if (t > t0) t0 = t; }
    else { if (t < t0) return [0, 0]; if (t < t1) t1 = t; }
  }
  return t1 > t0 ? [t0, t1] : [0, 0];
}

/** Remove the parts of a→b closer than `clear` to any obstacle. Returns the kept pieces and the removed length. */
function clipSegment(a: Pt, b: Pt, obstacles: Rect[], clear: number): { kept: [Pt, Pt][]; lost: number } {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return { kept: [], lost: 0 };
  const cut: [number, number][] = [];
  for (const o of obstacles) {
    const g = growRect(o, clear - 1e-6);
    // cheap reject
    if (Math.max(a.x, b.x) < g.x0 || Math.min(a.x, b.x) > g.x1 || Math.max(a.y, b.y) < g.y0 || Math.min(a.y, b.y) > g.y1) continue;
    const [t0, t1] = clipParam(a, b, g);
    if (t1 > t0) cut.push([t0, t1]);
  }
  cut.sort((m, n) => m[0] - n[0]);
  const merged: [number, number][] = [];
  for (const c of cut) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]); else merged.push([c[0], c[1]]);
  }
  const kept: [Pt, Pt][] = [];
  let lost = 0, t = 0;
  const at = (u: number): Pt => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  const MIN_PIECE = 0.05; // mm — a stroke shorter than its own width is a blob
  const push = (u0: number, u1: number) => { if ((u1 - u0) * len >= MIN_PIECE) kept.push([at(u0), at(u1)]); else lost += (u1 - u0) * len; };
  for (const [c0, c1] of merged) { if (c0 > t) push(t, c0); lost += (c1 - c0) * len; t = c1; }
  if (t < 1) push(t, 1);
  return { kept, lost };
}

function clipPolyline(pts: Pt[], obstacles: Rect[], clear: number): { kept: [Pt, Pt][]; lost: number } {
  const kept: [Pt, Pt][] = [];
  let lost = 0;
  for (let i = 1; i < pts.length; i++) {
    const r = clipSegment(pts[i - 1], pts[i], obstacles, clear);
    kept.push(...r.kept); lost += r.lost;
  }
  return { kept, lost };
}

/**
 * Silkscreen of one side, as geometry:
 *  - body outline (rotation-aware); if it would cross the part's own pads it
 *    is shrunk toward the centre first, then clipped so every stroke keeps
 *    ≥ 0.15 mm (+ mask expansion + half stroke) from ALL pad copper;
 *  - reference designator, placed where it clips least, mirrored on the bottom
 *    side so it reads correctly with the board flipped;
 *  - a pin-1 dot outside the pads of polarised / orientation-critical parts.
 */
export function buildSilkGeometry(layer: 'top' | 'bottom', footprints: Footprint[]): SilkGeometry {
  const segments: [Pt, Pt][] = [];
  const dots: SilkGeometry['dots'] = [];
  const obstacles = silkObstacles(footprints, layer);
  const C = SILK_CENTER_CLEARANCE;

  for (const fp of footprints) {
    if (fp.side !== layer) continue;
    const rad = (fp.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const rot = (lx: number, ly: number): Pt => ({ x: fp.position.x + lx * cos - ly * sin, y: fp.position.y + lx * sin + ly * cos });
    // ── body outline (shrunk until it stops crossing pads, then clipped) ──
    const hw0 = fp.bodySize.width / 2, hh0 = fp.bodySize.height / 2;
    const outline = (hw: number, hh: number): Pt[] => [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh), rot(-hw, -hh)];
    let best: { kept: [Pt, Pt][]; lost: number; area: number } | null = null;
    for (let iw = 0; iw <= 7; iw++) {
      for (let ih = 0; ih <= 7; ih++) {
        const hw = hw0 * (1 - iw * 0.1), hh = hh0 * (1 - ih * 0.1);
        const r = clipPolyline(outline(hw, hh), obstacles, C);
        const area = hw * hh;
        if (!best || r.lost < best.lost - 1e-9 || (Math.abs(r.lost - best.lost) <= 1e-9 && area > best.area)) best = { ...r, area };
      }
      if (best && best.lost === 0) break;
    }
    if (best) segments.push(...best.kept);

    // ── reference designator ──
    let minX = fp.position.x - hw0, maxX = fp.position.x + hw0, minY = fp.position.y - hh0, maxY = fp.position.y + hh0;
    for (const c of [rot(-hw0, -hh0), rot(hw0, -hh0), rot(hw0, hh0), rot(-hw0, hh0)]) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    }
    for (const pad of fp.pads) {
      const r = padRect(pad);
      minX = Math.min(minX, r.x0); maxX = Math.max(maxX, r.x1); minY = Math.min(minY, r.y0); maxY = Math.max(maxY, r.y1);
    }
    const TEXT_H = 1.0;
    const tw = strokeTextWidth(fp.refdes, TEXT_H);
    const cx = fp.position.x;
    const candidates: Pt[] = [
      { x: cx, y: minY - 0.9 }, { x: cx, y: maxY + 0.9 },
      { x: cx, y: minY - 2.1 }, { x: cx, y: maxY + 2.1 },
      { x: minX - 0.8 - tw / 2, y: fp.position.y }, { x: maxX + 0.8 + tw / 2, y: fp.position.y },
    ];
    let bestText: { kept: [Pt, Pt][]; lost: number } | null = null;
    for (const cand of candidates) {
      let kept: [Pt, Pt][] = [], lost = 0;
      for (const stroke of strokeText(fp.refdes, cand.x, cand.y, TEXT_H)) {
        // bottom side: the text is mirrored about its own centre line so it
        // reads correctly when the board is turned over
        const pts = layer === 'bottom' ? stroke.map((p) => ({ x: 2 * cand.x - p.x, y: p.y })) : stroke;
        const r = clipPolyline(pts, obstacles, C);
        kept = kept.concat(r.kept); lost += r.lost;
      }
      if (!bestText || lost < bestText.lost - 1e-9) bestText = { kept, lost };
      if (lost === 0) break;
    }
    if (bestText) segments.push(...bestText.kept);

    // ── pin-1 marker ──
    if (needsPin1Marker(fp)) {
      const pin1 = fp.pads.find((p) => p.number === '1')!;
      let dx = pin1.position.x - fp.position.x, dy = pin1.position.y - fp.position.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
      const need = SILK_DOT_R + SILK_PAD_CLEARANCE + MASK_EXPANSION; // dot centre ↔ pad copper
      const base = Math.max(pin1.size.width, pin1.size.height) / 2 + need;
      for (let extra = 0; extra <= 4; extra += 0.1) {
        const c = { x: pin1.position.x + dx * (base + extra), y: pin1.position.y + dy * (base + extra) };
        if (obstacles.every((o) => distPointRect(c, o) >= need - 1e-9)) { dots.push({ x: c.x, y: c.y, r: SILK_DOT_R }); break; }
      }
    }
  }
  return { segments, dots };
}

export function exportGerberSilkscreen(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  board: BoardOutline,
  x2?: X2Meta,
): string {
  const lines: string[] = [];
  lines.push(...x2Header(x2, footprints, board));
  lines.push('%FSLAX46Y46*%');
  lines.push('%MOMM*%');
  lines.push(`%LPD*%`);
  lines.push(`G04 Layer: ${layer.toUpperCase()}_SILKSCREEN*`);
  if (x2) lines.push('%TA.AperFunction,Legend*%');
  lines.push(`%ADD10C,${SILK_LINE_WIDTH.toFixed(3)}*%`);  // silkscreen line width
  lines.push('%ADD11C,0.500*%');  // pin-1 dot
  if (x2) lines.push('%TD.AperFunction*%');
  lines.push('G01*');
  lines.push('G54D10*');

  const geo = buildSilkGeometry(layer, footprints);
  // merge consecutive collinear-continuation segments into polylines
  let pen: Pt | null = null;
  for (const [a, b] of geo.segments) {
    if (!pen || Math.abs(pen.x - a.x) > 1e-9 || Math.abs(pen.y - a.y) > 1e-9) {
      lines.push(`X${fmtCoord(a.x)}Y${fmtCoord(fabY(a.y))}D02*`);
    }
    lines.push(`X${fmtCoord(b.x)}Y${fmtCoord(fabY(b.y))}D01*`);
    pen = b;
  }
  // Pin-1 dots, outside the pads — the only way an assembler can orient an
  // IC, transistor or polarised part.
  lines.push('G54D11*');
  for (const d of geo.dots) lines.push(`X${fmtCoord(d.x)}Y${fmtCoord(fabY(d.y))}D03*`);

  lines.push('M02*');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Excellon drill: plated (PTH) and non-plated (NPTH) files, slots as G85
// ─────────────────────────────────────────────────────────────────────────────

interface Hole { x: number; y: number; d: number; plated: boolean; /** slot end point (board mm), start = x,y */ to?: { x: number; y: number } }

/** Every drilled hole of the board: THT / NPTH pads (round or slotted) and vias. */
function collectHoles(footprints: Footprint[], vias: Via[]): Hole[] {
  const holes: Hole[] = [];
  // ONLY pads with an explicit drill > 0 get a hole. SMD pads (no drill field)
  // must NEVER be drilled: the old ~60%-of-pad estimate punched holes through
  // every SMD landing pad and destroyed them.
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (!(pad.drill != null && pad.drill > 0)) continue;
      const plated = pad.plated !== false;
      const s = pad.slot;
      if (s && Math.abs(s.width - s.height) > 1e-3) {
        const w = Math.min(s.width, s.height), L = Math.max(s.width, s.height), half = (L - w) / 2;
        const ax = s.width > s.height ? { x: half, y: 0 } : { x: 0, y: half };
        holes.push({ x: pad.position.x - ax.x, y: pad.position.y - ax.y, d: w, plated, to: { x: pad.position.x + ax.x, y: pad.position.y + ax.y } });
      } else {
        holes.push({ x: pad.position.x, y: pad.position.y, d: pad.drill, plated });
      }
    }
  }
  for (const via of vias) holes.push({ x: via.position.x, y: via.position.y, d: via.drill, plated: true });
  return holes;
}

/** True when the board has any non-plated hole (an NPTH file is needed). */
export function hasNonPlatedHoles(footprints: Footprint[]): boolean {
  return collectHoles(footprints, []).some((h) => !h.plated);
}

/**
 * Excellon drill file for the plated (`kind = 'pth'`, default: THT pads +
 * vias) or non-plated (`'npth'`: mounting holes) holes. Metric, decimal
 * coordinates, one tool per diameter (ascending); oval holes are routed
 * slots (G85). The two kinds go in separate files — a fab plates every hole
 * of a file, so a mounting hole in the PTH file would get copper barrels.
 */
export function exportExcellonDrill(
  footprints: Footprint[],
  vias: Via[],
  kind: 'pth' | 'npth' = 'pth',
  layerCount = 2,
  date: string = x2Date(),
): string {
  const plated = kind === 'pth';
  const holes = collectHoles(footprints, vias).filter((h) => h.plated === plated);
  const diameters = [...new Set(holes.map((h) => Math.round(h.d * 1000)))].sort((a, b) => a - b);
  const toolOf = new Map(diameters.map((d, i) => [d, i + 1]));

  const lines: string[] = [];
  lines.push('M48');
  lines.push(`; DRILL file {CircuitLab Web EDA} date ${date}`);
  lines.push('; FORMAT={-:-/ absolute / metric / decimal}');
  lines.push(`; #@! TF.CreationDate,${date}`);
  lines.push('; #@! TF.GenerationSoftware,CircuitLab,CircuitLab Web EDA,1.0');
  lines.push(plated ? `; #@! TF.FileFunction,Plated,1,${layerCount},PTH` : `; #@! TF.FileFunction,NonPlated,1,${layerCount},NPTH`);
  lines.push('; #@! TF.FilePolarity,Positive');
  lines.push(plated ? ';TYPE=PLATED' : ';TYPE=NON_PLATED');
  lines.push('FMAT,2');
  lines.push('METRIC');
  for (const d of diameters) lines.push(`T${toolOf.get(d)}C${(d / 1000).toFixed(3)}`);
  lines.push('%');
  lines.push('G90');
  lines.push('G05');

  const fmt = (n: number) => n.toFixed(3);
  for (const d of diameters) {
    lines.push(`T${toolOf.get(d)}`);
    for (const h of holes) {
      if (Math.round(h.d * 1000) !== d) continue;
      lines.push(h.to
        ? `X${fmt(h.x)}Y${fmt(fabY(h.y))}G85X${fmt(h.to.x)}Y${fmt(fabY(h.to.y))}`
        : `X${fmt(h.x)}Y${fmt(fabY(h.y))}`);
    }
  }
  lines.push('M30');
  return lines.join('\n');
}

/**
 * Human-readable drill map: hole count by size, plated status and slots.
 */
export function exportDrillMap(footprints: Footprint[], vias: Via[]): string {
  const sizes = new Map<string, { size: number; count: number; plated: boolean; slots: number }>();
  for (const h of collectHoles(footprints, vias)) {
    const key = `${h.d.toFixed(3)}:${h.plated ? 'PTH' : 'NPTH'}`;
    const e = sizes.get(key) ?? { size: h.d, count: 0, plated: h.plated, slots: 0 };
    e.count++;
    if (h.to) e.slots++;
    sizes.set(key, e);
  }
  const lines = ['Drill map (mm)', '================', ''];
  const sorted = [...sizes.values()].sort((a, b) => Number(b.plated) - Number(a.plated) || a.size - b.size);
  for (const e of sorted) {
    lines.push(`${e.size.toFixed(3)}mm  x${e.count}  ${e.plated ? 'PTH (plated)' : 'NPTH (non-plated)'}${e.slots ? `  [${e.slots} slot${e.slots > 1 ? 's' : ''}, G85]` : ''}`);
  }
  const pth = sorted.filter((e) => e.plated).reduce((a, e) => a + e.count, 0);
  const npth = sorted.filter((e) => !e.plated).reduce((a, e) => a + e.count, 0);
  lines.push('', `Plated holes (drill-PTH.drl): ${pth}`, `Non-plated holes (drill-NPTH.drl): ${npth}`, `Total holes: ${pth + npth}`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement files
// ─────────────────────────────────────────────────────────────────────────────

/** A footprint a pick-and-place machine mounts: has pads, at least one of them
 *  surface-mount, and is a real part (not a mounting hole / schematic symbol). */
export function isSmtFootprint(fp: Pick<Footprint, 'componentType' | 'pads'>): boolean {
  if (!fp.pads || fp.pads.length === 0) return false;
  if (!isPhysicalType(fp.componentType) || isMechanicalType(fp.componentType)) return false;
  return fp.pads.some((p) => !((p.drill ?? 0) > 0));
}

/**
 * Per-package CPL rotation corrections (degrees, added AFTER the CAD→JLC
 * conversion): the angle between this tool's footprint zero orientation
 * (= KiCad's, IPC-7351) and the zero orientation of the JLCPCB feeder/part
 * library. Deliberately EMPTY: a correction is only listed here when it is
 * verified against a real assembled board or JLCPCB's own documentation —
 * guessing flips parts. Add entries as
 *   { pattern: /^SOT-23/, offset: 180, source: 'URL or order number' }
 * and/or set the component parameter `cplRotationOffset` (degrees) per part.
 */
export const CPL_ROTATION_CORRECTIONS: { pattern: RegExp; offset: number; source: string }[] = [];

export interface CplOptions {
  /** schematic components — supplies the per-part `cplRotationOffset` parameter */
  components?: CircuitComponent[];
}

function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

/**
 * JLCPCB component placement list (CPL).
 *
 *   Designator,Mid X,Mid Y,Layer,Rotation
 *
 *  - SMT parts only (THT-only parts, mounting holes and schematic symbols are
 *    not machine-placed).
 *  - Mid X / Mid Y = centre of the bounding box of the part's pads (not its
 *    origin), mm, 4 decimals, in the SAME frame as the Gerbers: X as is, Y
 *    negated (board space is Y-down, fab space Y-up — see fabY).
 *  - Layer = Top | Bottom.
 *  - Rotation = footprint orientation in the IPC-7351 / KiCad zero frame,
 *    counter-clockwise positive (fabRotation). Bottom-side parts follow the
 *    convention JLCPCB's own KiCad tooling uses: board flipped about the Y
 *    axis, so rotation = (180 − θ) mod 360 (X is NOT mirrored).
 *  - then + the per-package correction (CPL_ROTATION_CORRECTIONS) or the
 *    component parameter `cplRotationOffset`, which overrides the table.
 */
export function exportJlcCpl(
  footprints: (Footprint & { footprintName?: string })[],
  opts: CplOptions = {},
): string {
  const byId = new Map((opts.components ?? []).map((c) => [c.id, c]));
  const lines = ['Designator,Mid X,Mid Y,Layer,Rotation'];
  for (const fp of footprints) {
    if (!isSmtFootprint(fp)) continue;
    const soldered = fp.pads.filter((p) => p.plated !== false);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of soldered) {
      const r = padRect(p);
      x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1);
    }
    const mid = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const bottom = fp.side === 'bottom';
    let rot = fabRotation(fp.rotation);
    if (bottom) rot = normDeg(180 - rot);
    const userOffset = byId.get(fp.componentId)?.parameters?.cplRotationOffset;
    let offset = 0;
    if (typeof userOffset === 'number' && Number.isFinite(userOffset)) offset = userOffset;
    else {
      const name = fp.footprintName ?? '';
      offset = CPL_ROTATION_CORRECTIONS.find((c) => c.pattern.test(name))?.offset ?? 0;
    }
    rot = normDeg(rot + offset);
    lines.push([
      fp.refdes,
      mid.x.toFixed(4),
      fabY(mid.y).toFixed(4),
      bottom ? 'Bottom' : 'Top',
      String(Number(rot.toFixed(4))),
    ].join(','));
  }
  return lines.join('\n');
}

/**
 * Generic placement list of every physical part (SMT and THT) for hand
 * assembly / other tools. Columns: Designator, Footprint, PosX, PosY,
 * Rotation, Side, Comment, LCSC Part #. Position = footprint origin, Y negated
 * like the Gerbers, rotation CCW (fabRotation); no per-package corrections —
 * for JLCPCB use exportJlcCpl.
 */
export function exportPickAndPlace(
  footprints: (Footprint & { footprintName?: string })[],
): string {
  const lines: string[] = [];
  lines.push('Designator,Footprint,PosX,PosY,Rotation,Side,Comment,LCSC Part #');
  for (const fp of footprints) {
    if (!isPhysicalType(fp.componentType) || isMechanicalType(fp.componentType)) continue;
    lines.push([
      fp.refdes,
      fp.footprintName ?? fp.componentType,
      fp.position.x.toFixed(3),
      fabY(fp.position.y).toFixed(3),
      fabRotation(fp.rotation).toString(),
      fp.side === 'bottom' ? 'Bottom' : 'Top',
      fp.componentType,
      '',
    ].join(','));
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundles
// ─────────────────────────────────────────────────────────────────────────────

type CopperLayerName = 'top' | 'bottom' | 'inner1' | 'inner2' | 'inner3' | 'inner4';

export interface BundleOptions {
  layers?: CopperLayerName[];
  teardrops?: { position: { x: number; y: number }; padId: string; points: { x: number; y: number }[]; layer: string }[];
  /** 'default' = top_copper.gbr …; 'protel' = JLCPCB/Protel extensions (board.GTL, .GBL, .GTS, .GBS, .GTO, .GBO, .GTP, .GBP, .GKO, .G1…) */
  naming?: 'default' | 'protel';
  /** base file name for 'protel' naming (default 'board') */
  name?: string;
  /** schematic components — per-part CPL rotation offsets (`cplRotationOffset`) */
  components?: CircuitComponent[];
}

const PROTEL_COPPER: Record<CopperLayerName, string> = { top: 'GTL', bottom: 'GBL', inner1: 'G1', inner2: 'G2', inner3: 'G3', inner4: 'G4' };

function bundleNames(opts: BundleOptions) {
  const protel = opts.naming === 'protel';
  const base = opts.name ?? 'board';
  return {
    copper: (l: CopperLayerName) => protel ? `${base}.${PROTEL_COPPER[l]}` : `${l}_copper.gbr`,
    mask: (s: 'top' | 'bottom') => protel ? `${base}.${s === 'top' ? 'GTS' : 'GBS'}` : `${s}_soldermask.gbr`,
    paste: (s: 'top' | 'bottom') => protel ? `${base}.${s === 'top' ? 'GTP' : 'GBP'}` : `${s}_paste.gbr`,
    silk: (s: 'top' | 'bottom') => protel ? `${base}.${s === 'top' ? 'GTO' : 'GBO'}` : `${s}_silkscreen.gbr`,
    edge: protel ? `${base}.GKO` : 'edge_cuts.gbr',
    pth: 'drill-PTH.drl',
    npth: 'drill-NPTH.drl',
  };
}

/**
 * Generate all manufacturing files as a set of downloadable strings.
 * (X1 Gerbers; see exportAllGerbersX2 for the attribute-carrying variant.)
 */
export function exportAllGerbers(
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  pours?: CopperPour[],
  opts?: BundleOptions,
): { filename: string; content: string }[] {
  return buildBundle(false, footprints, traces, vias, board, pours, opts);
}

function buildBundle(
  x2: boolean,
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  pours: CopperPour[] | undefined,
  opts: BundleOptions | undefined,
): { filename: string; content: string }[] {
  const files: { filename: string; content: string }[] = [];
  const layers = opts?.layers ?? ['top', 'bottom'];
  const names = bundleNames(opts ?? {});
  const date = x2Date();
  const projectId = { name: 'CircuitLab-PCB', guid: projectGuid(boardSeed(footprints, board)), rev: 'rev1' };
  const meta = (fileFunction: string, polarity: 'Positive' | 'Negative' = 'Positive'): X2Meta | undefined =>
    x2 ? { fileFunction, polarity, projectId, date } : undefined;
  // Physical stack order → 1-based layer numbers (top=L1 … last=L<N>).
  const stack = sortCopperLayers(layers as string[]);

  // Copper layers (pours render into their layer's copper) — inner layers
  // included when the stackup uses them. Teardrops render as copper flashes.
  const teardropFlashes = (opts?.teardrops ?? []).filter((t) => (layers as string[]).includes(t.layer));
  for (const layer of layers) {
    const td = teardropFlashes.filter((t) => t.layer === layer);
    files.push({
      filename: names.copper(layer),
      content: x2
        ? exportGerberX2Copper(layer, footprints, traces, vias, board, pours, td, stack.indexOf(layer) + 1, { projectId, date, layerCount: stack.length })
        : exportGerberCopper(layer, footprints, traces, vias, board, pours, td),
    });
  }

  // Solder masks (X2: FilePolarity Negative — the drawn image is the openings)
  files.push({ filename: names.mask('top'), content: exportGerberSolderMask('top', footprints, board, meta('Soldermask,Top', 'Negative')) });
  files.push({ filename: names.mask('bottom'), content: exportGerberSolderMask('bottom', footprints, board, meta('Soldermask,Bot', 'Negative')) });
  // Solder paste (SMD stencil)
  files.push({ filename: names.paste('top'), content: exportGerberPaste('top', footprints, board, meta('Paste,Top')) });
  files.push({ filename: names.paste('bottom'), content: exportGerberPaste('bottom', footprints, board, meta('Paste,Bot')) });
  // Silkscreen
  files.push({ filename: names.silk('top'), content: exportGerberSilkscreen('top', footprints, board, meta('Legend,Top')) });
  files.push({ filename: names.silk('bottom'), content: exportGerberSilkscreen('bottom', footprints, board, meta('Legend,Bot')) });
  // Board outline (Edge.Cuts) — the layer fabs actually route from
  files.push({ filename: names.edge, content: exportGerberEdgeCuts(board, meta('Profile,NP')) });

  // Drill: plated and non-plated holes are separate files
  files.push({ filename: names.pth, content: exportExcellonDrill(footprints, vias, 'pth', stack.length, date) });
  const npth = hasNonPlatedHoles(footprints);
  if (npth) files.push({ filename: names.npth, content: exportExcellonDrill(footprints, vias, 'npth', stack.length, date) });

  // Drill map (human-readable hole table for the fab drawing)
  files.push({ filename: 'drill_map.txt', content: exportDrillMap(footprints, vias) });

  // Pick and place: JLCPCB CPL (SMT only) + the generic all-parts list
  files.push({ filename: 'pick_and_place.csv', content: exportJlcCpl(footprints, { components: opts?.components }) });
  files.push({ filename: 'placement_all_parts.csv', content: exportPickAndPlace(footprints) });

  // Gerber job file — tells the CAM station what each file is
  files.push({ filename: 'job.gbrjob', content: exportGerberJobFile(layers, board, { names, hasNpth: npth, projectId, date }) });

  return files;
}

/**
 * Gerber job file (.gbrjob, Gerber X2 JSON): general specs plus one
 * FilesAttributes entry per exported file with its FileFunction / FilePolarity.
 */
export function exportGerberJobFile(
  layers: string[],
  board: BoardOutline,
  ctx?: { names?: ReturnType<typeof bundleNames>; hasNpth?: boolean; projectId?: { name: string; guid: string; rev: string }; date?: string },
): string {
  const names = ctx?.names ?? bundleNames({});
  const stack = sortCopperLayers(layers) as CopperLayerName[];
  const n = stack.length;
  const copperFn = (l: CopperLayerName, i: number) => `Copper,L${i + 1},${l === 'top' ? 'Top' : l === 'bottom' ? 'Bot' : 'Inr'}`;
  const files: { Path: string; FileFunction: string; FilePolarity: string }[] = [
    ...stack.map((l, i) => ({ Path: names.copper(l), FileFunction: copperFn(l, i), FilePolarity: 'Positive' })),
    { Path: names.mask('top'), FileFunction: 'Soldermask,Top', FilePolarity: 'Negative' },
    { Path: names.mask('bottom'), FileFunction: 'Soldermask,Bot', FilePolarity: 'Negative' },
    { Path: names.paste('top'), FileFunction: 'Paste,Top', FilePolarity: 'Positive' },
    { Path: names.paste('bottom'), FileFunction: 'Paste,Bot', FilePolarity: 'Positive' },
    { Path: names.silk('top'), FileFunction: 'Legend,Top', FilePolarity: 'Positive' },
    { Path: names.silk('bottom'), FileFunction: 'Legend,Bot', FilePolarity: 'Positive' },
    { Path: names.edge, FileFunction: 'Profile,NP', FilePolarity: 'Positive' },
    { Path: names.pth, FileFunction: `Plated,1,${n},PTH`, FilePolarity: 'Positive' },
    ...(ctx?.hasNpth ? [{ Path: names.npth, FileFunction: `NonPlated,1,${n},NPTH`, FilePolarity: 'Positive' }] : []),
  ];
  const job = {
    Header: {
      GenerationSoftware: { Vendor: 'CircuitLab', Application: 'CircuitLab Web EDA', Version: '1.0' },
      CreationDate: ctx?.date ?? x2Date(),
    },
    GeneralSpecs: {
      ProjectId: ctx?.projectId
        ? { Name: ctx.projectId.name, GUID: ctx.projectId.guid, Revision: ctx.projectId.rev }
        : { Name: 'CircuitLab-PCB', GUID: projectGuid(`${board.width}x${board.height}`), Revision: 'rev1' },
      Size: { X: board.width, Y: board.height },
      LayerNumber: n,
      BoardThickness: 1.6,
    },
    FilesAttributes: files,
  };
  return JSON.stringify(job, null, 2) + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gerber X2 (RS-274X revision 2) export.
//
// Gerber X2 adds:
//   - %TF.* file attributes: GenerationSoftware, CreationDate, ProjectId
//     (name, GUID, revision), SameCoordinates, FileFunction, FilePolarity
//   - %TA.AperFunction% aperture attributes, attached to the aperture at its
//     definition (SMDPad,CuDef / ComponentPad / ViaPad / Conductor)
//   - %TO.C% component (refdes), %TO.P% pin (refdes,pin-number), %TO.N% net
//     object attributes; an unconnected pad carries the net "N/C"
//
// JLC, PCBWay etc. read the layer from FileFunction, so file names stop
// mattering.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical physical stack positions (1-based) for the copper layers.
 *  Used to order an enabled layer set and to number X2 FileFunction
 *  attributes — the old hardcode (top→L1, bottom→L2, inner→replace) made
 *  inner1 claim L1 (top's number) and bottom claim L2 even on 4-layer
 *  boards where it is physically L4. */
const COPPER_STACK_POS: Record<string, number> = {
  top: 1, inner1: 2, inner2: 3, inner3: 4, inner4: 5, bottom: 6,
};

/** Sort an enabled copper layer set into physical top→bottom order. */
export function sortCopperLayers(layers: string[]): string[] {
  return [...layers].sort((a, b) => (COPPER_STACK_POS[a] ?? 99) - (COPPER_STACK_POS[b] ?? 99));
}

export function exportGerberX2Copper(
  layer: 'top' | 'bottom' | 'inner1' | 'inner2' | 'inner3' | 'inner4',
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  pours?: CopperPour[],
  teardrops?: { position: { x: number; y: number }; points: { x: number; y: number }[] }[],
  layerIndex?: number,
  ctx?: { projectId?: { name: string; guid: string; rev: string }; date?: string; layerCount?: number },
): string {
  const lines: string[] = [];
  // X2 layer number: position within the ENABLED stack when known (a
  // 4-layer board's bottom is L4), else the canonical full-stack position
  // (collision-free even without stack info).
  const layerNum = layerIndex != null && layerIndex >= 1
    ? `L${layerIndex}`
    : `L${COPPER_STACK_POS[layer] ?? 1}`;
  const side = layer === 'top' ? 'Top' : layer === 'bottom' ? 'Bot' : 'Inr';
  lines.push(...x2Header({ fileFunction: `Copper,${layerNum},${side}`, polarity: 'Positive', projectId: ctx?.projectId, date: ctx?.date }, footprints, board));
  lines.push('%FSLAX46Y46*%');
  lines.push('%MOMM*%');
  lines.push('%LPD*%');

  // ── Dynamic exact-size aperture allocator, attribute-tagged ─────────────
  // One aperture per (function, exact shape): the attribute is attached to
  // the aperture at definition, so two roles never share a D-code.
  let nextAp = 10;
  const aps = new Map<string, number>();
  const apDefs: string[] = [];
  const getAp = (body: string, fn: string): number => {
    const key = `${fn}|${body}`;
    let ap = aps.get(key);
    if (ap === undefined) {
      ap = nextAp++;
      aps.set(key, ap);
      apDefs.push(`%TA.AperFunction,${fn}*%`, `%ADD${ap}${body}*%`, '%TD.AperFunction*%');
    }
    return ap;
  };
  const circle = (d: number) => `C,${d.toFixed(4)}`;
  const rect = (w: number, h: number) => `R,${w.toFixed(4)}X${h.toFixed(4)}`;
  const padFn = (pad: Pad) => ((pad.drill ?? 0) > 0 ? 'ComponentPad' : 'SMDPad,CuDef');
  const getPadAp = (pad: Pad): number => getAp(padApertureBody(pad), padFn(pad));

  const padOnLayer = (pad: Pad, fp: Footprint): boolean =>
    pad.plated !== false && ((pad.drill ?? 0) > 0 || pad.layer === layer || fp.side === layer);

  // Pre-scan: allocate all apertures before emitting definitions (def-before-use)
  for (const fp of footprints) for (const pad of fp.pads) if (padOnLayer(pad, fp)) getPadAp(pad);
  for (const trace of traces) if (trace.layer === layer) getAp(circle(trace.width), 'Conductor');
  for (const via of vias) getAp(circle(via.diameter), 'ViaPad');
  // Copper pours on this layer (rect-run apertures, like the X1 writer)
  const layerPours = (pours ?? []).filter((p) => p.layer === layer)
    .map((p) => ({ net: p.net, runs: pourRuns(p) }));
  for (const { runs } of layerPours) for (const run of runs) getAp(rect(run.w, run.h), 'Conductor');
  lines.push(...apDefs);
  lines.push('G01*');

  // No board outline on copper (Edge.Cuts carries it; a copper line on the
  // edge is milled through by the fab).

  const net = (n: string | undefined) => attrText(n && n.trim() ? n : 'N/C');

  // Pads — component (TO.C), pin (TO.P refdes,pin-number) and net (TO.N)
  for (const fp of footprints) {
    const onLayer = fp.pads.map((pad, i) => ({ pad, i })).filter(({ pad }) => padOnLayer(pad, fp));
    if (onLayer.length === 0) continue;
    lines.push(`%TO.C,${attrText(fp.refdes)}*%`);
    for (const { pad, i } of onLayer) {
      lines.push(`%TO.P,${attrText(fp.refdes)},${attrText(pad.number ?? String(i + 1))}*%`);
      lines.push(`%TO.N,${net(pad.net)}*%`);
      lines.push(`G54D${getPadAp(pad)}*`);
      lines.push(`X${fmtCoord(pad.position.x)}Y${fmtCoord(fabY(pad.position.y))}D03*`);
      lines.push('%TD.P*%');
      lines.push('%TD.N*%');
    }
    lines.push('%TD.C*%');
  }

  // Traces — with net attributes
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    lines.push(`%TO.N,${net(trace.net)}*%`);
    lines.push(`G54D${getAp(circle(trace.width), 'Conductor')}*`);
    for (const seg of trace.segments) {
      lines.push(`X${fmtCoord(seg.start.x)}Y${fmtCoord(fabY(seg.start.y))}D02*`);
      lines.push(`X${fmtCoord(seg.end.x)}Y${fmtCoord(fabY(seg.end.y))}D01*`);
    }
    lines.push('%TD.N*%');
  }

  // Vias (ViaPad apertures)
  for (const via of vias) {
    lines.push(`%TO.N,${net(via.net)}*%`);
    lines.push(`G54D${getAp(circle(via.diameter), 'ViaPad')}*`);
    lines.push(`X${fmtCoord(via.position.x)}Y${fmtCoord(fabY(via.position.y))}D03*`);
    lines.push('%TD.N*%');
  }

  // Copper pours — filled regions with their net attribute (a GND pour
  // exports as GND copper)
  for (const { net: pourNet, runs } of layerPours) {
    lines.push(`%TO.N,${net(pourNet)}*%`);
    for (const run of runs) {
      lines.push(`G54D${getAp(rect(run.w, run.h), 'Conductor')}*`);
      lines.push(`X${fmtCoord(run.cx)}Y${fmtCoord(fabY(run.cy))}D03*`);
    }
    lines.push('%TD.N*%');
  }

  // Teardrops — G36 polygon regions (same as the X1 writer).
  for (const td of teardrops ?? []) {
    if (!td.points || td.points.length < 3) continue;
    lines.push('G36*');
    td.points.forEach((p, i) => {
      lines.push(`X${fmtCoord(p.x)}Y${fmtCoord(fabY(p.y))}D0${i === 0 ? 2 : 1}*`);
    });
    lines.push('G37*');
  }

  lines.push('M02*');

  return lines.join('\n');
}

/**
 * Export all Gerber X2 files — FULL parity with the X1 bundle (copper incl.
 * inner layers + teardrops, masks, paste, silk, edge-cuts, PTH/NPTH drills,
 * drill map, CPL, job file), every Gerber carrying its X2 FileFunction /
 * FilePolarity / ProjectId. Pass `naming: 'protel'` for JLCPCB's .GTL/.GBL/
 * .GTS/.GBS/.GTO/.GBO/.GTP/.GBP/.GKO file names.
 */
export function exportAllGerbersX2(
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  pours?: CopperPour[],
  opts?: BundleOptions,
): { filename: string; content: string }[] {
  return buildBundle(true, footprints, traces, vias, board, pours, opts);
}

// ─────────────────────────────────────────────────────────────────────────
// Copper pour geometry
// ─────────────────────────────────────────────────────────────────────────

/**
 * Merge a copper pour's grid cells into horizontal runs. Each run becomes
 * one exact rect aperture flash (center + size) — far fewer objects than
 * flashing every 0.5mm cell while reproducing the identical fill area.
 */
function pourRuns(pour: CopperPour): { cx: number; cy: number; w: number; h: number }[] {
  const cs = pour.cellSize;
  if (cs <= 0) return [];
  const rows = new Map<number, number[]>();
  for (const cell of pour.cells) {
    const col = Math.round(cell.x / cs - 0.5);
    const row = Math.round(cell.y / cs - 0.5);
    const list = rows.get(row);
    if (list) list.push(col); else rows.set(row, [col]);
  }
  const runs: { cx: number; cy: number; w: number; h: number }[] = [];
  for (const [row, cols] of rows) {
    cols.sort((a, b) => a - b);
    let start = cols[0];
    let prev = cols[0];
    for (let i = 1; i <= cols.length; i++) {
      const c = cols[i];
      if (c !== undefined && c === prev + 1) {
        prev = c;
        continue;
      }
      // flush the run [start..prev]
      runs.push({
        cx: (start + prev + 1) / 2 * cs,
        cy: (row + 0.5) * cs,
        w: (prev - start + 1) * cs,
        h: cs,
      });
      if (c !== undefined) { start = c; prev = c; }
    }
  }
  return runs;
}
