// Circuit summary for the chat UI — Bill of Materials + wire connections.
// ─────────────────────────────────────────────────────────────────────────────
// The two things that actually matter when an AI-built circuit lands on the
// canvas are WHAT parts it uses (BOM) and HOW they are wired together (the
// net list). This module derives BOTH from the applied circuit document —
// deterministic, computed from the real doc, never hallucinated by the model.
//
// Used by the ChatPanel "Circuit summary" card after the AI applies changes
// (auto mode) or offers a pending diff (review mode).

import { buildNodeMap } from '@/lib/circuit/engine';
import { getPlugin } from '@/lib/circuit/registry';
// Side effect — registers all built-in component plugins so getPlugin() and
// buildNodeMap() work wherever this module is used.
import '@/lib/circuit/components';
import type { CircuitComponent } from '@/lib/circuit/types';
import { formatSI } from './netlist-summary';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BomEntry {
  /** Display name of the component type ("Resistor", "NPN Transistor"). */
  name: string;
  /** Principal value ("10kΩ", "100µF", "NE555") — empty for abstract parts. */
  value: string;
  /** How many of this exact part the circuit uses. */
  count: number;
  /** Reference designators of those parts, in document order. */
  refdes: string[];
}

export interface NetEntry {
  /** Net display name ("GND", "VOUT", "+5V(V1)", "N1", …). */
  name: string;
  /** Member pins as "R1.a" strings. */
  members: string[];
}

