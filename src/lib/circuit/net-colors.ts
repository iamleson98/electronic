// Net coloring — assigns colors to wires based on their net's electrical role.
//
// Each wire is part of an electrical "net" — a set of nodes unified by net
// labels, power symbols, or hierarchical labels. This module:
//
//   1. Walks the components list to find any power/net labels attached to
//      each wire's endpoints, then derives a net name.
//   2. Looks up the net name in the user's `NetClass[]` definitions; if a
//      matching class is found, uses its `color` field.
//   3. If no user-defined class, applies a built-in palette:
//        - Ground nets (GND, AGND, DGND, 0) → dark slate (#475569)
//        - Power nets (VCC, +V, 5V, 3V3, 12V, VBAT, AVDD) → red (#ef4444)
//        - Default signal nets → cyan (#22d3ee)
//
// The result is a `Map<wireId, color>` that CircuitCanvas uses for stroke colors.

import type { CircuitComponent, ComponentPlugin, Wire, NetClass } from './types';
import type { NodeMap } from './engine';

const POWER_TYPES = new Set([
  'powerGND', 'powerAGND', 'powerDGND', 'powerVCC',
  'power5V', 'power3V3', 'power1V8', 'power2V5',
  'power12V', 'powerMinus12V', 'powerMinus5V',
  'powerAVDD', 'powerVBAT', 'powerFlag',
  'netLabel', 'busLabel', 'busVectorLabel', 'hierLabel',
]);

const GROUND_NAMES = new Set(['GND', 'gnd', 'AGND', 'DGND', '0', 'AGND2']);
const POWER_PATTERNS: RegExp[] = [
  /^VCC$/i, /^VDD$/i, /^AVDD$/i, /^VBAT$/i,
  /^\+V$/, /^\+5V$/i, /^\+3V3$/i, /^\+12V$/i, /^\-12V$/i,
  /^\-5V$/i, /^\+1V8$/i, /^\+2V5$/i, /^\+15V$/i, /^\-15V$/i,
  /^5V$/i, /^3V3$/i, /^12V$/i, /^1V8$/i, /^2V5$/i, /^24V$/i,
];

/**
 * Build a lookup map of wireId → color based on the wire's net.
 *
 * @param wires the current list of wires
 * @param components the current list of components
 * @param plugins the registered plugin map
 * @param nodeMap a precomputed NodeMap from buildNodeMap (used to group wires
 *                by electrical node — all wires on the same node share a color)
 * @param netClasses user-defined net classes; their `nets` field matches by
 *                   net name; their `color` field overrides the built-in palette
 */
export function buildWireColorMap(
  wires: Wire[],
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
  nodeMap: NodeMap,
  netClasses: NetClass[] = [],
): Map<string, string> {
  // First, build nodeId → netName by scanning power/net-label components
  const nodeIdToNetName = new Map<number, string>();
  for (const comp of components) {
    if (!POWER_TYPES.has(comp.type)) continue;
    const netName = (comp.parameters.net as string) || '';
    if (!netName) continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const t of plugin.terminals) {
      const nodeId = nodeMap.terminalNode.get(`${comp.id}:${t.id}`);
      if (nodeId != null) {
        // Don't overwrite a non-ground name with a later ground name
        const existing = nodeIdToNetName.get(nodeId);
        if (!existing || isGroundName(netName)) {
          nodeIdToNetName.set(nodeId, netName);
        }
      }
    }
  }

  // Build netName → color from user netClasses
  const userColorByNet = new Map<string, string>();
  for (const nc of netClasses) {
    if (!nc.color) continue;
    for (const netName of nc.nets) {
      userColorByNet.set(netName, nc.color);
    }
  }

  // For each wire, look up its node, then derive the color
  const result = new Map<string, string>();
  for (const wire of wires) {
    const fromKey = `${wire.from.componentId}:${wire.from.terminalId}`;
    const toKey = `${wire.to.componentId}:${wire.to.terminalId}`;
    const fromNode = nodeMap.terminalNode.get(fromKey);
    const toNode = nodeMap.terminalNode.get(toKey);
    const nodeId = fromNode ?? toNode;
    if (nodeId == null) {
      result.set(wire.id, '#94a3b8'); // default slate-gray for unattached wires
      continue;
    }
    const netName = nodeIdToNetName.get(nodeId);
    const color = netName
      ? (userColorByNet.get(netName) ?? defaultColorForNet(netName))
      : '#22d3ee'; // cyan for unnamed signal nets
    result.set(wire.id, color);
  }
  return result;
}

function isGroundName(name: string): boolean {
  return GROUND_NAMES.has(name);
}

function defaultColorForNet(netName: string): string {
  if (isGroundName(netName)) return '#475569'; // dark slate
  for (const re of POWER_PATTERNS) {
    if (re.test(netName)) return '#ef4444'; // red for power
  }
  return '#22d3ee'; // cyan for signals
}

/**
 * Returns a human-readable net name for a wire (for display purposes, e.g.
 * the wire tooltip). Returns null if the net has no name.
 */
export function getNetNameForWire(
  wire: Wire,
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
  nodeMap: NodeMap,
): string | null {
  const fromKey = `${wire.from.componentId}:${wire.from.terminalId}`;
  const toKey = `${wire.to.componentId}:${wire.to.terminalId}`;
  const fromNode = nodeMap.terminalNode.get(fromKey);
  const toNode = nodeMap.terminalNode.get(toKey);
  const nodeId = fromNode ?? toNode;
  if (nodeId == null) return null;
  // Walk components looking for any net label attached to this node
  for (const comp of components) {
    if (!POWER_TYPES.has(comp.type)) continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const t of plugin.terminals) {
      const termNode = nodeMap.terminalNode.get(`${comp.id}:${t.id}`);
      if (termNode === nodeId) {
        const name = (comp.parameters.net as string) || '';
        if (name) return name;
      }
    }
  }
  return null;
}
