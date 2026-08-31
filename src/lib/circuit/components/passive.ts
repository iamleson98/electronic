// Passive components: resistor, capacitor, inductor.
// Capacitor and inductor use companion models (backward Euler) for transient analysis.

import type { ComponentPlugin } from '../types';
import { drawResistorZigzag, drawCapacitor, drawInductor, drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { trapAlternates, TRAP_RING_ALT_THRESHOLD } from '../integration';

// ----- Resistor -----
const resistor: ComponentPlugin = {
  type: 'resistor',
  name: 'Resistor',
  category: 'passive',
  description: 'Linear resistor. V = I·R.',
  symbol: 'R',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'resistance', label: 'Resistance', type: 'number', default: 1000, unit: 'Ω', min: 0.001, max: 1e9, step: 1 },
  ],
  render(ctx, params, cellSize) {
    const len = 4 * cellSize;
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(3 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    drawResistorZigzag(ctx, 2 * cellSize, 12);
    drawLabel(ctx, `${formatR(params.resistance as number)}`, 0, -16);
  },
  stamp(params, terminals, sys) {
    const r = Math.max(1e-9, params.resistance as number);
    const g = 1 / r;
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    sys.stampConductance(a, b, g);
  },
  getFlowPath() {
    // Straight line from terminal a (0,1) through the body to terminal b (4,1)
    return [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
    ];
  },
  measure(params, terminals, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    const r = params.resistance as number;
    const i = v / r;
    return [
      { label: 'V', value: v.toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(3), unit: 'mA' },
      { label: 'P', value: (v * i * 1000).toFixed(3), unit: 'mW' },
    ];
  },
};

function formatR(r: number): string {
  // Model-provided / hand-edited parameters can be null, undefined, or NaN —
  // the canvas renderer must NEVER crash on a bad label value.
  if (typeof r !== 'number' || !Number.isFinite(r)) return 'Ω?';
  if (r >= 1e6) return `${(r / 1e6).toFixed(2)}MΩ`;
  if (r >= 1e3) return `${(r / 1e3).toFixed(2)}kΩ`;
  if (r >= 1) return `${r.toFixed(0)}Ω`;
  if (r >= 1e-3) return `${(r * 1e3).toFixed(2)}mΩ`;
  return `${r.toExponential(2)}Ω`;
}

// ----- Capacitor -----

/** Visual charge state of a capacitor — pure, testable mapping from (V, I, t). */
export interface CapacitorChargeVisuals {
  /** 0..1 stored-charge level (soft saturation of |V|; half-glow at ~3 V). */
  level: number;
  /** True while energy flows INTO the cap (V·I > 0 → plates charging up). */
  charging: boolean;
  /** True while energy flows OUT (V·I < 0 → plates draining). */
  discharging: boolean;
  /** 0..1 glow intensity including pulse modulation — drives the plate halos. */
  glow: number;
  /** Pulse rate in Hz (∝ |I| — charging/discharging activity "breathes"). */
  pulseHz: number;
  /** Which physical plate is at the higher potential. */
  positivePlate: 'a' | 'b';
  /** How many +/− charge marks to draw per plate (0..3, ∝ charge level). */
  marks: number;
}

/** Voltage at which the plate glow reaches half intensity. */
const CAP_GLOW_HALF_V = 3;

/**
 * Map a capacitor's instantaneous (voltage, current, time) to its visual
 * charge state. Conventions (Falstad/EveryCircuit-style):
 *  • glow intensity tracks stored energy: |V| soft-saturating → [0,1)
 *  • while current flows the glow PULSES at a rate ∝ |I| ("it's charging")
 *  • when discharging, |V| decays → the glow naturally dims ("energy draining")
 *  • current direction is rendered by the flow dots (into + plate / out of −)
 */
