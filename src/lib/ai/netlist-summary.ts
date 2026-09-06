// Compact circuit context for the AI — netlist + live operating point.
// ─────────────────────────────────────────────────────────────────────────────
// Injected as a system-message preamble on EVERY AI chat request (both
// /api/ai/chat and /api/ai/chat/stream). The model previously saw only
// "12 components (3× resistor, …)" — it had to burn tool-call round-trips on
// schematic.describe just to learn what connects to what. This module hands
// it the full topology + live node voltages up front, which is what makes
// active-circuit debugging ("why isn't my transistor amplifying?") actually
// smart: the model can immediately see that the emitter floats or VCE is
// 0.05 V (saturated) without a single tool call.
//
// Format (compact, token-frugal):
//   ## Current Circuit — netlist (5 components, 6 wires)
//   V1 dcVoltage 5V: p→+5V(V1), n→GND
//   R1 resistor 1kΩ: a→+5V(V1), b→N1
//   Q1 npn β=100: c→N2, b→N1, e→GND
//   ⚠️ 1 floating (unwired) pin(s): Q1.b — check whether each one should be
//   connected before assuming anything else is wrong.
//   ## Live Operating Point (t = 1.20 ms)
//   N1 [R1.b Q1.b] = 0.67 V
//   N2 [R2.a Q1.c] = 4.98 V
//   GND = 0 V (reference)

import { buildNodeMap } from '@/lib/circuit/engine';
import { getPlugin } from '@/lib/circuit/registry';
// Side effect — registers all built-in component plugins so getPlugin() and
// buildNodeMap() work wherever this module is used (server routes, tests)
// without relying on a transitive import elsewhere in the call chain.
import '@/lib/circuit/components';
import type { CircuitDocument, CircuitComponent } from '@/lib/circuit/types';

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

const SI_PREFIXES: Array<[number, string]> = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
];

