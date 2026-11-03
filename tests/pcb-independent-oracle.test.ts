// PCB pipeline — independent geometric oracle.
//
// Example circuits and deterministic randomized circuits go schematic →
// footprints → placement → autoroute; the copper is then checked with a
// geometry model written independently of the router and the DRC
// (capsule traces, circle / stadium / rectangle pads, through-hole pads and
// vias on every layer):
//   - shorts: no copper island joins pads of two different nets
//   - clearance: different-net copper keeps DRC minClearance on each layer
//   - opens: every net the router leaves open is a DRC ERROR (a board with
//     open nets used to pass DRC with only a warning)
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { exampleCategories } from '../src/lib/circuit/examples';
import { getPlugin } from '../src/lib/circuit/registry';
import { createPCBFromSchematic } from '../src/lib/pcb/netlist-sync';
import { autoRoute, DEFAULT_AUTOROUTE_OPTIONS } from '../src/lib/pcb/auto-router';
import { runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import type { Footprint, Trace, Via } from '../src/lib/pcb/types';

type P = { x: number; y: number };
type Shape = { kind: 'cap'; a: P; b: P; r: number } | { kind: 'rect'; c: P; hw: number; hh: number };
interface Obj { id: string; net: string; layers: Set<string>; shape: Shape; pad?: string }

const sub = (a: P, b: P) => ({ x: a.x - b.x, y: a.y - b.y });
function ptSeg(p: P, a: P, b: P): number {
  const ab = sub(b, a); const ap = sub(p, a);
  const L = ab.x * ab.x + ab.y * ab.y;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / L));
  return Math.hypot(a.x + t * ab.x - p.x, a.y + t * ab.y - p.y);
}
function segsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function segSeg(a: P, b: P, c: P, d: P): number {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}
function ptRect(p: P, c: P, hw: number, hh: number): number {
  const dx = Math.max(Math.abs(p.x - c.x) - hw, 0); const dy = Math.max(Math.abs(p.y - c.y) - hh, 0);
  return Math.hypot(dx, dy);
}
function segRect(a: P, b: P, c: P, hw: number, hh: number): number {
  const corners = [{ x: c.x - hw, y: c.y - hh }, { x: c.x + hw, y: c.y - hh }, { x: c.x + hw, y: c.y + hh }, { x: c.x - hw, y: c.y + hh }];
  const inside = (p: P) => Math.abs(p.x - c.x) <= hw && Math.abs(p.y - c.y) <= hh;
  if (inside(a) || inside(b)) return 0;
  let d = Math.min(ptRect(a, c, hw, hh), ptRect(b, c, hw, hh));
  for (let i = 0; i < 4; i++) d = Math.min(d, segSeg(a, b, corners[i], corners[(i + 1) % 4]));
  return d;
}
function dist(s: Shape, t: Shape): number {
  if (s.kind === 'cap' && t.kind === 'cap') return segSeg(s.a, s.b, t.a, t.b) - s.r - t.r;
  if (s.kind === 'cap' && t.kind === 'rect') return segRect(s.a, s.b, t.c, t.hw, t.hh) - s.r;
  if (s.kind === 'rect' && t.kind === 'cap') return dist(t, s);
  const r1 = s as any, r2 = t as any;
  const dx = Math.max(Math.abs(r1.c.x - r2.c.x) - r1.hw - r2.hw, 0);
  const dy = Math.max(Math.abs(r1.c.y - r2.c.y) - r1.hh - r2.hh, 0);
  return Math.hypot(dx, dy);
}

function copper(footprints: Footprint[], traces: Trace[], vias: Via[]): Obj[] {
  const used = new Set<string>(['top', 'bottom']);
  for (const t of traces) used.add(t.layer);
  const objs: Obj[] = [];
  for (const fp of footprints) for (const pad of fp.pads) {
    const layers = (pad.drill ?? 0) > 0 ? new Set(used) : new Set([pad.layer]);
    const { width: w, height: h } = pad.size;
    const c = pad.position;
    let shape: Shape;
    if (pad.shape === 'circle') shape = { kind: 'cap', a: c, b: c, r: Math.max(w, h) / 2 };
    else if (pad.shape === 'oval') {
      const r = Math.min(w, h) / 2; const half = Math.abs(w - h) / 2;
      shape = w >= h ? { kind: 'cap', a: { x: c.x - half, y: c.y }, b: { x: c.x + half, y: c.y }, r } : { kind: 'cap', a: { x: c.x, y: c.y - half }, b: { x: c.x, y: c.y + half }, r };
    } else shape = { kind: 'rect', c, hw: w / 2, hh: h / 2 };
    objs.push({ id: pad.id, net: pad.net ?? '', layers, shape, pad: `${pad.componentId}:${pad.terminalId}` });
  }
  for (const t of traces) t.segments.forEach((s, i) => objs.push({ id: `${t.id}#${i}`, net: t.net, layers: new Set([t.layer]), shape: { kind: 'cap', a: s.start, b: s.end, r: (s.width || t.width) / 2 } }));
  for (const v of vias) objs.push({ id: v.id, net: v.net, layers: new Set(used), shape: { kind: 'cap', a: v.position, b: v.position, r: v.diameter / 2 } });
  return objs;
}

