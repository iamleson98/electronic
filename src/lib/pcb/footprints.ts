// Footprint definitions for PCB layout.
// Each component type maps to a physical footprint with pads.
// Sizes are in millimeters (mm), following standard PCB conventions.

import type { FootprintDef, FootprintPadDef } from './types';
import { getPlugin } from '../circuit/registry';
import { realPackageDef, dipPos } from './real-packages';

// Standard pad sizes (mm).
// NOTE: PAD_SMD/PAD_SMALL keep their historical 1.5x0.8 / 1.0x1.0 sizes:
// the auto-router's clearance/corridor math and the router-quality tests
// are tuned to them (1206 pads at ±2.1mm, SOT-23 at 1.0mm pitch). Changing
// pad geometry shifts every routed trace by fractions of a millimeter and
// breaks the 100%-routed contracts on the dense clock boards.
const PAD_SMD = { width: 1.5, height: 0.8 };  // SMD pad (1206-ish)
const PAD_THT = { width: 1.8, height: 1.8 };   // Through-hole pad (1mm drill)
const PAD_SMALL = { width: 1.0, height: 1.0 }; // Small SMD pad

/** DIP pitch / row span for generated IC footprints.
 *
 * 2.5mm (not the literal 2.54) so every pad and every between-pin corridor
 * midpoint lands ON the router's 0.25mm grid — traces can pass between
 * adjacent pins exactly like routing a real DIP. With 2.54mm pitch the pads
 * sit between grid points and no legal crossing exists, which stranded nets
 * on dense boards (the multi-digit clock examples).
 */
/** Parametric-IC pad: 1.6mm circle, 1.0mm drill (0.3mm annular ring).
 *  Leaves a 0.9mm corridor between pins — a 0.3mm trace + 2×0.2mm clearance
 *  fits with 0.2mm to spare. */
const PAD_DIP = { width: 1.6, height: 1.6 };

/** Annotation-only types — logical, never physical. No pads on the PCB.
 *  `ground` (the classic ground symbol) and `junction` (a wire dot) belong
 *  here too: they used to get a through-hole pad each, so every ground
 *  symbol put a stray GND pad on the board and a "ground" line in the BOM. */
const ANNOTATION_TYPES = new Set([
  'netLabel', 'globalLabel', 'hierLabel', 'busLabel', 'busVectorLabel',
  'noConnect', 'textLabel', 'busEntry', 'bus', 'powerFlag', 'hierSheet',
  'powerGND', 'powerAGND', 'powerVCC', 'power5V', 'power3V3', 'power1V8',
  'power2V5', 'power12V', 'powerMinus12V', 'powerMinus5V', 'powerAVDD',
  'powerVBAT', 'customPower', 'ground', 'junction',
  // measurement instruments: they observe the circuit, nothing to solder
  'oscilloscope', 'voltmeter',
]);

/** Schematic-only symbol: shapes the netlist, never becomes a PCB part. */
export function isSchematicOnlyType(type: string): boolean {
  return ANNOTATION_TYPES.has(type);
}

/**
 * Generate a DIP-style footprint from a component plugin's REAL terminal
 * list, so every schematic pin gets a PCB pad with a matching terminalId.
 *
 * This is the fallback for the ~130 registered component types that have no
 * hand-drawn footprint (ICs, logic gates, sensors, …). The old fallback was a
 * generic 2-pad SMD with terminalIds "a"/"b" — for a CD4026 (12 pins: clk,
 * rst, vcc, gnd, co, a–g…) NONE of the pads matched a real terminal, so the
 * pads ended up net-less and the PCB silently omitted EVERY connection to
 * the chip while the router reported "100% routed".
 *
 * Layout convention (standard DIP numbering): pin 1 at top-left, down the
 * left column, then up the right column.
 */
function parametricFootprintDef(type: string): FootprintDef | null {
  const plugin = getPlugin(type);
  if (!plugin || plugin.terminals.length === 0) return null;
  const terminals = plugin.terminals;
  const n = terminals.length;

  if (n === 1) {
    // Single-pin (test point style)
    return {
      bodySize: { width: 2.0, height: 2.0 },
      pads: [{ terminalId: terminals[0].id, position: { x: 0, y: 0 }, shape: 'circle', size: PAD_THT }],
      name: `${plugin.name} (1-pin)`,
    };
  }

  if (n === 2) {
    // Axial 2-pin THT (resistor/diode style but with the REAL terminal ids).
    // ±2.5mm keeps the pads + midpoint on the 0.25mm routing grid.
    return {
      bodySize: { width: 6.0, height: 3.0 },
      pads: [
        { terminalId: terminals[0].id, position: { x: -2.5, y: 0 }, shape: 'circle', size: PAD_DIP, drill: 1.0 },
        { terminalId: terminals[1].id, position: { x: 2.5, y: 0 }, shape: 'circle', size: PAD_DIP, drill: 1.0 },
      ],
      name: `${plugin.name} (2-pin)`,
    };
  }

  // n ≥ 3: generic DIP with real geometry (2.54 mm pitch, 7.62 mm rows) —
  // but the pins follow the MODEL's terminal order, not a datasheet, so the
  // footprint is NOT verified and is flagged before fabrication.
  const pins = n + (n % 2);
  const pads: FootprintPadDef[] = terminals.map((t, i) => ({
    terminalId: t.id, position: dipPos(i + 1, pins), shape: i === 0 ? 'rect' : 'circle',
    size: PAD_DIP, drill: 0.8, number: String(i + 1),
  }));
  return {
    bodySize: { width: 6.35, height: (pins / 2) * 2.54 + 0.5 },
    pads,
    name: `${plugin.name} (generic DIP-${pins}, pinout not verified)`,
  };
}

