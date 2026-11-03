// Netlist & BOM exporters — KiCad eeschema "File → Export" parity.
//
// Exports:
//   - SPICE netlist (.cir / .net) — for round-tripping to ngspice/LTspice
//   - KiCad PCB netlist (.net) — for pushing design to pcbnew
//   - BOM (CSV, HTML, XML) — with MPN/distributor/DNP fields

import type { CircuitComponent, CircuitDocument, Wire, ComponentPlugin } from './types';
import { getPlugin } from './registry';
import { buildNodeMap } from './engine';
import { isSchematicOnlyType } from '../pcb/footprints';
import type { OpampSpec } from './components/opamp-core';
import { toSpiceExpr } from './spice-expr';
import { simpleDiodeModel } from './components/advanced-semi';
import { thermalVoltage } from './sim-options';

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

/** Thermal voltage at 27 °C — the export's junction models are pinned so
 *  their forward drop at a reference current equals the part's own setting. */
const VT = thermalVoltage(27); // 300.15 K — what ngspice uses at TEMP = 27 °C
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '');

/**
 * SPICE netlist that ngspice / LTspice can actually run, and that behaves
 * like the circuit does in this app:
 *  - schematic-only symbols (ground = node 0, net labels, junction dots,
 *    scope / voltmeter probes) are not elements;
 *  - every element line is a real SPICE primitive with its own .model card
 *    derived from the part's parameters (hFE, Vbe, Vth, Kp, LED/diode Vf…),
 *    instead of a stock 2N3904 / 1N4148 for everything;
 *  - an ammeter is the SPICE ammeter idiom (a 0 V source), a speaker its
 *    impedance, a switch its current state;
 *  - an op-amp is a behavioural .subckt built from the same spec the app
 *    simulates (gain, GBW pole, slew, offset, bias, CMRR, rail-limited
 *    swing, Rout + short-circuit limit, supply current); a marker comment
 *    in it lets our importer restore the exact part;
 *  - parts with no SPICE primitive (555, MCUs, modules…) are listed in a
 *    warning comment — they used to be written as undefined X-subcircuit
 *    calls, which made the whole netlist fail to load.
 */
/** SPICE node name for each engine node id, as exportSPICENetlist writes it. */
export function spiceNodeNamer(doc: CircuitDocument): (id: number) => string {
  const netNameMap = new Map<number, string>();
  for (const n of buildNets(doc)) netNameMap.set(n.id, n.name);
  return (id: number) => id === 0 ? '0' : sanitize(netNameMap.get(id) ?? `N${id}`) || `N${id}`;
}