function oracle(footprints: Footprint[], traces: Trace[], vias: Via[], clearance: number) {
  const objs = copper(footprints, traces, vias);
  const parent = objs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const share = (a: Obj, b: Obj) => { for (const l of a.layers) if (b.layers.has(l)) return true; return false; };
  const viol: string[] = [];
  for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) {
    const a = objs[i], b = objs[j];
    if (!share(a, b)) continue;
    const d = dist(a.shape, b.shape);
    if (d <= 1e-6) parent[find(i)] = find(j);
    else if (a.net !== b.net && a.net && b.net && d < clearance - 1e-4) viol.push(`${a.net}/${b.net} ${d.toFixed(3)}mm (${a.id}~${b.id})`);
  }
  // opens: pads of a net in >1 copper island
  const islandsByNet = new Map<string, Set<number>>();
  const netsByIsland = new Map<number, Set<string>>();
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (!o.pad || !o.net) continue;
    const r = find(i);
    (islandsByNet.get(o.net) ?? islandsByNet.set(o.net, new Set()).get(o.net)!).add(r);
    (netsByIsland.get(r) ?? netsByIsland.set(r, new Set()).get(r)!).add(o.net);
  }
  const opens = [...islandsByNet].filter(([, s]) => s.size > 1).map(([n, s]) => `${n}(${s.size} islands)`);
  const shorts = [...netsByIsland.values()].filter((s) => s.size > 1).map((s) => [...s].join('+'));
  return { opens, shorts, clearance: viol };
}


function routeAndCheck(components: any[], wires: any[]) {
  const { footprints, ratsnest, board } = createPCBFromSchematic(components, wires);
  const r = autoRoute(footprints, [], [], ratsnest, board, { ...DEFAULT_AUTOROUTE_OPTIONS, clearance: DEFAULT_DRC_CONFIG.minClearance });
  const drc = runDRC(footprints, r.traces, r.vias, ratsnest, board, DEFAULT_DRC_CONFIG);
  return { r, drc, o: oracle(footprints, r.traces, r.vias, DEFAULT_DRC_CONFIG.minClearance) };
}

describe('PCB: every example circuit yields a manufacturable board', () => {
  for (const cat of exampleCategories) for (const ex of cat.examples) {
    it(ex.name, () => {
      const doc = structuredClone(ex.doc) as any;
      const { r, drc, o } = routeAndCheck(doc.components, doc.wires);
      expect(r.unrouted).toEqual([]);
      expect(o.opens).toEqual([]);
      expect(o.shorts).toEqual([]);
      expect(o.clearance).toEqual([]);
      expect(drc.filter((e) => e.severity === 'error')).toEqual([]);
    }, 30_000);
  }
});

describe('PCB: randomized circuits', () => {
  it('never short or violate clearance, and every open net is a DRC error', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const kinds = ['resistor', 'capacitor', 'diode', 'led', 'npn', 'lm358', 'timer555', 'ic7408'];
    for (let trial = 0; trial < 10; trial++) {
      const n = 5 + Math.floor(rnd() * 22);
      const comps: any[] = [];
      const wires: any[] = [];
      const all: string[] = [];
      for (let i = 0; i < n; i++) {
        const type = pick(kinds);
        comps.push({ id: `U${i}`, type, position: { x: Math.floor(rnd() * 60), y: Math.floor(rnd() * 40) }, rotation: pick([0, 90, 180, 270]), parameters: {} });
        for (const t of getPlugin(type)!.terminals) all.push(`U${i}:${t.id}`);
      }
      let wid = 0;
      const join = (a: string, b: string) => {
        const [ac, at] = a.split(':');
        const [bc, bt] = b.split(':');
        wires.push({ id: `w${wid++}`, from: { componentId: ac, terminalId: at }, to: { componentId: bc, terminalId: bt } });
      };
      const pool = [...all].sort(() => rnd() - 0.5);
      const gnd = pool.splice(0, Math.max(2, Math.floor(all.length * 0.15)));
      const vcc = pool.splice(0, Math.max(2, Math.floor(all.length * 0.1)));
      for (const net of [gnd, vcc]) for (let i = 1; i < net.length; i++) join(net[0], net[i]);
      while (pool.length > 3) {
        if (rnd() < 0.15) { pool.pop(); continue; }
        const net = pool.splice(0, 2 + Math.floor(rnd() * 3));
        for (let i = 1; i < net.length; i++) join(net[i - 1], net[i]);
      }
      const { drc, o } = routeAndCheck(comps, wires);
      expect(o.shorts, `trial ${trial}`).toEqual([]);
      expect(o.clearance, `trial ${trial}`).toEqual([]);
      const openNets = new Set(o.opens.map((s) => s.slice(0, s.indexOf('('))));
      const drcOpen = new Set(drc.filter((e) => e.type === 'unrouted' && e.severity === 'error').map((e) => /Net "([^"]+)"/.exec(e.message)?.[1]));
      for (const net of openNets) expect(drcOpen.has(net), `trial ${trial}: open net ${net} not a DRC error`).toBe(true);
    }
  }, 120_000);
});
