// Single source of truth for every BOM (schematic JLC/PCBWay/CSV, PCB CSV,
// netlist-export HTML/XML) and for the KiCad netlist's component records.
//
// A BOM line must describe what is physically on the board:
//   value     = the component's ACTUAL value, engineering formatted
//               ('10k', '4.7µF', 'LED blue', '2N3904') — never a type name or
//               a default of some other part
//   footprint = the package the PCB really uses ('1206', 'DIP-8', 'TO-92'),
//               from the same resolver the PCB editor and the KiCad export use
//   MPN       = only when a real part matches EXACTLY (value + package);
//               otherwise empty. Never a near-miss, never an invented number.
//   LCSC      = never invented; only a number already present in the data.

import type { CircuitComponent } from '../circuit/types';
import { getPlugin } from '../circuit/registry';
import { footprintPackage, isPhysicalType, isMechanicalType, powerInputFor } from './footprints';
import { discreteFor, realPackageInfo } from './real-packages';
import { partDatabase, type PartInfo } from './part-database';

export interface BomItem {
  refdes: string;
  type: string;
  value: string;
  /** package placed on the PCB */
  footprint: string;
  /** KiCad standard-library id, or null (see `kicadNote`) */
  kicadFootprint: string | null;
  kicadNote?: string;
  mpn: string;
  manufacturer: string;
  description: string;
  digikeyPN: string;
  mouserPN: string;
  lcsc: string;
  datasheet: string;
  unitPrice: number | null;
}

export interface BomGroup {
  items: BomItem[];
  value: string;
  footprint: string;
  /** shared (first item's) data */
  head: BomItem;
}

const PREFIXES: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];

/** 4700 → '4.7k', 4.7e-6 + 'F' → '4.7µF', 220 → '220'. */
export function formatEng(v: number, unit = ''): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return `0${unit}`;
  const a = Math.abs(v);
  const [scale, prefix] = PREFIXES.find(([s]) => a >= s * 0.9995) ?? PREFIXES[PREFIXES.length - 1];
  const n = parseFloat((v / scale).toPrecision(3));
  return `${n}${prefix}${unit}`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const field = (c: CircuitComponent, key: string): string | undefined => c.fields?.find((f) => f.key === key)?.value || undefined;

/** The component's actual value; '' when the data does not say. */
export function componentValue(comp: CircuitComponent): string {
  const p = comp.parameters ?? {};
  const explicit = field(comp, 'Value');
  if (explicit) return explicit;
  switch (comp.type) {
    case 'resistor': { const r = num(p.resistance); return r === null ? '' : formatEng(r); }
    case 'capacitor': { const c = num(p.capacitance); return c === null ? '' : formatEng(c, 'F'); }
    case 'inductor': { const l = num(p.inductance); return l === null ? '' : formatEng(l, 'H'); }
    case 'led': return typeof p.color === 'string' && p.color ? `LED ${p.color}` : 'LED';
    case 'diode': return typeof p.part === 'string' && p.part ? p.part : 'Diode';
    default: break;
  }
  // supplies / signal sources are the board's input header: 'PWR 9V' / 'SIG IN'
  const input = powerInputFor(comp.type, p);
  if (input) return input.value;
  const d = discreteFor(comp.type, p.part);
  if (d) return d.part;
  const real = realPackageInfo(comp.type, p.part);
  if (real) return real.part;
  return getPlugin(comp.type)?.name ?? comp.type;
}

/** Real orderable MPNs this tool is confident about, by component type. */
const IC_MPN: Record<string, string> = {
  timer555: 'NE555P',
  lm358: 'LM358N',
  cd4017: 'CD4017BE',
  nand: '74HC00N',
};

function exactDbPart(mpn: string, pkg: string): PartInfo | undefined {
  return partDatabase.find((p) => p.mpn === mpn && p.package === pkg);
}

function mpnFor(comp: CircuitComponent, pkg: string): { mpn: string; db?: PartInfo } {
  const user = field(comp, 'MPN');
  if (user) return { mpn: user, db: exactDbPart(user, pkg) };
  const d = discreteFor(comp.type, comp.parameters?.part);
  if (d) return { mpn: d.part, db: exactDbPart(d.part, pkg) };
  const ic = IC_MPN[comp.type];
  if (ic) return { mpn: ic, db: exactDbPart(ic, pkg) };
  return { mpn: '' };
}

export function bomItemFor(comp: CircuitComponent, refdes?: string): BomItem {
  const fp = footprintPackage(comp.type, comp.parameters);
  const { mpn, db } = mpnFor(comp, fp.pkg);
  const plugin = getPlugin(comp.type);
  const d = discreteFor(comp.type, comp.parameters?.part);
  const input = powerInputFor(comp.type, comp.parameters);
  return {
    refdes: refdes ?? comp.refdes ?? comp.id,
    type: comp.type,
    value: componentValue(comp),
    footprint: fp.pkg,
    kicadFootprint: fp.kicad,
    ...(fp.note ? { kicadNote: fp.note } : {}),
    mpn,
    manufacturer: field(comp, 'Manufacturer') ?? db?.manufacturer ?? '',
    description: input
      ? (input.kind === 'dc' ? 'Power input header, 2.54 mm (pad 1 = +, pad 2 = −)' : 'Signal input header, 2.54 mm (pad 1 = signal, pad 2 = return)')
      : db?.description ?? d?.description ?? plugin?.description ?? comp.type,
    digikeyPN: field(comp, 'DigiKeyPN') ?? db?.digikeyPN ?? '',
    mouserPN: field(comp, 'MouserPN') ?? db?.mouserPN ?? '',
    lcsc: field(comp, 'LCSC') ?? db?.lcscPN ?? '',
    datasheet: db?.datasheet ?? '',
    unitPrice: db?.unitPrice ?? null,
  };
}

/** Does this component belong in the BOM (and the KiCad netlist)? Schematic
 *  symbols, probes, behavioural sources and mounting holes do not. */
export const isBomComponent = (comp: Pick<CircuitComponent, 'type'>): boolean =>
  isPhysicalType(comp.type) && !isMechanicalType(comp.type);

const refKey = (r: string): [string, number] => { const m = /^([A-Za-z_]*)(\d+)?/.exec(r); return [m?.[1] ?? r, m?.[2] ? parseInt(m[2], 10) : 0]; };
export function compareRefdes(a: string, b: string): number {
  const [pa, na] = refKey(a), [pb, nb] = refKey(b);
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
}

/** Group by (value, footprint[, mpn]) — 10k and 47k never share a row. */
export function groupBomItems(items: BomItem[]): BomGroup[] {
  const map = new Map<string, BomItem[]>();
  for (const it of items) {
    const key = `${it.value}\u0000${it.footprint}\u0000${it.mpn}`;
    const g = map.get(key);
    if (g) g.push(it); else map.set(key, [it]);
  }
  const groups: BomGroup[] = [];
  for (const list of map.values()) {
    list.sort((a, b) => compareRefdes(a.refdes, b.refdes));
    groups.push({ items: list, value: list[0].value, footprint: list[0].footprint, head: list[0] });
  }
  return groups.sort((a, b) => compareRefdes(a.items[0].refdes, b.items[0].refdes));
}

/** `"R1,R2,R3"` for the JLCPCB designator column. */
export const designators = (g: BomGroup) => g.items.map((i) => i.refdes).join(',');