export function exportSPICENetlist(doc: CircuitDocument, title: string = 'Circuit'): string {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of doc.components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);

  const nodeName = spiceNodeNamer(doc);

  const elements: string[] = [];
  const models = new Map<string, string>();
  const omitted: string[] = [];
  const subckts: string[] = [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  for (const comp of doc.components) {
    const plugin = plugins.get(comp.type);
    if (!plugin || isSchematicOnlyType(comp.type)) continue;
    const ref = sanitize(comp.refdes ?? comp.id);
    const P = comp.parameters;
    const n = (tid: string) => nodeName(nodeMap.terminalNode.get(`${comp.id}:${tid}`) ?? 0);
    // the app's own Shockley parameters (advanced-semi simpleDiodeModel), so
    // the netlist's diodes / LEDs / zeners have the same I–V curve
    const diodeModel = (name: string) => {
      const m = simpleDiodeModel(comp.type, P);
      models.set(name, `.model ${name} D(Is=${m.Is.toExponential(4)} N=${m.N} Rs=${formatSpiceCompact(Math.max(m.Rs, 1e-3))}${m.Bv > 0 ? ` BV=${sp(m.Bv)} IBV=1m` : ''})`);
      return name;
    };
    if (plugin.opampModel) {
      const om = plugin.opampModel;
      const tids = [om.pins.inp, om.pins.inn, om.pins.out, ...(om.pins.vcc && om.pins.vee ? [om.pins.vcc, om.pins.vee] : [])];
      const node = (tid: string) => nodeMap.terminalNode.get(`${comp.id}:${tid}`) ?? 0;
      const railsWired = tids.length === 5 && (node(tids[3]) !== 0 || node(tids[4]) !== 0);
      const name = `OA_${ref}`;
      subckts.push(opampSubckt(name, comp.type, tids, P, om.spec(P), railsWired, om.rin));
      elements.push(`X${ref} ${tids.map(n).join(' ')} ${name}`);
      continue;
    }
    switch (comp.type) {
      case 'resistor':
        elements.push(`R${ref} ${n('a')} ${n('b')} ${formatSpiceValue(num(P.resistance, 1e3), '')}`); break;
      case 'capacitor':
        elements.push(`C${ref} ${n('a')} ${n('b')} ${formatSpiceValue(num(P.capacitance, 1e-6), 'F')}${P.initialV ? ` IC=${P.initialV}` : ''}`); break;
      case 'inductor':
        elements.push(`L${ref} ${n('a')} ${n('b')} ${formatSpiceValue(num(P.inductance, 1e-3), 'H')}${P.initialI ? ` IC=${P.initialI}` : ''}`); break;
      case 'potentiometer': {
        const R = num(P.resistance, 1e4), w = Math.min(1, Math.max(0, num(P.wiper, 50) / 100));
        elements.push(`R${ref}A ${n('a')} ${n('w')} ${formatSpiceValue(Math.max(R * w, 1e-3), '')}`);
        elements.push(`R${ref}B ${n('w')} ${n('b')} ${formatSpiceValue(Math.max(R * (1 - w), 1e-3), '')}`);
        break;
      }
      case 'speaker':
        elements.push(`R${ref} ${n('a')} ${n('b')} ${formatSpiceValue(num(P.impedance, 8), '')} ; speaker (resistive load)`); break;
      case 'switch': case 'pushButton': {
        const closed = comp.type === 'switch' ? !!P.closed : !!P.pressed;
        const r = closed ? num(P.resistance_on, 0.01) : num(P.resistance_off, 1e12);
        elements.push(`R${ref} ${n('a')} ${n('b')} ${formatSpiceValue(r, '')} ; ${comp.type} ${closed ? 'closed' : 'open'}`);
        break;
      }
      case 'ammeter':
        elements.push(`V${ref} ${n('p')} ${n('n')} 0 ; ammeter (reads I(V${ref}))`); break;
      case 'dcVoltage':
        elements.push(`V${ref} ${n('p')} ${n('n')} DC ${num(P.voltage, 5)}`); break;
      case 'acVoltage':
        // offset round-trips (SINE(0 …) used to drop the user's DC offset)
        elements.push(`V${ref} ${n('p')} ${n('n')} SINE(${num(P.offset, 0)} ${num(P.amplitude, 1)} ${num(P.frequency, 50)} 0 0 ${num(P.phase, 0)})`); break;
      case 'pulseSource': {
        const f = num(P.frequency, 1), per = 1 / f, pw = per * num(P.duty, 50) / 100, edge = Math.min(per / 1000, 1e-6);
        elements.push(`V${ref} ${n('p')} ${n('n')} PULSE(${num(P.low, 0)} ${num(P.high, 5)} 0 ${formatSpiceCompact(edge)} ${formatSpiceCompact(edge)} ${formatSpiceCompact(pw - edge)} ${formatSpiceCompact(per)})`);
        break;
      }
      case 'currentSource':
        elements.push(`I${ref} ${n('p')} ${n('n')} DC ${num(P.current, 0.01)}`); break;
      case 'bvSource': case 'biSource':
        elements.push(`B${ref} ${n('p')} ${n('n')} ${comp.type === 'bvSource' ? 'V' : 'I'}='${toSpiceExpr((P.expr as string) ?? '0')}'`); break;
      case 'diode':
        elements.push(`D${ref} ${n('a')} ${n('k')} ${diodeModel(`D_${ref}`)}`); break;
      case 'led':
        elements.push(`D${ref} ${n('a')} ${n('k')} ${diodeModel(`LED_${ref}`)} ; ${P.color ?? ''} LED`); break;
      case 'zener':
        elements.push(`D${ref} ${n('a')} ${n('k')} ${diodeModel(`DZ_${ref}`)}`); break;
      case 'npn': case 'pnp': {
        const vbe = num(comp.type === 'npn' ? P.vbe : P.veb, 0.7);
        const Is = 1e-3 / Math.exp(vbe / VT); // Vbe = vbe at Ic = 1 mA
        const m = `Q_${ref}`;
        models.set(m, `.model ${m} ${comp.type.toUpperCase()}(Is=${Is.toExponential(4)} Bf=${num(P.hfe, 100)})`);
        elements.push(`Q${ref} ${n('c')} ${n('b')} ${n('e')} ${m}`);
        break;
      }
      case 'nmos': case 'pmos': {
        const m = `M_${ref}`;
        const vth = Math.abs(num(P.vth, 2));
        // the part's Id = ½·kp·Vov² — SPICE Level 1 with W = L
        models.set(m, `.model ${m} ${comp.type.toUpperCase()}(Level=1 Vto=${comp.type === 'pmos' ? -vth : vth} Kp=${num(P.kp, 0.1)} Lambda=${num(P.lambda, 0.02)} Rd=${num(P.ron, 0.1)})`);
        // the 4th (bulk) node is tied to the source
        elements.push(`M${ref} ${n('d')} ${n('g')} ${n('s')} ${n('s')} ${m} W=1u L=1u`);
        break;
      }
      case 'transLineLossless':
        elements.push(`T${ref} ${n('a1')} ${n('a2')} ${n('b1')} ${n('b2')} Z0=${formatSpiceCompact(num(P.Z0, 50))} TD=${formatSpiceCompact(num(P.Td, 1e-9))}`); break;
      case 'transLineLossy': {
        const m = `LTRA_${ref}`;
        models.set(m, `.model ${m} LTRA(R=${formatSpiceCompact(num(P.RperLen, 0.1))} L=${formatSpiceCompact(num(P.LperLen, 250e-9))} G=${formatSpiceCompact(num(P.GperLen, 1e-9))} C=${formatSpiceCompact(num(P.CperLen, 100e-12))} LEN=${formatSpiceCompact(num(P.length, 0.1))})`);
        elements.push(`O${ref} ${n('a1')} ${n('a2')} ${n('b1')} ${n('b2')} ${m}`);
        break;
      }
      default:
        omitted.push(`${comp.refdes ?? comp.id} (${comp.type})`);
    }
  }

  const lines: string[] = [];
  lines.push(`* ${title}`);
  lines.push(`* Exported from CircuitLab on ${new Date().toISOString()}`);
  if (omitted.length > 0) {
    lines.push(`* WARNING: ${omitted.length} part(s) have no SPICE primitive and are NOT in this netlist —`);
    lines.push(`* add their vendor models (.subckt) to simulate them: ${omitted.join(', ')}`);
  }
  lines.push(...elements);
  for (const sc of subckts) lines.push(sc);
  for (const m of models.values()) lines.push(m);
  lines.push(`.tran 1u 10m`);
  lines.push(`.end`);
  return lines.join('\n');
}

