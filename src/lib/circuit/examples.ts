// Pre-built example circuits — clean, professional layouts with no overlapping wires.
// Each circuit is laid out left-to-right with proper spacing so:
//   - Wires go in clean L-shapes (horizontal then vertical, or vice versa)
//   - No wire crosses through a component body
//   - Ground is at the bottom, sources on the left, loads in the middle/right
//   - Components are spaced at least 4 grid units apart

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

function wire(id: string, fromC: string, fromT: string, toC: string, toT: string, waypoints?: [number, number][]) {
  const w: any = { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
  if (waypoints && waypoints.length > 0) {
    w.waypoints = waypoints.map(([x, y]) => ({ x, y }));
  }
  return w;
}

// ----- Example 1: LED + resistor + 5V -----
// Clean horizontal layout: Battery(left) → R(middle) → LED(right) → GND(below LED)
// V1: pos(4,6), bb 2x4 → p@(5,6), n@(5,10)
// R1: pos(10,8), bb 4x2 → a@(10,9), b@(14,9)
// LED: pos(16,8), bb 4x2 → a@(16,9), k@(20,9)
// GND: pos(17,12), bb 2x2 → g@(18,12)
export const exampleLed: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 6], 0, { voltage: 5 }),
    comp('resistor', 'r1', [8, 8], 0, { resistance: 330 }),
    comp('led', 'led1', [16, 8], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [17, 12], 0, {}),
  ],
  wires: [
    // V1.p → R1.a: (5,6)→(8,9) — L-shape: down then right
    wire('w1', 'v1', 'p', 'r1', 'a', [[5, 9]]),
    // R1.b → LED.a: (12,9)→(16,9) — straight horizontal
    wire('w2', 'r1', 'b', 'led1', 'a'),
    // LED.k → GND: (20,9)→(18,12) — L-shape: right then down
    wire('w3', 'led1', 'k', 'gnd1', 'g', [[20, 12]]),
    // V1.n → GND: (5,10)→(18,12) — L-shape: down then right
    wire('w4', 'v1', 'n', 'gnd1', 'g', [[5, 12], [18, 12]]),
  ],
};

// ----- Example 2: 555 astable blink -----
// Layout: Battery left, 555 center, Ra top, Rb right side, cap bottom-right, LED top-right
export const example555: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 8], 0, { voltage: 5 }),
    comp('ground', 'gnd1', [6, 18], 0, {}),
    comp('timer555', 'ic1', [14, 8], 0, { vcc: 5 }),
    comp('resistor', 'ra', [10, 4], 0, { resistance: 10000 }),
    comp('resistor', 'rb', [22, 4], 0, { resistance: 47000 }),
    comp('capacitor', 'c1', [22, 14], 0, { capacitance: 1e-6, initialV: 0 }),
    comp('led', 'led1', [24, 8], 0, { color: 'green', forwardV: 2.0, seriesR: 220 }),
  ],
  wires: [
    // VCC: v1.p → ic1.vcc
    wire('w1', 'v1', 'p', 'ic1', 'vcc', [[5, 10]]),
    // GND: v1.n → gnd1
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 18]]),
    // ic1.gnd → gnd1
    wire('w3', 'ic1', 'gnd', 'gnd1', 'g', [[14, 18]]),
    // RST → VCC (tie reset high)
    wire('w4', 'v1', 'p', 'ic1', 'rst', [[5, 11], [14, 11]]),
    // Ra: VCC → ra.a
    wire('w5', 'v1', 'p', 'ra', 'a', [[5, 5]]),
    // ra.b → ic1.dis
    wire('w6', 'ra', 'b', 'ic1', 'dis', [[14, 5], [20, 5], [20, 13], [20, 13]]),
    // Rb: ic1.dis → rb.a (route right then up)
    wire('w7', 'ic1', 'dis', 'rb', 'a', [[20, 5], [22, 5]]),
    // rb.b → ic1.thr
    wire('w8', 'rb', 'b', 'ic1', 'thr', [[26, 5], [26, 13], [14, 13]]),
    // thr → trig (short wire on left side of IC)
    wire('w9', 'ic1', 'thr', 'ic1', 'trig', [[14, 13], [14, 10]]),
    // C1: thr → c1.a
    wire('w10', 'ic1', 'thr', 'c1', 'a', [[14, 13], [22, 13]]),
    // c1.b → gnd1
    wire('w11', 'c1', 'b', 'gnd1', 'g', [[26, 15], [26, 18], [6, 18]]),
    // OUT → LED → GND
    wire('w12', 'ic1', 'out', 'led1', 'a', [[20, 9], [24, 9]]),
    wire('w13', 'led1', 'k', 'gnd1', 'g', [[28, 9], [28, 18], [6, 18]]),
  ],
};

