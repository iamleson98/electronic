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

// ----- Example 9: Digital Clock (HH:MM:SS) -----
// A 6-digit digital clock using CD4026 decade counter ICs.
//
// Architecture:
//   1Hz pulse source (crystal) → sec-ones CD4026 → CO → sec-tens → CO →
//   min-ones → CO → min-tens → CO → hr-ones → CO → hr-tens
//
// Each CD4026 counts on the rising edge of its CLK input and drives a 7-segment
// display directly via its a-g outputs. The carry-out (CO) goes HIGH for the
// first half of the count cycle, producing a rising edge on the next CD4026's
// CLK when this counter wraps to 0.
//
// maxCount settings:
//   - ones digits: maxCount=10 (counts 0-9)
//   - tens digits: maxCount=6 (counts 0-5, for seconds/minutes tens)
//   - hours tens: maxCount=3 (counts 0-2, for 24h format)
//
// Note: For a true 24-hour reset (00:00:00 at 24:00:00), add an AND gate that
// detects hr-tens=2 AND hr-ones=4 and drives RST on both hour counters.
// This example omits that for simplicity — it counts 00:00:00 to 29:59:59.
//
// Layout: 6 digit columns, each with a CD4026 (top) and 7-seg (bottom).
//   x=2: hr-tens, x=10: hr-ones, x=20: min-tens, x=28: min-ones,
//   x=38: sec-tens, x=46: sec-ones
//   Crystal at far right, power and ground at bottom.
function digitSegWires(prefix: string, cx: number, segId: string, segCx: number) {
  // Generate 7 segment wires from CD4026 (at cx, y=2) to 7-seg (at segCx, y=8)
  // CD4026 segment outputs at (cx+0..6, 6)
  // 7-seg segment inputs at various positions
  const segPositions: Record<string, [number, number]> = {
    a: [segCx + 0, 8],   // top-left
    b: [segCx + 2, 8],   // top-mid
    c: [segCx + 4, 8],   // top-right
    d: [segCx + 4, 14],  // bot-right
    e: [segCx + 2, 14],  // bot-mid
    f: [segCx + 0, 14],  // bot-left
    g: [segCx + 0, 11],  // mid-left
  };
  const cd4026SegY = 6; // bottom of CD4026
  const segIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  return segIds.map((s, i) => {
    const [sx, sy] = segPositions[s];
    // Route from (cx+i, 6) to (sx, sy)
    // Simple L-path: go down from CD4026 output to a routing channel, then to the segment
    const waypoints: [number, number][] = [];
    if (sy <= 8) {
      // Top-row segments (a, b, c): route directly down
      waypoints.push([cx + i, 7], [sx, 7]);
    } else {
      // Bottom/side segments (d, e, f, g): route around the 7-seg body
      // Go down to y=7, then horizontal to sx, then down to sy
      waypoints.push([cx + i, 7], [sx, 7]);
    }
    return wire(`${prefix}_${s}`, `ic_${prefix}`, s, `seg_${prefix}`, s, waypoints);
  });
}

