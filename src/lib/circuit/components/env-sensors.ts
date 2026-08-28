// Environmental / motion / gas sensor batch + LM565 analog PLL:
// adxl335 (3-axis analog accelerometer), mpu6050 (digital IMU),
// ds18b20 (1-wire temperature), dht22 (temp+humidity),
// hcsr04 (ultrasonic ranger), pir501 (PIR motion), acs712 (Hall current
// sensor — fully real electrical model), mq2 (gas sensor with heater),
// lm565 (analog phase-locked loop).
//
// Conventions (from hall-sensors.ts / p3-components.ts):
//   - There is no physics solver for acceleration, sound, gas concentration,
//     motion or temperature, so each physical quantity is a user-settable
//     parameter — the sensor's "input". The ELECTRICAL pins are fully real:
//     every output is a Thevenin source (conductance + current source into
//     the part's own GND pin — the LDO/comparator pattern), every open-drain
//     bus pin is 1e-9 S leakage so external pull-ups set the level, and every
//     supply-pin current draw is stamped as a conductance
//     G = I_nominal / V_nominal (draws the nominal current at the nominal
//     rail, scaling linearly with the actual rail voltage).
//   - MULTI-STAMP SAFETY: solveDC re-stamps the same solution per Newton
//     iteration, so no region/level decision may key off a voltage its own
//     stamp influences. Every digital output level (mpu6050 INT, hcsr04
//     ECHO, pir501 OUT, mq2 DOUT) is decided purely from parameters; the
//     analog outputs read only the externally-driven supply rail and (for
//     acs712) the current-path nodes, none of which the output stamps touch.
//   - State: ONLY lm565 keeps state (VCO phase + PFD + loop filter), keyed
//     stateKey('lm565', comp) in sim.state.__global.
//     !!! memory.ts follow-up: add 'lm565' to COMP_ID_STATE_PREFIXES so
//     deleting an LM565 frees its state entry (the other 8 are stateless).
//   - 'sensor' is not in the ComponentCategory union (types.ts is off
//     limits) — documented cast exactly like hall-sensors.ts. lm565 uses
//     the existing 'ic' category (what the LM324/NE5532 op-amp macromodels
//     use; there is no 'analog' category member).

import type { ComponentPlugin, ComponentCategory, MnaSystem, SimContext } from '../types';
import { drawLabel } from './draw';
import { registerPlugin } from '../registry';
import { stateKey } from '../state-keys';

const SENSOR = 'sensor' as ComponentCategory;

/** Node id of a terminal (unwired pins map to node 0 = ground). */
function pinOf(terminals: { terminalId: string; nodeId: number }[], id: string): number {
  return terminals.find(t => t.terminalId === id)?.nodeId ?? 0;
}

/** Pin voltage (node 0 / unwired pins read 0 V). */
function v(sim: SimContext, node: number): number {
  return sim.nodeVoltage[node] ?? 0;
}

/**
 * Supply-rail voltage from the previous iterate with the parameter as the
 * unwired-pin fallback (op-amp macromodel convention — hallLinear pattern).
 */
function rail(sim: SimContext, node: number, fallback: number): number {
  return node > 0 ? Math.max(0, sim.nodeVoltage[node] ?? fallback) : fallback;
}

/**
 * Idle current draw stamped as a conductance between the supply pins:
 * G = I_nom / V_nom — draws exactly I_nom at the nominal rail and scales
 * linearly with the actual rail (a fixed conductance, solver friendly).
 * stampConductance itself ignores node-0 entries, so a GND pin wired to a
 * ground symbol (node 0) works exactly like any other ground reference.
 */
function drawCurrent(sys: MnaSystem, vccNode: number, gndNode: number, iNomA: number, vNom: number): void {
  if (vccNode === gndNode) return; // same node (or both unwired) — nothing
  sys.stampConductance(vccNode, gndNode, iNomA / vNom);
}

/**
 * Thevenin output stage referenced to the part's own GND pin: Rout from out
 * to gnd plus a current source gnd→out of V/Rout (holds V under load, needs
 * no extra MNA unknown). Skipped for unwired outputs (node 0).
 */
function thevenin(sys: MnaSystem, out: number, gnd: number, vOut: number, rOut: number): void {
  if (out === 0) return;
  sys.stampConductance(out, gnd, 1 / rOut);
  sys.stampCurrentSource(gnd, out, vOut / rOut);
}

/** 1 µS pin leakage — keeps a probed-but-otherwise-idle pin node solvable. */
function leak(sys: MnaSystem, node: number, gnd: number): void {
  if (node !== 0) sys.stampConductance(node, gnd, 1e-6);
}

/** Power-pin keep-alive leaks (hallLinear pattern). */
function powerLeaks(sys: MnaSystem, vcc: number, gnd: number): void {
  if (vcc !== gnd) sys.stampConductance(vcc, gnd, 1e-13);
  if (gnd !== 0) sys.stampConductance(gnd, 0, 1e-13);
}

/** Rounded pin label in the shared muted color. */
function pinLabel(ctx: CanvasRenderingContext2D, cellSize: number, text: string, x: number, y: number): void {
  drawLabel(ctx, text, x * cellSize, y * cellSize, '#64748b');
}

// ─────────────────────────────────────────────────────────────────────────────
// ADXL335 — analog 3-axis accelerometer (ratiometric)
// ─────────────────────────────────────────────────────────────────────────────

