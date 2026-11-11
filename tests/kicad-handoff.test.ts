// Part identity, pinouts, BOM and the KiCad handoff:
//  • transistor pads follow the chosen PART's datasheet (BC547 = C-B-E, not the symbol's default)
//  • unused op-amp / comparator channels get the safe termination
//  • BOM rows carry real values + the PCB's actual package, never an invented MPN
//  • the KiCad netlist uses real library footprints and datasheet pad numbers
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { DISCRETE_PARTS, discretePartFor } from '../src/lib/circuit/part-presets';
import { getFootprintDef } from '../src/lib/pcb/footprints';
import { REAL_PINOUTS } from '../src/lib/pcb/real-packages';
import { createPCBFromSchematic } from '../src/lib/pcb/netlist-sync';
import { exportBOM } from '../src/lib/pcb/additional-exports';
import { generateBOM, exportBOMForJLC, exportBOMForPCBWay } from '../src/lib/circuit/bom-export';
import { buildBOMRows, buildKiCadModel, exportKiCadNetlist, exportKiCadNetlistXml } from '../src/lib/circuit/netlist-export';
import { exampleCategories } from '../src/lib/circuit/examples';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, CircuitDocument, Wire } from '../src/lib/circuit/types';

const part = (id: string, type: string, params: Record<string, unknown> = {}, refdes?: string): CircuitComponent => {
  const pl = getPlugin(type)!;
  return {
    id, type, position: { x: 0, y: 0 }, rotation: 0, ...(refdes ? { refdes } : {}),
    parameters: { ...Object.fromEntries(pl.parameters.map((p) => [p.key, p.default])), ...params },
  } as CircuitComponent;
};
const wire = (a: string, b: string): Wire => {
  const [ca, ta] = a.split(':'); const [cb, tb] = b.split(':');
  return { id: `${a}-${b}`, from: { componentId: ca, terminalId: ta }, to: { componentId: cb, terminalId: tb } };
};

describe('per-part discrete pinouts', () => {
  for (const [type, list] of Object.entries(DISCRETE_PARTS)) {
    for (const d of list) {
      it(`${d.part} (${type}, ${d.pkg}): pad N carries the datasheet terminal`, () => {
        const def = getFootprintDef(type, { part: d.part });
        expect(def.pads.length).toBe(3);
        for (const [num, term] of Object.entries(d.map)) {
          expect(def.pads.find((p) => p.number === num)?.terminalId, `pad ${num}`).toBe(term);
        }
        // geometry per package
        const xs = def.pads.map((p) => p.position.x);
        if (d.pkg === 'TO-92') expect(xs).toEqual([-1.27, 0, 1.27]);
        if (d.pkg === 'TO-220') expect(xs).toEqual([-2.54, 0, 2.54]);
        if (d.pkg === 'SOT-23') {
          // KiCad Package_TO_SOT_SMD:SOT-23: pads 1,2 in the left column, pad 3 alone on the right
          const p1 = def.pads.find((p) => p.number === '1')!, p2 = def.pads.find((p) => p.number === '2')!, p3 = def.pads.find((p) => p.number === '3')!;
          expect(p1.position).toEqual({ x: -0.9375, y: -0.95 });
          expect(p2.position).toEqual({ x: -0.9375, y: 0.95 });
          expect(p3.position).toEqual({ x: 0.9375, y: 0 });
          expect(p1.size).toEqual({ width: 1.475, height: 0.6 });
          expect(p1.drill).toBeUndefined();
        }
      });
      it(`${d.part}: PCB footprint + KiCad netlist agree with the part map`, () => {
        const q = part('q', type, { part: d.part }, 'Q1');
        const terms = Object.values(d.map);
        const comps = [q, ...terms.map((t) => part(`r_${t}`, 'resistor', { resistance: 1000 }, `R_${t}`.toUpperCase().replace(/\W/g, '')))];
        const wires = terms.map((t) => wire(`q:${t}`, `r_${t}:a`));
        const doc: CircuitDocument = { version: 1, components: comps, wires };
        const { footprints } = createPCBFromSchematic(doc.components, doc.wires);
        const fp = footprints.find((f) => f.componentId === 'q')!;
        for (const [num, term] of Object.entries(d.map)) expect(fp.pads.find((p) => p.number === num)!.terminalId).toBe(term);
        expect(fp.footprintName).toContain(d.part);
        const model = buildKiCadModel(doc);
        expect(model.comps.find((c) => c.ref === 'Q1')!.footprint).toBe(d.kicadFootprint);
        for (const [num, term] of Object.entries(d.map)) {
          const rRef = `R_${term}`.toUpperCase().replace(/\W/g, '');
          const net = model.nets.find((n) => n.nodes.some((x) => x.ref === rRef && x.pin === '1'))!;
          expect(net.nodes.find((x) => x.ref === 'Q1')?.pin, `${term} → pad`).toBe(num);
        }
      });
    }
  }

  it('BC547 differs from 2N3904 on the same symbol; unknown part falls back to the default', () => {
    expect(getFootprintDef('npn', { part: 'BC547B' }).pads.find((p) => p.number === '1')!.terminalId).toBe('c');
    expect(getFootprintDef('npn', { part: '2N3904' }).pads.find((p) => p.number === '1')!.terminalId).toBe('e');
    expect(getFootprintDef('npn').pads.find((p) => p.number === '1')!.terminalId).toBe(discretePartFor('npn')!.map[1]);
  });

  it('Gummel-Poon BJTs and Level-1 MOSFETs resolve like the basic parts', () => {
    expect(getFootprintDef('bjtGPNpn', { part: 'BC547B' }).pads.find((p) => p.number === '1')!.terminalId).toBe('c');
    expect(getFootprintDef('bjtGPPnp', { part: 'BC557B' }).pads.find((p) => p.number === '3')!.terminalId).toBe('e');
    expect(getFootprintDef('mosLevel1N', { part: 'IRF540N' }).pads.map((p) => p.terminalId)).toEqual(['g', 'd', 's']);
    expect(getFootprintDef('mosLevel1P', { part: 'BSS84' }).pads.map((p) => p.terminalId)).toEqual(['g', 's', 'd']);
  });
});

