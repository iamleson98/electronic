// Circuit summary (BOM + wire connections) for the AI chat card, and the
// new analysis tools (simulate.acAnalysis / simulate.fourier / undo/redo).
import { describe, it, expect } from 'vitest';
import { summarizeCircuitDoc, buildBomEntries, buildNetEntries } from '../src/lib/ai/circuit-summary';
import { TOOLS, TOOLS_BY_NAME } from '../src/lib/ai/tools';
import type { ToolContext } from '../src/lib/ai/tools';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';
import type { CircuitComponent, Wire, CircuitDocument } from '../src/lib/circuit/types';

// ── fixtures ────────────────────────────────────────────────────────────────

function comp(id: string, type: string, parameters: any, refdes?: string): CircuitComponent {
  return {
    id, type, refdes: refdes ?? id.toUpperCase(),
    position: { x: 0, y: 0 }, rotation: 0,
    parameters,
  } as CircuitComponent;
}

function wire(id: string, from: { componentId: string; terminalId: string }, to: { componentId: string; terminalId: string }): Wire {
  return { id, from, to } as Wire;
}

/** V1(+5) → R1(1k) → [VOUT: R2(2k) ∥ C1(1µF)] → GND — the classic divider + cap. */
function dividerWithCap(): { components: CircuitComponent[]; wires: Wire[] } {
  const components = [
    comp('v1', 'dcVoltage', { voltage: 5 }, 'V1'),
    comp('r1', 'resistor', { resistance: 1000 }, 'R1'),
    comp('r2', 'resistor', { resistance: 2000 }, 'R2'),
    comp('c1', 'capacitor', { capacitance: 1e-6, initialV: 0 }, 'C1'),
    comp('gnd1', 'ground', {}, 'GND1'),
    comp('lbl1', 'netLabel', { net: 'VOUT' }, 'LBL1'),
  ];
  const wires = [
    wire('w1', { componentId: 'v1', terminalId: 'p' }, { componentId: 'r1', terminalId: 'a' }),
    wire('w2', { componentId: 'r1', terminalId: 'b' }, { componentId: 'r2', terminalId: 'a' }),
    wire('w3', { componentId: 'r2', terminalId: 'a' }, { componentId: 'c1', terminalId: 'a' }),
    wire('w4', { componentId: 'r2', terminalId: 'b' }, { componentId: 'gnd1', terminalId: 'g' }),
    wire('w5', { componentId: 'c1', terminalId: 'b' }, { componentId: 'gnd1', terminalId: 'g' }),
    wire('w6', { componentId: 'v1', terminalId: 'n' }, { componentId: 'gnd1', terminalId: 'g' }),
    wire('w7', { componentId: 'lbl1', terminalId: 'a' }, { componentId: 'r2', terminalId: 'a' }),
  ];
  return { components, wires };
}

// ── BOM ─────────────────────────────────────────────────────────────────────

describe('buildBomEntries', () => {
  it('groups same type+value into one line with all refdes', () => {
    const { components } = dividerWithCap();
    const bom = buildBomEntries(components);
    const r1k = bom.find(e => e.name === 'Resistor' && e.value === '1kΩ')!;
    expect(r1k.count).toBe(1);
    expect(r1k.refdes).toEqual(['R1']);
    const r2k = bom.find(e => e.name === 'Resistor' && e.value === '2kΩ')!;
    expect(r2k.refdes).toEqual(['R2']);
    const cap = bom.find(e => e.name === 'Capacitor')!;
    expect(cap.value).toBe('1µF');
    // Ground symbols never appear in the BOM.
    expect(bom.find(e => /ground/i.test(e.name))).toBeUndefined();
  });

  it('two identical LEDs collapse to qty 2', () => {
    const comps = [
      comp('led1', 'led', { color: 'red', forwardV: 2, seriesR: 220 }, 'LED1'),
      comp('led2', 'led', { color: 'red', forwardV: 2, seriesR: 220 }, 'LED2'),
      comp('led3', 'led', { color: 'green', forwardV: 2, seriesR: 220 }, 'LED3'),
    ];
    const bom = buildBomEntries(comps);
    expect(bom).toHaveLength(2);
    const red = bom.find(e => e.value === 'red')!;
    expect(red.count).toBe(2);
    expect(red.refdes).toEqual(['LED1', 'LED2']);
  });

  it('unknown component types are skipped without crashing', () => {
    const bom = buildBomEntries([comp('x1', 'notARealType', {})]);
    expect(bom).toHaveLength(0);
  });
});

// ── Nets (wire connections) ─────────────────────────────────────────────────

