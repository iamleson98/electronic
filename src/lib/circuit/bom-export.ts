import type { CircuitComponent, Wire, CircuitDocument, ComponentPlugin } from './types';
import { solveDC, buildNodeMap, getTerminalsForComponent, computeComponentCurrents, simulateStep } from './engine';
import { partDatabase } from '../pcb/part-database';

export interface BomLine { refdes: string; quantity: number; type: string; value: string; mpn: string | null; manufacturer: string | null; description: string | null; package: string | null; digikeyPN: string | null; mouserPN: string | null; unitPrice: number | null; extendedPrice: number | null; datasheet: string | null; }
export interface BomResult { lines: BomLine[]; totalQuantity: number; totalCost: number; matchedCount: number; unmatchedCount: number; }

function getValueString(comp: CircuitComponent): string {
  const p = comp.parameters;
  if (comp.type === 'resistor') { const r = p.resistance as number; return r >= 1e6 ? `${r/1e6}MΩ` : r >= 1e3 ? `${r/1e3}kΩ` : `${r}Ω`; }
  if (comp.type === 'capacitor') { const c = p.capacitance as number; return c >= 1e-6 ? `${c*1e6}µF` : c >= 1e-9 ? `${c*1e9}nF` : `${c*1e12}pF`; }
  if (comp.type === 'inductor') { const l = p.inductance as number; return l >= 1 ? `${l}H` : l >= 1e-3 ? `${l*1e3}mH` : `${l*1e6}µH`; }
  if (comp.type === 'dcVoltage') return `${p.voltage ?? 0}V`;
  if (comp.type === 'timer555') return 'NE555';
  if (comp.type === 'led') return p.color as string ?? 'LED';
  return comp.type;
}

function lookupPart(comp: CircuitComponent): any | null {
  if (comp.type === 'timer555') return partDatabase.find(p => p.mpn === 'NE555P') ?? null;
  if (comp.type === 'npn') return partDatabase.find(p => p.mpn === '2N3904') ?? null;
  if (comp.type === 'pnp') return partDatabase.find(p => p.mpn === '2N3906') ?? null;
  if (comp.type === 'diode') return partDatabase.find(p => p.mpn === '1N4148') ?? null;
  if (comp.type === 'led') { const c = (comp.parameters.color as string) ?? 'red'; return partDatabase.find(p => p.category === 'led' && p.description.toLowerCase().includes(c)) ?? partDatabase.find(p => p.category === 'led') ?? null; }
  if (comp.type === 'resistor') { const r = comp.parameters.resistance as number; const rStr = r >= 1e6 ? `${r/1e6}M` : r >= 1e3 ? `${r/1e3}K` : `${r}`; return partDatabase.find(p => p.category === 'resistor' && p.mpn.includes(rStr)) ?? partDatabase.find(p => p.category === 'resistor') ?? null; }
  if (comp.type === 'capacitor') { const c = comp.parameters.capacitance as number; const label = c >= 1e-6 ? `${c*1e6}uF` : `${c*1e9}nF`; return partDatabase.find(p => p.category === 'capacitor' && p.mpn.includes(label)) ?? partDatabase.find(p => p.category === 'capacitor') ?? null; }
  return null;
}

export function generateBOM(doc: CircuitDocument): BomResult { return generateBOMFromComponents(doc.components); }
export function generateBOMFromComponents(components: CircuitComponent[]): BomResult {
  const groups = new Map<string, CircuitComponent[]>();
  for (const c of components) { const key = `${c.type}:${getValueString(c)}`; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(c); }
  const lines: BomLine[] = []; let totalQ = 0, totalC = 0, matched = 0;
  for (const [key, comps] of groups) {
    const [type, value] = key.split(':'); const refdes = comps.map(c => c.refdes ?? c.id).join(', '); const qty = comps.length;
    const part = lookupPart(comps[0]);
    const line: BomLine = { refdes, quantity: qty, type, value, mpn: part?.mpn ?? null, manufacturer: part?.manufacturer ?? null, description: part?.description ?? null, package: part?.package ?? null, digikeyPN: part?.digikeyPN ?? null, mouserPN: part?.mouserPN ?? null, unitPrice: part?.unitPrice ?? null, extendedPrice: part?.unitPrice ? part.unitPrice * qty : null, datasheet: part?.datasheet ?? null };
    lines.push(line); totalQ += qty; if (line.extendedPrice !== null) totalC += line.extendedPrice; if (part) matched++;
  }
  return { lines, totalQuantity: totalQ, totalCost: totalC, matchedCount: matched, unmatchedCount: lines.length - matched };
}
export function exportBOMAsCSV(bom: BomResult): string { const h = ['Designator','Quantity','Comment','Footprint','Manufacturer Part','Manufacturer','Description','DigiKey PN','Mouser PN','Unit Price','Extended Price','Datasheet']; const rows = bom.lines.map(l => [`"${l.refdes}"`,l.quantity,`"${l.value}"`,`"${l.package??''}"`,`"${l.mpn??''}"`,`"${l.manufacturer??''}"`,`"${l.description??''}"`,`"${l.digikeyPN??''}"`,`"${l.mouserPN??''}"`,l.unitPrice??'',l.extendedPrice??'',`"${l.datasheet??''}"`].join(',')); return [h.join(','), ...rows].join('\n'); }
export function exportBOMForJLC(bom: BomResult): string { const h = ['Designator','Quantity','Comment','Footprint','Manufacturer Part']; const rows = bom.lines.map(l => [`"${l.refdes}"`,l.quantity,`"${l.value}"`,`"${l.package??''}"`,`"${l.mpn??''}"`].join(',')); return [h.join(','), ...rows].join('\n'); }
export function exportBOMForPCBWay(bom: BomResult): string { const h = ['Designator','Value','Footprint','Quantity','Manufacturer Part Number']; const rows = bom.lines.map(l => [`"${l.refdes}"`,`"${l.value}"`,`"${l.package??''}"`,l.quantity,`"${l.mpn??''}"`].join(',')); return [h.join(','), ...rows].join('\n'); }
export function exportBOMAsJSON(bom: BomResult): string { return JSON.stringify(bom, null, 2); }