export const exampleClock: CircuitDocument = {
  version: 1,
  components: [
    // 1Hz crystal oscillator (pulse source) — drives the seconds-ones counter
    comp('pulseSource', 'xtal', [53, 2], 0, { high: 5, low: 0, frequency: 1, duty: 50 }),
    // 5V power for the CD4026 ICs
    comp('dcVoltage', 'vcc1', [53, 8], 0, { voltage: 5 }),
    comp('ground', 'gnd1', [25, 18], 0, {}),
    // 6 CD4026 decade counters (left to right: hr-tens, hr-ones, min-tens, min-ones, sec-tens, sec-ones)
    comp('cd4026', 'ic_ht', [2, 2], 0, { maxCount: 3, vcc: 5 }),   // hours tens (0-2)
    comp('cd4026', 'ic_ho', [10, 2], 0, { maxCount: 10, vcc: 5 }),  // hours ones (0-9)
    comp('cd4026', 'ic_mt', [20, 2], 0, { maxCount: 6, vcc: 5 }),   // minutes tens (0-5)
    comp('cd4026', 'ic_mo', [28, 2], 0, { maxCount: 10, vcc: 5 }),  // minutes ones (0-9)
    comp('cd4026', 'ic_st', [38, 2], 0, { maxCount: 6, vcc: 5 }),   // seconds tens (0-5)
    comp('cd4026', 'ic_so', [46, 2], 0, { maxCount: 10, vcc: 5 }),  // seconds ones (0-9)
    // 6 seven-segment displays (below the CD4026s)
    comp('sevenSegment', 'seg_ht', [3, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_ho', [11, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_mt', [21, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_mo', [29, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_st', [39, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_so', [47, 8], 0, { color: 'green', threshold: 2.0 }),
  ],
  wires: [
    // Crystal → sec-ones CLK
    wire('clk_so', 'xtal', 'p', 'ic_so', 'clk', [[54, 1], [46, 1]]),
    wire('xtal_gnd', 'xtal', 'n', 'gnd1', 'g', [[54, 18]]),
    // Carry chain: CO → CLK of next stage (right to left: so→st→mo→mt→ho→ht)
    wire('co_so_st', 'ic_so', 'co', 'ic_st', 'clk', [[52, 4], [38, 4], [38, 1], [44, 1]]),
    wire('co_st_mo', 'ic_st', 'co', 'ic_mo', 'clk', [[44, 4], [28, 4], [28, 1], [34, 1]]),
    wire('co_mo_mt', 'ic_mo', 'co', 'ic_mt', 'clk', [[34, 4], [20, 4], [20, 1], [26, 1]]),
    wire('co_mt_ho', 'ic_mt', 'co', 'ic_ho', 'clk', [[26, 4], [10, 4], [10, 1], [16, 1]]),
    wire('co_ho_ht', 'ic_ho', 'co', 'ic_ht', 'clk', [[16, 4], [2, 4], [2, 1], [8, 1]]),

    // VCC for all CD4026s (connect to 5V supply)
    wire('vcc_ht', 'vcc1', 'p', 'ic_ht', 'vcc', [[54, 3], [3, 3]]),
    wire('vcc_ho', 'vcc1', 'p', 'ic_ho', 'vcc', [[54, 3], [11, 3]]),
    wire('vcc_mt', 'vcc1', 'p', 'ic_mt', 'vcc', [[54, 3], [21, 3]]),
    wire('vcc_mo', 'vcc1', 'p', 'ic_mo', 'vcc', [[54, 3], [29, 3]]),
    wire('vcc_st', 'vcc1', 'p', 'ic_st', 'vcc', [[54, 3], [39, 3]]),
    wire('vcc_so', 'vcc1', 'p', 'ic_so', 'vcc', [[54, 3], [47, 3]]),
    wire('vcc_gnd', 'vcc1', 'n', 'gnd1', 'g', [[54, 18]]),

    // GND for all CD4026s
    wire('gnd_ht', 'ic_ht', 'gnd', 'gnd1', 'g', [[7, 18]]),
    wire('gnd_ho', 'ic_ho', 'gnd', 'gnd1', 'g', [[15, 18]]),
    wire('gnd_mt', 'ic_mt', 'gnd', 'gnd1', 'g', [[25, 18]]),
    wire('gnd_mo', 'ic_mo', 'gnd', 'gnd1', 'g', [[33, 18]]),
    wire('gnd_st', 'ic_st', 'gnd', 'gnd1', 'g', [[43, 18]]),
    wire('gnd_so', 'ic_so', 'gnd', 'gnd1', 'g', [[51, 18]]),

    // RST for all CD4026s (tie to ground — no reset)
    wire('rst_ht', 'ic_ht', 'rst', 'gnd1', 'g', [[2, 18]]),
    wire('rst_ho', 'ic_ho', 'rst', 'gnd1', 'g', [[10, 18]]),
    wire('rst_mt', 'ic_mt', 'rst', 'gnd1', 'g', [[20, 18]]),
    wire('rst_mo', 'ic_mo', 'rst', 'gnd1', 'g', [[28, 18]]),
    wire('rst_st', 'ic_st', 'rst', 'gnd1', 'g', [[38, 18]]),
    wire('rst_so', 'ic_so', 'rst', 'gnd1', 'g', [[46, 18]]),

    // COM for all 7-seg displays → ground
    wire('com_ht', 'seg_ht', 'com', 'gnd1', 'g', [[7, 11], [7, 18]]),
    wire('com_ho', 'seg_ho', 'com', 'gnd1', 'g', [[15, 11], [15, 18]]),
    wire('com_mt', 'seg_mt', 'com', 'gnd1', 'g', [[25, 11], [25, 18]]),
    wire('com_mo', 'seg_mo', 'com', 'gnd1', 'g', [[33, 11], [33, 18]]),
    wire('com_st', 'seg_st', 'com', 'gnd1', 'g', [[43, 11], [43, 18]]),
    wire('com_so', 'seg_so', 'com', 'gnd1', 'g', [[51, 11], [51, 18]]),

    // Segment wires for each digit (7 per digit × 6 digits = 42 wires)
    // Generated by the helper function
    ...digitSegWires('ht', 2, 'seg_ht', 3),
    ...digitSegWires('ho', 10, 'seg_ho', 11),
    ...digitSegWires('mt', 20, 'seg_mt', 21),
    ...digitSegWires('mo', 28, 'seg_mo', 29),
    ...digitSegWires('st', 38, 'seg_st', 39),
    ...digitSegWires('so', 46, 'seg_so', 47),
  ],
};

// ----- Example 10b: 555 Timer Clock (HH:MM:SS) -----
// A complete 6-digit HH:MM:SS clock using a 555 timer as the 1Hz oscillator
// instead of a crystal pulse source. This is a fundamentally different approach:
// the 555 generates the clock through analog RC charging/discharging, while
// the existing Digital Clock uses a crystal (digital resonance).
//
// 555 astable wiring:
//   VCC → R1(47k) → DIS → R2(47k) → THR+TRIG → C(10µF) → GND
//   f = 1.44 / ((R1 + 2*R2) * C) ≈ 1.02 Hz
//   RST → VCC (disabled), CTRL → open (internal 2/3 VCC)
//   OUT → CD4026 chain CLK
//
// The CD4026 counter chain and 7-segment displays are identical to the
// crystal-based Digital Clock — only the clock source differs.
export const example555Clock: CircuitDocument = {
  version: 1,
  components: [
    // 555 timer + RC network (top-right, above the CD4026 chain)
    // Astable mode: 555 computes its output from R1/R2/C parameters directly
    // (the external R1/R2/C are still wired for visual authenticity)
    comp('timer555', 't555', [50, 0], 0, { vcc: 5, astable: true, r1: 47000, r2: 47000, c: 1e-5 }),
    comp('resistor', 'r1', [58, 0], 0, { resistance: 47000 }),   // R1 = 47kΩ
    comp('resistor', 'r2', [58, 4], 0, { resistance: 47000 }),   // R2 = 47kΩ
    comp('capacitor', 'c1', [62, 4], 0, { capacitance: 1e-5 }),  // C = 10µF
    // Power supply
    comp('dcVoltage', 'vcc1', [54, 8], 0, { voltage: 5 }),
    comp('ground', 'gnd1', [25, 18], 0, {}),
    // 6 CD4026 decade counters (same chain as the crystal-based clock)
    comp('cd4026', 'ic_ht', [2, 2], 0, { maxCount: 3, vcc: 5 }),
    comp('cd4026', 'ic_ho', [10, 2], 0, { maxCount: 10, vcc: 5 }),
    comp('cd4026', 'ic_mt', [20, 2], 0, { maxCount: 6, vcc: 5 }),
    comp('cd4026', 'ic_mo', [28, 2], 0, { maxCount: 10, vcc: 5 }),
    comp('cd4026', 'ic_st', [38, 2], 0, { maxCount: 6, vcc: 5 }),
    comp('cd4026', 'ic_so', [46, 2], 0, { maxCount: 10, vcc: 5 }),
    // 6 seven-segment displays
    comp('sevenSegment', 'seg_ht', [3, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_ho', [11, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_mt', [21, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_mo', [29, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_st', [39, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_so', [47, 8], 0, { color: 'green', threshold: 2.0 }),
  ],
  wires: [
    // ── 555 astable wiring ──────────────────────────────────────────────
    // VCC → R1.a (same node as 555.vcc)
    wire('w_vcc_r1', 'vcc1', 'p', 'r1', 'a'),
    // 555.vcc → VCC node (power the 555)
    wire('w_vcc_555', 'vcc1', 'p', 't555', 'vcc'),
    // R1.b → 555.dis (DIS node: R1.b, 555.dis, R2.a)
    wire('w_r1_dis', 'r1', 'b', 't555', 'dis'),
    // 555.dis → R2.a (R2.a also on DIS node)
    wire('w_dis_r2', 't555', 'dis', 'r2', 'a'),
    // R2.b → 555.thr (THR node: R2.b, 555.thr, 555.trig, C.a)
    wire('w_r2_thr', 'r2', 'b', 't555', 'thr'),
    // 555.thr → 555.trig (join THR and TRIG for astable mode)
    wire('w_thr_trig', 't555', 'thr', 't555', 'trig'),
    // 555.thr → C.a (C.a also on THR node)
    wire('w_thr_c', 't555', 'thr', 'c1', 'a'),
    // C.b → GND
    wire('w_c_gnd', 'c1', 'b', 'gnd1', 'g', [[64, 18]]),
    // 555.rst → VCC (tie RST high to disable reset)
    wire('w_rst_vcc', 't555', 'rst', 'vcc1', 'p'),
    // 555.gnd → GND
    wire('w_555_gnd', 't555', 'gnd', 'gnd1', 'g', [[50, 18]]),
    // 555.out → sec-ones CLK (clock signal to the counter chain)
    wire('w_555_clk', 't555', 'out', 'ic_so', 'clk', [[56, 1], [46, 1]]),
    // VCC return path
    wire('w_vcc_gnd', 'vcc1', 'n', 'gnd1', 'g', [[55, 18]]),

    // ── CD4026 carry chain (same as crystal-based clock) ───────────────
    wire('co_so_st', 'ic_so', 'co', 'ic_st', 'clk', [[52, 4], [38, 4], [38, 1], [44, 1]]),
    wire('co_st_mo', 'ic_st', 'co', 'ic_mo', 'clk', [[44, 4], [28, 4], [28, 1], [34, 1]]),
    wire('co_mo_mt', 'ic_mo', 'co', 'ic_mt', 'clk', [[34, 4], [20, 4], [20, 1], [26, 1]]),
    wire('co_mt_ho', 'ic_mt', 'co', 'ic_ho', 'clk', [[26, 4], [10, 4], [10, 1], [16, 1]]),
    wire('co_ho_ht', 'ic_ho', 'co', 'ic_ht', 'clk', [[16, 4], [2, 4], [2, 1], [8, 1]]),

    // VCC for all CD4026s
    wire('vcc_ht', 'vcc1', 'p', 'ic_ht', 'vcc'),
    wire('vcc_ho', 'vcc1', 'p', 'ic_ho', 'vcc'),
    wire('vcc_mt', 'vcc1', 'p', 'ic_mt', 'vcc'),
    wire('vcc_mo', 'vcc1', 'p', 'ic_mo', 'vcc'),
    wire('vcc_st', 'vcc1', 'p', 'ic_st', 'vcc'),
    wire('vcc_so', 'vcc1', 'p', 'ic_so', 'vcc'),

    // GND for all CD4026s
    wire('gnd_ht', 'ic_ht', 'gnd', 'gnd1', 'g', [[7, 18]]),
    wire('gnd_ho', 'ic_ho', 'gnd', 'gnd1', 'g', [[15, 18]]),
    wire('gnd_mt', 'ic_mt', 'gnd', 'gnd1', 'g', [[25, 18]]),
    wire('gnd_mo', 'ic_mo', 'gnd', 'gnd1', 'g', [[33, 18]]),
    wire('gnd_st', 'ic_st', 'gnd', 'gnd1', 'g', [[43, 18]]),
    wire('gnd_so', 'ic_so', 'gnd', 'gnd1', 'g', [[51, 18]]),

    // RST for all CD4026s (tied to ground)
    wire('rst_ht', 'ic_ht', 'rst', 'gnd1', 'g', [[2, 18]]),
    wire('rst_ho', 'ic_ho', 'rst', 'gnd1', 'g', [[10, 18]]),
    wire('rst_mt', 'ic_mt', 'rst', 'gnd1', 'g', [[20, 18]]),
    wire('rst_mo', 'ic_mo', 'rst', 'gnd1', 'g', [[28, 18]]),
    wire('rst_st', 'ic_st', 'rst', 'gnd1', 'g', [[38, 18]]),
    wire('rst_so', 'ic_so', 'rst', 'gnd1', 'g', [[46, 18]]),

    // COM for all 7-seg displays → ground
    wire('com_ht', 'seg_ht', 'com', 'gnd1', 'g', [[7, 11], [7, 18]]),
    wire('com_ho', 'seg_ho', 'com', 'gnd1', 'g', [[15, 11], [15, 18]]),
    wire('com_mt', 'seg_mt', 'com', 'gnd1', 'g', [[25, 11], [25, 18]]),
    wire('com_mo', 'seg_mo', 'com', 'gnd1', 'g', [[33, 11], [33, 18]]),
    wire('com_st', 'seg_st', 'com', 'gnd1', 'g', [[43, 11], [43, 18]]),
    wire('com_so', 'seg_so', 'com', 'gnd1', 'g', [[51, 11], [51, 18]]),

    // Segment wires for each digit (7 per digit × 6 digits = 42 wires)
    ...digitSegWires('ht', 2, 'seg_ht', 3),
    ...digitSegWires('ho', 10, 'seg_ho', 11),
    ...digitSegWires('mt', 20, 'seg_mt', 21),
    ...digitSegWires('mo', 28, 'seg_mo', 29),
    ...digitSegWires('st', 38, 'seg_st', 39),
    ...digitSegWires('so', 46, 'seg_so', 47),
  ],
};

// ----- Example 10d: Arduino Clock (HH:MM:SS) — Multiplexed -----
// A complete 6-digit HH:MM:SS clock driven by a SINGLE Arduino in clock mode.
// Uses multiplexing: 7 shared segment lines (D2-D8) + 6 digit-select lines
// (D9-D13, A0) = 13 pins total. The 7-seg displays LATCH their state, so all
// 6 displays show their correct values even though only one is refreshed per step.
//
// The Arduino in clockMode automatically:
//   1. Tracks sim.time → hours, minutes, seconds
//   2. Cycles through 6 displays (one per step)
//   3. Drives the active display's segments + com pin
//
// Total: 8 components (1 Arduino + 6 displays + 1 ground), ~20 wires
// — MUCH simpler than 6-CD4026 designs (15 components, 74 wires).
export const exampleArduinoClockHHMMSS: CircuitDocument = {
  version: 1,
  components: [
    comp('arduinoReal', 'ard1', [2, 4], 0, {
      clockMode: true,
      vcc: 5,
      sketch: '// Clock mode — Arduino auto-drives 6 multiplexed 7-seg displays',
    }),
    // 6 seven-segment displays (cyan) — all share 7 segment lines via resistors
    comp('sevenSegment', 'seg_h1', [14, 4], 0, { color: 'cyan', threshold: 2.0 }),   // hours tens
    comp('sevenSegment', 'seg_h2', [22, 4], 0, { color: 'cyan', threshold: 2.0 }),   // hours ones
    comp('sevenSegment', 'seg_m1', [30, 4], 0, { color: 'cyan', threshold: 2.0 }),   // minutes tens
    comp('sevenSegment', 'seg_m2', [38, 4], 0, { color: 'cyan', threshold: 2.0 }),   // minutes ones
    comp('sevenSegment', 'seg_s1', [46, 4], 0, { color: 'cyan', threshold: 2.0 }),   // seconds tens
    comp('sevenSegment', 'seg_s2', [54, 4], 0, { color: 'cyan', threshold: 2.0 }),   // seconds ones
    comp('ground', 'gnd1', [3, 18], 0, {}),
  ],
  wires: [
    // Arduino ground
    wire('wg', 'ard1', 'gnd', 'gnd1', 'g', [[3, 18]]),
    // ── Shared segment lines (D2-D8 → all 6 displays' segment pins) ────
    // Each segment line connects to ALL 6 displays' corresponding segment pin.
    // D2 → a of all 6 displays
    wire('wa_h1', 'ard1', 'd2', 'seg_h1', 'a'),
    wire('wa_h2', 'seg_h1', 'a', 'seg_h2', 'a'),
    wire('wa_m1', 'seg_h2', 'a', 'seg_m1', 'a'),
    wire('wa_m2', 'seg_m1', 'a', 'seg_m2', 'a'),
    wire('wa_s1', 'seg_m2', 'a', 'seg_s1', 'a'),
    wire('wa_s2', 'seg_s1', 'a', 'seg_s2', 'a'),
    // D3 → b of all 6 displays
    wire('wb_h1', 'ard1', 'd3', 'seg_h1', 'b'),
    wire('wb_h2', 'seg_h1', 'b', 'seg_h2', 'b'),
    wire('wb_m1', 'seg_h2', 'b', 'seg_m1', 'b'),
    wire('wb_m2', 'seg_m1', 'b', 'seg_m2', 'b'),
    wire('wb_s1', 'seg_m2', 'b', 'seg_s1', 'b'),
    wire('wb_s2', 'seg_s1', 'b', 'seg_s2', 'b'),
    // D4 → c
    wire('wc_h1', 'ard1', 'd4', 'seg_h1', 'c'),
    wire('wc_h2', 'seg_h1', 'c', 'seg_h2', 'c'),
    wire('wc_m1', 'seg_h2', 'c', 'seg_m1', 'c'),
    wire('wc_m2', 'seg_m1', 'c', 'seg_m2', 'c'),
    wire('wc_s1', 'seg_m2', 'c', 'seg_s1', 'c'),
    wire('wc_s2', 'seg_s1', 'c', 'seg_s2', 'c'),
    // D5 → d
    wire('wd_h1', 'ard1', 'd5', 'seg_h1', 'd'),
    wire('wd_h2', 'seg_h1', 'd', 'seg_h2', 'd'),
    wire('wd_m1', 'seg_h2', 'd', 'seg_m1', 'd'),
    wire('wd_m2', 'seg_m1', 'd', 'seg_m2', 'd'),
    wire('wd_s1', 'seg_m2', 'd', 'seg_s1', 'd'),
    wire('wd_s2', 'seg_s1', 'd', 'seg_s2', 'd'),
    // D6 → e
    wire('we_h1', 'ard1', 'd6', 'seg_h1', 'e'),
    wire('we_h2', 'seg_h1', 'e', 'seg_h2', 'e'),
    wire('we_m1', 'seg_h2', 'e', 'seg_m1', 'e'),
    wire('we_m2', 'seg_m1', 'e', 'seg_m2', 'e'),
    wire('we_s1', 'seg_m2', 'e', 'seg_s1', 'e'),
    wire('we_s2', 'seg_s1', 'e', 'seg_s2', 'e'),
    // D7 → f
    wire('wf_h1', 'ard1', 'd7', 'seg_h1', 'f'),
    wire('wf_h2', 'seg_h1', 'f', 'seg_h2', 'f'),
    wire('wf_m1', 'seg_h2', 'f', 'seg_m1', 'f'),
    wire('wf_m2', 'seg_m1', 'f', 'seg_m2', 'f'),
    wire('wf_s1', 'seg_m2', 'f', 'seg_s1', 'f'),
    wire('wf_s2', 'seg_s1', 'f', 'seg_s2', 'f'),
    // D8 → g
    wire('wg_h1', 'ard1', 'd8', 'seg_h1', 'g'),
    wire('wg_h2', 'seg_h1', 'g', 'seg_h2', 'g'),
    wire('wg_m1', 'seg_h2', 'g', 'seg_m1', 'g'),
    wire('wg_m2', 'seg_m1', 'g', 'seg_m2', 'g'),
    wire('wg_s1', 'seg_m2', 'g', 'seg_s1', 'g'),
    wire('wg_s2', 'seg_s1', 'g', 'seg_s2', 'g'),
    // ── Digit-select lines (D9-D13, A0 → each display's `com`) ─────────
    // Active display: com=LOW (0V). Inactive: com=HIGH (5V).
    wire('com_h1', 'ard1', 'd9', 'seg_h1', 'com'),
    wire('com_h2', 'ard1', 'd10', 'seg_h2', 'com'),
    wire('com_m1', 'ard1', 'd11', 'seg_m1', 'com'),
    wire('com_m2', 'ard1', 'd12', 'seg_m2', 'com'),
    wire('com_s1', 'ard1', 'd13', 'seg_s1', 'com'),
    wire('com_s2', 'ard1', 'a0', 'seg_s2', 'com'),
  ],
};

// ----- Example 10c: Arduino Clock (MM:SS) -----
// A 2-digit MM:SS clock driven by a single Arduino — no counter ICs needed.
// The Arduino tracks time in software (via the sketch) and drives two 7-segment
// displays directly through 220Ω current-limiting resistors.
//
// Pin mapping:
//   Display 1 (minutes):  a=D2, b=D3, c=D4, d=D5, e=D6, f=D7, g=D8
//   Display 2 (seconds):  a=D9, b=D10, c=D11, d=D12, e=D13, f=A0, g=A1
//
// The sketch counts 0-59 on minutes and 0-59 on seconds. Each digit pattern
// is set by 7 consecutive pin assignments (one per segment).
//
// Total: 18 components (1 Arduino + 14 resistors + 2 displays + 1 ground)
//        ~30 wires — simpler than 6-CD4026 designs (15 components, 74 wires).
function segAssignments(prefix: 'm' | 's', pins: string[]): string[] {
  // Generate 7 pin-assignment lines for a digit's segments a-g.
  // pins = [a, b, c, d, e, f, g] pin names
  return pins.map((pin, i) => `${pin} = SEG_${prefix}_${i}`);
}

export const exampleArduinoClock: CircuitDocument = {
  version: 1,
  components: [
    comp('arduinoReal', 'ard1', [2, 4], 0, {
      sketch: `// Arduino MM:SS clock — drives 2x 7-segment displays
// Minutes: a=D2 b=D3 c=D4 d=D5 e=D6 f=D7 g=D8
// Seconds: a=D9 b=D10 c=D11 d=D12 e=D13 f=A0 g=A1
loop:
// === 00:00 ===
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = HIGH
D6 = HIGH
D7 = HIGH
D8 = LOW
D9 = HIGH
D10 = HIGH
D11 = HIGH
D12 = HIGH
D13 = HIGH
A0 = HIGH
A1 = LOW
wait 500ms
// === 00:01 ===
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = HIGH
D6 = HIGH
D7 = HIGH
D8 = LOW
D9 = LOW
D10 = HIGH
D11 = HIGH
D12 = LOW
D13 = LOW
A0 = LOW
A1 = LOW
wait 500ms
// === 00:02 ===
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = HIGH
D6 = HIGH
D7 = HIGH
D8 = LOW
D9 = HIGH
D10 = HIGH
D11 = LOW
D12 = HIGH
D13 = HIGH
A0 = LOW
A1 = HIGH
wait 500ms
// === 00:03 ===
D2 = HIGH
D3 = HIGH
D4 = HIGH
D5 = HIGH
D6 = HIGH
D7 = HIGH
D8 = LOW
D9 = HIGH
D10 = HIGH
D11 = HIGH
D12 = HIGH
D13 = LOW
A0 = LOW
A1 = HIGH
wait 500ms
goto loop`,
      vcc: 5,
    }),
    // 7 resistors for minutes display (220Ω current limiting)
    comp('resistor', 'rm_a', [14, 4], 0, { resistance: 220 }),
    comp('resistor', 'rm_b', [14, 6], 0, { resistance: 220 }),
    comp('resistor', 'rm_c', [14, 8], 0, { resistance: 220 }),
    comp('resistor', 'rm_d', [14, 10], 0, { resistance: 220 }),
    comp('resistor', 'rm_e', [14, 12], 0, { resistance: 220 }),
    comp('resistor', 'rm_f', [14, 14], 0, { resistance: 220 }),
    comp('resistor', 'rm_g', [14, 16], 0, { resistance: 220 }),
    // 7 resistors for seconds display
    comp('resistor', 'rs_a', [26, 4], 0, { resistance: 220 }),
    comp('resistor', 'rs_b', [26, 6], 0, { resistance: 220 }),
    comp('resistor', 'rs_c', [26, 8], 0, { resistance: 220 }),
    comp('resistor', 'rs_d', [26, 10], 0, { resistance: 220 }),
    comp('resistor', 'rs_e', [26, 12], 0, { resistance: 220 }),
    comp('resistor', 'rs_f', [26, 14], 0, { resistance: 220 }),
    comp('resistor', 'rs_g', [26, 16], 0, { resistance: 220 }),
    // 2 seven-segment displays
    comp('sevenSegment', 'seg_m', [18, 4], 0, { color: 'cyan', threshold: 2.0 }),
    comp('sevenSegment', 'seg_s', [30, 4], 0, { color: 'cyan', threshold: 2.0 }),
    comp('ground', 'gnd1', [3, 22], 0, {}),
  ],
  wires: [
    // Arduino ground
    wire('wg', 'ard1', 'gnd', 'gnd1', 'g', [[3, 22]]),
    // Minutes: D2-D8 → resistors → seg_m
    wire('wm1a', 'ard1', 'd2', 'rm_a', 'a'),
    wire('wm1b', 'ard1', 'd3', 'rm_b', 'a'),
    wire('wm1c', 'ard1', 'd4', 'rm_c', 'a'),
    wire('wm1d', 'ard1', 'd5', 'rm_d', 'a'),
    wire('wm1e', 'ard1', 'd6', 'rm_e', 'a'),
    wire('wm1f', 'ard1', 'd7', 'rm_f', 'a'),
    wire('wm1g', 'ard1', 'd8', 'rm_g', 'a'),
    // Minutes resistors → seg_m (a at 18, b at 20, c at 22, d at 22, e at 20, f at 18, g at 18)
    wire('wm2a', 'rm_a', 'b', 'seg_m', 'a', [[18, 5]]),
    wire('wm2b', 'rm_b', 'b', 'seg_m', 'b', [[18, 5], [20, 5]]),
    wire('wm2c', 'rm_c', 'b', 'seg_m', 'c', [[18, 5], [22, 5]]),
    wire('wm2g', 'rm_g', 'b', 'seg_m', 'g', [[20, 9], [20, 7]]),
    wire('wm2d', 'rm_d', 'b', 'seg_m', 'd', [[22, 10]]),
    wire('wm2e', 'rm_e', 'b', 'seg_m', 'e', [[20, 10]]),
    wire('wm2f', 'rm_f', 'b', 'seg_m', 'f', [[18, 10]]),
    // seg_m common → ground
    wire('wmcom', 'seg_m', 'com', 'gnd1', 'g', [[22, 7], [22, 22]]),

    // Seconds: D9-D13, A0, A1 → resistors → seg_s
    wire('ws1a', 'ard1', 'd9', 'rs_a', 'a'),
    wire('ws1b', 'ard1', 'd10', 'rs_b', 'a'),
    wire('ws1c', 'ard1', 'd11', 'rs_c', 'a'),
    wire('ws1d', 'ard1', 'd12', 'rs_d', 'a'),
    wire('ws1e', 'ard1', 'd13', 'rs_e', 'a'),
    wire('ws1f', 'ard1', 'a0', 'rs_f', 'a'),
    wire('ws1g', 'ard1', 'a1', 'rs_g', 'a'),
    // Seconds resistors → seg_s (a at 30, b at 32, c at 34, d at 34, e at 32, f at 30, g at 30)
    wire('ws2a', 'rs_a', 'b', 'seg_s', 'a', [[30, 5]]),
    wire('ws2b', 'rs_b', 'b', 'seg_s', 'b', [[30, 5], [32, 5]]),
    wire('ws2c', 'rs_c', 'b', 'seg_s', 'c', [[30, 5], [34, 5]]),
    wire('ws2g', 'rs_g', 'b', 'seg_s', 'g', [[32, 9], [32, 7]]),
    wire('ws2d', 'rs_d', 'b', 'seg_s', 'd', [[34, 10]]),
    wire('ws2e', 'rs_e', 'b', 'seg_s', 'e', [[32, 10]]),
    wire('ws2f', 'rs_f', 'b', 'seg_s', 'f', [[30, 10]]),
    // seg_s common → ground
    wire('wscom', 'seg_s', 'com', 'gnd1', 'g', [[34, 7], [34, 22]]),
  ],
};

// ----- Example 10: Simple Seconds Counter (0-99) -----
// A minimalist 2-digit counter using only 2 CD4026 chips (vs 6 in the full clock).
// Architecture:
//   1Hz crystal → CD4026 ones (0-9) → CO → CD4026 tens (0-9) → 7-seg displays
//
// The ones counter increments on each clock pulse. When it wraps from 9→0,
// its CO output produces a rising edge that clocks the tens counter. Both
// counters use maxCount=10, giving a 00-99 range (counts 00→01→...→99→00).
//
// Total: 7 components, ~25 wires (vs 15 components, 74 wires for the 6-digit clock).
export const exampleSimpleClock: CircuitDocument = {
  version: 1,
  components: [
    // 1Hz crystal oscillator — drives the ones counter
    comp('pulseSource', 'xtal', [32, 2], 0, { high: 5, low: 0, frequency: 1, duty: 50 }),
    // 5V power supply
    comp('dcVoltage', 'vcc1', [32, 8], 0, { voltage: 5 }),
    comp('ground', 'gnd1', [16, 18], 0, {}),
    // CD4026 #1 — ones digit (counts 0-9)
    comp('cd4026', 'ic_so', [10, 2], 0, { maxCount: 10, vcc: 5 }),
    // CD4026 #2 — tens digit (counts 0-9, carries from ones)
    comp('cd4026', 'ic_st', [22, 2], 0, { maxCount: 10, vcc: 5 }),
    // 7-segment displays (green) — offset by 1 from CD4026 to center segments
    comp('sevenSegment', 'seg_so', [11, 8], 0, { color: 'green', threshold: 2.0 }),
    comp('sevenSegment', 'seg_st', [23, 8], 0, { color: 'green', threshold: 2.0 }),
  ],
  wires: [
    // Crystal → ones counter CLK
    wire('clk_xtal_so', 'xtal', 'p', 'ic_so', 'clk', [[33, 1], [10, 1]]),
    wire('xtal_gnd', 'xtal', 'n', 'gnd1', 'g', [[33, 18]]),
    // Carry chain: ones CO → tens CLK
    wire('co_so_st', 'ic_so', 'co', 'ic_st', 'clk', [[16, 1], [22, 1]]),
    // VCC for both CD4026s
    wire('vcc_so', 'vcc1', 'p', 'ic_so', 'vcc', [[33, 3], [11, 3]]),
    wire('vcc_st', 'vcc1', 'p', 'ic_st', 'vcc', [[33, 3], [23, 3]]),
    wire('vcc_gnd', 'vcc1', 'n', 'gnd1', 'g', [[33, 18]]),
    // GND for both CD4026s
    wire('gnd_so', 'ic_so', 'gnd', 'gnd1', 'g', [[15, 18]]),
    wire('gnd_st', 'ic_st', 'gnd', 'gnd1', 'g', [[27, 18]]),
    // RST for both CD4026s (tied to ground — no reset)
    wire('rst_so', 'ic_so', 'rst', 'gnd1', 'g', [[10, 18]]),
    wire('rst_st', 'ic_st', 'rst', 'gnd1', 'g', [[22, 18]]),
    // 7-seg COM → ground (com terminal at x=segCx+4, y=11)
    wire('com_so', 'seg_so', 'com', 'gnd1', 'g', [[15, 11], [15, 18]]),
    wire('com_st', 'seg_st', 'com', 'gnd1', 'g', [[27, 11], [27, 18]]),
    // Segment wires (7 per digit × 2 digits = 14 wires)
    ...digitSegWires('so', 10, 'seg_so', 11),
    ...digitSegWires('st', 22, 'seg_st', 23),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// NEW EXAMPLES — covering more components
// ─────────────────────────────────────────────────────────────────────────────

// ----- RL High-pass Filter -----
// Inductor in series with signal, resistor to ground. High frequencies pass
// through the inductor (low impedance), low frequencies are blocked.
// Components: acVoltage, inductor, resistor, oscilloscope ×2, ground
export const exampleRLHighPass: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'v1', [4, 6], 0, { amplitude: 5, frequency: 1000, offset: 0, phase: 0 }),
    comp('inductor', 'l1', [10, 6], 0, { inductance: 0.01 }),
    comp('resistor', 'r1', [16, 6], 0, { resistance: 100 }),
    comp('oscilloscope', 'scIn', [4, 2], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [18, 2], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [5, 12], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'l1', 'a', [[5, 7]]),
    wire('w2', 'v1', 'p', 'scIn', 'p', [[5, 3]]),
    wire('w3', 'scIn', 'n', 'gnd1', 'g', [[5, 3], [5, 12]]),
    wire('w4', 'l1', 'b', 'r1', 'a'),
    wire('w5', 'r1', 'b', 'gnd1', 'g', [[20, 7], [20, 12], [5, 12]]),
    wire('w6', 'r1', 'a', 'scOut', 'p', [[18, 3]]),
    wire('w7', 'scOut', 'n', 'gnd1', 'g', [[19, 3], [19, 12], [5, 12]]),
    wire('w8', 'v1', 'n', 'gnd1', 'g', [[5, 12]]),
  ],
};

// ----- Diode Half-wave Rectifier -----
// AC source → diode → resistor → ground. Only positive half-cycles pass.
// Components: acVoltage, diode, resistor, oscilloscope ×2, ground
export const exampleDiodeRectifier: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'v1', [4, 6], 0, { amplitude: 5, frequency: 100, offset: 0, phase: 0 }),
    comp('diode', 'd1', [10, 6], 0, { forwardV: 0.7, onR: 1, offR: 1e7 }),
    comp('resistor', 'r1', [16, 6], 0, { resistance: 1000 }),
    comp('oscilloscope', 'scIn', [4, 2], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [18, 2], 0, { color: '#22d3ee', label: 'Out' }),
    comp('ground', 'gnd1', [5, 12], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'd1', 'a', [[5, 7]]),
    wire('w2', 'v1', 'p', 'scIn', 'p', [[5, 3]]),
    wire('w3', 'scIn', 'n', 'gnd1', 'g', [[5, 3], [5, 12]]),
    wire('w4', 'd1', 'k', 'r1', 'a'),
    wire('w5', 'r1', 'b', 'gnd1', 'g', [[20, 7], [20, 12], [5, 12]]),
    wire('w6', 'r1', 'a', 'scOut', 'p', [[18, 3]]),
    wire('w7', 'scOut', 'n', 'gnd1', 'g', [[19, 3], [19, 12], [5, 12]]),
    wire('w8', 'v1', 'n', 'gnd1', 'g', [[5, 12]]),
  ],
};

// ----- Voltage Divider with Potentiometer -----
// Uses a potentiometer as a variable voltage divider. A load resistor draws
// current so flow dots are visible. Voltmeter reads the wiper voltage.
// Components: dcVoltage, potentiometer, resistor, voltmeter, ground
export const exampleVoltageDivider: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 6], 0, { voltage: 5 }),
    comp('potentiometer', 'pot1', [10, 6], 0, { resistance: 10000, wiper: 50 }),
    comp('resistor', 'r1', [16, 6], 0, { resistance: 10000 }),  // load resistor
    comp('voltmeter', 'vm1', [22, 4], 0, {}),
    comp('ground', 'gnd1', [5, 12], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'pot1', 'a', [[5, 7], [10, 7]]),
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 12]]),
    wire('w3', 'pot1', 'b', 'gnd1', 'g', [[14, 7], [14, 12], [5, 12]]),
    // Wiper → load resistor → ground (draws current)
    wire('w4', 'pot1', 'w', 'r1', 'a', [[12, 5], [12, 5], [16, 5]]),
    wire('w5', 'r1', 'b', 'gnd1', 'g', [[20, 7], [20, 12], [5, 12]]),
    // Voltmeter measures across the load (parallel, high impedance)
    wire('w6', 'r1', 'a', 'vm1', 'p', [[16, 3], [22, 3]]),
    wire('w7', 'vm1', 'n', 'gnd1', 'g', [[24, 5], [24, 12], [5, 12]]),
  ],
};

