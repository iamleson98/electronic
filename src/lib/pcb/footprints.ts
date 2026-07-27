// Footprint definitions for PCB layout.
// Each component type maps to a physical footprint with pads.
// Sizes are in millimeters (mm), following standard PCB conventions.

import type { FootprintDef } from './types';

// Standard pad sizes
const PAD_SMD = { width: 1.5, height: 0.8 };  // SMD pad (1206-ish)
const PAD_THT = { width: 1.8, height: 1.8 };   // Through-hole pad (1mm drill)
const PAD_SMALL = { width: 1.0, height: 1.0 }; // Small SMD pad

/** Footprint registry: component type → footprint definition */
export const footprintDefs: Record<string, FootprintDef> = {
  // ----- Passive components (SMD 1206 style) -----
  resistor: {
    bodySize: { width: 3.2, height: 1.6 },
    pads: [
      { terminalId: 'a', position: { x: -2.1, y: 0 }, shape: 'rect', size: PAD_SMD },
      { terminalId: 'b', position: { x: 2.1, y: 0 }, shape: 'rect', size: PAD_SMD },
    ],
  },
  capacitor: {
    bodySize: { width: 3.2, height: 1.6 },
    pads: [
      { terminalId: 'a', position: { x: -2.1, y: 0 }, shape: 'rect', size: PAD_SMD },
      { terminalId: 'b', position: { x: 2.1, y: 0 }, shape: 'rect', size: PAD_SMD },
    ],
  },
  inductor: {
    bodySize: { width: 4.0, height: 2.0 },
    pads: [
      { terminalId: 'a', position: { x: -2.5, y: 0 }, shape: 'rect', size: PAD_SMD },
      { terminalId: 'b', position: { x: 2.5, y: 0 }, shape: 'rect', size: PAD_SMD },
    ],
  },
  potentiometer: {
    bodySize: { width: 5.0, height: 5.0 },
    pads: [
      { terminalId: 'a', position: { x: -2.5, y: 0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'b', position: { x: 2.5, y: 0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'w', position: { x: 0, y: 2.5 }, shape: 'circle', size: PAD_THT },
    ],
  },

  // ----- Diodes / LEDs -----
  led: {
    bodySize: { width: 3.2, height: 1.6 },
    pads: [
      { terminalId: 'a', position: { x: -2.1, y: 0 }, shape: 'rect', size: PAD_SMD },
      { terminalId: 'k', position: { x: 2.1, y: 0 }, shape: 'rect', size: PAD_SMD },
    ],
  },
  diode: {
    bodySize: { width: 3.2, height: 1.6 },
    pads: [
      { terminalId: 'a', position: { x: -2.1, y: 0 }, shape: 'rect', size: PAD_SMD },
      { terminalId: 'k', position: { x: 2.1, y: 0 }, shape: 'rect', size: PAD_SMD },
    ],
  },

  // ----- Switches -----
  switch: {
    bodySize: { width: 6.0, height: 4.0 },
    pads: [
      { terminalId: 'a', position: { x: -3.0, y: 0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'b', position: { x: 3.0, y: 0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  pushButton: {
    bodySize: { width: 6.0, height: 4.0 },
    pads: [
      { terminalId: 'a', position: { x: -3.0, y: 0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'b', position: { x: 3.0, y: 0 }, shape: 'circle', size: PAD_THT },
    ],
  },

  // ----- Transistors (SOT-23 style) -----
  npn: {
    bodySize: { width: 2.9, height: 2.8 },
    pads: [
      { terminalId: 'c', position: { x: 1.0, y: -1.0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'b', position: { x: -1.0, y: 0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'e', position: { x: 1.0, y: 1.0 }, shape: 'rect', size: PAD_SMALL },
    ],
  },
  pnp: {
    bodySize: { width: 2.9, height: 2.8 },
    pads: [
      { terminalId: 'e', position: { x: 1.0, y: -1.0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'b', position: { x: -1.0, y: 0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'c', position: { x: 1.0, y: 1.0 }, shape: 'rect', size: PAD_SMALL },
    ],
  },
  nmos: {
    bodySize: { width: 2.9, height: 2.8 },
    pads: [
      { terminalId: 'd', position: { x: 1.0, y: -1.0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'g', position: { x: -1.0, y: 0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 's', position: { x: 1.0, y: 1.0 }, shape: 'rect', size: PAD_SMALL },
    ],
  },
  pmos: {
    bodySize: { width: 2.9, height: 2.8 },
    pads: [
      { terminalId: 's', position: { x: 1.0, y: -1.0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'g', position: { x: -1.0, y: 0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'd', position: { x: 1.0, y: 1.0 }, shape: 'rect', size: PAD_SMALL },
    ],
  },

  // ----- Power sources (THT) -----
  dcVoltage: {
    bodySize: { width: 5.0, height: 10.0 },
    pads: [
      { terminalId: 'p', position: { x: 0, y: -4.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'n', position: { x: 0, y: 4.0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  acVoltage: {
    bodySize: { width: 5.0, height: 10.0 },
    pads: [
      { terminalId: 'p', position: { x: 0, y: -4.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'n', position: { x: 0, y: 4.0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  pulseSource: {
    bodySize: { width: 5.0, height: 10.0 },
    pads: [
      { terminalId: 'p', position: { x: 0, y: -4.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'n', position: { x: 0, y: 4.0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  currentSource: {
    bodySize: { width: 5.0, height: 10.0 },
    pads: [
      { terminalId: 'p', position: { x: 0, y: -4.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'n', position: { x: 0, y: 4.0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  ground: {
    bodySize: { width: 3.0, height: 3.0 },
    pads: [
      { terminalId: 'g', position: { x: 0, y: 0 }, shape: 'circle', size: PAD_THT },
    ],
  },

  // ----- ICs -----
  opamp: {
    bodySize: { width: 6.0, height: 5.0 },
    pads: [
      { terminalId: 'in+', position: { x: -3.0, y: -1.0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'in-', position: { x: -3.0, y: 1.0 }, shape: 'rect', size: PAD_SMALL },
      { terminalId: 'out', position: { x: 3.0, y: 0 }, shape: 'rect', size: PAD_SMALL },
    ],
  },
  timer555: {
    bodySize: { width: 10.0, height: 8.0 },
    pads: [
      { terminalId: 'gnd', position: { x: -4.0, y: -3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'trig', position: { x: -4.0, y: -1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'out', position: { x: 4.0, y: -3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'rst', position: { x: -4.0, y: 1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'ctrl', position: { x: -4.0, y: 3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'thr', position: { x: -4.0, y: 5.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'dis', position: { x: 4.0, y: 3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'vcc', position: { x: 4.0, y: -1.0 }, shape: 'circle', size: PAD_THT },
    ],
  },

  // ----- Meters / Probes (small SMD) -----
  oscilloscope: {
    bodySize: { width: 3.0, height: 3.0 },
    pads: [
      { terminalId: 'p', position: { x: -1.5, y: 0 }, shape: 'circle', size: PAD_SMALL },
      { terminalId: 'n', position: { x: 1.5, y: 0 }, shape: 'circle', size: PAD_SMALL },
    ],
  },
  voltmeter: {
    bodySize: { width: 3.0, height: 4.0 },
    pads: [
      { terminalId: 'p', position: { x: -1.5, y: 0 }, shape: 'circle', size: PAD_SMALL },
      { terminalId: 'n', position: { x: 1.5, y: 0 }, shape: 'circle', size: PAD_SMALL },
    ],
  },
  ammeter: {
    bodySize: { width: 3.0, height: 4.0 },
    pads: [
      { terminalId: 'p', position: { x: -1.5, y: 0 }, shape: 'circle', size: PAD_SMALL },
      { terminalId: 'n', position: { x: 1.5, y: 0 }, shape: 'circle', size: PAD_SMALL },
    ],
  },

  // ----- MCUs -----
  arduino: {
    bodySize: { width: 18.0, height: 14.0 },
    pads: [
      { terminalId: '5v', position: { x: -8.0, y: -5.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'gnd', position: { x: -8.0, y: -3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd2', position: { x: 8.0, y: -5.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd3', position: { x: 8.0, y: -3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd4', position: { x: 8.0, y: -1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd5', position: { x: 8.0, y: 1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'a0', position: { x: -8.0, y: 1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'a1', position: { x: -8.0, y: 3.0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  arduinoReal: {
    bodySize: { width: 18.0, height: 14.0 },
    pads: [
      { terminalId: '5v', position: { x: -8.0, y: -5.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'gnd', position: { x: -8.0, y: -3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd2', position: { x: 8.0, y: -5.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd3', position: { x: 8.0, y: -3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd4', position: { x: 8.0, y: -1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd5', position: { x: 8.0, y: 1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'a0', position: { x: -8.0, y: 1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'a1', position: { x: -8.0, y: 3.0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  raspberryPi: {
    bodySize: { width: 18.0, height: 14.0 },
    pads: [
      { terminalId: '3v3', position: { x: -8.0, y: -5.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'gnd', position: { x: -8.0, y: -3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'gpio2', position: { x: 8.0, y: -5.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'gpio3', position: { x: 8.0, y: -3.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'gpio4', position: { x: 8.0, y: -1.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'gpio17', position: { x: 8.0, y: 1.0 }, shape: 'circle', size: PAD_THT },
    ],
  },

  // ----- IO -----
  sevenSegment: {
    bodySize: { width: 10.0, height: 15.0 },
    pads: [
      { terminalId: 'a', position: { x: -4.0, y: -6.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'b', position: { x: 0, y: -6.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'c', position: { x: 4.0, y: -6.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'd', position: { x: 4.0, y: 6.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'e', position: { x: 0, y: 6.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'f', position: { x: -4.0, y: 6.0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'g', position: { x: -4.0, y: 0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'com', position: { x: 4.0, y: 0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  speaker: {
    bodySize: { width: 8.0, height: 5.0 },
    pads: [
      { terminalId: 'a', position: { x: -3.0, y: 0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'b', position: { x: 3.0, y: 0 }, shape: 'circle', size: PAD_THT },
    ],
  },
  photoresistor: {
    bodySize: { width: 5.0, height: 4.0 },
    pads: [
      { terminalId: 'a', position: { x: -2.5, y: 0 }, shape: 'circle', size: PAD_THT },
      { terminalId: 'b', position: { x: 2.5, y: 0 }, shape: 'circle', size: PAD_THT },
    ],
  },

  // ----- Junction (single pad) -----
  junction: {
    bodySize: { width: 2.0, height: 2.0 },
    pads: [
      { terminalId: 'a', position: { x: 0, y: 0 }, shape: 'circle', size: PAD_SMALL },
    ],
  },
};

/** Get footprint definition for a component type. Falls back to a generic SMD. */
export function getFootprintDef(type: string): FootprintDef {
  return footprintDefs[type] ?? {
    bodySize: { width: 3.0, height: 2.0 },
    pads: [
      { terminalId: 'a', position: { x: -1.5, y: 0 }, shape: 'rect', size: PAD_SMD },
      { terminalId: 'b', position: { x: 1.5, y: 0 }, shape: 'rect', size: PAD_SMD },
    ],
  };
}
