// Debug: trace CO voltage and tens counter state for the Simple Seconds Counter.
import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { exampleSimpleClock } from '../src/lib/circuit/examples';
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

  const doc = exampleSimpleClock;
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

  const readCoV = (sim: SimContext, icId: string): number => {
    const ic = doc.components.find(c => c.id === icId)!;
    const plugin = plugins.get('cd4026')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(ic, plugin, nodeMap);
    const coNode = terms.find(t => t.terminalId === 'co')!.nodeId;
    return sim.nodeVoltage[coNode] ?? 0;
  };

  let simContext: SimContext | null = null;
  const dt = 1e-4;

  console.log('frame  time     so  co_so  st  display');
  console.log('──────────────────────────────────────────');

  for (let frame = 0; frame < 800; frame++) {
    const persistentState = simContext?.state ?? {};
    const prev = simContext
      ? { nodeVoltage: simContext.nodeVoltage, branchCurrent: simContext.branchCurrent, time: simContext.time, state: persistentState }
      : { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: persistentState };

    const result = simulateStep(doc.components, doc.wires, plugins, prev, dt);
    if (!result) break;
    simContext = result.sim;

    // Fast-forward
    const phase = (simContext.time * 1) % 1;
    const timeToRisingEdge = (1.0 - phase) / 1;
    const advance = Math.min(0.016, timeToRisingEdge + 0.001);
    if (advance > dt) simContext.time = simContext.time + advance;

    const so = readCount(simContext, 'ic_so');
    const st = readCount(simContext, 'ic_st');
    const coV = readCoV(simContext, 'ic_so');
    if (frame % 40 === 0 || so === 9 || so === 0) {
      console.log(`${String(frame).padStart(4)}   ${simContext.time.toFixed(3).padStart(7)}s  ${so}   ${coV.toFixed(1)}    ${st}   ${st}${so}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
