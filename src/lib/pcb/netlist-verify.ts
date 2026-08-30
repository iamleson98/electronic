// Netlist verification: compares the PCB netlist to the schematic netlist.
// Detects mismatches between what's connected in the schematic vs what's
// routed on the PCB.

import type { Footprint, Trace, Via, Pad } from './types';
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

// ─────────────────────────────────────────────────────────────────────────────
// Routing completion analysis (union-find over same-net copper)
// ─────────────────────────────────────────────────────────────────────────────

export interface NetCompletion {
  net: string;
  padCount: number;
  complete: boolean;
  /** pads not yet connected to the net's main copper cluster */
  unconnectedPads: { padId: string; position: { x: number; y: number } }[];
}

/**
 * For every net present in the footprints, determine whether ALL of its pads
 * are electrically connected through traces + vias.
 *
 * This is the correct notion of "routed" (the old completion indicator
 * counted a net as routed when ANY trace carried its name — a 4-pad net with
 * a single 2-pad trace showed up as done).
 */
export function computeNetCompletion(
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
): { nets: NetCompletion[]; routedNets: number; totalNets: number } {
  // pads by net
  const padsByNet = new Map<string, Pad[]>();
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const net = pad.net ?? '';
      if (!net) continue;
      let list = padsByNet.get(net);
      if (!list) { list = []; padsByNet.set(net, list); }
      list.push(pad);
    }
  }

  const results: NetCompletion[] = [];
  for (const [net, pads] of padsByNet) {
    if (pads.length < 2) continue;

    // union-find over: pads, trace endpoints, vias
    const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
    const nodes = new Map<string, number>();
    const parent: number[] = [];
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    const nodeAt = (x: number, y: number): number => {
      const k = key(x, y);
      let n = nodes.get(k);
      if (n === undefined) { n = parent.length; parent.push(n); nodes.set(k, n); }
      return n;
    };

    for (const t of traces) {
      if (t.net !== net) continue;
      for (const seg of t.segments) {
        union(nodeAt(seg.start.x, seg.start.y), nodeAt(seg.end.x, seg.end.y));
      }
    }
    for (const v of vias) {
      if (v.net !== net) continue;
      nodeAt(v.position.x, v.position.y);
    }
    const padNode = pads.map((p) => nodeAt(p.position.x, p.position.y));

    // co-located nodes belong together (a trace endpoint landing on a pad)
    const eps = 0.25;
    const pts = Array.from(nodes.entries()).map(([k, n]) => {
      const [xs, ys] = k.split(',');
      return { x: Number(xs) / 100, y: Number(ys) / 100, node: n };
    });
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= eps) union(pts[i].node, pts[j].node);
      }
    }

    // a pad connects to the nearest node within its capture radius
    const padCluster = pads.map((pad, i) => {
      const n = padNode[i];
      // find any node within eps of this pad
      for (const p of pts) {
        if (Math.hypot(p.x - pad.position.x, p.y - pad.position.y) <= eps) {
          union(n, p.node);
        }
      }
      return find(n);
    });

    const mainCluster = padCluster[0];
    const unconnectedPads = pads
      .map((pad, i) => ({ pad, cluster: padCluster[i] }))
      .filter((e) => e.cluster !== mainCluster)
      .map((e) => ({ padId: e.pad.id, position: { ...e.pad.position } }));

    results.push({
      net,
      padCount: pads.length,
      complete: unconnectedPads.length === 0,
      unconnectedPads,
    });
  }

  return {
    nets: results,
    routedNets: results.filter((r) => r.complete).length,
    totalNets: results.length,
  };
}
