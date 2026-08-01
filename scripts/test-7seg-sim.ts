// Test: simulate the 7-segment example and verify segments light up.

import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { exampleSevenSeg } from '../src/lib/circuit/examples';
import type { ComponentPlugin } from '../src/lib/circuit/types';

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

  const doc = exampleSevenSeg;
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of doc.components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }

  // Initialize simState
  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }

  let prev: any = undefined;
  let sim: any = null;
  // Run enough steps for the sketch to execute (500ms wait, dt=2ms → 250 steps per digit)
  // Check at t=100ms (digit 0), t=600ms (digit 1), t=1100ms (digit 2)
  const checkTimes = [0.1, 0.6, 1.1];
  const expectedDigits = [
    { name: '0', on: ['a', 'b', 'c', 'd', 'e', 'f'], off: ['g'] },
    { name: '1', on: ['b', 'c'], off: ['a', 'd', 'e', 'f', 'g'] },
    { name: '2', on: ['a', 'b', 'd', 'e', 'g'], off: ['c', 'f'] },
  ];

  for (let checkIdx = 0; checkIdx < checkTimes.length; checkIdx++) {
    const targetTime = checkTimes[checkIdx];
    const numSteps = Math.ceil(targetTime / 1e-3);
    // Reset
    let prev2: any = undefined;
    let sim2: any = null;
    for (const comp of doc.components) {
      if (!comp.simState) comp.simState = {};
      comp.simState.__inited = false;
    }
    for (let i = 0; i < numSteps; i++) {
      const r = simulateStep(doc.components, doc.wires, plugins, prev2, 1e-3);
      if (!r) break;
      sim2 = r.sim;
      prev2 = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    if (!sim2) { console.log('simulation failed'); process.exit(1); }

    const seg1 = doc.components.find(c => c.id === 'seg1')!;
    const segPlugin = plugins.get('sevenSegment')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(seg1, segPlugin, nodeMap);
    const expected = expectedDigits[checkIdx];

    console.log(`\n=== At t=${targetTime}s (expected digit ${expected.name}) ===`);
    console.log('Actual time:', sim2.time.toFixed(3), 's');
    let litSegments: string[] = [];
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const term = terms.find(t => t.terminalId === seg);
      if (!term) continue;
      const v = sim2.nodeVoltage[term.nodeId];
      const on = v > 2.0;
      console.log(`  seg.${seg}: V=${v.toFixed(3)}V ${on ? '(ON)' : '(off)'}`);
      if (on) litSegments.push(seg);
    }
    const matchesExpected = expected.on.every(s => litSegments.includes(s)) && expected.off.every(s => !litSegments.includes(s));
    console.log(`Expected ON: ${expected.on.join(',')}`);
    console.log(`Actual ON:   ${litSegments.join(',')}`);
    console.log(matchesExpected ? '✓ Correct!' : '✗ Mismatch');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
