// Tests for all example circuits — verifies wires connect, simulation runs, physics passes.
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
import { exampleCategories } from '../src/lib/circuit/examples';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/advanced');
  await import('../src/lib/circuit/components/advanced-devices');
  await import('../src/lib/circuit/components/arduino-real');
  await import('../src/lib/circuit/components/kicad-parity');
  await import('../src/lib/circuit/components/power-symbols');
});

function getPlugins(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return plugins;
}

function runSim(doc: { components: CircuitComponent[]; wires: Wire[] }, steps = 30): SimContext | null {
  const plugins = getPlugins(doc.components);
  for (const c of doc.components) if (!c.simState) c.simState = {};
  let prev: any = undefined;
  let sim: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) return null;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  return sim;
}

function checkWires(doc: { components: CircuitComponent[]; wires: Wire[] }): boolean {
  const plugins = getPlugins(doc.components);
  for (const w of doc.wires) {
    const fromComp = doc.components.find(c => c.id === w.from.componentId);
    const toComp = doc.components.find(c => c.id === w.to.componentId);
    if (!fromComp || !toComp) return false;
    const fromPlugin = plugins.get(fromComp.type);
    const toPlugin = plugins.get(toComp.type);
    if (!fromPlugin || !toPlugin) return false;
    const fromTerm = fromPlugin.terminals.find(t => t.id === w.from.terminalId);
    const toTerm = toPlugin.terminals.find(t => t.id === w.to.terminalId);
    if (!fromTerm || !toTerm) return false;
  }
  return true;
}

describe('All example circuits — wire connectivity', () => {
  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      it(`wires connect: ${ex.name}`, () => {
        expect(checkWires(ex.doc)).toBe(true);
      });
    }
  }
});

describe('All example circuits — simulation runs', () => {
  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      it(`simulates: ${ex.name}`, () => {
        const sim = runSim(ex.doc);
        expect(sim).not.toBeNull();
      });
    }
  }
});

describe('All example circuits — no NaN voltages', () => {
  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      it(`no NaN: ${ex.name}`, () => {
        const sim = runSim(ex.doc);
        expect(sim).not.toBeNull();
        for (let i = 0; i < sim.nodeVoltage.length; i++) {
          expect(isNaN(sim.nodeVoltage[i])).toBe(false);
          expect(isFinite(sim.nodeVoltage[i])).toBe(true);
        }
      });
    }
  }
});

describe('All example circuits — physics validation (no errors)', () => {
  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      it(`physics passes: ${ex.name}`, () => {
        const sim = runSim(ex.doc);
        expect(sim).not.toBeNull();
        const plugins = getPlugins(ex.doc.components);
        const result = validatePhysics(ex.doc.components, ex.doc.wires, plugins, sim);
        const errors = result.violations.filter(v => v.severity === 'error');
        expect(errors).toHaveLength(0);
      });
    }
  }
});

describe('Example categories structure', () => {
  it('has at least 7 categories', () => {
    expect(exampleCategories.length).toBeGreaterThanOrEqual(7);
  });

  it('every category has at least 1 example', () => {
    for (const cat of exampleCategories) {
      expect(cat.examples.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every example has name, description, and doc', () => {
    for (const cat of exampleCategories) {
      for (const ex of cat.examples) {
        expect(typeof ex.name).toBe('string');
        expect(ex.name.length).toBeGreaterThan(0);
        expect(typeof ex.description).toBe('string');
        expect(ex.doc).toBeDefined();
        expect(ex.doc.version).toBe(1);
        expect(Array.isArray(ex.doc.components)).toBe(true);
        expect(Array.isArray(ex.doc.wires)).toBe(true);
      }
    }
  });

  it('total examples >= 20', () => {
    const total = exampleCategories.reduce((sum, c) => sum + c.examples.length, 0);
    expect(total).toBeGreaterThanOrEqual(20);
  });
});
