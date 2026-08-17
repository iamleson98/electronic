// Schematic canvas overlay drawing functions.
//
// These functions are called from CircuitCanvas's render loop to draw:
//   - ERC error markers (red/yellow circles + tooltip)
//   - Auto-junction dots (where ≥3 wires meet at the same grid point)
//   - Wire length labels (mm/in on hovered or selected wire)
//
// All coordinates are pre-transformed to screen space by the caller —
// these helpers only do canvas drawing, never state mutation.
//
// Conventions:
//   - ERC errors are drawn on top of everything else so they're always visible.
//   - Auto-junction dots are drawn at wire endpoints where ≥3 wires meet.
//   - Wire length labels are drawn only for hovered/selected wires.

import type { ERCError } from './erc';
import type { CircuitComponent, TerminalDef, Vec2, Wire } from './types';
import { getPlugin } from './registry';
import { rotateTerminal } from './components/draw';

// ─────────────────────────────────────────────────────────────────────────────
// 1. ERC markers
// ─────────────────────────────────────────────────────────────────────────────

export interface ERCHitInfo {
  err: ERCError;
  sx: number;
  sy: number;
}

/**
 * Draw ERC error markers as colored circles with X marks.
 * Returns hit-test info so the canvas can show a tooltip on hover.
 *
 * @param errors   ERC errors from the store
 * @param ctx      canvas context
 * @param gridToScreen  grid->screen converter
 * @param hoveredError  optional — error currently hovered (for highlight)
 */
export function drawERCMarkers(
  errors: ERCError[],
  ctx: CanvasRenderingContext2D,
  gridToScreen: (gx: number, gy: number) => Vec2,
  hoveredError?: ERCError | null,
): ERCHitInfo[] {
  const hits: ERCHitInfo[] = [];
  for (const err of errors) {
    const sp = gridToScreen(err.position.x, err.position.y);
    const isHover = hoveredError === err;
    const r = isHover ? 9 : 7;
    const isError = err.severity === 'error';
    // outer halo
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r + 4, 0, Math.PI * 2);
    ctx.fillStyle = isError
      ? (isHover ? 'rgba(239, 68, 68, 0.45)' : 'rgba(239, 68, 68, 0.25)')
      : (isHover ? 'rgba(251, 191, 36, 0.45)' : 'rgba(251, 191, 36, 0.25)');
    ctx.fill();
    // inner disc
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isError ? '#dc2626' : '#f59e0b';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // Iconography (color-blind safe): errors use ✕ (X), warnings use ! (exclamation)
    // — provides shape distinction independent of red/amber color coding.
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (isError) {
      // X mark for errors
      ctx.beginPath();
      ctx.moveTo(sp.x - 3, sp.y - 3); ctx.lineTo(sp.x + 3, sp.y + 3);
      ctx.moveTo(sp.x + 3, sp.y - 3); ctx.lineTo(sp.x - 3, sp.y + 3);
      ctx.stroke();
    } else {
      // Exclamation mark for warnings — ! inside a triangle would be ideal but
      // a tall rectangle + dot is more legible at this radius.
      ctx.fillRect(sp.x - 0.8, sp.y - 4, 1.6, 5);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y + 3, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    hits.push({ err, sx: sp.x, sy: sp.y });
  }
  return hits;
}

