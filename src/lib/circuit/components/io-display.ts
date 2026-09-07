// Human-IO / display / wireless components: EC11 rotary encoder, WS2812B
// addressable RGB LED (NeoPixel), discrete common-cathode RGB LED, active
// electromagnetic buzzer, electret condenser microphone, LCD1602 with I2C
// backpack, SSD1306 OLED, nRF24L01+ 2.4 GHz transceiver, ESP32 DevKitC.
//
// Conventions shared with hall-sensors.ts / p3-components.ts / p3-logic.ts:
//   - Digital outputs are 100 Ω Thevenin sources (conductance + current
//     source referenced to the part's own GND pin) — load-safe, no extra MNA
//     unknown, and skipped entirely when the pin maps to node 0 so an
//     unwired output can never leave a singular row.
//   - Supply-dependent levels read the rail from the PREVIOUS iterate
//     (sim.nodeVoltage) with the nominal parameter as the unwired-pin
//     fallback (op-amp macromodel convention) — solveDC's Newton loop
//     converges in 2-3 passes.
//   - Load currents derived only from parameters are stamped as fixed
//     current sources (idempotent under re-stamps by construction);
//     load currents specified "at the nominal rail" are stamped as
//     conductances G = I_nom / V_nom between the power pins (current scales
//     with the actual rail, like a resistive load).
//   - MULTI-STAMP SAFETY: no decision below depends on a voltage its own
//     stamp influences except through previous-iterate reads (rgbLed channel
//     conduction, electret FET region, ws2812b DOUT level, esp32 LDO region)
//     — the same fixed-point pattern as the diode/led/op-amp plugins.
//
// Stateful prefixes used in sim.state.__global (comp-id keyed via stateKey):
//   - 'rgbled' — per-channel conduction hysteresis for rgbLed (the diode/
//     led plugin pattern). Needs adding to memory.ts COMP_ID_STATE_PREFIXES
//     so deleting a component frees its entry (see worklog).
// Everything else in this file is stateless (behavior is a pure function of
// parameters + prev-iterate node voltages); the buzzer / rgbLed also stash
// display-only readouts in instance.simState from step() (sevenSegment
// pattern — top-level per-component namespace, engine-managed).

import type { ComponentPlugin, ComponentCategory, MnaSystem, SimContext } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';

// 'sensor' is not in the ComponentCategory union (widening it would touch
// types.ts). Every runtime consumer treats categories as arbitrary strings
// with fallbacks (registry ordering `categoryOrder[x] ?? 99`, palette
// label/icon `?? raw`) and tests/comprehensive-extra.test.ts whitelists it,
// so the cast is safe — same as hall-sensors.ts. Used here for the two
// human/world-input parts (rotaryEncoder, electretMic); displays, the
// buzzer and the LEDs use the existing 'io' category (led/speaker/
// sevenSegment/live there), the radio module 'ic', the dev board 'mcu'.
const SENSOR = 'sensor' as ComponentCategory;

/** Node id of a terminal (unwired pins map to node 0 = ground). */
function pinOf(terminals: { terminalId: string; nodeId: number }[], id: string): number {
  return terminals.find(t => t.terminalId === id)?.nodeId ?? 0;
}

/** Pin voltage (node 0 / unwired pins read 0 V). */
function v(sim: SimContext, node: number): number {
  return sim.nodeVoltage[node] ?? 0;
}

/** Power-pin leaks keep wired-but-otherwise-idle nets solvable (hall pattern). */
function powerLeaks(sys: MnaSystem, vcc: number, gnd: number): void {
  if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
  if (gnd !== 0) sys.stampConductance(gnd, 0, 1e-13);
}

/**
 * Thevenin output stage: holds `volts` above the `ref` node through r ohms
 * (conductance 1/r + Norton current volts/r pushed into the pin). `pin`
 * must not be node 0 — callers skip unwired outputs.
 */
function stampThevenin(sys: MnaSystem, pin: number, ref: number, volts: number, r: number): void {
  const rr = Math.max(0.001, r);
  sys.stampConductance(pin, ref, 1 / rr);
  sys.stampCurrentSource(ref, pin, volts / rr);
}

/** Weak 1e-9 S pin leak to `gnd` (open-drain bus / high-Z input pin). */
function pinLeak(sys: MnaSystem, pin: number, gnd: number): void {
  if (pin !== 0 && pin !== gnd) sys.stampConductance(pin, gnd, 1e-9);
}

const ROUT = 100; // push-pull digital output resistance (Ω)

// ─────────────────────────────────────────────────────────────────────────────
// EC11 rotary encoder — quadrature A/B + push-button SW
// ─────────────────────────────────────────────────────────────────────────────

