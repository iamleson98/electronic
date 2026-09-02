// Netlist & BOM exporters — KiCad eeschema "File → Export" parity.
//
// Exports:
//   - SPICE netlist (.cir / .net) — for round-tripping to ngspice/LTspice
//   - KiCad PCB netlist (.net) — for pushing design to pcbnew
//   - BOM (CSV, HTML, XML) — with MPN/distributor/DNP fields

import type { CircuitComponent, CircuitDocument, Wire, ComponentPlugin } from './types';
import { getPlugin } from './registry';
import { buildNodeMap } from './engine';

// ─────────────────────────────────────────────────────────────────────────────
// Build a list of nets with their member terminals (component.refdes.terminalId)
// ─────────────────────────────────────────────────────────────────────────────

interface Net {
  id: number;
  name: string;
  pins: { refdes: string; termId: string; pinNumber?: string }[];
}

function buildNets(doc: CircuitDocument): Net[] {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of doc.components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);

  // collect named nets from netLabel / globalLabel / power symbols
  const namedNets = new Map<number, string>();
  for (const comp of doc.components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const netName = comp.parameters.net as string | undefined;
    if (!netName) continue;
    if (comp.type === 'netLabel' || comp.type === 'globalLabel' || comp.type === 'hierLabel' ||
        comp.type === 'powerGND' || comp.type === 'powerVCC' || comp.type === 'power5V' ||
        comp.type === 'power3V3' || comp.type === 'power12V' || comp.type === 'powerMinus12V' ||
        comp.type === 'powerFlag' || comp.type === 'customPower') {
      const term = plugin.terminals.find((t) => t.id === 'p');
      if (!term) continue;
      const key = `${comp.id}:${term.id}`;
      const node = nodeMap.terminalNode.get(key);
      if (node === undefined) continue;
      if (!namedNets.has(node)) {
        namedNets.set(node, netName);
      }
    }
  }

  // collect pins per node
  const netMap = new Map<number, { refdes: string; termId: string; pinNumber?: string }[]>();
  for (const comp of doc.components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const term of plugin.terminals) {
      const key = `${comp.id}:${term.id}`;
      const node = nodeMap.terminalNode.get(key);
      if (node === undefined) continue;
      const refdes = comp.refdes ?? comp.id;
      const pinNumber = term.number;
      if (!netMap.has(node)) netMap.set(node, []);
      netMap.get(node)!.push({ refdes, termId: term.id, pinNumber });
    }
  }

  const nets: Net[] = [];
  for (const [node, pins] of netMap) {
    if (node === 0) {
      nets.push({ id: 0, name: 'GND', pins });
    } else {
      nets.push({ id: node, name: namedNets.get(node) ?? `N${String(node).padStart(4, '0')}`, pins });
    }
  }
  nets.sort((a, b) => a.id - b.id);
  return nets;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPICE netlist export (.cir)
//   Format:
//     * Title
//     .SUBCKT ...
//     R1 n1 n2 1k
//     C1 n1 n2 1u
//     ...
//     .END
// ─────────────────────────────────────────────────────────────────────────────

const SPICE_TYPE_MAP: Record<string, string> = {
  resistor: 'R',
  capacitor: 'C',
  inductor: 'L',
  diode: 'D',
  led: 'D',
  zener: 'D',
  schottky: 'D',
  dcVoltage: 'V',
  acVoltage: 'V',
  pulseSource: 'V',
  currentSource: 'I',
  bvSource: 'B',
  biSource: 'B',
  npn: 'Q',
  pnp: 'Q',
  nmos: 'M',
  pmos: 'M',
  switch: 'S',
  pushButton: 'S',
  transLineLossless: 'T',
  transLineLossy: 'O',
};

