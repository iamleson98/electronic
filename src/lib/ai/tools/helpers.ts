// AI Tool helper utilities — shared across all tool category files.

import type { CircuitDocument, CircuitComponent } from '@/lib/circuit/types';
import type { ToolContext } from './types';
import { getPlugin } from '@/lib/circuit/registry';

export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function findComponent(doc: CircuitDocument, id: string): CircuitComponent | undefined {
  return doc.components.find(c => c.id === id);
}

/**
 * Ensure ctx.plugins covers every component type currently in the document.
 *
 * The routes build the initial plugin map from the SNAPSHOT the client sent.
 * When the AI adds a component type that wasn't already on the canvas (e.g.
 * "build me an LED circuit" on an empty canvas → adds dcVoltage/resistor/led),
 * the map would be stale and every simulation tool would silently skip the new
 * parts. Calling this after mutations (and before any sim that matters) keeps
 * the map complete. O(components) map lookups — cheap.
 */
export function ensurePlugins(ctx: ToolContext): void {
  for (const c of ctx.doc.components) {
    if (!ctx.plugins.has(c.type)) {
      const p = getPlugin(c.type);
      if (p) ctx.plugins.set(c.type, p);
    }
  }
}
