// Intensive tests for P1 batch 2: Schmitt triggers, op-amp macromodels,
// SCR, triac, alignment/distribute, multi-edit, ARIA labels.

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC } from '../src/lib/circuit/engine';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function comp(type: string, id: string, pos: [number, number], params?: any): any {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const pm of p.parameters) defaults[pm.key] = pm.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
}
function wire(id: string, fc: string, ft: string, tc: string, tt: string): any {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}
function plugins(): Map<string, any> {
  return new Map(getAllPlugins().map(p => [p.type, p]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Schmitt trigger gates
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 2: Schmitt triggers', () => {
  it('Schmitt NOT is registered with hysteresis thresholds', () => {
    const p = getPlugin('schmitt_not');
    expect(p).toBeDefined();
    expect(p!.parameters.some(pa => pa.key === 'vtPos')).toBe(true);
    expect(p!.parameters.some(pa => pa.key === 'vtNeg')).toBe(true);
  });

  it('Schmitt NAND is registered', () => {
    expect(getPlugin('schmitt_nand')).toBeDefined();
  });

  it('Schmitt NOT simulates without crash', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('schmitt_not', 'U1', [5, 0]),
      comp('resistor', 'R1', [12, 0], { resistance: 1000 }),
      comp('ground', 'GND', [12, 10]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'a'),
      wire('w2', 'U1', 'y', 'R1', 'a'),
      wire('w3', 'R1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    expect(() => solveDC(components, wires, plugins())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Op-amp macromodels
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 2: Op-amp macromodels', () => {
  it('LM358 is registered with realistic parameters', () => {
    const p = getPlugin('lm358');
    expect(p).toBeDefined();
    expect(p!.name).toBe('LM358');
    const gainParam = p!.parameters.find(pa => pa.key === 'gain');
    expect(gainParam).toBeDefined();
    expect(gainParam!.default).toBe(1e5);
  });

  it('LM741 is registered', () => {
    const p = getPlugin('lm741');
    expect(p).toBeDefined();
    expect(p!.name).toBe('LM741');
  });

  it('TL072 is registered with high slew rate', () => {
    const p = getPlugin('tl072');
    expect(p).toBeDefined();
    const slewParam = p!.parameters.find(pa => pa.key === 'slewRate');
    expect(slewParam!.default).toBe(13);
  });

  it('LM358 does not crash in simulation', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 12 }),
      comp('dcVoltage', 'V2', [0, 5], { voltage: 0.5 }),
      comp('lm358', 'U1', [5, 0]),
      comp('resistor', 'R1', [15, 0], { resistance: 10000 }),
      comp('resistor', 'R2', [15, 5], { resistance: 10000 }),
      comp('ground', 'GND', [15, 10]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'vcc'),
      wire('w2', 'V1', 'n', 'U1', 'vee'),
      wire('w3', 'V2', 'p', 'U1', 'inp'),
      wire('w4', 'GND', 'g', 'U1', 'inn'),
      wire('w5', 'U1', 'out', 'R1', 'a'),
      wire('w6', 'R1', 'b', 'GND', 'g'),
      wire('w7', 'V1', 'n', 'GND', 'g'),
      wire('w8', 'V2', 'n', 'GND', 'g'),
    ];
    expect(() => solveDC(components, wires, plugins())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCR and Triac
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 2: Thyristors', () => {
  it('SCR is registered with gate trigger', () => {
    const p = getPlugin('scr');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id)).toContain('a');
    expect(p!.terminals.map(t => t.id)).toContain('g');
    expect(p!.terminals.map(t => t.id)).toContain('k');
    expect(p!.parameters.some(pa => pa.key === 'gateTriggerV')).toBe(true);
    expect(p!.parameters.some(pa => pa.key === 'holdingI')).toBe(true);
  });

  it('Triac is registered with bidirectional terminals', () => {
    const p = getPlugin('triac');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id)).toContain('mt1');
    expect(p!.terminals.map(t => t.id)).toContain('mt2');
    expect(p!.terminals.map(t => t.id)).toContain('g');
  });

  it('SCR does not crash in simulation', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 12 }),
      comp('scr', 'Q1', [5, 0]),
      comp('resistor', 'R1', [12, 0], { resistance: 1000 }),
      comp('ground', 'GND', [12, 10]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'Q1', 'a'),
      wire('w2', 'Q1', 'k', 'R1', 'a'),
      wire('w3', 'R1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
      // Gate not connected — SCR should stay off
    ];
    expect(() => solveDC(components, wires, plugins())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Alignment / distribute tools
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 2: Alignment tools', () => {
  it('alignSelected aligns components to min X', async () => {
    const { useEditor } = await import('../src/lib/circuit/store');
    const s = useEditor.getState();
    s.clear();
    useEditor.setState({ past: [], future: [] });
    const r1 = s.addComponent('resistor', { x: 5, y: 0 });
    const r2 = s.addComponent('resistor', { x: 10, y: 5 });
    const r3 = s.addComponent('resistor', { x: 15, y: 10 });
    // Select all three
    s.setMultiSelection({ components: new Set([r1, r2, r3]), wires: new Set() });
    s.alignSelected('x', 'min');
    const state = useEditor.getState();
    // All should have x = 5 (the min)
    const selected = state.components.filter(c => [r1, r2, r3].includes(c.id));
    expect(selected.every(c => c.position.x === 5)).toBe(true);
  });

  it('distributeSelected evenly spaces components', async () => {
    const { useEditor } = await import('../src/lib/circuit/store');
    const s = useEditor.getState();
    s.clear();
    useEditor.setState({ past: [], future: [] });
    const r1 = s.addComponent('resistor', { x: 0, y: 0 });
    const r2 = s.addComponent('resistor', { x: 10, y: 0 });
    const r3 = s.addComponent('resistor', { x: 30, y: 0 });
    s.setMultiSelection({ components: new Set([r1, r2, r3]), wires: new Set() });
    s.distributeSelected('x');
    const state = useEditor.getState();
    const selected = state.components.filter(c => [r1, r2, r3].includes(c.id)).sort((a, b) => a.position.x - b.position.x);
    // First should be at 0, last at 30, middle at 15
    expect(selected[0].position.x).toBe(0);
    expect(selected[2].position.x).toBe(30);
    expect(selected[1].position.x).toBe(15);
  });

  it('alignSelected does nothing with < 2 selected', async () => {
    const { useEditor } = await import('../src/lib/circuit/store');
    const s = useEditor.getState();
    s.clear();
    useEditor.setState({ past: [], future: [] });
    const r1 = s.addComponent('resistor', { x: 5, y: 0 });
    s.setMultiSelection({ components: new Set([r1]), wires: new Set() });
    s.alignSelected('x', 'center');
    // Should not crash and should not change position
    expect(useEditor.getState().components[0].position.x).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-edit property panel
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 2: Multi-edit panel', () => {
  it('PropertyPanel imports multiSelection from store', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/PropertyPanel.tsx', 'utf-8');
    expect(source).toContain('multiSelection');
    expect(source).toContain('alignSelected');
    expect(source).toContain('distributeSelected');
    expect(source).toContain('Multi-Edit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARIA labels and landmarks
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 2: Accessibility', () => {
  it('layout.tsx has skip-to-main-content link', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/app/layout.tsx', 'utf-8');
    expect(source).toContain('Skip to main content');
    expect(source).toContain('sr-only');
  });

  it('PropertyPanel has role="complementary"', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/PropertyPanel.tsx', 'utf-8');
    expect(source).toContain('role="complementary"');
    expect(source).toContain('aria-label');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry completeness for batch 2
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 2: Registry completeness', () => {
  const newTypes = [
    'schmitt_not', 'schmitt_nand', 'lm358', 'lm741', 'tl072', 'scr', 'triac',
  ];
  for (const type of newTypes) {
    it(`${type} is registered`, () => {
      expect(getPlugin(type)).toBeDefined();
    });
  }
});
