// Wire routing utilities — path computation, hit-testing, and segment dragging.
import type { Vec2, Wire } from '@/lib/circuit/types';

/** Get the orthogonal path points for a wire. */
export function getWirePath(
  wire: Wire,
  fromPos: Vec2,
  toPos: Vec2,
  gridToScreenFn: (gx: number, gy: number) => Vec2,
  use45: boolean = false,
): Vec2[] {
  const points: Vec2[] = [fromPos];
  if (wire.waypoints && wire.waypoints.length > 0) {
    for (const wp of wire.waypoints) {
      points.push(gridToScreenFn(wp.x, wp.y));
    }
  } else {
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    if (Math.abs(dx) < 2) {
      // Nearly vertical — direct line
    } else if (Math.abs(dy) < 2) {
      // Nearly horizontal — direct line
    } else {
      points.push({ x: toPos.x, y: fromPos.y });
    }
  }
  points.push(toPos);
  return points;
}

/** Compute the midpoint of a segment for drag handle detection. */
export function segmentMidpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Angle (in degrees, 0-360) from a center point to a target point. */
export function angleFromCenter(cx: number, cy: number, x: number, y: number): number {
  const angle = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
  return (angle + 360) % 360;
}

/** Re-route a wire so a dragged segment follows the cursor freely in 2D. */
export function rerouteWireForDrag(
  fromPos: Vec2,
  toPos: Vec2,
  segIndex: number,
  cursorGrid: Vec2,
  existingWaypoints: Vec2[],
): Vec2[] {
  const wps: Vec2[] = existingWaypoints.length > 0
    ? existingWaypoints.map((w) => ({ ...w }))
    : [
        { x: (fromPos.x + toPos.x) / 2, y: fromPos.y },
        { x: (fromPos.x + toPos.x) / 2, y: toPos.y },
      ];

  const getPt = (i: number): Vec2 => {
    if (i === 0) return fromPos;
    if (i === wps.length + 1) return toPos;
    return wps[i - 1];
  };
  const setPt = (i: number, val: Vec2) => {
    if (i > 0 && i <= wps.length) wps[i - 1] = val;
  };

  const a = getPt(segIndex);
  const b = getPt(segIndex + 1);
  const isHorizontal = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);

  if (isHorizontal) {
    const newY = cursorGrid.y;
    const midX = (a.x + b.x) / 2;
    const deltaX = cursorGrid.x - midX;
    const aIdx = segIndex;
    const bIdx = segIndex + 1;
    const aIsFixed = (aIdx === 0);
    const bIsFixed = (bIdx === wps.length + 1);
    const newA = { ...getPt(aIdx) };
    const newB = { ...getPt(bIdx) };
    if (!aIsFixed) newA.y = newY;
    if (!bIsFixed) newB.y = newY;
    if (!aIsFixed && !bIsFixed) {
      newA.x += deltaX;
      newB.x += deltaX;
    } else if (aIsFixed && !bIsFixed) {
      newB.x += deltaX;
    } else if (!aIsFixed && bIsFixed) {
      newA.x += deltaX;
    }
    setPt(aIdx, newA);
    setPt(bIdx, newB);
  } else {
    const newX = cursorGrid.x;
    const midY = (a.y + b.y) / 2;
    const deltaY = cursorGrid.y - midY;
    const aIdx = segIndex;
    const bIdx = segIndex + 1;
    const aIsFixed = (aIdx === 0);
    const bIsFixed = (bIdx === wps.length + 1);
    const newA = { ...getPt(aIdx) };
    const newB = { ...getPt(bIdx) };
    if (!aIsFixed) newA.x = newX;
    if (!bIsFixed) newB.x = newX;
    if (!aIsFixed && !bIsFixed) {
      newA.y += deltaY;
      newB.y += deltaY;
    } else if (aIsFixed && !bIsFixed) {
      newB.y += deltaY;
    } else if (!aIsFixed && bIsFixed) {
      newA.y += deltaY;
    }
    setPt(aIdx, newA);
    setPt(bIdx, newB);
  }

  return orthogonalizePath(fromPos, toPos, wps);
}

/** Ensure a wire path is fully orthogonal (no diagonal segments). */
export function orthogonalizePath(fromPos: Vec2, toPos: Vec2, wps: Vec2[]): Vec2[] {
  const result: Vec2[] = [];
  const full: Vec2[] = [fromPos, ...wps, toPos];
  for (let i = 0; i < full.length - 1; i++) {
    const a = full[i];
    const b = full[i + 1];
    result.push({ ...a });
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) {
      result.push({ x: b.x, y: a.y });
    }
  }
  result.push({ ...toPos });
  return result.slice(1, -1);
}

/** Distance from point (px, py) to segment (ax,ay)-(bx,by). */
export function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