/** Footprint registry: component type → footprint definition */
export const footprintDefs: Record<string, FootprintDef> = {
  // ----- Passive components: IPC-7351 nominal 1206 / 1210 land patterns
  // (KiCad R_1206_3216Metric: 1.15 × 1.8 mm pads at ±1.5 mm). The old pads
  // were 1.5 × 0.8 mm at ±2.1 mm — rotated 90° and too far apart for the
  // part's end terminations to land on. -----
  resistor: {
    bodySize: { width: 3.2, height: 1.6 },
    pads: [
      { terminalId: 'a', position: { x: -1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 1.8 }, number: '1' },
      { terminalId: 'b', position: { x: 1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 1.8 }, number: '2' },
    ],
    name: 'R_1206_3216Metric',
    verified: true,
  },
  capacitor: {
    bodySize: { width: 3.2, height: 1.6 },
    pads: [
      { terminalId: 'a', position: { x: -1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 1.8 }, number: '1' },
      { terminalId: 'b', position: { x: 1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 1.8 }, number: '2' },
    ],
    name: 'C_1206_3216Metric',
    verified: true,
  },
  inductor: {
    bodySize: { width: 3.2, height: 2.5 },
    pads: [
      { terminalId: 'a', position: { x: -1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 2.65 }, number: '1' },
      { terminalId: 'b', position: { x: 1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 2.65 }, number: '2' },
    ],
    name: 'L_1210_3225Metric',
    verified: true,
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
      { terminalId: 'k', position: { x: -1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 1.8 }, number: '1' },
      { terminalId: 'a', position: { x: 1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 1.8 }, number: '2' },
    ],
    name: 'LED_1206_3216Metric (pad 1 = cathode)',
    verified: true,
  },
  diode: {
    bodySize: { width: 3.2, height: 1.6 },
    pads: [
      { terminalId: 'k', position: { x: -1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 1.8 }, number: '1' },
      { terminalId: 'a', position: { x: 1.5, y: 0 }, shape: 'rect', size: { width: 1.15, height: 1.8 }, number: '2' },
    ],
    name: 'D_1206_3216Metric (pad 1 = cathode)',
    verified: true,
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

  // ----- ICs, transistors, displays: real packages with datasheet pinouts
  // live in real-packages.ts (getFootprintDef falls through to them). -----

  // An ammeter sits IN SERIES — dropping it would cut the circuit. On the
  // board it is a 2-pin 2.54 mm jumper header: fit a jumper to close the
  // path, pull it and insert a meter to measure the current.
  ammeter: {
    bodySize: { width: 5.1, height: 2.6 },
    pads: [
      { terminalId: 'p', position: { x: -1.27, y: 0 }, shape: 'rect', size: { width: 1.7, height: 1.7 }, drill: 1.0, number: '1' },
      { terminalId: 'n', position: { x: 1.27, y: 0 }, shape: 'oval', size: { width: 1.7, height: 1.7 }, drill: 1.0, number: '2' },
    ],
    name: 'PinHeader_1x02_P2.54mm (current-measurement jumper)',
    verified: true,
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
  // NOTE: arduinoReal has 30 plugin terminals (5v, gnd, a0–a2, d2–d13…) — no
  // hand-drawn def can drop pins without breaking schematic↔PCB netlist
  // consistency, so it uses the parametric DIP generator below.

  // ----- IO -----
  // NOTE: sevenSegment keeps its historical 8-pad def (a-g + com). The
  // plugin exposes exactly these 8 terminals, so extra dp/com2 pads would
  // be net-less and inflate the ratsnest (2 unrouted legs on the clock).
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

/** Get footprint definition for a component type.
 *
 * Priority: hand-drawn def → parametric DIP from the plugin's real terminals
 * → annotation (no pads) → generic 2-pad SMD (unknown type).
 * The parametric path guarantees every schematic pin gets a PCB pad with a
 * matching terminalId — the netlist stays consistent by construction.
 */
export function getFootprintDef(type: string): FootprintDef {
  const explicit = footprintDefs[type];
  if (explicit) return explicit;
  // real package + datasheet pinout (user-registered footprints above win)
  const real = realPackageDef(type);
  if (real) return real;
  if (ANNOTATION_TYPES.has(type)) {
    return { bodySize: { width: 1.0, height: 1.0 }, pads: [], name: 'Annotation' };
  }
  const parametric = parametricFootprintDef(type);
  if (parametric) return parametric;
  return {
    bodySize: { width: 3.0, height: 2.0 },
    pads: [
      { terminalId: 'a', position: { x: -1.5, y: 0 }, shape: 'rect', size: PAD_SMD },
      { terminalId: 'b', position: { x: 1.5, y: 0 }, shape: 'rect', size: PAD_SMD },
    ],
  };
}

// Mark all THT-style pads (the shared 1.8mm PAD_THT circles) as plated
// through-holes with a 1.0mm drill, matching the PAD_THT definition comment.
// With `drill` set, the DRC (annular ring), Gerber copper export (pads appear
// on BOTH copper layers), Excellon drill export, copper pour and the 3D viewer
// all treat these as real through-hole pads instead of guessing.
// (The parametric generator sets drill: 1.0 on its PAD_DIP pads directly —
// fresh objects are created per call, so identity checks don't apply.)
for (const def of Object.values(footprintDefs)) {
  for (const pad of def.pads) {
    if (pad.shape === 'circle' && pad.size === PAD_THT && pad.drill == null) {
      pad.drill = 1.0;
    }
  }
}
