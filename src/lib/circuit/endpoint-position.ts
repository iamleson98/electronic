// Endpoint position resolution — the single shared implementation of
// "where in grid space is this wire endpoint?".
//
// Three copies of this logic previously existed (store.completeWire,
// use-canvas-coordinates, canvas-renderer.makeTransforms) and the router had
// a fourth variant; the rotation-aware version in smart-wire-router
// (terminalGridPos) fixed real routing bugs, so its semantics are the
// canonical ones. New code resolves endpoints through this module.

import { rotateTerminal } from './components/draw';
import type { CircuitComponent, ComponentPlugin, Vec2, HierarchicalSheet } from './types';
import { getPlugin } from './registry';

/** Rotation-aware grid position of a component terminal. */
export function terminalPos(
  comp: CircuitComponent,
  term: { id: string; position: Vec2 },
  plugin: ComponentPlugin,
): Vec2 {
  const rotated = rotateTerminal(term as never, comp.rotation, plugin.boundingBox);
  return { x: comp.position.x + rotated.position.x, y: comp.position.y + rotated.position.y };
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