describe('buildNetEntries', () => {
  it('derives GND, +5V(v1), and named nets with their member pins', () => {
    const { components, wires } = dividerWithCap();
    const nets = buildNetEntries(components, wires);
    const names = nets.map(n => n.name);
    expect(names).toContain('GND');
    expect(names).toContain('+5V(v1)'); // net naming convention matches the AI's netlist context
    expect(names).toContain('VOUT'); // netLabel wins over auto N1/N2
    const gnd = nets.find(n => n.name === 'GND')!;
    expect(gnd.members).toContain('R2.b');
    expect(gnd.members).toContain('C1.b');
    expect(gnd.members).toContain('V1.n');
    const vout = nets.find(n => n.name === 'VOUT')!;
    expect(vout.members).toContain('R1.b');
    expect(vout.members).toContain('R2.a');
    expect(vout.members).toContain('C1.a');
  });

  it('auto-numbers unnamed nets as N1, N2, …', () => {
    const components = [
      comp('v1', 'dcVoltage', { voltage: 9 }),
      comp('r1', 'resistor', { resistance: 100 }),
      comp('g1', 'ground', {}),
    ];
    const wires = [
      wire('w1', { componentId: 'v1', terminalId: 'p' }, { componentId: 'r1', terminalId: 'a' }),
      wire('w2', { componentId: 'r1', terminalId: 'b' }, { componentId: 'g1', terminalId: 'g' }),
      wire('w3', { componentId: 'v1', terminalId: 'n' }, { componentId: 'g1', terminalId: 'g' }),
    ];
    const nets = buildNetEntries(components, wires);
    expect(nets.map(n => n.name)).toEqual(['GND', '+9V(v1)']);
    // members only listed for real components
    expect(nets.find(n => n.name === '+9V(v1)')!.members).toEqual(['V1.p', 'R1.a']);
  });

  it('single unwired pins are not nets', () => {
    const components = [
      comp('r1', 'resistor', { resistance: 100 }),
      comp('r2', 'resistor', { resistance: 100 }),
    ];
    const wires = [wire('w1', { componentId: 'r1', terminalId: 'b' }, { componentId: 'r2', terminalId: 'a' })];
    const nets = buildNetEntries(components, wires);
    // the joined pair IS a net; the two dangling ends (single-pin) are not
    expect(nets).toHaveLength(1);
    expect(nets[0].members.sort()).toEqual(['R1.b', 'R2.a']);
  });
});

describe('summarizeCircuitDoc', () => {
  it('aggregates counts across BOM and nets', () => {
    const { components, wires } = dividerWithCap();
    const s = summarizeCircuitDoc(components, wires);
    // ground + netLabel are excluded from the BOM count
    expect(s.componentCount).toBe(4);
    expect(s.wireCount).toBe(7);
    expect(s.netCount).toBeGreaterThanOrEqual(3);
    expect(s.bom.length).toBeGreaterThanOrEqual(3);
  });

  it('empty doc → zeroed summary, no crash', () => {
    const s = summarizeCircuitDoc([], []);
    expect(s.componentCount).toBe(0);
    expect(s.bom).toHaveLength(0);
    expect(s.nets).toHaveLength(0);
  });
});

// ── new analysis tools ──────────────────────────────────────────────────────

