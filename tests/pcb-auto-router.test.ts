// Tests for the PCB auto-router.
// Verifies that the router can handle multiple nets without
// accumulating "blocked" state from previous routes.
import { describe, it, expect } from 'vitest';
import { autoRoute } from '../src/lib/pcb/auto-router';
import { routeTopologically, DEFAULT_ROUTER_OPTIONS } from '../src/lib/pcb/topological-router';
import type { Footprint, Ratsnest, BoardOutline, Pad, Trace, Via } from '../src/lib/pcb/types';

function makePad(
  id: string,
  componentId: string,
  terminalId: string,
  x: number,
  y: number,
  net: string,
  drill = 0,
): Pad {
  return {
    id,
    componentId,
    terminalId,
    position: { x, y },
    shape: 'circle',
    size: { width: 0.6, height: 0.6 },
    layer: 'top',
    net,
    drill,
  };
}

function makeFootprint(
  id: string,
  componentType: string,
  refdes: string,
  x: number,
  y: number,
  pads: Pad[],
): Footprint {
  return {
    id,
    componentId: id,
    componentType,
    refdes,
    position: { x, y },
    rotation: 0,
    bodySize: { width: 4, height: 4 },
    pads,
    side: 'top',
  };
}

function makeRatsnest(net: string, fromPadId: string, toPadId: string, from: [number, number], to: [number, number]): Ratsnest {
  return {
    net,
    fromPadId,
    toPadId,
    from: { x: from[0], y: from[1] },
    to: { x: to[0], y: to[1] },
  };
}

const board: BoardOutline = { width: 80, height: 60 };

describe('PCB auto-router (Lee BFS)', () => {
  it('routes a single direct net', () => {
    const padA = makePad('p_a', 'fp_a', 'a', 10, 10, 'N1');
    const padB = makePad('p_b', 'fp_b', 'b', 30, 10, 'N1');
    const footprints: Footprint[] = [
      makeFootprint('fp_a', 'resistor', 'R1', 10, 10, [padA]),
      makeFootprint('fp_b', 'resistor', 'R2', 30, 10, [padB]),
    ];
    const rats: Ratsnest[] = [makeRatsnest('N1', 'p_a', 'p_b', [10, 10], [30, 10])];

    const result = autoRoute(footprints, [], [], rats, board, 'top', 0.3);
    expect(result.stats.routed).toBe(1);
    expect(result.stats.failed).toBe(0);
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0].net).toBe('N1');
  });

  it('CRITICAL: routes 5 separate nets without accumulation bug', () => {
    // Five independent horizontal routes at different Y positions.
    // Previous bug: the `blocked` grid accumulated from one route to the next,
    // so by the 5th net the grid was so blocked that no path could be found.
    const footprints: Footprint[] = [];
    const rats: Ratsnest[] = [];
    for (let i = 0; i < 5; i++) {
      const y = 10 + i * 10;
      const padA = makePad(`p_a${i}`, `fp_a${i}`, 'a', 5, y, `N${i}`);
      const padB = makePad(`p_b${i}`, `fp_b${i}`, 'b', 75, y, `N${i}`);
      footprints.push(
        makeFootprint(`fp_a${i}`, 'resistor', `R${i}a`, 5, y, [padA]),
        makeFootprint(`fp_b${i}`, 'resistor', `R${i}b`, 75, y, [padB]),
      );
      rats.push(makeRatsnest(`N${i}`, `p_a${i}`, `p_b${i}`, [5, y], [75, y]));
    }

    const result = autoRoute(footprints, [], [], rats, board, 'top', 0.3);
    expect(result.stats.routed).toBe(5);
    expect(result.stats.failed).toBe(0);
    expect(result.traces).toHaveLength(5);
  });

  it('routes around an obstacle', () => {
    // Net 1: straight line at y=10.  Net 2: at y=15, blocked by an existing trace.
    const padA = makePad('p_a', 'fp_a', 'a', 5, 10, 'N1');
    const padB = makePad('p_b', 'fp_b', 'b', 75, 10, 'N1');
    const padC = makePad('p_c', 'fp_c', 'a', 5, 30, 'N2');
    const padD = makePad('p_d', 'fp_d', 'b', 75, 30, 'N2');
    const footprints: Footprint[] = [
      makeFootprint('fp_a', 'resistor', 'R1', 5, 10, [padA]),
      makeFootprint('fp_b', 'resistor', 'R2', 75, 10, [padB]),
      makeFootprint('fp_c', 'resistor', 'R3', 5, 30, [padC]),
      makeFootprint('fp_d', 'resistor', 'R4', 75, 30, [padD]),
    ];
    const rats: Ratsnest[] = [
      makeRatsnest('N1', 'p_a', 'p_b', [5, 10], [75, 10]),
      makeRatsnest('N2', 'p_c', 'p_d', [5, 30], [75, 30]),
    ];

    const result = autoRoute(footprints, [], [], rats, board, 'top', 0.3);
    expect(result.stats.routed).toBe(2);
    expect(result.stats.failed).toBe(0);
  });
});

