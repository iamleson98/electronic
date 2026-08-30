// Regression tests for the circuit app-layer audit (Task 2-b).
//
// Covers:
//   1. spice.ts (parseSpiceNetlist — the parser behind POST /api/spice/import):
//      .SUBCKT expansion, nesting, gnd aliases, title line, M/Q model cards.
//   2. netlist-export.ts: acVoltage SINE(offset amp freq) round-trips the offset.
//   3. store.ts: addNetClass is undoable; deleting components drops dangling
//      No-Connect markers; completeWire routes between rotated terminal positions.
//   4. smart-wire-router.ts: terminal math is rotation-aware.
//   5. share-url.ts: malformed share payloads return null instead of crashing.
//   6. memory.ts: every stateful plugin prefix is registered for cleanup.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { parseSpiceNetlist } from '../src/lib/circuit/spice';
import { exportSPICENetlist } from '../src/lib/circuit/netlist-export';
import { COMP_ID_STATE_PREFIXES } from '../src/lib/circuit/memory';
import { createShareURL, loadFromShareURL } from '../src/lib/circuit/share-url';
import { getWireGridPath, snapToNearestTerminal, buildRoutingGrid } from '../src/lib/circuit/smart-wire-router';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { useEditor } from '../src/lib/circuit/store';
import type { CircuitComponent, CircuitDocument, Wire, ComponentPlugin } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. SPICE import (spice.ts — the /api/spice/import parser)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSpiceNetlist: .SUBCKT expansion', () => {
  const dividerNetlist = [
    'divider subckt test',
    '.subckt DIVIDER in out com',
    'R1 in out 1k',
    'R2 out com 2k',
    '.ends',
    'V1 vin 0 DC 9',
    'X1 vin vmid 0 DIVIDER',
    'RL vmid 0 10k',
    '.end',
  ].join('\n');

  it('expands subckt contents onto the CALLER nets (pin substitution)', () => {
    const doc = parseSpiceNetlist(dividerNetlist);
    const resistors = doc.components.filter((c) => c.type === 'resistor');
    // R1, R2 (from the subckt) + RL (top level) — exactly one instance each.
    expect(resistors.length).toBe(3);
    expect(resistors.map((r) => r.parameters.resistance).sort((a, b) => (a as number) - (b as number))).toEqual([1000, 2000, 10000]);
    // R2's b terminal must land on net "0" → wired to the ground component,
    // and R1.b/R2.a/RL.a share net "vmid" → R1.b must be wired to R2.a.
    const ground = doc.components.find((c) => c.type === 'ground');
    expect(ground).toBeDefined();
    const r2 = resistors.find((r) => r.parameters.resistance === 2000)!;
    expect(doc.wires.some((w) =>
      (w.from.componentId === r2.id && w.from.terminalId === 'b' && w.to.componentId === ground!.id) ||
      (w.to.componentId === r2.id && w.to.terminalId === 'b' && w.from.componentId === ground!.id),
    )).toBe(true);
  });

  it('creates a DISTINCT instance per X call (no body leak, no collapse)', () => {
    const doc = parseSpiceNetlist([
      'two calls',
      '.subckt RPAIR a b',
      'R1 a b 1k',
      'R2 a b 2k',
      '.ends',
      'X1 n1 n2 RPAIR',
      'X2 n3 n4 RPAIR',
      '.end',
    ].join('\n'));
    const resistors = doc.components.filter((c) => c.type === 'resistor');
    // 2 per call — NOT the single leaked body copy the old code produced.
    expect(resistors.length).toBe(4);
    expect(resistors.filter((r) => r.parameters.resistance === 1000).length).toBe(2);
    expect(resistors.filter((r) => r.parameters.resistance === 2000).length).toBe(2);
    // each instance's pair is wired together on its own private net
    const wiredPairs = doc.wires.length; // n1, n2, n3, n4 → 4 two-terminal nets
    expect(wiredPairs).toBe(4);
  });

  it('expands NESTED subckt calls', () => {
    const doc = parseSpiceNetlist([
      'nested',
      '.subckt OUTER a b c',
      'R1 a b 1k',
      'XIN b c INNER',
      '.ends',
      '.subckt INNER p q',
      'R2 p q 2k',
      '.ends',
      'V1 x 0 DC 5',
      'X1 x y 0 OUTER',
      '.end',
    ].join('\n'));
    const resistors = doc.components.filter((c) => c.type === 'resistor');
    expect(resistors.length).toBe(2);
    const r2 = resistors.find((r) => r.parameters.resistance === 2000);
    expect(r2).toBeDefined();
    // INNER's q pin maps to OUTER's c → X1's third pin → node 0 → grounded.
    const ground = doc.components.find((c) => c.type === 'ground')!;
    expect(doc.wires.some((w) =>
      (w.from.componentId === r2!.id && w.from.terminalId === 'b') ||
      (w.to.componentId === r2!.id && w.to.terminalId === 'b'),
    )).toBe(true);
    expect(doc.wires.some((w) =>
      w.from.componentId === ground.id || w.to.componentId === ground.id,
    )).toBe(true);
  });

  it('does not instantiate subckt DEFINITION bodies at top level', () => {
    // A definition with no call contributes nothing.
    const doc = parseSpiceNetlist([
      'unused def',
      '.subckt NEVERCALLED a b',
      'R1 a b 1k',
      '.ends',
      'V1 1 0 5',
      'R2 1 0 1k',
      '.end',
    ].join('\n'));
    expect(doc.components.filter((c) => c.type === 'resistor').length).toBe(1);
  });
});