describe('unused op-amp / comparator channels', () => {
  const ampPins = (def: ReturnType<typeof getFootprintDef>, n: number) => def.pads.find((p) => p.number === String(n))!;
  for (const type of ['lm358', 'tl072', 'ne5532']) {
    it(`${type}: spare amp is a follower on the used amp's IN+ (never V−)`, () => {
      const d = getFootprintDef(type);
      expect(ampPins(d, 5).tieTo).toBe('pin3');
      expect(ampPins(d, 6).tieTo).toBe('pin7');
      expect(ampPins(d, 7).tie).toBeUndefined();
    });
  }
  it('lm324: all three spare amps follow IN+ of amp 1', () => {
    const d = getFootprintDef('lm324');
    for (const [inp, inn, out] of [[5, 6, 7], [10, 9, 8], [12, 13, 14]]) {
      expect(ampPins(d, inp).tieTo).toBe('pin3');
      expect(ampPins(d, inn).tieTo).toBe(`pin${out}`);
    }
  });
  it('lm393: spare comparator inputs both at GND, open-collector output open', () => {
    const d = getFootprintDef('lm393');
    expect(ampPins(d, 5).tieTo).toBe('gnd');
    expect(ampPins(d, 6).tieTo).toBe('gnd');
    expect(ampPins(d, 7).tie).toBeUndefined();
    expect(ampPins(d, 7).note).toMatch(/open/);
  });
  it('no op-amp pinout ties anything to the negative supply', () => {
    for (const t of ['lm358', 'tl072', 'ne5532', 'lm324']) {
      for (const pad of getFootprintDef(t).pads) expect(pad.tieTo, `${t} pad ${pad.number}`).not.toBe('vee');
    }
    expect(Object.keys(REAL_PINOUTS)).not.toContain('npn'); // discretes resolve per part now
  });
  it('KiCad netlist wires the parked amp (pin5 on the IN+ net, 6-7 follower net)', () => {
    const doc: CircuitDocument = { version: 1, components: [part('u', 'lm358', {}, 'U1'), part('r', 'resistor', {}, 'R1')], wires: [wire('u:inp', 'r:a')] };
    const m = buildKiCadModel(doc);
    const inpNet = m.nets.find((n) => n.nodes.some((x) => x.ref === 'R1' && x.pin === '1'))!;
    expect(inpNet.nodes.filter((x) => x.ref === 'U1').map((x) => x.pin).sort()).toEqual(['3', '5']);
    expect(m.nets.some((n) => n.nodes.length === 2 && n.nodes.every((x) => x.ref === 'U1') && n.nodes.map((x) => x.pin).sort().join() === '6,7')).toBe(true);
  });
});

