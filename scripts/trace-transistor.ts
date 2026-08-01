// Trace transistor switch simulation step-by-step

import { simulateStep, computeComponentCurrents } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

function buildCircuit(pressed: boolean) {
  const components: CircuitComponent[] = [
    { id: 'v1', type: 'dcVoltage', position: { x: 4, y: 4 }, rotation: 0, parameters: { voltage: 5 } },
    { id: 'v2', type: 'dcVoltage', position: { x: 4, y: 16 }, rotation: 0, parameters: { voltage: 5 } },
    { id: 'btn1', type: 'pushButton', position: { x: 8, y: 16 }, rotation: 0, parameters: { pressed, resistance_on: 0.01, resistance_off: 1e15 } },
    { id: 'rb', type: 'resistor', position: { x: 14, y: 16 }, rotation: 0, parameters: { resistance: 10000 } },
    { id: 'rc', type: 'resistor', position: { x: 14, y: 4 }, rotation: 0, parameters: { resistance: 1000 } },
    { id: 'q1', type: 'npn', position: { x: 22, y: 8 }, rotation: 0, parameters: { hfe: 100, vbe: 0.7, satV: 0.2 } },
    { id: 'led1', type: 'led', position: { x: 22, y: 4 }, rotation: 0, parameters: { color: 'red', forwardV: 2.0, seriesR: 1 } },
    { id: 'gnd1', type: 'ground', position: { x: 5, y: 22 }, rotation: 0, parameters: {} },
  ];
  const wires: Wire[] = [
    { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'rc', terminalId: 'a' }, waypoints: [[5, 5]] },
    { id: 'w3', from: { componentId: 'rc', terminalId: 'b' }, to: { componentId: 'led1', terminalId: 'a' }, waypoints: [[18, 5]] },
    { id: 'w4', from: { componentId: 'led1', terminalId: 'k' }, to: { componentId: 'q1', terminalId: 'c' }, waypoints: [[26, 5], [26, 9]] },
    { id: 'w5', from: { componentId: 'v2', terminalId: 'p' }, to: { componentId: 'btn1', terminalId: 'a' }, waypoints: [[5, 17]] },
    { id: 'w7', from: { componentId: 'btn1', terminalId: 'b' }, to: { componentId: 'rb', terminalId: 'a' }, waypoints: [] },
    { id: 'w8', from: { componentId: 'rb', terminalId: 'b' }, to: { componentId: 'q1', terminalId: 'b' }, waypoints: [[18, 17], [22, 17], [22, 10]] },
    { id: 'w2', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd1', terminalId: 'g' }, waypoints: [[5, 8], [5, 22]] },
    { id: 'w6', from: { componentId: 'v2', terminalId: 'n' }, to: { componentId: 'gnd1', terminalId: 'g' }, waypoints: [[5, 20], [5, 22]] },
    { id: 'w9', from: { componentId: 'q1', terminalId: 'e' }, to: { componentId: 'gnd1', terminalId: 'g' }, waypoints: [[25, 12], [25, 22], [5, 22]] },
  ];
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }
  return { components, wires, plugins };
}

function nodeOf(c: any, compId: string, termId: string): number {
  const nodeMap = buildNodeMap(c.components, c.wires, c.plugins);
  const comp = c.components.find((x: any) => x.id === compId)!;
  const plugin = c.plugins.get(comp.type)!;
  const terms = getTerminalsForComponent(comp, plugin, nodeMap);
  return terms.find(t => t.terminalId === termId)?.nodeId ?? 0;
}

async function main() {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/advanced');
  await import('../src/lib/circuit/components/advanced-devices');
  await import('../src/lib/circuit/components/arduino-real');
  await import('../src/lib/circuit/components/kicad-parity');
  await import('../src/lib/circuit/components/power-symbols');

  const c1 = buildCircuit(true);
  const bN = nodeOf(c1, 'q1', 'b');
  const cN = nodeOf(c1, 'q1', 'c');
  const aN = nodeOf(c1, 'led1', 'a');

  let prev: any = undefined;
  for (let i = 0; i < 8; i++) {
    const r = simulateStep(c1.components, c1.wires, c1.plugins, prev, 1e-4);
    if (!r) { console.log(`step ${i}: solve failed`); break; }
    const sim = r.sim;
    const vB = sim.nodeVoltage[bN];
    const vC = sim.nodeVoltage[cN];
    const vA = sim.nodeVoltage[aN];
    const npnState = sim.state.__global?.[`npn_${cN}_${bN}_${nodeOf(c1, 'q1', 'e')}`];
    const npnIb = sim.state.__global?.[`npn_${cN}_${bN}_${nodeOf(c1, 'q1', 'e')}_ib`];
    const ledState = sim.state.__global?.[`led_${aN}_${cN}`];
    console.log(`step ${i}: V_B=${vB?.toFixed(4)} V_C=${vC?.toFixed(4)} V_A=${vA?.toFixed(4)} npn_on=${npnState} npn_ib=${(npnIb*1000)?.toFixed(4)}mA led_on=${ledState}`);
    prev = { nodeVoltage: sim.nodeVoltage, branchCurrent: sim.branchCurrent, time: sim.time, state: sim.state };
  }
}

main().catch(e => { console.error(e); process.exit(1); });