export interface CircuitSummary {
  bom: BomEntry[];
  nets: NetEntry[];
  componentCount: number;
  wireCount: number;
  netCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOM
// ─────────────────────────────────────────────────────────────────────────────

/** The single most meaningful parameter of a component for a BOM line. */
const BOM_VALUE_PARAMS: Record<string, string> = {
  resistor: 'resistance',
  capacitor: 'capacitance',
  inductor: 'inductance',
  dcVoltage: 'voltage',
  acVoltage: 'amplitude',
  battery: 'voltage',
  currentSource: 'current',
  zener: 'zenerV',
  potentiometer: 'resistance',
  photoresistor: 'darkR',
};

const BOM_VALUE_UNITS: Record<string, string> = {
  resistance: 'Ω',
  capacitance: 'F',
  inductance: 'H',
  voltage: 'V',
  amplitude: 'V',
  current: 'A',
  zenerV: 'V',
  darkR: 'Ω',
};

/** Special-cased part numbers / plain labels for non-numeric parts. */
function bomValueString(c: CircuitComponent): string {
  const paramKey = BOM_VALUE_PARAMS[c.type];
  if (paramKey) {
    const v = (c.parameters as any)?.[paramKey];
    if (typeof v === 'number' && isFinite(v)) {
      return `${formatSI(v)}${BOM_VALUE_UNITS[paramKey] ?? ''}`;
    }
  }
  if (c.type === 'led') return String((c.parameters as any)?.color ?? 'LED');
  if (c.type === 'timer555') return 'NE555';
  if (c.type === 'npn' || c.type === 'pnp') {
    const hfe = (c.parameters as any)?.hfe;
    return typeof hfe === 'number' ? `β=${hfe}` : c.type.toUpperCase();
  }
  if (c.type === 'netLabel') return String((c.parameters as any)?.net ?? 'net');
  return '';
}

/** Types that are pure annotations — never appear in the BOM or net members. */
const NON_BOM_TYPES = new Set([
  'ground', 'powerGND', 'noConnect', 'junction', 'textLabel', 'busEntry',
  'netLabel', 'globalLabel', 'hierLabel', 'powerFlag', 'busLabel', 'busVectorLabel',
]);

/** Group components into BOM lines (same type + same value = one line). */
export function buildBomEntries(components: CircuitComponent[]): BomEntry[] {
  const groups = new Map<string, CircuitComponent[]>();
  for (const c of components) {
    if (NON_BOM_TYPES.has(c.type)) continue;
    const plugin = getPlugin(c.type);
    if (!plugin) continue; // unknown type — do not crash the card
    const key = `${c.type}|${bomValueString(c)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const entries: BomEntry[] = [];
  for (const comps of groups.values()) {
    const plugin = getPlugin(comps[0].type);
    entries.push({
      name: plugin?.name ?? comps[0].type,
      value: bomValueString(comps[0]),
      count: comps.length,
      refdes: comps.map(c => c.refdes || c.id),
    });
  }
  // Stable, readable order: most-used parts first, then alphabetically.
  entries.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nets (wire connections)
// ─────────────────────────────────────────────────────────────────────────────

const LABEL_TYPES = new Set(['netLabel', 'globalLabel', 'hierLabel']);
const SOURCE_TYPES = new Set(['dcVoltage', 'acVoltage', 'battery']);
const POWER_SYMBOL_TYPES = new Set([
  'powerVCC', 'power5V', 'power3V3', 'power1V8', 'power2V5', 'power12V',
  'powerMinus12V', 'powerMinus5V', 'powerAVDD', 'powerVBAT', 'powerAGND',
]);

/**
 * Derive the wire-connection view: which pins share which net. Net naming
 * mirrors the netlist context the AI itself sees (GND, explicit labels,
 * supply rails, then N1..Nn) so the card and the model agree.
 */
export function buildNetEntries(components: CircuitComponent[], wires: any[]): NetEntry[] {
  const plugins = new Map<string, any>();
  for (const c of components) {
    if (!plugins.has(c.type)) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
  }

  let nodeMap: { terminalNode: Map<string, number> } | null = null;
  try {
    nodeMap = buildNodeMap(components, wires, plugins) as any;
  } catch {
    nodeMap = null;
  }

  const nodeNames = new Map<number, string>();
  const nodeMembers = new Map<number, string[]>();

  const addMember = (node: number, member: string) => {
    if (!nodeMembers.has(node)) nodeMembers.set(node, []);
    const list = nodeMembers.get(node)!;
    if (!list.includes(member)) list.push(member);
  };

  // Priority 1 — explicit net labels name their node.
  for (const c of components) {
    if (!LABEL_TYPES.has(c.type)) continue;
    const net = String((c.parameters as any)?.net ?? '').trim();
    const node = nodeMap?.terminalNode?.get(`${c.id}:a`);
    if (net && typeof node === 'number' && !nodeNames.has(node)) nodeNames.set(node, net);
  }

  // Priority 2 — power symbols name their rail (+5V, 3V3, VCC…).
  for (const c of components) {
    if (!POWER_SYMBOL_TYPES.has(c.type)) continue;
    const net = String((c.parameters as any)?.net ?? '').trim();
    const plugin = plugins.get(c.type);
    const termId = plugin?.terminals?.[0]?.id;
    const node = termId !== undefined ? nodeMap?.terminalNode?.get(`${c.id}:${termId}`) : undefined;
    if (net && typeof node === 'number' && node !== 0 && !nodeNames.has(node)) nodeNames.set(node, net);
  }

  // Priority 3 — the + terminal of a source names its rail ("+5V(V1)").
  for (const c of components) {
    if (!SOURCE_TYPES.has(c.type)) continue;
    const v = (c.parameters as any)?.voltage;
    const node = nodeMap?.terminalNode?.get(`${c.id}:p`);
    if (typeof node === 'number' && typeof v === 'number' && node !== 0 && !nodeNames.has(node)) {
      nodeNames.set(node, `+${formatSI(v)}V(${c.id})`);
    }
  }

  // Members: every terminal of every real component (annotation types excluded).
  for (const c of components) {
    const plugin = plugins.get(c.type);
    if (!plugin) continue;
    if (NON_BOM_TYPES.has(c.type)) continue;
    for (const t of plugin.terminals) {
      const node = nodeMap?.terminalNode?.get(`${c.id}:${t.id}`);
      if (typeof node !== 'number') continue;
      addMember(node, `${c.refdes || c.id}.${t.id}`);
      if (node === 0) nodeNames.set(0, 'GND');
    }
  }

  // Priority 4 (LAST) — auto-number remaining nodes in first-appearance order.
  let autoCounter = 0;
  for (const c of components) {
    const plugin = plugins.get(c.type);
    if (!plugin || NON_BOM_TYPES.has(c.type)) continue;
    for (const t of plugin.terminals) {
      const node = nodeMap?.terminalNode?.get(`${c.id}:${t.id}`);
      if (typeof node !== 'number') continue;
      if (node === 0) nodeNames.set(0, 'GND');
      else if (!nodeNames.has(node)) nodeNames.set(node, `N${++autoCounter}`);
    }
  }

  const nets: NetEntry[] = [];
  for (const [node, members] of nodeMembers) {
    // Skip single-pin "nets" — a lone unwired pin is not a connection.
    if (node !== 0 && members.length < 2) continue;
    nets.push({ name: nodeNames.get(node) ?? `N${node}`, members });
  }
  // GND first, then labeled nets, then numbered nets — stable and readable.
  nets.sort((a, b) => {
    const rank = (n: NetEntry) => (n.name === 'GND' ? 0 : n.name.startsWith('+') || /^[A-Za-z]/.test(n.name) && !/^N\d+$/.test(n.name) ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return nets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────────────

export function summarizeCircuitDoc(components: CircuitComponent[], wires: any[]): CircuitSummary {
  const bom = buildBomEntries(components);
  const nets = buildNetEntries(components, wires);
  return {
    bom,
    nets,
    componentCount: bom.reduce((s, e) => s + e.count, 0),
    wireCount: wires?.length ?? 0,
    netCount: nets.length,
  };
}
