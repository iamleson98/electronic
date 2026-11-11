// JLCPCB-convention fab outputs: CPL, Excellon PTH/NPTH, silkscreen clearance,
// Gerber X2 attributes + syntax, Protel file names.
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { exampleCategories } from '../src/lib/circuit/examples';
import { createPCBFromSchematic } from '../src/lib/pcb/netlist-sync';
import { getFootprintDef } from '../src/lib/pcb/footprints';
import { runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import {
  exportJlcCpl, exportPickAndPlace, exportExcellonDrill, exportDrillMap, exportAllGerbers, exportAllGerbersX2,
  buildSilkGeometry, distSegmentRect, needsPin1Marker, SILK_CENTER_CLEARANCE, SILK_PAD_CLEARANCE, MASK_EXPANSION,
  exportGerberCopper, exportGerberX2Copper, fabY, fabRotation,
} from '../src/lib/pcb/gerber-export';
import type { Footprint, Pad } from '../src/lib/pcb/types';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';
import { getPlugin } from '../src/lib/circuit/registry';

const examples = exampleCategories.flatMap((c) => c.examples);
const ex = (name: string) => examples.find((e) => e.name === name)!;
const board555 = () => createPCBFromSchematic(ex('555 Astable Blink').doc.components, ex('555 Astable Blink').doc.wires);

const part = (id: string, type: string, params: Record<string, unknown> = {}, refdes?: string): CircuitComponent => {
  const pl = getPlugin(type)!;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, ...(refdes ? { refdes } : {}),
    parameters: { ...Object.fromEntries(pl.parameters.map((p) => [p.key, p.default])), ...params } } as CircuitComponent;
};
const wire = (a: string, b: string): Wire => {
  const [ca, ta] = a.split(':'); const [cb, tb] = b.split(':');
  return { id: `${a}-${b}`, from: { componentId: ca, terminalId: ta }, to: { componentId: cb, terminalId: tb } };
};

const mkPad = (o: Partial<Pad> & { id: string }): Pad => ({
  componentId: 'c', terminalId: 'a', position: { x: 0, y: 0 }, shape: 'rect', size: { width: 1, height: 1 }, layer: 'top', ...o,
});
const mkFp = (o: Partial<Footprint> & { refdes: string; pads: Pad[] }): Footprint => ({
  id: o.refdes, componentId: o.refdes, componentType: 'resistor', position: { x: 10, y: 10 }, rotation: 0,
  bodySize: { width: 3.2, height: 1.6 }, side: 'top', ...o,
});