// ----- PNP Transistor Switch -----
// PNP high-side switch. Emitter at VCC, collector → load → GND.
// When button is pressed, base is pulled LOW, turning the PNP ON.
// Components: dcVoltage, pushButton, resistor ×2, pnp, led, ground
export const examplePnpSwitch: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 4], 0, { voltage: 5 }),
    comp('pushButton', 'btn1', [4, 16], 0, { pressed: true }),
    comp('resistor', 'rb', [10, 16], 0, { resistance: 10000 }),
    comp('resistor', 'rc', [22, 8], 0, { resistance: 1000 }),
    comp('pnp', 'q1', [16, 8], 0, { hfe: 100, veb: 0.7, satV: 0.2 }),
    comp('led', 'led1', [28, 8], 0, { color: 'blue', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [5, 22], 0, {}),
  ],
  wires: [
    // Emitter → VCC (PNP high-side: emitter at top, connected to V+)
    wire('w1', 'v1', 'p', 'q1', 'e', [[5, 5], [16, 5]]),
    // Collector → load resistor → LED → GND
    wire('w3', 'q1', 'c', 'rc', 'a'),
    wire('w4', 'rc', 'b', 'led1', 'a'),
    wire('w5', 'led1', 'k', 'gnd1', 'g', [[32, 9], [32, 22], [5, 22]]),
    // Base: button → Rb → base. When button pressed, base → GND (LOW) → PNP ON
    wire('w6', 'btn1', 'a', 'gnd1', 'g', [[5, 17], [5, 22]]),
    wire('w7', 'btn1', 'b', 'rb', 'a'),
    wire('w8', 'rb', 'b', 'q1', 'b', [[14, 17], [16, 17], [16, 10]]),
    // V1 negative → ground
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 8], [5, 22]]),
  ],
};

