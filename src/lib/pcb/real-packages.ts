// Real packages with datasheet pinouts.
//
// A footprint is only useful if the real part drops into it: right pitch,
// right row spacing, and every schematic pin on the pad that carries that
// pin NUMBER on the datasheet. The simulation models list their terminals in
// whatever order suits the model (a CD4026 lists vcc, gnd, clk… while the
// chip is pin 1 = CLK, 8 = VSS, 16 = VDD), so pin numbers live here, per part.
//
// Pins the simulation model does not have (unused gates, CLK INH, offset
// null…) get extra pads. `tie` pads MUST be wired on the board (a floating
// CMOS input oscillates, a disabled clock inhibit stops the counter); `nc`
// pads are left open. DRC reports unwired `tie` pads.
//
// Geometry follows the KiCad standard library (IPC-7351 nominal):
//   DIP     2.54 mm pitch, 7.62 mm row span, Ø1.6 pad / Ø0.8 drill, pin 1 square
//   TO-92   inline 1.27 mm pitch, 1.05 × 1.5 oval pads, Ø0.75 drill
//   TO-220  vertical, 2.54 mm pitch, 1.9 × 2.0 oval pads, Ø1.1 drill
//   SOT-23  EXACTLY KiCad Package_TO_SOT_SMD:SOT-23 (kicad-footprints master):
//           pad 1 at (-0.9375, -0.95), pad 2 at (-0.9375, +0.95), pad 3 alone
//           at (+0.9375, 0); 1.475 × 0.6 mm pads (board Y is down, as in
//           KiCad). Same orientation as KiCad's, so KiCad-based JLCPCB
//           rotation databases (kicad-jlcpcb-tools, JLCKicadTools) apply.

import type { FootprintDef, FootprintPadDef } from './types';
import { discretePartFor, KICAD_FOOTPRINT, type DiscretePart } from '../circuit/part-presets';

/** `to`: the part's own terminal (or `pin<N>`) whose net this pin joins */
type PinFn = string | { tie: string; to?: string } | { nc: string };

interface Pinout {
  pkg: 'DIP' | 'TO-92' | 'TO-220' | 'SOT-23' | '7SEG-10';
  pins: number;
  part: string;
  /** datasheet pin number → schematic terminal id, or an extra pad */
  map: Record<number, PinFn>;
}

const DIP_PITCH = 2.54;
const DIP_SPAN = 7.62;

/** pin centre for pin `i` (1-based) of a DIP with `n` pins, pin 1 top-left,
 *  counter-clockwise seen from the top (board space is Y-down). */
function dipPos(i: number, n: number): { x: number; y: number } {
  const rows = n / 2;
  const left = i <= rows;
  const row = left ? i - 1 : n - i; // right column counts bottom → top
  return { x: left ? -DIP_SPAN / 2 : DIP_SPAN / 2, y: (row - (rows - 1) / 2) * DIP_PITCH };
}

function pinPos(p: Pinout, i: number): { x: number; y: number } {
  switch (p.pkg) {
    case 'DIP': return dipPos(i, p.pins);
    case 'TO-92': return { x: (i - 2) * 1.27, y: 0 };
    case 'TO-220': return { x: (i - 2) * 2.54, y: 0 };
    // KiCad SOT-23: pins 1,2 down the left column, pin 3 alone on the right
    case 'SOT-23': return i === 3 ? { x: 0.9375, y: 0 } : { x: -0.9375, y: i === 1 ? -0.95 : 0.95 };
    case '7SEG-10':
      // 0.56″ display: pins 1–5 along the bottom (left → right), 6–10 along
      // the top (right → left), rows 15.24 mm apart
      return i <= 5 ? { x: (i - 3) * 2.54, y: 7.62 } : { x: (8 - i) * 2.54, y: -7.62 };
  }
}

