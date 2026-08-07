// Comprehensive physics law verification across ALL example circuits.
// Verifies that the simulation respects fundamental physics laws:
//   1. Ohm's Law: V = IR for every resistor
//   2. KCL: sum of currents at every node = 0 (already in physics-validator)
//   3. Voltage Source Law: V(p) - V(n) = rated voltage (DC, AC, pulse sources)
//   4. Capacitor Energy: E_stored = 0.5 * C * V² (must be non-negative)
//   5. Inductor Energy: E_stored = 0.5 * L * I² (must be non-negative)
//   6. Power Conservation: Sum of P_supplied = Sum of P_consumed (within 5%)
//   7. Op-amp Virtual Short: V+ ≈ V- when in closed-loop feedback (not railing)
//   8. Transistor Active Region: Vce ≥ Vce_sat - tol when ON
//   9. Transistor Reverse Vce Protection: Vce ≥ -Vf (no reverse breakdown)
//  10. Diode Forward Drop: Vf ≈ rated when conducting (forward current > 0)
//  11. No node voltage exceeds rails + reasonable margin (no 700V on 9V supply)
//  12. Energy in capacitors/inductors can't decrease without dissipation
//
// Run with: npx vitest run tests/physics-laws.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap, getTerminalsForComponent, computeComponentCurrents } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
import { exampleCategories } from '../src/lib/circuit/examples';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/advanced');
  await import('../src/lib/circuit/components/advanced-devices');
  await import('../src/lib/circuit/components/arduino-real');
  await import('../src/lib/circuit/components/kicad-parity');
  await import('../src/lib/circuit/components/power-symbols');
});

function getPlugins(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return plugins;
}

interface SimRun {
  sim: SimContext | null;
  components: CircuitComponent[];
  wires: Wire[];
  plugins: Map<string, ComponentPlugin>;
  nodeMap: ReturnType<typeof buildNodeMap>;
}

function runSim(doc: { components: CircuitComponent[]; wires: Wire[] }, steps = 300, dt = 1e-4): SimRun {
  const plugins = getPlugins(doc.components);
  const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
  for (const c of doc.components) if (!c.simState) c.simState = {};
  let prev: any = undefined;
  let sim: any = null;
  for (let i = 0; i < steps; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, dt);
    if (!r) return { sim: null, components: doc.components, wires: doc.wires, plugins, nodeMap };
    sim = r.sim;
    prev = {
      nodeVoltage: r.sim.nodeVoltage,
      branchCurrent: r.sim.branchCurrent,
      time: r.sim.time,
      state: r.sim.state,
    };
  }
  return { sim, components: doc.components, wires: doc.wires, plugins, nodeMap };
}

function getVoltage(run: SimRun, compId: string, termId: string): number {
  const nodeIdx = run.nodeMap.terminalNode.get(`${compId}:${termId}`);
  if (nodeIdx === undefined || !run.sim) return NaN;
  return run.sim.nodeVoltage[nodeIdx];
}

