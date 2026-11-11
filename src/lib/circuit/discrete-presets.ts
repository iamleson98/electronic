/**
 * Datasheet electrical presets for the discrete transistors listed in
 * part-presets.ts. Picking a part (parameters.part) overwrites the model
 * parameters below with that part's typical datasheet values; the user may
 * still tweak any parameter afterwards.
 *
 *  BJT   hfe @ Ic ≈ 2-10 mA, Vbe/Veb @ 1 mA (typ.)
 *  MOSFET  Vth (|Vth| for PMOS — the plugin stores a positive threshold) and
 *          Rds(on) at a stated |Vgs|. The plugin's channel is
 *          Rds = 1/(Kp·(|Vgs|−Vth)); 20 % of the datasheet Rds goes into the
 *          drain series resistance `ron` (bond wires / epi) and Kp is fitted
 *          so the TOTAL equals the datasheet value at that point.
 */
import { DISCRETE_PARTS } from './part-presets';

export type PresetParams = Record<string, number>;

interface BjtPreset { hfe: number; vbe: number }
interface MosPreset { vth: number; rds: number; vgs: number }

const BJT: Record<string, BjtPreset> = {
  '2N3904': { hfe: 150, vbe: 0.65 },
  'PN2222A': { hfe: 150, vbe: 0.65 },
  'P2N2222A': { hfe: 150, vbe: 0.65 },
  'BC547B': { hfe: 290, vbe: 0.62 },
  'BC337-40': { hfe: 400, vbe: 0.65 },
  'MMBT3904': { hfe: 150, vbe: 0.65 },
  'TIP31C': { hfe: 50, vbe: 0.55 },
  '2N3906': { hfe: 150, vbe: 0.65 },
  'BC557B': { hfe: 290, vbe: 0.62 },
  'BC327-40': { hfe: 400, vbe: 0.65 },
  'MMBT3906': { hfe: 150, vbe: 0.65 },
  'TIP32C': { hfe: 50, vbe: 0.55 },
};

const MOS: Record<string, MosPreset> = {
  '2N7000': { vth: 2.1, rds: 1.2, vgs: 10 },
  'BS170': { vth: 2.1, rds: 1.2, vgs: 10 },
  'BSS138': { vth: 1.3, rds: 1.0, vgs: 4.5 },
  'AO3400A': { vth: 1.05, rds: 0.019, vgs: 4.5 },
  'IRF540N': { vth: 3.0, rds: 0.04, vgs: 10 },
  'IRLZ44N': { vth: 1.5, rds: 0.025, vgs: 5 },
  'BSS84': { vth: 1.6, rds: 6, vgs: 5 },
  'AO3401A': { vth: 0.9, rds: 0.044, vgs: 4.5 },
  'IRF9540N': { vth: 3.0, rds: 0.1, vgs: 10 },
};

const sig = (x: number, n = 4) => Number(x.toPrecision(n));

/** Parameter overrides for a part, or undefined when the part has no preset. */
export function partPreset(type: string, part: unknown): PresetParams | undefined {
  const name = String(part ?? '');
  if (type === 'npn') { const b = BJT[name]; return b && { hfe: b.hfe, vbe: b.vbe }; }
  if (type === 'pnp') { const b = BJT[name]; return b && { hfe: b.hfe, veb: b.vbe }; }
  if (type === 'nmos' || type === 'pmos') {
    const m = MOS[name];
    if (!m) return undefined;
    const ron = Math.max(0.001, 0.2 * m.rds);
    const kp = 1 / (Math.max(1e-6, m.rds - ron) * (m.vgs - m.vth));
    return { vth: m.vth, kp: sig(kp), ron: sig(ron) };
  }
  return undefined;
}

/** Datasheet Rds(on) point of a MOSFET part: [Rds Ω, |Vgs| V] (for tests / docs). */
export function mosfetRdsPoint(part: string): { rds: number; vgs: number } | undefined {
  const m = MOS[part];
  return m && { rds: m.rds, vgs: m.vgs };
}

/** `select` options for the `part` parameter of a discrete transistor type. */
export function partOptions(type: 'npn' | 'pnp' | 'nmos' | 'pmos'): { label: string; value: string }[] {
  return DISCRETE_PARTS[type].map((d) => ({ label: `${d.part} — ${d.description}`, value: d.part }));
}
export const defaultPart = (type: 'npn' | 'pnp' | 'nmos' | 'pmos') => DISCRETE_PARTS[type][0].part;
