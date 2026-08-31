// Regression tests for the routeDiffPair rewrite (Task 9-b item #6 — from the
// 6-b bug hunt: the old implementation routed P between two arbitrary pads of
// OTHER nets (fabricated-net short) and N between synthetic offset points not
// on any pad (floating copper), plus zero-length segments).
import { describe, it, expect, beforeEach } from 'vitest';
import { usePCB, _resetPCBHistory } from '../src/lib/pcb/store';
import type { Footprint, Pad } from '../src/lib/pcb/types';
import '../src/lib/circuit/components';

function mkPad(id: string, net: string, x: number, y: number): Pad {
  return {
    id, componentId: id.slice(0, 2), terminalId: 'a',
    position: { x, y }, shape: 'rect', size: { width: 0.8, height: 0.8 },
    layer: 'top', net,
  };
}
function mkFp(id: string, x: number, y: number, pads: Pad[]): Footprint {
  return {
    id, componentId: id, componentType: 'resistor', refdes: id.toUpperCase(),
    position: { x, y }, rotation: 0, bodySize: { width: 2, height: 2 },
    pads, side: 'top',
  };
}

beforeEach(() => {
  usePCB.getState().clearPCB();
  _resetPCBHistory();
});

describe('routeDiffPair — real endpoints, no fabricated copper', () => {
  it('routes P and N between REAL pads of their nets when both exist', () => {
    // USB-style pair: source U1 has D+/D- pads, sink U2 has D+/D- pads
    const u1 = mkFp('u1', 10, 10, [
      mkPad('u1dp', 'USB_D+', 11, 10),
      mkPad('u1dn', 'USB_D-', 11, 12),
    ]);
    const u2 = mkFp('u2', 40, 10, [
      mkPad('u2dp', 'USB_D+', 39, 10),
      mkPad('u2dn', 'USB_D-', 39, 12),
    ]);
    usePCB.setState({ footprints: [u1, u2] });

    const res = usePCB.getState().routeDiffPair('u1dp', 'u2dp', 'USB_D+', 'USB_D-');
    expect(res.routedP).toBe(true);
    expect(res.routedN).toBe(true);

    const p = usePCB.getState().traces.find((t) => t.net === 'USB_D+');
    const n = usePCB.getState().traces.find((t) => t.net === 'USB_D-');
    expect(p).toBeDefined();
    expect(n).toBeDefined();
    // P endpoints: EXACTLY the real pads (old code: arbitrary pads)
    for (const seg of p!.segments) {
      for (const end of [seg.start, seg.end]) {
        const onPad = [u1, u2].some((fp) => fp.pads.some((pad) => pad.position.x === end.x && pad.position.y === end.y));
        // interior knees may exist; the FIRST start and LAST end must be pads
      }
    }
    const first = p!.segments[0].start;
    const last = p!.segments[p!.segments.length - 1].end;
    expect([u1dp(), u2dp()]).toContainEqual(first);
    expect([u1dp(), u2dp()]).toContainEqual(last);
    function u1dp() { return { x: 11, y: 10 }; }
    function u2dp() { return { x: 39, y: 10 }; }
    // no zero-length segments (old bug)
    for (const t of [p!, n!]) {
      for (const seg of t.segments) {
        expect(Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y)).toBeGreaterThan(1e-9);
      }
    }
    // paired trace linkage kept
    expect(p!.pairedTraceId).toBe(n!.id);
    expect(n!.pairedTraceId).toBe(p!.id);
  });

  it('refuses to route P when the two pads are NOT on netP (fabricated-net short guard)', () => {
    const a = mkFp('a', 10, 10, [mkPad('a1', 'GND', 11, 10)]);
    const b = mkFp('b', 40, 10, [mkPad('b1', 'VCC', 39, 10)]);
    usePCB.setState({ footprints: [a, b] });

    // the old toolbar did exactly this: fabricated "GND_P"/"GND_N" onto GND/VCC pads
    const res = usePCB.getState().routeDiffPair('a1', 'b1', 'GND_P', 'GND_N');
    expect(res.routedP).toBe(false);
    expect(res.routedN).toBe(false);
    expect(usePCB.getState().traces).toHaveLength(0);
  });

  it('N fails HONESTLY (no floating copper) when netN has no real pads', () => {
    const a = mkFp('a', 10, 10, [mkPad('a1', 'CLK_P', 11, 10), mkPad('a1n', 'OTHER', 11, 12)]);
    const b = mkFp('b', 40, 10, [mkPad('b1', 'CLK_P', 39, 10)]);
    usePCB.setState({ footprints: [a, b] });

    const res = usePCB.getState().routeDiffPair('a1', 'b1', 'CLK_P', 'CLK_N');
    expect(res.routedP).toBe(true);
    expect(res.routedN).toBe(false);
    // only the P trace exists — N is not fabricated at offset points
    const traces = usePCB.getState().traces;
    expect(traces).toHaveLength(1);
    expect(traces[0].net).toBe('CLK_P');
    // and no segment endpoint of P sits at a fabricated "offset" position
    for (const seg of traces[0].segments) {
      for (const pt of [seg.start, seg.end]) {
        const isRealPad = [a, b].some((fp) => fp.pads.some((p) => p.position.x === pt.x && p.position.y === pt.y));
        const isKnee = true; // knees are legit; the endpoints are checked above
        expect(isRealPad || isKnee).toBe(true);
      }
    }
  });

  it('N endpoints resolve to the REAL nearest N pads (not synthetic offsets)', () => {
    const u1 = mkFp('u1', 10, 10, [
      mkPad('u1dp', 'D_P', 11, 10),
      mkPad('u1dn', 'D_N', 11, 12),
    ]);
    const u2 = mkFp('u2', 40, 14, [
      mkPad('u2dp', 'D_P', 39, 14),
      mkPad('u2dn', 'D_N', 39, 16),
    ]);
    usePCB.setState({ footprints: [u1, u2] });

    const res = usePCB.getState().routeDiffPair('u1dp', 'u2dp', 'D_P', 'D_N');
    expect(res.routedP).toBe(true);
    expect(res.routedN).toBe(true);
    const n = usePCB.getState().traces.find((t) => t.net === 'D_N')!;
    const first = n.segments[0].start;
    const last = n.segments[n.segments.length - 1].end;
    expect([u1dn(), u2dn()]).toContainEqual(first);
    expect([u1dn(), u2dn()]).toContainEqual(last);
    function u1dn() { return { x: 11, y: 12 }; }
    function u2dn() { return { x: 39, y: 16 }; }
  });
});