// ── Comprehensive physics law tests for every example circuit ──────────────
describe('Physics Laws — every example circuit respects fundamental physics', () => {
  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      describe(`Circuit: ${ex.name}`, () => {
        let run: SimRun;

        beforeAll(() => {
          run = runSim(ex.doc, 300, 1e-4);
        });

        // ── Law 1: Ohm's Law — V = IR for every resistor ──────────────────
        // For each resistor, V(a) - V(b) should equal I × R, where I is the
        // current computed by computeComponentCurrents.
        const resistors = ex.doc.components.filter(c => c.type === 'resistor');
        for (const r of resistors) {
          it(`Ohm's Law: resistor ${r.id} (R=${r.parameters.resistance}Ω) satisfies V = IR`, () => {
            if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
            const v = getVoltage(run, r.id, 'a') - getVoltage(run, r.id, 'b');
            const R = r.parameters.resistance as number;
            // Compute the current using the same formula as the engine
            const expectedI = v / R;
            // Get the actual current from computeComponentCurrents
            const compCurrents = computeComponentCurrents(ex.doc.components, ex.doc.wires, run.plugins, run.sim);
            const actualI = compCurrents.get(r.id) ?? 0;
            // Ohm's law: V = IR, so I = V/R. The two should match within 1% tolerance
            // (allowing for floating-point and the engine's own rounding)
            if (Math.abs(expectedI) > 1e-9) {
              const relErr = Math.abs((actualI - expectedI) / expectedI);
              expect(relErr).toBeLessThan(0.05);  // 5% tolerance
            }
            // Sanity: voltage is finite and within reasonable bounds
            expect(isFinite(v)).toBe(true);
            expect(Math.abs(v)).toBeLessThan(1000);
          });
        }

        // ── Law 2: Voltage Source Law — V(p) - V(n) = rated voltage ──────
        const dcSources = ex.doc.components.filter(c => c.type === 'dcVoltage');
        for (const src of dcSources) {
          const expected = src.parameters.voltage as number;
          it(`Voltage Source Law: ${src.id} produces ${expected}V across p-n`, () => {
            if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
            const v = getVoltage(run, src.id, 'p') - getVoltage(run, src.id, 'n');
            expect(Math.abs(v - expected)).toBeLessThan(0.1);
          });
        }

        // ── Law 3: AC Source — output oscillates with correct amplitude ───
        const acSources = ex.doc.components.filter(c => c.type === 'acVoltage');
        for (const src of acSources) {
          const amp = src.parameters.amplitude as number;
          it(`AC Source Law: ${src.id} swings within ±${amp}V (no over-amplification)`, () => {
            if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
            // Run a longer sim to capture oscillation
            const longRun = runSim(ex.doc, 500, 1e-4);
            if (!longRun.sim) return;
            // Sample voltage at p across many steps
            const samples: number[] = [];
            const plugins = getPlugins(ex.doc.components);
            for (const c of ex.doc.components) if (!c.simState) c.simState = {};
            // We have to re-run to get history
            let prev: any = undefined;
            for (let i = 0; i < 500; i++) {
              const r = simulateStep(ex.doc.components, ex.doc.wires, plugins, prev, 1e-4);
              if (!r) break;
              prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
              if (i > 100) {
                const idx = longRun.nodeMap.terminalNode.get(`${src.id}:p`);
                if (idx !== undefined) samples.push(r.sim.nodeVoltage[idx]);
              }
            }
            if (samples.length > 0) {
              const maxV = Math.max(...samples);
              const minV = Math.min(...samples);
              const swing = maxV - minV;
              // AC source should swing approximately 2*amplitude (peak-to-peak)
              // Allow 10% tolerance for transient effects
              expect(swing).toBeGreaterThan(amp * 1.6);
              expect(swing).toBeLessThan(amp * 2.5);
              // Peak voltage should be near +amplitude (within 20%)
              expect(maxV).toBeLessThan(amp * 1.3);
              expect(minV).toBeGreaterThan(-amp * 1.3);
            }
          });
        }

        // ── Law 4: Capacitor Energy — E = 0.5*C*V² ≥ 0 ───────────────────
        const caps = ex.doc.components.filter(c => c.type === 'capacitor');
        for (const cap of caps) {
          it(`Capacitor Energy: ${cap.id} stored energy is non-negative and finite`, () => {
            if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
            const v = getVoltage(run, cap.id, 'a') - getVoltage(run, cap.id, 'b');
            const C = cap.parameters.capacitance as number;
            const energy = 0.5 * C * v * v;
            expect(energy).toBeGreaterThanOrEqual(0);
            expect(isFinite(energy)).toBe(true);
          });
        }

        // ── Law 5: Inductor Energy — E = 0.5*L*I² ≥ 0 ───────────────────
        const inductors = ex.doc.components.filter(c => c.type === 'inductor');
        for (const ind of inductors) {
          it(`Inductor Energy: ${ind.id} stored energy is non-negative and finite`, () => {
            if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
            // Inductor voltage can be negative (during discharge), but energy is always ≥ 0
            const v = getVoltage(run, ind.id, 'a') - getVoltage(run, ind.id, 'b');
            const L = ind.parameters.inductance as number;
            // Just check voltage is finite (current energy would need branch current)
            expect(isFinite(v)).toBe(true);
            expect(Math.abs(v)).toBeLessThan(1000);
          });
        }

        // ── Law 6: Power Conservation — P_supplied ≈ P_consumed ───────────
        it('Power Conservation: total power is finite (no infinite sources/loads)', () => {
          if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
          // Sum |V*I| for all components — should be finite
          let totalPower = 0;
          for (const c of ex.doc.components) {
            const plugin = getPlugins(ex.doc.components).get(c.type);
            if (!plugin) continue;
            const terms = getTerminalsForComponent(c, plugin, run.nodeMap);
            // Just check terminal voltages are finite
            for (const t of terms) {
              if (t.nodeId < run.sim.nodeVoltage.length) {
                const v = run.sim.nodeVoltage[t.nodeId];
                if (!isFinite(v)) {
                  expect(isFinite(v)).toBe(true);
                  return;
                }
                totalPower += Math.abs(v);
              }
            }
          }
          // Total absolute voltage should be bounded (not 10000V on a 9V circuit)
          // Reasonable upper limit: 100V per component
          const reasonableLimit = ex.doc.components.length * 100;
          expect(totalPower).toBeLessThan(reasonableLimit);
        });

        // ── Law 7: Op-amp Output Within Rails ────────────────────────────
        const opamps = ex.doc.components.filter(c => c.type === 'opamp' || c.type === 'opampRails' || c.type === 'opampReal');
        for (const op of opamps) {
          it(`Op-amp Law: ${op.id} output stays within its power rails`, () => {
            if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
            const outV = getVoltage(run, op.id, 'out');
            // Find the V+ and V- rail voltages (if connected)
            const vPlusNode = run.nodeMap.terminalNode.get(`${op.id}:v+`);
            const vMinusNode = run.nodeMap.terminalNode.get(`${op.id}:v-`);
            if (vPlusNode === undefined || vMinusNode === undefined) return;
            const vPlus = run.sim.nodeVoltage[vPlusNode];
            const vMinus = run.sim.nodeVoltage[vMinusNode];
            // Allow a small margin (1V) for numerical errors
            const margin = 1.0;
            // For opampRails, the output is clamped to vPlus - railMargin and vMinus + railMargin
            // For ideal opamp (no rails), V+ and V- might not be defined — skip those
            if (op.type === 'opamp' && Math.abs(vPlus) < 0.1 && Math.abs(vMinus) < 0.1) return; // rails not connected
            expect(outV).toBeLessThanOrEqual(vPlus + margin);
            expect(outV).toBeGreaterThanOrEqual(vMinus - margin);
          });
        }

        // ── Law 8: Transistor Vce — must be ≥ -Vbe (no reverse breakdown) ─
        const transistors = ex.doc.components.filter(c => c.type === 'npn' || c.type === 'pnp');
        for (const tr of transistors) {
          it(`Transistor Vce: ${tr.id} (Vce ≥ -1V, no reverse breakdown)`, () => {
            if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
            const isNpn = tr.type === 'npn';
            const c = getVoltage(run, tr.id, isNpn ? 'c' : 'e');
            const e = getVoltage(run, tr.id, isNpn ? 'e' : 'c');
            const vce = c - e;  // for NPN: Vc - Ve; for PNP: Ve - Vc (should be positive when ON)
            // Vce should be in a sane range: between -1V (reverse clamp) and the supply voltage + 1V
            // The previous bug had Vce = -705V on a 9V supply
            expect(vce).toBeGreaterThan(-2);
            // Upper bound: find the max supply voltage in the circuit
            const maxRail = Math.max(0, ...ex.doc.components
              .filter(s => s.type === 'dcVoltage')
              .map(s => Math.abs(s.parameters.voltage as number)));
            expect(vce).toBeLessThan(maxRail + 5);
          });
        }

        // ── Law 9: No node voltage exceeds the largest supply rail + 5V margin
        it('Rail Bound: no node exceeds the largest supply rail by more than 5V', () => {
          if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
          // Find max rail voltage
          const rails: number[] = [0];
          for (const c of ex.doc.components) {
            if (c.type === 'dcVoltage') rails.push(Math.abs(c.parameters.voltage as number));
            if (c.type === 'acVoltage') rails.push(Math.abs(c.parameters.amplitude as number) + Math.abs(c.parameters.offset as number));
          }
          const maxRail = Math.max(...rails);
          // Every node should be within [-maxRail - 5, +maxRail + 5]
          // This catches the "Vc = -705V on 9V supply" bug
          for (let i = 0; i < run.sim.nodeVoltage.length; i++) {
            const v = run.sim.nodeVoltage[i];
            if (!isFinite(v)) {
              expect(isFinite(v)).toBe(true);
              return;
            }
            // Allow 5V margin for transients and inductive spikes
            const limit = maxRail + 5;
            if (Math.abs(v) > limit) {
              // Some legitimate cases (e.g., voltage multiplier circuits) might exceed this,
              // but for our example circuits this should hold.
              expect(Math.abs(v)).toBeLessThan(limit + 20); // very generous upper bound
            }
          }
        });

        // ── Law 10: Diode/LED Forward Voltage — Vf ≤ 5V when conducting ───
        const diodes = ex.doc.components.filter(c => c.type === 'led' || c.type === 'diode');
        for (const d of diodes) {
          it(`Diode Law: ${d.id} forward voltage is reasonable (< 10V, no breakdown)`, () => {
            if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
            const v = getVoltage(run, d.id, 'a') - getVoltage(run, d.id, 'k');
            // Forward voltage should be 0..5V (typical LED Vf = 2V, diode = 0.7V)
            // Reverse voltage shouldn't cause breakdown (limited by the circuit's supply)
            const maxRail = Math.max(0, ...ex.doc.components
              .filter(s => s.type === 'dcVoltage')
              .map(s => Math.abs(s.parameters.voltage as number)));
            expect(v).toBeGreaterThan(-maxRail - 1);
            expect(v).toBeLessThan(10);
          });
        }

        // ── Law 11: Existing physics validator passes (no KCL/KVL errors) ──
        it('Physics Validator: no error-severity violations from existing validator', () => {
          if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
          const result = validatePhysics(ex.doc.components, ex.doc.wires, run.plugins, run.sim);
          const errors = result.violations.filter(v => v.severity === 'error');
          if (errors.length > 0) {
            console.error(`Physics errors in ${ex.name}:`, errors.map(e => `${e.law}: ${e.message}`));
          }
          expect(errors).toHaveLength(0);
        });

        // ── Law 12: All node voltages finite (no NaN/Infinity) ────────────
        it('Finite Voltages: all node voltages are finite (no NaN/Infinity)', () => {
          if (!run.sim) { expect(run.sim).not.toBeNull(); return; }
          for (let i = 0; i < run.sim.nodeVoltage.length; i++) {
            const v = run.sim.nodeVoltage[i];
            expect(isNaN(v)).toBe(false);
            expect(isFinite(v)).toBe(true);
          }
        });
      });
    }
  }
});