// The knob position is a parameter (the "input" — no mechanical solver).
// `position` counts quadrature states; state = position mod 4 gives the
// gray-code sequence 00 → 10 → 11 → 01 (A leads B for increasing position):
//   state: 0 → A=0 B=0, 1 → A=1 B=0, 2 → A=1 B=1, 3 → A=0 B=1
// With the detented EC11 one mechanical detent = 4 state transitions (a full
// quadrature cycle), so detent # = floor(position / 4) when detents = true —
// the `detents` flag only changes that readout, never the electrical state.
// A/B are push-pull outputs (100 Ω Thevenin at the supply level), SW is a
// push-to-ground contact (100 Ω when pressed, 1e-9 S leakage when released —
// the switch plugin pattern). Supply draw 1 mA (fixed current source).
// STATELESS: everything is a pure function of parameters.
export const rotaryEncoder: ComponentPlugin = {
  type: 'rotaryEncoder',
  name: 'Rotary Encoder (EC11)',
  category: SENSOR,
  description: 'EC11-style incremental rotary encoder with quadrature A/B outputs and a push-to-ground switch. Set the position parameter (quadrature counts); state = position mod 4 gives gray code 00→10→11→01. Detented EC11: 4 counts per detent.',
  symbol: 'ENC',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    { id: 'sw', label: 'SW', position: { x: 0, y: 2 }, electricalType: 'passive' as const },
    { id: 'a', label: 'A', position: { x: 4, y: 1 }, electricalType: 'output' as const },
    { id: 'b', label: 'B', position: { x: 4, y: 3 }, electricalType: 'output' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 3.3, unit: 'V', min: 1.8, max: 5.5, step: 0.1 },
    { key: 'position', label: 'Position (quadrature counts)', type: 'number', default: 0, min: -10000, max: 10000, step: 1 },
    { key: 'detents', label: 'Detented (4 counts/detent)', type: 'boolean', default: true },
    { key: 'pressed', label: 'SW Pressed', type: 'boolean', default: false },
  ],
  keywords: ['encoder', 'rotary', 'ec11', 'quadrature', 'knob', 'input', 'human', 'gray', 'code'],
  datasheet: 'https://www.alpsalpine.com/e/vn/html/encoder/ec11/index.html',
  render(ctx, params, cellSize) {
    const pos = (params.position as number) ?? 0;
    const state = ((Math.round(pos) % 4) + 4) % 4;
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // leads: vcc (top), gnd (bottom), sw (left), a/b (right)
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, 0.8 * cellSize); ctx.lineTo(2 * cellSize, 0);
    ctx.moveTo(2 * cellSize, 3.2 * cellSize); ctx.lineTo(2 * cellSize, 4 * cellSize);
    ctx.moveTo(0.8 * cellSize, 2 * cellSize); ctx.lineTo(0, 2 * cellSize);
    ctx.moveTo(3.2 * cellSize, 1 * cellSize); ctx.lineTo(4 * cellSize, 1 * cellSize);
    ctx.moveTo(3.2 * cellSize, 3 * cellSize); ctx.lineTo(4 * cellSize, 3 * cellSize);
    ctx.stroke();
    // body
    ctx.beginPath();
    ctx.rect(0.8 * cellSize, 0.8 * cellSize, 2.4 * cellSize, 2.4 * cellSize);
    ctx.stroke();
    // knob with indicator line rotated by the quadrature state (225° + 90°·state)
    const cx = 2 * cellSize, cy = 2 * cellSize, r = 0.9 * cellSize;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.stroke();
    const ang = (-135 + state * 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx + 0.2 * r * Math.cos(ang), cy + 0.2 * r * Math.sin(ang));
    ctx.lineTo(cx + 0.9 * r * Math.cos(ang), cy + 0.9 * r * Math.sin(ang));
    ctx.strokeStyle = '#e2e8f0';
    ctx.stroke();
    drawLabel(ctx, 'EC11', 2 * cellSize, 3.62 * cellSize, '#64748b');
    drawLabel(ctx, 'VCC', 2.6 * cellSize, 0.3 * cellSize, '#64748b');
    drawLabel(ctx, 'GND', 2.6 * cellSize, 3.7 * cellSize, '#64748b');
    drawLabel(ctx, 'SW', 0.4 * cellSize, 1.6 * cellSize, '#64748b');
    drawLabel(ctx, 'A', 3.6 * cellSize, 0.65 * cellSize, '#64748b');
    drawLabel(ctx, 'B', 3.6 * cellSize, 2.65 * cellSize, '#64748b');
  },
  stamp(params, terminals, sys, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const a = pinOf(terminals, 'a');
    const b = pinOf(terminals, 'b');
    const sw = pinOf(terminals, 'sw');
    const vccNom = (params.vcc as number) ?? 3.3;
    // Actual supply (previous iterate, param fallback for an unwired pin).
    const vccActual = vcc > 0 ? Math.max(0, v(sim, vcc)) : vccNom;
    powerLeaks(sys, vcc, gnd);
    // Supply current: fixed 1 mA (parameter-only → idempotent).
    if (vcc !== 0 && vcc !== gnd) sys.stampCurrentSource(vcc, gnd, 0.001);
    // Quadrature gray code from the position parameter.
    const state = ((Math.round(params.position as number) % 4) + 4) % 4;
    const aHigh = state === 1 || state === 2;
    const bHigh = state === 2 || state === 3;
    if (a !== 0) stampThevenin(sys, a, gnd, aHigh ? vccActual : 0, ROUT);
    if (b !== 0) stampThevenin(sys, b, gnd, bHigh ? vccActual : 0, ROUT);
    // SW: push-to-ground contact (switch plugin pattern).
    if (sw !== 0 && sw !== gnd) {
      sys.stampConductance(sw, gnd, params.pressed ? 1 / ROUT : 1e-9);
    }
  },
  getFlowPath() { return [{ x: 2, y: 0 }, { x: 2, y: 4 }]; },
  measure(params, terminals, sim) {
    const a = pinOf(terminals, 'a');
    const b = pinOf(terminals, 'b');
    const pos = Math.round(params.position as number);
    const state = ((pos % 4) + 4) % 4;
    const rows = [
      { label: 'Pos', value: String(pos), unit: '' },
      { label: 'State', value: String(state), unit: '' },
      { label: 'A', value: v(sim, a).toFixed(3), unit: 'V' },
      { label: 'B', value: v(sim, b).toFixed(3), unit: 'V' },
      { label: 'SW', value: params.pressed ? 'PRESSED' : 'OPEN', unit: '' },
    ];
    if (params.detents) rows.push({ label: 'Detent', value: String(Math.floor(pos / 4)), unit: '' });
    return rows;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// WS2812B — addressable RGB LED (NeoPixel)
// ─────────────────────────────────────────────────────────────────────────────

// Three independent current sinks VCC→GND, one per color channel:
//   I_ch = ledCurrent_mA/1000 · (ch/255) · brightness
// The currents come from parameters only, so the stamps are idempotent under
// solveDC's re-stamps. DIN is a high-Z logic input (1e-9 S); DOUT is a
// push-pull 100 Ω repeater whose level is decided from the PREVIOUS-iterate
// DIN voltage (threshold 1.65 V) — the level never feeds back into DIN, so
// the fixed point converges in one extra pass. The repeated logic level is
// the supply rail (5 V part, 3.3 V-compatible input threshold).
export const ws2812b: ComponentPlugin = {
  type: 'ws2812b',
  name: 'WS2812B (Addressable RGB LED)',
  category: 'io',
  description: 'Addressable RGB LED (NeoPixel). Each color channel is a current sink: I = ledCurrent·(value/255)·brightness. DIN is a high-Z input; DOUT repeats the data signal at the supply level for daisy-chaining (100Ω push-pull).',
  symbol: 'RGB',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    { id: 'din', label: 'DIN', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'dout', label: 'DOUT', position: { x: 4, y: 1 }, electricalType: 'output' as const },
  ],
  parameters: [
    { key: 'red', label: 'Red (0-255)', type: 'number', default: 0, min: 0, max: 255, step: 1 },
    { key: 'green', label: 'Green (0-255)', type: 'number', default: 0, min: 0, max: 255, step: 1 },
    { key: 'blue', label: 'Blue (0-255)', type: 'number', default: 0, min: 0, max: 255, step: 1 },
    { key: 'brightness', label: 'Brightness (0-1)', type: 'number', default: 1, min: 0, max: 1, step: 0.05 },
    { key: 'ledCurrent_mA', label: 'Full-scale LED Current (mA)', type: 'number', default: 20, unit: 'mA', min: 1, max: 50, step: 1 },
  ],
  keywords: ['ws2812', 'neopixel', 'addressable', 'rgb', 'led', 'smart', 'led', 'pixel', 'display'],
  datasheet: 'https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf',
  render(ctx, params, cellSize, sim, instance) {
    const r = Math.min(255, Math.max(0, params.red as number));
    const g = Math.min(255, Math.max(0, params.green as number));
    const b = Math.min(255, Math.max(0, params.blue as number));
    const bri = Math.min(1, Math.max(0, (params.brightness as number) ?? 1));
    const hex = (x: number) => Math.round(x).toString(16).padStart(2, '0');
    const color = `#${hex(r)}${hex(g)}${hex(b)}`;
    // glow intensity: mixed channel magnitude × brightness (led plugin pattern)
    const mix = Math.max(r, g, b) / 255;
    const brightness = sim != null && instance != null ? bri * mix : 0;
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // leads
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, 0.7 * cellSize); ctx.lineTo(2 * cellSize, 0);
    ctx.moveTo(2 * cellSize, 3.3 * cellSize); ctx.lineTo(2 * cellSize, 4 * cellSize);
    ctx.moveTo(0, 1 * cellSize); ctx.lineTo(1.1 * cellSize, 1 * cellSize);
    ctx.moveTo(2.9 * cellSize, 1 * cellSize); ctx.lineTo(4 * cellSize, 1 * cellSize);
    ctx.stroke();
    // glow behind the package
    if (brightness > 0.01) {
      ctx.save();
      const glowRadius = cellSize * (1.2 + brightness * 1.6);
      const gradient = ctx.createRadialGradient(2 * cellSize, 2 * cellSize, 2, 2 * cellSize, 2 * cellSize, glowRadius);
      const alphaInner = Math.round(brightness * 0xcc).toString(16).padStart(2, '0');
      const alphaMid = Math.round(brightness * 0x44).toString(16).padStart(2, '0');
      gradient.addColorStop(0, color + alphaInner);
      gradient.addColorStop(0.5, color + alphaMid);
      gradient.addColorStop(1, color + '00');
      ctx.fillStyle = gradient;
      ctx.fillRect(2 * cellSize - glowRadius, 2 * cellSize - glowRadius, glowRadius * 2, glowRadius * 2);
      ctx.restore();
    }
    // 5050 package: white square with notch
    ctx.beginPath();
    ctx.rect(1.1 * cellSize, 1.1 * cellSize, 1.8 * cellSize, 1.8 * cellSize);
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.arc(1.35 * cellSize, 1.35 * cellSize, 2.5, 0, Math.PI * 2);
    ctx.fill();
    // data path arrows din → package → dout
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.4;
    for (const [x1, x2] of [[0.25, 0.75], [3.25, 3.75]] as [number, number][]) {
      const y = 1 * cellSize;
      ctx.beginPath();
      ctx.moveTo(x1 * cellSize, y);
      ctx.lineTo(x2 * cellSize, y);
      ctx.moveTo((x2 - 0.15) * cellSize, y - 4);
      ctx.lineTo(x2 * cellSize, y);
      ctx.lineTo((x2 - 0.15) * cellSize, y + 4);
      ctx.stroke();
    }
    drawLabel(ctx, 'WS2812B', 2 * cellSize, 2.05 * cellSize, '#334155');
    drawLabel(ctx, 'VCC', 2.6 * cellSize, 0.3 * cellSize, '#64748b');
    drawLabel(ctx, 'GND', 2.6 * cellSize, 3.7 * cellSize, '#64748b');
    drawLabel(ctx, 'DIN', 0.5 * cellSize, 0.6 * cellSize, '#64748b');
    drawLabel(ctx, 'DOUT', 3.5 * cellSize, 0.6 * cellSize, '#64748b');
  },
  stamp(params, terminals, sys, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const din = pinOf(terminals, 'din');
    const dout = pinOf(terminals, 'dout');
    powerLeaks(sys, vcc, gnd);
    // Per-channel current sinks VCC→GND (fixed currents from parameters).
    const full = ((params.ledCurrent_mA as number) ?? 20) / 1000;
    const bri = Math.min(1, Math.max(0, (params.brightness as number) ?? 1));
    if (vcc !== 0 && vcc !== gnd) {
      const clamp255 = (x: number) => Math.min(255, Math.max(0, x));
      sys.stampCurrentSource(vcc, gnd, full * (clamp255(params.red as number) / 255) * bri);
      sys.stampCurrentSource(vcc, gnd, full * (clamp255(params.green as number) / 255) * bri);
      sys.stampCurrentSource(vcc, gnd, full * (clamp255(params.blue as number) / 255) * bri);
    }
    // DIN: high-Z logic input (1e-9 S leak).
    pinLeak(sys, din, gnd);
    // DOUT: push-pull repeater, level from the previous-iterate DIN voltage.
    if (dout !== 0) {
      const vccActual = vcc > 0 ? Math.max(0, v(sim, vcc)) : 5; // 5 V part
      const hi = v(sim, din) > 1.65; // 3.3 V-compatible input threshold
      stampThevenin(sys, dout, gnd, hi ? vccActual : 0, ROUT);
    }
  },
  getFlowPath() { return [{ x: 2, y: 0 }, { x: 2, y: 4 }]; },
  measure(params, terminals, sim) {
    const clamp255 = (x: number) => Math.min(255, Math.max(0, x));
    const r = clamp255(params.red as number);
    const g = clamp255(params.green as number);
    const b = clamp255(params.blue as number);
    const bri = Math.min(1, Math.max(0, (params.brightness as number) ?? 1));
    const full = ((params.ledCurrent_mA as number) ?? 20) * bri;
    const iR = full * r / 255, iG = full * g / 255, iB = full * b / 255;
    const hex = (x: number) => Math.round(x).toString(16).padStart(2, '0');
    return [
      { label: 'R', value: String(Math.round(r)), unit: '' },
      { label: 'G', value: String(Math.round(g)), unit: '' },
      { label: 'B', value: String(Math.round(b)), unit: '' },
      { label: 'I R', value: iR.toFixed(2), unit: 'mA' },
      { label: 'I G', value: iG.toFixed(2), unit: 'mA' },
      { label: 'I B', value: iB.toFixed(2), unit: 'mA' },
      { label: 'Itotal', value: (iR + iG + iB).toFixed(2), unit: 'mA' },
      { label: 'Color', value: `#${hex(r * bri)}${hex(g * bri)}${hex(b * bri)}`, unit: '' },
      { label: 'VCC', value: v(sim, pinOf(terminals, 'vcc')).toFixed(3), unit: 'V' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// rgbLed — discrete common-cathode RGB LED
// ─────────────────────────────────────────────────────────────────────────────

// Three real diodes sharing one cathode: each anode→kathode channel uses the
// diode plugin's threshold stamp (hysteresis band vf−0.1 V … vf) in series
// with rs, i.e. ON = Thevenin Vf @ rs, OFF = 1e-13 S leakage. The Vf
// defaults follow the LED physics: ~2.0 V red, ~3.0 V green/blue InGaN at
// 20 mA. Channel conduction state (hysteresis) lives in __global under
// stateKey('rgbled', comp) — the exact led/diode plugin convention — so it
// survives node renumbering and repeated Newton re-stamps can't oscillate.
export const rgbLed: ComponentPlugin = {
  type: 'rgbLed',
  name: 'RGB LED (Common Cathode)',
  category: 'io',
  description: 'Discrete common-cathode RGB LED modeled as three real diodes sharing one cathode: Vf ≈ 2.0 V red / 3.0 V green / 3.0 V blue with per-channel series resistance. The cathode carries the sum of the conducting channel currents.',
  symbol: 'RGB',
  boundingBox: { width: 4, height: 6 },
  terminals: [
    { id: 'r', label: 'R', position: { x: 0, y: 1 }, electricalType: 'passive' as const },
    { id: 'g', label: 'G', position: { x: 0, y: 3 }, electricalType: 'passive' as const },
    { id: 'b', label: 'B', position: { x: 0, y: 5 }, electricalType: 'passive' as const },
    { id: 'k', label: 'K', position: { x: 4, y: 3 }, electricalType: 'passive' as const },
  ],
  parameters: [
    { key: 'vfR', label: 'Red Vf (V)', type: 'number', default: 2.0, unit: 'V', min: 1.2, max: 4, step: 0.05 },
    { key: 'vfG', label: 'Green Vf (V)', type: 'number', default: 3.0, unit: 'V', min: 1.2, max: 4, step: 0.05 },
    { key: 'vfB', label: 'Blue Vf (V)', type: 'number', default: 3.0, unit: 'V', min: 1.2, max: 4, step: 0.05 },
    // NOTE: 22 Ω is the *internal* channel resistance only — the test and
    // typical circuits add an EXTERNAL 220 Ω series resistor, so the total
    // is 242 Ω → (5−2)/242 ≈ 12.4mA (safe). Do NOT raise this default: it
    // would double-count the external resistor and break the current tests.
    // A bare LED wired straight to 5V still needs an external resistor.
    { key: 'rs', label: 'Channel Series R (Ω)', type: 'number', default: 22, unit: 'Ω', min: 0.1, max: 1000, step: 1 },
  ],
  keywords: ['rgb', 'led', 'full', 'color', 'common', 'cathode', 'display', 'light'],
  render(ctx, params, cellSize, sim, instance) {
    const st = (instance?.simState?.__rgb ?? {}) as { ir?: number; ig?: number; ib?: number };
    const bri = (i: number | undefined) =>
      sim != null && instance != null && (i ?? 0) > 0.0001 ? Math.min(1, (i ?? 0) / 0.02) : 0;
    const channels: { id: string; y: number; color: string; i: number | undefined }[] = [
      { id: 'R', y: 1, color: '#ef4444', i: st.ir },
      { id: 'G', y: 3, color: '#22c55e', i: st.ig },
      { id: 'B', y: 5, color: '#3b82f6', i: st.ib },
    ];
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // anode leads + cathode lead
    ctx.beginPath();
    for (const ch of channels) {
      ctx.moveTo(0, ch.y * cellSize); ctx.lineTo(1.2 * cellSize, ch.y * cellSize);
    }
    ctx.moveTo(2.8 * cellSize, 3 * cellSize); ctx.lineTo(4 * cellSize, 3 * cellSize);
    ctx.stroke();
    // body
    ctx.beginPath();
    ctx.rect(1.2 * cellSize, 0.6 * cellSize, 1.6 * cellSize, 4.8 * cellSize);
    ctx.stroke();
    // per-channel diode triangle + light arrows, brightness ∝ channel current
    for (const ch of channels) {
      const y = ch.y * cellSize;
      const bb = bri(ch.i);
      if (bb > 0.01) {
        ctx.save();
        const gradient = ctx.createRadialGradient(2 * cellSize, y, 2, 2 * cellSize, y, cellSize * (1 + bb));
        const aIn = Math.round(bb * 0x88).toString(16).padStart(2, '0');
        gradient.addColorStop(0, ch.color + aIn);
        gradient.addColorStop(1, ch.color + '00');
        ctx.fillStyle = gradient;
        ctx.fillRect(2 * cellSize - cellSize * (1 + bb), y - cellSize * (1 + bb), cellSize * 2 * (1 + bb), cellSize * 2 * (1 + bb));
        ctx.restore();
      }
      ctx.beginPath();
      ctx.moveTo(1.2 * cellSize, y - 7);
      ctx.lineTo(1.2 * cellSize, y + 7);
      ctx.lineTo(2.2 * cellSize, y);
      ctx.closePath();
      const triA = Math.round(0x88 + bb * 0x77).toString(16).padStart(2, '0');
      ctx.fillStyle = ch.color + triA;
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = bb > 0.01 ? ch.color : '#94a3b8';
      ctx.lineWidth = 1.2 + bb * 1.2;
      ctx.beginPath();
      ctx.moveTo(2.4 * cellSize, y - 6);
      ctx.lineTo(2.9 * cellSize, y - 11);
      ctx.moveTo(2.9 * cellSize, y - 11);
      ctx.lineTo(2.6 * cellSize, y - 10.5);
      ctx.moveTo(2.9 * cellSize, y - 11);
      ctx.lineTo(2.85 * cellSize, y - 8);
      ctx.stroke();
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    }
    // common cathode bar
    ctx.beginPath();
    ctx.moveTo(2.4 * cellSize, 0.8 * cellSize); ctx.lineTo(2.4 * cellSize, 5.2 * cellSize);
    ctx.lineWidth = 2;
    ctx.stroke();
    drawLabel(ctx, 'RGB', 1.7 * cellSize, 3 * cellSize, '#64748b');
  },
  stamp(params, terminals, sys, sim, comp) {
    const k = pinOf(terminals, 'k');
    const rs = Math.max(0.1, (params.rs as number) ?? 22);
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('rgbled', comp, ...terminals.map(t => t.nodeId));
    const s = (st[key] ?? (st[key] = { r: false, g: false, b: false })) as Record<string, boolean>;
    for (const ch of ['r', 'g', 'b'] as const) {
      const a = pinOf(terminals, ch);
      const vf = (params[`vf${ch.toUpperCase()}` as 'vfR' | 'vfG' | 'vfB'] as number) ?? 3.0;
      const vd = v(sim, a) - v(sim, k); // previous iterate (fixed point)
      // threshold model with hysteresis (matches the diode/led plugins)
      const on = s[ch] ? vd > vf - 0.1 : vd > vf;
      s[ch] = on;
      if (a === 0 || a === k || k === 0) continue; // unwired pin → nothing to stamp
      if (on) {
        // Forward biased: Vf in series with rs (Thevenin → Norton).
        sys.stampConductance(a, k, 1 / rs);
        sys.stampCurrentSource(k, a, vf / rs);
      } else {
        // Reverse biased: leakage only.
        sys.stampConductance(a, k, 1e-13);
      }
    }
  },
  getFlowPath() { return [{ x: 0, y: 3 }, { x: 4, y: 3 }]; },
  step(params, terminals, sim, instance) {
    if (!instance.simState) instance.simState = {};
    const k = pinOf(terminals, 'k');
    const rs = Math.max(0.1, (params.rs as number) ?? 22);
    const st = (sim.state.__global ?? {}) as Record<string, Record<string, boolean>>;
    const s = st[stateKey('rgbled', instance, ...terminals.map(t => t.nodeId))] ?? { r: false, g: false, b: false };
    const cur: Record<string, number> = {};
    for (const ch of ['r', 'g', 'b'] as const) {
      const a = pinOf(terminals, ch);
      const vf = (params[`vf${ch.toUpperCase()}` as 'vfR' | 'vfG' | 'vfB'] as number) ?? 3.0;
      const vd = v(sim, a) - v(sim, k);
      cur[ch] = s[ch] ? Math.max(0, (vd - vf) / rs) : vd * 1e-13;
    }
    instance.simState.__rgb = { ir: cur.r, ig: cur.g, ib: cur.b };
  },
  measure(params, terminals, sim, comp) {
    const k = pinOf(terminals, 'k');
    const rs = Math.max(0.1, (params.rs as number) ?? 22);
    const st = (sim.state.__global ?? {}) as Record<string, Record<string, boolean>>;
    const s = st[stateKey('rgbled', comp, ...terminals.map(t => t.nodeId))] ?? { r: false, g: false, b: false };
    const rows: { label: string; value: string; unit?: string }[] = [];
    const cur: Record<string, number> = {};
    const vfOf: Record<string, number> = {};
    for (const ch of ['r', 'g', 'b'] as const) {
      const a = pinOf(terminals, ch);
      const vf = (params[`vf${ch.toUpperCase()}` as 'vfR' | 'vfG' | 'vfB'] as number) ?? 3.0;
      const vd = v(sim, a) - v(sim, k);
      const i = s[ch] ? Math.max(0, (vd - vf) / rs) : vd * 1e-13;
      cur[ch] = i; vfOf[ch] = i > 1e-9 ? vf : 0;
      rows.push({ label: `I ${ch.toUpperCase()}`, value: (i * 1000).toFixed(2), unit: 'mA' });
    }
    for (const ch of ['r', 'g', 'b'] as const) {
      rows.push({ label: `Vf ${ch.toUpperCase()}`, value: vfOf[ch].toFixed(2), unit: 'V' });
    }
    const maxI = Math.max(cur.r, cur.g, cur.b);
    const dominant = maxI < 1e-6 ? 'off' : cur.r === maxI ? 'red' : cur.g === maxI ? 'green' : 'blue';
    rows.push({ label: 'Dominant', value: dominant, unit: '' });
    const hex = (x: number) => Math.round(x).toString(16).padStart(2, '0');
    const mixR = maxI > 1e-6 ? Math.round(255 * cur.r / maxI) : 0;
    const mixG = maxI > 1e-6 ? Math.round(255 * cur.g / maxI) : 0;
    const mixB = maxI > 1e-6 ? Math.round(255 * cur.b / maxI) : 0;
    rows.push({ label: 'Color', value: `#${hex(mixR)}${hex(mixG)}${hex(mixB)}`, unit: '' });
    rows.push({ label: 'Ik', value: ((cur.r + cur.g + cur.b) * 1000).toFixed(2), unit: 'mA' });
    return rows;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Buzzer — active electromagnetic
// ─────────────────────────────────────────────────────────────────────────────

// The coil is a plain resistor: R = ratedVoltage / (current_mA/1000)
// (5 V / 30 mA ≈ 167 Ω) stamped pos↔neg — real current draw in both
// directions, stateless. "Active" (sound on) is a display/readout decision:
// V(pos)−V(neg) ≥ 0.8·ratedVoltage, computed in step() from the SOLVED
// voltages (the same post-solve read the sevenSegment/led plugins use for
// rendering state) and exposed through measure().
export const buzzer: ComponentPlugin = {
  type: 'buzzer',
  name: 'Buzzer (Active 5V)',
  category: 'io',
  description: 'Active electromagnetic buzzer. The coil is stamped as ratedVoltage/current (≈167 Ω at 5 V/30 mA) so it draws real current; it plays a real tone at its resonant frequency (enable sound with the speaker icon in the status bar) when the voltage across it reaches 80% of the rated voltage.',
  symbol: 'BZ',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'pos', label: '+', position: { x: 0, y: 1 }, electricalType: 'passive' as const },
    { id: 'neg', label: '−', position: { x: 4, y: 1 }, electricalType: 'passive' as const },
  ],
  parameters: [
    { key: 'ratedVoltage', label: 'Rated Voltage (V)', type: 'number', default: 5, unit: 'V', min: 1, max: 24, step: 0.5 },
    { key: 'frequency', label: 'Resonant Frequency (Hz)', type: 'number', default: 2300, unit: 'Hz', min: 100, max: 8000, step: 100 },
    { key: 'current_mA', label: 'Rated Current (mA)', type: 'number', default: 30, unit: 'mA', min: 1, max: 200, step: 1 },
  ],
  keywords: ['buzzer', 'beeper', 'sound', 'audio', 'alarm', 'active', 'electromagnetic', 'indicator'],
  render(ctx, params, cellSize, sim, instance) {
    const rated = (params.ratedVoltage as number) ?? 5;
    const bz = (instance?.simState?.__buzzer ?? {}) as { v?: number };
    const vAc = bz.v ?? 0;
    const isRunning = sim != null && instance != null;
    const active = isRunning && vAc >= 0.8 * rated;
    const activity = active ? Math.min(1, vAc / rated) : 0;
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.0 * cellSize, cellSize);
    ctx.moveTo(3.0 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    // cylindrical body
    ctx.beginPath();
    ctx.rect(1.0 * cellSize, 0.25 * cellSize, 2.0 * cellSize, 1.5 * cellSize);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath(); // top face of the cylinder
    ctx.ellipse(2 * cellSize, 0.25 * cellSize, 1.0 * cellSize, 0.22 * cellSize, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.stroke();
    // sound hole
    ctx.beginPath();
    ctx.arc(2 * cellSize, 1.0 * cellSize, 0.28 * cellSize, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    // polarity marking
    drawLabel(ctx, '+', 0.55 * cellSize, 0.55 * cellSize, '#94a3b8');
    // sound arcs — animated-looking when active (speaker pattern)
    const wave = activity > 0.01 ? (sim!.time * 8) % 1 : 0;
    ctx.strokeStyle = active ? '#22d3ee' : '#475569';
    ctx.lineWidth = 1.5 + activity * 1.5;
    const r1 = 4 + activity * Math.sin(wave * Math.PI * 2) * 1.5;
    const r2 = 8 + activity * Math.sin(wave * Math.PI * 2 + 1) * 2;
    ctx.beginPath();
    ctx.arc(2 * cellSize, cellSize, r1, -Math.PI / 3, Math.PI / 3);
    ctx.moveTo(2 * cellSize + r2 * Math.cos(Math.PI / 3), cellSize - r2 * Math.sin(Math.PI / 3));
    ctx.arc(2 * cellSize, cellSize, r2, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
    if (active) {
      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 4 + activity * 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  },
  stamp(params, terminals, sys) {
    const pos = pinOf(terminals, 'pos');
    const neg = pinOf(terminals, 'neg');
    const iNom = Math.max(0.001, (params.current_mA as number) ?? 30) / 1000;
    const r = Math.max(0.001, ((params.ratedVoltage as number) ?? 5) / iNom);
    sys.stampConductance(pos, neg, 1 / r);
  },
  getFlowPath() { return [{ x: 0, y: 1 }, { x: 4, y: 1 }]; },
  step(params, terminals, sim, instance) {
    if (!instance.simState) instance.simState = {};
    // v/rated/freq are consumed by the WebAudio engine (lib/circuit/audio.ts)
    // — the rated voltage and resonant frequency are part of the state so the
    // poller doesn't need component-parameter access.
    instance.simState.__buzzer = {
      v: v(sim, pinOf(terminals, 'pos')) - v(sim, pinOf(terminals, 'neg')),
      rated: (params.ratedVoltage as number) ?? 5,
      freq: (params.frequency as number) ?? 2300,
    };
  },
  measure(params, terminals, sim) {
    const pos = pinOf(terminals, 'pos');
    const neg = pinOf(terminals, 'neg');
    const vd = v(sim, pos) - v(sim, neg);
    const rated = (params.ratedVoltage as number) ?? 5;
    const iNom = Math.max(0.001, (params.current_mA as number) ?? 30) / 1000;
    const r = Math.max(0.001, rated / iNom);
    const i = Math.abs(vd) / r;
    return [
      { label: 'V', value: vd.toFixed(3), unit: 'V' },
      { label: 'I', value: (i * 1000).toFixed(2), unit: 'mA' },
      { label: 'Freq', value: String(params.frequency ?? 2300), unit: 'Hz' },
      { label: 'State', value: vd >= 0.8 * rated ? 'ON' : 'OFF', unit: '' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Electret condenser microphone (2-terminal, internal FET)
// ─────────────────────────────────────────────────────────────────────────────

// Real 2-terminal part: OUT needs an external pull-up to VCC (2.2 kΩ
// typical). The internal FET is modeled as a 0.5 mA current sink from OUT to
// GND with voltage compliance: below VDS_sat = 0.4 V the channel is ohmic
// (0.4 V / 0.5 mA = 800 Ω), above it the sink holds — a continuous
// piecewise-linear characteristic whose region is picked from the
// previous-iterate OUT voltage (fixed point, no stored state). The AC signal
// component is 0 in a DC solve; its amplitude is reported by measure() using
// the 2.2 kΩ load assumption: Pa = 20 µPa·10^(spl/20), V_pk = 10^(dBV/20)·Pa.
export const electretMic: ComponentPlugin = {
  type: 'electretMic',
  name: 'Electret Microphone',
  category: SENSOR,
  description: 'Electret condenser microphone with internal FET (2-terminal). OUT needs an external pull-up (2.2 kΩ typical): the FET sinks 0.5 mA, so the node sits at VCC − 0.5 mA·R. Set spl_dB to see the AC output amplitude in the measurements.',
  symbol: 'MIC',
  boundingBox: { width: 4, height: 2 },
  terminals: [
    { id: 'out', label: 'OUT', position: { x: 0, y: 1 }, electricalType: 'output' as const },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 1 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'spl_dB', label: 'Sound Pressure (dB SPL)', type: 'number', default: 60, unit: 'dB', min: 0, max: 140, step: 1 },
    { key: 'sensitivity', label: 'Sensitivity (dBV/Pa)', type: 'number', default: -38, unit: 'dBV/Pa', min: -60, max: 0, step: 1 },
  ],
  keywords: ['microphone', 'electret', 'mic', 'audio', 'sound', 'sensor', 'input', 'condenser', 'fet'],
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // leads
    ctx.beginPath();
    ctx.moveTo(0, cellSize); ctx.lineTo(1.0 * cellSize, cellSize);
    ctx.moveTo(3.0 * cellSize, cellSize); ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    // capsule (circle with terminal face)
    ctx.beginPath();
    ctx.arc(2 * cellSize, cellSize, 0.72 * cellSize, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.stroke();
    // electret plate + field port (the sound inlet)
    ctx.beginPath();
    ctx.arc(2 * cellSize, cellSize, 0.3 * cellSize, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.stroke();
    // internal FET glyph (source to GND, drain to OUT)
    ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(1.45 * cellSize, cellSize); ctx.lineTo(1.85 * cellSize, cellSize);
    ctx.moveTo(2.15 * cellSize, cellSize); ctx.lineTo(2.55 * cellSize, cellSize);
    ctx.moveTo(2.3 * cellSize, cellSize - 0.22 * cellSize);
    ctx.lineTo(2.3 * cellSize, cellSize + 0.22 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'MIC', 2 * cellSize, 1.75 * cellSize, '#64748b');
    drawLabel(ctx, 'OUT', 0.5 * cellSize, 0.55 * cellSize, '#64748b');
    drawLabel(ctx, 'GND', 3.5 * cellSize, 0.55 * cellSize, '#64748b');
  },
  stamp(params, terminals, sys, sim) {
    const out = pinOf(terminals, 'out');
    const gnd = pinOf(terminals, 'gnd');
    if (out === 0 || out === gnd) return; // unwired OUT — nothing to sink
    const IB = 0.0005;  // FET bias current (0.5 mA)
    const VSAT = 0.4;   // FET saturation voltage
    const vOut = v(sim, out); // previous iterate
    if (vOut >= VSAT) {
      // Saturation: constant-current sink (0.5 mA out of OUT into GND)
      // + gmin leak so the sink never leaves a bare row.
      sys.stampCurrentSource(out, gnd, IB);
      sys.stampConductance(out, gnd, 1e-9);
    } else {
      // Ohmic region: VSAT/IB = 800 Ω channel resistance.
      sys.stampConductance(out, gnd, IB / VSAT);
    }
  },
  getFlowPath() { return [{ x: 4, y: 1 }, { x: 0, y: 1 }]; },
  measure(params, terminals, sim) {
    const out = pinOf(terminals, 'out');
    const gnd = pinOf(terminals, 'gnd');
    const vOut = out > 0 ? v(sim, out) : 0;
    // AC amplitude with the 2.2 kΩ load assumption.
    const pa = 20e-6 * Math.pow(10, (params.spl_dB as number) / 20);
    const vPk = Math.pow(10, (params.sensitivity as number) / 20) * pa;
    const iAcUa = (vPk / 2200) * 1e6; // signal current peak through 2.2 kΩ
    return [
      { label: 'Bias', value: vOut >= 0.4 ? '0.50' : (vOut / 800 * 1000).toFixed(2), unit: 'mA' },
      { label: 'Vout', value: vOut.toFixed(3), unit: 'V' },
      { label: 'Pull-up', value: vOut > 1 ? 'UP' : 'NONE', unit: '' },
      { label: 'Signal', value: (2 * vPk * 1000).toFixed(3), unit: 'mVpp' },
      { label: 'Iac', value: iAcUa.toFixed(2), unit: 'µA' },
      { label: 'SPL', value: String(params.spl_dB ?? 60), unit: 'dB' },
      { label: 'GND', value: v(sim, gnd).toFixed(3), unit: 'V' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LCD1602 — 16×2 character LCD with I2C backpack
// ─────────────────────────────────────────────────────────────────────────────

// Current draw as a conductance between the power pins: logic 1.2 mA +
// backlight 22 mA at the nominal rail → G = I_nom/V_nom (a resistive load,
// so the draw scales with the actual supply). SDA/SCL are open-drain bus
// pins: 1e-9 S leakage only — the external pull-ups set the levels.
export const lcd1602: ComponentPlugin = {
  type: 'lcd1602',
  name: 'LCD 16×2 (I2C)',
  category: 'io',
  description: '16×2 character LCD with I2C backpack (PCF8574). Draws 1.2 mA logic + 22 mA backlight (conductance load). SDA/SCL are open-drain — needs external pull-ups. Edit row1Text/row2Text to change what the display shows.',
  symbol: 'LCD',
  boundingBox: { width: 6, height: 6 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 3, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 3, y: 6 }, electricalType: 'power_in' as const },
    { id: 'sda', label: 'SDA', position: { x: 0, y: 2 }, electricalType: 'bidirectional' as const },
    { id: 'scl', label: 'SCL', position: { x: 0, y: 4 }, electricalType: 'input' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 5, unit: 'V', min: 2.5, max: 5.5, step: 0.1 },
    { key: 'backlight', label: 'Backlight On', type: 'boolean', default: true },
    { key: 'row1Text', label: 'Row 1 Text', type: 'string', default: 'Hello CircuitLab' },
    { key: 'row2Text', label: 'Row 2 Text', type: 'string', default: '' },
    { key: 'contrast', label: 'Contrast (0-1)', type: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
  ],
  keywords: ['lcd', '1602', 'character', 'display', 'i2c', 'pcf8574', 'backlight', 'text'],
  render(ctx, params, cellSize, sim, instance) {
    const backlight = (params.backlight as boolean) ?? true;
    const on = sim != null && instance != null;
    const w = 6 * cellSize, h = 6 * cellSize;
    // blue PCB
    ctx.beginPath();
    ctx.rect(0.3 * cellSize, 0.3 * cellSize, w - 0.6 * cellSize, h - 0.6 * cellSize);
    ctx.fillStyle = '#1e3a8a';
    ctx.fill();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // backlight glow behind the green display area
    if (on && backlight) {
      ctx.save();
      ctx.shadowColor = '#4ade80';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#052e16';
      ctx.fillRect(0.9 * cellSize, 1.5 * cellSize, 4.2 * cellSize, 3.0 * cellSize);
      ctx.restore();
    }
    // green display area
    ctx.beginPath();
    ctx.rect(0.9 * cellSize, 1.5 * cellSize, 4.2 * cellSize, 3.0 * cellSize);
    ctx.fillStyle = on && backlight ? '#14532d' : '#052e16';
    ctx.fill();
    ctx.strokeStyle = '#166534';
    ctx.stroke();
    // two rows of text, truncated to 16 characters (monospace)
    const txtColor = on && backlight ? '#86efac' : '#1e4d33';
    const row = (s: unknown) => String(s ?? '').slice(0, 16);
    ctx.save();
    ctx.font = `${Math.max(7, Math.floor(cellSize * 0.42))}px ui-monospace, monospace`;
    ctx.fillStyle = txtColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(row(params.row1Text), 3 * cellSize, 2.35 * cellSize);
    ctx.fillText(row(params.row2Text), 3 * cellSize, 3.65 * cellSize);
    ctx.restore();
    drawLabel(ctx, 'LCD1602', 3 * cellSize, 0.95 * cellSize, '#93c5fd');
    drawLabel(ctx, 'VCC', 3.6 * cellSize, 0.3 * cellSize, '#64748b');
    drawLabel(ctx, 'GND', 3.6 * cellSize, 5.7 * cellSize, '#64748b');
    drawLabel(ctx, 'SDA', 0.4 * cellSize, 1.55 * cellSize, '#64748b');
    drawLabel(ctx, 'SCL', 0.4 * cellSize, 3.55 * cellSize, '#64748b');
  },
  stamp(params, terminals, sys) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const sda = pinOf(terminals, 'sda');
    const scl = pinOf(terminals, 'scl');
    powerLeaks(sys, vcc, gnd);
    // Load conductance: 1.2 mA logic + 22 mA backlight at the nominal rail.
    const vccNom = Math.max(0.1, (params.vcc as number) ?? 5);
    const iNom = 0.0012 + ((params.backlight as boolean) ?? true ? 0.022 : 0);
    if (vcc !== gnd) sys.stampConductance(vcc, gnd, iNom / vccNom);
    // SDA/SCL: open-drain bus pins (leakage only, external pull-ups win).
    pinLeak(sys, sda, gnd);
    pinLeak(sys, scl, gnd);
  },
  getFlowPath() { return [{ x: 3, y: 0 }, { x: 3, y: 6 }]; },
  measure(params, terminals, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const vccNom = Math.max(0.1, (params.vcc as number) ?? 5);
    const iNom = 0.0012 + ((params.backlight as boolean) ?? true ? 0.022 : 0);
    const i = (v(sim, vcc) - v(sim, gnd)) * (iNom / vccNom);
    const trunc = (s: unknown) => String(s ?? '').slice(0, 16);
    return [
      { label: 'I', value: (i * 1000).toFixed(2), unit: 'mA' },
      { label: 'Backlight', value: (params.backlight as boolean) ?? true ? 'ON' : 'OFF', unit: '' },
      { label: 'Row1', value: trunc(params.row1Text) || '(empty)', unit: '' },
      { label: 'Row2', value: trunc(params.row2Text) || '(empty)', unit: '' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SSD1306 — 128×64 OLED I2C display
// ─────────────────────────────────────────────────────────────────────────────

// OLED current scales with brightness: I = on ? (12 + 10·contrast) mA : 0,
// stamped as a conductance at the nominal 3.3 V rail. SDA/SCL open-drain
// leakage like the LCD1602.
export const ssd1306: ComponentPlugin = {
  type: 'ssd1306',
  name: 'OLED 128×64 (SSD1306)',
  category: 'io',
  description: '128×64 monochrome OLED I2C display (SSD1306). Current = 12 + 10·contrast mA when on (conductance load at 3.3 V), 0 when off. SDA/SCL are open-drain — needs external pull-ups.',
  symbol: 'OLED',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    { id: 'sda', label: 'SDA', position: { x: 0, y: 1 }, electricalType: 'bidirectional' as const },
    { id: 'scl', label: 'SCL', position: { x: 0, y: 3 }, electricalType: 'input' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 3.3, unit: 'V', min: 1.65, max: 5.5, step: 0.1 },
    { key: 'contrast', label: 'Contrast (0-1)', type: 'number', default: 0.8, min: 0, max: 1, step: 0.05 },
    { key: 'on', label: 'Display On', type: 'boolean', default: true },
    { key: 'text', label: 'Text', type: 'string', default: 'OLED' },
  ],
  keywords: ['oled', 'ssd1306', 'display', 'i2c', '128x64', 'screen', 'monochrome'],
  render(ctx, params, cellSize, sim, instance) {
    const on = ((params.on as boolean) ?? true) && sim != null && instance != null;
    const w = 4 * cellSize;
    // PCB
    ctx.beginPath();
    ctx.rect(0.3 * cellSize, 0.3 * cellSize, w - 0.6 * cellSize, 3.4 * cellSize);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // dark glass
    ctx.beginPath();
    ctx.rect(0.7 * cellSize, 0.7 * cellSize, 2.6 * cellSize, 2.6 * cellSize);
    ctx.fillStyle = on ? '#0b1220' : '#111827';
    ctx.fill();
    ctx.strokeStyle = '#1f2937';
    ctx.stroke();
    // cyan text when on, dim gray when off
    ctx.save();
    ctx.font = `${Math.max(7, Math.floor(cellSize * 0.5))}px ui-monospace, monospace`;
    ctx.fillStyle = on ? '#22d3ee' : '#374151';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (on) { ctx.shadowColor = '#22d3ee'; ctx.shadowBlur = 6; }
    ctx.fillText(String(params.text ?? 'OLED').slice(0, 8), 2 * cellSize, 2 * cellSize);
    ctx.restore();
    drawLabel(ctx, 'SSD1306', 2 * cellSize, 3.6 * cellSize, '#64748b');
    drawLabel(ctx, 'VCC', 2.6 * cellSize, 0.3 * cellSize, '#64748b');
    drawLabel(ctx, 'GND', 2.6 * cellSize, 3.7 * cellSize, '#64748b');
    drawLabel(ctx, 'SDA', 0.5 * cellSize, 0.55 * cellSize, '#64748b');
    drawLabel(ctx, 'SCL', 0.5 * cellSize, 3.45 * cellSize, '#64748b');
  },
  stamp(params, terminals, sys) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const sda = pinOf(terminals, 'sda');
    const scl = pinOf(terminals, 'scl');
    powerLeaks(sys, vcc, gnd);
    const vccNom = Math.max(0.1, (params.vcc as number) ?? 3.3);
    const contrast = Math.min(1, Math.max(0, (params.contrast as number) ?? 0.8));
    const iNom = (params.on as boolean) ?? true ? 0.012 + 0.010 * contrast : 0;
    if (vcc !== gnd && iNom > 0) sys.stampConductance(vcc, gnd, iNom / vccNom);
    pinLeak(sys, sda, gnd);
    pinLeak(sys, scl, gnd);
  },
  getFlowPath() { return [{ x: 2, y: 0 }, { x: 2, y: 4 }]; },
  measure(params, terminals, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const vccNom = Math.max(0.1, (params.vcc as number) ?? 3.3);
    const contrast = Math.min(1, Math.max(0, (params.contrast as number) ?? 0.8));
    const on = (params.on as boolean) ?? true;
    const i = on ? (v(sim, vcc) - v(sim, gnd)) * ((0.012 + 0.010 * contrast) / vccNom) : 0;
    return [
      { label: 'I', value: (i * 1000).toFixed(2), unit: 'mA' },
      { label: 'State', value: on ? 'ON' : 'OFF', unit: '' },
      { label: 'Res', value: '128×64', unit: '' },
      { label: 'Contrast', value: contrast.toFixed(2), unit: '' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// nRF24L01+ — 2.4 GHz transceiver module
// ─────────────────────────────────────────────────────────────────────────────

// Supply current by mode (conductance load at the nominal 3.3 V rail):
//   idle (power-down/standby-I): 26 µA
//   tx: 11.3 mA at 0 dBm, −1.5 mA per 6 dB step down → 9.8/8.3/6.8 mA
//   rx: 12.6 mA
// Control pins (CE/CSN/SCK/MOSI) are high-Z inputs; MISO is a push-pull
// 100 Ω output that goes HIGH in RX mode when dataReady (a received packet
// is waiting); IRQ is open-drain and asserts (1 kΩ to GND) when dataReady —
// external pull-ups set the released level. All decisions are parameter-only.
export const nrf24l01: ComponentPlugin = {
  type: 'nrf24l01',
  name: 'nRF24L01+ (2.4GHz Transceiver)',
  category: 'ic',
  description: '2.4 GHz wireless transceiver module with PCB antenna. Current by mode: idle 26 µA, TX 11.3 mA at 0 dBm (−1.5 mA per 6 dB step), RX 12.6 mA. MISO goes high in RX mode when a packet waits (dataReady); IRQ asserts (open-drain) on dataReady.',
  symbol: 'RF',
  boundingBox: { width: 6, height: 8 },
  terminals: [
    { id: 'ce', label: 'CE', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'csn', label: 'CSN', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'sck', label: 'SCK', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'mosi', label: 'MOSI', position: { x: 0, y: 4 }, electricalType: 'input' as const },
    { id: 'miso', label: 'MISO', position: { x: 0, y: 5 }, electricalType: 'output' as const },
    { id: 'irq', label: 'IRQ', position: { x: 0, y: 6 }, electricalType: 'open_collector' as const },
    { id: 'vcc', label: 'VCC', position: { x: 6, y: 2 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 6, y: 6 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 3.3, unit: 'V', min: 1.9, max: 3.6, step: 0.1 },
    {
      key: 'mode', label: 'Mode', type: 'select', default: 'idle',
      options: [
        { label: 'Idle (standby)', value: 'idle' },
        { label: 'TX (transmit)', value: 'tx' },
        { label: 'RX (receive)', value: 'rx' },
      ],
    },
    { key: 'channel', label: 'Channel (2400+ MHz)', type: 'number', default: 76, min: 0, max: 125, step: 1 },
    {
      key: 'powerLevel', label: 'TX Power', type: 'select', default: '0dB',
      options: [
        { label: '0 dBm', value: '0dB' },
        { label: '−6 dBm', value: 'm6dB' },
        { label: '−12 dBm', value: 'm12dB' },
        { label: '−18 dBm', value: 'm18dB' },
      ],
    },
    { key: 'dataReady', label: 'Data Ready (RX packet)', type: 'boolean', default: false },
  ],
  keywords: ['nrf24', 'nrf24l01', 'wireless', 'radio', 'rf', '24ghz', 'transceiver', 'spi', '2.4'],
  datasheet: 'https://www.nordicsemi.com/Products/nRF24L01',
  render(ctx, params, cellSize) {
    const w = 6 * cellSize, h = 8 * cellSize;
    // module PCB
    ctx.beginPath();
    ctx.rect(0.5 * cellSize, 0.5 * cellSize, w - cellSize, h - cellSize);
    ctx.fillStyle = '#134e4a';
    ctx.fill();
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // PCB antenna zigzag along the top edge
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    const ax = 1.2 * cellSize, bx = 4.8 * cellSize, ay = 1.0 * cellSize;
    ctx.moveTo(ax, ay);
    const n = 6, step = (bx - ax) / n;
    for (let i = 0; i < n; i++) {
      ctx.lineTo(ax + step * (i + 0.5), ay + (i % 2 === 0 ? -0.45 : 0.45) * cellSize * 0.5);
      ctx.lineTo(ax + step * (i + 1), ay);
    }
    ctx.stroke();
    // RF chip
    ctx.beginPath();
    ctx.rect(1.8 * cellSize, 3.2 * cellSize, 2.4 * cellSize, 2.4 * cellSize);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.stroke();
    drawLabel(ctx, 'nRF24L01+', 3 * cellSize, 4.4 * cellSize, '#e2e8f0');
    drawLabel(ctx, `CH ${params.channel ?? 76}`, 3 * cellSize, 6.2 * cellSize, '#5eead4');
    // pin labels
    const left = ['CE', 'CSN', 'SCK', 'MOSI', 'MISO', 'IRQ'];
    ctx.textAlign = 'left';
    for (let i = 0; i < left.length; i++) {
      drawLabel(ctx, left[i], 0.6 * cellSize, (i + 1) * cellSize + 4, '#64748b');
    }
    drawLabel(ctx, 'VCC', 5.4 * cellSize, 2 * cellSize + 4, '#64748b');
    drawLabel(ctx, 'GND', 5.4 * cellSize, 6 * cellSize + 4, '#64748b');
  },
  stamp(params, terminals, sys, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const miso = pinOf(terminals, 'miso');
    const irq = pinOf(terminals, 'irq');
    powerLeaks(sys, vcc, gnd);
    // Supply current by mode (conductance at the nominal rail).
    const vccNom = Math.max(0.1, (params.vcc as number) ?? 3.3);
    const mode = (params.mode as string) ?? 'idle';
    const stepsDown = { '0dB': 0, m6dB: 1, m12dB: 2, m18dB: 3 }[params.powerLevel as string] ?? 0;
    const iNom = mode === 'tx' ? 0.0113 - 0.0015 * stepsDown
      : mode === 'rx' ? 0.0126
        : 0.000026;
    if (vcc !== gnd && iNom > 0) sys.stampConductance(vcc, gnd, iNom / vccNom);
    // SPI control inputs: high-Z (1e-9 S).
    for (const id of ['ce', 'csn', 'sck', 'mosi']) pinLeak(sys, pinOf(terminals, id), gnd);
    // MISO: push-pull 100 Ω, HIGH in RX mode when a packet is waiting.
    if (miso !== 0) {
      const vccActual = vcc > 0 ? Math.max(0, v(sim, vcc)) : vccNom;
      const hi = mode === 'rx' && (params.dataReady as boolean) === true;
      stampThevenin(sys, miso, gnd, hi ? vccActual : 0, ROUT);
    }
    // IRQ: open-drain, asserts (1 kΩ to GND) when dataReady.
    if (irq !== 0 && irq !== gnd) {
      sys.stampConductance(irq, gnd, (params.dataReady as boolean) === true ? 1 / 1000 : 1e-9);
    }
  },
  getFlowPath() { return [{ x: 6, y: 2 }, { x: 6, y: 6 }]; },
  measure(params, terminals, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const miso = pinOf(terminals, 'miso');
    const irq = pinOf(terminals, 'irq');
    const vccNom = Math.max(0.1, (params.vcc as number) ?? 3.3);
    const mode = (params.mode as string) ?? 'idle';
    const stepsDown = { '0dB': 0, m6dB: 1, m12dB: 2, m18dB: 3 }[params.powerLevel as string] ?? 0;
    const iNom = mode === 'tx' ? 0.0113 - 0.0015 * stepsDown
      : mode === 'rx' ? 0.0126
        : 0.000026;
    const dbm = -6 * stepsDown;
    return [
      { label: 'Mode', value: mode.toUpperCase(), unit: '' },
      { label: 'I', value: ((v(sim, vcc) - v(sim, gnd)) * (iNom / vccNom) * 1000).toFixed(3), unit: 'mA' },
      { label: 'Chan', value: String(params.channel ?? 76), unit: '' },
      { label: 'Power', value: (dbm === 0 ? '0' : String(dbm)), unit: 'dBm' },
      { label: 'MISO', value: v(sim, miso).toFixed(3), unit: 'V' },
      { label: 'IRQ', value: v(sim, irq).toFixed(3), unit: 'V' },
      { label: 'Freq', value: (2400 + (params.channel ?? 76)).toFixed(0), unit: 'MHz' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ESP32 DevKitC — 3V3 LDO + WiFi-current model
// ─────────────────────────────────────────────────────────────────────────────

// AMS1117-style on-board LDO from VIN (5 V USB) to the 3V3 rail: regulated
// Thevenin at 3.3 V through ron (dropout 0.3 V series element below that,
// 600 mA current limit — the lm7805/stampLdo pattern with a limit region).
// The module's own draw is stamped 3V3→GND as a conductance:
//   40 mA core + WiFi (off 0 / idle 20 mA / active 240 mA).
// When the 3V3 pin is unwired but VIN powers the board, the same current is
// stamped as a fixed source VIN→GND (the regulator feeds the chip internally
// — approximation documented in the description). GPIO2 drives the on-board
// LED at the 3V3 rail level (100 Ω push-pull when high, 1e-9 S when Hi-Z);
// every other GPIO is symbol-only high-Z. EN carries the real internal
// 10 kΩ pull-up to the 3V3 rail (Thevenin fallback to GND when the rail pin
// is unwired but VIN powers the board).
export const esp32dev: ComponentPlugin = {
  type: 'esp32dev',
  name: 'ESP32 DevKitC',
  category: 'mcu',
  description: 'ESP32 DevKitC with on-board 3.3 V LDO (VIN 5 V → 3V3, 0.3 V dropout, 600 mA limit). Module current = 40 mA + WiFi (idle 20 mA / active 240 mA), drawn from the 3V3 rail (or VIN when 3V3 is unwired). GPIO2 drives the on-board LED; EN has the internal 10 kΩ pull-up to 3V3.',
  symbol: 'ESP',
  boundingBox: { width: 8, height: 16 },
  terminals: [
    // left column (power / input-only / ADC pins)
    { id: 'en', label: 'EN', position: { x: 0, y: 1 }, electricalType: 'input' as const },
    { id: 'vp', label: 'VP (36)', position: { x: 0, y: 2 }, electricalType: 'input' as const },
    { id: 'vn', label: 'VN (39)', position: { x: 0, y: 3 }, electricalType: 'input' as const },
    { id: 'd34', label: 'D34', position: { x: 0, y: 4 }, electricalType: 'input' as const },
    { id: 'd35', label: 'D35', position: { x: 0, y: 5 }, electricalType: 'input' as const },
    { id: 'd32', label: 'D32', position: { x: 0, y: 6 }, electricalType: 'bidirectional' as const },
    { id: 'd33', label: 'D33', position: { x: 0, y: 7 }, electricalType: 'bidirectional' as const },
    { id: 'd25', label: 'D25', position: { x: 0, y: 8 }, electricalType: 'bidirectional' as const },
    { id: 'd26', label: 'D26', position: { x: 0, y: 9 }, electricalType: 'bidirectional' as const },
    { id: 'd27', label: 'D27', position: { x: 0, y: 10 }, electricalType: 'bidirectional' as const },
    { id: 'd14', label: 'D14', position: { x: 0, y: 11 }, electricalType: 'bidirectional' as const },
    { id: 'd12', label: 'D12', position: { x: 0, y: 12 }, electricalType: 'bidirectional' as const },
    { id: 'd13', label: 'D13', position: { x: 0, y: 13 }, electricalType: 'bidirectional' as const },
    { id: 'gnd', label: 'GND', position: { x: 0, y: 14 }, electricalType: 'power_in' as const },
    { id: 'vin', label: 'VIN', position: { x: 0, y: 15 }, electricalType: 'power_in' as const },
    // right column (3V3 rail + usable GPIOs)
    { id: '3v3', label: '3V3', position: { x: 8, y: 1 }, electricalType: 'power_out' as const },
    { id: 'gnd2', label: 'GND', position: { x: 8, y: 2 }, electricalType: 'power_in' as const },
    { id: 'd15', label: 'D15', position: { x: 8, y: 3 }, electricalType: 'bidirectional' as const },
    { id: 'd2', label: 'D2', position: { x: 8, y: 4 }, electricalType: 'output' as const },
    { id: 'd4', label: 'D4', position: { x: 8, y: 5 }, electricalType: 'bidirectional' as const },
    { id: 'rx2', label: 'RX2 (16)', position: { x: 8, y: 6 }, electricalType: 'bidirectional' as const },
    { id: 'tx2', label: 'TX2 (17)', position: { x: 8, y: 7 }, electricalType: 'bidirectional' as const },
    { id: 'd5', label: 'D5', position: { x: 8, y: 8 }, electricalType: 'bidirectional' as const },
    { id: 'd18', label: 'D18', position: { x: 8, y: 9 }, electricalType: 'bidirectional' as const },
    { id: 'd19', label: 'D19', position: { x: 8, y: 10 }, electricalType: 'bidirectional' as const },
    { id: 'd21', label: 'D21', position: { x: 8, y: 11 }, electricalType: 'bidirectional' as const },
    { id: 'rx0', label: 'RX0 (3)', position: { x: 8, y: 12 }, electricalType: 'bidirectional' as const },
    { id: 'tx0', label: 'TX0 (1)', position: { x: 8, y: 13 }, electricalType: 'bidirectional' as const },
    { id: 'd22', label: 'D22', position: { x: 8, y: 14 }, electricalType: 'bidirectional' as const },
    { id: 'd23', label: 'D23', position: { x: 8, y: 15 }, electricalType: 'bidirectional' as const },
  ],
  parameters: [
    {
      key: 'wifiMode', label: 'WiFi Mode', type: 'select', default: 'idle',
      options: [
        { label: 'Off', value: 'off' },
        { label: 'Idle (modem on)', value: 'idle' },
        { label: 'Active (TX/RX)', value: 'active' },
      ],
    },
    { key: 'gpio2', label: 'GPIO2 (on-board LED)', type: 'boolean', default: false },
  ],
  keywords: ['esp32', 'devkit', 'wifi', 'wireless', 'mcu', 'bluetooth', 'iot', '3v3', 'ldo'],
  render(ctx, params, cellSize) {
    const w = 8 * cellSize, h = 16 * cellSize;
    // PCB
    ctx.beginPath();
    ctx.rect(0.2 * cellSize, 0.2 * cellSize, w - 0.4 * cellSize, h - 0.4 * cellSize);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // antenna zone (meander above the shield)
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    const ax = 1.6 * cellSize, bx = 6.4 * cellSize, ay = 1.4 * cellSize;
    ctx.moveTo(ax, ay);
    const n = 6, step = (bx - ax) / n;
    for (let i = 0; i < n; i++) {
      ctx.lineTo(ax + step * (i + 0.5), ay + (i % 2 === 0 ? -0.5 : 0.5) * cellSize * 0.6);
      ctx.lineTo(ax + step * (i + 1), ay);
    }
    ctx.stroke();
    // metal RF shield
    ctx.beginPath();
    ctx.rect(1.4 * cellSize, 2.2 * cellSize, 5.2 * cellSize, 4.4 * cellSize);
    ctx.fillStyle = '#94a3b8';
    ctx.fill();
    ctx.strokeStyle = '#cbd5e1';
    ctx.stroke();
    drawLabel(ctx, 'ESP32', 4 * cellSize, 4 * cellSize, '#0f172a');
    drawLabel(ctx, 'WIFI', 4 * cellSize, 4.9 * cellSize, '#334155');
    // on-board LED (GPIO2)
    ctx.beginPath();
    ctx.arc(6.9 * cellSize, 7.2 * cellSize, 3, 0, Math.PI * 2);
    ctx.fillStyle = (params.gpio2 as boolean) ? '#22c55e' : '#14532d';
    ctx.fill();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.stroke();
    // USB connector notch (bottom edge)
    ctx.beginPath();
    ctx.rect(3.2 * cellSize, 15.2 * cellSize, 1.6 * cellSize, 0.7 * cellSize);
    ctx.fillStyle = '#475569';
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.stroke();
    // pin labels — two columns (arduinoReal convention)
    ctx.save();
    ctx.font = `${Math.floor(cellSize * 0.45)}px ui-monospace, monospace`;
    ctx.fillStyle = '#94a3b8';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const left = ['EN', 'VP', 'VN', 'D34', 'D35', 'D32', 'D33', 'D25', 'D26', 'D27', 'D14', 'D12', 'D13', 'GND', 'VIN'];
    for (let i = 0; i < left.length; i++) ctx.fillText(left[i], 0.3 * cellSize, (i + 1) * cellSize);
    ctx.textAlign = 'right';
    const right = ['3V3', 'GND', 'D15', 'D2', 'D4', 'RX2', 'TX2', 'D5', 'D18', 'D19', 'D21', 'RX0', 'TX0', 'D22', 'D23'];
    for (let i = 0; i < right.length; i++) ctx.fillText(right[i], w - 0.3 * cellSize, (i + 1) * cellSize);
    ctx.restore();
  },
  stamp(params, terminals, sys, sim) {
    const vin = pinOf(terminals, 'vin');
    const v3 = pinOf(terminals, '3v3');
    const gndL = pinOf(terminals, 'gnd');
    const gndR = pinOf(terminals, 'gnd2');
    const en = pinOf(terminals, 'en');
    const d2 = pinOf(terminals, 'd2');
    const gnd = gndL !== 0 ? gndL : gndR; // first wired ground pin
    // keep both ground nets alive when only one is wired
    if (gndL !== 0 && gndR !== 0 && gndL !== gndR) sys.stampConductance(gndL, gndR, 1e-13);
    powerLeaks(sys, vin, gnd);
    if (v3 !== 0 && v3 !== gnd) sys.stampConductance(v3, gnd, 1e-13);
    // Module current: 40 mA core + WiFi by mode.
    const wifi = { off: 0, idle: 0.020, active: 0.240 }[params.wifiMode as string] ?? 0.020;
    const iModule = 0.040 + wifi;
    if (v3 !== 0 && v3 !== gnd) {
      // normal path: draw from the 3V3 rail (conductance at nominal 3.3 V)
      sys.stampConductance(v3, gnd, iModule / 3.3);
    } else if (vin !== 0 && vin !== gnd) {
      // 3V3 pin unwired but VIN powers the board: same current via VIN
      sys.stampCurrentSource(vin, gnd, iModule);
    }
    // On-board LDO (VIN → 3V3), only meaningful with a wired 3V3 rail.
    const V3V3 = 3.3, DROPOUT = 0.3, RON = 0.1, ILIMIT = 0.6;
    if (vin !== 0 && vin !== v3 && v3 !== 0 && v3 !== gnd) {
      const vIn = v(sim, vin);   // previous iterate
      if (vIn > V3V3 + DROPOUT) {
        // estimate pass current from the previous-iterate rail voltage
        const iEst = Math.max(0, (V3V3 - v(sim, v3)) / RON);
        if (iEst <= ILIMIT) {
          // Regulated: linear VCCS pass element — I(vin→3v3) = (3.3−V(3v3))/ron.
          // Stamped as a Norton pair (fixed source + VCCS return, the Boyle
          // op-amp pattern): exact in one solve AND energy-correct at both
          // pins — VIN supplies exactly the rail load + module current,
          // unlike the plain ground-referenced Thevenin the lm7805 uses.
          sys.stampCurrentSource(vin, v3, V3V3 / RON);
          // stampVCCS(v3, vin, v3, gnd, 1/RON): current from 3V3 back to VIN
          // = V(3v3)/ron — combined with the fixed source above, the net
          // pass current VIN→3V3 is exactly (3.3 − V(3v3))/ron.
          sys.stampVCCS(v3, vin, v3, gnd, 1 / RON);
        } else {
          // current limit: fixed 600 mA pass + gmin to keep the row alive
          sys.stampCurrentSource(vin, v3, ILIMIT);
          sys.stampConductance(v3, gnd, 1e-9);
        }
      } else {
        // dropout: series element, I = (Vin − Vout − dropout)/ron
        sys.stampConductance(vin, v3, 1 / RON);
        sys.stampCurrentSource(v3, vin, DROPOUT / RON);
      }
    }
    // GPIO2 / on-board LED: push-pull at the rail level, Hi-Z when low.
    if (d2 !== 0) {
      const railV = v3 !== 0 ? Math.max(0, v(sim, v3)) : V3V3;
      if ((params.gpio2 as boolean) === true) {
        stampThevenin(sys, d2, gnd, railV, ROUT);
      } else {
        sys.stampConductance(d2, gnd, 1e-9);
      }
    }
    // EN: internal 10 kΩ pull-up to the 3V3 rail (Thevenin-to-GND fallback
    // when the rail pin is unwired but the board is VIN-powered).
    if (en !== 0) {
      if (v3 !== 0 && v3 !== gnd) {
        sys.stampConductance(en, v3, 1 / 10000);
      } else if (vin !== 0 && vin !== gnd) {
        stampThevenin(sys, en, gnd, V3V3, 10000);
      }
    }
    // All other GPIOs: symbol-only high-Z pins.
    for (const id of ['vp', 'vn', 'd34', 'd35', 'd32', 'd33', 'd25', 'd26', 'd27', 'd14', 'd12', 'd13',
      'd15', 'd4', 'rx2', 'tx2', 'd5', 'd18', 'd19', 'd21', 'rx0', 'tx0', 'd22', 'd23']) {
      pinLeak(sys, pinOf(terminals, id), gnd);
    }
  },
  getFlowPath() { return [{ x: 0, y: 15 }, { x: 0, y: 14 }]; },
  measure(params, terminals, sim) {
    const vin = pinOf(terminals, 'vin');
    const v3 = pinOf(terminals, '3v3');
    const d2 = pinOf(terminals, 'd2');
    const wifi = { off: 0, idle: 0.020, active: 0.240 }[params.wifiMode as string] ?? 0.020;
    const wifiMode = (params.wifiMode as string) ?? 'idle';
    return [
      { label: 'VIN', value: v(sim, vin).toFixed(3), unit: 'V' },
      { label: '3V3', value: v(sim, v3).toFixed(3), unit: 'V' },
      { label: 'MCU', value: '40.0', unit: 'mA' },
      { label: 'WiFi', value: (wifi * 1000).toFixed(1), unit: 'mA' },
      { label: 'Total', value: ((0.040 + wifi) * 1000).toFixed(1), unit: 'mA' },
      { label: 'GPIO2', value: (params.gpio2 as boolean) === true ? 'HIGH' : 'Hi-Z', unit: '' },
      { label: 'D2', value: v(sim, d2).toFixed(3), unit: 'V' },
      { label: 'Mode', value: wifiMode, unit: '' },
    ];
  },
};

// Register IO/display/wireless components
registerPlugin(rotaryEncoder);
registerPlugin(ws2812b);
registerPlugin(rgbLed);
registerPlugin(buzzer);
registerPlugin(electretMic);
registerPlugin(lcd1602);
registerPlugin(ssd1306);
registerPlugin(nrf24l01);
registerPlugin(esp32dev);