describe('JLCPCB CPL', () => {
  const { footprints } = board555();
  const cpl = exportJlcCpl(footprints).split('\n');

  it('header is exactly Designator,Mid X,Mid Y,Layer,Rotation; rows are plain mm numbers', () => {
    expect(cpl[0]).toBe('Designator,Mid X,Mid Y,Layer,Rotation');
    expect(cpl.length).toBeGreaterThan(1);
    for (const row of cpl.slice(1)) expect(row).toMatch(/^[A-Z]+\d+,-?\d+\.\d{4},-?\d+\.\d{4},(Top|Bottom),\d+(\.\d+)?$/);
  });

  it('SMT parts only: the DIP-8 555, the input header and ground symbols are not placed', () => {
    const refs = cpl.slice(1).map((r) => r.split(',')[0]);
    expect(refs.some((r) => /^R/.test(r))).toBe(true);
    expect(refs).not.toContain('U1');
    expect(refs.some((r) => /^J/.test(r))).toBe(false);
    // …but the generic list still has everything physical
    expect(exportPickAndPlace(footprints)).toContain('U1,');
  });

  it('Mid = pad bounding-box centre, Y negated like the Gerbers; rotation CCW (IPC-7351 / KiCad zero)', () => {
    const fp = mkFp({
      refdes: 'R9', position: { x: 20, y: 8 }, rotation: 90, footprintName: 'R_1206_3216Metric',
      pads: [mkPad({ id: 'a', position: { x: 20, y: 6.5 }, size: { width: 1.8, height: 1.15 } }), mkPad({ id: 'b', position: { x: 20, y: 9.5 }, size: { width: 1.8, height: 1.15 } })],
    });
    const row = exportJlcCpl([fp]).split('\n')[1].split(',');
    expect(+row[1]).toBeCloseTo(20, 6);
    expect(+row[2]).toBeCloseTo(fabY(8), 6);
    expect(+row[2]).toBeCloseTo(-8, 6); // same frame as the Gerber flash Y
    expect(row[3]).toBe('Top');
    expect(+row[4]).toBe(fabRotation(90)); // editor +90° is clockwise on screen → 270° CCW
    const g = exportGerberCopper('top', [fp], [], [], { width: 40, height: 30 });
    expect(g).toContain(`X0020000000Y-0006500000D03*`);
  });

  it('origin is NOT the Mid: an off-centre footprint (SOT-23: pads span x −1.675…+1.675) reports the pad-box centre', () => {
    const def = getFootprintDef('npn', { part: 'MMBT3904' });
    const fp = mkFp({
      refdes: 'Q1', componentType: 'npn', position: { x: 15, y: 12 }, bodySize: def.bodySize,
      pads: def.pads.map((p, i) => mkPad({ id: String(i), number: p.number, terminalId: p.terminalId, position: { x: 15 + p.position.x, y: 12 + p.position.y }, size: p.size })),
    });
    const row = exportJlcCpl([fp]).split('\n')[1].split(',');
    expect(+row[1]).toBeCloseTo(15, 4); // pads 1,2 at −0.9375, pad 3 at +0.9375, equal widths → centred
    expect(+row[2]).toBeCloseTo(-12, 4);
    // an asymmetric pad set shifts Mid away from the origin
    const lop = mkFp({ refdes: 'D1', componentType: 'diode', position: { x: 5, y: 5 }, pads: [mkPad({ id: 'k', position: { x: 4, y: 5 }, size: { width: 1, height: 1 } }), mkPad({ id: 'a', position: { x: 8, y: 5 }, size: { width: 1, height: 1 } })] });
    expect(+exportJlcCpl([lop]).split('\n')[1].split(',')[1]).toBeCloseTo(6, 6);
  });

  it('bottom side: Layer Bottom, X not mirrored, rotation = (180 − θ) mod 360 (JLC KiCad-tooling convention)', () => {
    const base = { refdes: 'R3', footprintName: 'R_1206_3216Metric', pads: [mkPad({ id: 'a', position: { x: 9, y: 10 } }), mkPad({ id: 'b', position: { x: 12, y: 10 }, layer: 'bottom' })] };
    const rowOf = (rotation: number) => exportJlcCpl([mkFp({ ...base, side: 'bottom', rotation, pads: base.pads.map((p) => ({ ...p, layer: 'bottom' as const })) })]).split('\n')[1].split(',');
    expect(rowOf(0)[3]).toBe('Bottom');
    expect(+rowOf(0)[1]).toBeCloseTo(10.5, 6);
    expect(+rowOf(0)[4]).toBe(180);
    expect(+rowOf(90)[4]).toBe((180 - fabRotation(90) + 720) % 360); // 270° CCW → −90 → 270
    expect(+rowOf(270)[4]).toBe(((180 - fabRotation(270)) % 360 + 360) % 360);
  });

  it('no name-regex hack: SOT-23 / diode names get 0 correction; component parameter cplRotationOffset overrides', () => {
    const fp = mkFp({ refdes: 'D1', componentId: 'd1', componentType: 'diode', footprintName: 'SOT-23', pads: [mkPad({ id: 'a' })] });
    expect(exportJlcCpl([fp]).split('\n')[1].split(',')[4]).toBe('0');
    const comp = { ...part('d1', 'diode'), parameters: { cplRotationOffset: 180 } } as CircuitComponent;
    expect(exportJlcCpl([fp], { components: [comp] }).split('\n')[1].split(',')[4]).toBe('180');
    const rotated = { ...fp, rotation: 90 };
    expect(exportJlcCpl([rotated], { components: [{ ...comp, parameters: { cplRotationOffset: 90 } } as CircuitComponent] }).split('\n')[1].split(',')[4]).toBe('0'); // 270 + 90
  });

  it('bundle: pick_and_place.csv is the JLC CPL', () => {
    const files = exportAllGerbers(footprints, [], [], { width: 50, height: 40 });
    expect(files.find((f) => f.filename === 'pick_and_place.csv')!.content.split('\n')[0]).toBe('Designator,Mid X,Mid Y,Layer,Rotation');
  });
});