// ----- Current Source Circuit -----
// Demonstrates a current source driving a resistor. Ammeter measures the
// current through the resistor.
// Components: currentSource, resistor, ammeter, ground
export const exampleCurrentSource: CircuitDocument = {
  version: 1,
  components: [
    comp('currentSource', 'i1', [4, 6], 0, { current: 0.01 }),
    comp('ammeter', 'am1', [10, 6], 0, {}),
    comp('resistor', 'r1', [14, 6], 0, { resistance: 500 }),
    comp('ground', 'gnd1', [5, 12], 0, {}),
  ],
  wires: [
    wire('w1', 'i1', 'p', 'am1', 'p'),
    wire('w2', 'am1', 'n', 'r1', 'a'),
    wire('w3', 'r1', 'b', 'gnd1', 'g', [[18, 7], [18, 12], [5, 12]]),
    wire('w4', 'i1', 'n', 'gnd1', 'g', [[5, 12]]),
  ],
};

// ----- Speaker Audio Driver -----
// Op-amp amplifies an AC audio signal and drives a speaker.
// Components: acVoltage, opamp, resistor ×2, speaker, ground, oscilloscope ×2
export const exampleSpeaker: CircuitDocument = {
  version: 1,
  components: [
    comp('acVoltage', 'v1', [4, 6], 0, { amplitude: 0.5, frequency: 440, offset: 0, phase: 0 }),  // A4 audio tone
    comp('opamp', 'op1', [12, 6], 0, { gain: 100 }),
    comp('resistor', 'rf', [16, 2], 0, { resistance: 10000 }),    // feedback
    comp('resistor', 'rin', [8, 10], 0, { resistance: 1000 }),    // input
    comp('speaker', 'spk1', [20, 6], 0, { impedance: 8 }),
    comp('ground', 'gnd1', [5, 14], 0, {}),
    comp('oscilloscope', 'scIn', [4, 2], 0, { color: '#f97316', label: 'In' }),
    comp('oscilloscope', 'scOut', [22, 2], 0, { color: '#22d3ee', label: 'Out' }),
  ],
  wires: [
    // v1.p → rin.a (input signal through Rin)
    wire('w1', 'v1', 'p', 'rin', 'a', [[5, 7], [5, 11], [8, 11]]),
    // v1.p → scIn.p (probe the input)
    wire('w1b', 'v1', 'p', 'scIn', 'p', [[5, 5], [4, 5]]),
    // scIn.n → ground
    wire('w1c', 'scIn', 'n', 'gnd1', 'g', [[6, 3], [6, 14], [5, 14]]),
    // rin.b → op1.in- (inverting input)
    wire('w2', 'rin', 'b', 'op1', 'in-', [[12, 11]]),
    // op1.in+ → ground (non-inverting input at ground reference)
    wire('w3', 'op1', 'in+', 'gnd1', 'g', [[12, 9], [12, 14], [5, 14]]),
    // op1.out → spk1.a (drive the speaker)
    wire('w4', 'op1', 'out', 'spk1', 'a'),
    // spk1.b → ground
    wire('w5', 'spk1', 'b', 'gnd1', 'g', [[23, 7], [23, 14], [5, 14]]),
    // v1.n → ground
    wire('w6', 'v1', 'n', 'gnd1', 'g', [[5, 14]]),
    // Feedback resistor: op1.out → rf.a, rf.b → op1.in- (same node as rin.b)
    wire('w7', 'op1', 'out', 'rf', 'a', [[16, 5], [16, 3]]),
    wire('w8', 'rf', 'b', 'op1', 'in-', [[16, 3], [12, 3], [12, 7]]),
    // Output scope probes the speaker node
    wire('w9', 'spk1', 'a', 'scOut', 'p', [[22, 5]]),
    wire('w10', 'scOut', 'n', 'gnd1', 'g', [[24, 5], [24, 14], [5, 14]]),
  ],
};