// V(axis) = 1.65·(Vcc/3.3) + 0.330·(Vcc/3.3)·a[g], clamped 0.05 V from either
// rail — the datasheet's ratiometric zero-g bias and ±330 mV/g sensitivity.
// Stamped as three independent 1 Ω Thevenin sources (hallLinear pattern),
// referenced to the sensor's own GND pin. Stateless.
export const adxl335: ComponentPlugin = {
  type: 'adxl335',
  name: 'ADXL335 (3-Axis Accelerometer)',
  category: SENSOR,
  description: 'Analog 3-axis accelerometer (ADXL335-style), ratiometric. Each axis output: 1.65·Vcc/3.3 + 0.330·Vcc/3.3·a (V), set accelX/Y/Z in g to simulate tilt/inclination. Zero-g output sits at half supply.',
  symbol: 'ACL',
  boundingBox: { width: 5, height: 5 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 2.5, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2.5, y: 5 }, electricalType: 'power_in' as const },
    { id: 'x', label: 'X', position: { x: 5, y: 1 }, electricalType: 'output' as const },
    { id: 'y', label: 'Y', position: { x: 5, y: 2.5 }, electricalType: 'output' as const },
    { id: 'z', label: 'Z', position: { x: 5, y: 4 }, electricalType: 'output' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 3.3, unit: 'V', min: 1.6, max: 3.6, step: 0.1 },
    { key: 'accelX', label: 'Acceleration X (g)', type: 'number', default: 0, unit: 'g', min: -3, max: 3, step: 0.1 },
    { key: 'accelY', label: 'Acceleration Y (g)', type: 'number', default: 0, unit: 'g', min: -3, max: 3, step: 0.1 },
    { key: 'accelZ', label: 'Acceleration Z (g)', type: 'number', default: 0, unit: 'g', min: -3, max: 3, step: 0.1 },
  ],
  keywords: ['accelerometer', 'adxl335', 'analog', 'sensor', 'tilt', 'inclination', 'imu', 'g', 'motion'],
  datasheet: 'https://www.analog.com/media/en/technical-documentation/data-sheets/ADXL335.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // leads
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, 0.75 * cellSize); ctx.lineTo(2.5 * cellSize, 0);
    ctx.moveTo(2.5 * cellSize, 3.75 * cellSize); ctx.lineTo(2.5 * cellSize, 5 * cellSize);
    ctx.moveTo(3.75 * cellSize, cellSize); ctx.lineTo(5 * cellSize, cellSize);
    ctx.moveTo(3.75 * cellSize, 2.5 * cellSize); ctx.lineTo(5 * cellSize, 2.5 * cellSize);
    ctx.moveTo(3.75 * cellSize, 4 * cellSize); ctx.lineTo(5 * cellSize, 4 * cellSize);
    ctx.stroke();
    // IC body
    ctx.beginPath();
    ctx.rect(0.75 * cellSize, 0.75 * cellSize, 3 * cellSize, 3 * cellSize);
    ctx.stroke();
    // acceleration arrows entering the sensitive face (pink, photodiode
    // light-arrow pattern) — one per axis, aligned with its output row
    ctx.strokeStyle = '#f472b6'; ctx.lineWidth = 1.2;
    for (const yy of [1, 2.5, 4]) {
      const y = yy * cellSize;
      ctx.beginPath();
      ctx.moveTo(0.1 * cellSize, y);
      ctx.lineTo(0.6 * cellSize, y);
      ctx.moveTo(0.42 * cellSize, y - 3);
      ctx.lineTo(0.6 * cellSize, y);
      ctx.lineTo(0.42 * cellSize, y + 3);
      ctx.stroke();
    }
    drawLabel(ctx, 'ADXL335', 2.25 * cellSize, 2.25 * cellSize);
    pinLabel(ctx, cellSize, 'VCC', 2.25, 0.32);
    pinLabel(ctx, cellSize, 'GND', 2.25, 4.62);
    pinLabel(ctx, cellSize, 'X', 4.25, 0.55);
    pinLabel(ctx, cellSize, 'Y', 4.25, 2.05);
    pinLabel(ctx, cellSize, 'Z', 4.25, 3.55);
  },
  stamp(params, terminals, sys, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const vccActual = rail(sim, vcc, params.vcc as number);
    const ratio = vccActual / 3.3; // ratiometric: bias AND sensitivity scale
    const sens = 0.330 * ratio;    // V per g
    const bias = 1.65 * ratio;     // zero-g level
    const vHi = Math.max(0.05, vccActual - 0.05);
    powerLeaks(sys, vcc, gnd);
    for (const [pin, key] of [['x', 'accelX'], ['y', 'accelY'], ['z', 'accelZ']] as const) {
      const out = pinOf(terminals, pin);
      const vRaw = bias + sens * (params[key] as number);
      const vOut = Math.min(vHi, Math.max(0.05, vRaw));
      thevenin(sys, out, gnd, vOut, 1);
      leak(sys, out, gnd);
    }
  },
  getFlowPath() { return [{ x: 2.5, y: 0 }, { x: 2.5, y: 2.25 }, { x: 2.5, y: 5 }]; },
  measure(params, terminals, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const vccActual = rail(sim, vcc, params.vcc as number);
    const ratio = vccActual / 3.3;
    const g = (pin: string) => {
      const out = pinOf(terminals, pin);
      return (sim.nodeVoltage[out] ?? 0).toFixed(3);
    };
    return [
      { label: 'X', value: g('x'), unit: 'V' },
      { label: 'Y', value: g('y'), unit: 'V' },
      { label: 'Z', value: g('z'), unit: 'V' },
      { label: 'aX', value: (params.accelX as number).toFixed(2), unit: 'g' },
      { label: 'aY', value: (params.accelY as number).toFixed(2), unit: 'g' },
      { label: 'aZ', value: (params.accelZ as number).toFixed(2), unit: 'g' },
      { label: 'Sens', value: (0.330 * ratio).toFixed(3), unit: 'V/g' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MPU6050 — digital 6-axis IMU (I2C)
// ─────────────────────────────────────────────────────────────────────────────

// Digital part: SDA/SCL are open-drain (1e-9 S leakage — the external
// pull-ups set the high level), AD0 is a plain input whose node voltage
// picks the I2C address (>1.65 V → 0x69, else 0x68), and INT is a push-pull
// digital output (100 Ω Thevenin, comparator pattern) asserted when
// |accel| ≥ motionThreshold. The threshold decision reads only the static
// accel parameter, so re-stamps are idempotent. 3.9 mA idle draw as a
// conductance. Stateless.
export const mpu6050: ComponentPlugin = {
  type: 'mpu6050',
  name: 'MPU6050 (6-Axis IMU)',
  category: SENSOR,
  description: 'Digital 6-axis gyroscope+accelerometer (MPU-6050-style) on I2C. SDA/SCL are open-drain (wire external pull-ups); AD0 high selects address 0x69, low/floating 0x68. INT is a push-pull output asserted when |accel| ≥ motionThreshold. Set accel (g) and gyro (°/s) to simulate motion.',
  symbol: 'IMU',
  boundingBox: { width: 6, height: 5 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 3, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 3, y: 5 }, electricalType: 'power_in' as const },
    { id: 'sda', label: 'SDA', position: { x: 0, y: 1.5 }, electricalType: 'bidirectional' as const },
    { id: 'scl', label: 'SCL', position: { x: 0, y: 3.5 }, electricalType: 'input' as const },
    { id: 'ad0', label: 'AD0', position: { x: 6, y: 1 }, electricalType: 'input' as const },
    { id: 'int', label: 'INT', position: { x: 6, y: 4 }, electricalType: 'output' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 3.3, unit: 'V', min: 2.4, max: 3.5, step: 0.1 },
    { key: 'accel', label: 'Acceleration (g)', type: 'number', default: 0, unit: 'g', min: -16, max: 16, step: 0.1 },
    { key: 'gyro', label: 'Angular Rate (°/s)', type: 'number', default: 0, unit: '°/s', min: -2000, max: 2000, step: 10 },
    { key: 'motionThreshold', label: 'Motion Threshold (g)', type: 'number', default: 0.5, unit: 'g', min: 0.05, max: 8, step: 0.05 },
    { key: 'idleCurrent_mA', label: 'Idle Current (mA)', type: 'number', default: 3.9, unit: 'mA', min: 0.1, max: 10, step: 0.1 },
  ],
  keywords: ['imu', 'mpu6050', 'mpu', 'gyroscope', 'accelerometer', 'i2c', 'sensor', 'motion', 'digital', 'interrupt'],
  datasheet: 'https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Datasheet1.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // leads
    ctx.beginPath();
    ctx.moveTo(3 * cellSize, 0.75 * cellSize); ctx.lineTo(3 * cellSize, 0);
    ctx.moveTo(3 * cellSize, 3.75 * cellSize); ctx.lineTo(3 * cellSize, 5 * cellSize);
    ctx.moveTo(1.1 * cellSize, 1.5 * cellSize); ctx.lineTo(0, 1.5 * cellSize);
    ctx.moveTo(1.1 * cellSize, 3.5 * cellSize); ctx.lineTo(0, 3.5 * cellSize);
    ctx.moveTo(4.9 * cellSize, cellSize); ctx.lineTo(6 * cellSize, cellSize);
    ctx.moveTo(4.9 * cellSize, 4 * cellSize); ctx.lineTo(6 * cellSize, 4 * cellSize);
    ctx.stroke();
    // IC body
    ctx.beginPath();
    ctx.rect(1.1 * cellSize, 0.75 * cellSize, 3.8 * cellSize, 3.5 * cellSize);
    ctx.stroke();
    // gyro ring icon: outer ring + spinning-mass dot + inner hub
    ctx.beginPath();
    ctx.arc(2.6 * cellSize, 2.5 * cellSize, 0.7 * cellSize, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(2.6 * cellSize, 2.5 * cellSize, 0.16 * cellSize, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(2.6 * cellSize, 1.8 * cellSize);
    ctx.lineTo(3.1 * cellSize, 2.25 * cellSize);
    ctx.stroke();
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    drawLabel(ctx, 'MPU6050', 3.6 * cellSize, 4 * cellSize, '#475569');
    pinLabel(ctx, cellSize, 'VCC', 2.7, 0.32);
    pinLabel(ctx, cellSize, 'GND', 2.7, 4.62);
    pinLabel(ctx, cellSize, 'SDA', 0.45, 1.1);
    pinLabel(ctx, cellSize, 'SCL', 0.45, 3.1);
    pinLabel(ctx, cellSize, 'AD0', 5.1, 0.55);
    pinLabel(ctx, cellSize, 'INT', 5.1, 3.55);
  },
  stamp(params, terminals, sys, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const vccActual = rail(sim, vcc, params.vcc as number);
    powerLeaks(sys, vcc, gnd);
    // 3.9 mA idle current draw (conductance at the nominal 3.3 V rail)
    drawCurrent(sys, vcc, gnd, (params.idleCurrent_mA as number) / 1000, 3.3);
    // SDA / SCL: open-drain — leakage only, external pull-ups set the level
    for (const id of ['sda', 'scl']) {
      const n = pinOf(terminals, id);
      if (n !== 0) sys.stampConductance(n, gnd, 1e-9);
    }
    // AD0 input: weak leak so a probed-but-floating pin stays solvable
    // (reads LOW → default address 0x68, matching a grounded AD0)
    const ad0 = pinOf(terminals, 'ad0');
    if (ad0 !== 0) sys.stampConductance(ad0, gnd, 1e-9);
    // INT: push-pull digital output, 100 Ω Thevenin. Level decided purely
    // from the static accel parameter (idempotent under re-stamps).
    const int = pinOf(terminals, 'int');
    const motion = Math.abs(params.accel as number) >= (params.motionThreshold as number);
    thevenin(sys, int, gnd, motion ? vccActual : 0, 100);
    leak(sys, int, gnd);
  },
  getFlowPath() { return [{ x: 3, y: 0 }, { x: 3, y: 2.5 }, { x: 3, y: 5 }]; },
  measure(params, terminals, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const ad0 = pinOf(terminals, 'ad0');
    const vccActual = rail(sim, vcc, params.vcc as number);
    const ad0High = ad0 > 0 && v(sim, ad0) > 1.65;
    const motion = Math.abs(params.accel as number) >= (params.motionThreshold as number);
    return [
      { label: 'Accel', value: (params.accel as number).toFixed(2), unit: 'g' },
      { label: 'Gyro', value: (params.gyro as number).toFixed(0), unit: '°/s' },
      { label: 'Addr', value: ad0High ? '0x69' : '0x68', unit: '' },
      { label: 'Vcc', value: vccActual.toFixed(3), unit: 'V' },
      { label: 'INT', value: motion ? 'HIGH' : 'LOW', unit: '' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DS18B20 — 1-wire digital temperature sensor
// ─────────────────────────────────────────────────────────────────────────────

// DQ is open-drain: with internalPullup the model stamps the part's own
// nominal 4.7 kΩ pull-up to VDD, otherwise 1e-9 S leakage (external pull-up
// required — or parasite power through DQ). 1.5 mA conversion current draw
// as a conductance. Temperature → raw code:
//   code = round(temp / 2^(8−bits)) & (2^bits − 1)
// (two's complement per resolution, negative temps via the bitwise &).
// Stateless (params only).
export const ds18b20: ComponentPlugin = {
  type: 'ds18b20',
  name: 'DS18B20 (1-Wire Temp Sensor)',
  category: SENSOR,
  description: '1-wire digital temperature sensor (DS18B20-style). DQ is open-drain — enable internalPullup (4.7kΩ to VDD) or wire an external one; supports parasite power (VDD tied to GND). Set temperature (°C) and resolution (9–12 bit); measure shows the raw register code.',
  symbol: 'TMP',
  boundingBox: { width: 4, height: 5 },
  terminals: [
    { id: 'vdd', label: 'VDD', position: { x: 1, y: 5 }, electricalType: 'power_in' as const },
    { id: 'dq', label: 'DQ', position: { x: 2, y: 5 }, electricalType: 'bidirectional' as const },
    { id: 'gnd', label: 'GND', position: { x: 3, y: 5 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'temperature', label: 'Temperature (°C)', type: 'number', default: 25, unit: '°C', min: -55, max: 125, step: 0.0625 },
    {
      key: 'resolutionBits', label: 'Resolution', type: 'select', default: '12',
      options: [
        { label: '9 bit (0.5°C)', value: '9' },
        { label: '10 bit (0.25°C)', value: '10' },
        { label: '11 bit (0.125°C)', value: '11' },
        { label: '12 bit (0.0625°C)', value: '12' },
      ],
    },
    { key: 'internalPullup', label: 'Internal 4.7kΩ Pull-up', type: 'boolean', default: false },
  ],
  keywords: ['temperature', 'ds18b20', '1-wire', 'onewire', 'dallas', 'sensor', 'digital', 'thermometer'],
  datasheet: 'https://www.analog.com/media/en/technical-documentation/data-sheets/ds18b20.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // TO-92 body: flat top, rounded bottom
    ctx.beginPath();
    ctx.moveTo(1 * cellSize, 1 * cellSize);
    ctx.lineTo(3 * cellSize, 1 * cellSize);
    ctx.lineTo(3 * cellSize, 3.1 * cellSize);
    ctx.arc(2 * cellSize, 3.1 * cellSize, cellSize, 0, Math.PI);
    ctx.closePath();
    ctx.stroke();
    // leads
    ctx.beginPath();
    ctx.moveTo(1 * cellSize, 4.1 * cellSize); ctx.lineTo(1 * cellSize, 5 * cellSize);
    ctx.moveTo(2 * cellSize, 4.1 * cellSize); ctx.lineTo(2 * cellSize, 5 * cellSize);
    ctx.moveTo(3 * cellSize, 4.1 * cellSize); ctx.lineTo(3 * cellSize, 5 * cellSize);
    ctx.stroke();
    // thermometer glyph: stem + bulb
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, 1.4 * cellSize);
    ctx.lineTo(2 * cellSize, 2.5 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(2 * cellSize, 2.85 * cellSize, 0.24 * cellSize, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
    drawLabel(ctx, 'DS18B20', 2 * cellSize, 0.5 * cellSize);
    pinLabel(ctx, cellSize, 'VDD', 1, 4.65);
    pinLabel(ctx, cellSize, 'DQ', 2, 4.65);
    pinLabel(ctx, cellSize, 'GND', 3, 4.65);
  },
  stamp(params, terminals, sys) {
    const vdd = pinOf(terminals, 'vdd');
    const gnd = pinOf(terminals, 'gnd');
    const dq = pinOf(terminals, 'dq');
    powerLeaks(sys, vdd, gnd);
    // 1.5 mA conversion current draw (conductance at the nominal 3.3 V rail)
    drawCurrent(sys, vdd, gnd, 0.0015, 3.3);
    // DQ open-drain: internal 4.7 kΩ pull-up to the part's own VDD, or
    // leakage only (external pull-up / parasite power feeds the bus).
    if (dq !== 0) {
      if (params.internalPullup && vdd !== 0) {
        sys.stampConductance(dq, vdd, 1 / 4700);
      } else {
        sys.stampConductance(dq, gnd, 1e-9);
      }
    }
  },
  getFlowPath() { return [{ x: 1, y: 5 }, { x: 2, y: 2.5 }, { x: 3, y: 5 }]; },
  measure(params, terminals, sim) {
    const vdd = pinOf(terminals, 'vdd');
    const gnd = pinOf(terminals, 'gnd');
    const temp = params.temperature as number;
    const bits = Number(params.resolutionBits ?? 12);
    const lsb = Math.pow(2, -(bits - 8)); // °C per count
    const mask = (1 << bits) - 1;
    const code = Math.round(temp / lsb) & mask; // two's complement
    // Parasite power: VDD tied to GND (same node or ~0 V while DQ is used).
    const parasite = vdd === gnd || v(sim, vdd) < 0.1;
    return [
      { label: 'Temp', value: temp.toFixed(bits >= 12 ? 4 : 3), unit: '°C' },
      { label: 'Code', value: `0x${code.toString(16).padStart(Math.ceil(bits / 4), '0').toUpperCase()}`, unit: '' },
      { label: 'Res', value: String(bits), unit: 'bit' },
      { label: 'Power', value: parasite ? 'parasite' : 'VDD', unit: '' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DHT22 — temperature + humidity sensor (single-wire digital)
// ─────────────────────────────────────────────────────────────────────────────

// DATA is open-drain (1e-9 S leakage — external ~10 kΩ pull-up expected).
// 1.5 mA average current draw as a conductance. 16-bit data codes:
// humidity code = round(RH·10); temperature code = round(|°C|·10) with the
// sign forced into bit 15 (negative temperatures, DHT22 convention).
// Stateless.
export const dht22: ComponentPlugin = {
  type: 'dht22',
  name: 'DHT22 (Temp + Humidity)',
  category: SENSOR,
  description: 'Digital temperature + relative-humidity sensor (DHT22/AM2302-style). DATA is open-drain — wire an external ~10 kΩ pull-up. Set temperature (°C) and humidity (%RH); measure shows the 16-bit codes the sensor would transmit.',
  symbol: 'RH',
  boundingBox: { width: 4, height: 4 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 2, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 }, electricalType: 'power_in' as const },
    { id: 'data', label: 'DATA', position: { x: 4, y: 2 }, electricalType: 'bidirectional' as const },
  ],
  parameters: [
    { key: 'temperature', label: 'Temperature (°C)', type: 'number', default: 25, unit: '°C', min: -40, max: 80, step: 0.1 },
    { key: 'humidity', label: 'Humidity (%RH)', type: 'number', default: 45, unit: '%RH', min: 0, max: 100, step: 0.1 },
  ],
  keywords: ['dht22', 'am2302', 'humidity', 'temperature', 'sensor', 'digital', 'single-wire', 'hygrometer'],
  datasheet: 'https://www.sparkfun.com/datasheets/Sensors/Temperature/DHT22.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // leads
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, 0.75 * cellSize); ctx.lineTo(2 * cellSize, 0);
    ctx.moveTo(2 * cellSize, 3.25 * cellSize); ctx.lineTo(2 * cellSize, 4 * cellSize);
    ctx.moveTo(3.25 * cellSize, 2 * cellSize); ctx.lineTo(4 * cellSize, 2 * cellSize);
    ctx.stroke();
    // vented box body
    ctx.beginPath();
    ctx.rect(0.75 * cellSize, 0.75 * cellSize, 2.5 * cellSize, 2.5 * cellSize);
    ctx.stroke();
    ctx.beginPath(); // vent slots
    for (let i = 0; i < 3; i++) {
      const y = (1.15 + i * 0.28) * cellSize;
      ctx.moveTo(1 * cellSize, y); ctx.lineTo(3 * cellSize, y);
    }
    ctx.stroke();
    // drip icon (humidity): teardrop outline
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, 1.6 * cellSize);
    ctx.quadraticCurveTo(2.55 * cellSize, 2.25 * cellSize, 2 * cellSize, 2.55 * cellSize);
    ctx.quadraticCurveTo(1.45 * cellSize, 2.25 * cellSize, 2 * cellSize, 1.6 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'DHT22', 2 * cellSize, 3 * cellSize, '#475569');
    pinLabel(ctx, cellSize, 'VCC', 1.35, 0.32);
    pinLabel(ctx, cellSize, 'GND', 1.35, 3.62);
    pinLabel(ctx, cellSize, 'DATA', 2.95, 1.4);
  },
  stamp(params, terminals, sys) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const data = pinOf(terminals, 'data');
    powerLeaks(sys, vcc, gnd);
    // 1.5 mA average current draw (conductance at the nominal 3.3 V rail)
    drawCurrent(sys, vcc, gnd, 0.0015, 3.3);
    // DATA: open-drain — leakage only, external pull-up sets the level
    if (data !== 0) sys.stampConductance(data, gnd, 1e-9);
  },
  getFlowPath() { return [{ x: 2, y: 0 }, { x: 2, y: 2 }, { x: 2, y: 4 }]; },
  measure(params, terminals, sim) {
    const temp = params.temperature as number;
    const hum = params.humidity as number;
    const humCode = Math.round(hum * 10) & 0xffff;
    const tempCode = (Math.round(Math.abs(temp) * 10) & 0x7fff) | (temp < 0 ? 0x8000 : 0);
    const data = pinOf(terminals, 'data');
    return [
      { label: 'Temp', value: temp.toFixed(1), unit: '°C' },
      { label: 'RH', value: hum.toFixed(1), unit: '%' },
      { label: 'tCode', value: `0x${tempCode.toString(16).padStart(4, '0').toUpperCase()}`, unit: '' },
      { label: 'hCode', value: `0x${humCode.toString(16).padStart(4, '0').toUpperCase()}`, unit: '' },
      { label: 'Vdata', value: v(sim, data).toFixed(3), unit: 'V' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HC-SR04 — ultrasonic ranging module
// ─────────────────────────────────────────────────────────────────────────────

// TRIG is a high-Z digital input (1e-9 S leak, no stamp side effects); ECHO
// is a push-pull digital output (100 Ω Thevenin) asserted only when
// `triggered` is true AND distance is within the 2–400 cm operating range —
// a decision made purely from parameters (idempotent). Echo pulse width:
//   width = distance_cm / 0.0172  µs  (≈58 µs per cm round trip, the
//   standard formula from the speed of sound, 343 m/s).
// 15 mA current draw as a conductance. Stateless.
export const hcsr04: ComponentPlugin = {
  type: 'hcsr04',
  name: 'HC-SR04 (Ultrasonic Ranger)',
  category: SENSOR,
  description: 'Ultrasonic distance ranger (HC-SR04-style). Pulse TRIG ≥10 µs to start a measurement (set `triggered`); ECHO goes high for width = distance/0.0172 µs (≈58 µs/cm round trip) when the target is in the 2–400 cm range. Set distance_cm to simulate the target.',
  symbol: 'US',
  boundingBox: { width: 8, height: 5 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 1.5, y: 0 }, electricalType: 'power_in' as const },
    { id: 'trig', label: 'TRIG', position: { x: 3.2, y: 0 }, electricalType: 'input' as const },
    { id: 'echo', label: 'ECHO', position: { x: 4.8, y: 0 }, electricalType: 'output' as const },
    { id: 'gnd', label: 'GND', position: { x: 6.5, y: 0 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 5, unit: 'V', min: 4.5, max: 5.5, step: 0.1 },
    { key: 'distance_cm', label: 'Distance (cm)', type: 'number', default: 100, unit: 'cm', min: 0, max: 450, step: 1 },
    { key: 'triggered', label: 'Measurement Triggered', type: 'boolean', default: true },
    { key: 'current_mA', label: 'Supply Current (mA)', type: 'number', default: 15, unit: 'mA', min: 1, max: 30, step: 0.5 },
  ],
  keywords: ['ultrasonic', 'hcsr04', 'hc-sr04', 'distance', 'range', 'ranger', 'sonar', 'sensor', 'echo', 'trig'],
  datasheet: 'https://cdn.sparkfun.com/assets/6/9/9/9/1/HCSR04b.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // top-edge leads
    ctx.beginPath();
    for (const x of [1.5, 3.2, 4.8, 6.5]) {
      ctx.moveTo(x * cellSize, 1 * cellSize); ctx.lineTo(x * cellSize, 0);
    }
    ctx.stroke();
    // module board
    ctx.beginPath();
    ctx.rect(0.5 * cellSize, 1 * cellSize, 7 * cellSize, 3 * cellSize);
    ctx.stroke();
    // two transducer cans
    for (const cx of [2, 6]) {
      ctx.beginPath();
      ctx.arc(cx * cellSize, 2.5 * cellSize, 0.85 * cellSize, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx * cellSize, 2.5 * cellSize, 0.55 * cellSize, 0, Math.PI * 2);
      ctx.stroke();
    }
    // crystal + label
    drawLabel(ctx, 'XTL', 4 * cellSize, 2 * cellSize, '#64748b');
    drawLabel(ctx, 'HC-SR04', 4 * cellSize, 3.3 * cellSize);
    pinLabel(ctx, cellSize, 'VCC', 1.5, 0.32);
    pinLabel(ctx, cellSize, 'TRG', 3.2, 0.32);
    pinLabel(ctx, cellSize, 'ECH', 4.8, 0.32);
    pinLabel(ctx, cellSize, 'GND', 6.5, 0.32);
  },
  stamp(params, terminals, sys, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const trig = pinOf(terminals, 'trig');
    const echo = pinOf(terminals, 'echo');
    const vccActual = rail(sim, vcc, params.vcc as number);
    powerLeaks(sys, vcc, gnd);
    // 15 mA supply current draw (conductance at the nominal 5 V rail)
    drawCurrent(sys, vcc, gnd, (params.current_mA as number) / 1000, 5);
    // TRIG: high-Z digital input — leakage only, no side effects
    if (trig !== 0) sys.stampConductance(trig, gnd, 1e-9);
    // ECHO: push-pull 100 Ω Thevenin. Param-only decision (idempotent):
    // high when triggered and the target is inside the 2–400 cm window.
    const d = params.distance_cm as number;
    const active = (params.triggered as boolean) && d >= 2 && d <= 400;
    thevenin(sys, echo, gnd, active ? vccActual : 0, 100);
    leak(sys, echo, gnd);
  },
  getFlowPath() { return [{ x: 1.5, y: 0 }, { x: 1.5, y: 2.5 }, { x: 6.5, y: 2.5 }, { x: 6.5, y: 0 }] },
  measure(params, terminals, sim) {
    const echo = pinOf(terminals, 'echo');
    const d = params.distance_cm as number;
    const active = (params.triggered as boolean) && d >= 2 && d <= 400;
    // Echo pulse width: distance / 0.0172 µs (speed of sound, 343 m/s,
    // round trip) — the standard HC-SR04 formula (≈58 µs per cm).
    const widthUs = d / 0.0172;
    return [
      { label: 'Dist', value: d.toFixed(1), unit: 'cm' },
      { label: 'Echo', value: active ? 'HIGH' : 'LOW', unit: '' },
      { label: 'Width', value: active ? widthUs.toFixed(0) : '—', unit: 'µs' },
      { label: 'Vecho', value: v(sim, echo).toFixed(3), unit: 'V' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HC-SR501 — PIR motion sensor (pir501)
// ─────────────────────────────────────────────────────────────────────────────

// OUT is a push-pull 3.3 V digital output (100 Ω Thevenin to the part's own
// GND — the real module regulates its output stage to 3.3 V even on a 5 V
// supply), HIGH while `motion` is asserted. 50 µA quiescent current as a
// conductance. The output decision reads only the motion parameter
// (idempotent). Stateless.
export const pir501: ComponentPlugin = {
  type: 'pir501',
  name: 'HC-SR501 (PIR Motion)',
  category: SENSOR,
  description: 'Passive-infrared motion sensor module (HC-SR501-style). OUT is a push-pull 3.3 V digital output (100 Ω), high while motion is detected. Set `motion` to simulate detection and `sensitivity` for the trimmer. ~50 µA quiescent draw.',
  symbol: 'PIR',
  boundingBox: { width: 4, height: 5 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 1.2, y: 5 }, electricalType: 'power_in' as const },
    { id: 'out', label: 'OUT', position: { x: 2, y: 5 }, electricalType: 'output' as const },
    { id: 'gnd', label: 'GND', position: { x: 2.8, y: 5 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 5, unit: 'V', min: 4.5, max: 20, step: 0.1 },
    { key: 'motion', label: 'Motion Detected', type: 'boolean', default: false },
    { key: 'sensitivity', label: 'Sensitivity (0–1)', type: 'number', default: 0.5, unit: '', min: 0, max: 1, step: 0.05 },
    { key: 'current_mA', label: 'Quiescent Current (µA)', type: 'number', default: 0.05, unit: 'µA', min: 0.01, max: 1, step: 0.01 },
  ],
  keywords: ['pir', 'motion', 'hcsr501', 'hc-sr501', 'infrared', 'occupancy', 'sensor', 'pyroelectric'],
  datasheet: 'https://www.epitran.it/ebay/datasheet/hcsr501.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // fresnel dome (semicircle on top of the board)
    ctx.beginPath();
    ctx.arc(2 * cellSize, 2.6 * cellSize, 1.15 * cellSize, Math.PI, 0);
    ctx.closePath();
    ctx.stroke();
    // board
    ctx.beginPath();
    ctx.rect(0.85 * cellSize, 2.6 * cellSize, 2.3 * cellSize, 1.9 * cellSize);
    ctx.stroke();
    // dome facet lines (PIR detection segments)
    ctx.beginPath();
    ctx.moveTo(2 * cellSize, 1.45 * cellSize); ctx.lineTo(2 * cellSize, 2.6 * cellSize);
    ctx.moveTo(1.45 * cellSize, 1.75 * cellSize); ctx.lineTo(1.45 * cellSize, 2.6 * cellSize);
    ctx.moveTo(2.55 * cellSize, 1.75 * cellSize); ctx.lineTo(2.55 * cellSize, 2.6 * cellSize);
    ctx.stroke();
    // leads
    ctx.beginPath();
    for (const x of [1.2, 2, 2.8]) {
      ctx.moveTo(x * cellSize, 4.5 * cellSize); ctx.lineTo(x * cellSize, 5 * cellSize);
    }
    ctx.stroke();
    drawLabel(ctx, 'SR501', 2 * cellSize, 3.7 * cellSize);
    pinLabel(ctx, cellSize, 'VCC', 1.2, 4.8);
    pinLabel(ctx, cellSize, 'OUT', 2, 4.8);
    pinLabel(ctx, cellSize, 'GND', 2.8, 4.8);
  },
  stamp(params, terminals, sys) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const out = pinOf(terminals, 'out');
    powerLeaks(sys, vcc, gnd);
    // ~50 µA quiescent current draw (conductance at the nominal 5 V rail)
    drawCurrent(sys, vcc, gnd, (params.current_mA as number) / 1000, 5);
    // OUT: push-pull 3.3 V digital, 100 Ω Thevenin (param-only decision)
    thevenin(sys, out, gnd, (params.motion as boolean) ? 3.3 : 0, 100);
    leak(sys, out, gnd);
  },
  getFlowPath() { return [{ x: 1.2, y: 5 }, { x: 2, y: 3.5 }, { x: 2.8, y: 5 }]; },
  measure(params, terminals, sim) {
    const out = pinOf(terminals, 'out');
    return [
      { label: 'Motion', value: (params.motion as boolean) ? 'YES' : 'NO', unit: '' },
      { label: 'Iq', value: ((params.current_mA as number) * 1000).toFixed(0), unit: 'µA' },
      { label: 'Vout', value: v(sim, out).toFixed(3), unit: 'V' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ACS712 — Hall-effect current sensor (±5 A variant)
// ─────────────────────────────────────────────────────────────────────────────

// FULLY REAL electrical model:
//  (a) the current path is a real 1.2 mΩ resistor stamped between IP1↔IP2
//      (the part's internal conductor resistance) — actual load current
//      flows through the component;
//  (b) VOUT = offset·(Vcc/5) + sensitivity·(Vcc/5)·I_path, a 1 Ω Thevenin
//      source to the part's own GND, where I_path is read from the PREVIOUS
//      iterate's node voltages: (V(ip1) − V(ip2))/1.2 mΩ (the op-amp
//      macromodel convention). Multi-stamp safe: the output stamp does not
//      touch the current-path nodes, so the reading is a fixed point.
//  (c) 10 mA IC current draw vcc→gnd as a conductance.
// Ratiometric: offset and sensitivity both track the actual supply.
export const acs712: ComponentPlugin = {
  type: 'acs712',
  name: 'ACS712 (±5A Current Sensor)',
  category: SENSOR,
  description: 'Hall-effect current sensor, ±5 A variant (ACS712ELCTR-05B). REAL current path: IP1↔IP2 is a 1.2 mΩ conductor — wire it in series with the load. VOUT = 2.5·Vcc/5 + 0.185·Vcc/5·I (ratiometric, 1 Ω output), centered at half supply at zero current.',
  symbol: 'ACS',
  boundingBox: { width: 6, height: 4 },
  terminals: [
    { id: 'ip1', label: 'IP1', position: { x: 0, y: 2 }, electricalType: 'passive' as const },
    { id: 'ip2', label: 'IP2', position: { x: 6, y: 2 }, electricalType: 'passive' as const },
    { id: 'vcc', label: 'VCC', position: { x: 3, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 3, y: 4 }, electricalType: 'power_in' as const },
    { id: 'vout', label: 'VOUT', position: { x: 6, y: 3.5 }, electricalType: 'output' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 5, unit: 'V', min: 4.5, max: 5.5, step: 0.1 },
    { key: 'sensitivity', label: 'Sensitivity (V/A)', type: 'number', default: 0.185, unit: 'V/A', min: 0.05, max: 1, step: 0.005 },
    { key: 'offset', label: 'Zero-Current Offset (V)', type: 'number', default: 2.5, unit: 'V', min: 0.5, max: 5, step: 0.05 },
    { key: 'range', label: 'Current Range (±A)', type: 'number', default: 5, unit: 'A', min: 1, max: 30, step: 1 },
  ],
  keywords: ['current', 'sensor', 'hall', 'acs712', 'current sensor', 'ammeter', 'isolation', 'ratiometric'],
  datasheet: 'https://www.allegromicro.com/-/media/files/datasheets/acs712-datasheet.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // current-path leads straight through the body
    ctx.beginPath();
    ctx.moveTo(0, 2 * cellSize); ctx.lineTo(1 * cellSize, 2 * cellSize);
    ctx.moveTo(5 * cellSize, 2 * cellSize); ctx.lineTo(6 * cellSize, 2 * cellSize);
    ctx.moveTo(3 * cellSize, 0.6 * cellSize); ctx.lineTo(3 * cellSize, 0);
    ctx.moveTo(3 * cellSize, 3.4 * cellSize); ctx.lineTo(3 * cellSize, 4 * cellSize);
    ctx.moveTo(5 * cellSize, 3.5 * cellSize); ctx.lineTo(6 * cellSize, 3.5 * cellSize);
    ctx.stroke();
    // IC body
    ctx.beginPath();
    ctx.rect(1 * cellSize, 0.6 * cellSize, 4 * cellSize, 2.8 * cellSize);
    ctx.stroke();
    // current-path arrows through the body (amber with arrowheads)
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.3;
    for (const dy of [-0.22, 0.22]) {
      const y = (2 + dy) * cellSize;
      ctx.beginPath();
      ctx.moveTo(1.2 * cellSize, y);
      ctx.lineTo(4.5 * cellSize, y);
      ctx.moveTo(4.15 * cellSize, y - 3);
      ctx.lineTo(4.5 * cellSize, y);
      ctx.lineTo(4.15 * cellSize, y + 3);
      ctx.stroke();
    }
    drawLabel(ctx, 'ACS712', 3 * cellSize, 1.1 * cellSize);
    pinLabel(ctx, cellSize, 'VCC', 3, 0.35);
    pinLabel(ctx, cellSize, 'GND', 3, 3.72);
    pinLabel(ctx, cellSize, 'VOUT', 4.9, 3.1);
  },
  stamp(params, terminals, sys, sim) {
    const ip1 = pinOf(terminals, 'ip1');
    const ip2 = pinOf(terminals, 'ip2');
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const vout = pinOf(terminals, 'vout');
    const vccActual = rail(sim, vcc, params.vcc as number);
    // (a) real current path: 1.2 mΩ internal conductor (resistor-plugin stamp)
    const R_PATH = 0.0012;
    sys.stampConductance(ip1, ip2, 1 / R_PATH);
    powerLeaks(sys, vcc, gnd);
    // (c) 10 mA IC current draw (conductance at the nominal 5 V rail)
    drawCurrent(sys, vcc, gnd, 0.010, 5);
    // (b) VOUT from the previous-iterate path current (fixed point: the
    // output stamp never touches ip1/ip2, so this converges, not oscillates)
    const iPath = (v(sim, ip1) - v(sim, ip2)) / R_PATH;
    const ratio = vccActual / 5;
    const vOut = (params.offset as number) * ratio + (params.sensitivity as number) * ratio * iPath;
    thevenin(sys, vout, gnd, vOut, 1);
    leak(sys, vout, gnd);
  },
  getFlowPath() { return [{ x: 0, y: 2 }, { x: 3, y: 2 }, { x: 6, y: 2 }]; },
  measure(params, terminals, sim) {
    const ip1 = pinOf(terminals, 'ip1');
    const ip2 = pinOf(terminals, 'ip2');
    const vout = pinOf(terminals, 'vout');
    const vcc = pinOf(terminals, 'vcc');
    const vccActual = rail(sim, vcc, params.vcc as number);
    const iPath = (v(sim, ip1) - v(sim, ip2)) / 0.0012;
    const range = params.range as number;
    return [
      { label: 'Ipath', value: iPath.toFixed(3), unit: 'A' },
      { label: 'Vout', value: v(sim, vout).toFixed(4), unit: 'V' },
      { label: 'Sens', value: ((params.sensitivity as number) * (vccActual / 5)).toFixed(4), unit: 'V/A' },
      { label: 'Range', value: Math.abs(iPath) > range ? 'OVER' : 'ok', unit: '' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MQ-2 — flammable-gas sensor
// ─────────────────────────────────────────────────────────────────────────────

//  (a) heater: a REAL resistor of heaterResistance Ω stamped vcc→gnd (the
//      resistor-plugin pattern) — ≈152 mA at 5 V for the nominal 33 Ω;
//  (b) AOUT: vcc·(0.1 + 0.8·min(ppm,10000)/10000) as a 10 kΩ Thevenin
//      source (the sensor divider's output impedance);
//  (c) DOUT: open-collector comparator output — ON (1 kΩ to GND) when
//      ppm ≥ threshold_ppm, else 1e-9 S leakage; optional internal 10 kΩ
//      pull-up to VCC (disabled by default, like the real module's jumper).
// All decisions read only parameters (idempotent under re-stamps).
export const mq2: ComponentPlugin = {
  type: 'mq2',
  name: 'MQ-2 (Gas Sensor)',
  category: SENSOR,
  description: 'Flammable-gas sensor (MQ-2-style) with heater. Heater is a real 33 Ω resistor VCC→GND (~150 mA at 5 V). AOUT = Vcc·(0.1 + 0.8·ppm/10000) via 10 kΩ; DOUT is open-collector — pulls LOW (1 kΩ) when ppm ≥ threshold, external pull-up otherwise. Set ppm to simulate gas concentration.',
  symbol: 'GAS',
  boundingBox: { width: 5, height: 5 },
  terminals: [
    { id: 'vcc', label: 'VCC', position: { x: 2.5, y: 0 }, electricalType: 'power_in' as const },
    { id: 'gnd', label: 'GND', position: { x: 2.5, y: 5 }, electricalType: 'power_in' as const },
    { id: 'aout', label: 'AOUT', position: { x: 5, y: 1.5 }, electricalType: 'output' as const },
    { id: 'dout', label: 'DOUT', position: { x: 5, y: 3.5 }, electricalType: 'open_collector' as const },
  ],
  parameters: [
    { key: 'vcc', label: 'Supply Voltage (V)', type: 'number', default: 5, unit: 'V', min: 4.5, max: 5.5, step: 0.1 },
    { key: 'ppm', label: 'Gas Concentration (ppm)', type: 'number', default: 100, unit: 'ppm', min: 0, max: 10000, step: 10 },
    { key: 'threshold_ppm', label: 'DOUT Threshold (ppm)', type: 'number', default: 300, unit: 'ppm', min: 10, max: 10000, step: 10 },
    { key: 'heaterResistance', label: 'Heater Resistance (Ω)', type: 'number', default: 33, unit: 'Ω', min: 5, max: 100, step: 1 },
    { key: 'internalPullup', label: 'Internal 10kΩ DOUT Pull-up', type: 'boolean', default: false },
  ],
  keywords: ['gas', 'mq2', 'mq-2', 'smoke', 'lpg', 'methane', 'sensor', 'heater', 'analog', 'comparator'],
  datasheet: 'https://www.sparkfun.com/datasheets/Sensors/MQ-2.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // leads
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, 1 * cellSize); ctx.lineTo(2.5 * cellSize, 0);
    ctx.moveTo(2.5 * cellSize, 4 * cellSize); ctx.lineTo(2.5 * cellSize, 5 * cellSize);
    ctx.moveTo(4 * cellSize, 1.5 * cellSize); ctx.lineTo(5 * cellSize, 1.5 * cellSize);
    ctx.moveTo(4 * cellSize, 3.5 * cellSize); ctx.lineTo(5 * cellSize, 3.5 * cellSize);
    ctx.stroke();
    // open-collector bar on DOUT
    ctx.beginPath();
    ctx.moveTo(4.15 * cellSize, 2.9 * cellSize);
    ctx.lineTo(4.15 * cellSize, 4.1 * cellSize);
    ctx.stroke();
    // sensor body
    ctx.beginPath();
    ctx.rect(1 * cellSize, 1 * cellSize, 3 * cellSize, 3 * cellSize);
    ctx.stroke();
    // stainless mesh cylinder (top view): two ellipses + mesh lines
    ctx.beginPath();
    ctx.ellipse(2.5 * cellSize, 2.2 * cellSize, 0.85 * cellSize, 0.85 * cellSize, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const x = (1.65 + i * 0.425) * cellSize;
      ctx.moveTo(x, 1.35 * cellSize); ctx.lineTo(x, 3.05 * cellSize);
    }
    ctx.stroke();
    // flame glyph (combustible gas)
    ctx.strokeStyle = '#fb923c'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(2.5 * cellSize, 2.65 * cellSize);
    ctx.quadraticCurveTo(2.05 * cellSize, 3.15 * cellSize, 2.5 * cellSize, 3.5 * cellSize);
    ctx.quadraticCurveTo(2.95 * cellSize, 3.15 * cellSize, 2.5 * cellSize, 2.65 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'MQ-2', 2.5 * cellSize, 3.85 * cellSize, '#475569');
    pinLabel(ctx, cellSize, 'VCC', 2.5, 0.32);
    pinLabel(ctx, cellSize, 'GND', 2.5, 4.62);
    pinLabel(ctx, cellSize, 'AOUT', 4.2, 1.05);
    pinLabel(ctx, cellSize, 'DOUT', 4.2, 3.05);
  },
  stamp(params, terminals, sys, sim) {
    const vcc = pinOf(terminals, 'vcc');
    const gnd = pinOf(terminals, 'gnd');
    const aout = pinOf(terminals, 'aout');
    const dout = pinOf(terminals, 'dout');
    const vccActual = rail(sim, vcc, params.vcc as number);
    // (a) heater: a REAL resistor stamp (vcc→gnd), the dominant current draw
    sys.stampConductance(vcc, gnd, 1 / Math.max(0.001, params.heaterResistance as number));
    if (gnd !== 0) sys.stampConductance(gnd, 0, 1e-13);
    // (b) AOUT: divider output, 10 kΩ Thevenin
    const frac = 0.1 + 0.8 * Math.min(params.ppm as number, 10000) / 10000;
    thevenin(sys, aout, gnd, vccActual * frac, 10000);
    // (c) DOUT: open-collector comparator — ON pulls LOW through 1 kΩ
    const on = (params.ppm as number) >= (params.threshold_ppm as number);
    if (dout !== 0) {
      if (on) {
        sys.stampConductance(dout, gnd, 1 / 1000);
      } else {
        sys.stampConductance(dout, gnd, 1e-9); // leakage — external pull-up sets the level
      }
      // optional internal 10 kΩ pull-up to VCC (module jumper)
      if (params.internalPullup && vcc !== 0) {
        sys.stampConductance(dout, vcc, 1 / 10000);
      }
    }
  },
  getFlowPath() { return [{ x: 2.5, y: 0 }, { x: 2.5, y: 2.5 }, { x: 2.5, y: 5 }]; },
  measure(params, terminals, sim) {
    const aout = pinOf(terminals, 'aout');
    const vcc = pinOf(terminals, 'vcc');
    const vccActual = rail(sim, vcc, params.vcc as number);
    const on = (params.ppm as number) >= (params.threshold_ppm as number);
    const iHeater = vccActual / Math.max(0.001, params.heaterResistance as number);
    return [
      { label: 'ppm', value: (params.ppm as number).toFixed(0), unit: 'ppm' },
      { label: 'AOUT', value: v(sim, aout).toFixed(3), unit: 'V' },
      { label: 'DOUT', value: on ? 'LOW' : 'HIGH', unit: '' },
      { label: 'Iheat', value: (iHeater * 1000).toFixed(1), unit: 'mA' },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LM565 — analog phase-locked loop
// ─────────────────────────────────────────────────────────────────────────────

// Behavioral model mirroring the 74HC4046 (pll4046) structure, on the real
// LM565 pin subset: IN (2), VCO OUT (4), DEMOD OUT (7), timing R (8), timing
// C (9), V+ (10) and V− (1) as vcc/vcc2, plus a signal-ground reference.
// Supplies are dual (params vpos/vneg, default ±6 V — the op-amp-macromodel
// rail convention: unwired supply pins fall back to the parameters).
//
//  - VCO: f0 = 1/(3.7·R·C). The timing R is measured ELECTRICALLY: the model
//    injects a 1 mA test current into the R pin (the real part drives its
//    timing resistor with a current source too) and reads the previous
//    iterate's pin voltage → R_ext = V(rpin)/1 mA; pins that are unwired or
//    measure outside 100 Ω…100 MΩ fall back to the timingR_kΩ parameter.
//    The timing C cannot be resolved from a DC companion model without an
//    integration loop, so the capacitance always comes from timingC_nF —
//    set it to match the external capacitor (documented deviation).
//  - Phase detector: the pll4046's sequential PFD with sim.time guards — a
//    rising edge on IN arms UP, a VCO wrap arms DOWN, both armed → overlap
//    reset. When no input edge has been seen for >10 VCO periods the PD
//    output clears to zero (analog-multiplier behavior with no signal —
//    the VCO then free-runs instead of railing).
//  - Loop filter: internal integrator with leakage — vctl steps ±loopGain
//    V/s while UP/DOWN is armed and relaxes toward the supply midpoint with
//    time constant filterTau. demodout = vctl (1 kΩ Thevenin).
//  - VCO output: 50 Ω Thevenin square wave between the rails (±0.5 V
//    headroom), frequency f0·(1 + vcoRange·(vctl − mid)).
//  - Supply current: 8 mA from V+ to V− (LDO-style current source).
//  - measure(): f0, actual VCO frequency, lock indicator (|f_in − f|/f < 0.1
//    from an internal input-edge frequency estimator), demod voltage,
//    timing values.
//
// State (VCO phase + PFD + loop filter) lives in sim.state.__global under
// stateKey('lm565', comp) — see the memory.ts note at the top of this file.
export const lm565: ComponentPlugin = {
  type: 'lm565',
  name: 'LM565 (Analog PLL)',
  category: 'ic',
  description: 'Analog phase-locked loop (LM565-style). VCO: f0 = 1/(3.7·R·C) on pin-4 square out; the timing resistor is measured electrically at the R pin (falls back to timingR_kΩ when unwired). Sequential phase detector + internal loop filter: demodout (pin 7) is the control voltage. Feed a signal into vin; measure() reports f0, VCO frequency and lock state.',
  symbol: 'PLL',
  boundingBox: { width: 8, height: 6 },
  terminals: [
    { id: 'vin', label: 'IN', position: { x: 0, y: 1.5 }, electricalType: 'input' as const, number: '2' },
    { id: 'rpin', label: 'R', position: { x: 0, y: 3 }, electricalType: 'input' as const, number: '8' },
    { id: 'cpin', label: 'C', position: { x: 0, y: 4.5 }, electricalType: 'input' as const, number: '9' },
    { id: 'vcoout', label: 'VCO', position: { x: 8, y: 1.5 }, electricalType: 'output' as const, number: '4' },
    { id: 'demodout', label: 'DEM', position: { x: 8, y: 3.5 }, electricalType: 'output' as const, number: '7' },
    { id: 'vcc', label: 'V+', position: { x: 2, y: 0 }, electricalType: 'power_in' as const, number: '10' },
    { id: 'vcc2', label: 'V−', position: { x: 6, y: 0 }, electricalType: 'power_in' as const, number: '1' },
    { id: 'gnd', label: 'GND', position: { x: 4, y: 6 }, electricalType: 'power_in' as const },
  ],
  parameters: [
    { key: 'vpos', label: 'V+ Supply (V)', type: 'number', default: 6, unit: 'V', min: 3, max: 12, step: 0.5 },
    { key: 'vneg', label: 'V− Supply (V)', type: 'number', default: -6, unit: 'V', min: -12, max: 0, step: 0.5 },
    { key: 'timingR_kΩ', label: 'Timing R (kΩ)', type: 'number', default: 4, unit: 'kΩ', min: 0.5, max: 100, step: 0.5 },
    { key: 'timingC_nF', label: 'Timing C (nF)', type: 'number', default: 100, unit: 'nF', min: 0.1, max: 10000, step: 10 },
    { key: 'vcoRange', label: 'VCO Range (frac/V)', type: 'number', default: 0.1, unit: '/V', min: 0.01, max: 1, step: 0.01 },
    { key: 'threshold', label: 'Input Threshold (V)', type: 'number', default: 0, unit: 'V', min: -10, max: 10, step: 0.1 },
    // Loop dynamics: ωn = √(2π·f0·vcoRange·loopGain), damping 1/(2·ωn·τ).
    // Defaults (400 V/s, 20 ms) give a comfortably damped loop at the default
    // f0 with the hold range (loopGain·τ = 8 V) beyond the VCO swing — tuned
    // empirically; a large τ under-damps the discrete loop into hunting.
    { key: 'loopGain', label: 'Loop Gain (V/s)', type: 'number', default: 400, unit: 'V/s', min: 1, max: 10000, step: 10 },
    { key: 'filterTau', label: 'Filter Tau (s)', type: 'number', default: 0.02, unit: 's', min: 0.001, max: 10, step: 0.005 },
  ],
  keywords: ['pll', 'lm565', 'phase', 'locked', 'loop', 'vco', 'demodulator', 'fm', 'analog', 'frequency'],
  datasheet: 'https://www.ti.com/lit/ds/symlink/lm565.pdf',
  render(ctx, _params, cellSize) {
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    // DIP-8 body with pin-1 notch on the left
    ctx.beginPath();
    ctx.rect(1 * cellSize, 0.5 * cellSize, 6 * cellSize, 5 * cellSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(1 * cellSize, 1.5 * cellSize, 0.3 * cellSize, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    // leads
    ctx.beginPath();
    for (const [x, y] of [[0, 1.5], [0, 3], [0, 4.5], [8, 1.5], [8, 3.5], [2, 0], [6, 0], [4, 6]] as const) {
      const bx = x === 0 ? 1 * cellSize : x === 8 ? 7 * cellSize : x * cellSize;
      const by = y === 0 ? 0.5 * cellSize : y === 6 ? 5.5 * cellSize : y * cellSize;
      ctx.moveTo(bx, by);
      ctx.lineTo(x * cellSize, y * cellSize);
    }
    ctx.stroke();
    // internal blocks: PD | VCO
    ctx.beginPath();
    ctx.moveTo(4.5 * cellSize, 1.2 * cellSize);
    ctx.lineTo(4.5 * cellSize, 4.8 * cellSize);
    ctx.stroke();
    drawLabel(ctx, 'PD', 2.75 * cellSize, 2 * cellSize, '#64748b');
    drawLabel(ctx, 'VCO', 6.25 * cellSize, 2 * cellSize, '#64748b');
    drawLabel(ctx, 'LM565', 4.5 * cellSize, 4.2 * cellSize);
    pinLabel(ctx, cellSize, 'IN', 0.45, 1.05);
    pinLabel(ctx, cellSize, 'R', 0.45, 2.55);
    pinLabel(ctx, cellSize, 'C', 0.45, 4.05);
    pinLabel(ctx, cellSize, 'VCO', 7.15, 1.05);
    pinLabel(ctx, cellSize, 'DEM', 7.15, 3.05);
    pinLabel(ctx, cellSize, 'V+', 2, 0.32);
    pinLabel(ctx, cellSize, 'V−', 6, 0.32);
    pinLabel(ctx, cellSize, 'GND', 4, 5.68);
  },
  stamp(params, terminals, sys, sim, comp) {
    const vin = pinOf(terminals, 'vin');
    const vcoout = pinOf(terminals, 'vcoout');
    const demodout = pinOf(terminals, 'demodout');
    const rpin = pinOf(terminals, 'rpin');
    const cpin = pinOf(terminals, 'cpin');
    const vcc = pinOf(terminals, 'vcc');
    const vcc2 = pinOf(terminals, 'vcc2');
    const gnd = pinOf(terminals, 'gnd');

    const vposP = params.vpos as number;
    const vnegP = params.vneg as number;
    // Rails from the previous iterate with param fallback (op-amp convention).
    const vpos = vcc > 0 ? (sim.nodeVoltage[vcc] ?? vposP) : vposP;
    const vneg = vcc2 > 0 ? (sim.nodeVoltage[vcc2] ?? vnegP) : vnegP;
    // Control-voltage reference and clamp window (static params — the loop
    // filter state initializes deterministically regardless of rail transients).
    const vMid = (vposP + vnegP) / 2;
    const vLo = vnegP + 0.5;
    const vHi = vposP - 0.5;

    // Supply: 8 mA from V+ to V− (LDO-style current source) + keep-alive leaks.
    if (vcc !== 0 || vcc2 !== 0) sys.stampCurrentSource(vcc, vcc2, 0.008);
    if (vcc !== 0 && vcc !== vcc2) sys.stampConductance(vcc, vcc2, 1e-13);
    if (gnd !== 0) sys.stampConductance(gnd, 0, 1e-13);
    // Input and timing-pin leaks keep otherwise-idle nets solvable.
    if (vin !== 0) sys.stampConductance(vin, gnd, 1e-9);
    if (cpin !== 0) sys.stampConductance(cpin, gnd, 1e-13);

    // External timing-resistance measurement: a 1 mA test current into the
    // R pin (the real chip drives its timing resistor with a current source);
    // the previous iterate's pin voltage gives R_ext = V/I. Below/above sane
    // bounds (shorted pin, dangling on a stiff source) the param is used.
    if (rpin !== 0) sys.stampCurrentSource(gnd, rpin, 0.001);
    let rExt: number | undefined;
    if (rpin > 0) {
      const rMeas = v(sim, rpin) / 0.001;
      if (rMeas >= 100 && rMeas <= 1e8) rExt = rMeas;
    }
    const rEff = rExt ?? (params.timingR_kΩ as number) * 1000;
    const cEff = (params.timingC_nF as number) * 1e-9;
    const f0 = 1 / (3.7 * rEff * cEff);

    // ── state ──
    const st = sim.state.__global ?? (sim.state.__global = {});
    const key = stateKey('lm565', comp);
    const s = st[key] ?? (st[key] = {
      phase: 0,
      lastTime: undefined as number | undefined,
      vinPrev: false,
      up: false,
      down: false,
      vctl: vMid,
      lastVinEdge: undefined as number | undefined,
      freqEst: undefined as number | undefined,
    });

    // ── time guard: mutate integrators only at a NEW sim.time ──
    if (s.lastTime === undefined || sim.time !== s.lastTime) {
      const dt = s.lastTime === undefined ? 0 : Math.max(0, sim.time - s.lastTime);
      s.lastTime = sim.time;
      const gain = params.vcoRange as number;
      const f = Math.max(1e-9, f0 * (1 + gain * (s.vctl - vMid)));

      // VCO phase advance + wrap (rising-edge) detection
      const inc = f * dt;
      const wrapped = s.phase + inc >= 1;
      s.phase = (s.phase + inc) % 1;

      // PFD: vin rising edge arms UP, VCO wrap arms DOWN, both → reset.
      const thresh = params.threshold as number;
      const vinNow = v(sim, vin) > thresh;
      const vinEdge = vinNow && !s.vinPrev;
      if (vinEdge) s.up = true;
      if (wrapped) s.down = true;
      if (s.up && s.down) {
        s.up = false; s.down = false; // classic overlap reset
      }
      s.vinPrev = vinNow;

      // Input frequency estimate (exponentially smoothed edge spacing).
      if (vinEdge) {
        if (s.lastVinEdge !== undefined && sim.time > s.lastVinEdge) {
          const fIn = 1 / (sim.time - s.lastVinEdge);
          s.freqEst = s.freqEst === undefined ? fIn : 0.75 * s.freqEst + 0.25 * fIn;
        }
        s.lastVinEdge = sim.time;
      }
      // No input signal for >10 VCO periods → the analog PD output is zero
      // (the real multiplier PD integrates to nothing without a signal, so
      // the VCO free-runs instead of railing against a dead reference).
      const noSignal = s.lastVinEdge === undefined || (sim.time - s.lastVinEdge) > 10 / Math.max(1e-9, f);
      if (noSignal) {
        s.up = false;
        s.down = false;
      }

      // Loop filter: integrate the PFD output, leak toward mid-supply.
      const kpd = params.loopGain as number;
      const tau = params.filterTau as number;
      if (s.up && !s.down) s.vctl += kpd * dt;
      else if (s.down && !s.up) s.vctl -= kpd * dt;
      s.vctl -= ((s.vctl - vMid) * dt) / tau;
      s.vctl = Math.min(vHi, Math.max(vLo, s.vctl));
    }

    // VCO output: square wave between the rails, 50 Ω Thevenin (the PLL's
    // pin-4 output stage). Rail levels come from the previous iterate.
    thevenin(sys, vcoout, gnd, s.phase < 0.5 ? vpos - 0.5 : vneg + 0.5, 50);
    // Demodulated / control voltage: 1 kΩ Thevenin on pin 7.
    thevenin(sys, demodout, gnd, s.vctl, 1000);
  },
  getFlowPath() { return [{ x: 0, y: 1.5 }, { x: 4, y: 1.5 }, { x: 8, y: 1.5 }]; },
  measure(params, terminals, sim, comp) {
    const vin = pinOf(terminals, 'vin');
    const demodout = pinOf(terminals, 'demodout');
    const vcoout = pinOf(terminals, 'vcoout');
    const rpin = pinOf(terminals, 'rpin');
    const vMid = ((params.vpos as number) + (params.vneg as number)) / 2;
    // effective timing R: external measurement when sane, else the param
    let rExt: number | undefined;
    if (rpin > 0) {
      const rMeas = v(sim, rpin) / 0.001;
      if (rMeas >= 100 && rMeas <= 1e8) rExt = rMeas;
    }
    const rEff = rExt ?? (params.timingR_kΩ as number) * 1000;
    const cEff = (params.timingC_nF as number) * 1e-9;
    const f0 = 1 / (3.7 * rEff * cEff);
    const st = (sim.state.__global ?? {}) as Record<string, unknown>;
    const s = (st[stateKey('lm565', comp)] ?? { phase: 0, vctl: vMid, freqEst: undefined }) as {
      phase: number; vctl: number; freqEst?: number;
    };
    const f = f0 * (1 + (params.vcoRange as number) * (s.vctl - vMid));
    let lock = '—';
    if (s.freqEst !== undefined && s.freqEst > 0) {
      lock = Math.abs(s.freqEst - f) / Math.max(1e-9, f) < 0.1 ? 'LOCK' : 'UNLOCK';
    }
    const fmt = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)}k` : x.toFixed(1));
    return [
      { label: 'f0', value: fmt(f0), unit: 'Hz' },
      { label: 'f_VCO', value: fmt(f), unit: 'Hz' },
      { label: 'Lock', value: lock, unit: '' },
      { label: 'Vdemod', value: v(sim, demodout).toFixed(3), unit: 'V' },
      { label: 'VCOout', value: v(sim, vcoout).toFixed(2), unit: 'V' },
      { label: 'Vin', value: v(sim, vin).toFixed(3), unit: 'V' },
      { label: 'R/C', value: `${(rEff / 1000).toFixed(2)}k/${cEff * 1e9 < 1 ? (cEff * 1e9).toFixed(2) : (cEff * 1e9).toFixed(0)}n`, unit: '' },
    ];
  },
};

// Register all environment/motion/gas sensors + the LM565 PLL.
registerPlugin(adxl335);
registerPlugin(mpu6050);
registerPlugin(ds18b20);
registerPlugin(dht22);
registerPlugin(hcsr04);
registerPlugin(pir501);
registerPlugin(acs712);
registerPlugin(mq2);
registerPlugin(lm565);
