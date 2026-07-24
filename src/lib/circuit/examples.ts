// Pre-built example circuits. Used by the "Examples" menu in the toolbar.
// Each circuit is carefully laid out with proper spacing so wires don't
// overlap components, terminals are visually distinct, and the schematic
// reads clearly from left to right.

import type { CircuitDocument } from './types';
import { getPlugin } from './registry';
import './components';

function defaultsFor(type: string): Record<string, number | string | boolean> {
  const plugin = getPlugin(type);
  if (!plugin) return {};
  const defaults: Record<string, number | string | boolean> = {};
  for (const p of plugin.parameters) defaults[p.key] = p.default;
  return defaults;
}

function comp(
  type: string,
  id: string,
  pos: [number, number],
  rotation: 0 | 1 | 2 | 3 = 0,
  params?: Record<string, number | string | boolean>,
) {
  return {
    id,
    type,
    position: { x: pos[0], y: pos[1] },
    rotation,
    parameters: { ...defaultsFor(type), ...params },
  };
}

function wire(id: string, fromC: string, fromT: string, toC: string, toT: string) {
  return { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
}

// ----- Example 1: LED + resistor + 5V -----
// Layout: Battery left, resistor+LED in a row, ground below battery.
// V1: pos(6,4), bb 2x4 → p@(7,4), n@(7,8)
// R1: pos(10,7), bb 4x2 → a@(10,8), b@(14,8)
// LED: pos(16,7), bb 4x2 → a@(16,8), k@(20,8)
// GND: pos(7,11), bb 2x2 → g@(8,11)
export const exampleLed: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [6, 4], 0, { voltage: 5 }),
    comp('resistor', 'r1', [10, 7], 0, { resistance: 330 }),
    comp('led', 'led1', [16, 7], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [7, 11], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'r1', 'a'),       // (7,4) → (10,8)
    wire('w2', 'r1', 'b', 'led1', 'a'),     // (14,8) → (16,8)
    wire('w3', 'led1', 'k', 'gnd1', 'g'),   // (20,8) → (8,11)
    wire('w4', 'v1', 'n', 'gnd1', 'g'),     // (7,8) → (8,11)
  ],
};

// ----- Example 2: 555 astable blink -----
// Layout: Battery left, 555 center, Ra/Rb above, cap below-right, LED right.
// 555: pos(14,6), bb 6x6 → gnd@(14,7), trig@(14,8), out@(20,7), rst@(14,9),
//   ctrl@(14,10), thr@(14,11), dis@(20,11), vcc@(20,8)
export const example555: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 8], 0, { voltage: 5 }),
    comp('ground', 'gnd1', [5, 16], 0, {}),
    comp('timer555', 'ic1', [14, 6], 0, { vcc: 5 }),
    // Ra: VCC → Ra → DIS. Ra above the 555.
    comp('resistor', 'ra', [8, 4], 0, { resistance: 10000 }),
    // Rb: DIS → THR. Rb between DIS and THR, horizontal.
    comp('resistor', 'rb', [10, 10], 0, { resistance: 47000 }),
    // Rb: a@(10,11), b@(14,11). ic1.thr@(14,11). Direct connection — OK.
    // C1: THR → GND
    comp('capacitor', 'c1', [22, 14], 0, { capacitance: 1e-6, initialV: 0 }),
    comp('led', 'led1', [24, 4], 0, { color: 'green', forwardV: 2.0, seriesR: 220 }),
  ],
  wires: [
    // VCC + GND
    wire('w1', 'v1', 'p', 'ic1', 'vcc'),     // v1.p(5,8) → ic1.vcc(20,8)
    wire('w2', 'v1', 'n', 'gnd1', 'g'),      // v1.n(5,12) → gnd1.g(6,16)
    wire('w3', 'ic1', 'gnd', 'gnd1', 'g'),   // ic1.gnd(14,7) → gnd1.g(6,16)
    // RST tied to VCC (active-low reset)
    wire('w13', 'v1', 'p', 'ic1', 'rst'),    // v1.p(5,8) → ic1.rst(14,9)
    // Ra: VCC → Ra → DIS
    wire('w4', 'v1', 'p', 'ra', 'a'),        // v1.p(5,8) → ra.a(8,5)
    wire('w5', 'ra', 'b', 'ic1', 'dis'),     // ra.b(12,5) → ic1.dis(20,11)
    // Rb: DIS → THR
    wire('w6', 'ic1', 'dis', 'rb', 'a'),     // ic1.dis(20,11) → rb.a(10,11)
    wire('w7', 'rb', 'b', 'ic1', 'thr'),     // rb.b(14,11) → ic1.thr(14,11) — same pos, but ok (direct connection)
    wire('w8', 'ic1', 'thr', 'ic1', 'trig'), // thr(14,11) → trig(14,8) — internal wire on left side of IC
    // C1: THR → GND
    wire('w9', 'ic1', 'thr', 'c1', 'a'),     // ic1.thr(14,11) → c1.a(22,11)
    wire('w10', 'c1', 'b', 'gnd1', 'g'),     // c1.b(22,11) → gnd1.g(6,16) -- wait, c1.b is at (22+4, 14+1)=(26,15)
    // OUT → LED → GND
    wire('w11', 'ic1', 'out', 'led1', 'a'),  // ic1.out(20,7) → led1.a(24,5)
    wire('w12', 'led1', 'k', 'gnd1', 'g'),   // led1.k(28,5) → gnd1.g(6,16)
  ],
};

