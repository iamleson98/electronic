// Debug: trace what the 555 Timer Clock counts step-by-step.
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

  const read555Out = (sim: SimContext): number => {
    const t555 = doc.components.find(c => c.id === 't555')!;
    const plugin = plugins.get('timer555')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(t555, plugin, nodeMap);
    const outNode = terms.find(t => t.terminalId === 'out')!.nodeId;
    return sim.nodeVoltage[outNode] ?? 0;
  };

  let prev: any = undefined;
  let sim: SimContext | null = null;

  console.log('=== 555 Clock Trace (first 60 steps) ===');
  console.log('step  time      555_out  so  st  display');

  for (let i = 0; i < 200; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) break;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };

    // Fast-forward for astable 555
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
    if (minFreq !== Infinity) {
      const phase = (sim.time * minFreq) % 1;
      const timeToRisingEdge = (1.0 - phase) / minFreq;
      const advance = Math.min(0.016, timeToRisingEdge + 0.001);
      if (advance > 1e-4) prev.time = sim.time + advance;
    }

    if (i % 5 === 0 || i < 10) {
      const so = readCount(sim, 'ic_so');
      const st = readCount(sim, 'ic_st');
      const vOut = read555Out(sim);
      console.log(`${String(i).padStart(3)}   ${sim.time.toFixed(4).padStart(8)}  ${vOut.toFixed(2)}    ${so}   ${st}   ${st}${so}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
