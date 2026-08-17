// Tests for net-colors.ts — wire coloring based on net class & net name.

import { describe, it, expect } from 'vitest';
import { buildWireColorMap, getNetNameForWire } from '../src/lib/circuit/net-colors';
import { buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';
import type { CircuitComponent, Wire, NetClass } from '../src/lib/circuit/types';

function mkComp(type: string, id: string, params: Record<string, any> = {}): CircuitComponent {
  const p = getPlugin(type);
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    rotation: 0,
    parameters: { ...(p?.parameters.reduce((a, p) => ({ ...a, [p.key]: p.default }), {}) || {}), ...params },
  };
}

function mkWire(id: string, fromC: string, fromT: string, toC: string, toT: string): Wire {
  return { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
}

function setup(...comps: CircuitComponent[]): { components: CircuitComponent[]; wires: Wire[]; plugins: Map<string, any>; nodeMap: any } {
  // Build a basic ground + source + resistor circuit for tests
  const components: CircuitComponent[] = comps;
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const wires: Wire[] = [];
  // Construct a minimal valid nodeMap (use buildNodeMap with empty wires first)
  const nodeMap = buildNodeMap(components, wires, plugins);
  return { components, wires, plugins, nodeMap };
}

describe('buildWireColorMap', () => {
  it('returns an empty map for no wires', () => {
    const { components, wires, plugins, nodeMap } = setup();
    const r = buildWireColorMap(wires, components, plugins, nodeMap);
    expect(r.size).toBe(0);
  });

  it('colors ground wires dark slate', () => {
    const gnd = mkComp('powerGND', 'gnd1', { net: 'GND' });
    const r1 = mkComp('resistor', 'r1');
    const { plugins } = setup(gnd, r1);
    // Build nodeMap with the wire — power symbols use terminal id 'p'
    const wires = [mkWire('w1', 'r1', 'b', 'gnd1', 'p')];
    const nodeMap = buildNodeMap([gnd, r1], wires, plugins);
    const r = buildWireColorMap(wires, [gnd, r1], plugins, nodeMap);
    expect(r.get('w1')).toBe('#475569');  // dark slate for ground
  });

  it('colors power wires red', () => {
    const vcc = mkComp('powerVCC', 'vcc1', { net: 'VCC' });
    const r1 = mkComp('resistor', 'r1');
    const { plugins } = setup(vcc, r1);
    const wires = [mkWire('w1', 'vcc1', 'p', 'r1', 'a')];
    const nodeMap = buildNodeMap([vcc, r1], wires, plugins);
    const r = buildWireColorMap(wires, [vcc, r1], plugins, nodeMap);
    expect(r.get('w1')).toBe('#ef4444');  // red for power
  });

  it('colors 5V power wires red', () => {
    const v5 = mkComp('power5V', 'v5', { net: '+5V' });
    const r1 = mkComp('resistor', 'r1');
    const { plugins } = setup(v5, r1);
    const wires = [mkWire('w1', 'v5', 'p', 'r1', 'a')];
    const nodeMap = buildNodeMap([v5, r1], wires, plugins);
    const r = buildWireColorMap(wires, [v5, r1], plugins, nodeMap);
    expect(r.get('w1')).toBe('#ef4444');
  });

  it('colors unnamed signal nets cyan', () => {
    const r1 = mkComp('resistor', 'r1');
    const r2 = mkComp('resistor', 'r2');
    const { plugins } = setup(r1, r2);
    const wires = [mkWire('w1', 'r1', 'b', 'r2', 'a')];
    const nodeMap = buildNodeMap([r1, r2], wires, plugins);
    const r = buildWireColorMap(wires, [r1, r2], plugins, nodeMap);
    expect(r.get('w1')).toBe('#22d3ee');  // cyan
  });

  it('user NetClass color overrides default palette', () => {
    const vcc = mkComp('powerVCC', 'vcc1', { net: 'VCC' });
    const r1 = mkComp('resistor', 'r1');
    const { plugins } = setup(vcc, r1);
    const wires = [mkWire('w1', 'vcc1', 'p', 'r1', 'a')];
    const nodeMap = buildNodeMap([vcc, r1], wires, plugins);
    const netClasses: NetClass[] = [
      { id: 'nc1', name: 'Power', nets: ['VCC'], color: '#ff00ff' },
    ];
    const r = buildWireColorMap(wires, [vcc, r1], plugins, nodeMap, netClasses);
    expect(r.get('w1')).toBe('#ff00ff');  // magenta from user class
  });

  it('user NetClass color also works for signal nets', () => {
    const r1 = mkComp('resistor', 'r1');
    const r2 = mkComp('resistor', 'r2');
    const label = mkComp('netLabel', 'lbl1', { net: 'DATA' });
    const { plugins } = setup(r1, r2, label);
    const wires = [
      mkWire('w1', 'r1', 'b', 'r2', 'a'),
      mkWire('w2', 'r2', 'a', 'lbl1', 'p'),
    ];
    const nodeMap = buildNodeMap([r1, r2, label], wires, plugins);
    const netClasses: NetClass[] = [
      { id: 'nc1', name: 'Data', nets: ['DATA'], color: '#aabbcc' },
    ];
    const r = buildWireColorMap(wires, [r1, r2, label], plugins, nodeMap, netClasses);
    // Both wires are on the same node (via the label), so both get the user color
    expect(r.get('w1')).toBe('#aabbcc');
    expect(r.get('w2')).toBe('#aabbcc');
  });

  it('wires on different nodes get different colors', () => {
    const gnd = mkComp('powerGND', 'gnd1', { net: 'GND' });
    const vcc = mkComp('powerVCC', 'vcc1', { net: 'VCC' });
    const r1 = mkComp('resistor', 'r1');
    const { plugins } = setup(gnd, vcc, r1);
    const wires = [
      mkWire('wPower', 'vcc1', 'p', 'r1', 'a'),
      mkWire('wGnd', 'r1', 'b', 'gnd1', 'p'),
    ];
    const nodeMap = buildNodeMap([gnd, vcc, r1], wires, plugins);
    const r = buildWireColorMap(wires, [gnd, vcc, r1], plugins, nodeMap);
    expect(r.get('wPower')).toBe('#ef4444');  // red
    expect(r.get('wGnd')).toBe('#475569');  // dark slate
  });

  it('wires on the same electrical node share a color', () => {
    const gnd = mkComp('powerGND', 'gnd1', { net: 'GND' });
    const r1 = mkComp('resistor', 'r1');
    const r2 = mkComp('resistor', 'r2');
    const { plugins } = setup(gnd, r1, r2);
    // Both wires end at the same gnd terminal → same node
    const wires = [
      mkWire('w1', 'r1', 'b', 'gnd1', 'p'),
      mkWire('w2', 'r2', 'b', 'gnd1', 'p'),
    ];
    const nodeMap = buildNodeMap([gnd, r1, r2], wires, plugins);
    const r = buildWireColorMap(wires, [gnd, r1, r2], plugins, nodeMap);
    expect(r.get('w1')).toBe(r.get('w2'));
  });

  it('AGND is recognized as a ground net', () => {
    const agnd = mkComp('powerAGND', 'agnd1', { net: 'AGND' });
    const r1 = mkComp('resistor', 'r1');
    const { plugins } = setup(agnd, r1);
    const wires = [mkWire('w1', 'r1', 'b', 'agnd1', 'p')];
    const nodeMap = buildNodeMap([agnd, r1], wires, plugins);
    const r = buildWireColorMap(wires, [agnd, r1], plugins, nodeMap);
    expect(r.get('w1')).toBe('#475569');
  });

  it('3V3 is recognized as a power net', () => {
    const v3 = mkComp('power3V3', 'v3', { net: '+3V3' });
    const r1 = mkComp('resistor', 'r1');
    const { plugins } = setup(v3, r1);
    const wires = [mkWire('w1', 'v3', 'p', 'r1', 'a')];
    const nodeMap = buildNodeMap([v3, r1], wires, plugins);
    const r = buildWireColorMap(wires, [v3, r1], plugins, nodeMap);
    expect(r.get('w1')).toBe('#ef4444');
  });
});

describe('getNetNameForWire', () => {
  it('returns the net name when wire is connected to a labeled net', () => {
    const vcc = mkComp('powerVCC', 'vcc1', { net: 'VCC' });
    const r1 = mkComp('resistor', 'r1');
    const { plugins } = setup(vcc, r1);
    const wires = [mkWire('w1', 'vcc1', 'p', 'r1', 'a')];
    const nodeMap = buildNodeMap([vcc, r1], wires, plugins);
    const name = getNetNameForWire(wires[0], [vcc, r1], plugins, nodeMap);
    expect(name).toBe('VCC');
  });

  it('returns null when wire has no labeled net', () => {
    const r1 = mkComp('resistor', 'r1');
    const r2 = mkComp('resistor', 'r2');
    const { plugins } = setup(r1, r2);
    const wires = [mkWire('w1', 'r1', 'b', 'r2', 'a')];
    const nodeMap = buildNodeMap([r1, r2], wires, plugins);
    const name = getNetNameForWire(wires[0], [r1, r2], plugins, nodeMap);
    expect(name).toBeNull();
  });

  it('returns the net name even if the wire is only indirectly connected via a junction', () => {
    // Three-terminal junction: r1.b → junction, r2.a → junction, gnd1.p → junction.
    // We model this with a wire from r1.b → r2.a, and another from r2.a → gnd1.p.
    // (r2.a acts as the junction point — both wires touch it.)
    const gnd = mkComp('powerGND', 'gnd1', { net: 'GND' });
    const r1 = mkComp('resistor', 'r1');
    const r2 = mkComp('resistor', 'r2');
    const { plugins } = setup(gnd, r1, r2);
    // r1.b → r2.a, then r2.a → gnd1.p — w1's endpoint (r2.a) IS the gnd node
    const wires = [
      mkWire('w1', 'r1', 'b', 'r2', 'a'),
      mkWire('w2', 'r2', 'a', 'gnd1', 'p'),
    ];
    const nodeMap = buildNodeMap([gnd, r1, r2], wires, plugins);
    // r1.b and r2.a and gnd1.p all share the same electrical node (node 0 = GND).
    const name = getNetNameForWire(wires[0], [gnd, r1, r2], plugins, nodeMap);
    expect(name).toBe('GND');
  });
});
