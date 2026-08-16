import { describe, it, expect, beforeAll } from 'vitest';
import { generateResistorLadder, benchmarkCircuit, MAX_COMPONENTS, checkComponentLimit, checkWireLimit } from '../src/lib/circuit/benchmark';
import { getAllPlugins } from '../src/lib/circuit/registry';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); });
function plugins(){return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('Benchmark', () => {
  it('generateResistorLadder: 10 stages', () => { const d=generateResistorLadder(10,1000);expect(d.components.length).toBe(12);});
  it('benchmarkCircuit: 100-node ladder', () => { const p=plugins();const d=generateResistorLadder(98);const r=benchmarkCircuit(d.components,d.wires,p);expect(r.ok).toBe(true);expect(r.solveDCMs).toBeLessThan(100);});
  it('MAX_COMPONENTS: 2000', () => { expect(MAX_COMPONENTS).toBe(2000);});
  it('checkComponentLimit: under limit', () => { const r=checkComponentLimit([]);expect(r.ok).toBe(true);});
  it('checkComponentLimit: over limit', () => { const r=checkComponentLimit(new Array(MAX_COMPONENTS+1).fill({}));expect(r.ok).toBe(false);});
  it('checkWireLimit: under limit', () => { const r=checkWireLimit([]);expect(r.ok).toBe(true);});
});
