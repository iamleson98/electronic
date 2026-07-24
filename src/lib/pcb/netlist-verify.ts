// Netlist verification: compares the PCB netlist to the schematic netlist.
// Detects mismatches between what's connected in the schematic vs what's
// routed on the PCB.

import type { Footprint, Trace, Pad } from './types';
import type { CircuitComponent, Wire } from '../circuit/types';
import { getPlugin } from '../circuit/registry';
import { buildNodeMap } from '../circuit/engine';

export interface NetlistVerifyResult {
  ok: boolean;
  errors: { message: string; severity: 'error' | 'warning' }[];
  stats: {
    schematicNets: number;
    pcbNets: number;
    matchedNets: number;
    missingInPCB: string[];
    missingInSchematic: string[];
    padCountMismatch: { net: string; schematic: number; pcb: number }[];
  };
}

/**
 * Verify that the PCB netlist matches the schematic netlist.
 * Compares:
 * - Which nets exist in schematic vs PCB
 * - How many pads are on each net
 * - Whether all schematic components have corresponding footprints
 */
export function verifyNetlist(
  schematicComponents: CircuitComponent[],
  schematicWires: Wire[],
  pcbFootprints: Footprint[],
  pcbTraces: Trace[],
): NetlistVerifyResult {
  const errors: { message: string; severity: 'error' | 'warning' }[] = [];

  // 1. Build schematic netlist
  const plugins = new Map<string, any>();
  for (const c of schematicComponents) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const nodeMap = buildNodeMap(schematicComponents, schematicWires, plugins);

  // Map: net name → set of terminal keys (schematic side)
  const schematicNets = new Map<string, Set<string>>();
  const nodeToNetName = new Map<number, string>();
  let netCounter = 1;
  for (const [termKey, nodeId] of nodeMap.terminalNode) {
    const netName = nodeId === 0 ? 'GND' : (nodeToNetName.get(nodeId) ?? `N${netCounter++}`);
    if (nodeId !== 0) nodeToNetName.set(nodeId, netName);
    if (!schematicNets.has(netName)) schematicNets.set(netName, new Set());
    schematicNets.get(netName)!.add(termKey);
  }

  // 2. Build PCB netlist from footprints
  const pcbNets = new Map<string, Set<string>>();
  for (const fp of pcbFootprints) {
    for (const pad of fp.pads) {
      const termKey = `${pad.componentId}:${pad.terminalId}`;
      const net = pad.net ?? '';
      if (!net) continue;
      if (!pcbNets.has(net)) pcbNets.set(net, new Set());
      pcbNets.get(net)!.add(termKey);
    }
  }

  // Also include nets from traces
  for (const trace of pcbTraces) {
    if (!pcbNets.has(trace.net)) pcbNets.set(trace.net, new Set());
  }

  // 3. Compare nets
  const missingInPCB: string[] = [];
  const missingInSchematic: string[] = [];
  const padCountMismatch: { net: string; schematic: number; pcb: number }[] = [];

  for (const [netName, schematicPads] of schematicNets) {
    if (!pcbNets.has(netName)) {
      missingInPCB.push(netName);
      errors.push({
        message: `Net "${netName}" exists in schematic but not in PCB (missing pads or import error)`,
        severity: 'error',
      });
    } else {
      const pcbPadCount = pcbNets.get(netName)!.size;
      const schematicPadCount = schematicPads.size;
      if (pcbPadCount !== schematicPadCount) {
        padCountMismatch.push({ net: netName, schematic: schematicPadCount, pcb: pcbPadCount });
        errors.push({
          message: `Net "${netName}": ${schematicPadCount} pads in schematic, ${pcbPadCount} in PCB`,
          severity: 'warning',
        });
      }
    }
  }

  for (const [netName] of pcbNets) {
    if (!schematicNets.has(netName)) {
      missingInSchematic.push(netName);
      // Only warn for non-empty net names
      if (netName && netName !== 'unrouted') {
        errors.push({
          message: `Net "${netName}" exists in PCB but not in schematic (extra trace?)`,
          severity: 'warning',
        });
      }
    }
  }

  // 4. Check component count
  const schematicComponentIds = new Set(schematicComponents.map((c) => c.id));
  const pcbComponentIds = new Set(pcbFootprints.map((f) => f.componentId));
  for (const id of schematicComponentIds) {
    if (!pcbComponentIds.has(id)) {
      const comp = schematicComponents.find((c) => c.id === id);
      errors.push({
        message: `Component "${comp?.type ?? id}" (${id}) in schematic but missing from PCB`,
        severity: 'error',
      });
    }
  }
  for (const id of pcbComponentIds) {
    if (!schematicComponentIds.has(id)) {
      errors.push({
        message: `Footprint for component "${id}" in PCB but not in schematic`,
        severity: 'warning',
      });
    }
  }

  // 5. Check for unrouted nets (nets with ratsnest but no traces)
  const routedNets = new Set(pcbTraces.map((t) => t.net));
  for (const [netName] of schematicNets) {
    if (!routedNets.has(netName) && schematicNets.get(netName)!.size > 1) {
      errors.push({
        message: `Net "${netName}" is unrouted (no copper traces)`,
        severity: 'warning',
      });
    }
  }

  const matched = schematicNets.size - missingInPCB.length;
  return {
    ok: errors.filter((e) => e.severity === 'error').length === 0,
    errors,
    stats: {
      schematicNets: schematicNets.size,
      pcbNets: pcbNets.size,
      matchedNets: matched,
      missingInPCB,
      missingInSchematic,
      padCountMismatch,
    },
  };
}