/** 1000 → "1k", 4700 → "4.7k", 1e-6 → "1µ", 0.67 → "0.67", 0.0047 → "4.7m" */
export function formatSI(value: number): string {
  if (!isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  // Human-natural range (0.01 … 999) prints plainly — 0.67 V stays "0.67",
  // not "670m" (node voltages and BJT bias values read better this way).
  if (abs >= 0.01 && abs < 1000) {
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
    return `${Number(value.toFixed(digits))}`;
  }
  for (const [scale, prefix] of SI_PREFIXES) {
    if (abs >= scale) {
      const scaled = value / scale;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `${Number(scaled.toFixed(digits))}${prefix}`;
    }
  }
  return value.toExponential(1);
}

/** The 1-2 most value-dense parameters per component for netlist lines. */
const NETLIST_KEY_PARAMS = [
  'resistance', 'capacitance', 'inductance', 'voltage', 'amplitude', 'frequency',
  'zenerV', 'forwardV', 'hfe', 'gain', 'outputV', 'r1', 'r2', 'c', 'ratio',
  'astable', 'field', 'turnsRatio', 'expr', 'vdd', 'vss', 'current',
];

/** Unit suffix per key parameter — makes netlist lines read like schematics. */
const PARAM_UNITS: Record<string, string> = {
  resistance: 'Ω', capacitance: 'F', inductance: 'H',
  voltage: 'V', amplitude: 'V', zenerV: 'V', forwardV: 'V', outputV: 'V',
  frequency: 'Hz', current: 'A', field: 'T',
};

function componentValueString(c: CircuitComponent): string {
  const parts: string[] = [];
  for (const k of NETLIST_KEY_PARAMS) {
    const v = (c.parameters as any)?.[k];
    if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
    if (k === 'hfe') parts.push(`β=${v}`);
    else if (k === 'expr') parts.push(String(v).slice(0, 40));
    else if (typeof v === 'number') parts.push(formatSI(v) + (PARAM_UNITS[k] ?? ''));
    else parts.push(String(v));
    if (parts.length >= 2) break;
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

/** Visual / annotation-only types that don't appear as netlist lines. */
const NON_CIRCUIT_TYPES = new Set([
  'ground', 'powerGND', 'netLabel', 'globalLabel', 'hierLabel', 'noConnect',
  'powerFlag', 'busLabel', 'busEntry', 'junction', 'testPoint', 'connector', 'textLabel',
]);

const LABEL_TYPES = new Set(['netLabel', 'globalLabel', 'hierLabel']);
const SOURCE_TYPES = new Set(['dcVoltage', 'acVoltage', 'battery']);

// ─────────────────────────────────────────────────────────────────────────────
// Net naming — shared by the netlist + operating-point views
// ─────────────────────────────────────────────────────────────────────────────

interface NetNaming {
  nodeMap: any;
  /** node index → display name (GND, labels, rails, or N1..Nn). */
  nodeNames: Map<number, string>;
  /** node index → member pin labels ("R1.b"). */
  nodeMembers: Map<number, string[]>;
}

/**
 * Build a COMPLETE plugin map from the registry. The caller's map (built from
 * the initial circuit snapshot) may miss annotation types like ground —
 * without the ground plugin, buildNodeMap can't merge V1.n into node 0 and
 * every net name would be wrong.
 */
function completePluginMap(components: CircuitComponent[]): Map<string, any> {
  const plugins = new Map<string, any>();
  for (const c of components) {
    if (!plugins.has(c.type)) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
  }
  return plugins;
}

function computeNetNaming(components: CircuitComponent[], wires: any[]): NetNaming {
  const nodeNames = new Map<number, string>();
  const nodeMembers = new Map<number, string[]>();
  const plugins = completePluginMap(components);

  let nodeMap: any = null;
  try {
    nodeMap = buildNodeMap(components, wires, plugins);
  } catch {
    nodeMap = null;
  }

  const addMember = (node: number, member: string) => {
    if (!nodeMembers.has(node)) nodeMembers.set(node, []);
    if (!nodeMembers.get(node)!.includes(member)) nodeMembers.get(node)!.push(member);
  };

  // Priority 1 — explicit net labels (netLabel/globalLabel components name their node).
  for (const c of components) {
    if (!LABEL_TYPES.has(c.type)) continue;
    const net = String((c.parameters as any)?.net ?? '').trim();
    const node = nodeMap?.terminalNode?.get(`${c.id}:a`);
    if (net && typeof node === 'number' && !nodeNames.has(node)) nodeNames.set(node, net);
  }

  // Priority 2 — supply rails: the + terminal of a source names its node
  // (e.g. "+5V(V1)") unless a label already named it.
  for (const c of components) {
    if (!SOURCE_TYPES.has(c.type)) continue;
    const v = (c.parameters as any)?.voltage;
    const node = nodeMap?.terminalNode?.get(`${c.id}:p`);
    if (typeof node === 'number' && typeof v === 'number' && node !== 0 && !nodeNames.has(node)) {
      nodeNames.set(node, `+${formatSI(v)}V(${c.id})`);
    }
  }

  // Collect member pins for every terminal of every circuit component. Node 0
  // is always GND (the engine maps ground-type terminals there).
  for (const c of components) {
    if (NON_CIRCUIT_TYPES.has(c.type)) continue;
    const plugin = getPlugin(c.type);
    if (!plugin) continue;
    for (const t of plugin.terminals) {
      const node = nodeMap?.terminalNode?.get(`${c.id}:${t.id}`);
      if (typeof node !== 'number') continue;
      addMember(node, `${c.id}.${t.id}`);
      if (node === 0) nodeNames.set(0, 'GND');
    }
  }

  // Priority 3 (LAST) — auto-number every still-unnamed node in first-appearance
  // order, so labels and rails always win.
  let autoCounter = 0;
  for (const c of components) {
    if (NON_CIRCUIT_TYPES.has(c.type)) continue;
    const plugin = getPlugin(c.type);
    if (!plugin) continue;
    for (const t of plugin.terminals) {
      const node = nodeMap?.terminalNode?.get(`${c.id}:${t.id}`);
      if (typeof node !== 'number') continue;
      if (node === 0) nodeNames.set(0, 'GND');
      else if (!nodeNames.has(node)) nodeNames.set(node, `N${++autoCounter}`);
    }
  }

  return { nodeMap, nodeNames, nodeMembers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Netlist construction
// ─────────────────────────────────────────────────────────────────────────────

export interface NetlistResult {
  /** Human/model-readable netlist block (null when the canvas is empty). */
  text: string | null;
  /** How many circuit (non-annotation) components were included. */
  componentCount: number;
  /** Terminals not touched by any wire, as "Q1.b" strings. */
  floatingPins: string[];
}

const MAX_NETLIST_COMPONENTS = 90;

/**
 * Hierarchical block summary for large circuits: groups components by
 * category + supply rail into functional blocks (e.g. "digital: 12 parts on
 * +5V", "analog: 4 parts") so the model sees structure past the 90-part cap.
 */
export function buildBlockSummary(components: CircuitComponent[]): string | null {
  const circuitComps = components.filter(c => !NON_CIRCUIT_TYPES.has(c.type));
  if (circuitComps.length <= MAX_NETLIST_COMPONENTS) return null;
  const byCat = new Map<string, number>();
  for (const c of circuitComps) {
    const plugin = getPlugin(c.type);
    const cat = plugin?.category ?? 'other';
    byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
  }
  const parts = [...byCat.entries()].map(([cat, n]) => `${cat}: ${n}`).join(', ');
  return `## Block Summary (${circuitComps.length} parts — netlist truncated at ${MAX_NETLIST_COMPONENTS})\n${parts}\nCall schematic.describe for full connectivity.`;
}

/**
 * Build a compact SPICE-style netlist of the whole circuit with stable,
 * meaningful net names (GND, net labels, supply rails, then N1..Nn).
 */
export function buildNetlistSummary(
  components: CircuitComponent[],
  wires: any[],
): NetlistResult {
  const circuitComps = components.filter(c => !NON_CIRCUIT_TYPES.has(c.type));
  if (circuitComps.length === 0) return { text: null, componentCount: 0, floatingPins: [] };

  const { nodeMap, nodeNames } = computeNetNaming(components, wires);
  const netName = (node: number | undefined): string => {
    if (node === undefined) return '∅';
    return nodeNames.get(node) ?? `N${node + 1}`;
  };

  // Which terminals are actually wired (for floating detection).
  const wiredTerminals = new Set<string>();
  for (const w of wires ?? []) {
    wiredTerminals.add(`${w.from.componentId}:${w.from.terminalId}`);
    wiredTerminals.add(`${w.to.componentId}:${w.to.terminalId}`);
  }

  // ── Per-component netlist lines ───────────────────────────────────────────
  const lines: string[] = [];
  const floatingPins: string[] = [];
  let included = 0;
  let truncated = false;

  for (const c of circuitComps) {
    if (included >= MAX_NETLIST_COMPONENTS) { truncated = true; break; }
    const plugin = getPlugin(c.type);
    if (!plugin) continue;
    included++;
    const pins = plugin.terminals.map(t => {
      const key = `${c.id}:${t.id}`;
      const wired = wiredTerminals.has(key);
      const node = nodeMap?.terminalNode?.get(key);
      const name = netName(node);
      if (!wired && node !== 0) floatingPins.push(`${c.id}.${t.id}`);
      return `${t.id}→${wired ? name : `${name}(FLOATING)`}`;
    });
    lines.push(`${c.id} ${c.type}${componentValueString(c)}: ${pins.join(', ')}`);
  }
  if (truncated) {
    lines.push(`… (${circuitComps.length - included} more components omitted — call schematic.describe for the rest)`);
  }

  return {
    text: lines.join('\n'),
    componentCount: circuitComps.length,
    floatingPins,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live operating point
// ─────────────────────────────────────────────────────────────────────────────

const MAX_OP_POINT_NODES = 16;

/**
 * Render the live node voltages (from the client's running simulation) with
 * pin labels, e.g. `N2 [R2.a Q1.c] = 4.98 V`. Node indices come from the same
 * buildNodeMap the engine uses, so client and server agree on numbering as
 * long as the circuit snapshot matches — which it does (sent with the request).
 */
export function buildOperatingPointSummary(
  components: CircuitComponent[],
  wires: any[],
  simContext: { nodeVoltage: ArrayLike<number>; time: number; dt: number } | null,
): string | null {
  if (!simContext || !simContext.nodeVoltage || simContext.nodeVoltage.length === 0) return null;
  const circuitComps = components.filter(c => !NON_CIRCUIT_TYPES.has(c.type));
  if (circuitComps.length === 0) return null;

  const { nodeNames, nodeMembers } = computeNetNaming(components, wires);

  const voltages = simContext.nodeVoltage;
  const lines: string[] = [];
  let shown = 0;
  for (let node = 0; node < voltages.length && shown < MAX_OP_POINT_NODES; node++) {
    const v = voltages[node];
    if (typeof v !== 'number' || !isFinite(v)) continue;
    if (node === 0) continue; // GND — implied
    const name = nodeNames.get(node) ?? `N${node + 1}`;
    const members = nodeMembers.get(node) ?? [];
    const memberStr = members.length ? ` [${members.slice(0, 4).join(' ')}]` : '';
    lines.push(`${name}${memberStr} = ${v.toFixed(3)} V`);
    shown++;
  }
  if (lines.length === 0) return null;
  const tMs = (simContext.time * 1000).toFixed(2);
  return `## Live Operating Point (t = ${tMs} ms)\n${lines.join('\n')}\nGND = 0 V (reference). Use these to check bias: BJTs need V(BE) ≈ 0.6–0.7 V and V(CE) > 0.2 V; MOSFETs need V(GS) above V(th) and V(DS) > V(GS)−V(th) for saturation; op-amps with negative feedback need V(in+) ≈ V(in−) and the output well inside the rails.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full context preamble — shared by BOTH chat routes
// ─────────────────────────────────────────────────────────────────────────────

export interface CircuitContextInput {
  doc: CircuitDocument;
  /** Live simulation state from the client (null when the sim never ran). */
  simContext?: {
    nodeVoltage: ArrayLike<number>;
    branchCurrent?: ArrayLike<number>;
    time: number;
    dt: number;
  } | null;
  /** Current simulation error message, if the user's sim is failing. */
  simError?: string | null;
  /** Whether the simulation is currently running. */
  simRunning?: boolean;
  /** Currently selected component ID, if any. */
  selectedComponentId?: string | null;
}

/**
 * Build the second system message: everything the model should know about the
 * CURRENT state of the user's circuit before it even starts thinking. Both
 * /api/ai/chat and /api/ai/chat/stream call this — kept in sync by
 * definition, not by copy-paste.
 */
export function buildContextPreamble(input: CircuitContextInput): string | null {
  const { doc } = input;
  const parts: string[] = [];

  const netlist = buildNetlistSummary(doc.components, doc.wires);
  if (netlist.text) {
    const headline = `## Current Circuit — netlist (${netlist.componentCount} components, ${doc.wires.length} wires)`;
    parts.push(`${headline}\n${netlist.text}`);
    const blocks = buildBlockSummary(doc.components);
    if (blocks) parts.push(blocks);
    if (netlist.floatingPins.length > 0) {
      parts.push(`⚠️ ${netlist.floatingPins.length} floating (unwired) pin(s): ${netlist.floatingPins.slice(0, 12).join(', ')}${netlist.floatingPins.length > 12 ? ' …' : ''} — check whether each one should be connected before assuming anything else is wrong.`);
    }
  } else {
    parts.push('## Current Circuit\nThe canvas is empty. No components or wires yet.');
  }

  // Simulation state
  if (input.simRunning !== undefined) {
    parts.push(`## Simulation State\nStatus: ${input.simRunning ? 'RUNNING' : 'STOPPED'}.`);
  }

  // Live operating point (node voltages with pin labels)
  const op = buildOperatingPointSummary(doc.components, doc.wires, input.simContext ?? null);
  if (op) parts.push(op);

  // Simulation error (CRITICAL — this is what lets the AI diagnose immediately)
  if (input.simError) {
    parts.push(`## ⚠️ SIMULATION ERROR\nThe user's simulation is failing with this error:\n"${input.simError}"\nThis is likely the root cause of whatever the user is asking about. Call ai.diagnose to get a full analysis.`);
  }

  // Selected component
  if (input.selectedComponentId) {
    const comp = doc.components.find(c => c.id === input.selectedComponentId);
    if (comp) {
      parts.push(`## Selected Component\nThe user has selected ${comp.id} (${comp.type}) at position (${comp.position.x}, ${comp.position.y}). If they ask "explain this" or "what's wrong with this", they mean this component.`);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}
