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
export class AutosaveManager {
  private timer: any = null; private lastSaveTime = 0; private isDirty = false;
  saveNow(doc: any): boolean { const ok = autosave(doc); this.lastSaveTime = Date.now(); this.isDirty = false; return ok; }
  markDirty(doc: any): void { this.isDirty = true; if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; if (this.isDirty) this.saveNow(doc); }, 1000); }
  shutdown(doc: any): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.saveNow(doc); markCleanShutdown(); }
  getLastSaveTime(): number { return this.lastSaveTime; }
  startPeriodic(fn: any): void {}
  stopPeriodic(): void {}
}
export function saveNamedCircuit(name: string, doc: any): string | null { return null; }
export function listNamedCircuits(): any[] { return []; }
export function loadNamedCircuit(id: string): any | null { return null; }
export function deleteNamedCircuit(id: string): boolean { return false; }
export function setupAutosaveEvents(getDoc: any, manager: any): void {}
