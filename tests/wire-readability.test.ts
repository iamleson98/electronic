// Wire readability regressions — "wires overlap each other, hard to see and
// distinguish them". Every bundled example is measured on its RENDERED wire
// geometry:
//   • no wire runs over a pin of another net (reads as a connection),
//   • no two nets share a stretch of wire (1:1 overlap),
//   • no wire of one net ends on / T-touches another net's wire,
//   • (almost) no wire runs through a component body,
// plus junction dots, Tidy wires, and zoom-to-fit.
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/lib/circuit/components';
import { exampleCategories } from '../src/lib/circuit/examples';
import { getPlugin } from '../src/lib/circuit/registry';
import { wireGridPath } from '../src/lib/circuit/wire-overlap';
import { terminalPos, transformBodyPoint } from '../src/lib/circuit/endpoint-position';
import { buildNodeMap } from '../src/lib/circuit/engine';
import { computeJunctionPoints } from '../src/lib/circuit/wire-junctions';
import { useEditor } from '../src/lib/circuit/store';
import { computeFitView } from '../src/components/circuit/fit-view';
import { CELL_SIZE } from '../src/components/circuit/canvas-types';
import type { CircuitDocument, ComponentPlugin, Vec2 } from '../src/lib/circuit/types';

interface Seg { w: number; net: number | undefined; a: Vec2; b: Vec2; ends: Set<string> }
const horiz = (s: Seg) => s.a.y === s.b.y;
const lo = (s: Seg) => (horiz(s) ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y));
const hi = (s: Seg) => (horiz(s) ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y));
const fixed = (s: Seg) => (horiz(s) ? s.a.y : s.a.x);

function metrics(doc: CircuitDocument) {
  const comps = doc.components, wires = doc.wires, sheets = doc.sheets ?? [];
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of comps) { const p = getPlugin(c.type); if (p) plugins.set(c.type, p); }
  const nm = buildNodeMap(comps, wires, plugins);
  const segs: Seg[] = [];
  wires.forEach((w, i) => {
    const p = wireGridPath(w, comps, sheets);
    if (!p) return;
    const net = nm.terminalNode.get(`${w.from.componentId}:${w.from.terminalId}`);
    const ends = new Set([`${p[0].x},${p[0].y}`, `${p[p.length - 1].x},${p[p.length - 1].y}`]);
    for (let k = 1; k < p.length; k++) {
      if (p[k].x !== p[k - 1].x || p[k].y !== p[k - 1].y) segs.push({ w: i, net, a: p[k - 1], b: p[k], ends });
    }
  });
  const pins: { p: Vec2; net: number | undefined }[] = [];
  const bodies: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const c of comps) {
    const pl = plugins.get(c.type);
    if (!pl) continue;
    const bb = pl.boundingBox;
    const q = [transformBodyPoint(c, { x: 0, y: 0 }, bb), transformBodyPoint(c, { x: bb.width, y: bb.height }, bb)];
    bodies.push({
      x0: c.position.x + Math.min(q[0].x, q[1].x) + 0.5, x1: c.position.x + Math.max(q[0].x, q[1].x) - 0.5,
      y0: c.position.y + Math.min(q[0].y, q[1].y) + 0.5, y1: c.position.y + Math.max(q[0].y, q[1].y) - 0.5,
    });
    for (const t of pl.terminals) pins.push({ p: terminalPos(c, t, pl), net: nm.terminalNode.get(`${c.id}:${t.id}`) });
  }
  let foreignPins = 0, diffOverlap = 0, diffTouch = 0, bodyLen = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (const t of pins) {
      if (t.net === s.net || s.ends.has(`${t.p.x},${t.p.y}`)) continue;
      const on = horiz(s) ? t.p.y === s.a.y && t.p.x >= lo(s) && t.p.x <= hi(s) : t.p.x === s.a.x && t.p.y >= lo(s) && t.p.y <= hi(s);
      if (on) foreignPins++;
    }
    for (const b of bodies) {
      if (b.x1 <= b.x0 || b.y1 <= b.y0) continue;
      if (horiz(s)) { if (s.a.y > b.y0 && s.a.y < b.y1) bodyLen += Math.max(0, Math.min(hi(s), b.x1) - Math.max(lo(s), b.x0)); }
      else if (s.a.x > b.x0 && s.a.x < b.x1) bodyLen += Math.max(0, Math.min(hi(s), b.y1) - Math.max(lo(s), b.y0));
    }
    for (let j = i + 1; j < segs.length; j++) {
      const r = segs[j];
      if (r.w === s.w || r.net === s.net) continue;
      if (horiz(s) === horiz(r)) {
        if (fixed(s) === fixed(r) && Math.min(hi(s), hi(r)) - Math.max(lo(s), lo(r)) > 0.5) diffOverlap++;
      } else {
        const h = horiz(s) ? s : r, v = horiz(s) ? r : s;
        const endOn = (e: Seg, o: Seg) => [e.a, e.b].some((p) => (horiz(o)
          ? p.y === o.a.y && p.x > lo(o) && p.x < hi(o)
          : p.x === o.a.x && p.y > lo(o) && p.y < hi(o)));
        if (endOn(h, v) || endOn(v, h)) diffTouch++;
      }
    }
  }
  return { foreignPins, diffOverlap, diffTouch, bodyLen };
}

const all = exampleCategories.flatMap((c) => c.examples);