describe('Excellon PTH / NPTH', () => {
  const hole = getFootprintDef('mountingHole');
  const mh = mkFp({
    refdes: 'H1', componentType: 'mountingHole', position: { x: 4, y: 4 },
    pads: [mkPad({ id: 'mh', position: { x: 4, y: 4 }, shape: 'circle', size: { width: 3.2, height: 3.2 }, drill: 3.2, plated: false })],
  });
  const tht = mkFp({ refdes: 'J1', componentType: 'ammeter', position: { x: 20, y: 10 },
    pads: [mkPad({ id: 'p1', position: { x: 20, y: 10 }, shape: 'circle', size: { width: 1.7, height: 1.7 }, drill: 1.0 })] });
  const slot = mkFp({ refdes: 'J2', componentType: 'ammeter', position: { x: 30, y: 10 },
    pads: [mkPad({ id: 's', position: { x: 30, y: 10 }, shape: 'oval', size: { width: 2.2, height: 1.2 }, drill: 0.8, slot: { width: 2.0, height: 0.8 } })] });
  const via = { id: 'v', position: { x: 12, y: 12 }, diameter: 0.6, drill: 0.3, net: 'A' };

  it('the mounting-hole footprint exists, is NPTH and has no copper in the Gerber', () => {
    expect(hole.pads).toHaveLength(1);
    expect(hole.pads[0]).toMatchObject({ drill: 3.2, plated: false });
    expect(hole.name).toMatch(/M3/);
    expect(exportGerberCopper('top', [mh], [], [], { width: 40, height: 30 })).not.toContain('D03*');
  });

  it('PTH file: pads + vias only, headers, tool table ascending, decimal metric', () => {
    const d = exportExcellonDrill([mh, tht], [via], 'pth').split('\n');
    expect(d[0]).toBe('M48');
    expect(d).toContain('METRIC');
    expect(d).toContain(';TYPE=PLATED');
    expect(d.some((l) => /TF\.FileFunction,Plated,1,2,PTH/.test(l))).toBe(true);
    expect(d).toContain('FMAT,2');
    expect(d.filter((l) => /^T\d+C/.test(l))).toEqual(['T1C0.300', 'T2C1.000']); // the 3.2 mm mounting hole is NOT here
    expect(d.filter((l) => /^X/.test(l))).toEqual(['X12.000Y-12.000', 'X20.000Y-10.000']);
    expect(d[d.length - 1]).toBe('M30');
  });

  it('NPTH file: only the mounting hole, ;TYPE=NON_PLATED', () => {
    const d = exportExcellonDrill([mh, tht], [via], 'npth').split('\n');
    expect(d).toContain(';TYPE=NON_PLATED');
    expect(d.some((l) => /TF\.FileFunction,NonPlated,1,2,NPTH/.test(l))).toBe(true);
    expect(d.filter((l) => /^T\d+C/.test(l))).toEqual(['T1C3.200']);
    expect(d.filter((l) => /^X/.test(l))).toEqual(['X4.000Y-4.000']);
  });

  it('oval holes are routed slots (G85) with the slot width as the tool', () => {
    const d = exportExcellonDrill([slot], [], 'pth').split('\n');
    expect(d).toContain('T1C0.800');
    expect(d).toContain('X29.400Y-10.000G85X30.600Y-10.000'); // (2.0 − 0.8)/2 = 0.6 each side of the centre
  });

  it('bundle: drill-PTH.drl always, drill-NPTH.drl only with NPTH holes; job file + drill map list both', () => {
    const noNp = exportAllGerbers([tht], [], [], { width: 50, height: 40 });
    expect(noNp.map((f) => f.filename)).toContain('drill-PTH.drl');
    expect(noNp.map((f) => f.filename)).not.toContain('drill-NPTH.drl');
    expect(noNp.map((f) => f.filename)).not.toContain('drill.drl');
    const files = exportAllGerbersX2([mh, tht], [], [], { width: 50, height: 40 });
    expect(files.map((f) => f.filename)).toEqual(expect.arrayContaining(['drill-PTH.drl', 'drill-NPTH.drl']));
    const job = JSON.parse(files.find((f) => f.filename === 'job.gbrjob')!.content);
    const fns = Object.fromEntries(job.FilesAttributes.map((a: { Path: string; FileFunction: string }) => [a.Path, a.FileFunction]));
    expect(fns['drill-PTH.drl']).toBe('Plated,1,2,PTH');
    expect(fns['drill-NPTH.drl']).toBe('NonPlated,1,2,NPTH');
    expect(fns['top_copper.gbr']).toBe('Copper,L1,Top');
    expect(fns['bottom_copper.gbr']).toBe('Copper,L2,Bot');
    expect(fns['top_soldermask.gbr']).toBe('Soldermask,Top');
    expect(fns['edge_cuts.gbr']).toBe('Profile,NP');
    const map = exportDrillMap([mh, tht, slot], [via]);
    expect(map).toMatch(/3\.200mm {2}x1 {2}NPTH/);
    expect(map).toMatch(/PTH \(plated\)/);
    expect(map).toMatch(/1 slot, G85/);
  });

  it('DRC: an NPTH mounting hole has no annular-ring error', () => {
    const errs = runDRC([mh], [], [], [], { width: 40, height: 30 }, DEFAULT_DRC_CONFIG);
    expect(errs.filter((e) => e.type === 'annular_ring')).toEqual([]);
  });
});