// ----- Photoresistor Light Sensor -----
// Photoresistor + fixed resistor form a voltage divider. As light increases,
// photoresistor resistance drops, changing the output voltage.
// Components: dcVoltage, photoresistor, resistor, voltmeter, ground
export const examplePhotoresistor: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 6], 0, { voltage: 5 }),
    comp('photoresistor', 'ldr1', [10, 6], 0, { darkR: 1000000, lightR: 1000, light: 0.5 }),
    comp('resistor', 'r1', [16, 6], 0, { resistance: 10000 }),
    comp('voltmeter', 'vm1', [16, 2], 0, {}),
    comp('ground', 'gnd1', [5, 12], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'ldr1', 'a', [[5, 7], [10, 7]]),
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 12]]),
    wire('w3', 'ldr1', 'b', 'r1', 'a'),
    wire('w4', 'r1', 'b', 'gnd1', 'g', [[20, 7], [20, 12], [5, 12]]),
    wire('w5', 'ldr1', 'b', 'vm1', 'p', [[14, 5], [14, 3], [16, 3]]),
    wire('w6', 'vm1', 'n', 'gnd1', 'g', [[18, 3], [18, 12], [5, 12]]),
  ],
};

// ----- Logic Gates Demo -----
// AND gate: output HIGH only when both inputs are HIGH. Two buttons drive
// the inputs; LED shows the output.
// Components: dcVoltage ×2, pushButton ×2, AND gate, resistor, LED, ground
export const exampleLogicGates: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'vA', [4, 4], 0, { voltage: 5 }),
    comp('dcVoltage', 'vB', [4, 10], 0, { voltage: 5 }),
    comp('pushButton', 'btnA', [8, 4], 0, { pressed: true }),
    comp('pushButton', 'btnB', [8, 10], 0, { pressed: true }),
    comp('and', 'g1', [14, 6], 0, { vcc: 5, threshold: 2.5 }),
    comp('resistor', 'r1', [20, 6], 0, { resistance: 330 }),
    comp('led', 'led1', [26, 6], 0, { color: 'green', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [5, 16], 0, {}),
  ],
  wires: [
    wire('w1', 'vA', 'p', 'btnA', 'a', [[5, 5]]),
    wire('w2', 'btnA', 'b', 'g1', 'a', [[12, 5]]),
    wire('w3', 'vB', 'p', 'btnB', 'a', [[5, 11]]),
    wire('w4', 'btnB', 'b', 'g1', 'b', [[12, 8], [12, 8]]),
    wire('w5', 'g1', 'y', 'r1', 'a'),
    wire('w6', 'r1', 'b', 'led1', 'a'),
    wire('w7', 'led1', 'k', 'gnd1', 'g', [[30, 7], [30, 16], [5, 16]]),
    wire('w8', 'vA', 'n', 'gnd1', 'g', [[5, 5], [5, 16]]),
    wire('w9', 'vB', 'n', 'gnd1', 'g', [[5, 11], [5, 16]]),
    wire('w10', 'g1', 'gnd', 'gnd1', 'g', [[16, 9], [16, 16], [5, 16]]),
  ],
};