function buildDef(p: Pinout): FootprintDef {
  const pads: FootprintPadDef[] = [];
  for (let i = 1; i <= p.pins; i++) {
    const fn = p.map[i] ?? { nc: 'not connected' };
    const position = pinPos(p, i);
    let size: { width: number; height: number } = { width: 1.6, height: 1.6 };
    let shape: FootprintPadDef['shape'] = i === 1 ? 'rect' : 'circle';
    let drill = 0.8;
    if (p.pkg === 'TO-92') { size = { width: 1.05, height: 1.5 }; shape = i === 1 ? 'rect' : 'oval'; drill = 0.75; }
    if (p.pkg === 'TO-220') { size = { width: 1.9, height: 2.0 }; shape = i === 1 ? 'rect' : 'oval'; drill = 1.1; }
    // SMD: no drill
    if (p.pkg === 'SOT-23') { size = { width: 1.475, height: 0.6 }; shape = 'rect'; drill = 0; }
    const pad: FootprintPadDef = { terminalId: typeof fn === 'string' ? fn : `pin${i}`, position, shape, size, ...(drill > 0 ? { drill } : {}), number: String(i) };
    if (typeof fn !== 'string') {
      if ('tie' in fn) { pad.tie = true; pad.note = fn.tie; if (fn.to) pad.tieTo = fn.to; } else { pad.note = fn.nc; }
    }
    pads.push(pad);
  }
  const body = p.pkg === 'DIP'
    ? { width: 6.35, height: (p.pins / 2) * DIP_PITCH + 0.5 }
    : p.pkg === 'TO-92' ? { width: 4.8, height: 3.8 }
    : p.pkg === 'TO-220' ? { width: 10.0, height: 4.5 }
    : p.pkg === 'SOT-23' ? { width: 1.3, height: 2.9 }
    : { width: 12.5, height: 19.0 };
  const pkgName = p.pkg === 'DIP' ? `DIP-${p.pins}` : p.pkg === '7SEG-10' ? '7-segment 0.56″ (10-pin)' : p.pkg;
  return { bodySize: body, pads, name: `${p.part} (${pkgName})`, verified: true };
}

// ── pin roles shared by many parts ────────────────────────────────────────
const tieIn = (what: string) => ({ tie: `unused ${what} input — tied to GND`, to: 'gnd' });
const ncOut = (what: string) => ({ nc: `unused ${what} output — leave open` });

/** one gate of a 74HC quad 2-input package (00 / 08 / 32 / 86 / 132 pinout) */
function quad2(part: string): Pinout {
  return {
    pkg: 'DIP', pins: 14, part,
    map: {
      1: 'a', 2: 'b', 3: 'y', 7: 'gnd', 14: 'vcc',
      4: tieIn('gate 2'), 5: tieIn('gate 2'), 6: ncOut('gate 2'),
      8: ncOut('gate 3'), 9: tieIn('gate 3'), 10: tieIn('gate 3'),
      11: ncOut('gate 4'), 12: tieIn('gate 4'), 13: tieIn('gate 4'),
    },
  };
}
const nor74: Pinout = {
  pkg: 'DIP', pins: 14, part: '74HC02',
  map: {
    1: 'y', 2: 'a', 3: 'b', 7: 'gnd', 14: 'vcc',
    4: ncOut('gate 2'), 5: tieIn('gate 2'), 6: tieIn('gate 2'),
    8: tieIn('gate 3'), 9: tieIn('gate 3'), 10: ncOut('gate 3'),
    11: tieIn('gate 4'), 12: tieIn('gate 4'), 13: ncOut('gate 4'),
  },
};
function hex1(part: string): Pinout {
  return {
    pkg: 'DIP', pins: 14, part,
    map: {
      1: 'a', 2: 'y', 7: 'gnd', 14: 'vcc',
      3: tieIn('inverter 2'), 4: ncOut('inverter 2'), 5: tieIn('inverter 3'), 6: ncOut('inverter 3'),
      8: ncOut('inverter 4'), 9: tieIn('inverter 4'), 10: ncOut('inverter 5'), 11: tieIn('inverter 5'),
      12: ncOut('inverter 6'), 13: tieIn('inverter 6'),
    },
  };
}
/** single op-amp, 741 / TL071 pinout */
function single741(part: string, pins: { inp: string; inn: string; out: string; vp: string; vn: string }): Pinout {
  return {
    pkg: 'DIP', pins: 8, part,
    map: {
      2: pins.inn, 3: pins.inp, 4: pins.vn, 6: pins.out, 7: pins.vp,
      1: { nc: 'offset null — leave open' }, 5: { nc: 'offset null — leave open' }, 8: { nc: 'not connected' },
    },
  };
}
/**
 * Unused op-amp channel termination — the universally safe one: the spare
 * amp is a voltage follower (IN− tied to its own OUT) with IN+ tied to the
 * USED amp's IN+ pin, which is inside the common-mode range by construction.
 * (Tying IN+ to V− breaks parts whose common-mode range excludes the
 * negative rail — TL072 / NE5532 — and can latch up or phase-reverse.)
 */
