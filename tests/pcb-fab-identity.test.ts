// PCB identity + placement regressions:
//  • schematic-only symbols (ground, junction dots, labels, power symbols)
//    never become PCB parts — they used to get a through-hole "GND" pad each
//    and a line in the BOM;
//  • every footprint gets a UNIQUE reference designator (parts with
//    non-numeric ids all came out as a bare "U" / "DSP");
//  • a two-row schematic stays two rows on the board (overlaps used to be
//    separated along the smaller-overlap axis, smearing a row of displays
//    under a row of counters into one scrambled strip).
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { createPCBFromSchematic, assignRefdes } from '../src/lib/pcb/netlist-sync';
import { autoRoute } from '../src/lib/pcb/auto-router';
import { exportBOM } from '../src/lib/pcb/additional-exports';
import { verifyNetlist } from '../src/lib/pcb/netlist-verify';
import { exampleCategories } from '../src/lib/circuit/examples';
import { generateBOMFromComponents } from '../src/lib/circuit/bom-export';
import { getAllPlugins } from '../src/lib/circuit/registry';
import { getFootprintDef, isSchematicOnlyType } from '../src/lib/pcb/footprints';
import type { CircuitComponent } from '../src/lib/circuit/types';

const all = exampleCategories.flatMap((c) => c.examples);
const ex = (name: string) => all.find((e) => e.name === name)!.doc;

