// Tests for P1 batch 3: connector, test point, tri-state buffer, diac,
// memory cleanup on delete, autosave filtering, ARIA labels, ? key, landmarks.

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
// New components: connector, test point, tri-state, diac
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 3: New components', () => {
  it('connector is registered with 2 pins', () => {
    const p = getPlugin('connector');
    expect(p).toBeDefined();
    expect(p!.terminals.length).toBe(2);
    expect(p!.terminals.map(t => t.id)).toContain('a');
    expect(p!.terminals.map(t => t.id)).toContain('b');
  });

  it('test point is registered with 1 terminal', () => {
    const p = getPlugin('testPoint');
    expect(p).toBeDefined();
    expect(p!.terminals.length).toBe(1);
  });

  it('tri-state buffer is registered with enable pin', () => {
    const p = getPlugin('tristate');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id)).toContain('a');
    expect(p!.terminals.map(t => t.id)).toContain('en');
    expect(p!.terminals.map(t => t.id)).toContain('y');
  });

  it('diac is registered with breakover voltage', () => {
    const p = getPlugin('diac');
    expect(p).toBeDefined();
    expect(p!.parameters.some(pa => pa.key === 'breakoverV')).toBe(true);
  });

  it('connector simulates correctly', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('connector', 'J1', [5, 0]),
      comp('resistor', 'R1', [10, 0], { resistance: 1000 }),
      comp('ground', 'GND', [10, 10]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'J1', 'a'),
      wire('w2', 'J1', 'b', 'R1', 'a'),
      wire('w3', 'R1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(components, wires, plugins());
    expect(dc).not.toBeNull();
    for (const v of dc!.nodeVoltage) expect(isFinite(v)).toBe(true);
  });

  it('tri-state buffer simulates without crash', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('dcVoltage', 'V2', [0, 10], { voltage: 5 }), // enable HIGH
      comp('tristate', 'U1', [5, 0]),
      comp('resistor', 'R1', [15, 0], { resistance: 1000 }),
      comp('ground', 'GND', [15, 10]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'a'),
      wire('w2', 'V2', 'p', 'U1', 'en'),
      wire('w3', 'U1', 'y', 'R1', 'a'),
      wire('w4', 'R1', 'b', 'GND', 'g'),
      wire('w5', 'V1', 'n', 'GND', 'g'),
      wire('w6', 'V2', 'n', 'GND', 'g'),
    ];
    expect(() => solveDC(components, wires, plugins())).not.toThrow();
  });

  it('diac simulates without crash', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 50 }),
      comp('diac', 'D1', [5, 0], { breakoverV: 30 }),
      comp('resistor', 'R1', [12, 0], { resistance: 1000 }),
      comp('ground', 'GND', [12, 10]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'D1', 'a'),
      wire('w2', 'D1', 'b', 'R1', 'a'),
      wire('w3', 'R1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    expect(() => solveDC(components, wires, plugins())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory cleanup on deleteComponent
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 3: Memory cleanup on delete', () => {
  it('deleteComponent cleans up sim state', async () => {
    const { useEditor } = await import('../src/lib/circuit/store');
    const s = useEditor.getState();
    s.clear();
    useEditor.setState({ past: [], future: [] });
    const id = s.addComponent('capacitor', { x: 5, y: 5 });
    // Simulate to populate sim state
    useEditor.setState({
      simContext: {
        nodeVoltage: new Float64Array([0, 5, 0]),
        branchCurrent: new Float64Array([0]),
        state: { __global: { [`cap_${id}`]: 0.5, [`other_${id}`]: 1.0, unrelated_key: true } },
        time: 0,
        dt: 1e-4,
      },
    });
    // Delete the component
    s.deleteComponent(id);
    // The sim state should have the component's entries removed
    const simCtx = useEditor.getState().simContext;
    if (simCtx?.state?.__global) {
      const g = simCtx.state.__global;
      expect(g[`cap_${id}`]).toBeUndefined();
      expect(g[`other_${id}`]).toBeUndefined();
      expect(g.unrelated_key).toBe(true); // unrelated entries preserved
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Autosave filtering — only marks dirty on structural changes
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 3: Autosave filtering', () => {
  it('page.tsx subscribes with component/wire reference check', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/app/page.tsx', 'utf-8');
    expect(source).toContain('lastComponents');
    expect(source).toContain('lastWires');
    expect(source).toContain('state.components !== lastComponents');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARIA labels and landmarks
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 3: Accessibility', () => {
  it('CircuitCanvas has role="application" and aria-label', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/CircuitCanvas.tsx', 'utf-8');
    expect(source).toContain('role="application"');
    expect(source).toContain('aria-label');
    expect(source).toContain('tabIndex={0}');
  });

  it('page.tsx has landmark roles (nav, main) and ARIA live region', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/app/page.tsx', 'utf-8');
    expect(source).toContain('aria-label="Component palette"');
    expect(source).toContain('aria-label="Circuit canvas"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('id="main-content"');
  });

  it('page.tsx binds ? key to open HelpDialog', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/app/page.tsx', 'utf-8');
    expect(source).toContain("e.key === '?'");
    expect(source).toContain('setShowHelp(true)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry completeness for batch 3
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 batch 3: Registry completeness', () => {
  const newTypes = ['connector', 'testPoint', 'tristate', 'diac'];
  for (const type of newTypes) {
    it(`${type} is registered`, () => {
      expect(getPlugin(type)).toBeDefined();
    });
  }
});