const parkedAmp = (n: string, inpPin: number, innPin: number, outPin: number, usedInp: number) => ({
  [inpPin]: { tie: `unused amp ${n} IN+ — tied to the used amp's IN+ (pin ${usedInp}), inside the common-mode range`, to: 'pin' + usedInp },
  [innPin]: { tie: `unused amp ${n} IN− — tied to its own OUT (pin ${outPin}): a parked voltage follower`, to: 'pin' + outPin },
  [outPin]: { nc: `unused amp ${n} output (follower output, leave open)` },
}) as Record<number, PinFn>;

/** unused comparator: open-collector output left open, both inputs at V−
 *  (GND) — the datasheet recommendation (no floating high-impedance inputs,
 *  and no tie of IN− to an open output). */
const parkedComparator = (n: string, inpPin: number, innPin: number, outPin: number, gnd: string) => ({
  [inpPin]: { tie: `unused comparator ${n} IN+ — tied to V−/GND`, to: gnd },
  [innPin]: { tie: `unused comparator ${n} IN− — tied to V−/GND`, to: gnd },
  [outPin]: { nc: `unused comparator ${n} output (open collector) — leave open` },
}) as Record<number, PinFn>;

/** channel A of a dual op-amp (LM358, TL072, NE5532) */
function dualA(part: string, vn: string): Pinout {
  return {
    pkg: 'DIP', pins: 8, part,
    map: { 1: 'out', 2: 'inn', 3: 'inp', 4: vn, 8: 'vcc', ...parkedAmp('B', 5, 6, 7, 3) },
  };
}
/** channel A of a dual comparator (LM393 / LM2903) */
function dualComparatorA(part: string, gnd: string): Pinout {
  return {
    pkg: 'DIP', pins: 8, part,
    map: { 1: 'out', 2: 'inn', 3: 'inp', 4: gnd, 8: 'vcc', ...parkedComparator('B', 5, 6, 7, gnd) },
  };
}

