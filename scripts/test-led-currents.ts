// Test: print wire currents for the LED example to see if they're equal in a series circuit.

import { simulateStep, computeComponentCurrents, computeWireCurrents } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { exampleLed } from '../src/lib/circuit/examples';
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

  const doc = exampleLed;
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of doc.components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }

  let prev: any = undefined;
  let sim: any = null;
  for (let i = 0; i < 10; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) break;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
  }

  const compCurrents = computeComponentCurrents(doc.components, doc.wires, plugins, sim);
  const wireCurrents = computeWireCurrents(doc.components, doc.wires, plugins, sim);

  console.log('=== LED Example — Component Currents ===');
  for (const comp of doc.components) {
    const i = compCurrents.get(comp.id) ?? 0;
    console.log(`  ${comp.id.padEnd(6)} (${comp.type.padEnd(10)}): ${i.toFixed(6)} A`);
  }

  console.log('\n=== LED Example — Wire Currents ===');
  for (const wire of doc.wires) {
    const i = wireCurrents.get(wire.id) ?? 0;
    const from = `${wire.from.componentId}.${wire.from.terminalId}`;
    const to = `${wire.to.componentId}.${wire.to.terminalId}`;
    console.log(`  ${wire.id.padEnd(4)} ${from.padEnd(10)} → ${to.padEnd(10)}: ${i.toFixed(6)} A  (abs=${Math.abs(i).toFixed(6)})`);
  }

  // Check: in a series circuit, all wire currents should have the same magnitude.
  const mags = doc.wires.map(w => Math.abs(wireCurrents.get(w.id) ?? 0));
  const maxMag = Math.max(...mags);
  const minMag = Math.min(...mags);
  console.log(`\nMagnitude range: ${minMag.toFixed(6)} to ${maxMag.toFixed(6)} A`);
  if (maxMag > 0 && (maxMag - minMag) / maxMag > 0.01) {
    console.log(`✗ Wire current magnitudes differ by ${((maxMag - minMag) / maxMag * 100).toFixed(1)}% — BUG!`);
  } else {
    console.log('✓ Wire current magnitudes are consistent.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
