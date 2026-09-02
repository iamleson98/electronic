// Wire crossing marks (hop arcs) — rendering-time detection of where wires
// geometrically cross WITHOUT being electrically connected.
//
// Why: in this engine two wires only connect when they share a terminal
// (engine.ts union-finds wire endpoints), and a junction dot is drawn where
// ≥3 wire endpoints coincide (schematic-overlays.ts). A mid-path crossing,
// however, rendered as two plain strokes on top of each other — visually
// indistinguishable from a connection. That ambiguity is the core of the
// "wires overlap and I can't reason about them" complaint.
//
// This module computes, per wire, the grid cells where it crosses another
// wire's path. The renderer draws a small "hop" arc at those cells on the
// wire that is LATER in draw order (the one visually on top), following the
// classic schematic convention: a hop = NOT connected, a dot = connected.
//
// Pure functions + a tiny ref-keyed memo so the 60fps render loop only
// recomputes when the document actually changes (pan/zoom/hover frames hit
// the cache).

import type { CircuitComponent, ComponentPlugin, Vec2, Wire, HierarchicalSheet } from './types';
import { expandPathToCells, getWireGridPath } from './smart-wire-router';
import { resolveEndpointGridPos } from './endpoint-position';

/** Per-wire list of grid cells where a hop arc should be drawn. */
export type WireCrossingMarks = Map<string, Vec2[]>;

interface CrossingCache {
  wires: Wire[] | null;
  components: CircuitComponent[] | null;
  marks: WireCrossingMarks;
}

const cache: CrossingCache = { wires: null, components: null, marks: new Map() };

/**
 * Compute hop-arc marks for every wire in the document.
 *
 * Rules (per shared cell between the rasterized paths of two wires):
 *  - the LATER wire in array order (drawn on top) carries the hop;
 *  - cells where either wire has an ENDPOINT are skipped (endpoint contact
 *    is signaled by the pin dot / junction dot, not a hop);
 *  - cells where ≥3 wire endpoints coincide are skipped (junction dots);
 *  - cells occupied by any component terminal are skipped (pin dots);
 *  - runs of consecutive shared cells (parallel overlap) collapse to one
 *    mark at the middle of the run.
 */
export function computeWireCrossingMarks(
  wires: Wire[],
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
  sheets: HierarchicalSheet[] = [],
): WireCrossingMarks {
  if (cache.wires === wires && cache.components === components) {
    return cache.marks;
  }

  const marks: WireCrossingMarks = new Map();
  if (wires.length < 2) {
    cache.wires = wires;
    cache.components = components;
    cache.marks = marks;
    return marks;
  }

  // Terminal cells (pin dots live there — hops at pins would be noise).
  const terminalCells = new Set<string>();
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const term of plugin.terminals) {
      const pos = resolveEndpointGridPos({ componentId: comp.id, terminalId: term.id }, components, sheets);
      if (pos) terminalCells.add(`${Math.round(pos.x)},${Math.round(pos.y)}`);
    }
  }

  // Wire endpoint cells (≥3 coinciding = junction dot; 2 = plain meeting at
  // a shared terminal — the pin dot covers both, so skip all endpoint cells).
  // Guards: wires with malformed endpoints (bad API calls, foreign JSON
  // imports) must not crash the render loop — they're simply ignored here,
  // exactly like the renderer's own resolveEndpointPos null-skip.
  const endpointCells = new Set<string>();
  for (const wire of wires) {
    for (const end of [wire.from, wire.to]) {
      if (!end || typeof end.componentId !== 'string' || typeof end.terminalId !== 'string') continue;
      const pos = resolveEndpointGridPos(end, components, sheets);
      if (pos) endpointCells.add(`${Math.round(pos.x)},${Math.round(pos.y)}`);
    }
  }

  // Per-wire rasterized cell sets.
  const cellSets = wires.map((w) => {
    const set = new Set<string>();
    for (const c of expandPathToCells(getWireGridPath(w, components, plugins))) {
      set.add(`${c.x},${c.y}`);
    }
    return set;
  });
  const cellLists = wires.map((w) => expandPathToCells(getWireGridPath(w, components, plugins)));

  for (let j = 1; j < wires.length; j++) {
    for (let i = 0; i < j; i++) {
      const shared: Vec2[] = [];
      for (const cell of cellLists[j]) {
        const key = `${cell.x},${cell.y}`;
        if (!cellSets[i].has(key)) continue;
        if (endpointCells.has(key) || terminalCells.has(key)) continue;
        shared.push(cell);
      }
      if (shared.length === 0) continue;
      // Collapse consecutive runs to the middle cell.
      const collapsed: Vec2[] = [];
      let run: Vec2[] = [];
      let prevKey = '';
      const flush = () => {
        if (run.length === 0) return;
        collapsed.push(run[Math.floor(run.length / 2)]);
        run = [];
      };
      for (const cell of shared) {
        const [x, y] = [cell.x, cell.y];
        const key = `${x},${y}`;
        // Consecutive = adjacent along either axis (orthogonal paths).
        const [px, py] = prevKey ? prevKey.split(',').map(Number) : [NaN, NaN];
        const adjacent = prevKey !== '' && (Math.abs(x - px) + Math.abs(y - py) === 1);
        if (!adjacent) flush();
        run.push(cell);
        prevKey = key;
      }
      flush();
      const existing = marks.get(wires[j].id) ?? [];
      marks.set(wires[j].id, [...existing, ...collapsed]);
    }
  }

  cache.wires = wires;
  cache.components = components;
  cache.marks = marks;
  return marks;
}
