// Regression tests for the v3 placement engine (Task 9-c: congestion-aware
// + module-clustered placement in netlist-sync.ts).
//
//   1. Determinism — same schematic, byte-identical placement (the router
//      relies on this guarantee; the v2 suite enforces it too).
//   2. Functional-module clustering — 555 Timer Clock: each counter stays
//      next to the display it drives; the 555 stays with its RC network;
//      stats report the clusters.
//   3. RUDY congestion feedback — Arduino Clock on a dense 50×35 board:
//      overflow cells detected, ≤2 re-relaxations, overflow reduced.
//   4. Option gates — moduleClustering:false → no clusters; congestionFeedback
//      :false → grid never computed.
//   5. Legacy path — a trivial board with no clusters is bit-identical with
//      clustering on vs off (the "no groups → v2 behavior" contract).
//   6. Routability smoke — the new placement still feeds a 100%-routing
//      board through the REAL store (LED + Resistor and 555 Astable Blink).
import { describe, it, expect, beforeEach } from 'vitest';
import { computeSmartPlacement, createPCBFromSchematic } from '../src/lib/pcb/netlist-sync';
import { exampleCategories } from '../src/lib/circuit/examples';
import { usePCB } from '../src/lib/pcb/store';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';
import '../src/lib/circuit/components';

const examples = exampleCategories.flatMap((c) => c.examples);
function example(name: string): { components: CircuitComponent[]; wires: Wire[] } {
  const ex = examples.find((e) => e.name === name);
  if (!ex) throw new Error(`example not found: ${name}`);
  return { components: ex.doc.components as CircuitComponent[], wires: ex.doc.wires as unknown as Wire[] };
}

describe('placement determinism', () => {
  it('createPCBFromSchematic twice → byte-identical footprints (router determinism contract)', () => {
    const { components, wires } = example('555 Timer Clock (HH:MM:SS)');
    const a = createPCBFromSchematic(components, wires);
    const b = createPCBFromSchematic(components, wires);
    expect(JSON.stringify(a.footprints)).toBe(JSON.stringify(b.footprints));
    expect(JSON.stringify(a.ratsnest)).toBe(JSON.stringify(b.ratsnest));
    expect(JSON.stringify(a.board)).toBe(JSON.stringify(b.board));
  });

  it('computeSmartPlacement twice → identical positions and rotations', () => {
    const { components, wires } = example('Two-Stage Audio Amplifier');
    const a = computeSmartPlacement(components, wires, 80, 60);
    const b = computeSmartPlacement(components, wires, 80, 60);
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()]);
    expect([...a.rotations.entries()]).toEqual([...b.rotations.entries()]);
  });
});