describe('every bundled example draws readable wires', () => {
  it('no foreign-pin passes, no different-net overlaps or T-touches, (nearly) no body crossings', () => {
    let body = 0;
    for (const e of all) {
      const m = metrics(e.doc);
      expect(m.foreignPins, e.name).toBe(0);
      expect(m.diffOverlap, e.name).toBe(0);
      expect(m.diffTouch, e.name).toBe(0);
      body += m.bodyLen;
    }
    // the whole library: was 739 cells of wire through part bodies
    expect(body).toBeLessThanOrEqual(12);
  });

  it('the amplifier grounds each part locally and stays readable', () => {
    const amp = all.find((e) => e.name === 'Two-Stage Audio Amplifier')!.doc;
    expect(amp.components.filter((c) => c.type === 'ground').length).toBeGreaterThan(5);
    expect(metrics(amp).foreignPins).toBe(0);
  });
});

describe('example layouts', () => {
  it('no two pins of different nets share a grid point (they would draw as connected)', () => {
    for (const e of all) {
      const comps = e.doc.components;
      const plugins = new Map<string, ComponentPlugin>();
      for (const c of comps) { const p = getPlugin(c.type); if (p) plugins.set(c.type, p); }
      const nm = buildNodeMap(comps, e.doc.wires, plugins);
      const at = new Map<string, Set<number | undefined>>();
      for (const c of comps) {
        const pl = plugins.get(c.type);
        if (!pl) continue;
        for (const t of pl.terminals) {
          const p = terminalPos(c, t, pl);
          const k = `${p.x},${p.y}`;
          const nets = at.get(k) ?? new Set();
          nets.add(nm.terminalNode.get(`${c.id}:${t.id}`));
          at.set(k, nets);
        }
      }
      const clashes = [...at].filter(([, n]) => n.size > 1).map(([k]) => k);
      expect(clashes, e.name).toEqual([]);
    }
  });
});

describe('junction dots', () => {
  it('mark only same-net meetings of three or more directions', () => {
    for (const e of all) {
      const comps = e.doc.components, wires = e.doc.wires;
      const plugins = new Map<string, ComponentPlugin>();
      for (const c of comps) { const p = getPlugin(c.type); if (p) plugins.set(c.type, p); }
      const nm = buildNodeMap(comps, wires, plugins);
      // every dot lies on at least one wire, and all wires through it share a net
      for (const d of computeJunctionPoints(comps, wires, e.doc.sheets ?? [])) {
        const nets = new Set<number | undefined>();
        for (const w of wires) {
          const p = wireGridPath(w, comps, e.doc.sheets ?? []);
          if (!p) continue;
          for (let k = 1; k < p.length; k++) {
            const a = p[k - 1], b = p[k];
            const on = a.y === b.y ? d.y === a.y && d.x >= Math.min(a.x, b.x) && d.x <= Math.max(a.x, b.x)
                                   : d.x === a.x && d.y >= Math.min(a.y, b.y) && d.y <= Math.max(a.y, b.y);
            if (on) nets.add(nm.terminalNode.get(`${w.from.componentId}:${w.from.terminalId}`));
          }
        }
        expect(nets.size, `${e.name} dot @${d.x},${d.y}`).toBe(1);
      }
    }
  });
});

describe('Tidy wires', () => {
  beforeEach(() => useEditor.getState().loadDocument({ version: 1, components: [], wires: [] }));

  it('re-routes every wire readably, undoably, without touching connectivity', () => {
    const amp = all.find((e) => e.name === 'Two-Stage Audio Amplifier')!.doc;
    const st = () => useEditor.getState();
    // start from straight-line (waypoint-free) wiring
    st().loadDocument({ ...amp, wires: amp.wires.map((w) => ({ id: w.id, from: w.from, to: w.to })) });
    const ends = st().wires.map((w) => `${w.from.componentId}:${w.from.terminalId}-${w.to.componentId}:${w.to.terminalId}`);
    st().tidyWires();
    expect(st().wires.map((w) => `${w.from.componentId}:${w.from.terminalId}-${w.to.componentId}:${w.to.terminalId}`)).toEqual(ends);
    const m = metrics({ ...amp, components: st().components, wires: st().wires });
    expect(m.foreignPins).toBe(0);
    expect(m.diffOverlap).toBe(0);
    st().undo();
    expect(st().wires.every((w) => !w.waypoints || w.waypoints.length === 0)).toBe(true);
  });
});

describe('zoom to fit', () => {
  it('centers the whole circuit in the canvas using the real 18 px cell', () => {
    const amp = all.find((e) => e.name === 'Two-Stage Audio Amplifier')!.doc;
    const W = 1000, H = 600;
    const { zoom, pan } = computeFitView(amp.components, amp.wires, amp.sheets ?? [], W, H);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of amp.components) {
      const pl = getPlugin(c.type)!;
      minX = Math.min(minX, c.position.x); maxX = Math.max(maxX, c.position.x + pl.boundingBox.width);
      minY = Math.min(minY, c.position.y); maxY = Math.max(maxY, c.position.y + pl.boundingBox.height);
    }
    const sx = (gx: number) => gx * CELL_SIZE * zoom + pan.x;
    const sy = (gy: number) => gy * CELL_SIZE * zoom + pan.y;
    // everything on screen…
    expect(sx(minX)).toBeGreaterThanOrEqual(0);
    expect(sx(maxX)).toBeLessThanOrEqual(W);
    expect(sy(minY)).toBeGreaterThanOrEqual(0);
    expect(sy(maxY)).toBeLessThanOrEqual(H);
    // …centered, and actually filling one axis (not the old 40 px/cell zoom-out)
    expect(Math.abs((sx(minX) + sx(maxX)) / 2 - W / 2)).toBeLessThan(W * 0.05);
    expect(Math.max((sx(maxX) - sx(minX)) / W, (sy(maxY) - sy(minY)) / H)).toBeGreaterThan(0.8);
  });

  it('an empty canvas keeps a neutral view', () => {
    expect(computeFitView([], [], [], 800, 600)).toEqual({ zoom: 1, pan: { x: 0, y: 0 } });
  });
});