/** Format a value with SPICE engineering suffixes, compact (no unit noise). */
function formatSpiceCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toPrecision(4)}g`;
  if (abs >= 1e6) return `${(v / 1e6).toPrecision(4)}meg`;
  if (abs >= 1e3) return `${(v / 1e3).toPrecision(4)}k`;
  if (abs >= 1) return `${v.toPrecision(4)}`;
  if (abs >= 1e-3) return `${(v / 1e-3).toPrecision(4)}m`;
  if (abs >= 1e-6) return `${(v / 1e-6).toPrecision(4)}u`;
  if (abs >= 1e-9) return `${(v / 1e-9).toPrecision(4)}n`;
  if (abs >= 1e-12) return `${(v / 1e-12).toPrecision(4)}p`;
  return `${(v / 1e-15).toPrecision(4)}f`;
}

export function exportSPICENetlist(doc: CircuitDocument, title: string = 'Circuit'): string {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of doc.components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);

  const nets = buildNets(doc);
  const netNameMap = new Map<number, string>();
  for (const n of nets) netNameMap.set(n.id, n.name);
  const nodeName = (id: number) => id === 0 ? '0' : (netNameMap.get(id) ?? `N${id}`);

  const lines: string[] = [];
  lines.push(`* ${title}`);
  lines.push(`* Exported from CircuitLab on ${new Date().toISOString()}`);
  // Lossy lines reference an LTRA .model card; collect one per distinct
  // parameter set (most designs have a handful).
  const ltraModels = new Map<string, string>(); // modelName -> .model line

  for (const comp of doc.components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const refdes = comp.refdes ?? comp.id;
    const spiceLetter = SPICE_TYPE_MAP[comp.type] ?? 'X';
    // collect terminal node names (only first 2-3 for basic components)
    const terms = plugin.terminals.filter((t) => !t.hidden);
    const nodeNames = terms.map((t) => {
      const key = `${comp.id}:${t.id}`;
      const node = nodeMap.terminalNode.get(key);
      return nodeName(node ?? 0);
    });
    // value
    let value = '';
    if (comp.type === 'resistor') value = formatSpiceValue(comp.parameters.resistance as number, '');
    else if (comp.type === 'capacitor') value = formatSpiceValue(comp.parameters.capacitance as number, 'F');
    else if (comp.type === 'inductor') value = formatSpiceValue(comp.parameters.inductance as number, 'H');
    else if (comp.type === 'dcVoltage') value = `${comp.parameters.voltage ?? 5}`;
    else if (comp.type === 'acVoltage') {
      // Round-trip the offset too — exporting SINE(0 ...) silently discarded
      // the user's DC offset on every export→import cycle.
      const off = comp.parameters.offset ?? 0;
      const amp = comp.parameters.amplitude ?? 1;
      const freq = comp.parameters.frequency ?? 50;
      value = `SINE(${off} ${amp} ${freq})`;
    } else if (comp.type === 'bvSource' || comp.type === 'biSource') {
      // ngspice B-element: B1 n+ n- V=expr (voltage) or I=expr (current).
      // Quoted so expressions containing spaces/commas survive one line.
      const kind = comp.type === 'bvSource' ? 'V' : 'I';
      value = `${kind}='${(comp.parameters.expr as string) ?? '0'}'`;
    } else if (comp.type === 'transLineLossless') {
      // SPICE T element: T<name> portA+ portA- portB+ portB- Z0=<z> TD=<t>
      value = `Z0=${formatSpiceCompact(comp.parameters.Z0 as number ?? 50)} TD=${formatSpiceCompact(comp.parameters.Td as number ?? 1e-9)}`;
    } else if (comp.type === 'transLineLossy') {
      // ngspice lossy line: O<name> a1 a2 b1 b2 <modelname> + .model LTRA
      const modelName = `LTRA_${(comp.refdes ?? comp.id).replace(/[^a-zA-Z0-9_]/g, '')}`;
      const R = (comp.parameters.RperLen as number) ?? 0.1;
      const Lp = (comp.parameters.LperLen as number) ?? 250e-9;
      const G = (comp.parameters.GperLen as number) ?? 1e-9;
      const C = (comp.parameters.CperLen as number) ?? 100e-12;
      const len = (comp.parameters.length as number) ?? 0.1;
      ltraModels.set(modelName,
        `.model ${modelName} LTRA(R=${formatSpiceCompact(R)} L=${formatSpiceCompact(Lp)} G=${formatSpiceCompact(G)} C=${formatSpiceCompact(C)} LEN=${formatSpiceCompact(len)})`);
      value = modelName;
    } else if (comp.type === 'diode' || comp.type === 'led' || comp.type === 'zener') {
      value = comp.parameters.modelName as string ?? '1N4148';
    } else if (comp.type === 'npn' || comp.type === 'pnp' || comp.type === 'nmos' || comp.type === 'pmos') {
      value = comp.parameters.modelName as string ?? (comp.type === 'npn' ? '2N3904' : comp.type === 'pnp' ? '2N3906' : comp.type === 'nmos' ? '2N7000' : 'BS250');
    } else {
      // generic sub-circuit call
      value = comp.type;
    }
    lines.push(`${spiceLetter}${refdes.replace(/[^a-zA-Z0-9]/g, '')} ${nodeNames.join(' ')} ${value}`);
  }

  // .model statements (very basic)
  lines.push(`.model 1N4148 D(Is=2.682n N=1.836 Rs=0.5661 Cjo=4p M=0.3333 Vj=0.5 Tt=4.5n)`);
  lines.push(`.model 2N3904 NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=0.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=0.3335 Vjc=0.75 Cje=4.493p Mje=0.3333 Vje=0.75 Tr=239.5n Tf=301.2p Itf=0.4 Vtf=4 Xtf=2)`);
  lines.push(`.model 2N3906 PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.977 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=0.3333 Vjc=0.75 Cje=8.063p Mje=0.3333 Vje=0.75 Tr=33.4n Tf=179.3p Itf=0.4 Vtf=4 Xtf=6)`);
  lines.push(`.model 2N7000 NMOS(Vto=2.1 Kp=0.1)`);
  lines.push(`.model BS250 PMOS(Vto=-2 Kp=0.05)`);
  // LTRA models for lossy transmission lines (deduped per model name)
  for (const m of ltraModels.values()) lines.push(m);

  // .tran / .end
  const lastTime = 10e-3;
  lines.push(`.tran 1u ${lastTime.toFixed(6)}`);
  lines.push(`.end`);
  return lines.join('\n');
}

function formatSpiceValue(v: number, unit: string): string {
  if (unit === 'F') {
    if (v >= 1) return `${v}`;
    if (v >= 1e-3) return `${(v * 1e3).toFixed(4)}m`;
    if (v >= 1e-6) return `${(v * 1e6).toFixed(4)}u`;
    if (v >= 1e-9) return `${(v * 1e9).toFixed(4)}n`;
    return `${(v * 1e12).toFixed(4)}p`;
  }
  if (unit === 'H') {
    if (v >= 1) return `${v}`;
    if (v >= 1e-3) return `${(v * 1e3).toFixed(4)}m`;
    if (v >= 1e-6) return `${(v * 1e6).toFixed(4)}u`;
    return `${(v * 1e9).toFixed(4)}n`;
  }
  // resistance — SPICE suffix is optional
  if (v >= 1e6) return `${(v / 1e6).toFixed(4)}Meg`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(4)}k`;
  return `${v}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// KiCad PCB netlist export (.net XML format — KiCad 6+ uses .kicad_netlist)
// ─────────────────────────────────────────────────────────────────────────────

export function exportKiCadNetlist(doc: CircuitDocument, title: string = 'Circuit'): string {
  const nets = buildNets(doc);
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of doc.components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }

  const compNodes = doc.components.map((comp) => {
    const plugin = plugins.get(comp.type);
    const refdes = comp.refdes ?? comp.id;
    const footprint = comp.fields?.find((f) => f.key === 'Footprint')?.value ?? plugin?.defaultFootprint ?? 'Unknown';
    const value = comp.parameters.resistance ?? comp.parameters.voltage ?? comp.parameters.capacitance ?? comp.type;
    const datasheet = comp.fields?.find((f) => f.key === 'Datasheet')?.value ?? plugin?.datasheet ?? '';
    return `    <comp ref="${escapeXML(refdes)}">
      <value>${escapeXML(String(value))}</value>
      <footprint>${escapeXML(footprint)}</footprint>
      <datasheet>${escapeXML(datasheet)}</datasheet>
