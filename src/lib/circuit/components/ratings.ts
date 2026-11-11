// Datasheet absolute-maximum ratings for the stress check (stress-check.ts).
//
// Every number below is the manufacturer's ABSOLUTE MAXIMUM (not the
// recommended operating value) at T = 25 °C. Parts that are not listed get no
// `ratings` hook, so the check stays silent for them instead of guessing.
//
// The hook is attached to the registered plugins when this module loads
// (components/index.ts imports it last) and again, idempotently, from
// ensureRatingsAttached() — so plugins registered later (user symbols, HMR
// re-registration) are picked up too.

import { getAllPlugins } from '../registry';
import { defaultPart } from '../discrete-presets';
import type { ComponentPlugin, PartRatings } from '../types';

type Params = Record<string, any>;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ── discrete transistors, keyed by `parameters.part` ────────────────────────

interface BjtRating { vceo: number; ic: number; pd: number; vebo: number; heatsinkPd?: boolean; freeAir?: number }
const BJT: Record<string, BjtRating> = {
  '2N3904': { vceo: 40, ic: 0.2, pd: 0.625, vebo: 6 },
  'PN2222A': { vceo: 40, ic: 1, pd: 0.625, vebo: 6 },
  'P2N2222A': { vceo: 40, ic: 0.6, pd: 0.625, vebo: 6 },
  'BC547B': { vceo: 45, ic: 0.1, pd: 0.5, vebo: 6 },
  'BC337-40': { vceo: 45, ic: 0.8, pd: 0.625, vebo: 5 },
  'MMBT3904': { vceo: 40, ic: 0.2, pd: 0.35, vebo: 6 },
  'TIP31C': { vceo: 100, ic: 3, pd: 40, vebo: 5, heatsinkPd: true, freeAir: 2 },
  '2N3906': { vceo: 40, ic: 0.2, pd: 0.625, vebo: 5 },
  'BC557B': { vceo: 45, ic: 0.1, pd: 0.5, vebo: 5 },
  'BC327-40': { vceo: 45, ic: 0.8, pd: 0.625, vebo: 5 },
  'MMBT3906': { vceo: 40, ic: 0.2, pd: 0.35, vebo: 5 },
  'TIP32C': { vceo: 100, ic: 3, pd: 40, vebo: 5, heatsinkPd: true, freeAir: 2 },
};

interface MosRating { vds: number; vgs: number; id: number; pd: number; heatsinkPd?: boolean; freeAir?: number }
const MOS: Record<string, MosRating> = {
  '2N7000': { vds: 60, vgs: 20, id: 0.2, pd: 0.4 },
  'BS170': { vds: 60, vgs: 20, id: 0.5, pd: 0.83 },
  'BSS138': { vds: 50, vgs: 20, id: 0.22, pd: 0.36 },
  'AO3400A': { vds: 30, vgs: 12, id: 5.7, pd: 1.4 },
  'IRF540N': { vds: 100, vgs: 20, id: 33, pd: 130, heatsinkPd: true, freeAir: 2 },
  'IRLZ44N': { vds: 55, vgs: 16, id: 47, pd: 110, heatsinkPd: true, freeAir: 2 },
  'BSS84': { vds: 50, vgs: 20, id: 0.13, pd: 0.36 },
  'AO3401A': { vds: 30, vgs: 12, id: 4, pd: 1.4 },
  'IRF9540N': { vds: 100, vgs: 20, id: 23, pd: 140, heatsinkPd: true, freeAir: 2 },
};

function powerRating(max: number, heatsink?: boolean, freeAir?: number): PartRatings['power'] {
  return {
    max,
    label: 'P',
    ...(heatsink ? { note: `${max} W needs a heatsink (case held at 25 °C); free-air limit is ~${freeAir ?? 2} W`, freeAir } : {}),
  };
}

