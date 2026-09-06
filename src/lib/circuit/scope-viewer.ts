// ─── Oscilloscope view model ────────────────────────────────────────────────
// Pure math + formatting helpers backing the scope tab of the ProbePanel.
// The React layer owns all state; everything exported here is side-effect
// free so it can be unit-tested in isolation (tests/scope-viewer.test.ts and
// tests/scope-panel.test.ts).

export interface ScopeSample { time: number; voltage: number; }
export interface ScopeChannel { id: string; label: string; color: string; samples: ScopeSample[]; visible: boolean; voltageScale: number; voltageOffset: number; coupling: 'DC' | 'AC'; }
export interface ScopeCursor { enabled: boolean; time: number; channel: number; }

/** Trigger configuration. Modes:
 *  - auto: free-running (traces stream continuously, marker shows level)
 *  - normal: the visible window re-anchors on every qualifying edge
 *  - single: captures ONE qualifying edge then disarms (one-shot/glitch) */
export interface ScopeTrigger {
  mode: 'auto' | 'normal' | 'single';
  source: number;          // index into the channel list
  edge: 'rising' | 'falling';
  level: number;           // threshold in volts at the source channel input
  armed: boolean;
  /** holdoff in seconds — edges within this window after a trigger are ignored */
  holdoff?: number;
}

/** A detected trigger event (edge crossing of the source channel). */
export interface TriggerEvent {
  time: number;
  edge: 'rising' | 'falling';
  /** sample index of the crossing */
  index: number;
}

/**
 * Scan samples for threshold crossings on the trigger source (real
 * acquisition: normal/single modes re-anchor the display window here).
 * Coupling-adjusted samples should be passed (AC mean already removed).
 * Returns crossing events in time order; holdoff suppresses re-triggers.
 */
export function findTriggerEvents(
  samples: ScopeSample[],
  level: number,
  edge: 'rising' | 'falling',
  holdoff = 0,
): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  let lastT = -Infinity;
  for (let i = 1; i < samples.length; i++) {
    const v0 = samples[i - 1].voltage;
    const v1 = samples[i].voltage;
    const rising = v0 < level && v1 >= level;
    const falling = v0 > level && v1 <= level;
    const hit = edge === 'rising' ? rising : falling;
    if (!hit) continue;
    const t0 = samples[i - 1].time;
    const t1 = samples[i].time;
    const frac = (level - v0) / (v1 - v0);
    const t = t0 + frac * (t1 - t0);
    if (t - lastT < holdoff) continue;
    lastT = t;
    events.push({ time: t, edge, index: i });
  }
  return events;
}

/**
 * Resolve the display anchor for normal/single trigger modes: the latest
 * qualifying edge at or before `now` (single mode additionally requires
 * `armed` — disarmed single shows the frozen capture time).
 */
export function resolveTriggerAnchor(
  samples: ScopeSample[],
  trigger: ScopeTrigger,
  now: number,
  frozenAt?: number,
): number {
  if (trigger.mode === 'auto') return now;
  if (trigger.mode === 'single' && !trigger.armed) return frozenAt ?? now;
  const coupled = samples; // caller passes coupling-adjusted samples
  const events = findTriggerEvents(coupled, trigger.level, trigger.edge, trigger.holdoff ?? 0);
  let anchor = frozenAt ?? -Infinity;
  for (const e of events) {
    if (e.time <= now && e.time > anchor) anchor = e.time;
  }
  return anchor === -Infinity ? now : anchor;
}

export interface ScopeMeasurement { name: string; value: number; unit: string; formatted: string; }

export interface ScopeConfig {
  timebase: number;        // seconds per horizontal division
  timeOffset: number;      // reserved: horizontal position knob (s)
  channels: ScopeChannel[];
  cursorA: ScopeCursor;
  cursorB: ScopeCursor;
  trigger: ScopeTrigger;
  maxSamples: number;      // cap on samples rendered per channel
  showGrid: boolean;
  showMeasurements: boolean;
}

// ─── Grid geometry ─────────────────────────────────────────────────────────
// A standard scope screen is 10 divisions wide (time) and 8 divisions tall
// (voltage). All div-based rendering derives its scale from these constants.
export const SCOPE_H_DIVS = 10;
export const SCOPE_V_DIVS = 8;

export interface ScopeTimeWindow { tStart: number; tEnd: number; }
export interface ScopeVoltageWindow { vTop: number; vBottom: number; }

