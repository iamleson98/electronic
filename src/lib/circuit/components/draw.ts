// Drawing helpers shared by component plugins.

import type { ComponentBoundingBox, TerminalDef, Vec2 } from '../types';

/** rotate a terminal position by 90° increments around the component center */
export function rotateTerminal(t: TerminalDef, rotation: 0 | 1 | 2 | 3, bb: ComponentBoundingBox): TerminalDef {
  const cx = bb.width / 2;
  const cy = bb.height / 2;
  const dx = t.position.x - cx;
  const dy = t.position.y - cy;
  let rx: number, ry: number;
  switch (rotation) {
    case 0: rx = dx; ry = dy; break;
    case 1: rx = -dy; ry = dx; break;
    case 2: rx = -dx; ry = -dy; break;
    case 3: rx = dy; ry = -dx; break;
  }
  return { ...t, position: { x: cx + rx, y: cy + ry } };
}

export function rotateVec(v: Vec2, rotation: 0 | 1 | 2 | 3, bb: ComponentBoundingBox): Vec2 {
  return rotateTerminal({ id: '', label: '', position: v } as TerminalDef, rotation, bb).position;
}

export function formatValue(value: number, unit: string): string {
  // Null/undefined/NaN (model-provided or hand-edited params) must never
  // crash the canvas renderer.
  if (typeof value !== 'number' || !Number.isFinite(value)) return `?${unit}`;
  if (value === 0) return `0${unit}`;
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M${unit}`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}k${unit}`;
  if (abs >= 1) return `${value.toFixed(2)}${unit}`;
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(2)}m${unit}`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(2)}µ${unit}`;
  if (abs >= 1e-9) return `${(value * 1e9).toFixed(2)}n${unit}`;
  return `${value.toExponential(2)}${unit}`;
}

/** Draw a zig-zag resistor body of length L (along x axis) centered at origin vertically */
export function drawResistorZigzag(ctx: CanvasRenderingContext2D, length: number, height: number = 12) {
  ctx.beginPath();
  const half = length / 2;
  ctx.moveTo(-half, 0);
  const peaks = 6;
  const step = length / peaks;
  for (let i = 0; i < peaks; i++) {
    const x = -half + step * (i + 0.5);
    const y = (i % 2 === 0 ? -1 : 1) * height / 2;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(half, 0);
  ctx.stroke();
}

/** Draw a capacitor symbol (two parallel plates) along x axis */
export function drawCapacitor(ctx: CanvasRenderingContext2D, gap: number = 6, height: number = 16) {
  ctx.beginPath();
  ctx.moveTo(0, -height / 2);
  ctx.lineTo(0, height / 2);
  ctx.moveTo(gap, -height / 2);
  ctx.lineTo(gap, height / 2);
  ctx.stroke();
}

/** Draw an inductor as a series of arcs along x axis */
export function drawInductor(ctx: CanvasRenderingContext2D, length: number, loops: number = 4) {
  const half = length / 2;
  const step = length / loops;
  ctx.beginPath();
  ctx.moveTo(-half, 0);
  for (let i = 0; i < loops; i++) {
    const cx = -half + step * (i + 0.5);
    ctx.arc(cx, 0, step / 2, Math.PI, 0, false);
  }
  ctx.stroke();
}

/** Draw a battery (multi-cell) along x axis */
export function drawBattery(ctx: CanvasRenderingContext2D, length: number) {
  const half = length / 2;
  // long plate (positive) on the right
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(0, 8);
  ctx.moveTo(6, -4);
  ctx.lineTo(6, 4);
  ctx.stroke();
  // leads
  ctx.beginPath();
  ctx.moveTo(-half, 0);
  ctx.lineTo(0, 0);
  ctx.moveTo(6, 0);
  ctx.lineTo(half, 0);
  ctx.stroke();
}

export function drawCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill?: string, stroke?: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawTerminal(ctx: CanvasRenderingContext2D, x: number, y: number, cellSize: number, hot: boolean = false) {
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = hot ? '#ef4444' : '#64748b';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1e293b';
  ctx.stroke();
}

export function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string = '#475569') {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}