function bjtRatings(kind: 'npn' | 'pnp') {
  return (p: Params): PartRatings | undefined => {
    const part = String(p.part ?? defaultPart(kind));
    const r = BJT[part];
    if (!r) return undefined;
    const npn = kind === 'npn';
    return {
      part,
      voltages: [
        // PNP: the collector sits BELOW the emitter in normal operation
        { label: 'Vceo', plus: npn ? 'c' : 'e', minus: npn ? 'e' : 'c', max: r.vceo },
        // reverse-biased base-emitter junction (avalanche beyond ~5–6 V)
        { label: 'Vebo', plus: npn ? 'e' : 'b', minus: npn ? 'b' : 'e', max: r.vebo },
      ],
      currents: [{ label: 'Ic', terminal: 'c', max: r.ic }],
      power: powerRating(r.pd, r.heatsinkPd, r.freeAir),
    };
  };
}

function mosRatings(kind: 'nmos' | 'pmos') {
  return (p: Params): PartRatings | undefined => {
    const part = String(p.part ?? defaultPart(kind));
    const r = MOS[part];
    if (!r) return undefined;
    const n = kind === 'nmos';
    return {
      part,
      voltages: [
        // PMOS: the drain sits BELOW the source in normal operation
        { label: 'Vds', plus: n ? 'd' : 's', minus: n ? 's' : 'd', max: r.vds },
        // gate oxide: ±Vgs
        { label: 'Vgs', plus: 'g', minus: 's', max: r.vgs, reverse: r.vgs },
      ],
      currents: [{ label: 'Id', terminal: 'd', max: r.id }],
      power: powerRating(r.pd, r.heatsinkPd, r.freeAir),
    };
  };
}

// ── passives & diodes ───────────────────────────────────────────────────────

const resistorRatings = (p: Params): PartRatings => ({
  part: 'resistor',
  voltages: [{ label: 'V', plus: 'a', minus: 'b', max: 200, reverse: 200, note: '1206 working voltage' }],
  power: { max: num(p.powerRating, 0.25), label: 'P' },
});

const capacitorRatings = (p: Params): PartRatings => {
  const rated = num(p.ratedVoltage, 50);
  const polarized = p.polarized === true;
  return {
    part: polarized ? 'polarized capacitor' : 'capacitor',
    voltages: [{
      label: 'V', plus: 'a', minus: 'b', max: rated,
      // an electrolytic tolerates ~0.5 V reverse; non-polarized types are symmetric
      reverse: polarized ? 0.5 : rated,
      note: polarized ? 'reverse bias on a polarized cap' : undefined,
    }],
  };
};

const ledRatings = (): PartRatings => ({
  part: 'LED',
  currents: [{ label: 'If', terminal: 'a', max: 0.03, note: '30 mA continuous (20 mA typical)' }],
  voltages: [{ label: 'Vr', plus: 'k', minus: 'a', max: 5 }],
});

const diodeRatings = (p: Params): PartRatings => ({
  part: 'diode',
  // defaults describe a 1N4148; 1N4007 = 1 A / 1000 V, 1N5819 = 1 A / 40 V
  currents: [{ label: 'If', terminal: 'a', max: num(p.ratedCurrent, 0.3) }],
  voltages: [{ label: 'Vr', plus: 'k', minus: 'a', max: num(p.ratedReverseV, 100) }],
});

const zenerRatings = (p: Params): PartRatings => ({
  part: 'zener',
  power: { max: num(p.ratedPower, 0.5), label: 'P' },
});

// ── ICs ─────────────────────────────────────────────────────────────────────

const timer555Ratings = (): PartRatings => ({
  part: 'NE555',
  voltages: [{ label: 'Vcc', plus: 'vcc', minus: 'gnd', max: 16, note: 'NE555 (bipolar) 16 V; SE555 allows 18 V' }],
  currents: [{ label: 'Iout', terminal: 'out', max: 0.2 }],
});

const lm7805Ratings = (): PartRatings => ({
  part: 'LM7805',
  voltages: [{ label: 'Vin', plus: 'in', minus: 'gnd', max: 35 }],
  currents: [{ label: 'Iout', terminal: 'out', max: 1.5, note: 'internal current limit' }],
});