// ----- Op-Amp Non-inverting Amplifier -----
// Non-inverting amplifier with gain = 1 + Rf/Rg. Uses opampRails with
// explicit V+/V- power connections.
// Components: dcVoltage ×2, acVoltage, opampRails, resistor ×2, voltmeter, ground
export const exampleOpampNonInverting: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'vcc', [4, 2], 0, { voltage: 12 }),
    comp('dcVoltage', 'vee', [4, 10], 0, { voltage: -12 }),
    comp('acVoltage', 'vin', [10, 6], 0, { amplitude: 0.5, frequency: 100, offset: 0, phase: 0 }),
    comp('opampRails', 'op1', [16, 6], 0, { gain: 1e5 }),
    comp('resistor', 'rf', [22, 2], 0, { resistance: 10000 }),
    comp('resistor', 'rg', [22, 10], 0, { resistance: 1000 }),
    comp('voltmeter', 'vm1', [26, 6], 0, {}),
    comp('ground', 'gnd1', [5, 16], 0, {}),
  ],
  wires: [
    // Power rails
    wire('w1', 'vcc', 'p', 'op1', 'v+', [[5, 3], [18, 3], [18, 6]]),
    wire('w2', 'vcc', 'n', 'gnd1', 'g', [[5, 4], [5, 16]]),
    wire('w3', 'vee', 'p', 'op1', 'v-', [[5, 11], [18, 11], [18, 10]]),
    wire('w4', 'vee', 'n', 'gnd1', 'g', [[5, 12], [5, 16]]),
    // Input
    wire('w5', 'vin', 'p', 'op1', 'in+', [[11, 7], [16, 7]]),
    wire('w6', 'vin', 'n', 'gnd1', 'g', [[11, 8], [11, 16], [5, 16]]),
    // Feedback network
    wire('w7', 'op1', 'out', 'rf', 'a', [[20, 7], [22, 3]]),
    wire('w8', 'rf', 'b', 'rg', 'a', [[22, 3], [22, 11]]),
    wire('w9', 'rg', 'b', 'gnd1', 'g', [[26, 11], [26, 16], [5, 16]]),
    wire('w10', 'rg', 'a', 'op1', 'in-', [[22, 11], [14, 11], [14, 8], [16, 8]]),
    // Output
    wire('w11', 'op1', 'out', 'vm1', 'p', [[20, 7], [26, 7]]),
    wire('w12', 'vm1', 'n', 'gnd1', 'g', [[28, 7], [28, 16], [5, 16]]),
  ],
};

