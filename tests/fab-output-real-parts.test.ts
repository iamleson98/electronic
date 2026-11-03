// Fabrication output must describe the board the editor shows, built from
// real parts:
//  • Gerber / drill / pick-and-place are Y-up — board Y is negated, so the
//    fab gets the layout, not its mirror image (a mirrored board wires every
//    IC and transistor backwards);
//  • real packages: datasheet pin numbers on real DIP / TO-92 / TO-220
//    geometry; pins the model lacks are tied to the right net;
//  • pad extents turn with the part; 1206 land patterns are IPC-nominal;
//  • silkscreen carries designators and pin-1 marks;
//  • DRC flags generic footprints and pins that still need wiring.
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { createPCBFromSchematic, rotatePadSize } from '../src/lib/pcb/netlist-sync';
import { autoRoute } from '../src/lib/pcb/auto-router';
import { runDRC } from '../src/lib/pcb/drc';
import { getFootprintDef } from '../src/lib/pcb/footprints';
import { exportGerberCopper, exportExcellonDrill, exportPickAndPlace, exportGerberSilkscreen, fabY, fabRotation } from '../src/lib/pcb/gerber-export';
import { exampleCategories } from '../src/lib/circuit/examples';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';
import type { Footprint } from '../src/lib/pcb/types';

const ex = (name: string) => exampleCategories.flatMap((c) => c.examples).find((e) => e.name === name)!.doc;
const part = (id: string, type: string): CircuitComponent => {
  const pl = getPlugin(type)!;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: Object.fromEntries(pl.parameters.map((p) => [p.key, p.default])) } as CircuitComponent;
};
const wire = (a: string, b: string): Wire => {
  const [ca, ta] = a.split(':'); const [cb, tb] = b.split(':');
  return { id: `${a}-${b}`, from: { componentId: ca, terminalId: ta }, to: { componentId: cb, terminalId: tb } };
};
/** parse "X…Y…D03*" flashes (4.6 format) into mm */
const flashes = (g: string) => [...g.matchAll(/X(-?\d+)Y(-?\d+)D03\*/g)].map((m) => ({ x: +m[1] / 1e6, y: +m[2] / 1e6 }));

describe('fab files are the layout, not its mirror image', () => {
  it('Y is negated consistently in copper, drill and pick-and-place', () => {
    const fp: Footprint = {
      id: 'u1', componentId: 'u1', componentType: 'timer555', refdes: 'U1', position: { x: 20, y: 10 }, rotation: 90, side: 'top',
      bodySize: { width: 6, height: 10 },
      pads: [
        { id: 'p1', componentId: 'u1', terminalId: 'gnd', position: { x: 16, y: 6 }, shape: 'rect', size: { width: 1.6, height: 1.6 }, layer: 'top', drill: 0.8, number: '1' },
        { id: 'p2', componentId: 'u1', terminalId: 'trig', position: { x: 16, y: 9 }, shape: 'circle', size: { width: 1.6, height: 1.6 }, layer: 'top', drill: 0.8, number: '2' },
      ],
    };
    const cu = flashes(exportGerberCopper('top', [fp], [], [], { width: 40, height: 30 }));
    // pin 1 is ABOVE pin 2 on screen (smaller board y) → higher Gerber Y
    const g1 = cu.find((p) => Math.abs(p.x - 16) < 1e-6 && Math.abs(p.y - fabY(6)) < 1e-6);
    const g2 = cu.find((p) => Math.abs(p.x - 16) < 1e-6 && Math.abs(p.y - fabY(9)) < 1e-6);
    expect(g1 && g2).toBeTruthy();
    expect(g1!.y).toBeGreaterThan(g2!.y);
    const drl = exportExcellonDrill([fp], []);
    expect(drl).toContain('X16.000Y-6.000');
    const pnp = exportPickAndPlace([fp]).split('\n')[1].split(',');
    expect(+pnp[3]).toBeCloseTo(-10, 6);
    expect(+pnp[4]).toBe(fabRotation(90)); // editor +90° is clockwise on screen → 270° CCW
    expect(fabRotation(90)).toBe(270);
  });
});

