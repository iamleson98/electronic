// PCB correctness audit fixes: preflight severity, via-in-pad, flip/rotate
// mirror, edge/courtyard/mask DRC geometry, copper pour clearance.
import { describe, it, expect, beforeEach } from 'vitest';
import { runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import { fabPreflight } from '../src/lib/pcb/fab-preflight';
import { autoRoute } from '../src/lib/pcb/auto-router';
import { createPCBFromSchematic } from '../src/lib/pcb/netlist-sync';
import { generateCopperPour } from '../src/lib/pcb/copper-pour';
import { usePCB } from '../src/lib/pcb/store';
import { exampleCategories } from '../src/lib/circuit/examples';
import type { Footprint, Pad, Trace, Via } from '../src/lib/pcb/types';
import '../src/lib/circuit/components';

const examples = exampleCategories.flatMap((c) => c.examples);
function board555() {
  const ex = examples.find((e) => e.name === '555 Astable Blink')!;
  return createPCBFromSchematic(ex.doc.components, ex.doc.wires);
}

function pad(id: string, x: number, y: number, net: string, o: { w?: number; h?: number; drill?: number; shape?: Pad['shape'] } = {}): Pad {
  return {
    id, componentId: id, terminalId: 'a', position: { x, y }, shape: o.shape ?? (o.drill ? 'circle' : 'rect'),
    size: { width: o.w ?? 1, height: o.h ?? 1 }, layer: 'top', net, ...(o.drill ? { drill: o.drill } : {}),
  };
}
function fp(id: string, x: number, y: number, pads: Pad[], body = { width: 2, height: 2 }): Footprint {
  return { id, componentId: id, componentType: 'resistor', refdes: id, position: { x, y }, rotation: 0, bodySize: body, pads, side: 'top', verified: true };
}
const B = { width: 40, height: 30 };
const run = (fps: Footprint[], traces: Trace[] = [], vias: Via[] = []) => runDRC(fps, traces, vias, [], B, DEFAULT_DRC_CONFIG);
const preflight = (fps: Footprint[], traces: Trace[] = [], vias: Via[] = []) => fabPreflight(fps, traces, vias, [], B, DEFAULT_DRC_CONFIG);
const trace = (net: string, pts: [number, number][], width = 0.3): Trace => ({
  id: `t_${net}`, net, layer: 'top', width,
  segments: pts.slice(1).map((p, i) => ({ start: { x: pts[i][0], y: pts[i][1] }, end: { x: p[0], y: p[1] }, width })),
});

describe('1. preflight blocks manufacturing violations', () => {
  it('foreign pads 0.05mm apart are NOT ok', () => {
    const f = [fp('a', 10, 10, [pad('p1', 10, 10, 'A')]), fp('b', 20, 20, [pad('p2', 11.05, 10, 'B')])];
    expect(preflight(f).ok).toBe(false);
    expect(run(f).some((e) => e.type === 'clearance' || e.type === 'short')).toBe(true);
  });
  it('via with 0.05mm annular ring, tiny drill, overlapping drills are errors', () => {
    const v: Via[] = [{ id: 'v1', position: { x: 10, y: 10 }, diameter: 0.4, drill: 0.3, net: 'A', type: 'tht' },
      { id: 'v2', position: { x: 10.3, y: 10 }, diameter: 0.9, drill: 0.5, net: 'A', type: 'tht' }];
    const types = run([], [], v).filter((e) => e.severity === 'error').map((e) => e.type);
    expect(types).toContain('annular_ring');
    expect(types).toContain('hole_to_hole');
    expect(preflight([], [], v).ok).toBe(false);
    const small: Via[] = [{ id: 'v', position: { x: 10, y: 10 }, diameter: 0.6, drill: 0.2, net: 'A', type: 'tht' }];
    expect(run([], [], small).find((e) => e.type === 'min_drill')!.severity).toBe('error');
  });
  it('unverified footprints and unwired required pins are listed blockers', () => {
    const f = fp('u', 20, 15, [pad('1', 19, 15, 'A'), pad('2', 20, 15, 'B'), pad('3', 21, 15, 'C')]);
    f.verified = false;
    const p = fp('w', 30, 15, [{ ...pad('1', 30, 15, ''), tie: true, note: 'tie to V+' }]);
    const r = preflight([f, p]);
    expect(r.ok).toBe(false);
    expect(r.blockers.map((b) => b.type)).toEqual(expect.arrayContaining(['unverified_footprint', 'unwired_required_pin']));
    expect(r.blockers.every((b) => b.reason.length > 10)).toBe(true);
  });
  it('a clean board is ok', () => {
    expect(preflight([fp('a', 10, 10, [pad('p1', 10, 10, 'A')]), fp('b', 25, 20, [pad('p2', 25, 20, 'B')])]).ok).toBe(true);
  });
});

describe('2. router never drops a via in a pad (555 example)', () => {
  it('0 DRC errors and no via touches any pad after autoroute', () => {
    const { footprints, ratsnest, board } = board555();
    const res = autoRoute(footprints, [], [], ratsnest, board);
    expect(res.stats.failed).toBe(0);
    const errs = runDRC(footprints, res.traces, res.vias, ratsnest, board, DEFAULT_DRC_CONFIG).filter((e) => e.severity === 'error');
    expect(errs.map((e) => e.message)).toEqual([]);
    for (const v of res.vias) {
      for (const f of footprints) for (const p of f.pads) {
        const dx = Math.max(Math.abs(v.position.x - p.position.x) - p.size.width / 2, 0);
        const dy = Math.max(Math.abs(v.position.y - p.position.y) - p.size.height / 2, 0);
        const d = p.shape === 'circle'
          ? Math.max(Math.hypot(v.position.x - p.position.x, v.position.y - p.position.y) - Math.max(p.size.width, p.size.height) / 2, 0)
          : Math.hypot(dx, dy);
        expect(d, `via ${v.id} vs pad ${p.id}`).toBeGreaterThanOrEqual(v.diameter / 2 - 1e-6);
      }
    }
  });
});

describe('3. flip + rotate keep the footprint mirrored', () => {
  const get = (id: string) => usePCB.getState().footprints.find((f) => f.id === id)!;
  const pos = (id: string) => get(id).pads.map((p) => ({ n: p.number ?? p.terminalId, x: +p.position.x.toFixed(4), y: +p.position.y.toFixed(4), w: p.size.width, h: p.size.height }));
  function setup() {
    const { footprints, board } = board555();
    usePCB.getState().clearPCB();
    usePCB.setState({ footprints, board });
    return footprints.find((f) => f.pads.length === 8)!.id;
  }
  /** canonical: def -> mirror-if-bottom -> rotate -> translate */
  const expected = (orig: Footprint, rot: number, bottom: boolean) => orig.pads.map((p) => {
    const r0 = (-orig.rotation * Math.PI) / 180, r1 = (rot * Math.PI) / 180;
    const ox = p.position.x - orig.position.x, oy = p.position.y - orig.position.y;
    let dx = ox * Math.cos(r0) - oy * Math.sin(r0);
    const dy = ox * Math.sin(r0) + oy * Math.cos(r0);
    if (bottom) dx = -dx;
    return { x: +(orig.position.x + dx * Math.cos(r1) - dy * Math.sin(r1)).toFixed(4), y: +(orig.position.y + dx * Math.sin(r1) + dy * Math.cos(r1)).toFixed(4) };
  });
  beforeEach(() => usePCB.getState().clearPCB());

  it('flip->rotate and rotate->flip give identical mirrored pads, matching the canonical formula', () => {
    const id = setup();
    const orig = structuredClone(get(id));
    usePCB.getState().flipFootprint(id);
    expect(get(id).side).toBe('bottom');
    expect(get(id).pads.every((p) => p.layer === 'bottom')).toBe(true);
    // flipped pin 1 is the x-mirror of the top-side pin 1 (about the part centre)
    const p1 = orig.pads.find((p) => p.number === '1')!;
    const q1 = get(id).pads.find((p) => p.number === '1')!;
    expect(q1.position.x - orig.position.x).toBeCloseTo(-(p1.position.x - orig.position.x), 6);
    usePCB.getState().rotateFootprint(id);
    const a = pos(id);
    const exp = expected(orig, orig.rotation + 90, true);
    a.forEach((p, i) => { expect(p.x).toBeCloseTo(exp[i].x, 3); expect(p.y).toBeCloseTo(exp[i].y, 3); });

    const id2 = setup();
    usePCB.getState().rotateFootprint(id2);
    usePCB.getState().flipFootprint(id2);
    expect(pos(id2)).toEqual(a);
    expect(get(id2).side).toBe('bottom');
  });

  it('4x rotate on a bottom part is the identity; pin 2 of the bottom NE555 stays mirrored', () => {
    const id = setup();
    usePCB.getState().flipFootprint(id);
    const before = pos(id);
    for (let i = 0; i < 4; i++) usePCB.getState().rotateFootprint(id);
    expect(pos(id)).toEqual(before);
    expect(get(id).side).toBe('bottom');
    // one more quarter turn: pins are the mirrored layout rotated, never the unmirrored one
    const orig = structuredClone(get(id));
    usePCB.getState().rotateFootprint(id);
    const p2 = get(id).pads.find((p) => p.number === '2')!;
    const o2 = orig.pads.find((p) => p.number === '2')!;
    // rotating +90 maps offset (x,y) -> (-y,x) irrespective of mirroring
    expect(p2.position.x - orig.position.x).toBeCloseTo(-(o2.position.y - orig.position.y), 4);
    expect(p2.position.y - orig.position.y).toBeCloseTo(o2.position.x - orig.position.x, 4);
  });
});

describe('4. board-edge DRC uses copper extents', () => {
  it('1.0mm trace centred 0.4mm from the edge is outside the board', () => {
    const t = trace('A', [[0.4, 5], [0.4, 20]], 1.0);
    const e = run([], [t]).filter((x) => x.type === 'outside_board' && x.severity === 'error');
    expect(e.length).toBeGreaterThan(0);
  });
  it('THT pad whose copper edge is 0.2mm from the edge fails the edge-clearance rule', () => {
    const f = fp('a', 10, 10, [pad('p', 1.7, 10, 'A', { w: 3, h: 3, drill: 1 })]);
    // copper spans x 0.2..3.2
    expect(run([f]).some((x) => x.type === 'outside_board' && x.severity === 'error')).toBe(true);
    expect(preflight([f]).ok).toBe(false);
  });
  it('a pad well inside passes', () => {
    const f = fp('a', 10, 10, [pad('p', 10, 10, 'A')]);
    expect(run([f]).some((x) => x.type === 'outside_board')).toBe(false);
  });
});

describe('5. courtyard and mask-sliver use real geometry', () => {
  const dip = (id: string, x: number) => fp(id, x, 15, [pad('a', x - 4.6, 15, 'A' + id, { w: 1.6, h: 1.6 }), pad('b', x + 4.6, 15, 'B' + id, { w: 1.6, h: 1.6 })], { width: 6.35, height: 8 });
  it('DIP bodies 7mm apart (pads touching) overlap; far enough apart do not', () => {
    // body +/-3.175, pads reach +/-5.4: centres 10mm apart => pad edges overlap
    expect(run([dip('a', 10), dip('b', 20)]).some((e) => e.type === 'courtyard')).toBe(true);
    // body-only gap would be 10-6.35=3.65mm (> old 0.5 rule) yet courtyards collide: that is the fix
    expect(run([dip('a', 10), dip('b', 22)]).some((e) => e.type === 'courtyard')).toBe(false);
  });
  it('mask web between rect pads uses rect geometry (0.15mm gap, 0.05 expansion each => 0.05 web < 0.1)', () => {
    const f = fp('a', 10, 10, [pad('1', 10, 10, 'A', { w: 2, h: 0.6 }), pad('2', 10, 10.75, 'B', { w: 2, h: 0.6 })]);
    // gap = 0.15mm; clearance 0.2 would flag too, so use a lax-clearance config
    const e = runDRC([f], [], [], [], B, { ...DEFAULT_DRC_CONFIG, minClearance: 0.1 });
    expect(e.some((x) => x.message.includes('Soldermask web'))).toBe(true);
  });
});

describe('6. copper pour clearance, edge inset, spokes, islands', () => {
  function gapToRect(cell: { x: number; y: number }, cs: number, p: Pad) {
    const dx = Math.max(Math.abs(cell.x - p.position.x) - (cs + p.size.width) / 2, 0);
    const dy = Math.max(Math.abs(cell.y - p.position.y) - (cs + p.size.height) / 2, 0);
    return Math.hypot(dx, dy);
  }
  const pb = { width: 30, height: 20 };
  const fps = [
    fp('g', 10, 10, [pad('g1', 10, 10, 'GND', { w: 1.6, h: 1.0 }), pad('g2', 20, 10, 'GND', { w: 1.2, h: 1.2 })]),
    fp('s', 15, 10, [pad('s1', 15.3, 10, 'SIG', { w: 1.0, h: 1.0 })]),
  ];
  const tr: Trace[] = [trace('SIG', [[15.3, 10], [15.3, 16]], 0.4)];
  const pour = generateCopperPour('top', 'GND', fps, tr, [], pb, 0.3);

  it('min gap from poured copper to foreign copper >= clearance (was 0.05)', () => {
    const cs = pour.cellSize;
    let min = Infinity;
    for (const c of pour.cells) {
      min = Math.min(min, gapToRect(c, cs, fps[1].pads[0]));
      // trace is vertical at x=15.3, y 10..16, half width 0.2
      const dx = Math.max(Math.abs(c.x - 15.3) - cs / 2, 0);
      const dy = c.y < 10 ? 10 - (c.y + cs / 2) : c.y > 16 ? c.y - cs / 2 - 16 : 0;
      min = Math.min(min, Math.hypot(dx, Math.max(dy, 0)) - 0.2);
    }
    expect(pour.cells.length).toBeGreaterThan(100);
    expect(min).toBeGreaterThanOrEqual(0.3 - 1e-6);
  });
  it('pour is inset from the board edge by the edge clearance', () => {
    const h = pour.cellSize / 2;
    for (const c of pour.cells) {
      expect(c.x - h).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(c.y - h).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(c.x + h).toBeLessThanOrEqual(pb.width - 0.3 + 1e-9);
      expect(c.y + h).toBeLessThanOrEqual(pb.height - 0.3 + 1e-9);
    }
  });
  it('every same-net pad has >= 2 spokes whose cells overlap its copper', () => {
    const h = pour.cellSize / 2;
    for (const p of [...fps[0].pads]) {
      const touching = pour.cells.filter((c) => Math.abs(c.x - p.position.x) < h + p.size.width / 2 && Math.abs(c.y - p.position.y) < h + p.size.height / 2);
      expect(touching.length, p.id).toBeGreaterThanOrEqual(2);
      const tp = pour.thermalPads!.find((t) => t.pos.x === p.position.x && t.pos.y === p.position.y)!;
      expect(tp.spokes).toBeGreaterThanOrEqual(2);
    }
  });
  it('islands: fill not 4-connected to same-net copper is removed', () => {
    const wall = trace('SIG', [[15, 0], [15, 20]], 1.0);
    const g = fp('g', 5, 10, [pad('g1', 5, 10, 'GND')]);
    const r = generateCopperPour('top', 'GND', [g], [wall], [], pb, 0.3);
    expect(r.cells.some((c) => c.x < 14)).toBe(true);
    expect(r.cells.some((c) => c.x > 16)).toBe(false);
  });
  it('direct connection (no thermal relief) overlaps the pad', () => {
    const g = fp('g', 5, 10, [pad('g1', 5, 10, 'GND')]);
    const r = generateCopperPour('top', 'GND', [g], [], [], pb, 0.3, { thermalRelief: false });
    expect(r.cells.some((c) => Math.abs(c.x - 5) < 0.5 && Math.abs(c.y - 10) < 0.5)).toBe(true);
  });
});