describe('BOM correctness', () => {
  const doc = (components: CircuitComponent[]): CircuitDocument => ({ version: 1, components, wires: [] });

  it('three different resistor values give three rows with their real values', () => {
    const bom = generateBOM(doc([
      part('a', 'resistor', { resistance: 10000 }, 'R1'), part('b', 'resistor', { resistance: 47000 }, 'R2'),
      part('c', 'resistor', { resistance: 220 }, 'R3'), part('d', 'resistor', { resistance: 10000 }, 'R4'),
    ]));
    expect(bom.lines.map((l) => `${l.value}:${l.refdes}`).sort()).toEqual(['10k:R1, R4', '220:R3', '47k:R2']);
    for (const l of bom.lines) expect(l.mpn).toBeNull(); // no exact real match → no invented MPN
    expect(buildBOMRows(doc([part('a', 'resistor', { resistance: 10000 }), part('b', 'resistor', { resistance: 47000 })])).length).toBe(2);
  });

  it('values are real: 1µF cap, 4.7k, blue LED, no 1N4148 for arbitrary diodes', () => {
    const bom = generateBOM(doc([
      part('c', 'capacitor', { capacitance: 1e-6 }, 'C1'), part('r', 'resistor', { resistance: 4700 }, 'R1'),
      part('l', 'led', { color: 'blue' }, 'D1'), part('d', 'diode', {}, 'D2'),
    ]));
    const by = (t: string) => bom.lines.find((l) => l.type === t)!;
    expect(by('capacitor').value).toBe('1µF');
    expect(by('resistor').value).toBe('4.7k');
    expect(by('led').value).toBe('LED blue');
    expect(by('led').mpn).toBeNull();
    expect(by('led').manufacturer ?? '').not.toMatch(/Kingbright/);
    expect(by('diode').mpn).toBeNull();
    expect(by('diode').value).not.toBe('1N4148');
  });

  it('Footprint column equals the package the PCB places', () => {
    const comps = [
      part('r', 'resistor', { resistance: 1000 }, 'R1'), part('q', 'npn', { part: 'BC547B' }, 'Q1'),
      part('m', 'nmos', { part: 'IRF540N' }, 'Q2'), part('u', 'timer555', {}, 'U1'), part('s', 'pmos', { part: 'BSS84' }, 'Q3'),
    ];
    const bom = generateBOM(doc(comps));
    const pkgOf = (ref: string) => bom.lines.find((l) => l.refdes.includes(ref))!.package;
    expect(pkgOf('R1')).toBe('1206');
    expect(pkgOf('Q1')).toBe('TO-92');
    expect(pkgOf('Q2')).toBe('TO-220');
    expect(pkgOf('Q3')).toBe('SOT-23');
    expect(pkgOf('U1')).toBe('DIP-8');
    // value of a discrete = its part name; MPN = that real part
    expect(bom.lines.find((l) => l.refdes === 'Q1')).toMatchObject({ value: 'BC547B', mpn: 'BC547B' });
    expect(bom.lines.find((l) => l.refdes === 'U1')).toMatchObject({ value: 'NE555', mpn: 'NE555P' });
    // PCB BOM: same rows, same footprint column
    const { footprints } = createPCBFromSchematic(comps, []);
    const csv = exportBOM(footprints, comps);
    expect(csv.split('\n')[0]).toBe('Designator,Quantity,Footprint,Value,Description,MPN,Manufacturer,LCSC,DigiKey,Mouser,UnitPrice,ExtPrice,DNP');
    expect(csv).toMatch(/"R1",1,"1206","1k"/);
    expect(csv).toMatch(/"Q1",1,"TO-92","BC547B"/);
    expect(csv).toMatch(/"Q3",1,"SOT-23","BSS84"/);
    expect(csv).not.toContain('CC0805');
    // without the schematic the PCB BOM still never lies about the value
    expect(exportBOM(footprints)).toMatch(/"Q1",1,"TO-92","BC547B"/);
  });

  it('JLC format is exact and LCSC is never invented', () => {
    const bom = generateBOM(doc([part('a', 'resistor', { resistance: 1000 }, 'R1'), part('b', 'resistor', { resistance: 1000 }, 'R2'), part('c', 'capacitor', { capacitance: 1e-7 }, 'C1')]));
    const lines = exportBOMForJLC(bom).split('\n');
    expect(lines[0]).toBe('Comment,Designator,Footprint,LCSC Part #');
    expect(lines).toContain('1k,"R1,R2",1206,');
    expect(lines).toContain('100nF,"C1",1206,');
    expect(exportBOMForPCBWay(bom)).toContain('"1k"');
  });
});

