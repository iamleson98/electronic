// Footprint definitions for PCB layout.
// Each component type maps to a physical footprint with pads.
// Sizes are in millimeters (mm), following standard PCB conventions.

import type { FootprintDef, FootprintPadDef } from './types';
import { getPlugin } from '../circuit/registry';
import { realPackageDef, realPackageInfo, dipPos } from './real-packages';

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

// ── Power / signal INPUT connectors ───────────────────────────────────────
// A schematic supply (dcVoltage, battery, …) is not a part you can buy: on the
// real board it is wherever the power comes IN. Every DC supply / battery is
// therefore mapped to a physical 2-pin 2.54 mm input header (ref J#, value
// "PWR 9V", pad 1 = +, pad 2 = −) and every signal / AC source to a 2-pin
// "SIG IN" header. ONE mapping: the PCB footprint, BOM, CPL and KiCad netlist
// all read it from here.

/** supply-type → the parameter holding its voltage */
const DC_SOURCE_VOLTAGE_PARAM: Record<string, string> = { dcVoltage: 'voltage', battery: 'voltage', solarCell: 'voc' };
const SIGNAL_SOURCES = new Set(['acVoltage', 'pulseSource', 'currentSource']);

/** KiCad footprint + BOM package of the input header. */
export const POWER_HEADER_KICAD = 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical';
export const POWER_HEADER_PKG = 'PinHeader-1x02 P2.54';

export interface PowerInput {
  kind: 'dc' | 'signal';
  /** BOM / netlist value: 'PWR 9V' or 'SIG IN' */
  value: string;
  /** DC supplies: the rail voltage */
  voltage?: number;
  /** DC supplies: name of the + net ('+9V', '+3.3V', '-5V'); absent when 0 V */
  netName?: string;
}

/** 9 → '+9V', 3.3 → '+3.3V', -5 → '-5V'; 0 → ''. */
export function formatRailName(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '';
  const n = parseFloat(Math.abs(v).toFixed(3));
  return `${v < 0 ? '-' : '+'}${n}V`;
}

/** The input-connector role of a source component, or null for anything else. */
export function powerInputFor(type: string, parameters?: Record<string, unknown>): PowerInput | null {
  const key = DC_SOURCE_VOLTAGE_PARAM[type];
  if (key) {
    const raw = parameters?.[key];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    const rail = v === undefined ? '' : formatRailName(v);
    return { kind: 'dc', value: rail ? `PWR ${rail.replace(/^\+/, '')}` : 'PWR', ...(v !== undefined ? { voltage: v } : {}), ...(rail ? { netName: rail } : {}) };
  }
  if (SIGNAL_SOURCES.has(type)) return { kind: 'signal', value: 'SIG IN' };
  return null;
}

/** Mechanical items (mounting holes): on the board, but not a BOM / CPL / netlist part. */
export function isMechanicalType(type: string): boolean {
  return type === 'mountingHole';
}

/**
 * Does this component type become something physical on the board?
 * Schematic symbols, probes and behavioural / dependent sources do not;
 * supplies and signal sources become input headers (see above).
 */