/** SPICE number: plain decimal/exponent, no engineering suffix ambiguity. */
const sp = (v: number) => (Number.isInteger(v) ? String(v) : v.toPrecision(6).replace(/\.?0+(e|$)/, '$1'));

/**
 * Behavioural op-amp macromodel matching opamp-core.ts (B sources run in
 * ngspice and LTspice):
 *   gain stage  A0·(vd + Vos + vcm/CMRR) drives a 1 MΩ ∥ C pole node
 *               (τ = A0 / 2π·GBW); the drive current is limited to C·SR
 *               (slew rate) and a stiff clamp keeps the pole node inside the
 *               output window, so saturation recovers at once (no windup);
 *               without a pole the gain stage is a smooth tanh window
 *   output      unity buffer → current-limited Rout → OUT; the output
 *               current is drawn from V+ when sourcing, returned to V− when
 *               sinking, plus the quiescent current V+ → V−
 */
function opampSubckt(
  name: string, type: string, tids: string[], params: Record<string, unknown>,
  s: OpampSpec, railsWired: boolean, rin?: number,
): string {
  const formal = ['inp', 'inn', 'out', ...(tids.length === 5 ? ['vcc', 'vee'] : [])];
  const hi = railsWired ? `(V(vcc)-${sp(s.swingHigh)})` : `(${sp(s.defVcc - s.swingHigh)})`;
  const lo = railsWired ? `(V(vee)+${sp(s.swingLow)})` : `(${sp(s.defVee + s.swingLow)})`;
  let vd = 'V(inp)-V(inn)';
  if (s.voff !== 0) vd += `+${sp(s.voff)}`;
  if (Number.isFinite(s.cmrr)) vd += `+${sp(0.5 / Math.pow(10, s.cmrr / 20))}*(V(inp)+V(inn))`;
  const L = [
    `.subckt ${name} ${formal.join(' ')}`,
    `* circuit-lab part=${type} pins=${tids.join(',')} params=${JSON.stringify(params)}`,
    'Rleakp inp 0 1G',
    'Rleakn inn 0 1G',
  ];
  if (rin !== undefined) L.push(`Rinp inp 0 ${sp(rin)}`, `Rinn inn 0 ${sp(rin)}`);
  if (s.ibias !== 0) L.push(`Ibp inp 0 ${sp(s.ibias)}`, `Ibn inn 0 ${sp(s.ibias)}`);
  if (Number.isFinite(s.gbw)) {
    const tau = s.gain / (2 * Math.PI * s.gbw);
    const C = tau / 1e6;
    const drive = `(${sp(s.gain)}*(${vd})-V(p))*1e-6`;
    const iMax = Number.isFinite(s.slewRate) ? C * s.slewRate * 1e6 : Infinity;
    L.push(`Bgain 0 p I=${Number.isFinite(iMax) ? `max(min(${drive},${sp(iMax)}),${sp(-iMax)})` : drive}`);
    L.push(`Cpole p 0 ${sp(C)}`);
    L.push(`Bclamp p 0 I=1e3*(max(V(p)-${hi},0)+min(V(p)-${lo},0))`);
    L.push('Ebuf int 0 p 0 1');
  } else {
    // no pole: a smooth tanh window (a hard min/max clamp leaves Newton a
    // zero-slope region and ngspice's DC solve fails); the slope stays
    // > 0.2·A0 up to 90 % of the swing, so closed-loop error is unchanged
    const mid = `((${hi})+(${lo}))/2`, half = `max(((${hi})-(${lo}))/2,1e-3)`;
    L.push(`Bint int 0 V=${mid}+${half}*tanh((${sp(s.gain)}*(${vd})-${mid})/${half})`);
  }
  const iOut = `(V(int)-V(out))/${sp(s.rout)}`;
  L.push(Number.isFinite(s.iLimit)
    ? `Bout int ox I=max(min(${iOut},${sp(s.iLimit)}),${sp(-s.iLimit)})`
    : `Rout int ox ${sp(s.rout)}`);
  L.push('Vsense ox out 0');
  if (railsWired) {
    L.push('Bsrc vcc 0 I=max(I(Vsense),0)', 'Bsnk 0 vee I=-min(I(Vsense),0)');
    if (s.iq > 0) L.push(`Iq vcc vee ${sp(s.iq)}`);
  }
  L.push(`.ends ${name}`);
  return L.join('\n');
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
// KiCad PCB netlist export — modern S-expression (.kicad_netlist, KiCad 6/7/8)
// with legacy XML fallback. DNP parts are excluded unless includeDnp.
// ─────────────────────────────────────────────────────────────────────────────

function isDnp(comp: CircuitComponent): boolean {
  if (comp.variant === 'dnp') return true;
  return comp.fields?.find((f) => f.key === 'DNP')?.value === 'true';
}

export function exportKiCadNetlist(
  doc: CircuitDocument,
  title: string = 'Circuit',
  opts?: { format?: 'sexpr' | 'xml'; includeDnp?: boolean },
): string {
  if (opts?.format === 'xml') return exportKiCadNetlistXml(doc, title);
  const nets = buildNets(doc);
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of doc.components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const fitted = doc.components.filter((c) => opts?.includeDnp || !isDnp(c));
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const compNodes = fitted.map((comp) => {
    const plugin = plugins.get(comp.type);
    const refdes = comp.refdes ?? comp.id;
    const footprint = comp.fields?.find((f) => f.key === 'Footprint')?.value ?? plugin?.defaultFootprint ?? '';
    const value = comp.parameters.resistance ?? comp.parameters.voltage ?? comp.parameters.capacitance ?? comp.parameters.inductance ?? comp.type;
    const datasheet = comp.fields?.find((f) => f.key === 'Datasheet')?.value ?? plugin?.datasheet ?? '';
    const extraFields = (comp.fields ?? [])
      .filter((f) => f.key !== 'Footprint' && f.key !== 'Datasheet')
      .map((f) => `      (field (name "${esc(f.name)}") "${esc(f.value)}")`)
      .join('\n');
    return `  (comp (ref "${esc(refdes)}")\n    (value "${esc(String(value))}")\n    (footprint "${esc(footprint)}")\n    (datasheet "${esc(datasheet)}")${extraFields ? `\n${extraFields}` : ''})`;
  }).join('\n');
  const fittedRefs = new Set(fitted.map((c) => c.refdes ?? c.id));
  const netNodes = nets.map((n, i) => {
    const pinNodes = n.pins
      .filter((p) => fittedRefs.has(p.refdes))
      .map((p) => `      (node (ref "${esc(p.refdes)}") (pin "${esc(p.pinNumber ?? p.termId)}"))`)
      .join('\n');
    return `  (net (code "${i + 1}") (name "${esc(n.name)}")\n${pinNodes})`;
  }).join('\n');
  return `(export (version "E")\n  (design (source "${esc(title)}") (date "${new Date().toISOString()}") (tool "CircuitLab Web EDA"))\n  (components\n${compNodes})\n  (nets\n${netNodes})\n)\n`;
}

export function exportKiCadNetlistXml(doc: CircuitDocument, title: string = 'Circuit'): string {
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
    const dnp = isDnp(comp);
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
