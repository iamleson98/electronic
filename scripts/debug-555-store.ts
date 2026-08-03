// Debug: verify the 555 Timer Clock counts correctly in the store simulation.
// Reproduces the exact step() behavior including simContext save/restore.
import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { example555Clock } from '../src/lib/circuit/examples';
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

  const doc = example555Clock;
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of doc.components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }
  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }

  const readCount = (sim: SimContext, icId: string): number => {
    const ic = doc.components.find(c => c.id === icId)!;
    const plugin = plugins.get('cd4026')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(ic, plugin, nodeMap);
    const key = `cd4026_${terms.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
    return sim.state[key]?.count ?? 0;
  };

  // Simulate the store's step() function exactly (saves/restores simContext)
  let simContext: SimContext | null = null;
  const dt = 1e-4;
  const speed = 1;
  const subSteps = Math.max(1, Math.floor(speed));

  console.log('=== 555 Clock — Store Simulation (saves/restores simContext) ===');
  console.log('frame  time      display');
  console.log('─────────────────────────────');

  const displays: string[] = [];
  for (let frame = 0; frame < 150; frame++) {
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

      // Same fast-forward as the store — but print when we advance
      const hasAstable555 = doc.components.some(c =>
        c.type === 'timer555' && (c.parameters.astable as boolean) === true);
      if (hasAstable555) {
        let minFreq = Infinity;
        for (const c of doc.components) {
          if (c.type === 'timer555' && (c.parameters.astable as boolean) === true) {
            const r1 = (c.parameters.r1 as number) || 47000;
            const r2 = (c.parameters.r2 as number) || 47000;
            const cap = (c.parameters.c as number) || 1e-5;
            const period = 0.693 * (r1 + 2 * r2) * cap;
            const f = 1 / period;
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
            result.sim.time = newTime;
          }
        }
      }
    }
    if (!result) break;
    simContext = result.sim;

    const so = readCount(simContext, 'ic_so');
    const st = readCount(simContext, 'ic_st');
    const display = `${st}${so}`;
    displays.push(display);
    // Print every frame for first 30, then every 10
    if (frame < 30 || frame % 10 === 0) {
      console.log(`${String(frame).padStart(4)}   ${simContext.time.toFixed(4).padStart(8)}  ${display}`);
    }
  }

  // Check the sequence
  console.log('\n=== Sequence Check ===');
  let prevDisplay = '00';
  let sequenceOk = true;
  for (let i = 1; i < displays.length; i++) {
    const prev = displays[i - 1];
    const curr = displays[i];
    if (prev === curr) continue; // same value (didn't tick yet)
    const prevNum = parseInt(prev);
    const currNum = parseInt(curr);
    const expected = (prevNum + 1) % 60;
    if (currNum !== expected) {
      console.log(`  ✗ At frame ${i}: ${prev} → ${curr} (expected ${String(expected).padStart(2, '0')})`);
      sequenceOk = false;
      if (i > 30) break;
    }
    prevDisplay = curr;
  }
  if (sequenceOk) {
    console.log('  ✓ Counting sequence is correct (00 → 01 → 02 → ... → 59 → 00)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