describe('PCB topological router (A*)', () => {
  it('routes a single net', () => {
    const padA = makePad('p_a', 'fp_a', 'a', 10, 10, 'N1');
    const padB = makePad('p_b', 'fp_b', 'b', 60, 50, 'N1');
    const footprints: Footprint[] = [
      makeFootprint('fp_a', 'resistor', 'R1', 10, 10, [padA]),
      makeFootprint('fp_b', 'resistor', 'R2', 60, 50, [padB]),
    ];
    const rats: Ratsnest[] = [makeRatsnest('N1', 'p_a', 'p_b', [10, 10], [60, 50])];

    const result = routeTopologically(footprints, [], [], rats, board, {
      ...DEFAULT_ROUTER_OPTIONS,
      clearance: 0.2,
      traceWidth: 0.3,
    });
    expect(result.stats.routed).toBe(1);
    expect(result.stats.failed).toBe(0);
    expect(result.traces.length).toBeGreaterThanOrEqual(1);
  });

  it('CRITICAL: routes 5 separate nets without accumulation bug', () => {
    const footprints: Footprint[] = [];
    const rats: Ratsnest[] = [];
    for (let i = 0; i < 5; i++) {
      const y = 10 + i * 10;
      const padA = makePad(`p_a${i}`, `fp_a${i}`, 'a', 5, y, `N${i}`);
      const padB = makePad(`p_b${i}`, `fp_b${i}`, 'b', 75, y, `N${i}`);
      footprints.push(
        makeFootprint(`fp_a${i}`, 'resistor', `R${i}a`, 5, y, [padA]),
        makeFootprint(`fp_b${i}`, 'resistor', `R${i}b`, 75, y, [padB]),
      );
      rats.push(makeRatsnest(`N${i}`, `p_a${i}`, `p_b${i}`, [5, y], [75, y]));
    }

    const result = routeTopologically(footprints, [], [], rats, board, {
      ...DEFAULT_ROUTER_OPTIONS,
      clearance: 0.2,
      traceWidth: 0.3,
    });
    expect(result.stats.routed).toBe(5);
    expect(result.stats.failed).toBe(0);
  });

  it('routes EVERY connection of a multi-pad net (3 pads → 2 legs)', () => {
    // Regression: routeOneNet used to route only connections[0], leaving the
    // third pad of the net permanently unrouted.
    const pads = [
      makePad('p_a', 'fp_a', 'a', 10, 10, 'N1'),
      makePad('p_b', 'fp_b', 'b', 60, 10, 'N1'),
      makePad('p_c', 'fp_c', 'a', 60, 50, 'N1'),
    ];
    const footprints: Footprint[] = [
      makeFootprint('fp_a', 'resistor', 'R1', 10, 10, [pads[0]]),
      makeFootprint('fp_b', 'resistor', 'R2', 60, 10, [pads[1]]),
      makeFootprint('fp_c', 'resistor', 'R3', 60, 50, [pads[2]]),
    ];
    const rats: Ratsnest[] = [
      makeRatsnest('N1', 'p_a', 'p_b', [10, 10], [60, 10]),
      makeRatsnest('N1', 'p_b', 'p_c', [60, 10], [60, 50]),
    ];

    const result = routeTopologically(footprints, [], [], rats, board, {
      ...DEFAULT_ROUTER_OPTIONS,
      clearance: 0.2,
      traceWidth: 0.3,
    });
    expect(result.stats.routed).toBe(2);
    expect(result.stats.failed).toBe(0);
    // Both legs present as traces on net N1
    expect(result.traces.filter((t) => t.net === 'N1').length).toBe(2);
  });
});

