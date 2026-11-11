import type { CircuitComponent, Wire, CircuitDocument, ComponentPlugin } from './types';
import { solveDC, buildNodeMap, getTerminalsForComponent, computeComponentCurrents, simulateStep } from './engine';
import { assignRefdes } from '../pcb/netlist-sync';
import { bomItemFor, groupBomItems, isBomComponent } from '../pcb/bom-core';
import { isPhysicalType } from '../pcb/footprints';

export interface BomLine { refdes: string; quantity: number; type: string; value: string; mpn: string | null; manufacturer: string | null; description: string | null; /** package placed on the PCB (never the component type) */ package: string | null; digikeyPN: string | null; mouserPN: string | null; lcsc: string | null; unitPrice: number | null; extendedPrice: number | null; datasheet: string | null; }
export interface BomResult { lines: BomLine[]; totalQuantity: number; totalCost: number; matchedCount: number; unmatchedCount: number; }

/**
 * Lines come from the shared row builder (pcb/bom-core.ts): grouped by
 * (value, footprint), value = the component's real value, footprint = the
 * package the PCB uses, MPN only on an exact match.
 */
export function generateBOM(doc: CircuitDocument): BomResult { return generateBOMFromComponents(doc.components); }
export function generateBOMFromComponents(components: CircuitComponent[], refdesOf?: Map<string, string>): BomResult {
  // ground / power symbols, net labels, probes, behavioural sources: nothing to buy.
  // Supplies / signal sources are the board's input header (J#, 'PWR 9V').
  const physical = components.filter(c => isPhysicalType(c.type));
  const refs = refdesOf ?? assignRefdes(physical); // same designators as the PCB
  const items = physical.filter(isBomComponent).map(c => bomItemFor(c, refs.get(c.id)));
  const lines: BomLine[] = []; let totalQ = 0, totalC = 0, matched = 0;
  for (const g of groupBomItems(items)) {
    const h = g.head; const qty = g.items.length;
    const ext = h.unitPrice !== null ? h.unitPrice * qty : null;
    lines.push({ refdes: g.items.map(i => i.refdes).join(', '), quantity: qty, type: h.type, value: g.value, mpn: h.mpn || null, manufacturer: h.manufacturer || null, description: h.description || null, package: g.footprint, digikeyPN: h.digikeyPN || null, mouserPN: h.mouserPN || null, lcsc: h.lcsc || null, unitPrice: h.unitPrice, extendedPrice: ext, datasheet: h.datasheet || null });
    totalQ += qty; if (ext !== null) totalC += ext; if (h.mpn) matched++;
  }
  return { lines, totalQuantity: totalQ, totalCost: totalC, matchedCount: matched, unmatchedCount: lines.length - matched };
}
function csvCell(v: string): string { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }
export function exportBOMAsCSV(bom: BomResult): string { const h = ['Designator','Quantity','Comment','Footprint','Manufacturer Part','Manufacturer','Description','DigiKey PN','Mouser PN','Unit Price','Extended Price','Datasheet']; const rows = bom.lines.map(l => [`"${l.refdes}"`,l.quantity,`"${l.value}"`,`"${l.package??''}"`,`"${l.mpn??''}"`,`"${l.manufacturer??''}"`,`"${l.description??''}"`,`"${l.digikeyPN??''}"`,`"${l.mouserPN??''}"`,l.unitPrice??'',l.extendedPrice??'',`"${l.datasheet??''}"`].join(',')); return [h.join(','), ...rows].join('\n'); }
/** JLCPCB assembly BOM: exactly `Comment,Designator,Footprint,LCSC Part #`; LCSC numbers are never invented. */
export function exportBOMForJLC(bom: BomResult): string { const h = ['Comment','Designator','Footprint','LCSC Part #']; const rows = bom.lines.map(l => [csvCell(l.value),`"${l.refdes.split(/,\s*/).join(',')}"`,csvCell(l.package ?? ''),csvCell(l.lcsc ?? '')].join(',')); return [h.join(','), ...rows].join('\n'); }
export function exportBOMForPCBWay(bom: BomResult): string { const h = ['Designator','Value','Footprint','Quantity','Manufacturer Part Number']; const rows = bom.lines.map(l => [`"${l.refdes}"`,`"${l.value}"`,`"${l.package??''}"`,l.quantity,`"${l.mpn??''}"`].join(',')); return [h.join(','), ...rows].join('\n'); }
export function exportBOMAsJSON(bom: BomResult): string { return JSON.stringify(bom, null, 2); }