export const REAL_PINOUTS: Record<string, Pinout> = {
  timer555: {
    pkg: 'DIP', pins: 8, part: 'NE555',
    map: { 1: 'gnd', 2: 'trig', 3: 'out', 4: 'rst', 5: 'ctrl', 6: 'thr', 7: 'dis', 8: 'vcc' },
  },
  // the ideal op-amp has no supply pins — the real chip does, and needs them
  opamp: {
    pkg: 'DIP', pins: 8, part: 'TL071',
    map: {
      2: 'in-', 3: 'in+', 6: 'out',
      4: { tie: 'V− supply — the ideal op-amp symbol has no supply pins; wire V− on the board' },
      7: { tie: 'V+ supply — the ideal op-amp symbol has no supply pins; wire V+ on the board' },
      1: { nc: 'offset null — leave open' }, 5: { nc: 'offset null — leave open' }, 8: { nc: 'not connected' },
    },
  },
  opampRails: single741('TL071', { inp: 'in+', inn: 'in-', out: 'out', vp: 'v+', vn: 'v-' }),
  opampReal: single741('TL071', { inp: 'in+', inn: 'in-', out: 'out', vp: 'vcc', vn: 'vee' }),
  lm741: single741('LM741', { inp: 'inp', inn: 'inn', out: 'out', vp: 'vcc', vn: 'vee' }),
  lm358: dualA('LM358', 'vee'),
  tl072: dualA('TL072', 'vee'),
  ne5532: dualA('NE5532', 'vee'),
  lm393: dualComparatorA('LM393', 'gnd'),
  lm324: {
    pkg: 'DIP', pins: 14, part: 'LM324',
    map: {
      1: 'out', 2: 'inn', 3: 'inp', 4: 'vcc', 11: 'vee',
      ...parkedAmp('2', 5, 6, 7, 3), ...parkedAmp('3', 10, 9, 8, 3), ...parkedAmp('4', 12, 13, 14, 3),
    },
  },
  lm7805: { pkg: 'TO-220', pins: 3, part: 'LM7805', map: { 1: 'in', 2: 'gnd', 3: 'out' } },
  lm317: { pkg: 'TO-220', pins: 3, part: 'LM317', map: { 1: 'adj', 2: 'out', 3: 'in' } },
  tl431: { pkg: 'TO-92', pins: 3, part: 'TL431', map: { 1: 'ref', 2: 'a', 3: 'c' } },
  sevenSegment: {
    pkg: '7SEG-10', pins: 10, part: '5161AS common-cathode',
    map: { 1: 'e', 2: 'd', 3: 'com', 4: 'c', 5: { nc: 'decimal point — leave open' }, 6: 'b', 7: 'a', 8: 'com', 9: 'f', 10: 'g' },
  },
  cd4026: {
    pkg: 'DIP', pins: 16, part: 'CD4026B',
    map: {
      1: 'clk', 5: 'co', 6: 'f', 7: 'g', 8: 'gnd', 9: 'd', 10: 'a', 11: 'e', 12: 'b', 13: 'c', 15: 'rst', 16: 'vcc',
      2: { tie: 'CLOCK INHIBIT — tied to VSS so the counter counts', to: 'gnd' },
      3: { tie: 'DISPLAY ENABLE IN — tied to VDD so the segments drive', to: 'vcc' },
      4: { nc: 'DISPLAY ENABLE OUT — leave open' },
      14: { nc: 'UNGATED C SEGMENT output — leave open' },
    },
  },
  cd4017: {
    pkg: 'DIP', pins: 16, part: 'CD4017B',
    map: {
      1: 'y5', 2: 'y1', 3: 'y0', 4: 'y2', 5: 'y6', 6: 'y7', 7: 'y3', 8: 'gnd',
      9: 'y8', 10: 'y4', 11: 'y9', 12: 'carry', 13: 'en', 14: 'clk', 15: 'rst', 16: 'vcc',
    },
  },
  cd4511: {
    pkg: 'DIP', pins: 16, part: 'CD4511B',
    map: {
      1: 'd1', 2: 'd2', 3: 'lt', 4: 'bi', 5: 'le', 6: 'd3', 7: 'd0', 8: 'gnd',
      9: 'e', 10: 'd', 11: 'c', 12: 'b', 13: 'a', 14: 'g', 15: 'f', 16: 'vcc',
    },
  },
  cd4093: {
    pkg: 'DIP', pins: 14, part: 'CD4093B',
    map: {
      1: 'a', 2: 'b', 3: 'y', 7: 'gnd', 14: 'vcc',
      4: ncOut('gate 2'), 5: tieIn('gate 2'), 6: tieIn('gate 2'),
      8: tieIn('gate 3'), 9: tieIn('gate 3'), 10: ncOut('gate 3'),
      11: ncOut('gate 4'), 12: tieIn('gate 4'), 13: tieIn('gate 4'),
    },
  },
  nand: quad2('74HC00'),
  schmitt_nand: quad2('74HC132'),
  and: quad2('74HC08'),
  ic7408: quad2('74HC08'),
  or: quad2('74HC32'),
  ic7432: quad2('74HC32'),
  xor: quad2('74HC86'),
  ic7486: quad2('74HC86'),
  nor: nor74,
  ic7402: nor74,
  not: hex1('74HC04'),
  ic7404: hex1('74HC04'),
  schmitt_not: hex1('74HC14'),
};

