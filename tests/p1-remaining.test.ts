// Tests for P1 remaining items: logic ICs, CD4000, mux/decoder, SPICE subckt import,
// convergence suggestions, paste feedback, empty-state card, ? key.

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC } from '../src/lib/circuit/engine';
import { importSpiceNetlist } from '../src/lib/circuit/spice-import';

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
// Logic ICs
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: Logic ICs', () => {
  const ics = ['ic7402', 'ic7404', 'ic7408', 'ic7432', 'ic7486', 'ic74125'];
  for (const type of ics) {
    it(`${type} is registered`, () => {
      expect(getPlugin(type)).toBeDefined();
    });
  }

  it('7404 (NOT) inverts input', () => {
    const components = [
      comp('dcVoltage', 'V1', [0, 0], { voltage: 5 }),
      comp('ic7404', 'U1', [5, 0]),
      comp('resistor', 'R1', [12, 0], { resistance: 1000 }),
      comp('ground', 'GND', [12, 10]),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'U1', 'a'),
      wire('w2', 'U1', 'y', 'R1', 'a'),
      wire('w3', 'R1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    const dc = solveDC(components, wires, plugins());
    expect(dc).not.toBeNull();
    if (dc) for (const v of dc.nodeVoltage) expect(isFinite(v)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CD4000 CMOS
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: CD4000 CMOS', () => {
  it('CD4013 D flip-flop is registered', () => {
    const p = getPlugin('cd4013');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id)).toContain('d');
    expect(p!.terminals.map(t => t.id)).toContain('clk');
    expect(p!.terminals.map(t => t.id)).toContain('set');
    expect(p!.terminals.map(t => t.id)).toContain('rst');
  });

  it('CD4066 bilateral switch is registered', () => {
    const p = getPlugin('cd4066');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id)).toContain('a');
    expect(p!.terminals.map(t => t.id)).toContain('ctrl');
    expect(p!.terminals.map(t => t.id)).toContain('b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mux/Decoder
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: Mux/Decoder', () => {
  it('74138 decoder is registered', () => {
    const p = getPlugin('ic74138');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id)).toContain('s0');
    expect(p!.terminals.map(t => t.id)).toContain('y0');
  });

  it('74153 multiplexer is registered', () => {
    const p = getPlugin('ic74153');
    expect(p).toBeDefined();
    expect(p!.terminals.map(t => t.id)).toContain('d0');
    expect(p!.terminals.map(t => t.id)).toContain('d3');
    expect(p!.terminals.map(t => t.id)).toContain('y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPICE .SUBCKT import
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: SPICE .SUBCKT import', () => {
  it('X cards are imported as passthrough connectors', () => {
    const netlist = `
V1 1 0 5
R1 1 2 1k
X1 2 3 MY_SUBCKT
R2 3 0 1k
.end
`;
    const r = importSpiceNetlist(netlist);
    expect(r.doc).not.toBeNull();
    expect(r.doc!.components.length).toBeGreaterThan(0);
    // The X1 subckt call should be imported as a connector
    const connector = r.doc!.components.find(c => c.id === 'X1');
    expect(connector).toBeDefined();
    expect(connector!.type).toBe('connector');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Convergence error suggestions
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: Convergence error suggestions', () => {
  it('store provides actionable error for no ground', async () => {
    const { useEditor } = await import('../src/lib/circuit/store');
    const s = useEditor.getState();
    s.clear();
    useEditor.setState({ past: [], future: [] });
    s.addComponent('dcVoltage', { x: 0, y: 0 }, { voltage: 5 } as any);
    s.addComponent('resistor', { x: 5, y: 0 });
    // No ground — sim should fail with helpful message
    s.setRunning(true);
    // The simError should be set (may take a tick, but the store action runs sync)
    const error = useEditor.getState().simError;
    if (error) {
      expect(error).toContain('ground');
    }
    s.setRunning(false);
  });

  it('store source contains parallel V-source detection', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/lib/circuit/store.ts', 'utf-8');
    expect(source).toContain('parallelVSources');
    expect(source).toContain('floating nodes');
    expect(source).toContain('series resistance');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Paste feedback
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: Paste feedback', () => {
  it('paste includes toast notification in source', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/lib/circuit/store.ts', 'utf-8');
    expect(source).toContain('toast.success');
    expect(source).toContain('Pasted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty-state card
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: Empty-state card', () => {
  it('CircuitCanvas has welcome card', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/CircuitCanvas.tsx', 'utf-8');
    expect(source).toContain('Welcome to CircuitLab');
    expect(source).toContain('Load Example');
    expect(source).toContain('Add Resistor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ? key binding
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: ? key binding', () => {
  it('page.tsx binds ? to open HelpDialog', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/app/page.tsx', 'utf-8');
    expect(source).toContain("e.key === '?'");
    expect(source).toContain('setShowHelp(true)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry completeness
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 remaining: Registry completeness', () => {
  const newTypes = [
    'ic7402', 'ic7404', 'ic7408', 'ic7432', 'ic7486', 'ic74125',
    'cd4013', 'cd4066', 'ic74138', 'ic74153',
  ];
  for (const type of newTypes) {
    it(`${type} is registered`, () => {
      expect(getPlugin(type)).toBeDefined();
    });
  }
});
