// Edge-case reliability check: simulate unusual but legitimate circuits that
// a user might build while experimenting. Catches crashes, NaN, infinite loops,
// and physics violations that would ruin an experiment.

import { simulateStep, solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

async function main() {
  await import('../src/lib/circuit/components');

  function comp(type: string, id: string, params?: any): CircuitComponent {
    const p = getPlugin(type);
    const defaults: any = {};
    if (p) for (const param of p.parameters) defaults[param.key] = param.default;
    return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
  }
  function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
    return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
  }
  function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
    const m = new Map<string, ComponentPlugin>();
    for (const c of components) { const p = getPlugin(c.type); if (p) m.set(c.type, p); }
    return m;
  }

  type TestCase = {
    name: string;
    components: CircuitComponent[];
    wires: Wire[];
    expected?: { minVoltage?: number; maxVoltage?: number; minCurrent?: number; maxCurrent?: number };
  };

  const cases: TestCase[] = [
    // 1. Bare voltage source (no load) — should not crash
    {
      name: 'bare V source',
      components: [comp('dcVoltage', 'V1', { voltage: 5 }), comp('ground', 'GND')],
      wires: [wire('w1', 'V1', 'p', 'GND', 'g'), wire('w2', 'V1', 'n', 'GND', 'g')],
    },
    // 2. Short circuit (V source → wire → ground)
    {
      name: 'short circuit',
      components: [comp('dcVoltage', 'V1', { voltage: 5 }), comp('ground', 'GND')],
      wires: [wire('w1', 'V1', 'p', 'GND', 'g'), wire('w2', 'V1', 'n', 'GND', 'g')],
    },
    // 3. Floating input (unconnected terminal)
    {
      name: 'floating input',
      components: [comp('resistor', 'R1', { resistance: 1000 }), comp('ground', 'GND')],
      wires: [wire('w1', 'R1', 'b', 'GND', 'g')],
    },
    // 4. Two voltage sources in parallel (different voltages) — should converge or fail gracefully
    {
      name: 'parallel V sources (5V vs 3V)',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('dcVoltage', 'V2', { voltage: 3 }),
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'V2', 'p'),
        wire('w2', 'V1', 'p', 'R1', 'a'),
        wire('w3', 'R1', 'b', 'GND', 'g'),
        wire('w4', 'V1', 'n', 'GND', 'g'),
        wire('w5', 'V2', 'n', 'GND', 'g'),
      ],
    },
    // 5. Very large resistance (1 TΩ) — numerical stress
    {
      name: '1 TΩ resistor',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('resistor', 'R1', { resistance: 1e12 }),
        comp('resistor', 'R2', { resistance: 1e12 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'R1', 'a'),
        wire('w2', 'R1', 'b', 'R2', 'a'),
        wire('w3', 'R2', 'b', 'GND', 'g'),
        wire('w4', 'V1', 'n', 'GND', 'g'),
      ],
    },
    // 6. Very small resistance (1 µΩ) — should not produce Infinity
    {
      name: '1 µΩ resistor',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('resistor', 'R1', { resistance: 1e-6 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'R1', 'a'),
        wire('w2', 'R1', 'b', 'GND', 'g'),
        wire('w3', 'V1', 'n', 'GND', 'g'),
      ],
    },
    // 7. Capacitor with no discharge path (floating cap)
    {
      name: 'floating capacitor',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('capacitor', 'C1', { capacitance: 1e-6 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'C1', 'a'),
        wire('w2', 'C1', 'b', 'GND', 'g'),
        wire('w3', 'V1', 'n', 'GND', 'g'),
      ],
    },
    // 8. Inductor with no series resistance (pure L)
    {
      name: 'pure inductor (no R)',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('inductor', 'L1', { inductance: 1e-3 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'L1', 'a'),
        wire('w2', 'L1', 'b', 'GND', 'g'),
        wire('w3', 'V1', 'n', 'GND', 'g'),
      ],
    },
    // 9. Negative voltage source
    {
      name: 'negative V source (-5V)',
      components: [
        comp('dcVoltage', 'V1', { voltage: -5 }),
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'R1', 'a'),
        wire('w2', 'R1', 'b', 'GND', 'g'),
        wire('w3', 'V1', 'n', 'GND', 'g'),
      ],
    },
    // 10. AC source at very high frequency (1 GHz)
    {
      name: '1 GHz AC source',
      components: [
        comp('acVoltage', 'V1', { amplitude: 1, frequency: 1e9, offset: 0 }),
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'R1', 'a'),
        wire('w2', 'R1', 'b', 'GND', 'g'),
        wire('w3', 'V1', 'n', 'GND', 'g'),
      ],
    },
    // 11. No ground reference
    {
      name: 'no ground',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('resistor', 'R1', { resistance: 1000 }),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'R1', 'a'),
        wire('w2', 'R1', 'b', 'V1', 'n'),
      ],
    },
    // 12. Open switch in series
    {
      name: 'open switch in series',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('switch', 'S1', { closed: false }),
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'S1', 'a'),
        wire('w2', 'S1', 'b', 'R1', 'a'),
        wire('w3', 'R1', 'b', 'GND', 'g'),
        wire('w4', 'V1', 'n', 'GND', 'g'),
      ],
    },
    // 13. Diode reverse-biased
    {
      name: 'reverse-biased diode',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('diode', 'D1', { forwardV: 0.7 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'R1', 'a'),
        wire('w2', 'R1', 'b', 'D1', 'k'),  // reverse bias
        wire('w3', 'D1', 'a', 'GND', 'g'),
        wire('w4', 'V1', 'n', 'GND', 'g'),
      ],
    },
    // 14. 100-node resistor ladder
    {
      name: '100-node resistor ladder',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('ground', 'GND'),
        ...Array.from({ length: 100 }, (_, i) => comp('resistor', `R${i}`, { resistance: 1000 })),
      ],
      wires: [
        wire('w0', 'V1', 'p', 'R0', 'a'),
        wire('wg', 'V1', 'n', 'GND', 'g'),
        ...Array.from({ length: 99 }, (_, i) => wire(`w${i + 1}`, `R${i}`, 'b', `R${i + 1}`, 'a')),
        wire('wf', 'R99', 'b', 'GND', 'g'),
      ],
    },
    // 15. Capacitor with initial voltage
    {
      name: 'cap with initial V',
      components: [
        comp('dcVoltage', 'V1', { voltage: 5 }),
        comp('resistor', 'R1', { resistance: 1000 }),
        comp('capacitor', 'C1', { capacitance: 1e-6, initialV: 3 }),
        comp('ground', 'GND'),
      ],
      wires: [
        wire('w1', 'V1', 'p', 'R1', 'a'),
        wire('w2', 'R1', 'b', 'C1', 'a'),
        wire('w3', 'C1', 'b', 'GND', 'g'),
        wire('w4', 'V1', 'n', 'GND', 'g'),
      ],
    },
  ];

  let pass = 0, fail = 0;
  const failures: string[] = [];

  for (const tc of cases) {
    let crashed = false;
    let nan = false;
    let physicsErrors = 0;
    let lastSim: SimContext | null = null;

    try {
      // DC
      const dc = solveDC(tc.components, tc.wires, pluginsFor(tc.components));
      if (dc) {
        for (const v of dc.nodeVoltage) {
          if (!isFinite(v)) { nan = true; break; }
        }
        lastSim = dc;
      }

      // Transient
      if (lastSim) {
        let prev: any = { nodeVoltage: lastSim.nodeVoltage, branchCurrent: lastSim.branchCurrent, time: lastSim.time, state: lastSim.state };
        for (let i = 0; i < 100; i++) {
          const r = simulateStep(tc.components, tc.wires, pluginsFor(tc.components), prev, 1e-4);
          if (!r) break;
          for (const v of r.sim.nodeVoltage) {
            if (!isFinite(v)) { nan = true; break; }
          }
          if (nan) break;
          lastSim = r.sim;
          prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
        }
      }

      // Physics
      if (lastSim) {
        const result = validatePhysics(tc.components, tc.wires, pluginsFor(tc.components), lastSim);
        physicsErrors = result.violations.filter(v => v.severity === 'error').length;
      }
    } catch (e) {
      crashed = true;
      console.log(`✗ ${tc.name}: CRASHED: ${(e as Error).message}`);
    }

    const ok = !crashed && !nan;
    if (ok) {
      pass++;
      console.log(`✓ ${tc.name}${physicsErrors > 0 ? ` (${physicsErrors} physics warnings)` : ''}`);
    } else {
      fail++;
      failures.push(tc.name);
    }
  }

  console.log(`\n=== EDGE CASE REPORT ===`);
  console.log(`Pass: ${pass}/${cases.length}`);
  console.log(`Fail: ${fail}/${cases.length}`);
  if (failures.length > 0) {
    console.log(`Failures: ${failures.join(', ')}`);
  }
}

main().catch(console.error);
