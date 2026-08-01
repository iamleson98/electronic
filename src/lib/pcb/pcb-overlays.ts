// PCB canvas overlay drawing functions.
//
// These functions are called from PCBCanvas's render loop to draw:
//   - DRC violation markers with severity halo + tooltip text
//   - Courtyard outlines (component placement boundary)
//   - Lock indicators on locked footprints
//   - Routing-completion progress bar (routed / total nets)
//
// All coordinates are pre-transformed to screen space by the caller —
// these helpers only do canvas drawing, never state mutation.

import type { DRCError } from './drc';
import type { Footprint } from './types';
import type { Vec2 } from '../circuit/types';

const PX_PER_MM = 8;

// ─────────────────────────────────────────────────────────────────────────────
// 1. DRC markers — drawn as colored halos with X marks + short message label
// ─────────────────────────────────────────────────────────────────────────────

export interface DRCHitInfo {
  err: DRCError;
  sx: number;
  sy: number;
}

/**
 * Draw DRC markers — same visual language as the schematic ERC markers
 * (halo + disc + X) plus an optional short label below the marker.
 *
 * @param errors     DRC errors from the store
 * @param ctx        canvas context
 * @param mmToScreen mm->screen converter
 * @param hoveredErr  error currently hovered (for highlight + full tooltip)
 * @param zoom       current zoom (for label sizing)
 */
export function drawDRCErrors(
  errors: DRCError[],
  ctx: CanvasRenderingContext2D,
  mmToScreen: (mx: number, my: number) => Vec2,
  hoveredErr: DRCError | null,
  zoom: number,
): DRCHitInfo[] {
  const hits: DRCHitInfo[] = [];
  for (const err of errors) {
    const sp = mmToScreen(err.position.x, err.position.y);
    const isHover = hoveredErr === err;
    const r = isHover ? 9 : 7;
    // outer halo
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r + 4, 0, Math.PI * 2);
    ctx.fillStyle = err.severity === 'error'
      ? (isHover ? 'rgba(239, 68, 68, 0.5)' : 'rgba(239, 68, 68, 0.28)')
      : (isHover ? 'rgba(251, 191, 36, 0.5)' : 'rgba(251, 191, 36, 0.28)');
    ctx.fill();
    // inner disc
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fillStyle = err.severity === 'error' ? '#dc2626' : '#f59e0b';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // X mark
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sp.x - 3, sp.y - 3); ctx.lineTo(sp.x + 3, sp.y + 3);
    ctx.moveTo(sp.x + 3, sp.y - 3); ctx.lineTo(sp.x - 3, sp.y + 3);
    ctx.stroke();
    // short label below marker (only when hovered or always-on error severity)
    if (isHover || err.severity === 'error') {
      const label = err.message.length > 32
        ? err.message.slice(0, 30) + '…'
        : err.message;
      ctx.save();
      ctx.font = `${Math.max(9, Math.floor(9 * zoom / 2))}px ui-monospace, monospace`;
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = err.severity === 'error' ? '#dc2626' : '#f59e0b';
      ctx.lineWidth = 1;
      const bx = sp.x - tw / 2;
      const by = sp.y + r + 4;
      roundRect(ctx, bx, by, tw, 14, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = err.severity === 'error' ? '#fecaca' : '#fde68a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, sp.x, by + 7);
      ctx.restore();
    }
    hits.push({ err, sx: sp.x, sy: sp.y });
  }
  return hits;
}