// ----- VCO Frequency Sweep -----
// Voltage-controlled oscillator. DC voltage controls the output frequency.
// A load resistor draws current so flow dots are visible.
// Components: dcVoltage ×2, vco, resistor, oscilloscope, ground
export const exampleVCO: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 6], 0, { voltage: 2.5 }),
    comp('vco', 'vco1', [10, 6], 0, { baseFreq: 10, sensitivity: 100, vcc: 5 }),
    comp('dcVoltage', 'vcc', [4, 2], 0, { voltage: 5 }),
    comp('resistor', 'r1', [18, 6], 0, { resistance: 1000 }),  // load resistor (to ground)
    comp('oscilloscope', 'sc1', [24, 2], 0, { color: '#22d3ee', label: 'Out' }),  // probe only
    comp('ground', 'gnd1', [5, 12], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'vco1', 'in', [[5, 7], [10, 7]]),
    wire('w2', 'v1', 'n', 'gnd1', 'g', [[5, 12]]),
    wire('w3', 'vcc', 'p', 'vco1', 'vcc', [[5, 3], [12, 3], [12, 6]]),
    wire('w4', 'vcc', 'n', 'gnd1', 'g', [[5, 4], [5, 12]]),
    wire('w5', 'vco1', 'gnd', 'gnd1', 'g', [[12, 9], [12, 12], [5, 12]]),
    // VCO output → load resistor → ground (main current path)
    wire('w6', 'vco1', 'out', 'r1', 'a'),
    wire('w7', 'r1', 'b', 'gnd1', 'g', [[22, 7], [22, 12], [5, 12]]),
    // Oscilloscope probes the VCO output (high impedance, parallel to R1)
    wire('w8', 'vco1', 'out', 'sc1', 'p', [[16, 5], [16, 3], [24, 3]]),
    wire('w9', 'sc1', 'n', 'gnd1', 'g', [[26, 3], [26, 12], [5, 12]]),
  ],
};