/** hit-test ERC errors by screen position */
export function findERCErrorAt(
  errors: ERCError[],
  sx: number,
  sy: number,
  gridToScreen: (gx: number, gy: number) => Vec2,
): ERCError | null {
  for (const err of errors) {
    const sp = gridToScreen(err.position.x, err.position.y);
    const dx = sx - sp.x;
    const dy = sy - sp.y;
    if (dx * dx + dy * dy < 100) return err;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Auto-junctions — dots where ≥3 wire endpoints converge at the same
//    screen-space grid point. KiCad draws these automatically; without them,
//    crossing wires look ambiguous (is it a connection or a crossing?).
// ─────────────────────────────────────────────────────────────────────────────

interface Junction {
  x: number;
  y: number;
  /** number of wire endpoints meeting here */
  count: number;
}

export function drawAutoJunctions(
  ctx: CanvasRenderingContext2D,
  components: CircuitComponent[],
  wires: Wire[],
  gridToScreen: (gx: number, gy: number) => Vec2,
  hoveredTerminal?: { componentId: string; terminalId: string; pos: Vec2 } | null,
): void {
  // Group all wire endpoints by their grid coordinate.
  // A junction dot is drawn only when ≥3 wires meet at the same point
  // (2 wires = a pass-through, no dot needed; the wire already represents it).
  const groups = new Map<string, Junction>();

  for (const wire of wires) {
    for (const end of [wire.from, wire.to]) {
      const comp = components.find((c) => c.id === end.componentId);
      if (!comp) continue;
      const plugin = getPlugin(comp.type);
      if (!plugin) continue;
      const term = plugin.terminals.find((t) => t.id === end.terminalId);
      if (!term) continue;
      const pos = getTerminalPos(comp, term);
      const key = `${pos.x.toFixed(3)},${pos.y.toFixed(3)}`;
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { x: pos.x, y: pos.y, count: 1 });
    }
  }

  // Draw a filled dot at each junction where ≥3 wires meet.
  for (const g of groups.values()) {
    if (g.count < 3) continue;
    const sp = gridToScreen(g.x, g.y);
    const isHot = hoveredTerminal &&
      Math.abs(hoveredTerminal.pos.x - g.x) < 0.5 &&
      Math.abs(hoveredTerminal.pos.y - g.y) < 0.5;
    const r = isHot ? 6 : 4.5;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b'; // dark center for contrast against wire
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r - 1, 0, Math.PI * 2);
    ctx.fillStyle = isHot ? '#fbbf24' : '#cbd5e1';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function getTerminalPos(comp: CircuitComponent, terminal: TerminalDef): Vec2 {
  const plugin = getPlugin(comp.type);
  if (!plugin) return { x: comp.position.x + terminal.position.x, y: comp.position.y + terminal.position.y };
  const rotated = rotateTerminal(terminal, comp.rotation, plugin.boundingBox);
  return {
    x: comp.position.x + rotated.position.x,
    y: comp.position.y + rotated.position.y,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Wire length label
//    Shows physical length (in mm/in) of a hovered or selected wire.
//    KiCad shows this when you hover a wire.
// ─────────────────────────────────────────────────────────────────────────────

export interface WireLengthInfo {
  /** length in mm */
  lengthMm: number;
  /** label with unit */
  label: string;
  /** midpoint screen coords */
  mid: Vec2;
}

/**
 * Compute total wire length in mm (1 grid unit = 1 mm in our convention;
 * KiCad uses a 1.27mm grid but here we use 1 unit = 1mm for simplicity).
 *
 * Caller passes the screen-space path so we can compute the midpoint for the label.
 */
export function drawWireLengthLabel(
  ctx: CanvasRenderingContext2D,
  screenPath: Vec2[],
  gridPath: Vec2[],
  units: 'mm' | 'mil' | 'in' | 'grid',
): WireLengthInfo | null {
  if (gridPath.length < 2) return null;
  // total length in grid units
  let totalGrid = 0;
  for (let i = 0; i < gridPath.length; i++) {
    if (i === 0) continue;
    const a = gridPath[i - 1];
    const b = gridPath[i];
    totalGrid += Math.hypot(b.x - a.x, b.y - a.y);
  }
  // 1 grid unit = 1 mm (our schematic convention)
  const lengthMm = totalGrid;
  let label: string;
  switch (units) {
    case 'mm': label = `${lengthMm.toFixed(2)} mm`; break;
    case 'mil': label = `${(lengthMm * 39.3701).toFixed(1)} mil`; break;
    case 'in': label = `${(lengthMm / 25.4).toFixed(3)} in`; break;
    case 'grid': label = `${totalGrid.toFixed(2)} u`; break;
  }
  // midpoint of the path
  let acc = 0;
  let mid: Vec2 = screenPath[0];
  let totalScreen = 0;
  const segLens: number[] = [];
  for (let i = 0; i < screenPath.length - 1; i++) {
    const a = screenPath[i];
    const b = screenPath[i + 1];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    segLens.push(l);
    totalScreen += l;
  }
  const half = totalScreen / 2;
  for (let i = 0; i < segLens.length; i++) {
    if (acc + segLens[i] >= half) {
      const t = (half - acc) / segLens[i];
      const a = screenPath[i];
      const b = screenPath[i + 1];
      mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      break;
    }
    acc += segLens[i];
  }
  // draw a small dark pill with the label
  ctx.save();
  ctx.font = 'bold 10px ui-monospace, monospace';
  const w = ctx.measureText(label).width + 8;
  const h = 16;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1;
  roundRect(ctx, mid.x - w / 2, mid.y - h / 2, w, h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fbbf24';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, mid.x, mid.y);
  ctx.restore();
  return { lengthMm, label, mid };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
