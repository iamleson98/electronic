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
      expect(net, e.name).not.toMatch(/^X/m);
      expect(net, e.name).not.toMatch(/ (pulseSource|currentSource|ground|oscilloscope|speaker)\s*$/m);
      expect(() => parseSpiceNetlist(net), e.name).not.toThrow();
    }
  });

  it('circuits built from SPICE primitives come back with the identical DC operating point', () => {
    let checked = 0;
    for (const e of all) {
      const net = exportSPICENetlist(e.doc, e.name);
      if (/WARNING: \d+ part/.test(net)) continue; // has parts SPICE has no primitive for
      if (/Schmitt|Differential/.test(e.name)) continue; // VCVS has no output rails (documented)
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