// ----- Two-Stage Audio Amplifier with Tone Control -----
// A complete audio signal chain: pre-amp → tone control → power amp → speaker.
//
// Signal flow:
//   vSig (AC, 50mV @ 1kHz) → C1 (input coupling, blocks DC)
//     → Rin (input series R, limits base current)
//     → Q1 base, biased by R1/R2 divider (~4.5V mid-supply)
//     → Q1 common-emitter amplifier (Rc1 collector load, Re1 emitter)
//     → Rtone + Ctone passive RC low-pass (treble cut, fc ≈ 1.6kHz)
//     → C2 inter-stage coupling cap
//     → Q2 second common-emitter amplifier (gain from Rc2/Re2)
//     → C3 output coupling cap → 8Ω speaker
//
// Power: +9V single supply. Two NPN stages provide enough gain without needing
// an op-amp (avoids the op-amp model's rail-latching issue with capacitive load).
// Three oscilloscopes probe the input, post-stage-1, and the final output.
//
// Components used: dcVoltage, acVoltage, npn ×2, resistor ×8, capacitor ×5,
//   speaker, oscilloscope ×3, ground (17 components, 37 wires)
export const exampleAudioAmplifier: CircuitDocument = {
  version: 1,
  components: [
    // ── Power supply ───────────────────────────────────────────────────────
    comp('dcVoltage', 'vPos', [4, 4], 0, { voltage: 9 }),
    comp('acVoltage', 'vSig', [6, 8], 0, { amplitude: 0.05, frequency: 1000, offset: 0, phase: 0 }),
    comp('ground', 'gnd1', [5, 22], 0, {}),

    // ── Stage 1: NPN common-emitter pre-amplifier ─────────────────────────
    comp('capacitor', 'c1', [8, 8], 0, { capacitance: 1e-6, initialV: 0 }),
    comp('resistor', 'rin', [9, 4], 0, { resistance: 10000 }),   // 10k input series R
    comp('resistor', 'r1', [11, 4], 0, { resistance: 100000 }),   // 100k bias top
    comp('resistor', 'r2', [11, 12], 0, { resistance: 100000 }),  // 100k bias bottom
    comp('npn', 'q1', [14, 8], 0, { hfe: 50, vbe: 0.7, satV: 0.2 }),
    comp('resistor', 'rc1', [14, 4], 0, { resistance: 1000 }),     // 1k collector load
    comp('resistor', 're1', [14, 12], 0, { resistance: 1000 }),    // 1k emitter (gain ≈ Rc/Re = 1)
    // Ce1 bypass cap — boosts AC gain at lower frequencies (bass boost)
    comp('capacitor', 'ce1', [18, 12], 0, { capacitance: 1e-6, initialV: 0 }),

    // ── Tone control: passive RC low-pass (treble cut, fc ≈ 1.6kHz) ───────
    comp('resistor', 'rtone', [19, 8], 0, { resistance: 10000 }),
    comp('capacitor', 'ctone', [23, 12], 0, { capacitance: 10e-9, initialV: 0 }),

    // ── Inter-stage coupling cap ─────────────────────────────────────────
    comp('capacitor', 'c2', [23, 8], 0, { capacitance: 1e-6, initialV: 0 }),

    // ── Stage 2: NPN common-emitter power amplifier ───────────────────────
    comp('resistor', 'r3', [25, 4], 0, { resistance: 47000 }),    // 47k bias top
    comp('resistor', 'r4', [25, 12], 0, { resistance: 10000 }),    // 10k bias bottom (sets base ~1.6V)
    // Rin2: input resistor for Q2. The NPN model has zero base input resistance
    // (Vbe is modeled as an ideal voltage source), so without a series resistor
    // the AC signal from C2 would be clamped and unable to swing the base.
    // 1k is small enough to pass most of the signal but large enough to limit
    // base current and prevent saturation.
    comp('resistor', 'rin2', [26, 8], 0, { resistance: 1000 }),    // 1k Q2 input
    comp('npn', 'q2', [28, 8], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    comp('resistor', 'rc2', [28, 4], 0, { resistance: 1000 }),     // 1k collector (drives speaker via C3)
    comp('resistor', 're2', [28, 12], 0, { resistance: 100 }),    // 100Ω emitter (gain = Rc/Re = 10)

    // ── Output coupling + speaker ────────────────────────────────────────
    comp('capacitor', 'c3', [32, 8], 0, { capacitance: 100e-6, initialV: 0 }),
    comp('speaker', 'spk1', [35, 8], 0, { impedance: 8 }),

    // ── Oscilloscope probes ─────────────────────────────────────────────
    comp('oscilloscope', 'scIn', [4, 2], 0, { color: '#f97316', label: 'Input' }),
    comp('oscilloscope', 'scMid', [16, 2], 0, { color: '#fbbf24', label: 'Stage1' }),
    comp('oscilloscope', 'scOut', [35, 2], 0, { color: '#22d3ee', label: 'Output' }),
  ],
  wires: [
    // ── Power supply ───────────────────────────────────────────────────────
    // vPos.n → ground
    wire('w1', 'vPos', 'n', 'gnd1', 'g', [[5, 8], [5, 22]]),

    // ── Audio signal input ───────────────────────────────────────────────
    // vSig.p → scIn.p (probe the source)
    wire('w2', 'vSig', 'p', 'scIn', 'p', [[7, 3], [4, 3]]),
    // scIn.n → ground
    wire('w3', 'scIn', 'n', 'gnd1', 'g', [[6, 3], [6, 22], [5, 22]]),
    // vSig.n → ground
    wire('w4', 'vSig', 'n', 'gnd1', 'g', [[7, 12], [7, 22], [5, 22]]),
    // vSig.p → C1.a (signal into amplifier)
    wire('w5', 'vSig', 'p', 'c1', 'a'),

    // ── Stage 1: bias divider + transistor ──────────────────────────────
    wire('w6', 'c1', 'b', 'rin', 'a', [[12, 9], [9, 9]]),
    wire('w7', 'rin', 'b', 'q1', 'b', [[13, 9], [14, 10]]),
    wire('w8', 'r1', 'b', 'q1', 'b', [[15, 10], [14, 10]]),
    wire('w9', 'r1', 'a', 'vPos', 'p', [[11, 4]]),
    wire('w10', 'r2', 'a', 'q1', 'b', [[14, 13], [14, 10]]),
    wire('w11', 'r2', 'b', 'gnd1', 'g', [[15, 22]]),

    // ── Stage 1: collector & emitter ──────────────────────────────────────
    wire('w12', 'q1', 'c', 'rc1', 'b', [[18, 8], [18, 5]]),
    wire('w13', 'rc1', 'a', 'vPos', 'p', [[14, 4]]),
    wire('w14', 'q1', 'e', 're1', 'a', [[17, 13], [14, 13]]),
    wire('w15', 're1', 'b', 'gnd1', 'g', [[18, 22]]),
    wire('w16', 're1', 'a', 'ce1', 'a', [[18, 13]]),
    wire('w17', 'ce1', 'b', 'gnd1', 'g', [[22, 22]]),

    // ── Stage 1 → tone control ───────────────────────────────────────────
    wire('w18', 'q1', 'c', 'rtone', 'a', [[19, 8], [19, 9]]),
    wire('w19', 'rtone', 'b', 'c2', 'a'),
    wire('w20', 'ctone', 'a', 'rtone', 'b', [[23, 9]]),
    wire('w21', 'ctone', 'b', 'gnd1', 'g', [[27, 22]]),

    // Probe the post-stage-1 signal (mid-amplifier node)
    wire('w22', 'rtone', 'b', 'scMid', 'p', [[23, 3], [16, 3]]),
    wire('w23', 'scMid', 'n', 'gnd1', 'g', [[18, 3], [18, 22], [5, 22]]),

    // ── Stage 2: bias + transistor ───────────────────────────────────────
    // C2.b → Rin2.a (AC signal into Q2's input resistor)
    wire('w24', 'c2', 'b', 'rin2', 'a', [[27, 9]]),
    // Rin2.b → Q2.b (signal into base, on top of bias)
    wire('w24b', 'rin2', 'b', 'q2', 'b', [[28, 10]]),
    // R3.b → Q2.b (bias divider top half)
    wire('w25', 'r3', 'b', 'q2', 'b', [[29, 10], [28, 10]]),
    // R3.a → V+ rail
    wire('w26', 'r3', 'a', 'vPos', 'p', [[25, 4]]),
    // R4.a → Q2.b (bias divider bottom half)
    wire('w27', 'r4', 'a', 'q2', 'b', [[28, 13], [28, 10]]),
    // R4.b → ground
    wire('w28', 'r4', 'b', 'gnd1', 'g', [[29, 22]]),

    // Q2.c → Rc2.b (collector up to Rc2)
    wire('w29', 'q2', 'c', 'rc2', 'b', [[31, 8], [31, 5]]),
    // Rc2.a → V+ rail
    wire('w30', 'rc2', 'a', 'vPos', 'p', [[28, 4]]),
    // Q2.e → Re2.a (emitter to Re2)
    wire('w31', 'q2', 'e', 're2', 'a', [[31, 13], [28, 13]]),
    // Re2.b → ground
    wire('w32', 're2', 'b', 'gnd1', 'g', [[31, 22]]),

    // ── Output coupling → speaker ────────────────────────────────────────
    // Q2.c → C3.a (signal from collector through output coupling cap)
    wire('w33', 'q2', 'c', 'c3', 'a', [[32, 8], [31, 8]]),
    // C3.b → speaker.a
    wire('w34', 'c3', 'b', 'spk1', 'a', [[36, 9], [35, 9]]),
    // Speaker.b → ground
    wire('w35', 'spk1', 'b', 'gnd1', 'g', [[38, 9], [38, 22], [5, 22]]),

    // ── Output oscilloscope probe ────────────────────────────────────────
    wire('w36', 'spk1', 'a', 'scOut', 'p', [[35, 3]]),
    wire('w37', 'scOut', 'n', 'gnd1', 'g', [[37, 3], [37, 22], [5, 22]]),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Categorized example tree.
// Each category groups related circuits. To add a new example, just append
// it to the appropriate category array below.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExampleEntry {
  name: string;
  description: string;
  doc: CircuitDocument;
}

export interface ExampleCategory {
  label: string;
  examples: ExampleEntry[];
}

export const exampleCategories: ExampleCategory[] = [
  {
    label: 'Basic Circuits',
    examples: [
      { name: 'LED + Resistor', description: 'Simple DC circuit: 5V → R → LED → GND', doc: exampleLed },
      { name: 'RC Low-pass Filter', description: 'Pulse source through RC filter, oscilloscope traces', doc: exampleRC },
      { name: 'RL High-pass Filter', description: 'Inductor + resistor: high frequencies pass, low blocked', doc: exampleRLHighPass },
      { name: 'Diode Rectifier', description: 'Half-wave rectifier: AC → diode → DC (positive only)', doc: exampleDiodeRectifier },
      { name: 'Voltage Divider', description: 'Potentiometer as variable voltage divider + voltmeter', doc: exampleVoltageDivider },
      { name: 'Current Source', description: 'Current source drives resistor, ammeter measures current', doc: exampleCurrentSource },
    ],
  },
  {
    label: 'Timers & Oscillators',
    examples: [
      { name: '555 Astable Blink', description: 'Classic 555 timer in astable mode driving an LED', doc: example555 },
      { name: 'VCO Frequency Sweep', description: 'Voltage-controlled oscillator, DC input controls frequency', doc: exampleVCO },
    ],
  },
  {
    label: 'Transistors & Switches',
    examples: [
      { name: 'Transistor Switch (NPN)', description: 'NPN transistor used as a digital switch with push-button', doc: exampleTransistor },
      { name: 'NMOS Switch', description: 'NMOS transistor switching an LED, push-button on gate', doc: exampleNmos },
      { name: 'PNP Switch', description: 'PNP high-side switch — base LOW turns it ON', doc: examplePnpSwitch },
    ],
  },
  {
    label: 'Op-Amps',
    examples: [
      { name: 'Op-Amp Inverting Amp', description: 'Op-amp with gain -10 (Rf/Rin = 10k/1k)', doc: exampleOpamp },
      { name: 'Op-Amp Non-inverting Amp', description: 'Real op-amp with rails, gain = 1 + Rf/Rg = 11', doc: exampleOpampNonInverting },
      { name: 'Two-Stage Audio Amplifier', description: 'Pre-amp + tone control + power amp driving a speaker (16 components, 35 wires)', doc: exampleAudioAmplifier },
    ],
  },
  {
    label: 'Sensors & Indicators',
    examples: [
      { name: 'Photoresistor Light Sensor', description: 'LDR + resistor divider, voltage changes with light', doc: examplePhotoresistor },
      { name: 'Speaker Driver', description: 'Op-amp drives an 8Ω speaker', doc: exampleSpeaker },
    ],
  },
  {
    label: 'Logic Gates',
    examples: [
      { name: 'AND Gate', description: 'Two buttons → AND gate → LED (HIGH only when both pressed)', doc: exampleLogicGates },
    ],
  },
  {
    label: 'Microcontrollers',
    examples: [
      { name: 'Arduino Blink', description: 'Arduino blinking an LED on D2', doc: exampleArduino },
      { name: '7-Segment Counter', description: 'Arduino drives 7-segment display counting 0-9 with BCD decoder', doc: exampleSevenSeg },
    ],
  },
  {
    label: 'Clocks & Counters',
    examples: [
      { name: 'Simple Seconds Counter', description: 'Minimalist 2-digit (0-99) counter using only 2 CD4026 chips', doc: exampleSimpleClock },
      { name: 'Arduino Clock (HH:MM:SS)', description: 'Full 6-digit clock driven by 1 Arduino — multiplexed displays, no counter ICs', doc: exampleArduinoClockHHMMSS },
      { name: '555 Timer Clock (HH:MM:SS)', description: 'Complete 6-digit clock using a 555 timer oscillator + CD4026 chain', doc: example555Clock },
      { name: 'Digital Clock (HH:MM:SS)', description: '6-digit digital clock using CD4026 counters and 1Hz crystal oscillator', doc: exampleClock },
    ],
  },
];

// Flat list (backward compatibility — some code may still reference `examples`)
export const examples: ExampleEntry[] = exampleCategories.flatMap(c => c.examples);