function toolCtx(doc: CircuitDocument, history?: { undoStack: string[]; redoStack: string[] }): ToolContext {
  const plugins = new Map<string, any>();
  for (const c of doc.components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return { doc, plugins, simContext: null, history };
}

describe('simulate.acAnalysis tool', () => {
  it('is registered and sweeps an RC low-pass with the right cutoff', async () => {
    expect(TOOLS_BY_NAME.has('simulate.acAnalysis')).toBe(true);
    const tool = TOOLS_BY_NAME.get('simulate.acAnalysis')!;
    // R1=1k, R2=2k ∥ C1=1µF → R_th = R1∥R2 = 667Ω → fc = 1/(2π·667·1µ) ≈ 238 Hz
    const { components, wires } = dividerWithCap();
    const ctx = toolCtx({ version: 1, components, wires });
    const r = await tool.execute(
      { sourceId: 'v1', outputNode: 'c1:a', fStart: 1, fStop: 1e6, nPoints: 12 },
      ctx,
    );
    expect(r.ok).toBe(true);
    const fc = r.result.cutoffFrequencyHz as number;
    expect(fc).not.toBeNull();
    expect(fc).toBeGreaterThan(180);
    expect(fc).toBeLessThan(300);
    expect(r.result.filterType).toBe('low-pass');
    expect((r.result.points as any[]).length).toBeLessThanOrEqual(40);
    expect(typeof r.result.passbandGainDb).toBe('number');
  });

  it('rejects unknown sources with a helpful error', async () => {
    const tool = TOOLS_BY_NAME.get('simulate.acAnalysis')!;
    const { components, wires } = dividerWithCap();
    const ctx = toolCtx({ version: 1, components, wires });
    const r = await tool.execute({ sourceId: 'nope', outputNode: 'c1:a' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('nope');
    expect(r.result?.available).toContain('v1');
  });
});

describe('simulate.fourier tool', () => {
  it('is registered and measures a clean sine fundamental (low THD)', async () => {
    expect(TOOLS_BY_NAME.has('simulate.fourier')).toBe(true);
    const tool = TOOLS_BY_NAME.get('simulate.fourier')!;
    // 1 kHz sine source → 1k load. Fundamental ≈ 1 kHz, THD tiny.
    const components = [
      comp('v1', 'acVoltage', { amplitude: 2.5, frequency: 1000, offset: 0, phase: 0 }, 'V1'),
      comp('r1', 'resistor', { resistance: 1000 }, 'R1'),
      comp('g1', 'ground', {}, 'GND'),
    ];
    const wires = [
      wire('w1', { componentId: 'v1', terminalId: 'p' }, { componentId: 'r1', terminalId: 'a' }),
      wire('w2', { componentId: 'r1', terminalId: 'b' }, { componentId: 'g1', terminalId: 'g' }),
      wire('w3', { componentId: 'v1', terminalId: 'n' }, { componentId: 'g1', terminalId: 'g' }),
    ];
    const ctx = toolCtx({ version: 1, components, wires });
    // dt=10µs → 2000 steps = 20 ms = 20 periods of 1 kHz.
    const r = await tool.execute({ probe: 'r1:a', fundamentalHz: 1000, steps: 2000, dt: 1e-5 }, ctx);
    expect(r.ok).toBe(true);
    const f0 = r.result.fundamentalHz as number;
    expect(f0).toBeGreaterThan(900);
    expect(f0).toBeLessThan(1100);
    expect(r.result.thdPercent as number).toBeLessThan(5);
    expect((r.result.harmonics as any[])[0].n).toBe(1);
  });

  it('current probes work (bare componentId)', async () => {
    const tool = TOOLS_BY_NAME.get('simulate.fourier')!;
    const components = [
      comp('v1', 'acVoltage', { amplitude: 2.5, frequency: 1000, offset: 0, phase: 0 }, 'V1'),
      comp('r1', 'resistor', { resistance: 1000 }, 'R1'),
      comp('g1', 'ground', {}, 'GND'),
    ];
    const wires = [
      wire('w1', { componentId: 'v1', terminalId: 'p' }, { componentId: 'r1', terminalId: 'a' }),
      wire('w2', { componentId: 'r1', terminalId: 'b' }, { componentId: 'g1', terminalId: 'g' }),
      wire('w3', { componentId: 'v1', terminalId: 'n' }, { componentId: 'g1', terminalId: 'g' }),
    ];
    const ctx = toolCtx({ version: 1, components, wires });
    const r = await tool.execute({ probe: 'r1', steps: 2000, dt: 1e-5 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.result.quantity).toContain('current');
    expect(Math.abs(r.result.dc as number)).toBeLessThan(0.01);
  });
});

describe('schematic.undo / schematic.redo tools', () => {
  it('are registered in the global tool list', () => {
    expect(TOOLS_BY_NAME.has('schematic.undo')).toBe(true);
    expect(TOOLS_BY_NAME.has('schematic.redo')).toBe(true);
    expect(TOOLS.some(t => t.name === 'schematic.undo')).toBe(true);
  });

  it('undo restores the pre-mutation document and redo reapplies it', async () => {
    const undo = TOOLS_BY_NAME.get('schematic.undo')!;
    const redo = TOOLS_BY_NAME.get('schematic.redo')!;
    const { components, wires } = dividerWithCap();
    const doc = { version: 1 as const, components, wires };
    const history = { undoStack: [], redoStack: [] };
    const ctx = toolCtx(doc, history);

    // Simulate what the turn runner does before a mutating tool:
    history.undoStack.push(JSON.stringify({ components: ctx.doc.components, wires: ctx.doc.wires }));
    ctx.doc.components = [...ctx.doc.components, comp('led9', 'led', { color: 'red' }, 'LED9')];

    // undo → back to the original 6 components
    const u = await undo.execute({}, ctx);
    expect(u.ok).toBe(true);
    expect(ctx.doc.components).toHaveLength(6);
    expect(ctx.doc.components.find(c => c.id === 'led9')).toBeUndefined();
    expect(history.redoStack).toHaveLength(1);

    // redo → LED9 is back
    const r = await redo.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.doc.components.find(c => c.id === 'led9')).toBeDefined();
    expect(history.undoStack).toHaveLength(1);
  });

  it('undo with an empty history fails gracefully', async () => {
    const undo = TOOLS_BY_NAME.get('schematic.undo')!;
    const ctx = toolCtx({ version: 1, components: [], wires: [] }, { undoStack: [], redoStack: [] });
    const u = await undo.execute({}, ctx);
    expect(u.ok).toBe(false);
    expect(u.error).toContain('Nothing to undo');
  });
});
