// Verify PZ pole math on an AC-coupled circuit (cap floating between two nodes).
// True pole: s = -(1/R1 + 1/R2)/C  (single pole; the cap's common mode is an
// infinite eigenvalue). The old diagonal-C solver returned 2 wrong poles.
import { runPZ } from '../src/lib/circuit/analysis';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

function mk(type: string, id: string, params: Record<string, number> = {}) {
  const p = getPlugin(type)!;
  const d: Record<string, number | string | boolean> = {};
  for (const q of p.parameters) d[q.key] = q.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...params }, refdes: id.toUpperCase() };
}

// AC-coupled: source(1k) - node1 - C(1uF) - node2 - (1k) - ground
const R1 = 1000, R2 = 1000, C = 1e-6;
const comps = [
  mk('dcVoltage', 'v1', { voltage: 5 }),
  mk('resistor', 'r1', { resistance: R1 }),
  mk('capacitor', 'c1', { capacitance: C }),
  mk('resistor', 'r2', { resistance: R2 }),
  mk('ground', 'gnd'),
];
const wires = [
  { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
  { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'c1', terminalId: 'a' } },
  { id: 'w3', from: { componentId: 'c1', terminalId: 'b' }, to: { componentId: 'r2', terminalId: 'a' } },
  { id: 'w4', from: { componentId: 'r2', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
  { id: 'w5', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
];
const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
const r = runPZ(comps as never, wires as never, plugins as never, { type: 'pz', inputNode: 'v1:p', outputNode: 'r2:b' });
const t = r.traces[0] as unknown as { xValues: Float64Array; yValues: Float64Array };
const truePole = -1 / ((R1 + R2) * C); // series discharge loop: A→R1→ground→R2→B
console.log(`poles reported: ${t.xValues.length}`);
for (let i = 0; i < t.xValues.length; i++) {
  console.log(`  s = ${t.xValues[i].toExponential(4)} ${t.yValues[i] !== 0 ? '+ ' + t.yValues[i].toExponential(4) + 'i' : ''}`);
}
console.log(`true pole: ${truePole.toExponential(4)}`);
const poles = Array.from(t.xValues).filter((x) => Math.abs(x) < 1e10);
if (poles.length === 1 && Math.abs(poles[0] - truePole) < Math.abs(truePole) * 0.05) {
  console.log('PASS: AC-coupled pole correct (single pole, 5% tolerance)');
} else {
  console.log('FAIL: AC-coupled pole wrong');
  process.exit(1);
}