export function capacitorChargeVisuals(v: number, i: number, time: number): CapacitorChargeVisuals {
  const av = typeof v === 'number' && isFinite(v) ? Math.abs(v) : 0;
  const ai = typeof i === 'number' && isFinite(i) ? Math.abs(i) : 0;
  const level = av / (av + CAP_GLOW_HALF_V);
  const vv = typeof v === 'number' && isFinite(v) ? v : 0;
  const ii = typeof i === 'number' && isFinite(i) ? i : 0;
  const power = vv * ii;
  // Charging/discharging STATE requires a visually meaningful current (≥1µA):
  // the exponential settling tail of an RC circuit leaves ~tens of nA forever,
  // and calling that "charging" would keep the badge alive eternally.
  const active = ai >= 1e-6;
  const charging = active && power > 0;
  const discharging = active && power < 0;
  // Pulse: 0.8–4.4 Hz, log-scaled with current magnitude (1µA → ~0.8 Hz, 1mA → ~2 Hz, ≥1A → 4.4 Hz).
  const pulseHz = 0.8 + 1.2 * Math.min(3, Math.max(0, Math.log10(ai / 1e-6 + 1)));
  const pulsing = active;
  const pulse = pulsing ? 0.72 + 0.28 * Math.sin(2 * Math.PI * pulseHz * time) : 1;
  const glow = Math.min(1, level * pulse);
  return {
    level,
    charging,
    discharging,
    glow,
    pulseHz,
    positivePlate: v >= 0 ? 'a' : 'b',
    marks: Math.min(3, Math.round(level * 3)),
  };
}

