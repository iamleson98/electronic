/**
 * Discrete-semiconductor part catalogue — the PHYSICAL identity of a real
 * part (package + datasheet pin order + KiCad footprint id).
 *
 * A schematic transistor stores the chosen part name in `parameters.part`.
 *   - The simulator side (component plugins) maps the name to datasheet
 *     electrical parameters.
 *   - The PCB / export side maps the name to the pad → terminal order below.
 *
 * Same symbol, different pinout is the #1 real-world assembly mistake
 * (2N3904 is E-B-C, BC547 is C-B-E, 2N7000 is S-G-D, BS170 is D-G-S), so the
 * pin order is per PART, never per symbol. Pad numbers follow the datasheet
 * pin numbers, which are also the pad numbers of the referenced KiCad
 * library footprints.
 */

export type DiscretePackage = 'TO-92' | 'SOT-23' | 'TO-220';

export interface DiscretePart {
  /** Manufacturer part number as printed on the datasheet. */
  part: string;
  pkg: DiscretePackage;
  /** pad number (1-based) → schematic terminal id */
  map: Record<number, string>;
  /** KiCad standard-library footprint id (lib:footprint). */
  kicadFootprint: string;
  description: string;
}

export const KICAD_FOOTPRINT: Record<DiscretePackage, string> = {
  'TO-92': 'Package_TO_SOT_THT:TO-92_Inline',
  'SOT-23': 'Package_TO_SOT_SMD:SOT-23',
  'TO-220': 'Package_TO_SOT_THT:TO-220-3_Vertical',
};

const p = (part: string, pkg: DiscretePackage, order: string, description: string): DiscretePart => {
  const ids = order.split('');
  const map: Record<number, string> = {};
  ids.forEach((id, i) => { map[i + 1] = id; });
  return { part, pkg, map, kicadFootprint: KICAD_FOOTPRINT[pkg], description };
};

/** component type → part name → physical identity. First entry is the default. */
export const DISCRETE_PARTS: Record<'npn' | 'pnp' | 'nmos' | 'pmos', DiscretePart[]> = {
  npn: [
    p('2N3904', 'TO-92', 'ebc', 'General-purpose NPN, 40 V / 200 mA'),
    p('PN2222A', 'TO-92', 'ebc', 'General-purpose NPN, 40 V / 1 A'),
    p('P2N2222A', 'TO-92', 'cbe', 'General-purpose NPN, 40 V / 600 mA (C-B-E pinout!)'),
    p('BC547B', 'TO-92', 'cbe', 'Small-signal NPN, 45 V / 100 mA'),
    p('BC337-40', 'TO-92', 'cbe', 'Switching NPN, 45 V / 800 mA'),
    p('MMBT3904', 'SOT-23', 'bec', 'SMD 2N3904, 40 V / 200 mA'),
    p('TIP31C', 'TO-220', 'bce', 'Power NPN, 100 V / 3 A'),
  ],
  pnp: [
    p('2N3906', 'TO-92', 'ebc', 'General-purpose PNP, −40 V / −200 mA'),
    p('BC557B', 'TO-92', 'cbe', 'Small-signal PNP, −45 V / −100 mA'),
    p('BC327-40', 'TO-92', 'cbe', 'Switching PNP, −45 V / −800 mA'),
    p('MMBT3906', 'SOT-23', 'bec', 'SMD 2N3906, −40 V / −200 mA'),
    p('TIP32C', 'TO-220', 'bce', 'Power PNP, −100 V / −3 A'),
  ],
  nmos: [
    p('2N7000', 'TO-92', 'sgd', 'Small-signal N-MOSFET, 60 V / 200 mA'),
    p('BS170', 'TO-92', 'dgs', 'Small-signal N-MOSFET, 60 V / 500 mA (D-G-S pinout!)'),
    p('BSS138', 'SOT-23', 'gsd', 'Logic-level N-MOSFET, 50 V / 220 mA'),
    p('AO3400A', 'SOT-23', 'gsd', 'Logic-level N-MOSFET, 30 V / 5.7 A'),
    p('IRF540N', 'TO-220', 'gds', 'Power N-MOSFET, 100 V / 33 A (needs 10 V gate drive)'),
    p('IRLZ44N', 'TO-220', 'gds', 'Logic-level power N-MOSFET, 55 V / 47 A'),
  ],
  pmos: [
    p('BSS84', 'SOT-23', 'gsd', 'Small-signal P-MOSFET, −50 V / −130 mA'),
    p('AO3401A', 'SOT-23', 'gsd', 'Logic-level P-MOSFET, −30 V / −4 A'),
    p('IRF9540N', 'TO-220', 'gds', 'Power P-MOSFET, −100 V / −23 A'),
  ],
};

/** Resolve the physical part for a component; falls back to the type's default part. */
export function discretePartFor(type: string, partName?: unknown): DiscretePart | undefined {
  const list = (DISCRETE_PARTS as Record<string, DiscretePart[] | undefined>)[type];
  if (!list) return undefined;
  return list.find(d => d.part === partName) ?? list[0];
}
