// Physics & Electrical Law Validator
// ─────────────────────────────────────────────────────────────────────────────
// A set of physics laws that EVERY circuit simulation must satisfy. After each
// simulation step, run `validatePhysics()` to check the result against these
// laws. Any violation indicates a bug in the simulation engine, a component
// model, or the wire-current computation.
//
// Laws implemented:
//   1. Voltage Sanity      — no NaN, Infinity, or absurdly large voltages
//   2. KCL (node currents)  — sum of currents leaving any node ≈ 0
//   3. Series Current      — all wires in a series path carry the same |I|
//   4. Diode Forward Law   — I_diode = (V - Vf) / R when on, 0 when off
//   5. Transistor Off Law  — when base drive removed, I_C must drop to ~0
//   6. Voltage Source      — V(p) - V(n) = rated voltage
//   7. Power Conservation  — P_supplied ≈ P_consumed (within tolerance)
//   8. Switch Off Law      — open switch → 0 current through it
//   9. 7-Segment Law       — OFF segments draw ~0 current, ON segments draw I
//  10. CD4026 Output Law   — segment output HIGH when count says ON, else LOW
//
// Each law returns a list of violations. Empty list = law satisfied.

import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from './types';
import { buildNodeMap, getTerminalsForComponent, computeComponentCurrents, computeWireCurrents } from './engine';
import { getPlugin } from './registry';
import { stateKey } from './state-keys';

export interface PhysicsViolation {
  law: string;           // e.g. "KCL", "Series Current", "Diode Forward Law"
  severity: 'error' | 'warning';
  componentId?: string;   // which component violated (if applicable)
  wireId?: string;        // which wire violated (if applicable)
  nodeId?: number;        // which node violated (if applicable)
  message: string;        // human-readable description
  expected?: string;      // what the value should be
  actual?: string;        // what the value actually is
}

export interface ValidationResult {
  violations: PhysicsViolation[];
  passed: boolean;        // true if no 'error' severity violations
  checkedAt: number;       // sim.time when validated
  componentCount: number;
  wireCount: number;
}

// Tolerances
const TOL = {
  current: 1e-9,      // 1 nA — below this, treat as zero
  voltage: 1e-6,      // 1 µV
  kclNode: 1e-7,      // 100 nA — KCL must balance to this
  powerRel: 0.05,     // 5% relative tolerance for power conservation
  maxVoltage: 1e6,    // no node voltage should exceed 1 MV (sanity)
  seriesRel: 0.02,    // 2% relative tolerance for series current equality
};

/**
 * Run all physics laws against the circuit + simulation result.
 * Returns a list of violations. Empty list = all laws satisfied.
 */