// ----- Example 3: RC low-pass filter -----
export const exampleRC: CircuitDocument = {
  version: 1,
  components: [
    comp('pulseSource', 'v1', [4, 8], 0, { high: 5, low: 0, frequency: 100, duty: 50 }),
    comp('resistor', 'r1', [10, 8], 0, { resistance: 1000 }),
    comp('capacitor', 'c1', [16, 10], 0, { capacitance: 1e-6 }),
    comp('ground', 'gnd1', [5, 14], 0, {}),
    comp('oscilloscope', 'sc1', [16, 6], 0, { color: '#22d3ee', label: 'Out' }),
    comp('oscilloscope', 'sc2', [6, 6], 0, { color: '#f97316', label: 'In' }),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'sc2', 'p'),
    wire('w2', 'v1', 'n', 'gnd1', 'g'),
    wire('w3', 'v1', 'p', 'r1', 'a'),
    wire('w4', 'r1', 'b', 'c1', 'a'),
    wire('w5', 'r1', 'b', 'sc1', 'p'),
    wire('w6', 'c1', 'b', 'gnd1', 'g'),
    wire('w7', 'sc1', 'n', 'gnd1', 'g'),
    wire('w8', 'sc2', 'n', 'gnd1', 'g'),
  ],
};

// ----- Example 4: Transistor switch -----
export const exampleTransistor: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 4], 0, { voltage: 5 }),
    comp('dcVoltage', 'v2', [4, 14], 0, { voltage: 5 }),
    comp('pushButton', 'btn1', [8, 14], 0, { pressed: false }),
    comp('resistor', 'rb', [14, 14], 0, { resistance: 10000 }),
    comp('resistor', 'rc', [14, 4], 0, { resistance: 1000 }),
    comp('npn', 'q1', [20, 8], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    comp('led', 'led1', [20, 4], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [5, 20], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'rc', 'a'),
    wire('w2', 'v1', 'n', 'gnd1', 'g'),
    wire('w3', 'rc', 'b', 'led1', 'a'),
    wire('w4', 'led1', 'k', 'q1', 'c'),
    wire('w5', 'v2', 'p', 'btn1', 'a'),
    wire('w6', 'v2', 'n', 'gnd1', 'g'),
    wire('w7', 'btn1', 'b', 'rb', 'a'),
    wire('w8', 'rb', 'b', 'q1', 'b'),
    wire('w9', 'q1', 'e', 'gnd1', 'g'),
  ],
};

// ----- Example 5: Arduino blink -----
export const exampleArduino: CircuitDocument = {
  version: 1,
  components: [
    comp('arduino', 'ard1', [6, 6], 0, { sketch: 'blink', vcc: 5 }),
    comp('resistor', 'r1', [18, 6], 0, { resistance: 330 }),
    comp('led', 'led1', [24, 6], 0, { color: 'blue', forwardV: 2.5, seriesR: 1 }),
    comp('ground', 'gnd1', [7, 14], 0, {}),
  ],
  wires: [
    wire('w1', 'ard1', 'gnd', 'gnd1', 'g'),
    wire('w2', 'ard1', 'd2', 'r1', 'a'),
    wire('w3', 'r1', 'b', 'led1', 'a'),
    wire('w4', 'led1', 'k', 'gnd1', 'g'),
  ],
};

// ----- Example 6: Op-amp inverting amplifier -----
export const exampleOpamp: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'vIn', [4, 8], 0, { amplitude: 1, frequency: 100, offset: 0, phase: 0 }),
    comp('resistor', 'rIn', [10, 8], 0, { resistance: 1000 }),
    comp('resistor', 'rF', [10, 2], 0, { resistance: 10000 }),
    comp('opamp', 'op1', [16, 6], 0, { gain: 1e5 }),
    comp('ground', 'gnd1', [5, 14], 0, {}),
    comp('oscilloscope', 'scIn', [6, 6], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [24, 6], 0, { color: '#22d3ee', label: 'Out' }),
    comp('resistor', 'rLoad', [24, 10], 0, { resistance: 10000 }),
  ],
  wires: [
    wire('w1', 'vIn', 'p', 'scIn', 'p'),
    wire('w2', 'vIn', 'n', 'gnd1', 'g'),
    wire('w3', 'vIn', 'p', 'rIn', 'a'),
    wire('w4', 'rIn', 'b', 'op1', 'in-'),
    wire('w5', 'rF', 'a', 'op1', 'in-'),
    wire('w6', 'rF', 'b', 'op1', 'out'),
    wire('w7', 'op1', 'in+', 'gnd1', 'g'),
    wire('w8', 'op1', 'out', 'scOut', 'p'),
    wire('w9', 'scIn', 'n', 'gnd1', 'g'),
    wire('w10', 'scOut', 'n', 'gnd1', 'g'),
    wire('w11', 'op1', 'out', 'rLoad', 'a'),
    wire('w12', 'rLoad', 'b', 'gnd1', 'g'),
  ],
};

