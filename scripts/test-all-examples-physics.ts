// Test: run physics validator on ALL example circuits and report violations.

import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { validatePhysics, formatValidationResult } from '../src/lib/circuit/physics-validator';
import {
  exampleLed, example555, exampleRC, exampleTransistor, exampleArduino,
  exampleOpamp, exampleNmos, exampleSevenSeg, exampleSimpleClock, exampleClock,
  exampleRLHighPass, exampleDiodeRectifier, exampleVoltageDivider,
  examplePnpSwitch, exampleCurrentSource, exampleSpeaker,
  examplePhotoresistor, exampleLogicGates, exampleOpampNonInverting, exampleVCO,
  exampleArduinoClockHHMMSS, example555Clock,
} from '../src/lib/circuit/examples';
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
    // Fast-forward for pulseSource/Arduino circuits
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

  const examples = [
    { name: 'LED + Resistor', doc: exampleLed, steps: 20 },
    { name: '555 Astable Blink', doc: example555, steps: 50 },
    { name: 'RC Low-pass Filter', doc: exampleRC, steps: 50 },
    { name: 'Transistor Switch', doc: exampleTransistor, steps: 30 },
    { name: 'Arduino Blink', doc: exampleArduino, steps: 50 },
    { name: 'Op-Amp Inverting Amp', doc: exampleOpamp, steps: 30 },
    { name: 'NMOS Switch', doc: exampleNmos, steps: 30 },
    { name: '7-Segment Counter', doc: exampleSevenSeg, steps: 50 },
    { name: 'Simple Seconds Counter', doc: exampleSimpleClock, steps: 100 },
    { name: 'Digital Clock', doc: exampleClock, steps: 100 },
    { name: 'Arduino Clock (HH:MM:SS)', doc: exampleArduinoClockHHMMSS, steps: 100 },
    { name: '555 Timer Clock', doc: example555Clock, steps: 100 },
    // New examples
    { name: 'RL High-pass Filter', doc: exampleRLHighPass, steps: 30 },
    { name: 'Diode Rectifier', doc: exampleDiodeRectifier, steps: 30 },
    { name: 'Voltage Divider', doc: exampleVoltageDivider, steps: 30 },
    { name: 'PNP Switch', doc: examplePnpSwitch, steps: 30 },
    { name: 'Current Source', doc: exampleCurrentSource, steps: 30 },
    { name: 'Speaker Driver', doc: exampleSpeaker, steps: 30 },
    { name: 'Photoresistor Light Sensor', doc: examplePhotoresistor, steps: 30 },
    { name: 'AND Gate', doc: exampleLogicGates, steps: 30 },
    { name: 'Op-Amp Non-inverting Amp', doc: exampleOpampNonInverting, steps: 30 },
    { name: 'VCO Frequency Sweep', doc: exampleVCO, steps: 50 },
  ];

  console.log('=== Physics Validation — ALL Example Circuits ===\n');

  let totalErrors = 0;
  let totalWarnings = 0;
  for (const ex of examples) {
    const sim = simulate(ex.doc, ex.steps);
    if (!sim) {
      console.log(`━━━ ${ex.name} ━━━`);
      console.log('  ✗ SIMULATION FAILED\n');
      totalErrors++;
      continue;
    }
    const plugins = getPlugins(ex.doc.components);
    const result = validatePhysics(ex.doc.components, ex.doc.wires, plugins, sim);
    const errors = result.violations.filter(v => v.severity === 'error');
    const warnings = result.violations.filter(v => v.severity === 'warning');
    totalErrors += errors.length;
    totalWarnings += warnings.length;
    console.log(`━━━ ${ex.name} ━━━`);
    console.log(`  ${result.passed ? 'PASS ✓' : 'FAIL ✗'} — ${errors.length} error(s), ${warnings.length} warning(s)`);
    if (result.violations.length > 0) {
      for (const v of result.violations) {
        console.log(`    [${v.severity}] ${v.law}: ${v.message}`);
      }
    }
    console.log('');
  }

  console.log('━━━ Summary ━━━');
  console.log(`Total errors:   ${totalErrors}`);
  console.log(`Total warnings: ${totalWarnings}`);
  if (totalErrors === 0) {
    console.log('✓ All circuits pass physics validation (no errors).');
  } else {
    console.log('✗ Some circuits have physics violations — needs fixing.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
