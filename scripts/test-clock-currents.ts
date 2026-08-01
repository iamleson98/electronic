// Test: check wire currents in the clock circuit.
// For a digit showing "1" (segments b, c ON), the b and c wires should have
// current, while a, d, e, f, g wires should have ~0.

import { simulateStep, computeComponentCurrents, computeWireCurrents } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { exampleClock } from '../src/lib/circuit/examples';
import type { ComponentPlugin, SimContext } from '../src/lib/circuit/types';

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

  const doc = exampleClock;
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of doc.components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }
  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }

  // Simulate until we reach a known digit (e.g., 00:00:01 → sec-ones shows "1")
  let simContext: SimContext | null = null;
  const dt = 1e-4;

  for (let frame = 0; frame < 100; frame++) {
    const persistentState = simContext?.state ?? {};
    const prev = simContext
      ? { nodeVoltage: simContext.nodeVoltage, branchCurrent: simContext.branchCurrent, time: simContext.time, state: persistentState }
      : { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: persistentState };

    const result = simulateStep(doc.components, doc.wires, plugins, prev, dt);
    if (!result) break;

    // Fast-forward (same as store)
    const hasPulseSource = doc.components.some(c => c.type === 'pulseSource');
    if (hasPulseSource) {
      let minFreq = Infinity;
      for (const c of doc.components) {
        if (c.type === 'pulseSource') {
          const f = c.parameters.frequency as number;
          if (f > 0 && f < minFreq) minFreq = f;
        }
      }
      if (minFreq !== Infinity) {
        const currentTime = result.sim.time;
        const phase = (currentTime * minFreq) % 1;
        const timeToRisingEdge = (1.0 - phase) / minFreq;
        const advance = Math.min(0.016, timeToRisingEdge + 0.001);
        if (advance > dt) {
          result.sim.time = currentTime + advance;
        }
      }
    }
    simContext = result.sim;
  }

  if (!simContext) { console.log('simulation failed'); process.exit(1); }

  // Check the sec-ones digit (should be showing "1" at t≈1s)
  const segIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const wireCurrents = computeWireCurrents(doc.components, doc.wires, plugins, simContext);

  console.log('=== Wire Currents for sec-ones digit (should show "1": b,c ON) ===');
  console.log('(t =', simContext.time.toFixed(3), 's)\n');

  // Read the sec-ones count
  const soIc = doc.components.find(c => c.id === 'ic_so')!;
  const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
  const soTerms = getTerminalsForComponent(soIc, plugins.get('cd4026')!, nodeMap);
  const soKey = `cd4026_${soTerms.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
  const soSt = simContext.state[soKey] ?? { count: 0 };
  console.log(`sec-ones count = ${soSt.count} (digit "${soSt.count}")\n`);

  for (const seg of segIds) {
    const wId = `so_${seg}`;
    const i = wireCurrents.get(wId) ?? 0;
    const expected = soSt.count === 1 ? (seg === 'b' || seg === 'c' ? 'ON ' : 'OFF') : '?';
    console.log(`  ${wId}: ${i.toFixed(6)} A  (abs=${Math.abs(i).toFixed(6)})  expected: ${expected}`);
  }

  // Also check VCC, GND, COM, CLK, CO wires
  console.log('\n=== Power/Control Wire Currents ===');
  const powerWires = ['vcc_so', 'gnd_so', 'rst_so', 'com_so', 'clk_so'];
  for (const wId of powerWires) {
    const i = wireCurrents.get(wId) ?? 0;
    console.log(`  ${wId}: ${i.toFixed(6)} A  (abs=${Math.abs(i).toFixed(6)})`);
  }

  // Check all 6 digits — each should have different total current depending on digit
  console.log('\n=== All 6 Digits — Total Segment Current ===');
  const digitIds = ['ht', 'ho', 'mt', 'mo', 'st', 'so'];
  for (const d of digitIds) {
    let totalI = 0;
    for (const seg of segIds) {
      totalI += Math.abs(wireCurrents.get(`${d}_${seg}`) ?? 0);
    }
    const icId = `ic_${d}`;
    const ic = doc.components.find(c => c.id === icId)!;
    const plugin = plugins.get('cd4026')!;
    const nm = buildNodeMap(doc.components, doc.wires, plugins);
    const ts = getTerminalsForComponent(ic, plugin, nm);
    const key = `cd4026_${ts.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
    const count = simContext.state[key]?.count ?? 0;
    console.log(`  ${d} (digit ${count}): total segment current = ${(totalI * 1000).toFixed(2)} mA`);
  }

  // Check if ON segments have more current than OFF segments
  const onCurrents: number[] = [];
  const offCurrents: number[] = [];
  for (const seg of segIds) {
    const i = Math.abs(wireCurrents.get(`so_${seg}`) ?? 0);
    const isOn = seg === 'b' || seg === 'c'; // digit "1"
    if (isOn) onCurrents.push(i);
    else offCurrents.push(i);
  }
  const avgOn = onCurrents.reduce((a, b) => a + b, 0) / onCurrents.length;
  const avgOff = offCurrents.reduce((a, b) => a + b, 0) / offCurrents.length;
  console.log(`\nAvg ON segment current:  ${(avgOn * 1000).toFixed(2)} mA`);
  console.log(`Avg OFF segment current: ${(avgOff * 1000).toFixed(4)} mA`);

  if (avgOn > 0.001 && avgOff < 0.0001) {
    console.log('✓ ON segments conduct, OFF segments do not.');
  } else {
    console.log('✗ Wire currents are NOT differentiated (bug!)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