/** hit-test DRC errors by screen position */
export function findDRCErrorAt(
  errors: DRCError[],
  sx: number,
  sy: number,
  mmToScreen: (mx: number, my: number) => Vec2,
): DRCError | null {
  for (const err of errors) {
    const sp = mmToScreen(err.position.x, err.position.y);
    const dx = sx - sp.x;
    const dy = sy - sp.y;
    if (dx * dx + dy * dy < 100) return err;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Courtyard outlines — KiCad draws a dashed rectangle around each
//    footprint representing the minimum keep-out area for placement.
//    Without this, components can visually overlap and look fine —
//    but the DRC will fail. Drawing it makes placement intuitional.
// ─────────────────────────────────────────────────────────────────────────────

const COURTYARD_MARGIN_MM = 0.5; // 0.5mm margin around bodySize (matches DRC default)

export function drawCourtyards(
  ctx: CanvasRenderingContext2D,
  footprints: Footprint[],
  mmToScreen: (mx: number, my: number) => Vec2,
  zoom: number,
  selectedFootprintId: string | null,
): void {
  ctx.save();
  for (const fp of footprints) {
    const isSelected = selectedFootprintId === fp.id;
    const w = fp.bodySize.width + COURTYARD_MARGIN_MM * 2;
    const h = fp.bodySize.height + COURTYARD_MARGIN_MM * 2;
    // rotate the rectangle around the footprint center
    const center = mmToScreen(fp.position.x, fp.position.y);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate((fp.rotation * Math.PI) / 180);
    // courtyard rectangle
    ctx.strokeStyle = isSelected ? 'rgba(34, 197, 94, 0.85)' : 'rgba(34, 197, 94, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(-w / 2 * PX_PER_MM * zoom, -h / 2 * PX_PER_MM * zoom, w * PX_PER_MM * zoom, h * PX_PER_MM * zoom);
    ctx.setLineDash([]);
    // corner markers (small + at each corner) — KiCad style
    if (isSelected) {
      const corners = [
        { x: -w / 2, y: -h / 2 },
        { x:  w / 2, y: -h / 2 },
        { x: -w / 2, y:  h / 2 },
        { x:  w / 2, y:  h / 2 },
      ];
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.4;
      for (const c of corners) {
        const cx = c.x * PX_PER_MM * zoom;
        const cy = c.y * PX_PER_MM * zoom;
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy); ctx.lineTo(cx + 3, cy);
        ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 3);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Lock indicators — small lock icon on locked footprints (top-right)
// ─────────────────────────────────────────────────────────────────────────────

export interface LockableFootprint {
  id: string;
  locked?: boolean;
  position: { x: number; y: number };
  bodySize: { width: number; height: number };
  rotation: number;
}

export function drawLockIndicators(
  ctx: CanvasRenderingContext2D,
  footprints: LockableFootprint[],
  mmToScreen: (mx: number, my: number) => Vec2,
  zoom: number,
): void {
  for (const fp of footprints) {
    if (!fp.locked) continue;
    // compute corner in mm, then transform to screen (ignoring rotation for icon position —
    // lock icon should always appear top-right in screen space, not rotated)
    const cornerMm = {
      x: fp.position.x + fp.bodySize.width / 2,
      y: fp.position.y - fp.bodySize.height / 2,
    };
    const sp = mmToScreen(cornerMm.x, cornerMm.y);
    const size = 10;
    ctx.save();
    ctx.translate(sp.x + 4, sp.y - 4);
    // shackle (rounded part)
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, -2, 3, Math.PI, 0);
    ctx.stroke();
    // body
    ctx.fillStyle = '#facc15';
    ctx.fillRect(-4, -1, 8, 6);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 0.6;
    ctx.strokeRect(-4, -1, 8, 6);
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Routing completion progress bar — bottom-right HUD showing
//    routed_nets / total_nets as a small bar + percentage
// ─────────────────────────────────────────────────────────────────────────────

export function drawRoutingCompletion(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  routedNets: number,
  totalNets: number,
): void {
  const pct = totalNets > 0 ? routedNets / totalNets : 0;
  const barW = 140;
  const barH = 8;
  const x = canvasWidth - barW - 16;
  const y = canvasHeight - 40;
  ctx.save();
  // label
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`Routing: ${routedNets}/${totalNets} nets (${Math.round(pct * 100)}%)`, x, y - 2);
  // bar background
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(x, y, barW, barH);
  // bar fill — green when 100%, amber when partial
  const fillColor = pct >= 1 ? '#22c55e' : '#fbbf24';
  ctx.fillStyle = fillColor;
  ctx.fillRect(x, y, barW * pct, barH);
  // border
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, barW, barH);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: rounded rectangle
// ─────────────────────────────────────────────────────────────────────────────

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
