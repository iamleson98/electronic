// Test: verify the Arduino Clock (MM:SS) circuit.
import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { exampleArduinoClock } from '../src/lib/circuit/examples';
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

  const doc = exampleArduinoClock;
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of doc.components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }

  // Test 1: Wire connectivity
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
      console.log(`  ✗ ${wire.id}: missing terminal`);
      allWiresOk = false;
    }
  }
  console.log(`  ${allWiresOk ? '✓' : '✗'} ${doc.wires.length} wires checked`);

  // Test 2: Simulate and check segments
  console.log('\n━━━ Test 2: Simulation ━━━');
  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }
  let simContext: SimContext | null = null;

  const readSegVoltages = (sim: SimContext, segId: string) => {
    const seg = doc.components.find(c => c.id === segId)!;
    const plugin = plugins.get('sevenSegment')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(seg, plugin, nodeMap);
    const result: Record<string, number> = {};
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const t = terms.find(t => t.terminalId === s)!;
      result[s] = sim.nodeVoltage[t.nodeId] ?? 0;
    }
    return result;
  };

  const digitFromSegs = (vs: Record<string, number>): string => {
    const on: string[] = [];
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      if (vs[s] > 2.0) on.push(s);
    }
    const map: Record<string, string> = {
      'a,b,c,d,e,f': '0', 'b,c': '1', 'a,b,d,e,g': '2', 'a,b,c,d,g': '3',
      'b,c,f,g': '4', 'a,c,d,f,g': '5', 'a,c,d,e,f,g': '6', 'a,b,c': '7',
      'a,b,c,d,e,f,g': '8', 'a,b,c,d,f,g': '9',
    };
    return map[on.join(',')] ?? '?';
  };

  // Run 100 steps with Arduino fast-forward (same as store)
  for (let frame = 0; frame < 100; frame++) {
    const persistentState = simContext?.state ?? {};
    const prev = simContext
      ? { nodeVoltage: simContext.nodeVoltage, branchCurrent: simContext.branchCurrent, time: simContext.time, state: persistentState }
      : { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: persistentState };

    const result = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!result) break;
    simContext = result.sim;

    if (frame % 20 === 0) {
      const mV = readSegVoltages(simContext, 'seg_m');
      const sV = readSegVoltages(simContext, 'seg_s');
      const mDigit = digitFromSegs(mV);
      const sDigit = digitFromSegs(sV);
      console.log(`  frame ${frame}: t=${simContext.time.toFixed(3)}s  minutes=${mDigit}  seconds=${sDigit}  display=${mDigit}:${sDigit}`);
    }
  }

  // Test 3: Physics validation
  console.log('\n━━━ Test 3: Physics Validation ━━━');
  if (!simContext) { console.log('  ✗ Simulation failed'); process.exit(1); }
  const result = validatePhysics(doc.components, doc.wires, plugins, simContext);
  console.log(`  ${result.passed ? '✓ PASS' : '✗ FAIL'} — ${result.violations.filter(v => v.severity === 'error').length} error(s), ${result.violations.filter(v => v.severity === 'warning').length} warning(s)`);
  if (result.violations.length > 0) {
    for (const v of result.violations.slice(0, 5)) {
      console.log(`    [${v.severity}] ${v.law}: ${v.message}`);
    }
  }

  console.log(`\n━━━ Summary ━━━`);
  console.log(`  Components: ${doc.components.length}`);
  console.log(`  Wires: ${doc.wires.length}`);
  console.log(`  Approach: Single Arduino drives 2× 7-segment displays via 14 resistors`);
}

main().catch(e => { console.error(e); process.exit(1); });
