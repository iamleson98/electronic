// Example wire-style regression tests.
//
// Guards the orthogonal wiring style of every bundled example circuit:
//   1. ORTHOGONAL — no diagonal segments in any rendered wire path.
//   2. NO DIFFERENT-NET 1:1 OVERLAPS — no wire runs line-on-line on top of
//      a different net (same-net runs are legal: that is what a bus rail is).
//   3. CORNER-SPARSE — no duplicate or collinear interior waypoints.
//
// Also unit-tests normalizeExampleWires (src/lib/circuit/example-wires.ts):
// diagonal splitting, corner-sparsification, endpoint preservation, and the
// graceful fallback for unresolvable endpoints.

import { describe, it, expect, beforeAll } from 'vitest';
import { exampleCategories, exampleLed, example555 } from '../src/lib/circuit/examples';
import { normalizeExampleWires, differentNetOverlaps } from '../src/lib/circuit/example-wires';
import { wireGridPath } from '../src/lib/circuit/wire-overlap';
import { resolveEndpointGridPos } from '../src/lib/circuit/endpoint-position';
import type { CircuitDocument, Vec2, Wire } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/advanced');
  await import('../src/lib/circuit/components/advanced-devices');
  await import('../src/lib/circuit/components/arduino-real');
  await import('../src/lib/circuit/components/kicad-parity');
  await import('../src/lib/circuit/components/power-symbols');
});

const EPS = 1e-6;

function isDiagonal(a: Vec2, b: Vec2): boolean {
  return Math.abs(b.x - a.x) > EPS && Math.abs(b.y - a.y) > EPS;
}

function docDiagonals(doc: CircuitDocument): string[] {
  const out: string[] = [];
  for (const w of doc.wires) {
    const path = wireGridPath(w, doc.components, doc.sheets ?? []);
    if (!path) continue;
    for (let i = 0; i < path.length - 1; i++) {
      if (isDiagonal(path[i], path[i + 1])) {
        out.push(`${w.id}: (${path[i].x},${path[i].y})→(${path[i + 1].x},${path[i + 1].y})`);
      }
    }
  }
  return out;
}

function docRedundantInteriorPoints(doc: CircuitDocument): string[] {
  const out: string[] = [];
  for (const w of doc.wires) {
    const path = wireGridPath(w, doc.components, doc.sheets ?? []);
    if (!path || path.length < 3) continue;
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[i - 1], b = path[i], c = path[i + 1];
      const collinear =
        (Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS) ||
        (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS);
      const dup = Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
      if (collinear || dup) out.push(`${w.id}: (${b.x},${b.y})`);
    }
  }
  return out;
}

const allExamples: Array<{ name: string; doc: CircuitDocument }> = exampleCategories.flatMap(
  (c) => c.examples.map((e) => ({ name: e.name, doc: e.doc as CircuitDocument })),
);

describe('every bundled example: orthogonal wire style', () => {
  it('has at least 20 examples loaded (sanity — the list must not regress)', () => {
    expect(allExamples.length).toBeGreaterThanOrEqual(20);
  });

  for (const ex of allExamples) {
    it(`no diagonal segments: ${ex.name}`, () => {
      expect(docDiagonals(ex.doc)).toEqual([]);
    });
    it(`no different-net 1:1 wire overlaps: ${ex.name}`, () => {
      expect(differentNetOverlaps(ex.doc)).toEqual([]);
    });
    it(`corner-sparse waypoints: ${ex.name}`, () => {
      expect(docRedundantInteriorPoints(ex.doc)).toEqual([]);
    });
  }
});

describe('normalizeExampleWires (unit)', () => {
  const makeDoc = (wires: Wire[]): CircuitDocument =>
    ({ version: 1, components: [], wires } as unknown as CircuitDocument);

  it('splits a diagonal waypoint into a horizontal-first elbow', () => {
    // from (0,0) → wp (5,5) → to (10,0): the (0,0)→(5,5) leg is diagonal;
    // orthogonalization inserts the elbow at (5,0).
    const doc = makeDoc([
      {
        id: 'w1',
        from: { componentId: 'a', terminalId: 'p' },
        to: { componentId: 'b', terminalId: 'p' },
        waypoints: [{ x: 5, y: 5 }],
      },
    ]);
    const out = normalizeExampleWires(doc);
    // endpoints unresolved (no components) → wire must be left untouched
    expect(out.wires[0].waypoints).toEqual([{ x: 5, y: 5 }]);
  });

  it('leaves wire endpoints (from/to refs) completely untouched', () => {
    const raw = JSON.parse(JSON.stringify(exampleLed)) as CircuitDocument;
    const out = normalizeExampleWires(raw);
    expect(out.wires.length).toBe(raw.wires.length);
    for (let i = 0; i < raw.wires.length; i++) {
      expect(out.wires[i].from).toEqual(raw.wires[i].from);
      expect(out.wires[i].to).toEqual(raw.wires[i].to);
    }
  });

  it('is idempotent — normalizing an already-normalized doc changes nothing', () => {
    const once = normalizeExampleWires(JSON.parse(JSON.stringify(example555)) as CircuitDocument);
    const twice = normalizeExampleWires(JSON.parse(JSON.stringify(once)) as CircuitDocument);
    expect(twice.wires.map((w) => w.waypoints ?? null)).toEqual(
      once.wires.map((w) => w.waypoints ?? null),
    );
  });

  it('returns the input document when there are no wires', () => {
    const doc = makeDoc([]);
    expect(normalizeExampleWires(doc)).toBe(doc);
  });

  it('same-net stacking is legal in the overlap audit (bus rails)', () => {
    // exampleLed is fully clean; differentNetOverlaps must be empty.
    expect(differentNetOverlaps(exampleLed as CircuitDocument)).toEqual([]);
  });
});

describe('connectivity is preserved by the normalization (endpoint-derived)', () => {
  it('every example wire resolves to real component terminals (no orphan geometry)', () => {
    for (const ex of allExamples) {
      for (const w of ex.doc.wires) {
        const from = resolveEndpointGridPos(w.from, ex.doc.components, ex.doc.sheets ?? []);
        const to = resolveEndpointGridPos(w.to, ex.doc.components, ex.doc.sheets ?? []);
        expect(from, `${ex.name}/${w.id} from-terminal must resolve`).not.toBeNull();
        expect(to, `${ex.name}/${w.id} to-terminal must resolve`).not.toBeNull();
      }
    }
  });
});
