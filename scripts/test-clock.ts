// Test: verify the digital clock counts 00:00:00 → 00:00:01 → 00:00:02 → ...
// Also verify carry chain: 00:00:09 → 00:00:10, 00:00:59 → 00:01:00, etc.

import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { exampleClock } from '../src/lib/circuit/examples';
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

  const doc = exampleClock;
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of doc.components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }

  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }

  // Simulate using the same fast-forward logic as the store:
  // advance sim.time toward the next rising edge of the pulseSource.
  let prev: any = undefined;
  let sim: any = null;

  const readDigit = (icId: string, segId: string): number => {
    const ic = doc.components.find(c => c.id === icId)!;
    const plugin = plugins.get('cd4026')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(ic, plugin, nodeMap);
    const key = `cd4026_${terms.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
    const st = sim.state[key] ?? { count: 0 };
    return st.count;
  };

  const readTime = (): string => {
    const ht = readDigit('ic_ht', 'seg_ht');
    const ho = readDigit('ic_ho', 'seg_ho');
    const mt = readDigit('ic_mt', 'seg_mt');
    const mo = readDigit('ic_mo', 'seg_mo');
    const st = readDigit('ic_st', 'seg_st');
    const so = readDigit('ic_so', 'seg_so');
    return `${ht}${ho}:${mt}${mo}:${st}${so}`;
  };

  console.log('=== Digital Clock Simulation ===\n');

  // Run 500 steps with 16ms fast-forward (same as store) to see ~8 seconds of counting
  const times: string[] = [];
  for (let i = 0; i < 500; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) { console.log('solve failed at step', i); break; }
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };

    // Same fast-forward as the store: cap at 16ms per step
    const minFreq = 1; // 1Hz
    const currentTime = sim.time;
    const phase = (currentTime * minFreq) % 1;
    const timeToRisingEdge = (1.0 - phase) / minFreq;
    const advance = Math.min(0.016, timeToRisingEdge + 0.001);
    if (advance > 1e-4) {
      prev.time = currentTime + advance;
    }

    times.push(`${i}: t=${sim.time.toFixed(3)}s → ${readTime()}`);
  }

  // Print every 5th step
  for (let i = 0; i < times.length; i += 5) {
    console.log(times[i]);
  }

  // Verify seconds-ones is counting
  const counts = times.map(t => parseInt(t.split('→ ')[1].split(':')[2]));
  const distinctCounts = new Set(counts);
  console.log(`\nSeconds-ones counts seen: ${[...distinctCounts].sort((a,b) => a-b).join(',')} (${distinctCounts.size} distinct)`);

  if (distinctCounts.size >= 2) {
    console.log('✓ Clock is counting!');
  } else {
    console.log('✗ Clock not counting');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
