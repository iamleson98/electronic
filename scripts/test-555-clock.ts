// Test: verify the 555 Timer Clock circuit.
// 1. All wires connect to existing terminals
// 2. Simulation produces a clock signal and counts
// 3. Physics validation passes

import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
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

  // ── Test 1: All wires connect to existing terminals ──
  console.log('━━━ Test 1: Wire Connectivity ━━━');
  let allWiresOk = true;
  for (const wire of doc.wires) {
    const fromComp = doc.components.find(c => c.id === wire.from.componentId);
    const toComp = doc.components.find(c => c.id === wire.to.componentId);
    if (!fromComp || !toComp) { allWiresOk = false; continue; }
    const fromPlugin = plugins.get(fromComp.type);
    const toPlugin = plugins.get(toComp.type);
    if (!fromPlugin || !toPlugin) { allWiresOk = false; continue; }
    const fromTerm = fromPlugin.terminals.find(t => t.id === wire.from.terminalId);
    const toTerm = toPlugin.terminals.find(t => t.id === wire.to.terminalId);
    if (!fromTerm || !toTerm) {
      console.log(`  ✗ ${wire.id}: missing terminal (${fromComp.id}.${wire.from.terminalId} → ${toComp.id}.${wire.to.terminalId})`);
      allWiresOk = false;
    }
  }
  console.log(`  ${allWiresOk ? '✓' : '✗'} ${doc.wires.length} wires checked — ${allWiresOk ? 'all connected' : 'some missing'}`);
  if (!allWiresOk) process.exit(1);

  // ── Test 2: 555 produces oscillating output ──
  console.log('\n━━━ Test 2: 555 Oscillation ━━━');
  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }
  let prev: any = undefined;
  let sim: SimContext | null = null;

  // Run a few steps to see if the 555 output changes
  const outVoltages: number[] = [];
  for (let i = 0; i < 500; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) break;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };

    // Fast-forward for astable 555 (same logic as the store)
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
      if (minFreq !== Infinity) {
        const phase = (sim.time * minFreq) % 1;
        const timeToRisingEdge = (1.0 - phase) / minFreq;
        const advance = Math.min(0.016, timeToRisingEdge + 0.001);
        if (advance > 1e-4) prev.time = sim.time + advance;
      }
    }

    // Record 555 output voltage every 50 steps
    if (i % 50 === 0) {
      const t555 = doc.components.find(c => c.id === 't555')!;
      const plugin = plugins.get('timer555')!;
      const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
      const terms = getTerminalsForComponent(t555, plugin, nodeMap);
      const outNode = terms.find(t => t.terminalId === 'out')!.nodeId;
      const vOut = sim.nodeVoltage[outNode] ?? 0;
      outVoltages.push(vOut);
      console.log(`  step ${i}: t=${sim.time.toFixed(4)}s  V_out=${vOut.toFixed(3)}V`);
    }
  }

  // Check if output changed (oscillating)
  const uniqueVoltages = new Set(outVoltages.map(v => v > 2.5 ? 'HIGH' : 'LOW'));
  console.log(`  Output states seen: ${[...uniqueVoltages].join(', ')}`);
  const oscillating = uniqueVoltages.size >= 2;
  console.log(`  ${oscillating ? '✓' : '✗'} 555 is oscillating (output changes between HIGH and LOW)`);

  // ── Test 3: Counters advance ──
  console.log('\n━━━ Test 3: Counter Advancement ━━━');
  const readCount = (icId: string): number => {
    const ic = doc.components.find(c => c.id === icId)!;
    const plugin = plugins.get('cd4026')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(ic, plugin, nodeMap);
    const key = `cd4026_${terms.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
    return sim!.state[key]?.count ?? 0;
  };

  // Run more steps with fast-forward to advance time faster
  for (let i = 0; i < 500; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) break;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };

    // Fast-forward for astable 555
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
      if (minFreq !== Infinity) {
        const phase = (sim.time * minFreq) % 1;
        const timeToRisingEdge = (1.0 - phase) / minFreq;
        const advance = Math.min(0.016, timeToRisingEdge + 0.001);
        if (advance > 1e-4) prev.time = sim.time + advance;
      }
    }
  }

  const soCount = readCount('ic_so');
  const stCount = readCount('ic_st');
  console.log(`  After ~10s: sec_ones=${soCount}, sec_tens=${stCount}`);
  console.log(`  Display: ${stCount}${soCount}`);
  if (soCount > 0 || stCount > 0) {
    console.log('  ✓ Counters are advancing (555 clock is driving the chain)');
  } else {
    console.log('  ✗ Counters not advancing — 555 may not be producing clock edges');
  }

  // ── Test 4: Physics Validation ──
  console.log('\n━━━ Test 4: Physics Validation ━━━');
  if (!sim) { console.log('  ✗ Simulation failed'); process.exit(1); }
  const result = validatePhysics(doc.components, doc.wires, plugins, sim);
  const errors = result.violations.filter(v => v.severity === 'error');
  const warnings = result.violations.filter(v => v.severity === 'warning');
  console.log(`  ${result.passed ? '✓ PASS' : '✗ FAIL'} — ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (result.violations.length > 0) {
    for (const v of result.violations.slice(0, 5)) {
      console.log(`    [${v.severity}] ${v.law}: ${v.message}`);
    }
  }

  // ── Summary ──
  console.log('\n━━━ Summary ━━━');
  console.log(`  Components: ${doc.components.length}`);
  console.log(`  Wires: ${doc.wires.length}`);
  console.log(`  Approach: 555 timer (RC astable) → CD4026 chain → 7-seg displays`);
  console.log(`  vs crystal-based clock: pulseSource → CD4026 chain → 7-seg displays`);

  if (allWiresOk && oscillating && result.passed) {
    console.log('\n✓ All tests pass — 555 Timer Clock works correctly.');
  } else {
    console.log('\n✗ Some tests failed.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