describe('silkscreen keeps ≥ 0.15 mm from pads and marks pin 1', () => {
  const minDist = (fps: Footprint[], layer: 'top' | 'bottom') => {
    const geo = buildSilkGeometry(layer, fps);
    const rects = fps.flatMap((fp) => fp.pads.filter((p) => (p.drill ?? 0) > 0 || p.layer === layer || fp.side === layer).map((p) => ({
      x0: p.position.x - p.size.width / 2, y0: p.position.y - p.size.height / 2, x1: p.position.x + p.size.width / 2, y1: p.position.y + p.size.height / 2,
    })));
    let worst = Infinity;
    for (const [a, b] of geo.segments) for (const r of rects) worst = Math.min(worst, distSegmentRect(a, b, r));
    let worstDot = Infinity;
    for (const d of geo.dots) for (const r of rects) worstDot = Math.min(worstDot, distSegmentRect({ x: d.x, y: d.y }, { x: d.x, y: d.y }, r) - d.r);
    return { geo, worst, worstDot };
  };

  it('the rule constants are the JLC numbers', () => {
    expect(SILK_PAD_CLEARANCE).toBe(0.15);
    expect(SILK_CENTER_CLEARANCE).toBeCloseTo(0.15 + MASK_EXPANSION + 0.075, 9);
  });

  it('555 board: no outline / text segment or pin-1 dot touches a pad (was 7/7 parts crossing)', () => {
    const { footprints } = board555();
    const { geo, worst, worstDot } = minDist(footprints, 'top');
    expect(geo.segments.length).toBeGreaterThan(footprints.length * 2);
    expect(worst).toBeGreaterThanOrEqual(SILK_CENTER_CLEARANCE - 1e-6);
    expect(worstDot).toBeGreaterThanOrEqual(SILK_PAD_CLEARANCE + MASK_EXPANSION - 1e-6);
  });

  it('every example board, both sides: silk is ≥ 0.15 mm (edge) from every pad', () => {
    for (const e of examples) {
      let fps: Footprint[];
      try { fps = createPCBFromSchematic(e.doc.components, e.doc.wires).footprints; } catch { continue; }
      for (const side of ['top', 'bottom'] as const) {
        const flipped = side === 'bottom' ? fps.map((f) => ({ ...f, side: 'bottom' as const, pads: f.pads.map((p) => ({ ...p, layer: 'bottom' as const })) })) : fps;
        const { worst, worstDot } = minDist(flipped, side);
        expect(worst, `${e.name} (${side}) silk stroke`).toBeGreaterThanOrEqual(SILK_CENTER_CLEARANCE - 1e-6);
        expect(worstDot, `${e.name} (${side}) pin-1 dot`).toBeGreaterThanOrEqual(SILK_PAD_CLEARANCE + MASK_EXPANSION - 1e-6);
      }
    }
  });

  it('pin-1 marker only on polarised parts: IC, transistor, diode, LED, header — not resistor/capacitor', () => {
    const { footprints } = board555();
    for (const fp of footprints) {
      const expected = fp.pads.length >= 3 || ['led', 'diode', 'dcVoltage'].includes(fp.componentType);
      expect(needsPin1Marker(fp), fp.refdes).toBe(expected);
    }
    const dots = buildSilkGeometry('top', footprints).dots;
    expect(dots.length).toBe(footprints.filter(needsPin1Marker).length);
  });

  it('bottom-side designator text is mirrored about its own centre', () => {
    const mk = (side: 'top' | 'bottom') => mkFp({ refdes: 'L1', side, position: { x: 30, y: 30 }, bodySize: { width: 0.2, height: 0.2 }, pads: [] });
    const key = (segs: [{ x: number; y: number }, { x: number; y: number }][], mirror: boolean) =>
      segs.map(([a, b]) => { const f = (x: number) => (mirror ? 60 - x : x); return [[f(a.x), a.y], [f(b.x), b.y]].map((p) => p.map((v) => v.toFixed(5)).join(':')).sort().join('|'); }).sort();
    const top = buildSilkGeometry('top', [mk('top')]).segments;
    const bottom = buildSilkGeometry('bottom', [mk('bottom')]).segments;
    expect(top.length).toBeGreaterThan(5);
    expect(key(bottom, false)).toEqual(key(top, true)); // bottom = top reflected about x = 30 (text reads right when the board is turned over)
    expect(key(bottom, false)).not.toEqual(key(top, false)); // 'L1' is not mirror-symmetric
  });
});