export function isPhysicalType(type: string): boolean {
  if (ANNOTATION_TYPES.has(type)) return false;
  if (powerInputFor(type)) return true;
  const cat = getPlugin(type)?.category;
  if (cat === 'source') return false;
  if (cat === 'meter' && type !== 'ammeter') return false;
  return true;
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

/** KiCad PinHeader_1x02_P2.54mm_Vertical, origin at the pad-pair centre:
 *  pad 1 (square) = + / signal, pad 2 (round) = − / return. */
function powerHeaderDef(): FootprintDef {
  return {
    bodySize: { width: 2.54, height: 5.08 },
    pads: [
      { terminalId: 'p', position: { x: 0, y: -1.27 }, shape: 'rect', size: { width: 1.7, height: 1.7 }, drill: 1.0, number: '1' },
      { terminalId: 'n', position: { x: 0, y: 1.27 }, shape: 'circle', size: { width: 1.7, height: 1.7 }, drill: 1.0, number: '2' },
    ],
    name: 'PinHeader_1x02_P2.54mm (pad 1 = +, pad 2 = −)',
    verified: true,
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

  // ----- Transistors (npn/pnp/nmos/pmos + Gummel-Poon / Level-1 variants):
  // resolved PER PART in real-packages.ts (TO-92 / SOT-23 / TO-220 with the
  // datasheet pad numbers of the chosen part). -----

  // ----- Power / signal sources: a 2-pin input header (see powerInputFor) -----
  dcVoltage: powerHeaderDef(),
  battery: powerHeaderDef(),
  solarCell: powerHeaderDef(),
  acVoltage: powerHeaderDef(),
  pulseSource: powerHeaderDef(),
  currentSource: powerHeaderDef(),

  // ----- Mechanical: M3 mounting hole, non-plated (NPTH) -----
  // KiCad MountingHole_3.2mm_M3: Ø3.2 mm hole, no copper, no pin number.
  mountingHole: {
    bodySize: { width: 3.2, height: 3.2 },
    pads: [
      { terminalId: 'mh', position: { x: 0, y: 0 }, shape: 'circle', size: { width: 3.2, height: 3.2 }, drill: 3.2, plated: false },
    ],
    name: 'MountingHole_3.2mm_M3 (NPTH)',
    verified: true,
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
export function getFootprintDef(type: string, parameters?: Record<string, unknown>): FootprintDef {
  const explicit = footprintDefs[type];
  if (explicit) return explicit;
  // real package + datasheet pinout (user-registered footprints above win).
  // `parameters.part` picks the physical part of a transistor (BC547 ≠ 2N3904).
  const real = realPackageDef(type, parameters?.part);
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


/** KiCad-library ids + BOM package names of the hand-drawn passive footprints. */
const PASSIVE_PACKAGES: Record<string, { pkg: string; kicad: string }> = {
  resistor: { pkg: '1206', kicad: 'Resistor_SMD:R_1206_3216Metric' },
  capacitor: { pkg: '1206', kicad: 'Capacitor_SMD:C_1206_3216Metric' },
  inductor: { pkg: '1210', kicad: 'Inductor_SMD:L_1210_3225Metric' },
  led: { pkg: '1206', kicad: 'LED_SMD:LED_1206_3216Metric' },
  diode: { pkg: '1206', kicad: 'Diode_SMD:D_1206_3216Metric' },
  ammeter: { pkg: 'PinHeader-1x02 P2.54', kicad: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical' },
  // supplies / signal sources are the board's input header (powerInputFor)
  dcVoltage: { pkg: POWER_HEADER_PKG, kicad: POWER_HEADER_KICAD },
  battery: { pkg: POWER_HEADER_PKG, kicad: POWER_HEADER_KICAD },
  solarCell: { pkg: POWER_HEADER_PKG, kicad: POWER_HEADER_KICAD },
  acVoltage: { pkg: POWER_HEADER_PKG, kicad: POWER_HEADER_KICAD },
  pulseSource: { pkg: POWER_HEADER_PKG, kicad: POWER_HEADER_KICAD },
  currentSource: { pkg: POWER_HEADER_PKG, kicad: POWER_HEADER_KICAD },
};

export interface FootprintPackage {
  /** package as placed on the PCB ('1206', 'DIP-8', 'TO-92', …) — never the component type */
  pkg: string;
  /** KiCad standard-library footprint id; null when this tool has no verified real footprint */
  kicad: string | null;
  /** why `kicad` is null */
  note?: string;
}

/**
 * The package the PCB actually uses for a component, plus its KiCad library
 * footprint id. Single source of truth for the BOM and the KiCad netlist.
 */
export function footprintPackage(type: string, parameters?: Record<string, unknown>): FootprintPackage {
  const passive = PASSIVE_PACKAGES[type];
  if (passive) {
    return { pkg: passive.pkg, kicad: passive.kicad };
  }
  const real = realPackageInfo(type, parameters?.part);
  if (real) {
    return real.kicad
      ? { pkg: real.pkg, kicad: real.kicad }
      : { pkg: real.pkg, kicad: null, note: `no KiCad library footprint verified for ${real.pkg}; assign one in Pcbnew` };
  }
  const def = getFootprintDef(type, parameters);
  return {
    pkg: def.name ?? `${type} (generic footprint)`,
    kicad: null,
    note: 'generic footprint, pinout not verified against a datasheet; assign the real footprint in Pcbnew',
  };
}