describe('schematic-only symbols are not PCB parts', () => {
  it('no example board carries a ground / junction footprint or BOM line', () => {
    for (const e of all) {
      const { footprints } = createPCBFromSchematic(e.doc.components, e.doc.wires);
      const bad = footprints.filter((f) => f.componentType === 'ground' || f.componentType === 'junction');
      expect(bad, e.name).toEqual([]);
      expect(exportBOM(footprints), e.name).not.toMatch(/,ground,|,junction,/);
      const schematicBom = generateBOMFromComponents(e.doc.components);
      expect(schematicBom.lines.map((l) => l.type), e.name).not.toContain('ground');
    }
  });

  it('ground symbols still join the GND net, and netlist verification does not miss them', () => {
    const doc = ex('Two-Stage Audio Amplifier');
    expect(doc.components.filter((c) => c.type === 'ground').length).toBeGreaterThan(1);
    const { footprints, ratsnest, board } = createPCBFromSchematic(doc.components, doc.wires);
    const gndPads = footprints.flatMap((f) => f.pads).filter((p) => p.net === 'GND');
    expect(gndPads.length).toBeGreaterThanOrEqual(5);
    const r = autoRoute(footprints, [], [], ratsnest, board);
    expect(r.stats.failed).toBe(0);
    const v = verifyNetlist(doc.components, doc.wires, footprints, r.traces);
    expect(v.errors.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('reference designators', () => {
  it('every example board has unique designators', () => {
    for (const e of all) {
      const { footprints } = createPCBFromSchematic(e.doc.components, e.doc.wires);
      const refs = footprints.map((f) => f.refdes);
      expect(new Set(refs).size, `${e.name}: ${refs.join(' ')}`).toBe(refs.length);
    }
  });

  it('keeps the schematic refdes, numbers the rest without collisions', () => {
    const c = (id: string, type: string, refdes?: string) =>
      ({ id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: {}, ...(refdes ? { refdes } : {}) }) as CircuitComponent;
    const m = assignRefdes([c('a', 'resistor', 'R2'), c('ic_x', 'opamp'), c('ic_y', 'opamp'), c('r_top', 'resistor'), c('b', 'resistor', 'R2')]);
    expect(m.get('a')).toBe('R2');
    expect(m.get('ic_x')).toBe('U1');
    expect(m.get('ic_y')).toBe('U2');
    expect(m.get('r_top')).toBe('R1');
    expect(m.get('b')).toBe('R3'); // duplicate schematic refdes → renumbered
  });
});

describe('placement keeps the schematic arrangement', () => {
  it('Digital Clock: counters stay a row ABOVE their displays, in order, on a compact board', () => {
    const doc = ex('Digital Clock (HH:MM:SS)');
    const { footprints, ratsnest, board } = createPCBFromSchematic(doc.components, doc.wires);
    const at = (id: string) => footprints.find((f) => f.componentId === id)!.position;
    const counters = ['ic_ht', 'ic_ho', 'ic_mt', 'ic_mo', 'ic_st', 'ic_so'];
    const displays = ['seg_ht', 'seg_ho', 'seg_mt', 'seg_mo', 'seg_st', 'seg_so'];
    for (let i = 0; i < 6; i++) {
      expect(at(displays[i]).y - at(counters[i]).y).toBeGreaterThan(10);
      expect(Math.abs(at(displays[i]).x - at(counters[i]).x)).toBeLessThan(8);
      if (i > 0) expect(at(counters[i]).x).toBeGreaterThan(at(counters[i - 1]).x);
    }
    // the old one-strip layout needed a 173×96 board and 74+ vias
    expect(board.width * board.height).toBeLessThan(120 * 70);
    const r = autoRoute(footprints, [], [], ratsnest, board);
    expect(r.stats.failed).toBe(0);
    // real CD4026 / 5161AS pinouts scramble the segment order between chip and
    // display, so traces must cross (the old invented pinouts needed fewer)
    expect(r.stats.vias).toBeLessThanOrEqual(90);
  });
});

describe('every physical part keeps all its pins on the board', () => {
  it('footprint pads match the schematic pins one-to-one for every registered part', () => {
    const bad: string[] = [];
    for (const p of getAllPlugins()) {
      if (isSchematicOnlyType(p.type)) continue;
      const def = getFootprintDef(p.type);
      const pads = new Set(def.pads.map((x) => x.terminalId));
      const missing = p.terminals.map((t) => t.id).filter((id) => !pads.has(id));
      // a real package may have pins the model lacks — each must say what to do with it
      const extra = def.pads.filter((x) => !p.terminals.some((t) => t.id === x.terminalId) && !x.note).map((x) => x.terminalId);
      if (missing.length || extra.length) bad.push(`${p.type}: missing [${missing}] unexplained extra [${extra}]`);
    }
    expect(bad).toEqual([]);
  });
});

describe('measurement instruments on the board', () => {
  it('scope / voltmeter probes are not parts; an ammeter becomes a jumper header that keeps the circuit closed', () => {
    const amp = ex('Two-Stage Audio Amplifier');
    const { footprints } = createPCBFromSchematic(amp.components, amp.wires);
    expect(footprints.filter((f) => f.componentType === 'oscilloscope' || f.componentType === 'voltmeter')).toEqual([]);
    expect(exportBOM(footprints)).not.toMatch(/oscilloscope|voltmeter/);

    const c = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: {} }) as CircuitComponent;
    const w = (a: string, ta: string, b: string, tb: string) => ({ id: `${a}${ta}${b}${tb}`, from: { componentId: a, terminalId: ta }, to: { componentId: b, terminalId: tb } });
    const comps = [c('v1', 'dcVoltage'), c('am', 'ammeter'), c('r1', 'resistor'), c('g', 'ground')];
    const wires = [w('v1', 'p', 'am', 'p'), w('am', 'n', 'r1', 'a'), w('r1', 'b', 'g', 'g'), w('v1', 'n', 'g', 'g')];
    const pcb = createPCBFromSchematic(comps, wires);
    const am = pcb.footprints.find((f) => f.componentType === 'ammeter')!;
    expect(am.refdes).toMatch(/^J\d+$/);
    expect(am.verified).toBe(true);
    // the header's pins carry the two nets the meter sat between
    const vNet = pcb.footprints.find((f) => f.componentId === 'v1')!.pads.find((p) => p.terminalId === 'p')!.net;
    const rNet = pcb.footprints.find((f) => f.componentId === 'r1')!.pads.find((p) => p.terminalId === 'a')!.net;
    expect(am.pads.map((p) => p.net).sort()).toEqual([vNet, rNet].sort());
  });
});
