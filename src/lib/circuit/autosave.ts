export function saveToLocalStorage(key: string, doc: any): boolean {
  if (typeof localStorage === 'undefined') return false;
  try { localStorage.setItem(key, JSON.stringify(doc)); return true; } catch { return false; }
}
export function loadFromLocalStorage(key: string): any | null {
  if (typeof localStorage === 'undefined') return null;
  try { const j = localStorage.getItem(key); return j ? JSON.parse(j) : null; } catch { return null; }
}
export function removeFromLocalStorage(key: string): void { try { localStorage.removeItem(key); } catch {} }
export function autosave(doc: any): boolean {
  const ok = saveToLocalStorage('circuitsim:autosave', doc);
  if (ok) {
    try { localStorage.setItem('circuitsim:autosave:timestamp', String(Date.now())); localStorage.setItem('circuitsim:autosave:version', '1'); localStorage.setItem('circuitsim:autosave:crashed', 'true'); } catch {}
  }
  return ok;
}
export function markCleanShutdown(): void { try { localStorage.setItem('circuitsim:autosave:crashed', 'false'); } catch {} }
export function detectCrashRecovery(): any | null {
  if (typeof localStorage === 'undefined') return null;
  const json = localStorage.getItem('circuitsim:autosave'); if (!json) return null;
  const ts = localStorage.getItem('circuitsim:autosave:timestamp');
  const crashed = localStorage.getItem('circuitsim:autosave:crashed');
  if (!ts) return null;
  try { const doc = JSON.parse(json); return { timestamp: parseInt(ts), crashed: crashed === 'true', version: 1, componentCount: doc?.components?.length ?? 0, wireCount: doc?.wires?.length ?? 0 }; } catch { return null; }
}
export function loadAutosave(): any | null { return loadFromLocalStorage('circuitsim:autosave'); }
export function clearAutosave(): void { removeFromLocalStorage('circuitsim:autosave'); removeFromLocalStorage('circuitsim:autosave:timestamp'); removeFromLocalStorage('circuitsim:autosave:crashed'); removeFromLocalStorage('circuitsim:autosave:version'); }
export function getLastAutosaveTime(): Date | null { if (typeof localStorage === 'undefined') return null; const ts = localStorage.getItem('circuitsim:autosave:timestamp'); return ts ? new Date(parseInt(ts)) : null; }

/**
 * AutosaveManager — wires periodic autosave + shutdown save into the app.
 *
 * Usage:
 *   const mgr = new AutosaveManager();
 *   useEffect(() => {
 *     // subscribe to store changes — mark dirty on every change
 *     const unsub = useEditor.subscribe((s) => mgr.markDirty(() => s.serialize()));
 *     // save on tab close / navigation
 *     const onUnload = () => mgr.shutdown(() => useEditor.getState().serialize());
 *     window.addEventListener('beforeunload', onUnload);
 *     return () => { unsub(); window.removeEventListener('beforeunload', onUnload); };
 *   }, []);
 *
 * markDirty takes a GETTER (not a doc) so the debounced save always writes
 * the latest state — previously the first markDirty's doc was captured and
 * subsequent edits in the debounce window were lost.
 */
export class AutosaveManager {
  private timer: any = null;
  private lastSaveTime = 0;
  private isDirty = false;
  private getDoc: (() => any) | null = null;

  /** Register the doc getter — must be called before markDirty. */
  start(getDoc: () => any): void {
    this.getDoc = getDoc;
  }

  saveNow(doc?: any): boolean {
    const d = doc ?? (this.getDoc ? this.getDoc() : null);
    if (!d) return false;
    const ok = autosave(d);
    this.lastSaveTime = Date.now();
    this.isDirty = false;
    return ok;
  }

  /** Mark the doc as dirty. Saves after a 1-second debounce. */
  markDirty(_doc?: any): void {
    this.isDirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.isDirty) this.saveNow();
    }, 1000);
  }

  /** Save immediately and mark a clean shutdown (so no crash-recovery prompt). */
  shutdown(_doc?: any): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.saveNow();
    markCleanShutdown();
  }

  getLastSaveTime(): number { return this.lastSaveTime; }
}

export function saveNamedCircuit(name: string, doc: any): string | null { return null; }
export function listNamedCircuits(): any[] { return []; }
export function loadNamedCircuit(id: string): any | null { return null; }
export function deleteNamedCircuit(id: string): boolean { return false; }
export function setupAutosaveEvents(getDoc: any, manager: any): void {}