describe('KiCad netlist handoff', () => {
  const doc555 = exampleCategories.flatMap((c) => c.examples).find((e) => /555/.test(e.name) && /astable|blink/i.test(e.name))!.doc;
  const net = exportKiCadNetlist(doc555, '555 astable');
  const model = buildKiCadModel(doc555);

  it('parentheses balance and the structure is KiCad version E', () => {
    let depth = 0, inStr = false;
    for (let i = 0; i < net.length; i++) {
      const ch = net[i];
      if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '(') depth++; else if (ch === ')') { depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    }
    expect(depth).toBe(0);
    expect(net.startsWith('(export (version "E")')).toBe(true);
    expect(net).toContain('(components');
    expect(net).toContain('(nets');
    expect(net).toMatch(/\(net \(code "1"\) \(name "[^"]+"\)/);
    expect(net).toMatch(/\(node \(ref "U1"\) \(pin "1"\)\)/);
  });

  it('only real KiCad library footprints; the supply is an input header, ground symbols are not parts', () => {
    expect(model.comps.length).toBeGreaterThan(0);
    for (const c of model.comps) expect(c.footprint, c.ref).toMatch(/^(Resistor_SMD|Capacitor_SMD|LED_SMD|Diode_SMD|Package_DIP|Package_TO_SOT_THT|Package_TO_SOT_SMD|Connector_PinHeader_2\.54mm):[\w.\-]+$/);
    // no ground / simulation source symbol reaches the board…
    expect(model.comps.length).toBe(doc555.components.filter((c) => c.type !== 'ground').length);
    // …but the DC supply is a physical 2-pin input header: J#, 'PWR 9V', pad 1 = +, pad 2 = −
    const supply = doc555.components.find((c) => c.type === 'dcVoltage')!;
    const volts = supply.parameters.voltage as number;
    const j = model.comps.find((c) => /^J\d+$/.test(c.ref))!;
    expect(j).toBeDefined();
    expect(j.value).toBe(`PWR ${parseFloat(volts.toFixed(3))}V`);
    expect(j.footprint).toBe('Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical');
    const rail = model.nets.find((n) => n.nodes.some((x) => x.ref === j.ref && x.pin === '1'))!;
    expect(rail.name).toBe(`+${parseFloat(volts.toFixed(3))}V`);
    expect(model.nets.find((n) => n.nodes.some((x) => x.ref === j.ref && x.pin === '2'))!.name).toBe('GND');
    expect(model.comps.find((c) => c.ref === 'U1')!.footprint).toBe('Package_DIP:DIP-8_W7.62mm');
    expect(model.comps.some((c) => c.footprint === 'Resistor_SMD:R_1206_3216Metric')).toBe(true);
    expect(model.comps.some((c) => c.footprint === 'LED_SMD:LED_1206_3216Metric')).toBe(true);
    expect(model.nets.some((n) => n.name === 'GND')).toBe(true);
  });

  it('power-input mapping is ONE: PCB footprint, BOM, KiCad netlist and refdes agree', () => {
    const v = part('v', 'battery', { voltage: 3.3 }, 'BT7');
    const s = part('s', 'acVoltage', {}, 'V2');
    const r = part('r', 'resistor', { resistance: 1000 }, 'R1');
    const g = part('g', 'ground');
    const doc: CircuitDocument = { version: 1, components: [v, s, r, g], wires: [wire('v:p', 'r:a'), wire('r:b', 's:p'), wire('v:n', 'g:g'), wire('s:n', 'g:g')] };
    const { footprints } = createPCBFromSchematic(doc.components, doc.wires);
    expect(footprints.find((f) => f.componentId === 'g')).toBeUndefined();
    const fv = footprints.find((f) => f.componentId === 'v')!, fs = footprints.find((f) => f.componentId === 's')!;
    expect(fv.refdes).toMatch(/^J\d+$/); expect(fs.refdes).toMatch(/^J\d+$/);
    expect(fv.pads.map((p) => [p.number, p.terminalId])).toEqual([['1', 'p'], ['2', 'n']]);
    expect(fv.pads.every((p) => (p.drill ?? 0) > 0)).toBe(true);
    const bom = generateBOM(doc);
    const lineOf = (ref: string) => bom.lines.find((l) => l.refdes.split(', ').includes(ref))!;
    expect(lineOf(fv.refdes)).toMatchObject({ value: 'PWR 3.3V', package: 'PinHeader-1x02 P2.54' });
    expect(lineOf(fs.refdes)).toMatchObject({ value: 'SIG IN', package: 'PinHeader-1x02 P2.54' });
    expect(bom.lines.some((l) => /BT|ground/i.test(l.refdes + l.value))).toBe(false);
    const m = buildKiCadModel(doc);
    expect(m.comps.find((c) => c.ref === fv.refdes)).toMatchObject({ value: 'PWR 3.3V', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical' });
    expect(m.comps.find((c) => c.ref === fs.refdes)!.value).toBe('SIG IN');
    expect(m.nets.find((n) => n.nodes.some((x) => x.ref === fv.refdes && x.pin === '1'))!.name).toBe('+3.3V');
    // signal source: the net keeps its auto name
    expect(m.nets.find((n) => n.nodes.some((x) => x.ref === fs.refdes && x.pin === '1'))!.name).toMatch(/^N\d+$/);
    // behavioural sources never reach a board
    const b = part('b', 'bvSource', {}, 'B1');
    expect(buildKiCadModel({ version: 1, components: [b], wires: [] }).comps).toEqual([]);
  });

  it('two DC supplies of the same voltage get distinct net names', () => {
    const a = part('a', 'dcVoltage', { voltage: 5 }, 'V1'), b = part('b', 'dcVoltage', { voltage: 5 }, 'V2');
    const r1 = part('r1', 'resistor', {}, 'R1'), r2 = part('r2', 'resistor', {}, 'R2');
    const m = buildKiCadModel({ version: 1, components: [a, b, r1, r2], wires: [wire('a:p', 'r1:a'), wire('b:p', 'r2:a')] });
    const names = m.nets.map((n) => n.name);
    expect(names.filter((n) => n.startsWith('+5V')).sort()).toEqual(['+5V', '+5V_2']);
  });

  it('NE555 pins land on the datasheet nets (1 GND 2 TRIG 3 OUT 4 RESET 5 CTRL 6 THR 7 DIS 8 VCC)', () => {
    const netOf = (pin: string) => model.nets.find((n) => n.nodes.some((x) => x.ref === 'U1' && x.pin === pin));
    expect(netOf('1')?.name).toBe('GND');
    for (const p of ['1', '2', '3', '4', '6', '7', '8']) expect(netOf(p), `pin ${p} connected`).toBeDefined();
    // astable wiring: TRIG(2) = THR(6) = timing cap; RESET(4) = VCC(8); DIS(7) between Ra and Rb
    expect(netOf('2')).toBe(netOf('6'));
    expect(netOf('4')).toBe(netOf('8'));
    expect(netOf('7')).not.toBe(netOf('6'));
    expect(netOf('3')).not.toBe(netOf('8'));
    expect(netOf('1')).not.toBe(netOf('8'));
    // the net of pin 7 holds Ra and Rb (DIS), the net of pin 3 holds the LED resistor
    const refsOn = (n?: { nodes: { ref: string }[] }) => n!.nodes.map((x) => x.ref).filter((r) => r !== 'U1');
    expect(refsOn(netOf('7')).length).toBe(2);
    expect(refsOn(netOf('3')).length).toBe(1);
    // CTRL (pin 5) is not wired in this example: it must not share a net with anything
    expect(netOf('5')?.nodes.length ?? 1).toBe(1);
  });

  it('XML variant agrees', () => {
    const xml = exportKiCadNetlistXml(doc555);
    expect(xml).toContain('<export version="E">');
    expect(xml).toContain('Package_DIP:DIP-8_W7.62mm');
    expect(xml).toMatch(/<node ref="U1" pin="1"\/>/);
  });

  it('a part with no verified footprint is emitted with an empty footprint and an explanation', () => {
    const d: CircuitDocument = { version: 1, components: [part('p', 'potentiometer', {}, 'RV1')], wires: [] };
    const m = buildKiCadModel(d);
    expect(m.comps[0].footprint).toBe('');
    expect(m.comps[0].fields.find((f) => f.name === 'FootprintNote')?.value).toMatch(/KiCad|footprint/);
  });
});