describe('PCB auto-router layer awareness', () => {
  it('bottom-side SMD pads do not block top-layer routing', () => {
    // Regression: pads of other nets were obstacles regardless of layer, so
    // routing on one layer failed when the board was populated on the other.
    const padA = makePad('p_a', 'fp_a', 'a', 5, 10, 'N1');
    const padB = makePad('p_b', 'fp_b', 'b', 75, 10, 'N1');
    // A wall of BOTTOM-side SMD pads (drill = 0) straight across the route path
    const blockers: Footprint[] = [];
    for (let i = 0; i < 5; i++) {
      const bx = 20 + i * 10;
      blockers.push(makeFootprint(`fp_blk${i}`, 'resistor', `BLK${i}`, bx, 10, [
        makePad(`p_blk${i}`, `fp_blk${i}`, 'a', bx, 10, 'OTHER', 0),
      ]));
      (blockers[i].pads[0] as Pad).layer = 'bottom';
    }
    const footprints: Footprint[] = [
      makeFootprint('fp_a', 'resistor', 'R1', 5, 10, [padA]),
      makeFootprint('fp_b', 'resistor', 'R2', 75, 10, [padB]),
      ...blockers,
    ];
    const rats: Ratsnest[] = [makeRatsnest('N1', 'p_a', 'p_b', [5, 10], [75, 10])];

    const result = autoRoute(footprints, [], [], rats, board, 'top', 0.3);
    expect(result.stats.routed).toBe(1);
    expect(result.stats.failed).toBe(0);
  });

  it('THT pads (drill > 0) block routing on every layer', () => {
    const padA = makePad('p_a', 'fp_a', 'a', 5, 10, 'N1');
    const padB = makePad('p_b', 'fp_b', 'b', 75, 10, 'N1');
    const blockers: Footprint[] = [];
    for (let i = 0; i < 5; i++) {
      const bx = 20 + i * 10;
      blockers.push(makeFootprint(`fp_blk${i}`, 'resistor', `BLK${i}`, bx, 10, [
        makePad(`p_blk${i}`, `fp_blk${i}`, 'a', bx, 10, 'OTHER', 0.8),
      ]));
      (blockers[i].pads[0] as Pad).layer = 'bottom';
    }
    const footprints: Footprint[] = [
      makeFootprint('fp_a', 'resistor', 'R1', 5, 10, [padA]),
      makeFootprint('fp_b', 'resistor', 'R2', 75, 10, [padB]),
      ...blockers,
    ];
    const rats: Ratsnest[] = [makeRatsnest('N1', 'p_a', 'p_b', [5, 10], [75, 10])];

    // The THT wall spans the board, but the router must still find a way
    // around it (above/below the wall) — it must not route straight through.
    const result = autoRoute(footprints, [], [], rats, board, 'top', 0.3);
    expect(result.stats.routed).toBe(1);
    // Verify the route actually detours around each THT pad (no segment passes
    // straight through a blocker pad center).
    const trace = result.traces.find((t) => t.net === 'N1');
    expect(trace).toBeDefined();
    for (const seg of trace!.segments) {
      for (const fp of blockers) {
        const p = fp.pads[0];
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const px = seg.start.x + (seg.end.x - seg.start.x) * t;
          const py = seg.start.y + (seg.end.y - seg.start.y) * t;
          expect(Math.hypot(px - p.position.x, py - p.position.y)).toBeGreaterThanOrEqual(0.4);
        }
      }
    }
  });
});
