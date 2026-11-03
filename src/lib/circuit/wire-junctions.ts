// Junction dots from the RENDERED wire geometry.
//
// A dot means "these wires connect here". It belongs wherever same-net
// copper meets in three or more directions — a branch tapping the middle of
// a trunk, the point where stacked same-net wires split, or a pin with two or
// more wires. (Dots used to be drawn only where ≥3 wire ENDPOINTS shared a
// pin, so a branch leaving the middle of a same-net run had no dot and read
// as a crossing.)

import type { CircuitComponent, HierarchicalSheet, Vec2, Wire } from './types';
import { getPlugin } from './registry';
import { buildNodeMap } from './engine';
import { terminalPos } from './endpoint-position';
import { wireGridPath } from './wire-overlap';

const key = (p: Vec2) => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;

let cache: { wires: Wire[]; components: CircuitComponent[]; out: Vec2[] } | null = null;

/** Grid points that get a junction dot (memoized on document identity). */
export function computeJunctionPoints(components: CircuitComponent[], wires: Wire[], sheets: HierarchicalSheet[] = []): Vec2[] {
  if (cache && cache.wires === wires && cache.components === components) return cache.out;
  const plugins = new Map<string, NonNullable<ReturnType<typeof getPlugin>>>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const nm = buildNodeMap(components, wires, plugins);
  // per net: point → set of directions copper leaves in (bitmask R,L,D,U)
  const dirs = new Map<string, Map<string, { p: Vec2; mask: number }>>();
  const mark = (net: string, p: Vec2, bit: number) => {
    let m = dirs.get(net);
    if (!m) dirs.set(net, (m = new Map()));
    const k = key(p);
    const e = m.get(k);
    if (e) e.mask |= bit; else m.set(k, { p, mask: bit });
  };
  for (const w of wires) {
    const net = String(nm.terminalNode.get(`${w.from.componentId}:${w.from.terminalId}`));
    const path = wireGridPath(w, components, sheets);
    if (!path) continue;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if (a.x === b.x && a.y === b.y) continue;
      if (a.y === b.y) {
        const [lo, hi] = a.x < b.x ? [a, b] : [b, a];
        mark(net, lo, 1); mark(net, hi, 2);
        // interior lattice points of the run carry copper both ways
        for (let x = lo.x + 0.5; x < hi.x - 1e-9; x += 0.5) mark(net, { x, y: a.y }, 3);
      } else if (a.x === b.x) {
        const [lo, hi] = a.y < b.y ? [a, b] : [b, a];
        mark(net, lo, 4); mark(net, hi, 8);
        for (let y = lo.y + 0.5; y < hi.y - 1e-9; y += 0.5) mark(net, { x: a.x, y }, 12);
      }
    }
  }
  // a pin counts as one more connection — for ITS OWN net only (a wire
  // passing over another net's pin must not get a dot claiming a joint)
  const pins = new Set<string>();
  for (const c of components) {
    const pl = plugins.get(c.type);
    if (!pl) continue;
    for (const t of pl.terminals) pins.add(`${nm.terminalNode.get(`${c.id}:${t.id}`)}|${key(terminalPos(c, t, pl))}`);
  }
  const out: Vec2[] = [];
  for (const [net, m] of dirs) {
    for (const [k, { p, mask }] of m) {
      const n = (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1) + (pins.has(`${net}|${k}`) ? 1 : 0);
      if (n >= 3) out.push(p);
    }
  }
  cache = { wires, components, out };
  return out;
}