describe('real packages with datasheet pinouts', () => {
  it('NE555 is a real DIP-8: pins 1–4 down the left, 5–8 up the right, 2.54 / 7.62 mm', () => {
    const d = getFootprintDef('timer555');
    expect(d.verified).toBe(true);
    const at = (n: string) => d.pads.find((p) => p.number === n)!;
    expect(at('1').terminalId).toBe('gnd');
    expect(at('3').terminalId).toBe('out');
    expect(at('4').terminalId).toBe('rst');
    expect(at('5').terminalId).toBe('ctrl');
    expect(at('8').terminalId).toBe('vcc');
    expect(at('1').position.x).toBeCloseTo(-3.81, 6);
    expect(at('8').position.x).toBeCloseTo(3.81, 6);
    expect(at('2').position.y - at('1').position.y).toBeCloseTo(2.54, 6);
    expect(at('8').position.y).toBeCloseTo(at('1').position.y, 6); // pin 8 opposite pin 1
    expect(at('1').shape).toBe('rect'); // square pin-1 pad
  });

  it('TO-92 transistors follow the 2N3904 / 2N3906 / 2N7000 E-B-C / S-G-D order at 1.27 mm', () => {
    for (const [type, order] of [['npn', ['e', 'b', 'c']], ['pnp', ['e', 'b', 'c']], ['nmos', ['s', 'g', 'd']]] as const) {
      const d = getFootprintDef(type);
      expect(d.verified, type).toBe(true);
      const byNum = ['1', '2', '3'].map((n) => d.pads.find((p) => p.number === n)!);
      expect(byNum.map((p) => p.terminalId), type).toEqual(order);
      expect(byNum[1].position.x - byNum[0].position.x).toBeCloseTo(1.27, 6);
    }
  });

  it('a generic IC gets real DIP geometry but stays unverified', () => {
    const d = getFootprintDef('vco');
    expect(d.verified).toBeFalsy();
    const xs = new Set(d.pads.map((p) => Math.abs(p.position.x).toFixed(2)));
    expect([...xs]).toEqual(['3.81']);
  });

  it('CD4026: CLOCK INHIBIT joins GND and DISPLAY ENABLE IN joins VDD on the routed board', () => {
    const doc = ex('Digital Clock (HH:MM:SS)');
    const { footprints, ratsnest, board } = createPCBFromSchematic(doc.components, doc.wires);
    const counters = footprints.filter((f) => f.componentType === 'cd4026');
    expect(counters.length).toBe(6);
    for (const u of counters) {
      const pin = (n: string) => u.pads.find((p) => p.number === n)!;
      expect(pin('2').net, u.refdes).toBe(pin('8').net); // CLK INH ↔ VSS
      expect(pin('3').net, u.refdes).toBe(pin('16').net); // DEI ↔ VDD
      expect(pin('4').net).toBeUndefined(); // DEO left open
    }
    const r = autoRoute(footprints, [], [], ratsnest, board);
    expect(r.stats.failed).toBe(0);
  });
});

describe('pads, land patterns, silkscreen', () => {
  it('pad extents turn with the part', () => {
    expect(rotatePadSize({ width: 1.15, height: 1.8 }, 90)).toEqual({ width: 1.8, height: 1.15 });
    expect(rotatePadSize({ width: 1.15, height: 1.8 }, 180)).toEqual({ width: 1.15, height: 1.8 });
    const doc = ex('Two-Stage Audio Amplifier');
    const { footprints } = createPCBFromSchematic(doc.components, doc.wires);
    for (const f of footprints.filter((x) => x.componentType === 'resistor')) {
      const p = f.pads[0];
      const across = f.rotation % 180 === 0 ? p.size.height : p.size.width;
      expect(across, f.refdes).toBeCloseTo(1.8, 6); // long side across the part, whatever the rotation
    }
  });

  it('1206 resistor/capacitor land: 1.15 × 1.8 mm pads at ±1.5 mm (IPC-7351 nominal)', () => {
    for (const t of ['resistor', 'capacitor']) {
      const d = getFootprintDef(t);
      expect(d.pads.map((p) => p.position.x)).toEqual([-1.5, 1.5]);
      expect(d.pads[0].size).toEqual({ width: 1.15, height: 1.8 });
    }
    // LED / diode: pad 1 = cathode (KiCad convention, feeder orientation)
    expect(getFootprintDef('led').pads.find((p) => p.number === '1')!.terminalId).toBe('k');
  });

  it('silkscreen draws every designator and a pin-1 dot', () => {
    const doc = ex('555 Astable Blink');
    const { footprints, board } = createPCBFromSchematic(doc.components, doc.wires);
    const silk = exportGerberSilkscreen('top', footprints, board);
    const strokes = (silk.match(/D01\*/g) ?? []).length;
    expect(strokes).toBeGreaterThan(footprints.length * 4 + 20); // outlines alone are 4 per part
    const dots = silk.split('G54D11*')[1] ?? '';
    expect((dots.match(/D03\*/g) ?? []).length).toBe(footprints.filter((f) => f.pads.some((p) => p.number === '1') && f.pads.length >= 2).length);
  });
});

describe('DRC flags what would make the board wrong', () => {
  it('the ideal op-amp needs its supply pins wired; generic footprints are flagged', () => {
    const comps = [part('u1', 'opamp'), part('v1', 'dcVoltage'), part('r1', 'resistor'), part('g', 'ground'), part('x1', 'vco')];
    const wires = [wire('v1:p', 'r1:a'), wire('r1:b', 'u1:in+'), wire('u1:out', 'u1:in-'), wire('v1:n', 'g:g'), wire('x1:gnd', 'g:g'), wire('x1:vcc', 'v1:p'), wire('x1:in', 'u1:out')];
    const { footprints, ratsnest, board } = createPCBFromSchematic(comps, wires);
    const errs = runDRC(footprints, [], [], ratsnest, board);
    const supply = errs.filter((e) => e.type === 'unwired_required_pin');
    expect(supply.map((e) => e.message).join('\n')).toMatch(/pin 4: V− supply[\s\S]*pin 7: V\+ supply/);
    expect(errs.some((e) => e.type === 'unverified_footprint' && /vco/.test(e.message))).toBe(true);
    expect(errs.some((e) => e.type === 'unverified_footprint' && /timer555|opamp/.test(e.message))).toBe(false);
  });
});
