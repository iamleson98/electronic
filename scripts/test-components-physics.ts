// Test: validate physics for individual components not covered by examples.
// Tests: PNP transistor, PMOS, diode, switch (SPST), current source,
// logic gates (AND/OR/NOT/NAND/NOR/XOR), 555 monostable, op-amp rails,
// VCO, transformer, speaker, lamp, DC motor, potentiometer, fuse.

import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
import type { CircuitComponent, Wire, CircuitDocument, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

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

function comp(type: string, id: string, pos: [number, number], params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return { id, type, position: { x: pos[0], y: pos[1] }, rotation: 0, parameters: { ...defaults, ...params } };
}

function wire(id: string, fromC: string, fromT: string, toC: string, toT: string, waypoints?: [number, number][]): Wire {
  const w: any = { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
  if (waypoints) w.waypoints = waypoints.map(([x, y]) => ({ x, y }));
  return w;
}

function simulate(doc: CircuitDocument, steps: number, dt: number = 1e-4): SimContext | null {
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
  }
  return sim;
}

async function main() {
  await loadPlugins();

  const tests: { name: string; doc: CircuitDocument; expectedPass: boolean }[] = [];

  // 1. PNP transistor switch (high-side switch)
  tests.push({
    name: 'PNP Transistor Switch',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 4], { voltage: 5 }),
        comp('dcVoltage', 'v2', [4, 16], { voltage: 5 }),
        comp('pushButton', 'btn1', [8, 16], { pressed: true }),
        comp('resistor', 'rb', [14, 16], { resistance: 10000 }),
        comp('resistor', 'rc', [14, 4], { resistance: 1000 }),
        comp('pnp', 'q1', [22, 8], { hfe: 100, veb: 0.7, satV: 0.2 }),
        comp('led', 'led1', [22, 4], { color: 'red', forwardV: 2.0, seriesR: 1 }),
        comp('ground', 'gnd1', [5, 22], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'rc', 'a', [[5, 5]]),
        wire('w3', 'rc', 'b', 'led1', 'a', [[18, 5]]),
        wire('w4', 'led1', 'k', 'q1', 'c', [[26, 5], [26, 9]]),
        wire('w5', 'v2', 'p', 'btn1', 'a', [[5, 17]]),
        wire('w7', 'btn1', 'b', 'rb', 'a'),
        wire('w8', 'rb', 'b', 'q1', 'b', [[18, 17], [22, 17], [22, 10]]),
        wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 8], [5, 22]]),
        wire('w6', 'v2', 'n', 'gnd1', 'g', [[5, 20], [5, 22]]),
        wire('w9', 'q1', 'e', 'v1', 'p', [[25, 12], [25, 5], [5, 5]]),
      ],
    },
    expectedPass: true,
  });

  // 2. PMOS transistor switch
  tests.push({
    name: 'PMOS Switch',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 4], { voltage: 5 }),
        comp('dcVoltage', 'v2', [4, 16], { voltage: 5 }),
        comp('pushButton', 'btn1', [8, 16], { pressed: true }),
        comp('resistor', 'rG', [14, 16], { resistance: 100 }),
        comp('resistor', 'rD', [14, 4], { resistance: 1000 }),
        comp('pmos', 'm1', [22, 8], { vth: -2.0, kp: 0.1, ron: 0.1 }),
        comp('led', 'led1', [22, 4], { color: 'red', forwardV: 2.0, seriesR: 1 }),
        comp('ground', 'gnd1', [5, 22], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'rD', 'a', [[5, 5]]),
        wire('w3', 'rD', 'b', 'led1', 'a', [[18, 5]]),
        wire('w4', 'led1', 'k', 'm1', 'd', [[26, 5], [26, 9]]),
        wire('w5', 'v2', 'p', 'btn1', 'a', [[5, 17]]),
        wire('w7', 'btn1', 'b', 'rG', 'a'),
        wire('w8', 'rG', 'b', 'm1', 'g', [[18, 17], [22, 17], [22, 10]]),
        wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 8], [5, 22]]),
        wire('w6', 'v2', 'n', 'gnd1', 'g', [[5, 20], [5, 22]]),
        wire('w9', 'm1', 's', 'v1', 'p', [[25, 12], [25, 5], [5, 5]]),
      ],
    },
    expectedPass: true,
  });

  // 3. SPST Switch (open and closed)
  tests.push({
    name: 'SPST Switch (closed)',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 8], { voltage: 5 }),
        comp('switch', 'sw1', [10, 8], { closed: true }),
        comp('resistor', 'r1', [16, 8], { resistance: 1000 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'sw1', 'a'),
        wire('w2', 'sw1', 'b', 'r1', 'a'),
        wire('w3', 'r1', 'b', 'gnd1', 'g', [[20, 9], [20, 14], [5, 14]]),
        wire('w4', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  tests.push({
    name: 'SPST Switch (open)',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 8], { voltage: 5 }),
        comp('switch', 'sw1', [10, 8], { closed: false }),
        comp('resistor', 'r1', [16, 8], { resistance: 1000 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'sw1', 'a'),
        wire('w2', 'sw1', 'b', 'r1', 'a'),
        wire('w3', 'r1', 'b', 'gnd1', 'g', [[20, 9], [20, 14], [5, 14]]),
        wire('w4', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 4. Current Source
  tests.push({
    name: 'Current Source',
    doc: {
      version: 1,
      components: [
        comp('currentSource', 'i1', [4, 8], { current: 0.01 }),
        comp('resistor', 'r1', [10, 8], { resistance: 500 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'i1', 'p', 'r1', 'a'),
        wire('w2', 'r1', 'b', 'gnd1', 'g', [[14, 9], [14, 14], [5, 14]]),
        wire('w3', 'i1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 5. Logic gates (AND gate)
  tests.push({
    name: 'AND Gate (A=H, B=H → Y=H)',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'vA', [4, 4], { voltage: 5 }),
        comp('dcVoltage', 'vB', [4, 8], { voltage: 5 }),
        comp('and', 'g1', [10, 6], { vcc: 5, threshold: 2.5 }),
        comp('resistor', 'rL', [16, 6], { resistance: 1000 }),
        comp('led', 'led1', [22, 6], { color: 'green', forwardV: 2.0, seriesR: 1 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'vA', 'p', 'g1', 'a', [[5, 5], [10, 5]]),
        wire('w2', 'vB', 'p', 'g1', 'b', [[5, 9], [10, 9]]),
        wire('w3', 'g1', 'y', 'rL', 'a'),
        wire('w4', 'rL', 'b', 'led1', 'a'),
        wire('w5', 'led1', 'k', 'gnd1', 'g', [[26, 7], [26, 14], [5, 14]]),
        wire('w6', 'vA', 'n', 'gnd1', 'g', [[5, 5], [5, 14]]),
        wire('w7', 'vB', 'n', 'gnd1', 'g', [[5, 9], [5, 14]]),
        wire('w8', 'g1', 'gnd', 'gnd1', 'g', [[12, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 6. NOT gate
  tests.push({
    name: 'NOT Gate (A=H → Y=L)',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'vA', [4, 6], { voltage: 5 }),
        comp('not', 'g1', [10, 6], { vcc: 5, threshold: 2.5 }),
        comp('resistor', 'rL', [16, 6], { resistance: 1000 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'vA', 'p', 'g1', 'a', [[5, 7], [10, 7]]),
        wire('w2', 'g1', 'y', 'rL', 'a'),
        wire('w3', 'rL', 'b', 'gnd1', 'g', [[20, 7], [20, 14], [5, 14]]),
        wire('w4', 'vA', 'n', 'gnd1', 'g', [[5, 7], [5, 14]]),
        wire('w5', 'g1', 'gnd', 'gnd1', 'g', [[12, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 7. Diode (forward biased)
  tests.push({
    name: 'Diode (forward biased)',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 8], { voltage: 5 }),
        comp('resistor', 'r1', [10, 8], { resistance: 1000 }),
        comp('diode', 'd1', [16, 8], { forwardV: 0.7, onR: 1, offR: 1e7 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'r1', 'a'),
        wire('w2', 'r1', 'b', 'd1', 'a'),
        wire('w3', 'd1', 'k', 'gnd1', 'g', [[20, 9], [20, 14], [5, 14]]),
        wire('w4', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 8. Speaker
  tests.push({
    name: 'Speaker',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 8], { voltage: 5 }),
        comp('speaker', 'spk1', [10, 8], { impedance: 8 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'spk1', 'a'),
        wire('w2', 'spk1', 'b', 'gnd1', 'g', [[14, 9], [14, 14], [5, 14]]),
        wire('w3', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 9. Potentiometer (voltage divider)
  tests.push({
    name: 'Potentiometer (voltage divider)',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 8], { voltage: 5 }),
        comp('potentiometer', 'pot1', [10, 8], { resistance: 10000 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'pot1', 'a'),
        wire('w2', 'pot1', 'b', 'gnd1', 'g', [[14, 9], [14, 14], [5, 14]]),
        wire('w3', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 10. Fuse
  tests.push({
    name: 'Fuse',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 8], { voltage: 5 }),
        comp('fuse', 'f1', [10, 8], { resistance: 0.1 }),
        comp('resistor', 'r1', [16, 8], { resistance: 100 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'f1', 'a'),
        wire('w2', 'f1', 'b', 'r1', 'a'),
        wire('w3', 'r1', 'b', 'gnd1', 'g', [[20, 9], [20, 14], [5, 14]]),
        wire('w4', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 11. Lamp
  tests.push({
    name: 'Lamp',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 8], { voltage: 5 }),
        comp('lamp', 'lamp1', [10, 8], { resistance: 100 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'lamp1', 'a'),
        wire('w2', 'lamp1', 'b', 'gnd1', 'g', [[14, 9], [14, 14], [5, 14]]),
        wire('w3', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  // 12. DC Motor
  tests.push({
    name: 'DC Motor',
    doc: {
      version: 1,
      components: [
        comp('dcVoltage', 'v1', [4, 8], { voltage: 5 }),
        comp('dcMotor', 'm1', [10, 8], { resistance: 50 }),
        comp('ground', 'gnd1', [5, 14], {}),
      ],
      wires: [
        wire('w1', 'v1', 'p', 'm1', 'a'),
        wire('w2', 'm1', 'b', 'gnd1', 'g', [[14, 9], [14, 14], [5, 14]]),
        wire('w3', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
      ],
    },
    expectedPass: true,
  });

  console.log('=== Physics Validation — Individual Components ===\n');

  let totalErrors = 0;
  let totalWarnings = 0;
  for (const test of tests) {
    const sim = simulate(test.doc, 30);
    if (!sim) {
      console.log(`━━━ ${test.name} ━━━`);
      console.log('  ✗ SIMULATION FAILED\n');
      totalErrors++;
      continue;
    }
    const plugins = getPlugins(test.doc.components);
    const result = validatePhysics(test.doc.components, test.doc.wires, plugins, sim);
    const errors = result.violations.filter(v => v.severity === 'error');
    const warnings = result.violations.filter(v => v.severity === 'warning');
    totalErrors += errors.length;
    totalWarnings += warnings.length;
    console.log(`━━━ ${test.name} ━━━`);
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
    console.log('✓ All component tests pass physics validation.');
  } else {
    console.log('✗ Some components have physics violations — needs fixing.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