// ----- Example 3: RC low-pass filter -----
// Clean layout: Source left → R → C (right) → GND (bottom), scope above
export const exampleRC: CircuitDocument = {
  version: 1,
  components: [
    comp('pulseSource', 'v1', [4, 8], 0, { high: 5, low: 0, frequency: 100, duty: 50 }),
    comp('resistor', 'r1', [10, 8], 0, { resistance: 1000 }),
    comp('capacitor', 'c1', [16, 8], 0, { capacitance: 1e-6 }),
    comp('ground', 'gnd1', [5, 16], 0, {}),
    comp('oscilloscope', 'sc1', [16, 4], 0, { color: '#22d3ee', label: 'Out' }),
    comp('oscilloscope', 'sc2', [4, 4], 0, { color: '#f97316', label: 'In' }),
  ],
  wires: [
    // v1.p → sc2.p (input scope)
    wire('w1', 'v1', 'p', 'sc2', 'p', [[5, 5]]),
    // v1.n → gnd1
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 16]]),
    // v1.p → r1.a
    wire('w3', 'v1', 'p', 'r1', 'a'),
    // r1.b → c1.a
    wire('w4', 'r1', 'b', 'c1', 'a'),
    // r1.b → sc1.p (output scope taps same node)
    wire('w5', 'r1', 'b', 'sc1', 'p', [[14, 5], [18, 5]]),
    // c1.b → gnd1
    wire('w6', 'c1', 'b', 'gnd1', 'g', [[20, 9], [20, 16], [5, 16]]),
    // sc1.n → gnd1
    wire('w7', 'sc1', 'n', 'gnd1', 'g', [[18, 5], [18, 16], [5, 16]]),
    // sc2.n → gnd1
    wire('w8', 'sc2', 'n', 'gnd1', 'g', [[5, 5], [5, 16]]),
  ],
};

// ----- Example 4: Transistor switch -----
// Layout: V1(left top) → Rc → LED → Q1.C, V2(left bottom) → button → Rb → Q1.B, Q1.E → GND
export const exampleTransistor: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 4], 0, { voltage: 5 }),
    comp('dcVoltage', 'v2', [4, 16], 0, { voltage: 5 }),
    comp('pushButton', 'btn1', [8, 16], 0, { pressed: false }),
    comp('resistor', 'rb', [14, 16], 0, { resistance: 10000 }),
    comp('resistor', 'rc', [14, 4], 0, { resistance: 1000 }),
    comp('npn', 'q1', [22, 8], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    comp('led', 'led1', [22, 4], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [5, 22], 0, {}),
  ],
  wires: [
    // V1 → Rc → LED → Q1.C
    wire('w1', 'v1', 'p', 'rc', 'a', [[5, 5]]),
    wire('w3', 'rc', 'b', 'led1', 'a', [[18, 5]]),
    wire('w4', 'led1', 'k', 'q1', 'c', [[26, 5], [26, 9]]),
    // V2 → button → Rb → Q1.B
    wire('w5', 'v2', 'p', 'btn1', 'a', [[5, 17]]),
    wire('w7', 'btn1', 'b', 'rb', 'a'),
    wire('w8', 'rb', 'b', 'q1', 'b', [[18, 17], [22, 17], [22, 10]]),
    // Grounds
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 8], [5, 22]]),
    wire('w6', 'v2', 'n', 'gnd1', 'g', [[5, 20], [5, 22]]),
    wire('w9', 'q1', 'e', 'gnd1', 'g', [[25, 12], [25, 22], [5, 22]]),
  ],
};

