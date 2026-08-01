// Test: verify the physics validator catches known bug classes.
// For each example circuit, run the simulation and validate physics.
// The validator should pass on correctly-working circuits.

import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { validatePhysics, formatValidationResult } from '../src/lib/circuit/physics-validator';
import { exampleLed, exampleTransistor, exampleSevenSeg, exampleClock } from '../src/lib/circuit/examples';
import type { ComponentPlugin, SimContext } from '../src/lib/circuit/types';

async function loadPlugins() {
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
}

function getPlugins(components: any[]): Map<string, ComponentPlugin> {
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }
  return plugins;
}

function simulate(doc: any, steps: number, dt: number = 1e-4): SimContext | null {
  const plugins = getPlugins(doc.components);
  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }
  let prev: any = undefined;
  let sim: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, dt);
    if (!r) return null;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    // Fast-forward for pulseSource circuits
    const hasPulse = doc.components.some((c: any) => c.type === 'pulseSource');
    const hasArduino = doc.components.some((c: any) => c.type === 'arduinoReal' || c.type === 'arduino');
    if (hasPulse && !hasArduino) {
      let minFreq = Infinity;
      for (const c of doc.components) {
        if (c.type === 'pulseSource') {
          const f = c.parameters.frequency;
          if (f > 0 && f < minFreq) minFreq = f;
        }
      }
      if (minFreq !== Infinity) {
        const phase = (sim.time * minFreq) % 1;
        const timeToEdge = (1.0 - phase) / minFreq;
        const advance = Math.min(0.016, timeToEdge + 0.001);
        if (advance > dt) prev.time = sim.time + advance;
      }
    }
  }
  return sim;
}

async function main() {
  await loadPlugins();

  console.log('=== Physics Validator Test ===\n');

  // Test 1: LED + Resistor (simple series circuit — should pass)
  console.log('━━━ Test 1: LED + Resistor ━━━');
  {
    const sim = simulate(exampleLed, 20);
    if (!sim) { console.log('FAIL: simulation failed'); process.exit(1); }
    const plugins = getPlugins(exampleLed.components);
    const result = validatePhysics(exampleLed.components, exampleLed.wires, plugins, sim);
    console.log(formatValidationResult(result));
    if (result.passed) console.log('✓ LED circuit passes physics validation\n');
    else console.log('✗ LED circuit has violations\n');
  }

  // Test 2: Transistor Switch (button pressed — should pass)
  console.log('━━━ Test 2: Transistor Switch (pressed) ━━━');
  {
    // Clone the example with button pressed
    const doc = JSON.parse(JSON.stringify(exampleTransistor));
    doc.components.find((c: any) => c.id === 'btn1').parameters.pressed = true;
    const sim = simulate(doc, 30);
    if (!sim) { console.log('FAIL: simulation failed'); process.exit(1); }
    const plugins = getPlugins(doc.components);
    const result = validatePhysics(doc.components, doc.wires, plugins, sim);
    console.log(formatValidationResult(result));
    if (result.passed) console.log('✓ Transistor (pressed) passes\n');
    else console.log('✗ Transistor (pressed) has violations\n');
  }

  // Test 3: Transistor Switch (button released — should pass with our fix)
  console.log('━━━ Test 3: Transistor Switch (released) ━━━');
  {
    // First press, then release
    const docPressed = JSON.parse(JSON.stringify(exampleTransistor));
    docPressed.components.find((c: any) => c.id === 'btn1').parameters.pressed = true;
    const plugins = getPlugins(docPressed.components);
    for (const comp of docPressed.components) {
      if (!comp.simState) comp.simState = {};
    }
    let prev: any = undefined;
    let sim: any = null;
    // Press for 20 steps
    for (let i = 0; i < 20; i++) {
      const r = simulateStep(docPressed.components, docPressed.wires, plugins, prev, 1e-4);
      if (!r) break;
      sim = r.sim;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    // Release for 20 steps
    docPressed.components.find((c: any) => c.id === 'btn1').parameters.pressed = false;
    for (let i = 0; i < 20; i++) {
      const r = simulateStep(docPressed.components, docPressed.wires, plugins, prev, 1e-4);
      if (!r) break;
      sim = r.sim;
      prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
    }
    if (!sim) { console.log('FAIL: simulation failed'); process.exit(1); }
    const result = validatePhysics(docPressed.components, docPressed.wires, plugins, sim);
    console.log(formatValidationResult(result));
    if (result.passed) console.log('✓ Transistor (released) passes — no stuck-on bug\n');
    else console.log('✗ Transistor (released) has violations (stuck-on bug?)\n');
  }

  // Test 4: 7-Segment Counter (should pass)
  console.log('━━━ Test 4: 7-Segment Counter ━━━');
  {
    const sim = simulate(exampleSevenSeg, 50);
    if (!sim) { console.log('FAIL: simulation failed'); process.exit(1); }
    const plugins = getPlugins(exampleSevenSeg.components);
    const result = validatePhysics(exampleSevenSeg.components, exampleSevenSeg.wires, plugins, sim);
    console.log(formatValidationResult(result));
    if (result.passed) console.log('✓ 7-Segment passes\n');
    else console.log('✗ 7-Segment has violations\n');
  }

  // Test 5: Digital Clock (should pass)
  console.log('━━━ Test 5: Digital Clock ━━━');
  {
    const sim = simulate(exampleClock, 100);
    if (!sim) { console.log('FAIL: simulation failed'); process.exit(1); }
    const plugins = getPlugins(exampleClock.components);
    const result = validatePhysics(exampleClock.components, exampleClock.wires, plugins, sim);
    console.log(formatValidationResult(result));
    if (result.passed) console.log('✓ Clock passes\n');
    else console.log('✗ Clock has violations\n');
  }

  console.log('━━━ Summary ━━━');
  console.log('The physics validator runs 10 laws against each circuit:');
  console.log('  1. Voltage Sanity (no NaN/Infinity)');
  console.log('  2. KCL (sum of currents at each node = 0)');
  console.log('  3. Series Current Equality');
  console.log('  4. Diode/LED Forward Law');
  console.log('  5. Transistor Off Law (catches stuck-on bug)');
  console.log('  6. Voltage Source (V matches rated)');
  console.log('  7. Power Conservation');
  console.log('  8. Switch Off Law (open switch → 0 current)');
  console.log('  9. 7-Segment Law (ON/OFF voltage correct)');
  console.log(' 10. CD4026 Output Law (segment/CO voltages match count)');
}

main().catch(e => { console.error(e); process.exit(1); });