/** Minimal Gerber syntax checker (RS-274X / X2). Returns a list of problems. */
function checkGerber(text: string, expectFunction?: RegExp): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] !== 'M02*') problems.push('does not end with M02*');
  if (lines.filter((l) => l === 'M02*').length !== 1) problems.push('M02* must appear exactly once');
  const defined = new Set<number>();
  let selected = false, tf = 0, fsSeen = false, moSeen = false, taOpen = false;
  for (const [i, line] of lines.entries()) {
    const at = `line ${i + 1} "${line}"`;
    if (line.startsWith('%')) {
      if (!line.endsWith('*%')) { problems.push(`unbalanced % block: ${at}`); continue; }
      if ((line.match(/%/g) ?? []).length !== 2) problems.push(`stray %: ${at}`);
      if (line.startsWith('%FS')) fsSeen = true;
      if (line.startsWith('%MO')) moSeen = true;
      let m: RegExpExecArray | null;
      if ((m = /^%ADD(\d+)[A-Z]/.exec(line))) {
        const n = +m[1];
        if (n < 10) problems.push(`D-code < 10 defined: ${at}`);
        if (defined.has(n)) problems.push(`D${n} defined twice`);
        defined.add(n);
        taOpen = false;
      }
      if (line.startsWith('%TA.')) {
        if (taOpen) problems.push(`TA without aperture: ${at}`);
        taOpen = true;
      }
      if (line.startsWith('%TD.AperFunction') || line === '%TD*%') taOpen = false;
      if (line.startsWith('%TF.')) tf++;
      if (/^%TO\.P,/.test(line)) { const f = line.slice(6, -2).split(','); if (f.length < 2 || !/^[A-Za-z]+\d+$/.test(f[0]) || !/^[A-Za-z0-9]+$/.test(f[1])) problems.push(`bad TO.P: ${at}`); }
      if (/^%TO\.N,/.test(line) && /,(unconnected|)\*%$/.test(line)) problems.push(`bad TO.N: ${at}`);
      continue;
    }
    if (taOpen && line.startsWith('X')) problems.push(`flash/draw while TA open: ${at}`);
    if (line.startsWith('G04')) continue;
    if (!line.endsWith('*')) { problems.push(`statement without *: ${at}`); continue; }
    const sel = /^(?:G54)?D(\d+)\*$/.exec(line);
    if (sel) {
      const n = +sel[1];
      if (n >= 10) { if (!defined.has(n)) problems.push(`D${n} selected before definition: ${at}`); selected = true; }
    }
    if (/D0[123]\*$/.test(line) && !/^(G\d+)?D0/.test(line) && !selected && !line.startsWith('G36') && !/^X.*D02\*$/.test(line)) problems.push(`draw before aperture select: ${at}`);
    if (/^X-?\d+Y-?\d+D0[123]\*$/.test(line) && !/^X-?\d{10}Y-?\d{10}D0[123]\*$/.test(line)) problems.push(`coordinate not 4.6: ${at}`);
  }
  if (!fsSeen || !moSeen) problems.push('missing FS/MO');
  if (expectFunction) {
    const ff = lines.find((l) => l.startsWith('%TF.FileFunction,'));
    if (!ff || !expectFunction.test(ff)) problems.push(`FileFunction mismatch: ${ff}`);
  }
  return problems;
}

