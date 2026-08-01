// Test: transistor switch circuit — verify that when the push button is open,
// no current flows through the LED / resistor / npn collector path.

import { simulateStep, computeComponentCurrents, computeWireCurrents } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

function buildCircuit(pressed: boolean): { components: CircuitComponent[]; wires: Wire[]; plugins: Map<string, ComponentPlugin> } {
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

function nodeOf(components: CircuitComponent[], wires: Wire[], plugins: Map<string, ComponentPlugin>, compId: string, termId: string): number {
  const nodeMap = buildNodeMap(components, wires, plugins);
  const comp = components.find(c => c.id === compId)!;
  const plugin = plugins.get(comp.type)!;
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

  // === Phase 1: button pressed — should conduct ===
  console.log('\n=== Phase 1: button PRESSED ===');
  const c1 = buildCircuit(true);
  let prev: any = undefined;
  let sim: any = null;
  for (let i = 0; i < 30; i++) {
    const r = simulateStep(c1.components, c1.wires, c1.plugins, prev, 1e-4);
    if (!r) { console.log('solve failed at step', i); break; }
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  if (!sim) return;
  const bNode1 = nodeOf(c1.components, c1.wires, c1.plugins, 'q1', 'b');
  const cNode1 = nodeOf(c1.components, c1.wires, c1.plugins, 'q1', 'c');
  const eNode1 = nodeOf(c1.components, c1.wires, c1.plugins, 'q1', 'e');
  const ledANode1 = nodeOf(c1.components, c1.wires, c1.plugins, 'led1', 'a');
  const ledKNode1 = nodeOf(c1.components, c1.wires, c1.plugins, 'led1', 'k');
  const compCurrents1 = computeComponentCurrents(c1.components, c1.wires, c1.plugins, sim);
  const wireCurrents1 = computeWireCurrents(c1.components, c1.wires, c1.plugins, sim);
  console.log('  V_B (q1.b)    =', sim.nodeVoltage[bNode1]?.toFixed(4), 'V');
  console.log('  V_C (q1.c)    =', sim.nodeVoltage[cNode1]?.toFixed(4), 'V');
  console.log('  V_E (q1.e)    =', sim.nodeVoltage[eNode1]?.toFixed(4), 'V');
  console.log('  V_A (led1.a)  =', sim.nodeVoltage[ledANode1]?.toFixed(4), 'V');
  console.log('  V_K (led1.k)  =', sim.nodeVoltage[ledKNode1]?.toFixed(4), 'V');
  console.log('  LED current   =', compCurrents1.get('led1')?.toFixed(6), 'A');
  console.log('  NPN current   =', compCurrents1.get('q1')?.toFixed(6), 'A');
  console.log('  Rc current    =', compCurrents1.get('rc')?.toFixed(6), 'A');
  console.log('  wire w3 (rc→LED):', wireCurrents1.get('w3')?.toFixed(6), 'A');

  // === Phase 2: button released ===
  console.log('\n=== Phase 2: button RELEASED ===');
  const c2 = buildCircuit(false);
  let prev2 = prev;
  let sim2: any = null;
  for (let i = 0; i < 30; i++) {
    const r = simulateStep(c2.components, c2.wires, c2.plugins, prev2, 1e-4);
    if (!r) { console.log('solve failed at step', i); break; }
    sim2 = r.sim;
    prev2 = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }
  if (!sim2) return;
  const bNode2 = nodeOf(c2.components, c2.wires, c2.plugins, 'q1', 'b');
  const cNode2 = nodeOf(c2.components, c2.wires, c2.plugins, 'q1', 'c');
  const ledKNode2 = nodeOf(c2.components, c2.wires, c2.plugins, 'led1', 'k');
  const compCurrents2 = computeComponentCurrents(c2.components, c2.wires, c2.plugins, sim2);
  const wireCurrents2 = computeWireCurrents(c2.components, c2.wires, c2.plugins, sim2);
  console.log('  V_B (q1.b)    =', sim2.nodeVoltage[bNode2]?.toFixed(4), 'V');
  console.log('  V_C (q1.c)    =', sim2.nodeVoltage[cNode2]?.toFixed(4), 'V');
  console.log('  V_K (led1.k)  =', sim2.nodeVoltage[ledKNode2]?.toFixed(4), 'V');
  console.log('  LED current   =', compCurrents2.get('led1')?.toFixed(6), 'A');
  console.log('  NPN current   =', compCurrents2.get('q1')?.toFixed(6), 'A');
  console.log('  Rc current    =', compCurrents2.get('rc')?.toFixed(6), 'A');
  console.log('  wire w3 (rc→LED):', wireCurrents2.get('w3')?.toFixed(6), 'A');

  // Assertions
  const ledOn = Math.abs(compCurrents1.get('led1') ?? 0) > 0.0001;
  const npnOn = Math.abs(compCurrents1.get('q1') ?? 0) > 0.0001;
  const ledOff = Math.abs(compCurrents2.get('led1') ?? 0) < 0.0001;
  const npnOff = Math.abs(compCurrents2.get('q1') ?? 0) < 0.0001;
  console.log('\n=== Assertions ===');
  console.log('  Button pressed  → LED glowing :', ledOn ? 'PASS' : 'FAIL');
  console.log('  Button pressed  → NPN conducting:', npnOn ? 'PASS' : 'FAIL');
  console.log('  Button released → LED dark    :', ledOff ? 'PASS' : 'FAIL');
  console.log('  Button released → NPN off     :', npnOff ? 'PASS' : 'FAIL');
  if (ledOn && npnOn && ledOff && npnOff) {
    console.log('\n✓ All assertions pass.');
  } else {
    console.log('\n✗ Some assertions failed.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