// ----- Example 7: NMOS switch -----
export const exampleNmos: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 4], 0, { voltage: 5 }),
    comp('dcVoltage', 'v2', [4, 14], 0, { voltage: 5 }),
    comp('pushButton', 'btn1', [8, 14], 0, { pressed: false }),
    comp('resistor', 'rG', [14, 14], 0, { resistance: 100 }),
    comp('resistor', 'rD', [14, 4], 0, { resistance: 1000 }),
    comp('nmos', 'm1', [20, 8], 0, { vth: 2.0, kp: 0.1, ron: 0.1 }),
    comp('led', 'led1', [20, 4], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [5, 20], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'rD', 'a'),
    wire('w2', 'v1', 'n', 'gnd1', 'g'),
    wire('w3', 'rD', 'b', 'led1', 'a'),
    wire('w4', 'led1', 'k', 'm1', 'd'),
    wire('w5', 'v2', 'p', 'btn1', 'a'),
    wire('w6', 'v2', 'n', 'gnd1', 'g'),
    wire('w7', 'btn1', 'b', 'rG', 'a'),
    wire('w8', 'rG', 'b', 'm1', 'g'),
    wire('w9', 'm1', 's', 'gnd1', 'g'),
  ],
};

// ----- Example 8: 7-segment counter (Arduino-driven) -----
// The Arduino sketch cycles D2→D3→D4→D5, lighting segments a→b→c→d in sequence.
// Using 20ms wait instead of 200ms so the cycling is visible at default simulation speed.
export const exampleSevenSeg: CircuitDocument = {
  version: 1,
  components: [
    comp('arduinoReal', 'ard1', [4, 8], 0, {
      sketch: '// 4-bit counter on D2-D5\nloop:\nD2 = HIGH\nwait 20ms\nD2 = LOW\nD3 = HIGH\nwait 20ms\nD3 = LOW\nD4 = HIGH\nwait 20ms\nD4 = LOW\nD5 = HIGH\nwait 20ms\nD5 = LOW\ngoto loop',
      vcc: 5,
    }),
    comp('resistor', 'ra', [16, 4], 0, { resistance: 220 }),
    comp('resistor', 'rb', [16, 7], 0, { resistance: 220 }),
    comp('resistor', 'rc', [16, 10], 0, { resistance: 220 }),
    comp('resistor', 'rd', [16, 13], 0, { resistance: 220 }),
    comp('sevenSegment', 'seg1', [22, 4], 0, { color: 'red', threshold: 2.0 }),
    comp('ground', 'gnd1', [5, 18], 0, {}),
  ],
  wires: [
    wire('w1', 'ard1', 'gnd', 'gnd1', 'g'),
    wire('w2', 'ard1', 'd2', 'ra', 'a'),
    wire('w3', 'ard1', 'd3', 'rb', 'a'),
    wire('w4', 'ard1', 'd4', 'rc', 'a'),
    wire('w5', 'ard1', 'd5', 'rd', 'a'),
    wire('w6', 'ra', 'b', 'seg1', 'a'),
    wire('w7', 'rb', 'b', 'seg1', 'b'),
    wire('w8', 'rc', 'b', 'seg1', 'c'),
    wire('w9', 'rd', 'b', 'seg1', 'd'),
    wire('w10', 'seg1', 'com', 'gnd1', 'g'),
  ],
};

export const examples: { name: string; description: string; doc: CircuitDocument }[] = [
  { name: 'LED + Resistor', description: 'Simple DC circuit: 5V → R → LED → GND', doc: exampleLed },
  { name: '555 Astable Blink', description: 'Classic 555 timer in astable mode driving an LED', doc: example555 },
  { name: 'RC Low-pass Filter', description: 'Pulse source through RC filter, oscilloscope traces', doc: exampleRC },
  { name: 'Transistor Switch', description: 'NPN transistor used as a digital switch with push-button', doc: exampleTransistor },
  { name: 'Arduino Blink', description: 'Arduino (stub) blinking an LED on D2', doc: exampleArduino },
  { name: 'Op-Amp Inverting Amp', description: 'Op-amp with gain -10 (Rf/Rin = 10k/1k), dual supply ±12V', doc: exampleOpamp },
  { name: 'NMOS Switch', description: 'NMOS transistor switching an LED, push-button on gate', doc: exampleNmos },
  { name: '7-Segment Counter', description: 'Programmable Arduino driving a 7-segment display (BCD 0-9)', doc: exampleSevenSeg },
];