const lm317Ratings = (): PartRatings => ({
  part: 'LM317',
  voltages: [{ label: 'Vin−Vout', plus: 'in', minus: 'out', max: 40 }],
  currents: [{ label: 'Iout', terminal: 'out', max: 1.5, note: 'internal current limit' }],
});

/** Behavioural op-amp with VCC/VEE pins: 741-class defaults (±18 V = 36 V; LM358 32 V is lower). */
const opampRealRatings = (): PartRatings => ({
  part: 'op-amp',
  voltages: [{ label: 'Vs', plus: 'vcc', minus: 'vee', max: 36, note: 'LM741/TL072 36 V (±18 V); LM358 is 32 V, NE5532 44 V' }],
});

const comparatorRatings = (): PartRatings => ({
  part: 'comparator',
  voltages: [{ label: 'Vs', plus: 'vcc', minus: 'vee', max: 36, note: 'LM393 36 V' }],
});

/** Named op-amp macromodels: datasheet absolute-max total supply (V+ − V−). */
const opampSupply = (part: string, max: number, note: string) => (): PartRatings => ({
  part,
  voltages: [{ label: 'Vs', plus: 'vcc', minus: 'vee', max, note }],
});

function supplyRatings(plus: string, minus: string, max: number, part: string, note: string) {
  return (): PartRatings => ({ part, voltages: [{ label: 'Vcc', plus, minus, max, note }] });
}

// ── registry hookup ─────────────────────────────────────────────────────────

const BY_TYPE: Record<string, (p: Params) => PartRatings | undefined> = {
  resistor: resistorRatings,
  capacitor: capacitorRatings,
  led: ledRatings,
  diode: diodeRatings,
  zener: zenerRatings,
  npn: bjtRatings('npn'),
  pnp: bjtRatings('pnp'),
  nmos: mosRatings('nmos'),
  pmos: mosRatings('pmos'),
  timer555: timer555Ratings,
  lm7805: lm7805Ratings,
  lm317: lm317Ratings,
  opampReal: opampRealRatings,
  lm358: opampSupply('LM358', 32, 'LM358: 32 V (±16 V) abs max'),
  lm324: opampSupply('LM324', 32, 'LM324: 32 V (±16 V) abs max'),
  lm741: opampSupply('LM741', 36, 'LM741: ±18 V abs max'),
  tl072: opampSupply('TL072', 36, 'TL072: ±18 V abs max'),
  ne5532: opampSupply('NE5532', 44, 'NE5532: ±22 V abs max'),
  lm393: supplyRatings('vcc', 'gnd', 36, 'LM393', 'LM393: 36 V abs max'),
  lm311: supplyRatings('vcc', 'gnd', 36, 'LM311', 'LM311: 36 V (V+ to V−) abs max'),
  comparator: comparatorRatings,
};

function hookFor(plugin: ComponentPlugin): ComponentPlugin['ratings'] {
  const direct = BY_TYPE[plugin.type];
  if (direct) return direct;
  const ids = new Set(plugin.terminals.map((t) => t.id));
  const pos = ids.has('vcc') ? 'vcc' : ids.has('vdd') ? 'vdd' : undefined;
  const neg = ids.has('gnd') ? 'gnd' : ids.has('vss') ? 'vss' : undefined;
  if (pos && neg) {
    // CD4000-series CMOS: 20 V absolute max (18 V recommended)
    if (/^cd40\d+/.test(plugin.type)) return supplyRatings(pos, neg, 20, 'CD4000', 'CD4000 series: 20 V abs max, 18 V recommended');
    // 74xx: 7 V absolute max (74HC 6 V recommended)
    if (/^ic74\d+/.test(plugin.type)) return supplyRatings(pos, neg, 7, '74HC', '74HC: 7 V abs max, 6 V recommended');
  }
  return undefined;
}

/** Attach the ratings hook to every registered plugin that lacks one. Idempotent. */
export function attachRatings(): void {
  for (const plugin of getAllPlugins()) {
    if (plugin.ratings) continue;
    const h = hookFor(plugin);
    if (h) plugin.ratings = h;
  }
}

attachRatings();
