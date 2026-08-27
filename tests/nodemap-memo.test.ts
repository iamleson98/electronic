// Tests for the buildNodeMap memoization (identity-keyed cache).
//
// The live loop + canvas render call buildNodeMap several times per frame
// with the same array references; the cache must return the same object and
// must invalidate when the topology (array identity) or the plugin registry
// changes.

import { describe, it, expect, beforeAll } from 'vitest';
import { buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins, registerPlugin, getRegistryVersion } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function comp(t: string, id: string, p?: any): CircuitComponent {
  const pl = getPlugin(t);
  const d: any = {};
  if (pl) for (const pm of pl.parameters) d[pm.key] = pm.default;
  return { id, type: t, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...p }, simState: {} };
}
function wire(id: string, f: string, ft: string, t: string, tt: string): Wire {
  return { id, from: { componentId: f, terminalId: ft }, to: { componentId: t, terminalId: tt } };
}
function plugins() {
  return new Map(getAllPlugins().map(p => [p.type, p]));
}

describe('buildNodeMap memoization', () => {
  it('returns the identical object for repeated calls with the same references', () => {
    const comps = [comp('dcVoltage', 'V1', { voltage: 5 }), comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const p1 = plugins();
    const p2 = plugins(); // different Map instance, same content
    const m1 = buildNodeMap(comps, ws, p1);
    const m2 = buildNodeMap(comps, ws, p2);
    expect(m2).toBe(m1); // same cached object even with a fresh plugins Map
    expect(m2.terminalNode.get('R1:a')).toBe(m1.terminalNode.get('R1:a'));
  });

  it('invalidates when components or wires are replaced (new references)', () => {
    const comps = [comp('dcVoltage', 'V1'), comp('resistor', 'R1'), comp('ground', 'GND')];
    const ws = [wire('w1', 'V1', 'p', 'R1', 'a'), wire('w2', 'V1', 'n', 'GND', 'g')];
    const m1 = buildNodeMap(comps, ws, plugins());
    // new wires array (e.g. a wire was added)
    const ws2 = [...ws, wire('w3', 'R1', 'b', 'GND', 'g')];
    const m2 = buildNodeMap(comps, ws2, plugins());
    expect(m2).not.toBe(m1);
    // R1:b is now wired to ground (it had no node entry before)
    expect(m1.terminalNode.has('R1:b')).toBe(false);
    expect(m2.terminalNode.get('R1:b')).toBe(0);
    // new components array (e.g. a component was moved)
    const comps2 = [...comps];
    const m3 = buildNodeMap(comps2, ws, plugins());
    expect(m3).not.toBe(m1);
  });

  it('invalidates when the plugin registry generation changes', () => {
    const comps = [comp('dcVoltage', 'V1'), comp('ground', 'GND')];
    const ws = [wire('w1', 'V1', 'p', 'GND', 'g'), wire('w2', 'V1', 'n', 'GND', 'g')];
    const m1 = buildNodeMap(comps, ws, plugins());
    const before = getRegistryVersion();
    const testPlugin: ComponentPlugin = {
      type: '__memoTestProbe__',
      name: 'Memo Probe',
      category: 'passive',
      description: 'test-only plugin',
      symbol: '?',
      boundingBox: { width: 2, height: 2 },
      terminals: [{ id: 'a', label: 'A', position: { x: 0, y: 1 } }, { id: 'b', label: 'B', position: { x: 2, y: 1 } }],
      parameters: [],
      render() { /* not rendered */ },
    };
    registerPlugin(testPlugin);
    expect(getRegistryVersion()).toBe(before + 1);
    const m2 = buildNodeMap(comps, ws, plugins());
    expect(m2).not.toBe(m1);
  });
});
