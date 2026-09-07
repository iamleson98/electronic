// ─── Persistent user symbol library ──────────────────────────────────────────
// Custom symbols created in the Symbol Editor and symbols imported from KiCad
// libraries are persisted to localStorage and re-registered as palette plugins
// at app startup. Previously custom symbols were runtime-only — every reload
// silently discarded them.
//
// Storage contract: JSON array of entries under `circuitlab-user-library-v1`.
// Entries hold the SymbolDesign (pure data — no functions) plus provenance.

import type { SymbolDesign } from './symbol-editor-types';
import { symbolDesignToPlugin } from './symbol-editor-types';
import { registerPlugin, hasPlugin } from './registry';

const LIBRARY_KEY = 'circuitlab-user-library-v1';

/** Hard cap — localStorage holds ~5 MB; a full KiCad lib is far larger, so the
 *  import dialog enforces this and tells the user. */
export const USER_LIBRARY_MAX_SYMBOLS = 400;

export interface UserLibraryEntry {
  design: SymbolDesign;
  source: 'symbol-editor' | 'kicad-import';
  importedAt: number;
}

function readRaw(): UserLibraryEntry[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: only keep entries with a usable design
    return parsed.filter(
      (e): e is UserLibraryEntry =>
        e && typeof e === 'object' && e.design && typeof e.design.type === 'string' && Array.isArray(e.design.pins),
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: UserLibraryEntry[]): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded / storage blocked — the registration still happened
    // in-memory for this session; persistence is best-effort.
  }
}

export function listUserDesigns(): UserLibraryEntry[] {
  return readRaw();
}

/** Add or replace (by design.type). Returns false when the library is full
 *  (and the design is new). */
export function saveUserDesign(design: SymbolDesign, source: UserLibraryEntry['source']): boolean {
  const entries = readRaw();
  const idx = entries.findIndex((e) => e.design.type === design.type);
  const entry: UserLibraryEntry = { design, source, importedAt: Date.now() };
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    if (entries.length >= USER_LIBRARY_MAX_SYMBOLS) return false;
    entries.push(entry);
  }
  writeRaw(entries);
  return true;
}

export function removeUserDesign(type: string): void {
  const entries = readRaw().filter((e) => e.design.type !== type);
  writeRaw(entries);
}

export function clearUserLibrary(): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(LIBRARY_KEY);
  } catch { /* storage blocked */ }
}

/**
 * Register every persisted user symbol as a live palette plugin. Called once
 * at app startup (main page and embed page). Returns the number registered.
 * Built-in types always win: a user symbol whose type collides with a real
 * plugin type is skipped (imports are prefixed with `kicad_` to make this rare).
 */
export function registerAllUserSymbols(): number {
  let count = 0;
  for (const entry of readRaw()) {
    try {
      if (hasPlugin(entry.design.type)) continue;
      registerPlugin(symbolDesignToPlugin(entry.design));
      count++;
    } catch {
      // one broken entry must not abort the rest
    }
  }
  if (count > 0) {
    try {
      window.dispatchEvent(new CustomEvent('circuitlab:plugin-registered'));
    } catch { /* not in a browser */ }
  }
  return count;
}