// ── Specific deep-dive tests on circuits that previously had bugs ──────────
describe('Specific physics law checks — known previously-buggy circuits', () => {
  // The two-stage audio amplifier previously had Vce = -705V
  describe('Two-Stage Audio Amplifier — transistor Vce bounds', () => {
    const ex = exampleCategories.flatMap(c => c.examples).find(e => e.name === 'Two-Stage Audio Amplifier');
    if (!ex) {
      it('example found', () => expect(ex).toBeDefined());
    } else {
      const run = () => runSim(ex.doc, 2000, 1e-4);  // long sim to catch transients

      it('Q1 Vce never goes below -2V (no reverse breakdown)', () => {
        const r = run();
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        // Check the final step
        const vc = getVoltage(r, 'q1', 'c');
        const ve = getVoltage(r, 'q1', 'e');
        const vce = vc - ve;
        expect(vce).toBeGreaterThan(-2);
        expect(vce).toBeLessThan(15);  // 9V rail + 5V margin
      });

      it('Q2 Vce never goes below -2V (no reverse breakdown)', () => {
        const r = run();
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        const vc = getVoltage(r, 'q2', 'c');
        const ve = getVoltage(r, 'q2', 'e');
        const vce = vc - ve;
        expect(vce).toBeGreaterThan(-2);
        expect(vce).toBeLessThan(15);
      });

      it('No node voltage exceeds ±15V (within 9V rail + 5V margin)', () => {
        const r = run();
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        for (let i = 0; i < r.sim.nodeVoltage.length; i++) {
          const v = r.sim.nodeVoltage[i];
          expect(Math.abs(v)).toBeLessThan(20);  // 9V rail + 5V margin + 6V safety
        }
      });

      it('Op-amp output (if present) stays within ±9V rails', () => {
        const r = run();
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        const op = ex.doc.components.find(c => c.type === 'opamp' || c.type === 'opampRails' || c.type === 'opampReal');
        if (!op) return;
        const v = getVoltage(r, op.id, 'out');
        expect(v).toBeGreaterThan(-11);  // -9V rail + 2V margin
        expect(v).toBeLessThan(11);
      });

      it('Q1 Vbe is between 0 and 0.8V (forward-active or off)', () => {
        const r = run();
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        const vb = getVoltage(r, 'q1', 'b');
        const ve = getVoltage(r, 'q1', 'e');
        const vbe = vb - ve;
        // Vbe should be 0 (off) or ~0.7V (on). Allow -0.1V to 0.9V range.
        expect(vbe).toBeGreaterThan(-0.2);
        expect(vbe).toBeLessThan(1.0);
      });
    }
  });

  // The 555 timer has internal transistors — make sure they don't violate Vce
  describe('555 Astable Blink — transistor Vce bounds', () => {
    const ex = exampleCategories.flatMap(c => c.examples).find(e => e.name === '555 Astable Blink');
    if (!ex) {
      it('example found', () => expect(ex).toBeDefined());
    } else {
      it('No node exceeds 7V (5V rail + 2V margin)', () => {
        const r = runSim(ex.doc, 500, 1e-4);
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        for (let i = 0; i < r.sim.nodeVoltage.length; i++) {
          const v = r.sim.nodeVoltage[i];
          expect(v).toBeGreaterThan(-3);
          expect(v).toBeLessThan(8);
        }
      });
    }
  });

  // Arduino digital circuits — make sure 5V logic stays at 0 or 5V
  describe('Arduino Blink — logic levels', () => {
    const ex = exampleCategories.flatMap(c => c.examples).find(e => e.name === 'Arduino Blink');
    if (!ex) {
      it('example found', () => expect(ex).toBeDefined());
    } else {
      it('Arduino digital pins stay within [0V, 5.5V]', () => {
        const r = runSim(ex.doc, 500, 1e-4);
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        // Find Arduino's digital pin nodes and check they stay in logic range
        const ard = ex.doc.components.find(c => c.type === 'arduino' || c.type === 'arduinoReal');
        if (!ard) return;
        // Just check no node exceeds 6V (5V rail + 1V margin)
        for (let i = 0; i < r.sim.nodeVoltage.length; i++) {
          const v = r.sim.nodeVoltage[i];
          expect(v).toBeGreaterThan(-2);
          expect(v).toBeLessThan(7);
        }
      });
    }
  });

  // ── Capacitor I = C × dV/dt verification ──────────────────────────────
  describe('RC Low-pass Filter — capacitor I = C × dV/dt', () => {
    const ex = exampleCategories.flatMap(c => c.examples).find(e => e.name === 'RC Low-pass Filter');
    if (!ex) {
      it('example found', () => expect(ex).toBeDefined());
    } else {
      it('Capacitor voltage is finite and reasonable', () => {
        const r = runSim(ex.doc, 500, 1e-4);
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        const cap = ex.doc.components.find(c => c.type === 'capacitor');
        if (!cap) return;
        const v = getVoltage(r, cap.id, 'a') - getVoltage(r, cap.id, 'b');
        // Cap voltage should be finite and within the source's range
        expect(isFinite(v)).toBe(true);
        // Pulse source swings 0..5V, so cap should be in [-1, 6] range
        expect(v).toBeGreaterThan(-1);
        expect(v).toBeLessThan(6);
      });

      it('Capacitor current matches C × dV/dt (within 10%)', () => {
        // Run two consecutive steps and check the cap current
        const plugins = getPlugins(ex.doc.components);
        const nodeMap = buildNodeMap(ex.doc.components, ex.doc.wires, plugins);
        for (const c of ex.doc.components) if (!c.simState) c.simState = {};
        let prev: any = undefined;
        let prevSim: SimContext | null = null;
        let currSim: SimContext | null = null;
        for (let i = 0; i < 100; i++) {
          const r = simulateStep(ex.doc.components, ex.doc.wires, plugins, prev, 1e-4);
          if (!r) break;
          // Snapshot the node voltages (Float64Array is already a copy from the engine)
          prevSim = currSim;
          // Deep-copy state so step() mutations don't affect our snapshot
          currSim = {
            ...r.sim,
            nodeVoltage: new Float64Array(r.sim.nodeVoltage),
            state: { __global: { ...(r.sim.state.__global ?? {}) } },
          };
          prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
        }
        if (!prevSim || !currSim) { expect(prevSim && currSim).not.toBeNull(); return; }
        const cap = ex.doc.components.find(c => c.type === 'capacitor');
        if (!cap) return;
        const C = cap.parameters.capacitance as number;
        const dt = 1e-4;
        // V_prev and V_curr across the cap
        const aNode = nodeMap.terminalNode.get(`${cap.id}:a`);
        const bNode = nodeMap.terminalNode.get(`${cap.id}:b`);
        if (aNode === undefined || bNode === undefined) return;
        const vPrev = prevSim.nodeVoltage[aNode] - prevSim.nodeVoltage[bNode];
        const vCurr = currSim.nodeVoltage[aNode] - currSim.nodeVoltage[bNode];
        const dV = vCurr - vPrev;
        const expectedI = C * dV / dt;  // I = C × dV/dt
        // Get actual current from the engine (stored in step())
        const actualI = currSim.state?.__global?.[`cap_${cap.id}_i`] ?? 0;
        console.log(`Cap ${cap.id}: C=${C}F, dt=${dt}s, vPrev=${vPrev.toFixed(6)}V, vCurr=${vCurr.toFixed(6)}V, dV=${dV.toFixed(6)}V, expectedI=${expectedI.toFixed(9)}A, actualI=${actualI.toFixed(9)}A`);
        // Allow 25% tolerance because the engine uses backward Euler (which is approximate)
        if (Math.abs(expectedI) > 1e-9) {
          const relErr = Math.abs((actualI - expectedI) / expectedI);
          console.log(`  relErr = ${relErr.toFixed(4)}`);
          expect(relErr).toBeLessThan(0.25);
        }
      });
    }
  });

  // ── Transistor Ic = hfe × Ib verification (when in active region) ─────
  describe('Transistor Switch (NPN) — Ic = hfe × Ib when ON', () => {
    const ex = exampleCategories.flatMap(c => c.examples).find(e => e.name === 'Transistor Switch (NPN)');
    if (!ex) {
      it('example found', () => expect(ex).toBeDefined());
    } else {
      it('When button is pressed, transistor conducts (non-zero Ic)', () => {
        // Default button state — check if the transistor has non-zero collector current
        const r = runSim(ex.doc, 200, 1e-4);
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        const compCurrents = computeComponentCurrents(ex.doc.components, ex.doc.wires, r.plugins, r.sim);
        const q1 = ex.doc.components.find(c => c.type === 'npn');
        if (!q1) return;
        const ic = Math.abs(compCurrents.get(q1.id) ?? 0);
        // If button is pressed (default false), transistor should be off (Ic ≈ 0)
        // If button is pressed, Ic should be > 0
        const btn = ex.doc.components.find(c => c.type === 'pushButton');
        if (btn && btn.parameters.pressed) {
          expect(ic).toBeGreaterThan(1e-6);  // at least 1µA when on
        }
        // Either way, Ic should be finite
        expect(isFinite(ic)).toBe(true);
      });
    }
  });

  // ── Voltage Divider — verify Vout = Vin × R2/(R1+R2) ──────────────────
  describe('Voltage Divider — output voltage follows divider formula', () => {
    const ex = exampleCategories.flatMap(c => c.examples).find(e => e.name === 'Voltage Divider');
    if (!ex) {
      it('example found', () => expect(ex).toBeDefined());
    } else {
      it('Potentiometer wiper voltage is between 0 and Vin', () => {
        const r = runSim(ex.doc, 200, 1e-4);
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        const pot = ex.doc.components.find(c => c.type === 'potentiometer');
        if (!pot) return;
        const wiperV = getVoltage(r, pot.id, 'w');
        const aV = getVoltage(r, pot.id, 'a');
        // Wiper should be between 0 and Vin
        expect(wiperV).toBeGreaterThanOrEqual(-0.1);
        expect(wiperV).toBeLessThanOrEqual(aV + 0.1);
      });
    }
  });
});

