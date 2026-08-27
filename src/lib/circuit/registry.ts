// Plugin registry: every component plugin registers itself here.
// To add a new component, call `registerPlugin(...)` at module load time.
// The registry is the single source of truth for "what kinds of parts exist".

import type { ComponentPlugin } from './types';

const registry = new Map<string, ComponentPlugin>();
/** Bumped on every (re-)registration — used to invalidate nodeMap caches. */
let registryVersion = 0;
const categoryOrder: Record<string, number> = {
  io: 0,        // input/output (switches, LEDs)
  source: 1,    // power sources
  passive: 2,   // R, L, C
  semiconductor: 3, // diodes, transistors
  ic: 4,        // op-amp, 555, logic
  logic: 5,     // gates
  meter: 6,     // voltmeter, ammeter, scope
  mcu: 7,       // Arduino, RPi
};

export function registerPlugin(plugin: ComponentPlugin) {
  // Overwrite if a plugin with the same type already exists — this matches
  // the comment below (HMR re-registration, plus user-symbol re-saves).
  // Built-in plugins are registered at module load and re-registering them
  // with identical data is a no-op.
  registry.set(plugin.type, plugin);
  registryVersion++;
}

/** Current registry generation — changes whenever a plugin is (re-)registered. */
export function getRegistryVersion(): number {
  return registryVersion;
}

export function getPlugin(type: string): ComponentPlugin | undefined {
  return registry.get(type);
}

export function getAllPlugins(): ComponentPlugin[] {
  return Array.from(registry.values()).sort((a, b) => {
    const ca = categoryOrder[a.category] ?? 99;
    const cb = categoryOrder[b.category] ?? 99;
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name);
  });
}

export function getPluginsByCategory(): { category: string; plugins: ComponentPlugin[] }[] {
  const groups = new Map<string, ComponentPlugin[]>();
  for (const p of getAllPlugins()) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category)!.push(p);
  }
  return Array.from(groups.entries()).map(([category, plugins]) => ({ category, plugins }));
}

export function hasPlugin(type: string): boolean {
  return registry.has(type);
}
