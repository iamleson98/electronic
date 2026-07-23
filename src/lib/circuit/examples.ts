// Pre-built example circuits. Used by the "Examples" menu in the toolbar.

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
export const exampleLed: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [10, 4], 0, { voltage: 5 }),
    comp('resistor', 'r1', [14, 7], 0, { resistance: 330 }),
    comp('led', 'led1', [18, 7], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [11, 10], 0, {}),
  ],
  wires: [
    wire('w1', 'v1', 'p', 'r1', 'a'),
    wire('w2', 'r1', 'b', 'led1', 'a'),
    wire('w3', 'led1', 'k', 'gnd1', 'g'),
    wire('w4', 'v1', 'n', 'gnd1', 'g'),
  ],
};

// ----- Example 2: 555 astable blink -----
export const example555: CircuitDocument = {
  version: 1,
  components: [
    comp('dcVoltage', 'v1', [4, 6], 0, { voltage: 5 }),
    comp('ground', 'gnd1', [5, 12], 0, {}),
    comp('timer555', 'ic1', [12, 6], 0, { vcc: 5 }),
    comp('resistor', 'ra', [8, 6], 0, { resistance: 10000 }),
    comp('resistor', 'rb', [8, 12], 0, { resistance: 47000 }),
    comp('capacitor', 'c1', [16, 14], 0, { capacitance: 1e-6, initialV: 0 }),
    comp('led', 'led1', [20, 6], 0, { color: 'green', forwardV: 2.0, seriesR: 220 }),
  ],
  wires: [
    // VCC + GND
    wire('w1', 'v1', 'p', 'ic1', 'vcc'),
    wire('w2', 'v1', 'n', 'gnd1', 'g'),
    wire('w3', 'ic1', 'gnd', 'gnd1', 'g'),
    // RST tied to VCC (active-low reset)
    wire('w13', 'v1', 'p', 'ic1', 'rst'),
    // Ra: VCC -> Ra -> DIS
    wire('w4', 'v1', 'p', 'ra', 'a'),
    wire('w5', 'ra', 'b', 'ic1', 'dis'),
    // Rb: DIS -> THR/TRIG
    wire('w6', 'ic1', 'dis', 'rb', 'a'),
    wire('w7', 'rb', 'b', 'ic1', 'thr'),
    wire('w8', 'ic1', 'thr', 'ic1', 'trig'),
    // C1: THR -> GND
    wire('w9', 'ic1', 'thr', 'c1', 'a'),
    wire('w10', 'c1', 'b', 'gnd1', 'g'),
    // OUT -> LED -> GND
    wire('w11', 'ic1', 'out', 'led1', 'a'),
    wire('w12', 'led1', 'k', 'gnd1', 'g'),
  ],
};

// ----- Example 3: RC low-pass filter -----
export const exampleRC: CircuitDocument = {
  version: 1,
  components: [
    comp('pulseSource', 'v1', [4, 6], 0, { high: 5, low: 0, frequency: 100, duty: 50 }),
    comp('resistor', 'r1', [10, 6], 0, { resistance: 1000 }),
    comp('capacitor', 'c1', [14, 8], 0, { capacitance: 1e-6 }),
    comp('ground', 'gnd1', [5, 12], 0, {}),
    comp('oscilloscope', 'sc1', [14, 4], 0, { color: '#22d3ee', label: 'Out' }),
    comp('oscilloscope', 'sc2', [6, 4], 0, { color: '#f97316', label: 'In' }),
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
    comp('dcVoltage', 'v2', [4, 12], 0, { voltage: 5 }),
    comp('pushButton', 'btn1', [8, 12], 0, { pressed: false }),
    comp('resistor', 'rb', [12, 12], 0, { resistance: 10000 }),
    comp('resistor', 'rc', [12, 4], 0, { resistance: 1000 }),
    comp('npn', 'q1', [16, 8], 0, { hfe: 100, vbe: 0.7, satV: 0.2 }),
    comp('led', 'led1', [16, 4], 0, { color: 'red', forwardV: 2.0, seriesR: 1 }),
    comp('ground', 'gnd1', [5, 18], 0, {}),
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
    comp('arduino', 'ard1', [10, 6], 0, { sketch: 'blink', vcc: 5 }),
    comp('resistor', 'r1', [20, 6], 0, { resistance: 330 }),
    comp('led', 'led1', [24, 6], 0, { color: 'blue', forwardV: 2.5, seriesR: 1 }),
    comp('ground', 'gnd1', [11, 14], 0, {}),
  ],
  wires: [
    wire('w1', 'ard1', 'gnd', 'gnd1', 'g'),
    wire('w2', 'ard1', 'd2', 'r1', 'a'),
    wire('w3', 'r1', 'b', 'led1', 'a'),
    wire('w4', 'led1', 'k', 'gnd1', 'g'),
  ],
};

export const examples: { name: string; description: string; doc: CircuitDocument }[] = [
  { name: 'LED + Resistor', description: 'Simple DC circuit: 5V → R → LED → GND', doc: exampleLed },
  { name: '555 Astable Blink', description: 'Classic 555 timer in astable mode driving an LED', doc: example555 },
  { name: 'RC Low-pass Filter', description: 'Pulse source through RC filter, oscilloscope traces', doc: exampleRC },
  { name: 'Transistor Switch', description: 'NPN transistor used as a digital switch with push-button', doc: exampleTransistor },
  { name: 'Arduino Blink', description: 'Arduino Uno (stub) blinking an LED on D2', doc: exampleArduino },
];