${(comp.fields ?? []).filter((f) => f.key !== 'Footprint' && f.key !== 'Datasheet').map((f) => `      <field name="${escapeXML(f.name)}">${escapeXML(f.value)}</field>`).join('\n')}
    </comp>`;
  }).join('\n');

  const netNodes = nets.map((n) => {
    const pinNodes = n.pins.map((p) => `        <node ref="${escapeXML(p.refdes)}" pin="${escapeXML(p.pinNumber ?? p.termId)}"/>`).join('\n');
    return `    <net code="${n.id}" name="${escapeXML(n.name)}">
${pinNodes}
    </net>`;
  }).join('\n');

  const date = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<export version="E-DRAFT">
  <design>
    <source>${escapeXML(title)}</source>
    <date>${date}</date>
    <tool>CircuitLab Web EDA</tool>
  </design>
  <components>
${compNodes}
  </components>
  <nets>
${netNodes}
  </nets>
</export>
`;
}

function escapeXML(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

// ─────────────────────────────────────────────────────────────────────────────
// BOM export (CSV / HTML / XML) — with MPN, distributor, DNP support
// ─────────────────────────────────────────────────────────────────────────────

export interface BOMRow {
  designators: string[];
  quantity: number;
  value: string;
  footprint: string;
  manufacturer?: string;
  mpn?: string;
  digikeyPN?: string;
  mouserPN?: string;
  description: string;
  dnp: boolean;
}

export function buildBOMRows(doc: CircuitDocument): BOMRow[] {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of doc.components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const groups = new Map<string, BOMRow>();
  for (const comp of doc.components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const refdes = comp.refdes ?? comp.id;
    const dnp = comp.fields?.find((f) => f.key === 'DNP')?.value === 'true';
    const footprint = comp.fields?.find((f) => f.key === 'Footprint')?.value ?? plugin.defaultFootprint ?? 'Unknown';
    const mpn = comp.fields?.find((f) => f.key === 'MPN')?.value;
    const manufacturer = comp.fields?.find((f) => f.key === 'Manufacturer')?.value;
    const digikeyPN = comp.fields?.find((f) => f.key === 'DigiKeyPN')?.value;
    const mouserPN = comp.fields?.find((f) => f.key === 'MouserPN')?.value;
    const value = String(comp.parameters.resistance ?? comp.parameters.voltage ?? comp.parameters.capacitance ?? comp.parameters.inductance ?? comp.type);

    // group by (footprint, value, mpn)
    const key = `${footprint}|${value}|${mpn ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        designators: [], quantity: 0, value, footprint,
        manufacturer, mpn, digikeyPN, mouserPN,
        description: plugin.description, dnp,
      });
    }
    const row = groups.get(key)!;
    row.designators.push(refdes);
    row.quantity++;
  }
  return Array.from(groups.values()).sort((a, b) => a.footprint.localeCompare(b.footprint));
}

export function exportBOMCSV(doc: CircuitDocument): string {
  const rows = buildBOMRows(doc);
  const header = ['Designator', 'Quantity', 'Value', 'Footprint', 'Manufacturer', 'MPN', 'DigiKeyPN', 'MouserPN', 'Description', 'DNP'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      `"${r.designators.join(', ')}"`,
      r.quantity,
      `"${r.value}"`,
      `"${r.footprint}"`,
      `"${r.manufacturer ?? ''}"`,
      `"${r.mpn ?? ''}"`,
      `"${r.digikeyPN ?? ''}"`,
      `"${r.mouserPN ?? ''}"`,
      `"${r.description}"`,
      r.dnp ? 'DNP' : '',
    ].join(','));
  }
  return lines.join('\n');
}

export function exportBOMHTML(doc: CircuitDocument, title: string = 'Bill of Materials'): string {
  const rows = buildBOMRows(doc);
  const totalQty = rows.reduce((sum, r) => sum + (r.dnp ? 0 : r.quantity), 0);
  const lineItems = rows.length;
  const date = new Date().toLocaleDateString();

  const rowHtml = rows.map((r, i) => `
      <tr class="${r.dnp ? 'dnp' : ''}">
        <td>${i + 1}</td>
        <td>${r.designators.map((d) => `<span class="refdes">${escapeXML(d)}</span>`).join(', ')}</td>
        <td>${r.quantity}</td>
        <td>${escapeXML(r.value)}</td>
        <td>${escapeXML(r.footprint)}</td>
        <td>${escapeXML(r.manufacturer ?? '')}</td>
        <td>${escapeXML(r.mpn ?? '')}</td>
        <td>${escapeXML(r.digikeyPN ?? '')}</td>
        <td>${escapeXML(r.mouserPN ?? '')}</td>
        <td>${escapeXML(r.description)}</td>
        <td>${r.dnp ? 'DNP' : ''}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeXML(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #1e293b; }
    h1 { color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 0.5rem; }
    .meta { color: #64748b; margin-bottom: 1rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { background: #1e293b; color: white; padding: 0.5rem; text-align: left; }
    td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #e2e8f0; }
    tr:nth-child(even) { background: #f8fafc; }
    tr.dnp { color: #94a3b8; font-style: italic; }
    .refdes { font-family: ui-monospace, monospace; }
    .footer { margin-top: 1rem; color: #64748b; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>${escapeXML(title)}</h1>
  <div class="meta">Generated ${date} · ${lineItems} line items · ${totalQty} parts (excluding DNP)</div>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Designators</th><th>Qty</th><th>Value</th><th>Footprint</th>
        <th>Manufacturer</th><th>MPN</th><th>DigiKey</th><th>Mouser</th><th>Description</th><th>DNP</th>
      </tr>
    </thead>
    <tbody>${rowHtml}
    </tbody>
  </table>
  <div class="footer">Generated by CircuitLab Web EDA</div>
</body>
</html>`;
}

export function exportBOMXML(doc: CircuitDocument): string {
  const rows = buildBOMRows(doc);
  const itemXml = rows.map((r, i) => `  <lineItem id="${i + 1}">
    <designators>${r.designators.map((d) => `<refdes>${escapeXML(d)}</refdes>`).join('')}</designators>
    <quantity>${r.quantity}</quantity>
    <value>${escapeXML(r.value)}</value>
    <footprint>${escapeXML(r.footprint)}</footprint>
    <manufacturer>${escapeXML(r.manufacturer ?? '')}</manufacturer>
    <mpn>${escapeXML(r.mpn ?? '')}</mpn>
    <digikeyPN>${escapeXML(r.digikeyPN ?? '')}</digikeyPN>
    <mouserPN>${escapeXML(r.mouserPN ?? '')}</mouserPN>
    <description>${escapeXML(r.description)}</description>
    <dnp>${r.dnp}</dnp>
  </lineItem>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<bom>
  <date>${new Date().toISOString()}</date>
  <tool>CircuitLab Web EDA</tool>
${itemXml}
</bom>
`;
}