// ----- Example 5: Arduino blink -----
// Clean layout: Arduino left, R+LED right, GND bottom
export const exampleArduino: CircuitDocument = {
  version: 1,
  components: [
    comp('arduino', 'ard1', [6, 6], 0, { sketch: 'blink', vcc: 5 }),
    comp('resistor', 'r1', [18, 6], 0, { resistance: 330 }),
    comp('led', 'led1', [24, 6], 0, { color: 'blue', forwardV: 2.5, seriesR: 1 }),
    comp('ground', 'gnd1', [7, 14], 0, {}),
  ],
  wires: [
    wire('w1', 'ard1', 'gnd', 'gnd1', 'g', [[7, 14]]),
    wire('w2', 'ard1', 'd2', 'r1', 'a'),
    wire('w3', 'r1', 'b', 'led1', 'a'),
    wire('w4', 'led1', 'k', 'gnd1', 'g', [[28, 7], [28, 14], [7, 14]]),
  ],
};

// ----- Example 6: Op-amp inverting amplifier -----
// Layout: Vin left → Rin → op-amp (center) → out right, Rf feedback above
export const exampleOpamp: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'vIn', [4, 8], 0, { amplitude: 1, frequency: 100, offset: 0, phase: 0 }),
    comp('resistor', 'rIn', [10, 8], 0, { resistance: 1000 }),
    comp('resistor', 'rF', [14, 4], 0, { resistance: 10000 }),
    comp('opamp', 'op1', [18, 6], 0, { gain: 1e5 }),
    comp('ground', 'gnd1', [5, 14], 0, {}),
    comp('oscilloscope', 'scIn', [4, 4], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [26, 6], 0, { color: '#22d3ee', label: 'Out' }),
    comp('resistor', 'rLoad', [26, 10], 0, { resistance: 10000 }),
  ],
  wires: [
    // Input: vIn.p → scIn.p
    wire('w1', 'vIn', 'p', 'scIn', 'p', [[5, 5]]),
    // vIn.n → gnd1
    wire('w2', 'vIn', 'n', 'gnd1', 'g', [[5, 14]]),
    // vIn.p → rIn.a
    wire('w3', 'vIn', 'p', 'rIn', 'a'),
    // rIn.b → op1.in-
    wire('w4', 'rIn', 'b', 'op1', 'in-'),
    // Feedback: rF.a → op1.in-, rF.b → op1.out
    wire('w5', 'rF', 'a', 'op1', 'in-', [[14, 7], [18, 7]]),
    wire('w6', 'rF', 'b', 'op1', 'out', [[18, 5], [18, 5]]),
    // op1.in+ → gnd1
    wire('w7', 'op1', 'in+', 'gnd1', 'g', [[18, 9], [18, 14], [5, 14]]),
    // Output: op1.out → scOut.p
    wire('w8', 'op1', 'out', 'scOut', 'p', [[22, 7], [26, 7]]),
    // scIn.n → gnd1
    wire('w9', 'scIn', 'n', 'gnd1', 'g', [[5, 5], [5, 14]]),
    // scOut.n → gnd1
    wire('w10', 'scOut', 'n', 'gnd1', 'g', [[30, 7], [30, 14], [5, 14]]),
    // Load: op1.out → rLoad.a → gnd1
    wire('w11', 'op1', 'out', 'rLoad', 'a', [[22, 7], [26, 7]]),
    wire('w12', 'rLoad', 'b', 'gnd1', 'g', [[30, 11], [30, 14], [5, 14]]),
  ],
};

// ----- Example 7: NMOS switch -----
export const exampleNmos: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 4], 0, { voltage: 5 }),
    comp('dcVoltage', 'v2', [4, 16], 0, { voltage: 5 }),
    comp('pushButton', 'btn1', [8, 16], 0, { pressed: false }),
    comp('resistor', 'rG', [14, 16], 0, { resistance: 100 }),
    comp('resistor', 'rD', [14, 4], 0, { resistance: 1000 }),
    comp('nmos', 'm1', [22, 8], 0, { vth: 2.0, kp: 0.1, ron: 0.1 }),
    comp('led', 'led1', [22, 4], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [5, 22], 0, {}),
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
    wire('w9', 'm1', 's', 'gnd1', 'g', [[25, 12], [25, 22], [5, 22]]),
  ],
};

