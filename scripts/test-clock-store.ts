// Test: verify the digital clock counts when simulating through the store's
// step() function (which saves/restores simContext across calls).
// This reproduces the bug where the fast-forward was lost between step() calls.

import { simulateStep } from '../src/lib/circuit/engine';
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

  // Simulate the store's step() function:
  // - Save simContext after each step() call
  // - Restore from simContext on the next step() call
  // - Apply the digital fast-forward (same logic as the store)
  let simContext: SimContext | null = null;

  const readTime = (sim: SimContext): string => {
    const ics = ['ic_ht', 'ic_ho', 'ic_mt', 'ic_mo', 'ic_st', 'ic_so'];
    let time = '';
    for (const icId of ics) {
      const ic = doc.components.find(c => c.id === icId)!;
      const plugin = plugins.get('cd4026')!;
      const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
      const terms = getTerminalsForComponent(ic, plugin, nodeMap);
      const key = `cd4026_${terms.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
      const st = sim.state[key] ?? { count: 0 };
      time += st.count;
      if (icId === 'ic_ho' || icId === 'ic_mo' || icId === 'ic_so') time += ':';
    }
    return time.slice(0, -1); // remove trailing ':'
  };

  // Run 100 step() calls (simulating ~100 frames at 60Hz = ~1.7 seconds real time)
  const dt = 1e-4;
  const speed = 1;
  const subSteps = Math.max(1, Math.floor(speed));
  const times: string[] = [];

  for (let frame = 0; frame < 100; frame++) {
    // Build prev from simContext (exactly like the store)
    const persistentState = simContext?.state ?? {};
    const prev = simContext
      ? {
          nodeVoltage: simContext.nodeVoltage,
          branchCurrent: simContext.branchCurrent,
          time: simContext.time,
          state: persistentState,
        }
      : { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: persistentState };

    let result: { sim: SimContext; branchCurrentSize: number; nodeMap: any } | null = null;
    for (let i = 0; i < subSteps; i++) {
      result = simulateStep(doc.components, doc.wires, plugins, prev, dt);
      if (!result) break;
      prev.nodeVoltage = result.sim.nodeVoltage;
      prev.branchCurrent = result.sim.branchCurrent;
      prev.time = result.sim.time;
      prev.state = result.sim.state;

      // Digital fast-forward (same logic as the store)
      const hasCapacitor = doc.components.some(c => c.type === 'capacitor' || c.type === 'inductor');
      const hasPulseSource = doc.components.some(c => c.type === 'pulseSource');
      const hasArduino = doc.components.some(c => c.type === 'arduinoReal' || c.type === 'arduino');
      if (hasPulseSource && !hasCapacitor && !hasArduino) {
        let minFreq = Infinity;
        for (const c of doc.components) {
          if (c.type === 'pulseSource') {
            const f = c.parameters.frequency as number;
            if (f > 0 && f < minFreq) minFreq = f;
          }
        }
        if (minFreq !== Infinity && minFreq > 0) {
          const currentTime = result.sim.time;
          const phase = (currentTime * minFreq) % 1;
          const timeToRisingEdge = (1.0 - phase) / minFreq;
          const advance = Math.min(0.016, timeToRisingEdge + 0.001);
          if (advance > dt) {
            const newTime = currentTime + advance;
            prev.time = newTime;
            result.sim.time = newTime; // CRITICAL: persist to simContext
          }
        }
      }
    }
    if (!result) break;

    // Save simContext (like the store does)
    simContext = result.sim;

    times.push(`frame ${frame}: t=${simContext.time.toFixed(3)}s → ${readTime(simContext)}`);
  }

  console.log('=== Digital Clock — Store Simulation Test ===\n');
  for (let i = 0; i < times.length; i += 10) {
    console.log(times[i]);
  }

  // Check if it counted
  const counts = times.map(t => parseInt(t.split('→ ')[1].split(':')[2]));
  const distinctCounts = new Set(counts);
  console.log(`\nSeconds-ones counts seen: ${[...distinctCounts].sort((a,b) => a-b).join(',')} (${distinctCounts.size} distinct)`);

  if (distinctCounts.size >= 2) {
    console.log('✓ Clock is counting!');
  } else {
    console.log('✗ Clock NOT counting — fast-forward not persisting');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