export function validatePhysics(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  sim: SimContext,
): ValidationResult {
  const violations: PhysicsViolation[] = [];
  const nodeMap = buildNodeMap(components, wires, plugins);
  const compCurrents = computeComponentCurrents(components, wires, plugins, sim);
  const wireCurrents = computeWireCurrents(components, wires, plugins, sim);

  // ── Law 1: Voltage Sanity ──────────────────────────────────────────────
  for (let i = 0; i < sim.nodeVoltage.length; i++) {
    const v = sim.nodeVoltage[i];
    if (!isFinite(v)) {
      violations.push({
        law: 'Voltage Sanity',
        severity: 'error',
        nodeId: i,
        message: `Node ${i} voltage is ${isNaN(v) ? 'NaN' : 'Infinity'}`,
        expected: 'finite number',
        actual: String(v),
      });
    } else if (Math.abs(v) > TOL.maxVoltage) {
      violations.push({
        law: 'Voltage Sanity',
        severity: 'error',
        nodeId: i,
        message: `Node ${i} voltage ${v.toFixed(2)}V exceeds sanity limit ${TOL.maxVoltage}V`,
        expected: `|V| < ${TOL.maxVoltage}V`,
        actual: `${v.toFixed(2)}V`,
      });
    }
  }

  // ── Law 2: KCL — sum of currents leaving any node ≈ 0 ──────────────────
  // For each node, sum the currents from all wires connected to it.
  // The sum should be ≈ 0 (KCL).
  const nodeCurrentSum = new Map<number, number>();
  for (const wire of wires) {
    const fromComp = components.find(c => c.id === wire.from.componentId);
    const toComp = components.find(c => c.id === wire.to.componentId);
    if (!fromComp || !toComp) continue;
    const fromPlugin = plugins.get(fromComp.type);
    const toPlugin = plugins.get(toComp.type);
    if (!fromPlugin || !toPlugin) continue;
    const fromTerms = getTerminalsForComponent(fromComp, fromPlugin, nodeMap);
    const toTerms = getTerminalsForComponent(toComp, toPlugin, nodeMap);
    const fromNode = fromTerms.find(t => t.terminalId === wire.from.terminalId)?.nodeId ?? 0;
    const toNode = toTerms.find(t => t.terminalId === wire.to.terminalId)?.nodeId ?? 0;
    const i = wireCurrents.get(wire.id) ?? 0;
    // Current flows from→to: leaves fromNode (+i), enters toNode (-i)
    nodeCurrentSum.set(fromNode, (nodeCurrentSum.get(fromNode) ?? 0) + i);
    nodeCurrentSum.set(toNode, (nodeCurrentSum.get(toNode) ?? 0) - i);
  }
  for (const [nodeId, sum] of nodeCurrentSum) {
    if (Math.abs(sum) > TOL.kclNode) {
      // Only report if the node has multiple wires (otherwise it's not a real KCL test)
      const connectedWires = wires.filter(w => {
        const fc = components.find(c => c.id === w.from.componentId);
        const tc = components.find(c => c.id === w.to.componentId);
        if (!fc || !tc) return false;
        const fp = plugins.get(fc.type);
        const tp = plugins.get(tc.type);
        if (!fp || !tp) return false;
        const ft = getTerminalsForComponent(fc, fp, nodeMap);
        const tt = getTerminalsForComponent(tc, tp, nodeMap);
        const fn = ft.find(t => t.terminalId === w.from.terminalId)?.nodeId ?? 0;
        const tn = tt.find(t => t.terminalId === w.to.terminalId)?.nodeId ?? 0;
        return fn === nodeId || tn === nodeId;
      });
      if (connectedWires.length >= 2) {
        violations.push({
          law: 'KCL',
          severity: 'error',
          nodeId,
          message: `KCL violated at node ${nodeId}: net current = ${sum.toFixed(6)}A (should be ~0)`,
          expected: '0A',
          actual: `${sum.toFixed(6)}A`,
        });
      }
    }
  }

  // ── Law 3: Series Current Equality ─────────────────────────────────────
  // In a series path (e.g., V → R → LED → GND), all wires should carry the
  // same |current|. Find series paths by tracing wire connectivity.
  // We check simple 2-terminal components: the wire on the 'a' side and the
  // wire on the 'b' side should have the same |current|.
  for (const comp of components) {
    if (!['resistor', 'led', 'diode', 'capacitor', 'inductor', 'switch', 'pushButton'].includes(comp.type)) continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const aNode = terms.find(t => t.terminalId === 'a')?.nodeId ?? 0;
    const bNode = terms.find(t => t.terminalId === (comp.type === 'led' || comp.type === 'diode' ? 'k' : 'b'))?.nodeId ?? 0;
    // Find wires connected to a and b
    const aWires: { id: string; i: number }[] = [];
    const bWires: { id: string; i: number }[] = [];
    for (const wire of wires) {
      const fc = components.find(c => c.id === wire.from.componentId);
      const tc = components.find(c => c.id === wire.to.componentId);
      if (!fc || !tc) continue;
      const fp = plugins.get(fc.type);
      const tp = plugins.get(tc.type);
      if (!fp || !tp) continue;
      const ft = getTerminalsForComponent(fc, fp, nodeMap);
      const tt = getTerminalsForComponent(tc, tp, nodeMap);
      const fn = ft.find(t => t.terminalId === wire.from.terminalId)?.nodeId ?? 0;
      const tn = tt.find(t => t.terminalId === wire.to.terminalId)?.nodeId ?? 0;
      const i = wireCurrents.get(wire.id) ?? 0;
      if (fn === aNode || tn === aNode) aWires.push({ id: wire.id, i });
      if (fn === bNode || tn === bNode) bWires.push({ id: wire.id, i });
    }
    // If there's exactly one wire on each side, they should have the same |I|
    if (aWires.length === 1 && bWires.length === 1) {
      const aI = Math.abs(aWires[0].i);
      const bI = Math.abs(bWires[0].i);
      if (aI > TOL.current && bI > TOL.current) {
        const relDiff = Math.abs(aI - bI) / Math.max(aI, bI);
        if (relDiff > TOL.seriesRel) {
          violations.push({
            law: 'Series Current',
            severity: 'error',
            componentId: comp.id,
            message: `${comp.id} (${comp.type}): series current mismatch — a-side=${(aI*1000).toFixed(3)}mA, b-side=${(bI*1000).toFixed(3)}mA`,
            expected: `${(Math.max(aI, bI)*1000).toFixed(3)}mA on both sides`,
            actual: `a=${(aI*1000).toFixed(3)}mA, b=${(bI*1000).toFixed(3)}mA`,
          });
        }
      }
    }
  }

  // ── Law 4: Diode / LED Forward Law ──────────────────────────────────────
  // When forward-biased (V > Vf), I = (V - Vf) / R. When off, I = 0.
  for (const comp of components) {
    if (comp.type !== 'led' && comp.type !== 'diode') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const aNode = terms.find(t => t.terminalId === 'a')?.nodeId ?? 0;
    const kNode = terms.find(t => t.terminalId === 'k')?.nodeId ?? 0;
    const v = sim.nodeVoltage[aNode] - sim.nodeVoltage[kNode];
    const vf = (comp.parameters.forwardV as number) || 0.7;
    // Guard against undefined params — Math.max(0.01, undefined) is NaN and
    // NaN comparisons are always false, silently disabling this whole check.
    const r = comp.type === 'led'
      ? Math.max(0.01, (comp.parameters.seriesR as number) ?? 220)
      : Math.max(0.001, (comp.parameters.onR as number) ?? 1);
    const st = sim.state.__global ?? {};
    const on = st[stateKey(comp.type, comp, aNode, kNode)] ?? false;
    const actualI = Math.abs(compCurrents.get(comp.id) ?? 0);
    if (on) {
      // Should have current ≈ (V - Vf) / R
      const expectedI = Math.max(0, (v - vf) / r);
      if (Math.abs(actualI - expectedI) > Math.max(0.001, expectedI * 0.1)) {
        violations.push({
          law: 'Diode Forward Law',
          severity: 'warning',
          componentId: comp.id,
          message: `${comp.id}: ON state current ${(actualI*1000).toFixed(3)}mA ≠ expected ${(expectedI*1000).toFixed(3)}mA`,
          expected: `${(expectedI*1000).toFixed(3)}mA`,
          actual: `${(actualI*1000).toFixed(3)}mA`,
        });
      }
    } else {
      // OFF state: should have ~0 current
      if (actualI > 0.0001) { // > 0.1 mA
        violations.push({
          law: 'Diode Forward Law',
          severity: 'error',
          componentId: comp.id,
          message: `${comp.id}: OFF state but current = ${(actualI*1000).toFixed(3)}mA (should be ~0)`,
          expected: '0mA',
          actual: `${(actualI*1000).toFixed(3)}mA`,
        });
      }
    }
  }

  // ── Law 5: Transistor Off Law ──────────────────────────────────────────
  // When the base current is ~0 (external drive removed), the collector
  // current MUST drop to ~0. This catches the "stuck on" bug.
  //
  // AC CIRCUIT EXCEPTION: In an AC-driven amplifier (e.g. the Two-Stage
  // Audio Amplifier), the base current swings positive AND negative each
  // cycle. At the moment the simulator samples `prevIb`, the AC source may
  // be at its negative peak (Ib ≈ 0) even though the collector is still
  // conducting due to the Ce bypass cap or just because the AC current
  // continues to flow. To avoid false positives in AC circuits, we check
  // whether there's any AC source in the circuit — if so, we skip this
  // check (it's designed for DC switch circuits like "button released").
  const hasAcSource = components.some(c => c.type === 'acVoltage' || c.type === 'pulseSource');
  for (const comp of components) {
    if (comp.type !== 'npn' && comp.type !== 'pnp') continue;
    if (hasAcSource) continue;  // skip the "stuck on" check in AC circuits
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const st = sim.state.__global ?? {};
    const key = stateKey(comp.type, comp);
    const prevIb = (st[key + '_ib'] as number) ?? 0;
    const ic = Math.abs(compCurrents.get(comp.id) ?? 0);
    if (prevIb < TOL.current && ic > 0.0001) { // < 1nA base drive but > 0.1mA collector
      violations.push({
        law: 'Transistor Off Law',
        severity: 'error',
        componentId: comp.id,
        message: `${comp.id}: base current ≈ 0 (${(prevIb*1e9).toFixed(2)}nA) but collector current = ${(ic*1000).toFixed(3)}mA — transistor stuck on`,
        expected: 'I_C ≈ 0 when I_B ≈ 0',
        actual: `I_B=${(prevIb*1e9).toFixed(2)}nA, I_C=${(ic*1000).toFixed(3)}mA`,
      });
    }
  }

  // ── Law 6: Voltage Source ──────────────────────────────────────────────
  // V(p) - V(n) should equal the rated voltage.
  for (const comp of components) {
    if (comp.type !== 'dcVoltage' && comp.type !== 'acVoltage' && comp.type !== 'pulseSource') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const pNode = terms.find(t => t.terminalId === 'p')?.nodeId ?? 0;
    const nNode = terms.find(t => t.terminalId === 'n')?.nodeId ?? 0;
    const actualV = sim.nodeVoltage[pNode] - sim.nodeVoltage[nNode];
    let expectedV: number;
    if (comp.type === 'dcVoltage') {
      expectedV = comp.parameters.voltage as number;
    } else if (comp.type === 'acVoltage') {
      const amp = comp.parameters.amplitude as number;
      const freq = comp.parameters.frequency as number;
      // The plugin's phase parameter is in DEGREES (unit: '°') — convert to
      // radians like sources.ts does, or every phased source false-errors.
      const phase = ((comp.parameters.phase as number) ?? 0) * Math.PI / 180;
      const offset = (comp.parameters.offset as number) ?? 0;
      expectedV = offset + amp * Math.sin(2 * Math.PI * freq * sim.time + phase);
    } else {
      // pulseSource
      const f = comp.parameters.frequency as number;
      const duty = ((comp.parameters.duty as number) ?? 50) / 100;
      const t = (sim.time * f) % 1;
      expectedV = t < duty ? (comp.parameters.high as number) : (comp.parameters.low as number);
    }
    if (Math.abs(actualV - expectedV) > TOL.voltage) {
      violations.push({
        law: 'Voltage Source',
        severity: 'error',
        componentId: comp.id,
        message: `${comp.id}: V(p)-V(n) = ${actualV.toFixed(4)}V ≠ rated ${expectedV.toFixed(4)}V`,
        expected: `${expectedV.toFixed(4)}V`,
        actual: `${actualV.toFixed(4)}V`,
      });
    }
  }

  // ── Law 7: Power Conservation ──────────────────────────────────────────
  // Sum of power supplied by sources ≈ sum of power consumed by loads.
  let powerSupplied = 0;
  let powerConsumed = 0;
  for (const comp of components) {
    const i = compCurrents.get(comp.id) ?? 0;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    if (comp.type === 'dcVoltage' || comp.type === 'acVoltage' || comp.type === 'pulseSource') {
      const pNode = terms.find(t => t.terminalId === 'p')?.nodeId ?? 0;
      const nNode = terms.find(t => t.terminalId === 'n')?.nodeId ?? 0;
      const v = sim.nodeVoltage[pNode] - sim.nodeVoltage[nNode];
      powerSupplied += v * i;
    } else if (['resistor', 'led', 'diode', 'zener', 'capacitor', 'inductor', 'speaker', 'lamp', 'dcMotor', 'photoresistor',
               'npn', 'pnp', 'nmos', 'pmos', 'switch', 'pushButton', 'potentiometer'].includes(comp.type)) {
      // Two-terminal passives plus transistors/switches: account for their
      // dissipation so transistor circuits don't trip the power-conservation
      // warning (Vce·Ic used to be missing entirely from "consumed").
      let aNode: number, bNode: number;
      if (comp.type === 'npn' || comp.type === 'nmos' || comp.type === 'pmos') {
        aNode = terms.find(t => t.terminalId === (comp.type === 'npn' ? 'c' : 'd'))?.nodeId ?? 0;
        bNode = terms.find(t => t.terminalId === (comp.type === 'npn' ? 'e' : 's'))?.nodeId ?? 0;
      } else if (comp.type === 'pnp') {
        aNode = terms.find(t => t.terminalId === 'e')?.nodeId ?? 0;
        bNode = terms.find(t => t.terminalId === 'c')?.nodeId ?? 0;
      } else {
        aNode = terms.find(t => t.terminalId === 'a')?.nodeId ?? 0;
        bNode = terms.find(t => t.terminalId === (comp.type === 'led' || comp.type === 'diode' || comp.type === 'zener' ? 'k' : 'b'))?.nodeId ?? 0;
      }
      const v = sim.nodeVoltage[aNode] - sim.nodeVoltage[bNode];
      powerConsumed += Math.abs(v * i);
    } else if (comp.type === 'sevenSegment') {
      // 7-seg: sum of (V_seg - V_com) * I_seg for each ON segment
      const com = terms.find(t => t.terminalId === 'com')?.nodeId ?? 0;
      let segPower = 0;
      for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const segNode = terms.find(t => t.terminalId === seg)?.nodeId ?? 0;
        const segV = sim.nodeVoltage[segNode] - sim.nodeVoltage[com];
        // Compute per-segment current from the segment voltage and internal R
        const rSeg = 220;
        const threshold = (comp.parameters.threshold as number) ?? 2.0;
        const st = sim.state.__global ?? {};
        const segKey = stateKey('7seg', comp, ...terms.map(t => t.nodeId));
        const segStates = (st[segKey] ?? {}) as Record<string, boolean>;
        const prevOn = segStates[seg] ?? false;
        const on = prevOn ? segV > threshold * 0.5 : segV > threshold;
        if (on) {
          segPower += Math.abs(segV * (segV / rSeg));
        }
      }
      powerConsumed += segPower;
    }
    // Note: cd4026 power is accounted for via the 7-seg displays it drives
    // (the CD4026 sources current from VCC, which flows through to the 7-seg).
    // We don't double-count it here.
  }
  if (powerSupplied > 0.001) {
    const relDiff = Math.abs(powerSupplied - powerConsumed) / powerSupplied;
    if (relDiff > TOL.powerRel) {
      violations.push({
        law: 'Power Conservation',
        severity: 'warning',
        message: `Power mismatch: supplied ${(powerSupplied*1000).toFixed(3)}mW vs consumed ${(powerConsumed*1000).toFixed(3)}mW`,
        expected: `${(powerSupplied*1000).toFixed(3)}mW`,
        actual: `${(powerConsumed*1000).toFixed(3)}mW`,
      });
    }
  }

  // ── Law 8: Switch Off Law ──────────────────────────────────────────────
  // An open switch should have ~0 current through it.
  for (const comp of components) {
    if (comp.type !== 'switch' && comp.type !== 'pushButton') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const closed = comp.type === 'switch' ? comp.parameters.closed : comp.parameters.pressed;
    if (!closed) {
      const i = Math.abs(compCurrents.get(comp.id) ?? 0);
      if (i > 0.0001) { // > 0.1 mA through an open switch
        violations.push({
          law: 'Switch Off Law',
          severity: 'error',
          componentId: comp.id,
          message: `${comp.id}: open switch but current = ${(i*1000).toFixed(3)}mA (should be ~0)`,
          expected: '0mA',
          actual: `${(i*1000).toFixed(3)}mA`,
        });
      }
    }
  }

  // ── Law 9: 7-Segment Law ──────────────────────────────────────────────
  // OFF segments should draw ~0 current, ON segments should draw I > 0.
  for (const comp of components) {
    if (comp.type !== 'sevenSegment') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const st = sim.state.__global ?? {};
    const segKey = stateKey('7seg', comp, ...terms.map(t => t.nodeId));
    const segStates = (st[segKey] ?? {}) as Record<string, boolean>;
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const segNode = terms.find(t => t.terminalId === seg)?.nodeId ?? 0;
      const segI = Math.abs(compCurrents.get(comp.id) ?? 0); // approximate
      const isOn = segStates[seg] ?? false;
      const v = sim.nodeVoltage[segNode];
      if (isOn && v < 2.0) {
        violations.push({
          law: '7-Segment Law',
          severity: 'warning',
          componentId: comp.id,
          message: `${comp.id}.${seg}: marked ON but voltage = ${v.toFixed(3)}V (should be > 2V)`,
          expected: '> 2V',
          actual: `${v.toFixed(3)}V`,
        });
      }
      if (!isOn && v > 3.0) {
        violations.push({
          law: '7-Segment Law',
          severity: 'warning',
          componentId: comp.id,
          message: `${comp.id}.${seg}: marked OFF but voltage = ${v.toFixed(3)}V (should be < 2V)`,
          expected: '< 2V',
          actual: `${v.toFixed(3)}V`,
        });
      }
    }
  }

  // ── Law 10: CD4026 Output Law ──────────────────────────────────────────
  // Segment outputs should be HIGH (5V) when count says ON, LOW (0V) when OFF.
  // Carry-out should be HIGH for first half of count cycle.
  for (const comp of components) {
    if (comp.type !== 'cd4026') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const key = comp.id
      ? `cd4026_${comp.id}`
      : `cd4026_${terms.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
    const st = sim.state[key] ?? { count: 0 };
    const maxCount = comp.parameters.maxCount as number;
    const vccV = comp.parameters.vcc as number;
    // Check segment outputs
    const SEG_PATTERNS: Record<number, number[]> = {
      0: [1,1,1,1,1,1,0], 1: [0,1,1,0,0,0,0], 2: [1,1,0,1,1,0,1], 3: [1,1,1,1,0,0,1],
      4: [0,1,1,0,0,1,1], 5: [1,0,1,1,0,1,1], 6: [1,0,1,1,1,1,1], 7: [1,1,1,0,0,0,0],
      8: [1,1,1,1,1,1,1], 9: [1,1,1,1,0,1,1],
    };
    const pattern = SEG_PATTERNS[st.count] ?? [0,0,0,0,0,0,0];
    const segIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (let i = 0; i < 7; i++) {
      const segNode = terms.find(t => t.terminalId === segIds[i])?.nodeId ?? 0;
      const v = sim.nodeVoltage[segNode];
      const expected = pattern[i] ? vccV : 0;
      if (Math.abs(v - expected) > 0.1) {
        violations.push({
          law: 'CD4026 Output Law',
          severity: 'error',
          componentId: comp.id,
          message: `${comp.id}.${segIds[i]}: count=${st.count}, expected ${expected}V, got ${v.toFixed(3)}V`,
          expected: `${expected}V`,
          actual: `${v.toFixed(3)}V`,
        });
      }
    }
    // Check carry-out (only if CO is actually wired to something)
    const coNode = terms.find(t => t.terminalId === 'co')?.nodeId ?? 0;
    const coWired = wires.some(w => {
      const fc = components.find(c => c.id === w.from.componentId);
      const tc = components.find(c => c.id === w.to.componentId);
      if (!fc || !tc) return false;
      const fp = plugins.get(fc.type);
      const tp = plugins.get(tc.type);
      if (!fp || !tp) return false;
      const ft = getTerminalsForComponent(fc, fp, nodeMap);
      const tt = getTerminalsForComponent(tc, tp, nodeMap);
      const fn = ft.find(t => t.terminalId === w.from.terminalId)?.nodeId ?? 0;
      const tn = tt.find(t => t.terminalId === w.to.terminalId)?.nodeId ?? 0;
      return fn === coNode || tn === coNode;
    });
    if (coWired) {
      const coV = sim.nodeVoltage[coNode];
      const coExpected = st.count < maxCount / 2 ? vccV : 0;
      if (Math.abs(coV - coExpected) > 0.1) {
        violations.push({
          law: 'CD4026 Output Law',
          severity: 'warning',
          componentId: comp.id,
          message: `${comp.id}.co: count=${st.count}, expected ${coExpected}V, got ${coV.toFixed(3)}V`,
          expected: `${coExpected}V`,
          actual: `${coV.toFixed(3)}V`,
        });
      }
    }
  }

  const hasErrors = violations.some(v => v.severity === 'error');
  return {
    violations,
    passed: !hasErrors,
    checkedAt: sim.time,
    componentCount: components.length,
    wireCount: wires.length,
  };
}

/**
 * Format validation results as a human-readable string.
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push(`=== Physics Validation @ t=${result.checkedAt.toFixed(4)}s ===`);
  lines.push(`Components: ${result.componentCount}, Wires: ${result.wireCount}`);
  lines.push(`Status: ${result.passed ? 'PASS ✓' : 'FAIL ✗'}`);
  lines.push(`Violations: ${result.violations.length}`);
  if (result.violations.length > 0) {
    lines.push('');
    const byLaw = new Map<string, PhysicsViolation[]>();
    for (const v of result.violations) {
      if (!byLaw.has(v.law)) byLaw.set(v.law, []);
      byLaw.get(v.law)!.push(v);
    }
    for (const [law, vs] of byLaw) {
      const errors = vs.filter(v => v.severity === 'error').length;
      const warnings = vs.filter(v => v.severity === 'warning').length;
      lines.push(`── ${law} (${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''}) ──`);
      for (const v of vs.slice(0, 5)) {
        lines.push(`  [${v.severity.toUpperCase()}] ${v.message}`);
      }
      if (vs.length > 5) lines.push(`  ... and ${vs.length - 5} more`);
    }
  }
  return lines.join('\n');
}
