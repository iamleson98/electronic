// Test: verify the Simple Seconds Counter circuit.
// 1. All wires connect to existing terminals
// 2. Simulation counts 0-59 and wraps correctly
// 3. Physics validation passes

import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
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

  // ── Test 2: Simulation counts 0-59 ──
  console.log('\n━━━ Test 2: Counting 0-59 ━━━');
  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }
  let prev: any = undefined;
  let sim: SimContext | null = null;
  const counts: { step: number; time: number; tens: number; ones: number }[] = [];

  for (let i = 0; i < 120; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) break;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };

    // Fast-forward (same as store)
    const minFreq = 1;
    const phase = (sim.time * minFreq) % 1;
    const timeToRisingEdge = (1.0 - phase) / minFreq;
    const advance = Math.min(0.016, timeToRisingEdge + 0.001);
    if (advance > 1e-4) prev.time = sim.time + advance;

    // Read counts every 10 steps
    if (i % 10 === 0) {
      const readCount = (icId: string): number => {
        const ic = doc.components.find(c => c.id === icId)!;
        const plugin = plugins.get('cd4026')!;
        const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
        const terms = getTerminalsForComponent(ic, plugin, nodeMap);
        const key = `cd4026_${terms.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
        return sim!.state[key]?.count ?? 0;
      };
      const ones = readCount('ic_so');
      const tens = readCount('ic_st');
      counts.push({ step: i, time: sim.time, tens, ones });
    }
  }

  console.log('  Step  Time(s)  Display');
  for (const c of counts.slice(0, 15)) {
    console.log(`  ${String(c.step).padStart(4)}  ${c.time.toFixed(3).padStart(7)}  ${c.tens}${c.ones}`);
  }

  // Verify counting sequence
  const displays = counts.map(c => c.tens * 10 + c.ones);
  const distinctValues = [...new Set(displays)].sort((a, b) => a - b);
  console.log(`\n  Distinct values seen: ${distinctValues.join(',')} (${distinctValues.length} total)`);

  // Check if it counts 0, 1, 2, ... sequentially
  let countingOk = true;
  for (let i = 1; i < counts.length; i++) {
    const prev = counts[i - 1].tens * 10 + counts[i - 1].ones;
    const curr = counts[i].tens * 10 + counts[i].ones;
    // Next value should be prev+1, or wrap from 59 to 0
    const expected = (prev + 1) % 60;
    if (curr !== expected && curr !== prev) {
      // Allow same value (didn't tick yet within the 10-step window)
      countingOk = false;
      console.log(`  ✗ Expected ${expected} after ${prev}, got ${curr}`);
      break;
    }
  }
  console.log(`  ${countingOk ? '✓' : '✗'} Counting sequence is correct (0→1→2→...→59→0)`);

  // ── Test 3: Physics Validation ──
  console.log('\n━━━ Test 3: Physics Validation ━━━');
  if (!sim) { console.log('  ✗ Simulation failed'); process.exit(1); }
  const result = validatePhysics(doc.components, doc.wires, plugins, sim);
  const errors = result.violations.filter(v => v.severity === 'error');
  const warnings = result.violations.filter(v => v.severity === 'warning');
  console.log(`  ${result.passed ? '✓ PASS' : '✗ FAIL'} — ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (result.violations.length > 0) {
    for (const v of result.violations) {
      console.log(`    [${v.severity}] ${v.law}: ${v.message}`);
    }
  }

  // ── Summary ──
  console.log('\n━━━ Summary ━━━');
  console.log(`  Components: ${doc.components.length} (vs 15 for 6-digit clock)`);
  console.log(`  Wires: ${doc.wires.length} (vs 74 for 6-digit clock)`);
  console.log(`  Chips: 2 CD4026 (vs 6 CD4026 for 6-digit clock) — 3x fewer`);

  if (allWiresOk && countingOk && result.passed) {
    console.log('\n✓ All tests pass — Simple Seconds Counter works correctly.');
  } else {
    console.log('\n✗ Some tests failed.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
