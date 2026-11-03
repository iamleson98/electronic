// Camera that fits a schematic in the canvas: every part (rotation-aware
// body box) and every wire bend inside the view, centered, with a margin.
// (The old zoom-to-fit assumed 40 px per grid cell — the canvas uses
// CELL_SIZE = 18 — so it zoomed out ~2.2× too far and parked the circuit in
// the top-left corner; it also ignored wire bends and rotated parts.)

import type { CircuitComponent, HierarchicalSheet, Vec2, Wire } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';
import { transformBodyPoint } from '@/lib/circuit/endpoint-position';
import { CELL_SIZE } from './canvas-types';

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4;

export function computeFitView(
  components: CircuitComponent[],
  wires: Wire[],
  sheets: HierarchicalSheet[],
  canvasW: number,
  canvasH: number,
  marginPx = 40,
): { zoom: number; pan: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const c of components) {
    const pl = getPlugin(c.type);
    if (!pl) continue;
    const bb = pl.boundingBox;
    const a = transformBodyPoint(c, { x: 0, y: 0 }, bb);
    const b = transformBodyPoint(c, { x: bb.width, y: bb.height }, bb);
    add(c.position.x + a.x, c.position.y + a.y);
    add(c.position.x + b.x, c.position.y + b.y);
  }
  for (const w of wires) for (const p of w.waypoints ?? []) add(p.x, p.y);
  for (const s of sheets) {
    add(s.position.x, s.position.y);
    add(s.position.x + (s.size?.width ?? 0), s.position.y + (s.size?.height ?? 0));
  }
  if (!Number.isFinite(minX)) return { zoom: 1, pan: { x: 0, y: 0 } };
  const wPx = Math.max(1, (maxX - minX) * CELL_SIZE);
  const hPx = Math.max(1, (maxY - minY) * CELL_SIZE);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(
    (canvasW - 2 * marginPx) / wPx,
    (canvasH - 2 * marginPx) / hPx,
  )));
  // center the content box
  const cx = ((minX + maxX) / 2) * CELL_SIZE * zoom;
  const cy = ((minY + maxY) / 2) * CELL_SIZE * zoom;
  return { zoom, pan: { x: canvasW / 2 - cx, y: canvasH / 2 - cy } };
}