// ─── Measurements ──────────────────────────────────────────────────────────

export function computeMeasurements(samples: ScopeSample[]): ScopeMeasurement[] {
  if (samples.length < 1) return [];
  let vMax = -Infinity, vMin = Infinity, vSum = 0, vSumSq = 0;
  for (const s of samples) {
    vMax = Math.max(vMax, s.voltage);
    vMin = Math.min(vMin, s.voltage);
    vSum += s.voltage;
    vSumSq += s.voltage * s.voltage;
  }
  const vAvg = vSum / samples.length;
  // True RMS = sqrt(mean(v²)). (The previous version computed sqrt(mean − avg²)
  // from the plain sum, which is neither RMS nor variance.)
  const vRms = Math.sqrt(vSumSq / samples.length);
  const vPp = vMax - vMin;
  return [
    { name: 'Vmax', value: vMax, unit: 'V', formatted: vMax.toFixed(3) + ' V' },
    { name: 'Vmin', value: vMin, unit: 'V', formatted: vMin.toFixed(3) + ' V' },
    { name: 'Vpp', value: vPp, unit: 'V', formatted: vPp.toFixed(3) + ' V' },
    { name: 'Vavg', value: vAvg, unit: 'V', formatted: vAvg.toFixed(3) + ' V' },
    { name: 'Vrms', value: vRms, unit: 'V', formatted: vRms.toFixed(3) + ' V' },
  ];
}

export function getVoltageAtTime(samples: ScopeSample[], time: number): number | null {
  if (samples.length === 0) return null;
  if (time <= samples[0].time) return samples[0].voltage;
  if (time >= samples[samples.length - 1].time) return samples[samples.length - 1].voltage;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].time >= time) {
      const prev = samples[i - 1], curr = samples[i];
      const frac = (time - prev.time) / (curr.time - prev.time);
      return prev.voltage + frac * (curr.voltage - prev.voltage);
    }
  }
  return null;
}

/** Arithmetic mean of the sample voltages (AC coupling / trigger display). */
export function meanVoltage(samples: ScopeSample[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s.voltage;
  return sum / samples.length;
}

// ─── Probe loading ─────────────────────────────────────────────────────────
// Real probes load the circuit: 1× = 1 MΩ ‖ ~100 pF, 10× = 10 MΩ ‖ ~15 pF.
// The simulator's probe is ideal (1 TΩ); these helpers model what a REAL
// probe would read so high-impedance circuits can be sanity-checked.

export interface ProbeModel {
  /** label shown in the UI */
  label: string;
  /** shunt resistance to ground (Ω) */
  rIn: number;
  /** shunt capacitance to ground (F) */
  cIn: number;
  /** voltage division of the probe (1 or 10) */
  attenuation: 1 | 10;
}

export const PROBE_MODELS: ProbeModel[] = [
  { label: 'Ideal (simulator)', rIn: 1e12, cIn: 0, attenuation: 1 },
  { label: '1× (1 MΩ ‖ 100 pF)', rIn: 1e6, cIn: 100e-12, attenuation: 1 },
  { label: '10× (10 MΩ ‖ 15 pF)', rIn: 10e6, cIn: 15e-12, attenuation: 10 },
];

/** -3 dB bandwidth of a probe loaded by a source resistance (Hz). */
export function probeBandwidth(rSource: number, probe: ProbeModel): number {
  const rEq = (rSource * probe.rIn) / Math.max(rSource + probe.rIn, 1e-12);
  if (probe.cIn <= 0) return Infinity;
  return 1 / (2 * Math.PI * rEq * probe.cIn);
}

/** DC loading error: fraction of the true voltage a real probe reads. */
export function probeDcGain(rSource: number, probe: ProbeModel): number {
  return probe.rIn / (rSource + probe.rIn);
}

// ─── Cursor-interval math ──────────────────────────────────────────────────
// Statistics over the samples strictly between two cursor times (A–B):
// AVG / RMS / PP / min / max plus trapezoidal integral and mean derivative.

export interface CursorIntervalStats {
  count: number;
  vMin: number;
  vMax: number;
  vPp: number;
  vAvg: number;
  vRms: number;
  /** trapezoidal ∫v dt over the interval (V·s) */
  integral: number;
  /** mean dV/dt over the interval (V/s) */
  meanSlope: number;
}

export function cursorIntervalStats(samples: ScopeSample[], timeA: number, timeB: number): CursorIntervalStats | null {
  const lo = Math.min(timeA, timeB);
  const hi = Math.max(timeA, timeB);
  const pts = samples.filter((s) => s.time >= lo && s.time <= hi);
  if (pts.length === 0) return null;
  let vMin = Infinity, vMax = -Infinity, sum = 0, sumSq = 0, integral = 0;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i].voltage;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
    sum += v;
    sumSq += v * v;
    if (i > 0) {
      const dt = pts[i].time - pts[i - 1].time;
      integral += 0.5 * (v + pts[i - 1].voltage) * dt;
    }
  }
  const span = pts.length > 1 ? pts[pts.length - 1].time - pts[0].time : 0;
  return {
    count: pts.length,
    vMin,
    vMax,
    vPp: vMax - vMin,
    vAvg: sum / pts.length,
    vRms: Math.sqrt(sumSq / pts.length),
    integral,
    meanSlope: span > 0 ? (pts[pts.length - 1].voltage - pts[0].voltage) / span : 0,
  };
}

