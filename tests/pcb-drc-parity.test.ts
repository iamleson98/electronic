// Regression tests for the DRC parity set (Task 9-b item #11 — KiCad-consumer-bar
// checks): exact rect↔rect pad distance (kills the circle-approximation false
// positives from Task 6-b), board-boundary checks for pads/vias/footprints
// (not just trace endpoints), and hole-to-hole drill spacing.
import { describe, it, expect } from 'vitest';
import { runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import type { Footprint, Pad, Trace, Via } from '../src/lib/pcb/types';

function mkPad(id: string, net: string, x: number, y: number, opts: Partial<Pad> = {}): Pad {
  return {
    id, componentId: id.slice(0, 2), terminalId: 'a',
    position: { x, y },
    shape: 'rect',
    size: { width: 1.2, height: 0.6 },
    layer: 'top',
    net,
    ...opts,
  } as Pad;
}

function mkFp(id: string, x: number, y: number, pads: Pad[]): Footprint {
  return {
    id, componentId: id, componentType: 'resistor', refdes: id.toUpperCase(),
    position: { x, y }, rotation: 0,
    bodySize: { width: 3.2, height: 1.6 },
    pads, side: 'top',
  };
}

const BOARD = { width: 80, height: 60 };

describe('pad-pad clearance — exact rect geometry', () => {
  it('two rect pads 0.7mm apart (real gap) is NOT a violation (was: false positive)', () => {
    // The Task 6-b probe: 1.2×0.6 SMD pads stacked vertically 1.5mm apart →
    // 1.5 − 0.6 = 0.9mm edge-to-edge... make the actual worst case: centers
    // 1.3mm apart → 1.3 − 0.6 = 0.7mm gap ≥ 0.2 clearance → clean.
    const a = mkFp('a', 20, 20, [mkPad('a1', 'NET_A', 20, 20)]);
    const b = mkFp('b', 20, 21.3, [mkPad('b1', 'NET_B', 20, 21.3)]);
    const errors = runDRC([a, b], [], [], [], BOARD, DEFAULT_DRC_CONFIG, []);
    const padViolations = errors.filter((e) => /pads .*(a1|b1)/.test(e.message));
    expect(padViolations).toHaveLength(0);
  });

  it('two rect pads with a real 0.1mm gap IS flagged (the check still works)', () => {
    const a = mkFp('a', 20, 20, [mkPad('a1', 'NET_A', 20, 20)]);
    const b = mkFp('b', 20, 20.7, [mkPad('b1', 'NET_B', 20, 20.7)]); // 0.7 − 0.6 = 0.1mm gap
    const errors = runDRC([a, b], [], [], [], BOARD, DEFAULT_DRC_CONFIG, []);
    expect(errors.some((e) => /pads "a1" and "b1"/.test(e.message))).toBe(true);
  });

  it('rect pads side by side with a wide horizontal gap use the true rect distance', () => {
    // 1.2-wide pads, centers 2.0mm apart horizontally → 2.0 − 1.2 = 0.8mm
    // gap. Circle approximation used max(1.2,0.6)/2 = 0.6 radii → 2.0 − 1.2 =
    // 0.8 too in this orientation; the discriminator is the STACKED case
    // (covered above) — this pins the horizontal case stays correct.
    const a = mkFp('a', 20, 20, [mkPad('a1', 'NET_A', 20, 20)]);
    const b = mkFp('b', 22, 20, [mkPad('b1', 'NET_B', 22, 20)]);
    const errors = runDRC([a, b], [], [], [], BOARD, DEFAULT_DRC_CONFIG, []);
    expect(errors.filter((e) => /pads "a1" and "b1"/.test(e.message))).toHaveLength(0);
  });
});

describe('board boundary — every object class is checked', () => {
  it('a pad outside the board is an error (was: invisible)', () => {
    const a = mkFp('a', 79.5, 20, [mkPad('a1', 'NET_A', 79.5, 20)]); // pad 1.2 wide → edge at 80.1
    const errors = runDRC([a], [], [], [], BOARD, DEFAULT_DRC_CONFIG, []);
    expect(errors.some((e) => e.type === 'outside_board' && /pad "a1"/i.test(e.message))).toBe(true);
  });

  it('a via outside the board is an error', () => {
    const via: Via = {
      id: 'v1', position: { x: -1, y: 30 }, diameter: 0.6, drill: 0.3,
      net: 'N', type: 'tht', fromLayer: 'top', toLayer: 'bottom',
    };
    const errors = runDRC([], [], [via], [], BOARD, DEFAULT_DRC_CONFIG, []);
    expect(errors.some((e) => e.type === 'outside_board' && /via/i.test(e.message))).toBe(true);
  });

  it('a footprint body hanging over the edge is an error (pads may still be inside)', () => {
    // body 3.2 wide centered at 78.8 → extends to 80.4 (pad edge at 79.4 is inside)
    const a = mkFp('a', 78.8, 30, [mkPad('a1', 'NET_A', 78.8, 30)]);
    const errors = runDRC([a], [], [], [], BOARD, DEFAULT_DRC_CONFIG, []);
    expect(errors.some((e) => e.type === 'outside_board' && /footprint "A"/i.test(e.message))).toBe(true);
  });

  it('a fully-inside board stays clean on these checks', () => {
    const a = mkFp('a', 40, 30, [mkPad('a1', 'NET_A', 40, 30)]);
    const via: Via = {
      id: 'v1', position: { x: 40, y: 35 }, diameter: 0.6, drill: 0.3,
      net: 'N', type: 'tht', fromLayer: 'top', toLayer: 'bottom',
    };
    const errors = runDRC([a], [], [via], [], BOARD, DEFAULT_DRC_CONFIG, []);
    expect(errors.filter((e) => e.type === 'outside_board')).toHaveLength(0);
  });
});

describe('hole-to-hole drill spacing', () => {
  it('two drills with a 0.1mm web are flagged', () => {
    const padA = mkPad('a1', 'NET_A', 20, 20, { drill: 0.4, shape: 'circle', size: { width: 0.9, height: 0.9 } });
    const padB = mkPad('b1', 'NET_B', 20.6, 20, { drill: 0.4, shape: 'circle', size: { width: 0.9, height: 0.9 } });
    const a = mkFp('a', 20, 20, [padA]);
    const b = mkFp('b', 20.6, 20, [padB]);
    const errors = runDRC([a, b], [], [], [], BOARD, DEFAULT_DRC_CONFIG, []);
    expect(errors.some((e) => e.type === 'hole_to_hole')).toBe(true);
  });

  it('drills 1mm apart stay clean', () => {
    const padA = mkPad('a1', 'NET_A', 20, 20, { drill: 0.4, shape: 'circle', size: { width: 0.9, height: 0.9 } });
    const padB = mkPad('b1', 'NET_B', 21, 20, { drill: 0.4, shape: 'circle', size: { width: 0.9, height: 0.9 } });
    const a = mkFp('a', 20, 20, [padA]);
    const b = mkFp('b', 21, 20, [padB]);
    const errors = runDRC([a, b], [], [], [], BOARD, DEFAULT_DRC_CONFIG, []);
    expect(errors.filter((e) => e.type === 'hole_to_hole')).toHaveLength(0);
  });
});