const capacitor: ComponentPlugin = {
  type: 'capacitor',
  name: 'Capacitor',
  category: 'passive',
  description: 'Linear capacitor. Q = C·V. Uses companion model for transient analysis.',
  symbol: 'C',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: '+', position: { x: 0, y: 1 } },
    { id: 'b', label: '-', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'capacitance', label: 'Capacitance', type: 'number', default: 1e-6, unit: 'F', min: 1e-15, max: 1, step: 1e-9 },
    { key: 'initialV', label: 'Initial Voltage', type: 'number', default: 0, unit: 'V', min: -1000, max: 1000, step: 0.1 },
  ],
  render(ctx, params, cellSize, sim, instance) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(2 * cellSize - 3, cellSize);
    ctx.moveTo(2 * cellSize + 3, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);

    // ── Charge visualization (only while a simulation context exists) ──────
    // The positive plate glows amber while charging (pulsing with |I|), the
    // negative plate glows cyan; both dim as the stored energy drains. +/−
    // marks show the accumulated charge — exactly the physics story the
    // animated current dots tell on the wires around it.
    if (sim && instance) {
      const st = (sim.state as any)?.__global ?? {};
      const key = `cap_${instance.id}`;
      const v = typeof st[key] === 'number' ? st[key] : ((params.initialV as number) ?? 0);
      const i = typeof st[key + '_i'] === 'number' ? st[key + '_i'] : 0;
      const cv = capacitorChargeVisuals(v, i, sim.time);
      if (cv.level > 0.02) {
        const plateGap = 6;
        // plate A sits at local x=0, plate B at x=plateGap (drawCapacitor geometry)
        const plates: Array<{ x: number; positive: boolean }> = [
          { x: 0, positive: cv.positivePlate === 'a' },
          { x: plateGap, positive: cv.positivePlate === 'b' },
        ];
        for (const plate of plates) {
          if (cv.glow <= 0.01) continue;
          const color = plate.positive ? '#fbbf24' : '#38bdf8';
          const radius = cellSize * (0.55 + 0.75 * cv.glow);
          const gradient = ctx.createRadialGradient(plate.x, 0, 1, plate.x, 0, radius);
          const aInner = Math.round(cv.glow * 0.55 * 255).toString(16).padStart(2, '0');
          const aMid = Math.round(cv.glow * 0.22 * 255).toString(16).padStart(2, '0');
          gradient.addColorStop(0, color + aInner);
          gradient.addColorStop(0.55, color + aMid);
          gradient.addColorStop(1, color + '00');
          ctx.fillStyle = gradient;
          ctx.fillRect(plate.x - radius, -radius, radius * 2, radius * 2);
        }
        // charge marks: + on the positive plate, − on the negative plate
        if (cv.marks > 0) {
          ctx.save();
          ctx.font = 'bold 8px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.globalAlpha = Math.min(1, 0.35 + cv.glow);
          const plateH = 18;
          for (const plate of plates) {
            ctx.fillStyle = plate.positive ? '#fde68a' : '#7dd3fc';
            const dx = plate.positive ? -5 : 5;
            for (let m = 0; m < cv.marks; m++) {
              const y = plateH / 2 - (m + 0.5) * (plateH / cv.marks);
              ctx.fillText(plate.positive ? '+' : '−', plate.x + dx, y);
            }
          }
          ctx.restore();
        }
      }
    }

    drawCapacitor(ctx, 6, 18);
    drawLabel(ctx, `${formatC(params.capacitance as number)}`, 0, -16);
  },
  stamp(params, terminals, sys, sim, comp) {
    const C = Math.max(1e-15, params.capacitance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `cap_${comp?.id ?? `${a}_${b}`}`;
    const vPrev = st[key] ?? (params.initialV as number);
    const method = sim.method ?? 'euler';
    // companion models — see integration.ts for the derivations.
    // The Norton source injects I_eq INTO node a (positive plate), same
    // orientation as the historical backward-Euler stamp.
    const dt = Math.max(sim.dt, 1e-12);
    let g: number;
    let iEq: number;
    if (method === 'trap' && !(st[key + '_ring'] > 0)) {
      // Trapezoidal (2nd order): i_n = (2C/dt)(v_n − v_{n−1}) − i_{n−1}
      //   → G = 2C/dt, I_eq = (2C/dt)·vPrev + iPrev
      // iPrev (the previous step's cap current) is stored under `_i` by step().
      const iPrev = (st[key + '_i'] as number | undefined) ?? 0;
      g = (2 * C) / dt;
      iEq = g * vPrev + iPrev;
      st[key + '_used'] = 'trap';
    } else if (method === 'trap') {
      // Trapezoidal ringing guard: the detector in step() counted a sustained
      // (−1)^n alternation of the cap current — fall back to backward Euler
      // for this step (L-stable, kills the sampling mode). The `_ring`
      // counter is decremented once per step by step().
      g = C / dt;
      iEq = (C / dt) * vPrev;
      st[key + '_used'] = 'euler';
    } else if (method === 'gear') {
      // Gear/BDF-2: i_n = C(3v_n − 4v_{n−1} + v_{n−2})/(2dt)
      //   → G = 3C/(2dt), I_eq = C(4vPrev − vPrev2)/(2dt)
      // Needs two steps of history; the first step falls back to Euler
      // (standard SPICE practice — start at order 1, then ramp up).
      const vPrev2 = st[key + '_v2'] as number | undefined;
      if (vPrev2 === undefined) {
        g = C / dt;
        iEq = (C / dt) * vPrev;
      } else {
        g = (3 * C) / (2 * dt);
        iEq = (C * (4 * vPrev - vPrev2)) / (2 * dt);
      }
    } else {
      // Backward Euler (default): G_eq = C/dt, I_eq = (C/dt) * vPrev
      g = C / dt;
      iEq = (C / dt) * vPrev;
    }
    sys.stampConductance(a, b, g);
    sys.stampCurrentSource(b, a, iEq);
  },
  getFlowPaths() {
    // Current does NOT cross the dielectric: dots flow INTO the positive
    // plate on the a-side and OUT of the negative plate on the b-side while
    // charging (i > 0), and the reverse while discharging. The gap between
    // the sub-paths is the plate gap (drawCapacitor plates at grid x≈1.83
    // and x≈2.33 of this 4-wide body).
    return [
      [{ x: 0, y: 1 }, { x: 1.8, y: 1 }],   // terminal a → positive plate
      [{ x: 2.25, y: 1 }, { x: 4, y: 1 }],  // negative plate → terminal b
    ];
  },
  step(params, terminals, sim, comp) {
    const C = Math.max(1e-15, params.capacitance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `cap_${comp?.id ?? `${a}_${b}`}`;
    const method = sim.method ?? 'euler';
    const dt = Math.max(sim.dt, 1e-12);
    const vPrev = st[key] ?? (params.initialV as number);
    const vCurr = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    // Compute the ACTUAL current that flowed during this step (BEFORE updating
    // vPrev). This is stored under `_i` and doubles as the trapezoidal
    // method's iPrev for the next step — the two quantities are identical.
    const used = method === 'trap' ? (st[key + '_used'] as 'trap' | 'euler' | undefined) ?? 'trap' : method;
    let i: number;
    if (used === 'trap') {
      const iPrev = (st[key + '_i'] as number | undefined) ?? 0;
      i = ((2 * C) / dt) * (vCurr - vPrev) - iPrev;
      // ── Trapezoidal ringing guard ──────────────────────────────────────
      // Sustained sign alternation of the current differences = the (−1)^n
      // sampling mode. A smooth signal alternates at most once (at an
      // extremum), so TRAP_RING_ALT_THRESHOLD consecutive alternations are
      // unambiguous ringing. Trip → the next two stamps fall back to Euler.
      const iPrev2 = st[key + '_i2'] as number | undefined;
      if (iPrev2 !== undefined) {
        const altKey = key + '_alt';
        if (trapAlternates(i, iPrev, iPrev2, 1e-12, 1e-3)) {
          const alt = ((st[altKey] as number | undefined) ?? 0) + 1;
          st[altKey] = alt;
          if (alt >= TRAP_RING_ALT_THRESHOLD) {
            st[key + '_ring'] = 2;                 // 2 Euler-fallback steps
            st[altKey] = 0;
            st.__trapRingCount = ((st.__trapRingCount as number | undefined) ?? 0) + 1;
          }
        } else {
          st[altKey] = 0;
        }
      }
    } else if (used === 'euler' && method === 'trap') {
      // Euler fallback step (ringing guard) — plain companion current.
      i = (C / dt) * (vCurr - vPrev);
    } else if (used === 'gear') {
      const vPrev2 = st[key + '_v2'] as number | undefined;
      i = vPrev2 === undefined
        ? (C / dt) * (vCurr - vPrev)
        : (C / (2 * dt)) * (3 * vCurr - 4 * vPrev + vPrev2);
    } else {
      i = (C / dt) * (vCurr - vPrev);
    }
    // shift history: _i2 keeps i_{n−1} (trap detector), _i keeps i_n.
    st[key + '_i2'] = st[key + '_i'];
    st[key + '_i'] = i;
    // Gear needs the shifted voltage history (v_{n−2} = old v_{n−1}).
    if (method === 'gear') {
      st[key + '_v2'] = vPrev;
    }
    // consume one Euler-fallback step (stamp() only reads the counter — it is
    // re-stamped several times per step by the feedback iteration, so the
    // countdown must happen exactly once, here).
    if (method === 'trap') {
      const ring = st[key + '_ring'] as number | undefined;
      if (ring !== undefined && ring > 0) st[key + '_ring'] = ring - 1;
    }
    // Now update vPrev for the next step's stamp()
    st[key] = vCurr;
  },
  measure(params, terminals, sim) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    return [{ label: 'V', value: v.toFixed(3), unit: 'V' }];
  },
};

