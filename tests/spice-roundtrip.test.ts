// SPICE export must be a netlist ngspice / LTspice can actually run and
// that behaves like the circuit in this app; importing it back must give the
// same circuit. Before: ground / probes / speakers / 555s were written as
// undefined X-subcircuit calls (the netlist failed to load anywhere,
// including our own importer), pulse and current sources had the part TYPE
// as their value, every LED was a 1N4148, and imported MOSFETs ignored
// their model parameters.
import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { exportSPICENetlist } from '../src/lib/circuit/netlist-export';
import { parseSpiceNetlist } from '../src/lib/circuit/spice';
import { toSpiceExpr, fromSpiceExpr } from '../src/lib/circuit/spice-expr';
import { exampleCategories } from '../src/lib/circuit/examples';
import { solveDC } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, CircuitDocument, ComponentPlugin } from '../src/lib/circuit/types';

const plugins = (cs: CircuitComponent[]) => {
  const m = new Map<string, ComponentPlugin>();
  for (const c of cs) { const p = getPlugin(c.type); if (p) m.set(c.type, p); }
  return m;
};
const dcLevels = (d: CircuitDocument) => {
  const r = solveDC(d.components, d.wires, plugins(d.components));
  return r ? [...r.nodeVoltage].map((v) => +v.toFixed(3) + 0).sort((a, b) => a - b) : null; // + 0: no −0
};
const all = exampleCategories.flatMap((c) => c.examples);

