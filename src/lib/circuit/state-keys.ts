// Per-component simulation-state keys.
//
// Sim state used to be keyed by node ids (`npn_3_1_2`). buildNodeMap()
// renumbers nodes on every step, so any topology edit (wire added/deleted,
// pin swapped, undo/redo) silently re-attributed state to a different net or
// orphaned it. Keying by the component's stable id makes state immune to node
// renumbering by construction.
//
// The node-based fallback only applies to hand-built stamps that have no
// component reference (legacy tests) and matches the historical key format.

import type { CircuitComponent } from './types';

/**
 * Build a per-component sim-state key.
 *
 * Examples:
 *   stateKey('npn', comp, c, b, e)  → "npn_Q1"      (normal path)
 *   stateKey('npn', undefined, 3, 1, 2) → "npn_3_1_2" (legacy fallback)
 */
export function stateKey(
  prefix: string,
  comp: CircuitComponent | undefined,
  ...fallbackNodes: (number | string)[]
): string {
  const id = comp?.id;
  if (id != null && id !== '') return `${prefix}_${id}`;
  return `${prefix}_${fallbackNodes.join('_')}`;
}