describe('Gerber X2 attributes + syntax', () => {
  const { footprints, traces } = (() => {
    const b = board555();
    return { footprints: b.footprints, traces: [] as never[] };
  })();
  const board = { width: 50, height: 40 };
  const files = exportAllGerbersX2(footprints, traces, [], board, undefined, { layers: ['top', 'inner1', 'bottom'] });
  const by = (n: string) => files.find((f) => f.filename === n)!.content;

  it('every Gerber of the bundle is syntactically valid', () => {
    for (const f of files.filter((x) => x.filename.endsWith('.gbr'))) {
      expect(checkGerber(f.content), f.filename).toEqual([]);
    }
  });

  it('FileFunction: Copper,Ln,Top|Inr|Bot; Soldermask/Paste/Legend ,Top|Bot; Profile,NP; FilePolarity', () => {
    expect(by('top_copper.gbr')).toContain('%TF.FileFunction,Copper,L1,Top*%');
    expect(by('inner1_copper.gbr')).toContain('%TF.FileFunction,Copper,L2,Inr*%');
    expect(by('bottom_copper.gbr')).toContain('%TF.FileFunction,Copper,L3,Bot*%');
    expect(by('top_soldermask.gbr')).toContain('%TF.FileFunction,Soldermask,Top*%');
    expect(by('bottom_soldermask.gbr')).toContain('%TF.FileFunction,Soldermask,Bot*%');
    expect(by('top_soldermask.gbr')).toContain('%TF.FilePolarity,Negative*%');
    expect(by('top_paste.gbr')).toContain('%TF.FileFunction,Paste,Top*%');
    expect(by('bottom_paste.gbr')).toContain('%TF.FileFunction,Paste,Bot*%');
    expect(by('top_silkscreen.gbr')).toContain('%TF.FileFunction,Legend,Top*%');
    expect(by('bottom_silkscreen.gbr')).toContain('%TF.FileFunction,Legend,Bot*%');
    expect(by('edge_cuts.gbr')).toContain('%TF.FileFunction,Profile,NP*%');
    expect(by('top_copper.gbr')).toContain('%TF.FilePolarity,Positive*%');
    expect(by('edge_cuts.gbr')).toContain('%TF.FilePolarity,Positive*%');
  });

  it('ProjectId carries a GUID shared by every file; creation date has an offset', () => {
    const ids = files.filter((f) => f.filename.endsWith('.gbr')).map((f) => /%TF\.ProjectId,([^,]+),([^,]+),([^,*]+)\*%/.exec(f.content)!);
    for (const m of ids) expect(m[2]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids.map((m) => m[2])).size).toBe(1);
    expect(by('top_copper.gbr')).toMatch(/%TF\.CreationDate,\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00\*%/);
  });

  it('pin attributes are %TO.P,refdes,pin-number (never the component type); missing net is N/C', () => {
    const top = by('top_copper.gbr');
    expect(top).toMatch(/%TO\.P,U1,1\*%/);
    expect(top).not.toMatch(/%TO\.P,[A-Z]+\d+,(timer555|resistor|led|capacitor)\*%/);
    expect(top).not.toContain('unconnected');
    const nc = exportGerberX2Copper('top', [mkFp({ refdes: 'R5', pads: [mkPad({ id: 'a', number: '1', position: { x: 5, y: 5 } })] })], [], [], { width: 20, height: 20 });
    expect(nc).toContain('%TO.N,N/C*%'); // a pad with no net
    expect(top).toMatch(/%TO\.C,R1\*%/);
  });

  it('aperture attributes are attached to apertures (no stray %TA before any aperture)', () => {
    const top = by('top_copper.gbr').split('\n');
    top.forEach((l, i) => { if (l.startsWith('%TA.AperFunction')) expect(top[i + 1], l).toMatch(/^%ADD\d+/); });
    expect(by('top_copper.gbr')).toContain('%TA.AperFunction,ComponentPad*%');
    expect(by('top_copper.gbr')).toContain('%TA.AperFunction,SMDPad,CuDef*%');
  });

  it('X1 bundle also has G01 + valid syntax; Protel/JLC extensions available', () => {
    const x1 = exportAllGerbers(footprints, [], [], board, undefined, { layers: ['top', 'bottom'] });
    for (const f of x1.filter((x) => x.filename.endsWith('.gbr'))) expect(checkGerber(f.content), f.filename).toEqual([]);
    const jlc = exportAllGerbersX2(footprints, [], [], board, undefined, { layers: ['top', 'inner1', 'inner2', 'bottom'], naming: 'protel', name: 'myboard' });
    expect(jlc.map((f) => f.filename)).toEqual(expect.arrayContaining([
      'myboard.GTL', 'myboard.GBL', 'myboard.G1', 'myboard.G2', 'myboard.GTS', 'myboard.GBS', 'myboard.GTO', 'myboard.GBO',
      'myboard.GTP', 'myboard.GBP', 'myboard.GKO', 'drill-PTH.drl', 'pick_and_place.csv', 'job.gbrjob',
    ]));
    // same content as the default naming
    expect(jlc.find((f) => f.filename === 'myboard.GTL')!.content).toContain('%TF.FileFunction,Copper,L1,Top*%');
    const job = JSON.parse(jlc.find((f) => f.filename === 'job.gbrjob')!.content);
    expect(job.FilesAttributes.map((a: { Path: string }) => a.Path)).toContain('myboard.GKO');
    expect(job.GeneralSpecs.LayerNumber).toBe(4);
  });
});

describe('power-input footprint', () => {
  it('a DC source is a 2-pin 2.54 mm THT header: pad 1 (square) = +, pad 2 = −, both drilled', () => {
    for (const t of ['dcVoltage', 'battery', 'acVoltage', 'pulseSource']) {
      const d = getFootprintDef(t);
      expect(d.pads.map((p) => [p.number, p.terminalId, p.drill])).toEqual([['1', 'p', 1.0], ['2', 'n', 1.0]]);
      expect(Math.abs(d.pads[1].position.y - d.pads[0].position.y)).toBeCloseTo(2.54, 9);
      expect(d.pads[0].shape).toBe('rect');
    }
  });
  it('J# refdes, even when the schematic called it BT1 / V1', () => {
    const doc = { components: [part('v', 'dcVoltage', { voltage: 9 }, 'BT1'), part('r', 'resistor', {}, 'R1')], wires: [wire('v:p', 'r:a')] };
    const { footprints } = createPCBFromSchematic(doc.components, doc.wires);
    expect(footprints.find((f) => f.componentId === 'v')!.refdes).toBe('J1');
  });
});