// ─── Coupling ──────────────────────────────────────────────────────────────

/** Apply input coupling. AC removes the DC component (mean) of the captured
 *  window, exactly like an AC-coupled scope input. Returns the same array
 *  reference for DC/empty so hot paths avoid allocation. */
export function applyCoupling(samples: ScopeSample[], coupling: 'DC' | 'AC'): ScopeSample[] {
  if (coupling !== 'AC' || samples.length === 0) return samples;
  const mean = meanVoltage(samples);
  return samples.map((s) => ({ time: s.time, voltage: s.voltage - mean }));
}

// ─── Div-based windows and pixel mapping ───────────────────────────────────

/** X window: ±5 divisions of `timebase` around `centerTime` (the scope shows
 *  the trigger point / newest sample at screen center by convention). */
export function computeTimeWindow(timebase: number, centerTime: number): ScopeTimeWindow {
  const half = (SCOPE_H_DIVS / 2) * timebase;
  return { tStart: centerTime - half, tEnd: centerTime + half };
}

/** Y window for one channel: ±4 divisions of `voltageScale` around the
 *  channel's `voltageOffset` (the voltage pinned to the vertical center). */
export function computeVoltageWindow(voltageScale: number, offset: number): ScopeVoltageWindow {
  const half = (SCOPE_V_DIVS / 2) * voltageScale;
  return { vTop: offset + half, vBottom: offset - half };
}

/** Map a timestamp to a pixel x within the grid rect [x, x+width]. */
export function mapTimeToX(time: number, win: ScopeTimeWindow, x: number, width: number): number {
  const span = win.tEnd - win.tStart;
  return x + ((time - win.tStart) / span) * width;
}

/** Map a pixel x back to a timestamp (inverse of mapTimeToX). */
export function mapXToTime(px: number, win: ScopeTimeWindow, x: number, width: number): number {
  const span = win.tEnd - win.tStart;
  return win.tStart + ((px - x) / width) * span;
}

/** Map a voltage to a pixel y within the grid rect [y, y+height].
 *  vTop lands on the top edge, vBottom on the bottom edge. */
export function mapVoltageToY(voltage: number, win: ScopeVoltageWindow, y: number, height: number): number {
  const span = win.vTop - win.vBottom;
  return y + (1 - (voltage - win.vBottom) / span) * height;
}

// ─── Preset stepping (1-2-5 ladders) ───────────────────────────────────────

/** Step through an ascending preset ladder (e.g. TIMEBASE_PRESETS).
 *  +1 = next coarser preset, −1 = next finer preset; clamps at the ends.
 *  A `current` value that is not on the ladder snaps to the adjacent preset
 *  in the requested direction. */
export function stepPreset(presets: readonly number[], current: number, direction: 1 | -1): number {
  if (presets.length === 0) return current;
  if (direction >= 0) {
    for (const p of presets) if (p > current) return p;
    return presets[presets.length - 1];
  }
  for (let i = presets.length - 1; i >= 0; i--) {
    if (presets[i] < current) return presets[i];
  }
  return presets[0];
}

/** Smallest V/div preset whose ±4-division window around `offset` covers
 *  [vMin, vMax]; clamps to the largest preset for huge signals. */
