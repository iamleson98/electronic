// Debug script: trace runTran pulse-RC and gear quarter-tau sequences.
import { simulateStep, solveDC } from '../src/lib/circuit/engine';
import { runTran } from '../src/lib/circuit/analysis';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

async function main() {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');

  const comp = (type: string, id: string, params?: any): CircuitComponent => {
    const p = getPlugin(type);
    const defaults: any = {};
    if (p) for (const param of p.parameters) defaults[param.key] = param.default;
    return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...defaults, ...params } };
  };
  const wire = (id: string, fc: string, ft: string, tc: string, tt: string): Wire =>
    ({ id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } });
  const pluginsFor = (components: CircuitComponent[]) =>
    new Map(getAllPlugins().filter(p => components.some(c => c.type === p.type)).map(p => [p.type, p]));

  // ── Case A: pulse RC euler, manual live-loop ──
  {
    const components = [
      comp('ground', 'gnd'),
      comp('pulseSource', 'v1', { high: 5, low: 0, frequency: 100, duty: 50 }),
      comp('resistor', 'r1', { resistance: 1000 }),
      comp('capacitor', 'c1', { capacitance: 1e-6 }),
    ];
    const wires = [
      wire('w1', 'v1', 'p', 'r1', 'a'),
      wire('w2', 'v1', 'n', 'gnd', 'g'),
      wire('w3', 'r1', 'b', 'c1', 'a'),
      wire('w4', 'c1', 'b', 'gnd', 'g'),
    ];
    const plugins = pluginsFor(components);
    const dc = solveDC(components, wires, plugins);
    console.log('A: DC op v_c =', dc!.nodeVoltage[1]);
    // live loop from cold
    let prev: any;
    const vals: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(components, wires, plugins, prev, 1e-3);
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
      vals.push(r!.sim.nodeVoltage[1]);
    }
    console.log('A: live-loop (cold start) cap volts per step:', vals.map(v => v.toFixed(6)).join(', '));

    // live loop seeded from DC
    let prev2: any = {
      nodeVoltage: dc!.nodeVoltage, branchCurrent: dc!.branchCurrent, time: 0, state: dc!.state,
    };
    const vals2: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = simulateStep(components, wires, plugins, prev2, 1e-3);
      prev2 = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
      vals2.push(r!.sim.nodeVoltage[1]);
    }
    console.log('A: live-loop (DC-seeded) cap volts per step:', vals2.map(v => v.toFixed(6)).join(', '));

    const result = runTran(components, wires, plugins, { type: 'tran', tStop: 10e-3, tStep: 1e-3, probes: ['c1:a'] });
    console.log('A: runTran trace:', Array.from(result.traces[0].yValues).map(v => v.toFixed(6)).join(', '));
  }

  // ── Case B: gear quarter-tau RC discharge ──
  {
    const components = [
      comp('ground', 'gnd'),
      comp('resistor', 'r1', { resistance: 1000 }),
      comp('capacitor', 'c1', { capacitance: 1e-6, initialV: 5 }),
    ];
    const wires = [
      wire('w1', 'r1', 'a', 'c1', 'a'),
      wire('w2', 'r1', 'b', 'gnd', 'g'),
      wire('w3', 'c1', 'b', 'gnd', 'g'),
    ];
    const plugins = pluginsFor(components);
    let prev: any;
    const vals: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = simulateStep(components, wires, plugins, prev, 2.5e-4, { method: 'gear' });
      prev = { nodeVoltage: r!.sim.nodeVoltage, branchCurrent: r!.sim.branchCurrent, time: r!.sim.time, state: r!.sim.state };
      vals.push(r!.sim.nodeVoltage[1]);
    }
    console.log('B: gear quarter-tau volts:', vals.map(v => v.toPrecision(12)).join(', '));
    console.log('B: expected:            4, 3.142857142857, 2.448979591837, 1.901020408163, 1.472780916285');
    // state dump
    const st = prev.state.__global ?? {};
    console.log('B: cap state keys:', JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, typeof v === 'number' ? v.toPrecision(10) : v]))));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