describe('parseSpiceNetlist: ground aliases + cards', () => {
  it('treats gnd/GND node names as ground', () => {
    const doc = parseSpiceNetlist('V1 1 GND DC 5\nR1 1 gnd 1k\n.end\n');
    expect(doc.components.some((c) => c.type === 'ground')).toBe(true);
    // both source negative terminal and resistor b must be wired to ground
    const ground = doc.components.find((c) => c.type === 'ground')!;
    const v = doc.components.find((c) => c.type === 'dcVoltage')!;
    const r = doc.components.find((c) => c.type === 'resistor')!;
    const grounded = (id: string, term: string) => doc.wires.some((w) =>
      (w.from.componentId === id && w.from.terminalId === term && w.to.componentId === ground.id) ||
      (w.to.componentId === id && w.to.terminalId === term && w.from.componentId === ground.id),
    );
    expect(grounded(v.id, 'n')).toBe(true);
    expect(grounded(r.id, 'b')).toBe(true);
  });

  it('skips a bare title line (no phantom component)', () => {
    const doc = parseSpiceNetlist('My Circuit Title\nV1 1 0 5\nR1 1 0 1k\n.end\n');
    expect(doc.components.filter((c) => c.type === 'nmos').length).toBe(0);
    expect(doc.components.filter((c) => c.type === 'dcVoltage').length).toBe(1);
  });

  it('keeps a first line that IS a well-formed element card', () => {
    const doc = parseSpiceNetlist('V1 1 0 5\nR1 1 0 1k\n.end\n');
    expect(doc.components.filter((c) => c.type === 'dcVoltage').length).toBe(1);
  });

  it('resolves the .MODEL name on an M card with inline L=/W= params', () => {
    const doc = parseSpiceNetlist([
      'mos test',
      '.model MYNMOS NMOS(VTO=2 KP=0.1)',
      'M1 d g s MYNMOS L=5u W=20u',
      'V1 d 0 10',
      '.end',
    ].join('\n'));
    const m = doc.components.find((c) => c.type === 'nmos');
    expect(m).toBeDefined();
    expect(m!.parameters.Vto).toBeCloseTo(2, 9);
    expect(m!.parameters.Kp).toBeCloseTo(0.1, 9);
    expect(m!.parameters.L).toBeCloseTo(5e-6, 12);
    expect(m!.parameters.W).toBeCloseTo(20e-6, 12);
  });

  it('resolves the .MODEL name on a Q card with a substrate node', () => {
    const doc = parseSpiceNetlist([
      'bjt test',
      '.model QP PNP(BF=150)',
      'Q1 1 2 3 4 QP',
      'V1 1 0 5',
      '.end',
    ].join('\n'));
    const q = doc.components.find((c) => c.type === 'pnp');
    expect(q).toBeDefined();
    expect(q!.parameters.hfe).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SPICE export: acVoltage offset round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('exportSPICENetlist: acVoltage', () => {
  it('exports SINE(offset amp freq) — offset is no longer discarded', () => {
    const plugin = getPlugin('acVoltage')!;
    const params: any = {};
    for (const p of plugin.parameters) params[p.key] = p.default;
    const doc: CircuitDocument = {
      version: 1,
      components: [{
        id: 'V1', type: 'acVoltage', position: { x: 0, y: 0 }, rotation: 0,
        parameters: { ...params, offset: 2.5, amplitude: 1, frequency: 1000 },
      }],
      wires: [],
    };
    const net = exportSPICENetlist(doc);
    const line = net.split('\n').find((l) => l.startsWith('VV1'))!;
    expect(line).toBeDefined();
    expect(line).toContain('SINE(2.5 1 1000)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Store: undo integrity + noConnect hygiene + rotated routing
// ─────────────────────────────────────────────────────────────────────────────

describe('store: app-layer fixes', () => {
  beforeEach(() => {
    useEditor.getState().clear();
    useEditor.setState({ past: [], future: [], noConnects: [], netClasses: [] });
  });

  it('addNetClass is undoable WITHOUT a manual pushHistory', () => {
    const s = useEditor.getState();
    s.addComponent('resistor', { x: 5, y: 5 });
    const before = useEditor.getState().past.length;
    s.addNetClass('Power');
    expect(useEditor.getState().netClasses.length).toBe(1);
    expect(useEditor.getState().past.length).toBe(before + 1);
    s.undo();
    expect(useEditor.getState().netClasses.length).toBe(0);
  });

  it('deleteComponent drops dangling No-Connect markers', () => {
    const s = useEditor.getState();
    const id = s.addComponent('resistor', { x: 5, y: 5 });
    s.addNoConnect(id, 'a');
    expect(useEditor.getState().noConnects.length).toBe(1);
    s.deleteComponent(id);
    expect(useEditor.getState().noConnects.length).toBe(0);
  });

  it('deleteSelected drops dangling No-Connect markers too', () => {
    const s = useEditor.getState();
    const id = s.addComponent('resistor', { x: 5, y: 5 });
    s.addNoConnect(id, 'b');
    s.setMultiSelection({ components: new Set([id]), wires: new Set() });
    s.deleteSelected();
    expect(useEditor.getState().noConnects.length).toBe(0);
  });

  it('undo restores noConnects removed by deleteComponent', () => {
    const s = useEditor.getState();
    const id = s.addComponent('resistor', { x: 5, y: 5 });
    s.addNoConnect(id, 'a');
    s.deleteComponent(id);
    expect(useEditor.getState().noConnects.length).toBe(0);
    s.undo();
    // the pre-delete snapshot still has the marker + the component
    expect(useEditor.getState().noConnects.length).toBe(1);
    expect(useEditor.getState().components.length).toBe(1);
  });

  it('completeWire routes between ROTATED terminal positions', () => {
    const s = useEditor.getState();
    const v1 = s.addComponent('dcVoltage', { x: 4, y: 6 });
    const r1 = s.addComponent('resistor', { x: 10, y: 6 });
    // Rotate the resistor 90° — its 'a'/'b' pins swap vertical/horizontal offsets.
    const rot = s.rotateComponent(r1);
    expect(rot).toBeUndefined(); // rotateComponent returns void
    const comp = useEditor.getState().components.find((c) => c.id === r1)!;
    expect(comp.rotation).toBe(1);
    s.startWire({ componentId: v1, terminalId: 'p' }, { x: 5, y: 7 });
    s.completeWire({ componentId: r1, terminalId: 'a' });
    const wire = useEditor.getState().wires[0];
    expect(wire).toBeDefined();
    expect(wire.from.componentId).toBe(v1);
    expect(wire.to.componentId).toBe(r1);
    expect(wire.to.terminalId).toBe('a');
    // The smart router's waypoints (when produced) must END near the ROTATED
    // 'a' pin position, not the unrotated one. Resistor bb is 4x2 with pins at
    // (0,1)/(4,1); after 90° rotation pin 'a' orbits the (2,1) center to
    // (2,-1) rel → absolute (12,5).
    if (wire.waypoints && wire.waypoints.length > 0) {
      const lastWp = wire.waypoints[wire.waypoints.length - 1];
      expect(Math.abs(lastWp.x - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(lastWp.y - 5)).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Smart wire router: rotation-aware terminal math
// ─────────────────────────────────────────────────────────────────────────────

describe('smart-wire-router: rotation', () => {
  function plugins(): Map<string, ComponentPlugin> {
    return new Map(getAllPlugins().map((p) => [p.type, p]));
  }
  function comp(type: string, id: string): CircuitComponent {
    const p = getPlugin(type)!;
    const d: any = {};
    for (const pm of p.parameters) d[pm.key] = pm.default;
    return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: d };
  }

  it('snapToNearestTerminal uses the rotated pin position', () => {
    const r = comp('resistor', 'R1');
    r.position = { x: 10, y: 5 };
    r.rotation = 1; // 90°: 'a' pin (0,1) orbits center (2,1) → (2,-1) rel → (12,4)
    const snapped = snapToNearestTerminal({ x: 11.8, y: 4.2 }, [r], plugins(), 0.5);
    expect(snapped.x).toBe(12);
    expect(snapped.y).toBe(4);
  });

  it('getWireGridPath endpoints honor rotation', () => {
    const v = comp('dcVoltage', 'V1');
    v.position = { x: 0, y: 0 };
    const r = comp('resistor', 'R1');
    r.position = { x: 10, y: 5 };
    r.rotation = 1;
    const w: Wire = { id: 'w1', from: { componentId: 'V1', terminalId: 'p' }, to: { componentId: 'R1', terminalId: 'a' } };
    const path = getWireGridPath(w, [v, r], plugins());
    const last = path[path.length - 1];
    expect(last.x).toBe(12);
    expect(last.y).toBe(4);
  });

  it('buildRoutingGrid blocks the ROTATED body extents (w↔h swapped)', () => {
    const r = comp('resistor', 'R1');
    r.position = { x: 5, y: 5 };
    r.rotation = 1; // body occupies 2 wide × 4 tall now
    const grid = buildRoutingGrid([r], [], plugins(), { width: 20, height: 20 });
    // new tall extent is blocked...
    expect(grid.cells[8][6]).toBe('blocked');
    // ...and the area that the UNROTATED body used to cover is free
    expect(grid.cells[5][8]).toBe('free');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Share URL hardening
// ─────────────────────────────────────────────────────────────────────────────

describe('share-url: payload validation', () => {
  it('round-trips a real document', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [{ id: 'R1', type: 'resistor', position: { x: 1, y: 1 }, rotation: 0, parameters: { resistance: 1000 } }],
      wires: [],
    };
    const url = createShareURL(doc);
    const restored = loadFromShareURL(url.slice(url.indexOf('#')));
    expect(restored).not.toBeNull();
    expect(restored!.components.length).toBe(1);
  });

  it('returns null for a valid-base64 non-document payload', () => {
    const payload = Buffer.from(JSON.stringify({ foo: 1 }), 'utf-8').toString('base64url');
    expect(loadFromShareURL(`#circuit=${payload}`)).toBeNull();
  });

  it('returns null for a payload with non-array components', () => {
    const payload = Buffer.from(JSON.stringify({ components: {}, wires: [] }), 'utf-8').toString('base64url');
    expect(loadFromShareURL(`#circuit=${payload}`)).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(loadFromShareURL('#circuit=not-base64-$$$')).toBeNull();
    expect(loadFromShareURL('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Memory cleanup prefix registry completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('memory.ts: state-prefix registry', () => {
  it('contains every stateful prefix found in components/*.ts', () => {
    // The four that were missing at audit time:
    expect(COMP_ID_STATE_PREFIXES).toContain('dcmotor');
    expect(COMP_ID_STATE_PREFIXES).toContain('opampRails');
    expect(COMP_ID_STATE_PREFIXES).toContain('opto');
    expect(COMP_ID_STATE_PREFIXES).toContain('xfmr_lm');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Hierarchy + subcircuit recursion guards
// ─────────────────────────────────────────────────────────────────────────────

describe('recursion guards', () => {
  it('flattenHierarchy terminates on a self-referencing (cyclic) sheet', async () => {
    const { flattenHierarchy } = await import('../src/lib/circuit/hierarchy');
    const sheet = { id: 's1', sheetName: 'loop', fileName: 'loop.sch', position: { x: 0, y: 0 }, size: { width: 4, height: 3 }, pins: [] };
    const doc = {
      version: 1 as const,
      components: [],
      wires: [],
      sheets: [sheet],
    };
    // "loop.sch" contains a sheet box that points back at loop.sch → cycle.
    const childSheets: any = {
      'loop.sch': {
        version: 1,
        components: [{ id: 'R1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0 as const, parameters: { resistance: 1000 } }],
        wires: [],
        sheets: [sheet],
      },
    };
    const flat = flattenHierarchy(doc, childSheets);
    // R1 inlined exactly once, not infinitely.
    expect(flat.components.filter((c: any) => c.type === 'resistor').length).toBe(1);
  });

  it('sibling boxes may still instantiate the SAME sheet file twice', async () => {
    const { flattenHierarchy } = await import('../src/lib/circuit/hierarchy');
    const mkSheet = (id: string, name: string) => ({
      id, sheetName: name, fileName: 'sub.sch', position: { x: 0, y: 0 }, size: { width: 4, height: 3 }, pins: [],
    });
    const doc = {
      version: 1 as const,
      components: [],
      wires: [],
      sheets: [mkSheet('s1', 'a'), mkSheet('s2', 'b')],
    };
    const childSheets: any = {
      'sub.sch': {
        version: 1,
        components: [{ id: 'R1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0 as const, parameters: { resistance: 1000 } }],
        wires: [],
      },
    };
    const flat = flattenHierarchy(doc, childSheets);
    // two instances (a.R1 + b.R1), not one — multi-instance stays legal.
    expect(flat.components.filter((c: any) => c.id.endsWith('.R1')).length).toBe(2);
  });

  it('a self-referencing sub-circuit definition does not blow the stack at stamp time', async () => {
    const { createSubCircuitPlugin } = await import('../src/lib/circuit/subcircuit');
    const def = {
      type: 'selfy',
      name: 'Selfy',
      description: 'self-referencing subcircuit',
      pins: [{ id: 'a', label: 'A', position: { x: 0, y: 0 } }, { id: 'b', label: 'B', position: { x: 4, y: 0 } }],
      document: {
        version: 1 as const,
        components: [
          { id: 'inner', type: 'selfy', position: { x: 0, y: 0 }, rotation: 0 as const, parameters: {} },
          { id: 'r', type: 'resistor', position: { x: 0, y: 2 }, rotation: 0 as const, parameters: { resistance: 1000 } },
        ],
        wires: [],
      },
      pinMap: [
        { pinId: 'a', componentId: 'r', terminalId: 'a' },
        { pinId: 'b', componentId: 'r', terminalId: 'b' },
      ],
      boundingBox: { width: 5, height: 2 },
    };
    // Registering the plugin makes getPlugin('selfy') resolve — without the
    // guard, stamping an instance would recurse through the inner 'selfy'.
    const { registerPlugin } = await import('../src/lib/circuit/registry');
    registerPlugin(createSubCircuitPlugin(def as any));
    const plugin = getPlugin('selfy')!;
    const fakeSys: any = {
      nextExtra: 0,
      addExtra: () => 0,
      stampConductance: () => {},
      stampVoltageSource: () => {},
      stampCurrentSource: () => {},
    };
    const fakeSim: any = { state: {}, nodeVoltage: [], dt: 1e-4 };
    expect(() =>
      plugin.stamp!({} as any, [{ terminalId: 'a', nodeId: 1 }, { terminalId: 'b', nodeId: 2 }], fakeSys, fakeSim, { id: 'X1', type: 'selfy', position: { x: 0, y: 0 }, rotation: 0, parameters: {} } as any),
    ).not.toThrow();
  });
});