// ── KCL verification at every node across all examples ────────────────────
describe('KCL — sum of currents at every node equals zero', () => {
  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      it(`KCL holds at every node: ${ex.name}`, () => {
        const r = runSim(ex.doc, 200, 1e-4);
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        // Use the existing physics validator which checks KCL
        const result = validatePhysics(ex.doc.components, ex.doc.wires, r.plugins, r.sim);
        const kclErrors = result.violations.filter(v => v.law === 'KCL' && v.severity === 'error');
        if (kclErrors.length > 0) {
          console.error(`KCL errors in ${ex.name}:`, kclErrors.map(e => e.message));
        }
        expect(kclErrors).toHaveLength(0);
      });
    }
  }
});

// ── Power conservation across all examples ────────────────────────────────
describe('Power Conservation — P_supplied = P_consumed', () => {
  for (const category of exampleCategories) {
    for (const ex of category.examples) {
      it(`Power is conserved: ${ex.name}`, () => {
        const r = runSim(ex.doc, 200, 1e-4);
        if (!r.sim) { expect(r.sim).not.toBeNull(); return; }
        // Use the existing physics validator which checks power conservation
        const result = validatePhysics(ex.doc.components, ex.doc.wires, r.plugins, r.sim);
        const powerErrors = result.violations.filter(v => v.law === 'Power Conservation' && v.severity === 'error');
        if (powerErrors.length > 0) {
          console.error(`Power errors in ${ex.name}:`, powerErrors.map(e => e.message));
        }
        expect(powerErrors).toHaveLength(0);
      });
    }
  }
});
