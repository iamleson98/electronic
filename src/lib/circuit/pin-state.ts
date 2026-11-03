// Pin connectivity queries for plugins.
//
// Unwired signal pins get their own floating node (see buildNodeMap), so a
// plugin can tell "left open" apart from "wired to ground" — e.g. a counter
// whose CLK is unwired runs its internal oscillator, while a grounded CLK
// holds the clock low.

import type { SimContext } from './types';

/**
 * True when `node` belongs to an unwired (floating) signal pin. Contexts
 * built without a node map (hand-rolled tests) fall back to the historical
 * convention, where unwired pins mapped to node 0.
 */
export function isPinUnwired(sim: SimContext, node: number): boolean {
  if (sim.floatingNodes) return sim.floatingNodes.has(node);
  return node === 0;
}