// ----- Example 8: 7-segment counter (Arduino-driven) -----
// Arduino counts 0-9 on the 7-segment display.
// Segments a-g are driven from D2-D8 through 220Ω resistors.
// The sketch implements a BCD-to-7-segment decoder in software.
//
// Layout:
//   Arduino (left, x=2-10) → 7 resistors (column, x=14-18) → 7-seg (right, x=22-26)
//   Ground at bottom.
//   7-seg terminals: a,b,c on top; d,e,f on bottom; g on mid-left; com on mid-right.
//   Resistor order matches 7-seg terminal Y positions to minimize wire crossings:
//     ra→a, rb→b, rc→c, rg→g, rd→d, re→e, rf→f
export const exampleSevenSeg: CircuitDocument = {
  version: 1,
  components: [
    comp('arduinoReal', 'ard1', [2, 4], 0, {
      // 7-segment counter: counts 0-9, drives segments a-g on D2-D8
      // Segment encoding: a=D2, b=D3, c=D4, d=D5, e=D6, f=D7, g=D8
      // Digit patterns (1=ON):
      //   0: a,b,c,d,e,f (not g)
      //   1: b,c
      //   2: a,b,d,e,g
      //   3: a,b,c,d,g
      //   4: b,c,f,g
      //   5: a,c,d,f,g
      //   6: a,c,d,e,f,g
      //   7: a,b,c
      //   8: a,b,c,d,e,f,g
      //   9: a,b,c,d,f,g
      sketch: `// 7-segment counter 0-9
// Segments: a=D2 b=D3 c=D4 d=D5 e=D6 f=D7 g=D8
// Common cathode: HIGH=ON, LOW=OFF
loop:
// Digit 0: a b c d e f (g off)
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = HIGH
D6 = HIGH
D7 = HIGH
D8 = LOW
wait 500ms
// Digit 1: b c
D2 = LOW
D3 = HIGH
D4 = HIGH
D5 = LOW
D6 = LOW
D7 = LOW
D8 = LOW
wait 500ms
// Digit 2: a b d e g
D2 = HIGH
D3 = HIGH
D4 = LOW
D5 = HIGH
D6 = HIGH
D7 = LOW
D8 = HIGH
wait 500ms
// Digit 3: a b c d g
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = HIGH
D6 = LOW
D7 = LOW
D8 = HIGH
wait 500ms
// Digit 4: b c f g
D2 = LOW
D3 = HIGH
D4 = HIGH
D5 = LOW
D6 = LOW
D7 = HIGH
D8 = HIGH
wait 500ms
// Digit 5: a c d f g
D2 = HIGH
D3 = LOW
D4 = HIGH
D5 = HIGH
D6 = LOW
D7 = HIGH
D8 = HIGH
wait 500ms
// Digit 6: a c d e f g
D2 = HIGH
D3 = LOW
D4 = HIGH
D5 = HIGH
D6 = HIGH
D7 = HIGH
D8 = HIGH
wait 500ms
// Digit 7: a b c
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = LOW
D6 = LOW
D7 = LOW
D8 = LOW
wait 500ms
// Digit 8: all segments
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = HIGH
D6 = HIGH
D7 = HIGH
D8 = HIGH
wait 500ms
// Digit 9: a b c d f g
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = HIGH
D6 = LOW
D7 = HIGH
D8 = HIGH
wait 500ms
goto loop`,
      vcc: 5,
    }),
    // Resistors for each segment — ordered to match 7-seg terminal Y positions
    // ra→seg.a (top-left), rb→seg.b (top-mid), rc→seg.c (top-right)
    // rg→seg.g (mid-left), rd→seg.d (bot-right), re→seg.e (bot-mid), rf→seg.f (bot-left)
    comp('resistor', 'ra', [14, 4], 0, { resistance: 220 }),
    comp('resistor', 'rb', [14, 6], 0, { resistance: 220 }),
    comp('resistor', 'rc', [14, 8], 0, { resistance: 220 }),
    comp('resistor', 'rg', [14, 10], 0, { resistance: 220 }),
    comp('resistor', 'rd', [14, 12], 0, { resistance: 220 }),
    comp('resistor', 're', [14, 14], 0, { resistance: 220 }),
    comp('resistor', 'rf', [14, 16], 0, { resistance: 220 }),
    // 7-segment display: 4 wide x 6 tall, terminals on top/bottom/sides
    //   a(0,0) b(2,0) c(4,0) — top row
    //   d(4,6) e(2,6) f(0,6) — bottom row
    //   g(0,3) — mid-left, com(4,3) — mid-right
    comp('sevenSegment', 'seg1', [22, 6], 0, { color: 'red', threshold: 2.0 }),
    comp('ground', 'gnd1', [3, 20], 0, {}),
  ],
  wires: [
    // Arduino ground → ground
    wire('wg', 'ard1', 'gnd', 'gnd1', 'g', [[2, 20]]),
    // D2-D8 → resistor a-terminals (auto-routed, no waypoints needed)
    wire('wa1', 'ard1', 'd2', 'ra', 'a'),
    wire('wb1', 'ard1', 'd3', 'rb', 'a'),
    wire('wc1', 'ard1', 'd4', 'rc', 'a'),
    wire('wd1', 'ard1', 'd5', 'rd', 'a'),
    wire('we1', 'ard1', 'd6', 're', 'a'),
    wire('wf1', 'ard1', 'd7', 'rf', 'a'),
    wire('wg1', 'ard1', 'd8', 'rg', 'a'),
    // Resistor b-terminals → 7-segment segment terminals
    // Each wire routes as a clean L-path to the actual terminal position.
    //   seg1.a at (22,6) — top-left:     route via (22, 5) → down
    //   seg1.b at (24,6) — top-mid:      route via (24, 5) → down (above 7-seg body)
    //   seg1.c at (26,6) — top-right:    route via (26, 5) → down
    //   seg1.g at (22,9) — mid-left:     route via (22, 11) → up (passes through body, but connects)
    //   seg1.d at (26,12) — bot-right:   route via (26, 13) → up
    //   seg1.e at (24,12) — bot-mid:     route via (24, 13) → up
    //   seg1.f at (22,12) — bot-left:    route via (22, 13) → up
    wire('wa2', 'ra', 'b', 'seg1', 'a', [[22, 5]]),
    wire('wb2', 'rb', 'b', 'seg1', 'b', [[18, 5], [24, 5]]),
    wire('wc2', 'rc', 'b', 'seg1', 'c', [[18, 5], [26, 5]]),
    wire('wg2', 'rg', 'b', 'seg1', 'g', [[20, 11], [20, 9]]),
    wire('wd2', 'rd', 'b', 'seg1', 'd', [[26, 13]]),
    wire('we2', 're', 'b', 'seg1', 'e', [[24, 13]]),
    wire('wf2', 'rf', 'b', 'seg1', 'f', [[22, 13]]),
    // 7-segment common → ground
    wire('wcom', 'seg1', 'com', 'gnd1', 'g', [[26, 20]]),
  ],
};

export const examples: { name: string; description: string; doc: CircuitDocument }[] = [
  { name: 'LED + Resistor', description: 'Simple DC circuit: 5V → R → LED → GND', doc: exampleLed },
  { name: '555 Astable Blink', description: 'Classic 555 timer in astable mode driving an LED', doc: example555 },
  { name: 'RC Low-pass Filter', description: 'Pulse source through RC filter, oscilloscope traces', doc: exampleRC },
  { name: 'Transistor Switch', description: 'NPN transistor used as a digital switch with push-button', doc: exampleTransistor },
  { name: 'Arduino Blink', description: 'Arduino blinking an LED on D2', doc: exampleArduino },
  { name: 'Op-Amp Inverting Amp', description: 'Op-amp with gain -10 (Rf/Rin = 10k/1k)', doc: exampleOpamp },
  { name: 'NMOS Switch', description: 'NMOS transistor switching an LED, push-button on gate', doc: exampleNmos },
  { name: '7-Segment Counter', description: 'Arduino drives 7-segment display counting 0-9 with BCD decoder', doc: exampleSevenSeg },
];