export function pickDefaultVoltageScale(vMin: number, vMax: number, offset = 0): number {
  const maxAbs = Math.max(Math.abs(vMin - offset), Math.abs(vMax - offset));
  const needed = maxAbs / (SCOPE_V_DIVS / 2);
  for (const p of VOLTAGE_SCALE_PRESETS) if (p >= needed) return p;
  return VOLTAGE_SCALE_PRESETS[VOLTAGE_SCALE_PRESETS.length - 1];
}

/** Grow-only re-fit: if an untouched channel's signal no longer fits in the
 *  current ±4-division window, bump the V/div up to cover it. Signals that
 *  shrank never shrink the scale, so a user's mental picture of the screen
 *  stays stable. */
export function refitVoltageScale(current: number, vMin: number, vMax: number, offset: number): number {
  const maxAbs = Math.max(Math.abs(vMin - offset), Math.abs(vMax - offset));
  if (maxAbs <= (SCOPE_V_DIVS / 2) * current) return current; // still fits
  for (const p of VOLTAGE_SCALE_PRESETS) {
    if (p >= maxAbs / (SCOPE_V_DIVS / 2)) return p;
  }
  return VOLTAGE_SCALE_PRESETS[VOLTAGE_SCALE_PRESETS.length - 1];
}

// ─── A/B cursor math ───────────────────────────────────────────────────────

export interface CursorDeltaResult { dt: number; freq: number | null; }

/** Δt between cursors (B − A, signed) and its reciprocal as a frequency
 *  estimate (1/|Δt|). freq is null when the cursors coincide. */
export function computeCursorDeltas(timeA: number, timeB: number): CursorDeltaResult {
  const dt = timeB - timeA;
  const adt = Math.abs(dt);
  return { dt, freq: adt > 0 ? 1 / adt : null };
}

// ─── Config factory ────────────────────────────────────────────────────────

export function createDefaultScopeConfig(): ScopeConfig {
  return {
    timebase: 1e-3,
    timeOffset: 0,
    channels: [],
    cursorA: { enabled: false, time: 0, channel: -1 },
    cursorB: { enabled: false, time: 0, channel: -1 },
    trigger: { mode: 'auto', source: 0, edge: 'rising', level: 0, armed: true },
    maxSamples: 5000,
    showGrid: true,
    showMeasurements: true,
  };
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function formatTimebase(secondsPerDiv: number): string {
  if (secondsPerDiv >= 1e-3) return (secondsPerDiv * 1e3).toFixed(2) + ' ms/div';
  if (secondsPerDiv >= 1e-6) return (secondsPerDiv * 1e6).toFixed(2) + ' µs/div';
  return (secondsPerDiv * 1e9).toFixed(2) + ' ns/div';
}

export function formatVoltageScale(voltsPerDiv: number): string {
  if (voltsPerDiv >= 1) return voltsPerDiv.toFixed(2) + ' V/div';
  return (voltsPerDiv * 1e3).toFixed(2) + ' mV/div';
}

/** Compact duration for cursor / Δt readouts (auto s/ms/µs/ns). */
export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs === 0) return '0.000 s';
  if (abs >= 1) return seconds.toFixed(3) + ' s';
  if (abs >= 1e-3) return (seconds * 1e3).toFixed(3) + ' ms';
  if (abs >= 1e-6) return (seconds * 1e6).toFixed(3) + ' µs';
  return (seconds * 1e9).toFixed(3) + ' ns';
}

/** Compact frequency for 1/Δt readouts (auto Hz/kHz/MHz/GHz). */
export function formatFrequency(hz: number): string {
  if (hz >= 1e9) return (hz / 1e9).toFixed(3) + ' GHz';
  if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz';
  if (hz >= 1e3) return (hz / 1e3).toFixed(3) + ' kHz';
  return hz.toFixed(3) + ' Hz';
}

/** Compact voltage for offset / cursor readouts (auto V/mV). */
export function formatVoltage(volts: number): string {
  const abs = Math.abs(volts);
  if (abs >= 1) return volts.toFixed(3) + ' V';
  if (abs === 0) return '0.000 V';
  return (volts * 1e3).toFixed(3) + ' mV';
}

export const TIMEBASE_PRESETS: number[] = [1e-9, 2e-9, 5e-9, 1e-8, 2e-8, 5e-8, 1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 1e-1, 2e-1, 5e-1, 1, 2, 5];
export const VOLTAGE_SCALE_PRESETS: number[] = [1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 1e-1, 2e-1, 5e-1, 1, 2, 5, 10, 20, 50];
