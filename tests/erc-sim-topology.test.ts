// ERC topology rules that explain simulator failures:
//  • voltage_source_loop — an ideal source shorted by a wire, or ideal
//    sources / inductors closing a loop (singular MNA matrix);
//  • no_dc_path — a net reached only through capacitors (undefined DC level);
// plus: ERC markers sit on the pin of ROTATED parts, and a failed simulation
// names the culprit instead of listing every possible cause.
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/lib/circuit/components';
import { runFullERC } from '../src/lib/circuit/erc';
import { useEditor } from '../src/lib/circuit/store';
import { getPlugin } from '../src/lib/circuit/registry';
import { terminalPos } from '../src/lib/circuit/endpoint-position';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';

const part = (id: string, type: string, params: Record<string, number> = {}, rotation: 0 | 1 | 2 | 3 = 0): CircuitComponent => {
  const pl = getPlugin(type)!;
  const defaults = Object.fromEntries(pl.parameters.map((p) => [p.key, p.default]));
  return { id, type, position: { x: 10, y: 10 }, rotation, parameters: { ...defaults, ...params } } as CircuitComponent;
};
const wire = (a: string, b: string): Wire => {
  const [ca, ta] = a.split(':');
  const [cb, tb] = b.split(':');
  return { id: `${a}-${b}`, from: { componentId: ca, terminalId: ta }, to: { componentId: cb, terminalId: tb } };
};
const of = (type: string, comps: CircuitComponent[], wires: Wire[]) =>
  runFullERC(comps, wires).errors.filter((e) => e.type === type);

describe('voltage_source_loop', () => {
  it('flags a source shorted by a wire', () => {
    const comps = [part('v1', 'dcVoltage'), part('g', 'ground'), part('r', 'resistor')];
    const wires = [wire('v1:p', 'v1:n'), wire('v1:n', 'g:g'), wire('v1:p', 'r:a'), wire('r:b', 'g:g')];
    const e = of('voltage_source_loop', comps, wires);
    expect(e).toHaveLength(1);
    expect(e[0].componentId).toBe('v1');
    expect(e[0].message).toMatch(/shorted/);
  });

  it('flags two ideal sources in parallel, but not sources in series', () => {
    const comps = [part('v1', 'dcVoltage', { voltage: 5 }), part('v2', 'dcVoltage', { voltage: 3 }), part('g', 'ground'), part('r', 'resistor')];
    const parallel = [wire('v1:p', 'v2:p'), wire('v1:n', 'v2:n'), wire('v1:n', 'g:g'), wire('v1:p', 'r:a'), wire('r:b', 'g:g')];
    expect(of('voltage_source_loop', comps, parallel)).toHaveLength(1);
    const series = [wire('v1:p', 'v2:n'), wire('v1:n', 'g:g'), wire('v2:p', 'r:a'), wire('r:b', 'g:g')];
    expect(of('voltage_source_loop', comps, series)).toHaveLength(0);
  });

  it('flags an inductor straight across a DC source (a DC short)', () => {
    const comps = [part('v1', 'dcVoltage'), part('l1', 'inductor'), part('g', 'ground')];
    const wires = [wire('v1:p', 'l1:a'), wire('l1:b', 'v1:n'), wire('v1:n', 'g:g')];
    expect(of('voltage_source_loop', comps, wires)).toHaveLength(1);
  });
});

describe('no_dc_path', () => {
  it('flags a node reached only through capacitors; a bleed resistor clears it', () => {
    const comps = [part('v1', 'dcVoltage'), part('c1', 'capacitor'), part('c2', 'capacitor'), part('g', 'ground')];
    const wires = [wire('v1:p', 'c1:a'), wire('c1:b', 'c2:a'), wire('c2:b', 'g:g'), wire('v1:n', 'g:g')];
    const e = of('no_dc_path', comps, wires);
    expect(e).toHaveLength(1);
    expect(e[0].severity).toBe('warning');
    const fixed = [...comps, part('rb', 'resistor', { resistance: 1e6 })];
    expect(of('no_dc_path', fixed, [...wires, wire('c1:b', 'rb:a'), wire('rb:b', 'g:g')])).toHaveLength(0);
  });

  it('stays quiet on an ordinary RC coupling network', () => {
    const comps = [part('v1', 'acVoltage'), part('c1', 'capacitor'), part('r1', 'resistor'), part('g', 'ground')];
    const wires = [wire('v1:p', 'c1:a'), wire('c1:b', 'r1:a'), wire('r1:b', 'g:g'), wire('v1:n', 'g:g')];
    expect(of('no_dc_path', comps, wires)).toHaveLength(0);
  });
});

describe('ERC marker positions', () => {
  it('an unconnected pin of a ROTATED part is marked at the pin itself', () => {
    const r = part('r1', 'resistor', {}, 1);
    const pl = getPlugin('resistor')!;
    const e = runFullERC([part('g', 'ground'), part('v', 'dcVoltage'), r], [wire('v:n', 'g:g')])
      .errors.filter((x) => x.componentId === 'r1');
    for (const x of e) {
      const t = pl.terminals.find((tt) => tt.id === x.terminalId)!;
      expect(x.position).toEqual(terminalPos(r, t, pl));
    }
  });
});

describe('a failed simulation names the culprit', () => {
  beforeEach(() => {
    useEditor.getState().loadDocument({ version: 1, components: [], wires: [] });
  });

  it('shorted source → message names the source', () => {
    const st = () => useEditor.getState();
    st().loadDocument({
      version: 1,
      components: [part('v1', 'dcVoltage'), part('g', 'ground'), part('r', 'resistor')],
      wires: [wire('v1:p', 'v1:n'), wire('v1:n', 'g:g'), wire('v1:p', 'r:a'), wire('r:b', 'g:g')],
    });
    st().setRunning(true);
    st().step();
    expect(st().simError).toMatch(/v1 is shorted/);
    st().setRunning(false);
  });
});