describe('functional-module clustering', () => {
  it('555 Timer Clock: modules detected (6 counter+display + the 555 RC); timer stays with its RC network; displays stay adjacent to counters', () => {
    const { components, wires } = example('555 Timer Clock (HH:MM:SS)');
    const r = computeSmartPlacement(components, wires, 80, 60);
    const s = r.stats;
    // 6 counter+display modules + the 555 RC module (calibrated on the
    // deterministic engine; assert exact structure)
    expect(s.clusters).toBe(7);
    expect(s.clusteredComponents).toBe(15);

    const pos = (id: string) => r.positions.get(id)!;
    const dist = (a: string, b: string) => {
      const pa = pos(a), pb = pos(b);
      return Math.sqrt((pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2);
    };
    // the 555 + its timing RC stay a module: each within 16 mm of the 555
    const timer = components.find((c) => c.type === 'timer555')!;
    const rc = components.filter((c) => c.type === 'resistor' || c.type === 'capacitor');
    expect(rc.length).toBeGreaterThanOrEqual(3);
    for (const c of rc) {
      expect(dist(timer.id, c.id)).toBeLessThanOrEqual(16);
    }
    // every display has a counter within 28 mm, and on average within 16 mm
    // (module adjacency — the force relaxation + clustering jointly own
    // this outcome; one module may sit farther, none may be orphaned)
    const counters = components.filter((c) => c.type === 'cd4026');
    const displays = components.filter((c) => c.type === 'sevenSegment');
    expect(counters.length).toBe(6);
    expect(displays.length).toBe(6);
    const nearests = displays.map((d) => Math.min(...counters.map((c) => dist(c.id, d.id))));
    expect(Math.max(...nearests)).toBeLessThanOrEqual(28);
    expect(nearests.reduce((a, b) => a + b, 0) / nearests.length).toBeLessThanOrEqual(16);
  });

  it('scrambled schematic positions: modules still form next to their drivers', () => {
    const { components, wires } = example('555 Timer Clock (HH:MM:SS)');
    const scrambled = components.map((c, i) => ({ ...c, position: { x: (i * 37) % 90, y: (i * 23) % 70 } }));
    const r = computeSmartPlacement(scrambled, wires, 80, 60);
    expect(r.stats.clusters).toBe(7);
    const pos = (id: string) => r.positions.get(id)!;
    const counters = scrambled.filter((c) => c.type === 'cd4026');
    const displays = scrambled.filter((c) => c.type === 'sevenSegment');
    const nearests = displays.map((d) => Math.min(...counters.map((c) => {
      const pc = pos(c.id), pd = pos(d.id);
      return Math.sqrt((pc.x - pd.x) ** 2 + (pc.y - pd.y) ** 2);
    })));
    expect(Math.max(...nearests)).toBeLessThanOrEqual(20);
    expect(nearests.reduce((a, b) => a + b, 0) / nearests.length).toBeLessThanOrEqual(15);
  });

  it('moduleClustering: false disables the pre-pass entirely', () => {
    const { components, wires } = example('555 Timer Clock (HH:MM:SS)');
    const r = computeSmartPlacement(components, wires, 80, 60, { moduleClustering: false });
    expect(r.stats.clusters).toBe(0);
    expect(r.stats.clusteredComponents).toBe(0);
  });
});

describe('RUDY congestion feedback', () => {
  it('Arduino Clock on a dense 50×35 board: overflow detected, re-relaxed away', () => {
    const { components, wires } = example('Arduino Clock (MM:SS)');
    const r = computeSmartPlacement(components, wires, 50, 35);
    const s = r.stats;
    // the dense board genuinely overflows the routing supply estimate…
    expect(s.overflowCellsBefore).toBeGreaterThanOrEqual(1);
    expect(s.maxDemandRatio).toBeGreaterThan(1);
    // …the feedback loop runs (bounded)…
    expect(s.congestionReRelaxations).toBeGreaterThanOrEqual(1);
    expect(s.congestionReRelaxations).toBeLessThanOrEqual(2);
    // …and the overflow is reduced (calibrated: to 0)
    expect(s.overflowCellsAfter).toBeLessThan(s.overflowCellsBefore);
    expect(s.overflowCellsAfter).toBe(0);
  });

  it('congestionFeedback: false never computes the grid', () => {
    const { components, wires } = example('Arduino Clock (MM:SS)');
    const r = computeSmartPlacement(components, wires, 50, 35, { congestionFeedback: false });
    expect(r.stats.overflowCellsBefore).toBe(0);
    expect(r.stats.maxDemandRatio).toBe(0);
    expect(r.stats.congestionReRelaxations).toBe(0);
  });
});

describe('legacy path for trivial boards', () => {
  it('LED + Resistor (no clusters, no overflow) is bit-identical with clustering on vs off', () => {
    const { components, wires } = example('LED + Resistor');
    const on = computeSmartPlacement(components, wires, 80, 60);
    const off = computeSmartPlacement(components, wires, 80, 60, { moduleClustering: false, congestionFeedback: false });
    expect(on.stats.clusters).toBe(0); // nothing to cluster — legacy path
    expect([...on.positions.entries()]).toEqual([...off.positions.entries()]);
    expect([...on.rotations.entries()]).toEqual([...off.rotations.entries()]);
  });
});

describe('routability smoke (real store)', () => {
  beforeEach(() => {
    usePCB.getState().clearPCB();
  });

  it('555 Astable Blink: v3 placement → auto-route completes 100%, DRC clean', () => {
    const { components, wires } = example('555 Astable Blink');
    usePCB.getState().importFromSchematic(components, wires);
    const stats = usePCB.getState().runAutoRoute();
    expect(stats.unroutedCount).toBe(0);
    usePCB.getState().runDRC();
    expect(usePCB.getState().drcErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
  });

  it('7-Segment Counter: v3 placement → auto-route completes 100%', () => {
    const { components, wires } = example('7-Segment Counter');
    usePCB.getState().importFromSchematic(components, wires);
    const stats = usePCB.getState().runAutoRoute();
    expect(stats.unroutedCount).toBe(0);
  });
});
