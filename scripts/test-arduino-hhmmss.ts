// Test: verify the Arduino Clock (HH:MM:SS) counts correctly.
import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { exampleArduinoClockHHMMSS } from '../src/lib/circuit/examples';
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

  const doc = exampleArduinoClockHHMMSS;
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of doc.components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }
  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }

  // Store simulation (saves/restores simContext)
  let simContext: SimContext | null = null;
  const dt = 1e-4;

  const readSegs = (sim: SimContext, segId: string): string => {
    const seg = doc.components.find(c => c.id === segId)!;
    const plugin = plugins.get('sevenSegment')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(seg, plugin, nodeMap);
    const key = `7seg_${terms.map(t => t.nodeId).join('_')}`;
    const segState = (sim.state[key] || {}) as Record<string, boolean>;
    const on = ['a','b','c','d','e','f','g'].filter(s => segState[s]).join(',');
    const map: Record<string, string> = {
      'a,b,c,d,e,f': '0', 'b,c': '1', 'a,b,d,e,g': '2', 'a,b,c,d,g': '3',
      'b,c,f,g': '4', 'a,c,d,f,g': '5', 'a,c,d,e,f,g': '6', 'a,b,c': '7',
      'a,b,c,d,e,f,g': '8', 'a,b,c,d,f,g': '9',
    };
    return map[on] ?? '?';
  };

  console.log('=== Arduino Clock (HH:MM:SS) — Store Simulation ===\n');
  console.log('frame  time       display');
  console.log('───────────────────────────────');

  for (let frame = 0; frame < 500; frame++) {
    const persistentState = simContext?.state ?? {};
    const prev = simContext
      ? { nodeVoltage: simContext.nodeVoltage, branchCurrent: simContext.branchCurrent, time: simContext.time, state: persistentState }
      : { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: persistentState };

    const result = simulateStep(doc.components, doc.wires, plugins, prev, dt);
    if (!result) break;
    simContext = result.sim;

    if (frame % 10 === 0 || frame < 10) {
      const h1 = readSegs(simContext, 'seg_h1');
      const h2 = readSegs(simContext, 'seg_h2');
      const m1 = readSegs(simContext, 'seg_m1');
      const m2 = readSegs(simContext, 'seg_m2');
      const s1 = readSegs(simContext, 'seg_s1');
      const s2 = readSegs(simContext, 'seg_s2');
      console.log(`${String(frame).padStart(4)}   ${simContext.time.toFixed(3).padStart(8)}s  ${h1}${h2}:${m1}${m2}:${s1}${s2}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
