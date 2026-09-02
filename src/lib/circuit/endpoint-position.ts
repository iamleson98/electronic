// Endpoint position resolution — the single shared implementation of
// "where in grid space is this wire endpoint?".
//
// Three copies of this logic previously existed (store.completeWire,
// use-canvas-coordinates, canvas-renderer.makeTransforms) and the router had
// a fourth variant; the rotation-aware version in smart-wire-router
// (terminalGridPos) fixed real routing bugs, so its semantics are the
// canonical ones. New code resolves endpoints through this module.
//
// transformBodyPoint is THE canonical body-space → grid-space transform. It
// matches the canvas body render exactly (canvas-renderer component loop):
//
//   translate(center) → rotate(θ) → mirror-scale → translate(-center)
//
// where θ = rotationDeg (free 15°-step rotation) when present, else
// rotation·90°, and mirrorX flips vertically, mirrorY horizontally — both
// around the bounding-box center. Before this module existed, terminal
// resolution honored only the 90°-step rotation while the body render also
// applied mirror/rotationDeg, so mirrored or free-rotated components drew
// their symbol body AWAY from where wires and pin dots attached.

import { rotateTerminal } from './components/draw';
import type { CircuitComponent, ComponentPlugin, Vec2, HierarchicalSheet, ComponentBoundingBox } from './types';
import { getPlugin } from './registry';

/**
 * Transform a body-space point (relative to the component's top-left corner)
 * into the component's local grid frame, applying rotation AND mirror —
 * bit-identical to the canvas body-render transform for 90° steps.
 */
export function transformBodyPoint(
  comp: Pick<CircuitComponent, 'rotation' | 'rotationDeg' | 'mirrorX' | 'mirrorY'>,
  p: Vec2,
  bb: ComponentBoundingBox,
): Vec2 {
  const cx = bb.width / 2;
  const cy = bb.height / 2;
  const deg = comp.rotationDeg;
  // Exact integer path for 90° multiples (including rotationDeg = 90/180/270
  // and the legacy rotation field) — avoids cos(π/2)=6.1e-17 drift so stored
  // waypoints stay on exact grid coordinates.
  const isQuarter = deg == null || Math.abs(deg % 90) < 1e-9;
  if (isQuarter) {
    const totalDeg = (deg ?? comp.rotation * 90) % 360;
    const step = ((Math.round(totalDeg / 90) % 4) + 4) % 4 as 0 | 1 | 2 | 3;
    const r = rotateTerminal({ id: '', label: '', position: p } as never, step, bb).position;
    // Mirror reflects around the bounding-box center in the FINAL frame:
    //   mirrorY (horizontal flip): x → width − x
    //   mirrorX (vertical flip):   y → height − y
    return {
      x: comp.mirrorY ? bb.width - r.x : r.x,
      y: comp.mirrorX ? bb.height - r.y : r.y,
    };
  }
  // Free rotation (15° steps): trig path, same composition order as the body
  // render (rotate, then mirror, around the center).
  const dx = p.x - cx;
  const dy = p.y - cy;
  const rad = (deg! * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let rx = dx * cos - dy * sin;
  let ry = dx * sin + dy * cos;
  if (comp.mirrorY) rx = -rx;
  if (comp.mirrorX) ry = -ry;
  return { x: cx + rx, y: cy + ry };
}

/** Rotation- and mirror-aware grid position of a component terminal. */
export function terminalPos(
  comp: CircuitComponent,
  term: { id: string; position: Vec2 },
  plugin: ComponentPlugin,
): Vec2 {
  const t = transformBodyPoint(comp, term.position, plugin.boundingBox);
  return { x: comp.position.x + t.x, y: comp.position.y + t.y };
}

/**
 * Resolve a wire endpoint ({componentId, terminalId} — component terminal or
 * hierarchical-sheet pin) to its grid-space position, honoring rotation.
 * Returns null when the component/terminal no longer exists.
 */
export function resolveEndpointGridPos(
  endpoint: { componentId: string; terminalId: string },
  components: CircuitComponent[],
  sheets: HierarchicalSheet[],
): Vec2 | null {
  // Defensive: malformed endpoints (scripting-API misuse, foreign JSON
  // imports) return null instead of crashing callers like the render loop.
  if (!endpoint || typeof endpoint.componentId !== 'string' || typeof endpoint.terminalId !== 'string') {
    return null;
  }
  if (endpoint.componentId.startsWith('__sheet:')) {
    const sheetId = endpoint.componentId.slice('__sheet:'.length);
    const sheet = sheets.find((s) => s.id === sheetId);
    if (!sheet) return null;
    const pinId = endpoint.terminalId.startsWith('pin:') ? endpoint.terminalId.slice('pin:'.length) : endpoint.terminalId;
    const pin = sheet.pins.find((p) => p.id === pinId);
    if (!pin) return null;
    return { x: sheet.position.x + pin.position.x, y: sheet.position.y + pin.position.y };
  }
  const comp = components.find((c) => c.id === endpoint.componentId);
  if (!comp) return null;
  const plugin = getPlugin(comp.type);
  if (!plugin) return null;
  const t = plugin.terminals.find((tt) => tt.id === endpoint.terminalId);
  if (!t) return null;
  return terminalPos(comp, t, plugin);
}