/** Gummel-Poon / Level-1 plugin types share the physical part lists of the basic parts. */
const DISCRETE_ALIAS: Record<string, 'npn' | 'pnp' | 'nmos' | 'pmos'> = {
  npn: 'npn', bjtGPNpn: 'npn',
  pnp: 'pnp', bjtGPPnp: 'pnp',
  nmos: 'nmos', mosLevel1N: 'nmos',
  pmos: 'pmos', mosLevel1P: 'pmos',
};

/** The physical part (package + datasheet pin order) for a transistor component. */
export function discreteFor(type: string, partName?: unknown): DiscretePart | undefined {
  const base = DISCRETE_ALIAS[type];
  return base ? discretePartFor(base, partName) : undefined;
}

function discretePinout(d: DiscretePart): Pinout {
  return { pkg: d.pkg, pins: 3, part: d.part, map: { ...d.map } };
}

/** The Pinout for a component type (+ chosen discrete part name, if any). */
function pinoutFor(type: string, partName?: unknown): Pinout | undefined {
  const d = discreteFor(type, partName);
  return d ? discretePinout(d) : REAL_PINOUTS[type];
}

const cache = new Map<string, FootprintDef>();

/**
 * Real-package footprint, or null when the part has no verified pinout.
 * Transistors resolve per PART (`parameters.part`): a BC547 (C-B-E) and a
 * 2N3904 (E-B-C) share a symbol but not a pinout, so pad numbers follow the
 * datasheet of the chosen part.
 */
export function realPackageDef(type: string, partName?: unknown): FootprintDef | null {
  const p = pinoutFor(type, partName);
  if (!p) return null;
  const key = `${type}|${p.part}`;
  let d = cache.get(key);
  if (!d) { d = buildDef(p); cache.set(key, d); }
  return d;
}

export interface RealPackageInfo {
  /** short package name for BOMs: 'DIP-8', 'TO-92', 'SOT-23', 'TO-220' */
  pkg: string;
  /** KiCad standard-library footprint id, or null when not verified */
  kicad: string | null;
  part: string;
}

/** Package name + KiCad footprint id of the real package `realPackageDef` returns. */
export function realPackageInfo(type: string, partName?: unknown): RealPackageInfo | null {
  const p = pinoutFor(type, partName);
  if (!p) return null;
  if (p.pkg === 'DIP') {
    const ok = p.pins === 8 || p.pins === 14 || p.pins === 16 || p.pins === 18 || p.pins === 20 || p.pins === 24 || p.pins === 28;
    return { pkg: `DIP-${p.pins}`, kicad: ok ? `Package_DIP:DIP-${p.pins}_W7.62mm` : null, part: p.part };
  }
  if (p.pkg === '7SEG-10') return { pkg: '7SEG-10', kicad: null, part: p.part };
  return { pkg: p.pkg, kicad: KICAD_FOOTPRINT[p.pkg], part: p.part };
}

/**
 * Datasheet pad number for each of a component's schematic terminals, or
 * null when the type has no verified pinout. (Terminals that map to no pad
 * are absent — e.g. the Level-1 MOSFET's bulk terminal.)
 */
export function padNumbersFor(type: string, partName?: unknown): Record<string, string> | null {
  const def = realPackageDef(type, partName);
  if (!def) return null;
  const out: Record<string, string> = {};
  for (const pad of def.pads) {
    if (pad.number != null && !pad.terminalId.startsWith('pin')) out[pad.terminalId] = pad.number;
  }
  return out;
}

export { dipPos, DIP_PITCH, DIP_SPAN };