function formatC(c: number): string {
  if (typeof c !== 'number' || !Number.isFinite(c)) return 'F?';
  if (c >= 1) return `${c.toFixed(2)}F`;
  if (c >= 1e-3) return `${(c * 1e3).toFixed(2)}mF`;
  if (c >= 1e-6) return `${(c * 1e6).toFixed(2)}µF`;
  if (c >= 1e-9) return `${(c * 1e9).toFixed(2)}nF`;
  return `${(c * 1e12).toFixed(2)}pF`;
}

// ----- Inductor -----
const inductor: ComponentPlugin = {
  type: 'inductor',
  name: 'Inductor',
  category: 'passive',
  description: 'Linear inductor. V = L·dI/dt. Uses companion model for transient analysis.',
  symbol: 'L',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'inductance', label: 'Inductance', type: 'number', default: 1e-3, unit: 'H', min: 1e-9, max: 100, step: 1e-6 },
    { key: 'initialI', label: 'Initial Current', type: 'number', default: 0, unit: 'A', min: -100, max: 100, step: 0.01 },
  ],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(3 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    ctx.translate(2 * cellSize, cellSize);
    drawInductor(ctx, 2 * cellSize, 4);
    drawLabel(ctx, `${formatL(params.inductance as number)}`, 0, -16);
  },
  stamp(params, terminals, sys, sim, comp) {
    const L = Math.max(1e-12, params.inductance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    // Use component ID for unique key — parallel inductors between the same
    // node pair must have independent state (different currents).
    const key = `ind_${comp?.id ?? `${a}_${b}`}`;
    const iPrev = st[key] ?? (params.initialI as number);
    const method = sim.method ?? 'euler';
    const dt = Math.max(sim.dt, 1e-12);
    let g: number;
    let iEq: number;
    if (method === 'trap' && !(st[key + '_ring'] > 0)) {
      // Trapezoidal: i_n = i_{n−1} + (dt/2L)(v_n + v_{n−1})
      //   → Norton: G = dt/(2L), I_eq = iPrev + (dt/2L)·vPrev (source a→b)
      const vPrev = (st[key + '_vp'] as number | undefined) ?? 0;
      g = dt / (2 * L);
      iEq = iPrev + g * vPrev;
      st[key + '_used'] = 'trap';
    } else if (method === 'trap') {
      // Ringing guard fallback — backward Euler companion (see capacitor).
      g = dt / L;
      iEq = iPrev;
      st[key + '_used'] = 'euler';
    } else if (method === 'gear') {
      // Gear/BDF-2: i_n = (4i_{n−1} − i_{n−2})/3 + (2dt/3L)·v_n
      // First step (no i_{n−2} yet) falls back to Euler.
      const iPrev2 = st[key + '_i2'] as number | undefined;
      if (iPrev2 === undefined) {
        g = dt / L;
        iEq = iPrev;
      } else {
        g = (2 * dt) / (3 * L);
        iEq = (4 * iPrev - iPrev2) / 3;
      }
    } else {
      // Backward Euler (default):
      //   V = L * (I - iPrev) / dt   ->   V = (L/dt) * I - (L/dt) * iPrev
      //   stamp as voltage source with V = -L/dt * iPrev and series resistance R = L/dt
      // Equivalent: Thevenin: V_th = -(L/dt) * iPrev, R = L/dt
      //   -> stamp as conductance G = dt/L in parallel with current source I = iPrev
      g = dt / L;
      iEq = iPrev;
    }
    sys.stampConductance(a, b, g);
    sys.stampCurrentSource(a, b, iEq);
  },
  getFlowPath() {
    // Straight through the inductor coils
    return [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
    ];
  },
  step(params, terminals, sim, comp) {
    const L = Math.max(1e-12, params.inductance as number);
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = `ind_${comp?.id ?? `${a}_${b}`}`;
    const method = sim.method ?? 'euler';
    const dt = Math.max(sim.dt, 1e-12);
    const iPrev = st[key] ?? (params.initialI as number);
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    // Integrate the inductor current with the selected method. The stored
    // `_i` (this step's current) doubles as the readout for current displays
    // and, for Gear, `_i2` keeps i_{n−2}; `_vp` keeps v_{n−1} for trapezoidal.
    const used = method === 'trap' ? (st[key + '_used'] as 'trap' | 'euler' | undefined) ?? 'trap' : method;
    let iCurr: number;
    if (used === 'trap') {
      const vPrev = (st[key + '_vp'] as number | undefined) ?? 0;
      iCurr = iPrev + (dt / (2 * L)) * (v + vPrev);
      // ── Trapezoidal ringing guard (dual of the capacitor's) ──────────────
      // Ringing on an inductor appears in the VOLTAGE across it (the current
      // integrates smoothly). Watch the voltage history for sustained sign
      // alternation of consecutive differences.
      const vPrev2 = st[key + '_vp2'] as number | undefined;
      if (vPrev2 !== undefined) {
        const altKey = key + '_alt';
        if (trapAlternates(v, vPrev, vPrev2, 1e-6, 1e-3)) {
          const alt = ((st[altKey] as number | undefined) ?? 0) + 1;
          st[altKey] = alt;
          if (alt >= TRAP_RING_ALT_THRESHOLD) {
            st[key + '_ring'] = 2;               // 2 Euler-fallback steps
            st[altKey] = 0;
            st.__trapRingCount = ((st.__trapRingCount as number | undefined) ?? 0) + 1;
          }
        } else {
          st[altKey] = 0;
        }
      }
    } else if (used === 'gear') {
      const iPrev2 = st[key + '_i2'] as number | undefined;
      iCurr = iPrev2 === undefined
        ? iPrev + (v / L) * dt
        : (4 * iPrev - iPrev2) / 3 + ((2 * dt) / (3 * L)) * v;
    } else {
      iCurr = iPrev + (v / L) * dt;
    }
    // Store the current BEFORE updating iPrev.
    // I = iCurr (the inductor's state variable IS its current)
    st[key + '_i'] = iCurr;
    if (method === 'gear') {
      st[key + '_i2'] = iPrev;
    }
    // shift voltage history for the trap detector: _vp2 keeps v_{n−1}.
    if (method === 'trap') {
      st[key + '_vp2'] = st[key + '_vp'];
    }
    st[key + '_vp'] = v;
    // consume one Euler-fallback step (see the capacitor's step()).
    if (method === 'trap') {
      const ring = st[key + '_ring'] as number | undefined;
      if (ring !== undefined && ring > 0) st[key + '_ring'] = ring - 1;
    }
    // Now update iPrev for the next step's stamp()
    st[key] = iCurr;
  },
  measure(params, terminals, sim, comp) {
    const a = terminals.find((t) => t.terminalId === 'a')!.nodeId;
    const b = terminals.find((t) => t.terminalId === 'b')!.nodeId;
    const st = sim.state.__global ?? {};
    // step() stores the current under `ind_${compId}` — the old node-pair key
    // never matched, so the readout was always stuck at 0.
    const key = comp ? `ind_${comp.id}` : `ind_${a}_${b}`;
    const i = st[key] ?? 0;
    return [
      { label: 'V', value: (sim.nodeVoltage[a] - sim.nodeVoltage[b]).toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(3), unit: 'mA' },
    ];
  },
};

