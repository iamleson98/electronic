// Keys built from NODE ids (npn_1_2_3, 7seg_..., gate_...) cannot be
// attributed to a component here and are left alone.

// State-key prefixes that embed a component id: `prefix_${id}` with an
// optional trailing suffix (_i, _dir, _ib, ...).
const COMP_ID_STATE_PREFIXES = ['cap', 'ind', 'vcsw', 'xfmr_branch', 'ff'];

/**
 * Remove __global sim-state entries that reference deleted components.
 *
 * A key is garbage when it embeds a component id that is no longer present:
 *   - via a known state prefix (`cap_<id>`, `ind_<id>_i`, `vcsw_<id>`, ...),
 *     which works for ids of ANY format (C1, R1, comp_...), or
 *   - via the genId pattern `prefix_<base36-ts>_<counter>` embedded anywhere
 *     (`other_<id>`, ...).
 *
 * The old substring match (`key.includes('_' + id)`) also wiped keys of
 * OTHER components whose ids shared a prefix — deleting `comp_x_5`
 * destroyed `cap_comp_x_51`'s state. Full-id matching makes that collision
 * impossible. Legacy node-pair keys (`cap_3_7`) are preserved.
 */
export function cleanupComponentState(sim: any, components: any[]): number {
  if (!sim || !sim.state || !sim.state.__global) return 0;
  const globalState = sim.state.__global;
  const validIds = new Set(components.map(c => c.id));
  // genId pattern: prefix_base36timestamp_counter (timestamp >= 6 chars)
  const idPattern = /(?:^|_)([a-z][a-z0-9]*_[a-z0-9]{6,}_\d+)(?=_|$)/gi;
  let removed = 0; const keysToDelete: string[] = [];
  outer:
  for (const key of Object.keys(globalState)) {
    // (a) known state prefix + arbitrary-format id
    for (const prefix of COMP_ID_STATE_PREFIXES) {
      if (!key.startsWith(`${prefix}_`)) continue;
      const m = key.slice(prefix.length + 1).match(/^(.+?)(?:_i|_dir|_ib|_clk|_vgs|_vds|_vbs|_vbe|_vce|_a|_b|_branch)?$/);
      if (m) {
        const id = m[1];
        // pure-numeric ids are legacy node-pair keys — keep them
        if (!/^\d+(_\d+)*$/.test(id) && !validIds.has(id)) {
          keysToDelete.push(key); removed++;
          continue outer;
        }
      }
    }
    // (b) genId-pattern id embedded anywhere in the key
    idPattern.lastIndex = 0;
    let m2: RegExpExecArray | null;
    while ((m2 = idPattern.exec(key)) !== null) {
      if (!validIds.has(m2[1])) {
        keysToDelete.push(key); removed++;
        break;
      }
    }
  }
  for (const key of keysToDelete) delete globalState[key];
  return removed;
}
export function compactTraces(traces: any[], maxSamples: number): number { let removed = 0; for (const t of traces) { if (t.samples.length > maxSamples) { const excess = t.samples.length - maxSamples; t.samples = t.samples.slice(-maxSamples); removed += excess; } } return removed; }
export function getMemoryStats(sim?: any, traces?: any[], components?: any[], wires?: any[]): any { const s: any = {}; if (typeof performance !== 'undefined' && (performance as any).memory) { s.usedJSHeapSize = (performance as any).memory.usedJSHeapSize; } if (typeof process !== 'undefined' && process.memoryUsage) { s.usedJSHeapSize = process.memoryUsage().heapUsed; } if (sim?.state?.__global) s.stateEntryCount = Object.keys(sim.state.__global).length; if (traces) s.totalTraceSamples = traces.reduce((sum: number, t: any) => sum + t.samples.length, 0); if (components) s.componentCount = components.length; if (wires) s.wireCount = wires.length; return s; }
export class MemoryMonitor { private snapshots: any[] = []; snapshot(sim?: any, traces?: any[], components?: any[], wires?: any[]) { const s = { timestamp: Date.now(), stats: getMemoryStats(sim, traces, components, wires) }; this.snapshots.push(s); if (this.snapshots.length > 100) this.snapshots.shift(); return s; } getSnapshots() { return [...this.snapshots]; } detectGrowth() { if (this.snapshots.length < 2) return 0; return (this.snapshots[this.snapshots.length-1].stats.usedJSHeapSize ?? 0) - (this.snapshots[0].stats.usedJSHeapSize ?? 0); } detectLeak(threshold: number = 10485760) { return this.detectGrowth() > threshold; } getSummary() { if (this.snapshots.length < 2) return { duration: 0, heapGrowth: 0, stateEntryGrowth: 0, traceSampleGrowth: 0, componentGrowth: 0, wireGrowth: 0, snapshots: this.snapshots.length }; const f = this.snapshots[0], l = this.snapshots[this.snapshots.length-1]; return { duration: l.timestamp - f.timestamp, heapGrowth: (l.stats.usedJSHeapSize ?? 0) - (f.stats.usedJSHeapSize ?? 0), stateEntryGrowth: (l.stats.stateEntryCount ?? 0) - (f.stats.stateEntryCount ?? 0), traceSampleGrowth: (l.stats.totalTraceSamples ?? 0) - (f.stats.totalTraceSamples ?? 0), componentGrowth: (l.stats.componentCount ?? 0) - (f.stats.componentCount ?? 0), wireGrowth: (l.stats.wireCount ?? 0) - (f.stats.wireCount ?? 0), snapshots: this.snapshots.length }; } reset() { this.snapshots = []; } }
export function suggestGC(): void { if (typeof globalThis !== 'undefined' && (globalThis as any).gc) (globalThis as any).gc(); }
export function resetComponentSimState(components: any[]): void { for (const c of components) c.simState = {}; }