describe('SPICE export → import', () => {
  it('every example exports a loadable netlist with no undefined subcircuits', () => {
    for (const e of all) {
      const net = exportSPICENetlist(e.doc, e.name);
      // every X call names a .subckt defined in the same file
      for (const m of net.matchAll(/^X\S*.* (\S+)$/gm)) {
        expect(net, `${e.name}: ${m[1]}`).toMatch(new RegExp(`^\\.subckt ${m[1]} `, 'm'));
      }
      expect(net, e.name).not.toMatch(/ (pulseSource|currentSource|ground|oscilloscope|speaker)\s*$/m);
      expect(() => parseSpiceNetlist(net), e.name).not.toThrow();
    }
  });

  it('circuits built from SPICE primitives come back with the identical DC operating point', () => {
    let checked = 0;
    for (const e of all) {
      const net = exportSPICENetlist(e.doc, e.name);
      if (/WARNING: \d+ part/.test(net)) continue; // has parts SPICE has no primitive for
      expect(dcLevels(parseSpiceNetlist(net)), e.name).toEqual(dcLevels(e.doc));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it('parts without a SPICE primitive are named in a warning instead of breaking the file', () => {
    const net = exportSPICENetlist(all.find((e) => e.name === '555 Astable Blink')!.doc);
    expect(net).toMatch(/\* WARNING: 1 part\(s\) have no SPICE primitive[\s\S]*\(timer555\)/);
  });

  it('per-part models keep each part\'s own behaviour through the round trip', () => {
    const c = (id: string, type: string, parameters: Record<string, number | string | boolean>) =>
      ({ id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...Object.fromEntries(getPlugin(type)!.parameters.map((p) => [p.key, p.default])), ...parameters } }) as CircuitComponent;
    const w = (a: string, ta: string, b: string, tb: string) => ({ id: `${a}${ta}${b}${tb}`, from: { componentId: a, terminalId: ta }, to: { componentId: b, terminalId: tb } });
    const doc: CircuitDocument = {
      version: 1,
      components: [
        c('v1', 'dcVoltage', { voltage: 9 }), c('led1', 'led', { forwardV: 2.1 }), c('q1', 'npn', { hfe: 57, vbe: 0.66 }),
        c('m1', 'nmos', { vth: 1.7, kp: 0.3, lambda: 0.01 }), c('p1', 'pulseSource', { low: 0, high: 5, frequency: 1000, duty: 25 }),
        c('am', 'ammeter', {}), c('r1', 'resistor', { resistance: 470 }), c('g', 'ground', {}),
      ],
      wires: [w('v1', 'p', 'am', 'p'), w('am', 'n', 'r1', 'a'), w('r1', 'b', 'led1', 'a'), w('led1', 'k', 'q1', 'c'), w('q1', 'e', 'g', 'g'),
        w('p1', 'p', 'm1', 'g'), w('m1', 's', 'g', 'g'), w('m1', 'd', 'q1', 'b'), w('v1', 'n', 'g', 'g'), w('p1', 'n', 'g', 'g')],
    };
    const net = exportSPICENetlist(doc);
    expect(net).toMatch(/^Vam .* 0 ; ammeter/m);
    expect(net).toMatch(/PULSE\(0 5 0 [^ ]+ [^ ]+ [^ ]+ 1\.000m\)/);
    const back = parseSpiceNetlist(net);
    const get = (type: string) => back.components.find((x) => x.type === type)!;
    expect(get('led').parameters.forwardV).toBeCloseTo(2.1, 2);
    expect(get('npn').parameters.hfe).toBe(57);
    expect(get('npn').parameters.vbe).toBeCloseTo(0.66, 2);
    expect(get('nmos').parameters.vth).toBeCloseTo(1.7, 6);
    expect(get('nmos').parameters.kp).toBeCloseTo(0.3, 6);
    expect(get('pulseSource').parameters.duty).toBeCloseTo(25, 1);
    // a PNP model written LTspice-style, "PNP(…)", stays a PNP
    const pnp = parseSpiceNetlist(`* t
Q1 c b e QP
.model QP PNP(Is=1f Bf=80)
.end`).components.find((x) => x.type === 'pnp' || x.type === 'npn')!;
    expect(pnp.type).toBe('pnp');
    expect(pnp.parameters.hfe).toBe(80);
  });

  it('imports LTspice-style inline comments and MOSFETs without W/L as W = L', () => {
    const d = parseSpiceNetlist(`* t
V1 in 0 DC 5 ; supply
M1 out in 0 0 MN
R1 vdd out 1k ; load
V2 vdd 0 DC 10
.model MN NMOS(Level=1 Vto=1 Kp=2m)
.end`);
    const m = d.components.find((c) => c.type === 'nmos')!;
    expect(m.parameters.kp).toBeCloseTo(2e-3, 9); // was ×10 (W/L defaulted to 10)
    expect(d.components.find((c) => c.type === 'dcVoltage' && c.parameters.voltage === 5)).toBeDefined();
  });
});

describe('op-amps and behavioural sources run in a real SPICE', () => {
  const opampDoc = (type: string, params: Record<string, number> = {}) => {
    const c = (id: string, t: string, p: Record<string, number> = {}) =>
      ({ id, type: t, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...Object.fromEntries(getPlugin(t)!.parameters.map((x) => [x.key, x.default])), ...p } }) as CircuitComponent;
    const pl = getPlugin(type)!;
    const pin = (re: RegExp) => pl.terminals.find((t) => re.test(t.id))!.id;
    const w = (a: string, ta: string, b: string, tb: string) => ({ id: `${a}${ta}${b}${tb}`, from: { componentId: a, terminalId: ta }, to: { componentId: b, terminalId: tb } });
    const rails = pl.terminals.some((t) => /^(v\+|vcc)$/.test(t.id));
    return {
      version: 1,
      components: [c('vin', 'dcVoltage', { voltage: 0.5 }), c('u1', type, params), c('rf', 'resistor', { resistance: 10e3 }), c('rg', 'resistor', { resistance: 1e3 }), c('g', 'ground'),
        ...(rails ? [c('vp', 'dcVoltage', { voltage: 12 }), c('vn', 'dcVoltage', { voltage: 12 })] : [])],
      wires: [w('vin', 'p', 'u1', pin(/^(in\+|inp)$/)), w('u1', 'out', 'rf', 'a'), w('rf', 'b', 'u1', pin(/^(in-|inn)$/)), w('rg', 'a', 'u1', pin(/^(in-|inn)$/)), w('rg', 'b', 'g', 'g'), w('vin', 'n', 'g', 'g'),
        ...(rails ? [w('vp', 'p', 'u1', pin(/^(v\+|vcc)$/)), w('vp', 'n', 'g', 'g'), w('vn', 'p', 'g', 'g'), w('vn', 'n', 'u1', pin(/^(v-|vee)$/))] : [])],
    } as CircuitDocument;
  };

  it('every op-amp part exports a behavioural .subckt (pole, slew, rails, Rout) and comes back identical', () => {
    for (const type of ['opamp', 'opampRails', 'opampReal', 'lm741', 'lm358', 'tl072', 'ne5532', 'lm324']) {
      if (!getPlugin(type)) continue;
      const doc = opampDoc(type);
      const net = exportSPICENetlist(doc);
      expect(net, type).toMatch(/^\.subckt OA_u1 inp inn out/m);
      expect(net, type).toMatch(new RegExp(`^\\* circuit-lab part=${type} `, 'm'));
      expect(net.split('.subckt')[0], type).not.toMatch(/^E/m); // no bare top-level VCVS any more
      if (getPlugin(type)!.opampModel!.spec(doc.components[1].parameters).gbw < Infinity) {
        expect(net, type).toMatch(/^Cpole p 0 /m);
        expect(net, type).toMatch(/^Bclamp p 0 I=/m);
      }
      const back = parseSpiceNetlist(net);
      const u = back.components.find((x) => x.type === type)!;
      expect(u, type).toBeDefined();
      expect(u.parameters, type).toEqual(doc.components[1].parameters);
      expect(dcLevels(back), type).toEqual(dcLevels(doc));
    }
  });

  it('the non-inverting stage saturates at the rail in the exported model, as in the app', () => {
    const doc = opampDoc('opampRails');
    doc.components[0].parameters.voltage = 2; // ×11 → 22 V, past the +11.5 V window
    const net = exportSPICENetlist(doc);
    expect(net).toMatch(/V\(vcc\)-0\.5/); // output window follows the actual rails
    expect(Math.max(...dcLevels(doc)!)).toBeCloseTo(12, 6);
  });

  it('if() / limit() / log() are written in ngspice syntax and read back unchanged', () => {
    const net = exportSPICENetlist(all.find((e) => e.name === 'Behavioral Signal Chain')!.doc);
    const b = net.split('\n').filter((l) => /^B/.test(l));
    expect(b.length).toBeGreaterThan(0);
    for (const l of b) expect(l).not.toMatch(/\bif\(|\blimit\(/);
    expect(net).toMatch(/\? \(4\) : \(0\)/);
    expect(fromSpiceExpr(toSpiceExpr('2*if(V(a) > 1, limit(V(b), -1, 1), log(V(c)))')))
      .toBe('2*if(V(a) > 1, max(-1, min(V(b), 1)), ln(V(c)))');
    expect(fromSpiceExpr('V(a) > 1 ? 2 : V(b) < 0 ? 3 : 4')).toBe('if(V(a) > 1, 2, if(V(b) < 0, 3, 4))');
  });
});
