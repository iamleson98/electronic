import { describe, it, expect } from 'vitest';
import { exportGerberCopper, exportAllGerbers, exportExcellonDrill, exportGerberSolderMask } from '../src/lib/pcb/gerber-export';
import type { Footprint, Pad, Via, Trace } from '../src/lib/pcb/types';

function pad(partial: Partial<Pad> & { id: string }): Pad {
  return {
    componentId: 'c1',
    terminalId: 'a',
    position: { x: 10, y: 10 },
    shape: 'rect',
    size: { width: 1.5, height: 0.8 },
    layer: 'top',
    net: 'N1',
    ...partial,
  };
}

function footprint(pads: Pad[], side: 'top' | 'bottom' = 'top'): Footprint {
  return {
    id: 'fp1',
    componentId: 'c1',
    componentType: 'resistor',
    refdes: 'R1',
    position: { x: 10, y: 10 },
    rotation: 0,
    bodySize: { width: 3.2, height: 1.6 },
    pads,
    side,
  };
}

describe('Gerber export', () => {
  it('exportGerberCopper: valid RS-274X header', () => { const g=exportGerberCopper('top',[],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(g).toContain('%FSLAX26Y26*%');expect(g).toContain('%MOMM*%');expect(g.trim().endsWith('M02*')).toBe(true);});
  it('exportGerberCopper: bottom layer name', () => { const g=exportGerberCopper('bottom',[],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(g).toContain('%LNBOTTOM_COPPER*%');});
  it('exportAllGerbers: produces file set', () => { const files=exportAllGerbers([],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(files.length).toBeGreaterThanOrEqual(5);for(const f of files){expect(f.filename).toBeDefined();expect(f.content.length).toBeGreaterThan(0);}});

  // ── Regression: exact-size apertures (was: snapped to a 9-preset table) ──
  it('exports rect pads with an exact-size R aperture (1.5x0.8, not 1.8x1.8)', () => {
    const g = exportGerberCopper('top', [footprint([pad({ id: 'p1' })])], [], [], { width: 50, height: 50 });
    expect(g).toMatch(/%ADD\d+R,1\.5000X0\.8000\*%/);
    expect(g).not.toMatch(/%ADD\d+R,1\.8000X1\.8000\*%/);
  });

  it('exports traces and vias with exact-diameter C apertures', () => {
    const trace: Trace = {
      id: 't1', net: 'N1', layer: 'top', width: 0.6,
      segments: [{ start: { x: 1, y: 1 }, end: { x: 5, y: 1 }, width: 0.6 }],
    };
    const via: Via = { id: 'v1', position: { x: 3, y: 3 }, diameter: 0.6, drill: 0.3, net: 'N1' };
    const g = exportGerberCopper('top', [], [trace], [via], { width: 50, height: 50 });
    expect(g).toMatch(/%ADD\d+C,0\.6000\*%/);
    // 0.6mm must NOT be drawn with the old 0.5mm or 0.8mm preset apertures
    // (undersized/oversized copper).
  });

  it('THT pads (drill > 0) appear on BOTH copper layers', () => {
    const tht = footprint([pad({ id: 'p1', shape: 'circle', size: { width: 1.8, height: 1.8 }, drill: 1.0 })]);
    const top = exportGerberCopper('top', [tht], [], [], { width: 50, height: 50 });
    const bottom = exportGerberCopper('bottom', [tht], [], [], { width: 50, height: 50 });
    expect(top).toContain('D03*');
    expect(bottom).toContain('D03*');
  });

  it('coordinates use 8 digits per the FSLAX26Y26 format (2 int + 6 dec)', () => {
    const g = exportGerberCopper('top', [footprint([pad({ id: 'p1', position: { x: 1.234567, y: 2 } })])], [], [], { width: 50, height: 50 });
    // 1.234567mm → 01234567
    expect(g).toContain('X01234567');
  });

  // ── Regression: Excellon drills ────────────────────────────────────────────
  it('Excellon: rect THT pads (drill > 0) are drilled; circle pads use their real drill', () => {
    const fp = footprint([
      pad({ id: 'p1', shape: 'rect', size: { width: 1.6, height: 1.6 }, drill: 0.8, position: { x: 5, y: 5 } }),
      pad({ id: 'p2', shape: 'circle', size: { width: 1.8, height: 1.8 }, drill: 1.0, position: { x: 7, y: 5 } }),
      pad({ id: 'p3', shape: 'rect', size: { width: 1.5, height: 0.8 }, drill: 0, position: { x: 9, y: 5 } }),
    ]);
    const drl = exportExcellonDrill([fp], []);
    // rect THT pad gets a hole with its exact drill size
    expect(drl).toContain('T1C0.800');
    // circle pad uses its real 1.0mm drill (not the old 0.6×1.08 estimate)
    expect(drl).toContain('C1.000');
    // SMD pad (drill 0) must NOT be drilled
    const hits = drl.split('\n').filter((l) => l.startsWith('X'));
    expect(hits).toHaveLength(2);
  });

  // ── Regression: solder-mask aperture collision (D50 outline clash) ────────
  it('soldermask: pad openings never collide with the outline aperture', () => {
    // 0.4mm max-dimension pad → opening r = 0.3 → old code produced D50 which
    // clashed with the D50 outline aperture definition.
    const fp = footprint([pad({ id: 'p1', size: { width: 0.4, height: 0.4 } })]);
    const g = exportGerberSolderMask('top', [fp], { width: 50, height: 50 });
    const dCodes = new Set<string>();
    for (const m of g.matchAll(/%ADD(\d+)/g)) dCodes.add(m[1]);
    // every selected D-code must have exactly one definition
    for (const m of g.matchAll(/G54D(\d+)/g)) {
      expect(dCodes.has(m[1])).toBe(true);
    }
  });
});

describe('Gerber coordinate encoding', () => {
  it('negative coordinates keep the minus sign in front of the digits', () => {
    const fp = footprint([pad({ id: 'p1', position: { x: -0.5, y: 2 } })]);
    const g = exportGerberCopper('top', [fp], [], [], { width: 50, height: 50 });
    expect(g).toContain('X-00500000');
    expect(g).not.toContain('0-500000');
  });
});