function formatL(l: number): string {
  if (typeof l !== 'number' || !Number.isFinite(l)) return 'H?';
  if (l >= 1) return `${l.toFixed(2)}H`;
  if (l >= 1e-3) return `${(l * 1e3).toFixed(2)}mH`;
  if (l >= 1e-6) return `${(l * 1e6).toFixed(2)}µH`;
  return `${(l * 1e9).toFixed(2)}nH`;
}

// ----- Ground -----
const ground: ComponentPlugin = {
  type: 'ground',
  name: 'Ground',
  category: 'source',
  description: 'Reference 0V node. Required for any circuit.',
  symbol: 'GND',
  boundingBox: { width: 2, height: 2 },
  terminals: [
    { id: 'g', label: 'GND', position: { x: 1, y: 0 } },
  ],
  parameters: [],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.moveTo(cellSize, 0);
    ctx.lineTo(cellSize, cellSize);
    ctx.stroke();
    ctx.translate(cellSize, cellSize);
    // ground symbol: three horizontal lines
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(8, 0);
    ctx.moveTo(-5, 4);
    ctx.lineTo(5, 4);
    ctx.moveTo(-2, 8);
    ctx.lineTo(2, 8);
    ctx.stroke();
  },
};

// ----- Wire / Node (just a junction dot) -----
const junction: ComponentPlugin = {
  type: 'junction',
  name: 'Junction',
  category: 'passive',
  description: 'Visual wire junction. Connects all attached terminals electrically.',
  symbol: '•',
  boundingBox: { width: 1, height: 1 },
  terminals: [
    { id: 'a', label: '', position: { x: 0, y: 0 } },
  ],
  parameters: [],
  render(ctx, params, cellSize) {
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
  },
  stamp() {
    // no-op; node identity handled by wire graph
  },
};

registerPlugin(resistor);
registerPlugin(capacitor);
registerPlugin(inductor);
registerPlugin(ground);
registerPlugin(junction);

export { resistor, capacitor, inductor, ground, junction };
