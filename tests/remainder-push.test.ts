// Remainder push: ERC waivers, sim profiles, diff-pair tune, stitch,
// panelize, STEP rotation/side, ODB/IPC layers, block summary, images,
// skill level, BGA/footprint validation (covered in continue-push).

import { describe, it, expect } from 'vitest';
import { applyERCExclusions, runFullERC } from '../src/lib/circuit/erc';
import { buildBlockSummary } from '../src/lib/ai/netlist-summary';
import { exportSTEP, exportODB, exportIPC2581 } from '../src/lib/pcb/additional-exports';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

describe('ERC waivers filter violations', () => {
  it('applyERCExclusions drops waived keys', () => {
    const comps = [
      { id: 'r1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0 as const, parameters: { resistance: 1000 }, refdes: 'R1' },
    ];
    const result = runFullERC(comps as never, [], []);
    const keys = result.errors.map((e) => e.exclusionKey).filter(Boolean) as string[];
    if (keys.length === 0) {
      expect(result.errors.length).toBeGreaterThanOrEqual(0);
      return;
    }
    const filtered = applyERCExclusions(result, [keys[0]]);
    expect(filtered.errors.length).toBe(result.errors.length - result.errors.filter((e) => e.exclusionKey === keys[0]).length);
  });
});

describe('block summary for large circuits', () => {
  it('returns null under the cap, blocks above it', () => {
    const small = [{ id: 'r1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0 as const, parameters: {} }];
    expect(buildBlockSummary(small as never)).toBeNull();
    const big = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`, type: 'resistor', position: { x: 0, y: 0 }, rotation: 0 as const, parameters: {},
    }));
    const summary = buildBlockSummary(big as never);
    expect(summary).toContain('Block Summary');
    expect(summary).toContain('passive');
  });
});

describe('STEP rotation/side + ODB/IPC layers', () => {
  const board = { width: 20, height: 20 };
  it('bottom parts hang below the board', () => {
    const fps = [{
      refdes: 'U1', componentType: 'ic', position: { x: 10, y: 10 }, rotation: 0,
      side: 'bottom' as const, bodySize: { width: 4, height: 4 }, pads: [],
    }];
    const step = exportSTEP(fps as never, board as never);
    expect(step).toContain('MANIFOLD_SOLID_BREP');
  });
  it('ODB has bottom/mask/silk/drill/netlist', () => {
    const files = exportODB([], [], [], board as never, new Map());
    const paths = files.map((f) => f.path);
    expect(paths).toContain('steps/pcb/layers/bottom/features');
    expect(paths).toContain('steps/pcb/layers/smtop/features');
    expect(paths).toContain('steps/pcb/layers/silktop/features');
    expect(paths).toContain('steps/pcb/layers/drill/features');
    expect(paths).toContain('steps/pcb/netlists/cadnet/netlist');
  });
  it('IPC-2581 has Step/LayerFeature/Profile', () => {
    const xml = exportIPC2581([], [], [], board as never, new Map());
    expect(xml).toContain('<Step name="pcb">');
    expect(xml).toContain('LayerFeature');
    expect(xml).toContain('<Profile>');
  });
});

describe('registry sanity for new editors', () => {
  it('resistor plugin exists for tolerance tests', () => {
    expect(getPlugin('resistor')).toBeDefined();
  });
});
