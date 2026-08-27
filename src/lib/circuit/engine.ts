// The simulation engine: builds a node index from the wire graph, stamps
// every component into an MNA system, solves it, and propagates results.
//
// Supports DC operating point and transient analysis (backward Euler).
// Non-linear components do a few Newton iterations per step (simple).

import type {
  CircuitComponent,
  ComponentPlugin,
  MnaSystem,
  SimContext,
  Wire,
} from './types';
import { createMnaSystem, solveMna } from './solver';
import { createSparseMnaSystem, solveSparse, shouldUseSparseSolver, asMnaSystem } from './sparse-klu';
import { stateKey } from './state-keys';
import { getRegistryVersion } from './registry';

export interface NodeMap {
  /** key = `${componentId}:${terminalId}` -> node id (0 = ground) */
  terminalNode: Map<string, number>;
  /** total number of nodes (including ground) */
  numNodes: number;
}

/**
 * Expand a bus vector name like "D[0..7]" into ["D0", "D1", ..., "D7"].
 * Supports [start..end] (ascending or descending).
 * Single-bit names like "D0" return ["D0"].
 * Invalid patterns return [name] unchanged.
 */
export function expandBusVector(name: string): string[] {
  // Match patterns: BASE[START..END] or BASE[START:END]
  const m = name.match(/^([A-Za-z_]\w*)\[(\d+)\.\.(\d+)\]$/);
  if (!m) return [name];
  const [, base, startStr, endStr] = m;
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);
  if (start <= end) {
    const bits: string[] = [];
    for (let i = start; i <= end; i++) bits.push(`${base}${i}`);
    return bits;
  } else {
    const bits: string[] = [];
    for (let i = start; i >= end; i--) bits.push(`${base}${i}`);
    return bits;
  }
}

/**
 * Build a node map by union-find over all terminal connections.
 * Any terminal connected to a `ground` plugin's terminal becomes node 0.
 */
/**
 * Build the node map (union-find over terminals + wires).
 *
 * MEMOIZED: the live simulation loop and the canvas render both call this
 * several times per frame with the SAME component/wire array references
 * (all store mutations replace the arrays immutably), so the result is cached
 * on (components, wires) identity + the plugin-registry generation. The cache
 * holds a single entry — the hot path is one circuit — and any topology edit
 * produces new array references, invalidating it automatically.
 */
export function buildNodeMap(components: CircuitComponent[], wires: Wire[], plugins: Map<string, ComponentPlugin>): NodeMap {
  const regVersion = getRegistryVersion();
  if (
    nodeMapCache &&
    nodeMapCache.components === components &&
    nodeMapCache.wires === wires &&
    nodeMapCache.registryVersion === regVersion
  ) {
    return nodeMapCache.map;
  }
  const map = buildNodeMapUncached(components, wires, plugins);
  nodeMapCache = { components, wires, registryVersion: regVersion, map };
  return map;
}

let nodeMapCache: {
  components: CircuitComponent[];
  wires: Wire[];
  registryVersion: number;
  map: NodeMap;
} | null = null;

function buildNodeMapUncached(components: CircuitComponent[], wires: Wire[], plugins: Map<string, ComponentPlugin>): NodeMap {
  const terminalNode = new Map<string, number>();
  const parent: number[] = [0]; // node 0 is ground

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // prefer to keep ground (0) as root
    if (ra === 0) parent[rb] = 0;
    else if (rb === 0) parent[ra] = 0;
    else parent[rb] = ra;
  }
  function newNode(): number {
    const id = parent.length;
    parent.push(id);
    return id;
  }

  function termKey(cId: string, tId: string) {
    return `${cId}:${tId}`;
  }
  function nodeFor(cId: string, tId: string): number {
    const k = termKey(cId, tId);
    let n = terminalNode.get(k);
    if (n === undefined) {
      n = newNode();
      terminalNode.set(k, n);
    }
    return n;
  }

  // First: pre-assign ground nodes from any "ground" plugin
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    if (comp.type === 'ground' || comp.type === 'powerGND') {
      for (const t of plugin.terminals) {
        const k = termKey(comp.id, t.id);
        terminalNode.set(k, 0);
      }
    }
  }

  // Power symbols & net labels: unify all terminals with the same `net` parameter
  const netToNode = new Map<string, number>();
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const isPowerSymbol =
      comp.type === 'powerGND' || comp.type === 'powerAGND' ||
      comp.type === 'powerVCC' || comp.type === 'power5V' || comp.type === 'power3V3' ||
      comp.type === 'power1V8' || comp.type === 'power2V5' ||
      comp.type === 'power12V' || comp.type === 'powerMinus12V' ||
      comp.type === 'powerMinus5V' || comp.type === 'powerAVDD' ||
      comp.type === 'powerVBAT' || comp.type === 'powerFlag' ||
      comp.type === 'netLabel' || comp.type === 'busLabel' ||
      comp.type === 'busVectorLabel' || comp.type === 'hierLabel';
    if (!isPowerSymbol) continue;
    const netName = (comp.parameters.net as string) || '';
    if (!netName) continue;
    if (netName === 'GND' || netName === 'gnd' || netName === '0') {
      for (const t of plugin.terminals) terminalNode.set(termKey(comp.id, t.id), 0);
      continue;
    }
    // Bus vector expansion: a label with text "D[0..7]" creates 8 implicit
    // nodes D0, D1, ..., D7. Each terminal of the busVectorLabel plugin gets
    // unified to its corresponding bit's shared node.
    const expandedBits = expandBusVector(netName);
    if (expandedBits.length > 1) {
      // Multi-bit bus vector — assign each terminal a separate bit's node
      for (let i = 0; i < plugin.terminals.length && i < expandedBits.length; i++) {
        const bitName = expandedBits[i];
        let bitNode = netToNode.get(bitName);
        if (bitNode === undefined) { bitNode = newNode(); netToNode.set(bitName, bitNode); }
        terminalNode.set(termKey(comp.id, plugin.terminals[i].id), bitNode);
      }
      continue;
    }
    let sharedNode = netToNode.get(netName);
    if (sharedNode === undefined) { sharedNode = newNode(); netToNode.set(netName, sharedNode); }
    for (const t of plugin.terminals) terminalNode.set(termKey(comp.id, t.id), sharedNode);
  }

  // Process wires - union terminals
  for (const wire of wires) {
    const aKey = termKey(wire.from.componentId, wire.from.terminalId);
    const bKey = termKey(wire.to.componentId, wire.to.terminalId);
    const a = nodeFor(wire.from.componentId, wire.from.terminalId);
    const b = nodeFor(wire.to.componentId, wire.to.terminalId);
    // if either is already ground (0), union handles it
    union(a, b);
    const root = find(a);
    terminalNode.set(aKey, root);
    terminalNode.set(bKey, root);
  }

  // Finalize: compress all paths and remap to 0..N contiguous
  // Collect all distinct roots
  const rootSet = new Set<number>();
  rootSet.add(0);
  for (const n of terminalNode.values()) {
    rootSet.add(find(n));
  }
  // assign contiguous ids, ground stays 0
  const rootToId = new Map<number, number>();
  rootToId.set(0, 0);
  let nextId = 1;
  for (const r of rootSet) {
    if (r === 0) continue;
    rootToId.set(r, nextId++);
  }
  for (const [k, n] of terminalNode) {
    terminalNode.set(k, rootToId.get(find(n))!);
  }

  return { terminalNode, numNodes: nextId };
}

export function getTerminalsForComponent(
  comp: CircuitComponent,
  plugin: ComponentPlugin,
  nodeMap: NodeMap,
): { terminalId: string; nodeId: number }[] {
  return plugin.terminals.map((t) => ({
    terminalId: t.id,
    nodeId: nodeMap.terminalNode.get(`${comp.id}:${t.id}`) ?? 0,
  }));
}

/**
 * Compute the current flowing through each wire, in amperes.
 * Returns a map of wireId -> current (positive = from `from` terminal to `to` terminal).
 *
 * This follows the **conventional current** convention (positive charge flow from + to -),
 * which is what Falstad and most simulators use for the animated dots.
 *
 * Method:
 * - For each wire, we look at the component at the `from` end and compute the current
 *   flowing INTO that terminal from the wire's perspective.
 * - For passive components (R, C, L, diode, LED): current = (V(a)-V(b))/R flows from a to b
 *   THROUGH the component. If the wire is attached to terminal 'a', then current leaving
 *   the wire INTO 'a' = +I (the wire delivers current to 'a'). If attached to 'b',
 *   current leaving the wire INTO 'b' = -I.
 *   But we want current flowing FROM wire.to TO wire.from... actually simpler:
 *   The current through the wire = the current through the component, signed so that
 *   positive = conventional current flowing from wire.from to wire.to.
 *
 * - For voltage sources: current flows OUT of the + terminal (conventional current).
 *   We compute this from the actual MNA branch current if available, or approximate
 *   from the load.
 *
 * The sign convention: positive current = dots animate from `from` to `to`.
 * In the renderer, positive = amber dots, negative = cyan dots (reverse).
 */
export function computeWireCurrents(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  sim: SimContext,
): Map<string, number> {
  // First compute per-component currents
  const compCurrents = computeComponentCurrents(components, wires, plugins, sim);
  const result = new Map<string, number>();
  const nodeMap = buildNodeMap(components, wires, plugins);

  // Build nodeCurrentOut for KCL-based voltage source current
  // This sums up ALL currents leaving each node from ALL component types,
  // so the voltage source current = total current drawn from its + node.
  const nodeCurrentOut = new Map<number, number>();
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const i = compCurrents.get(comp.id) ?? 0;

    if (comp.type === 'resistor' || comp.type === 'capacitor' || comp.type === 'inductor' ||
        comp.type === 'led' || comp.type === 'diode' || comp.type === 'zener' ||
        comp.type === 'switch' || comp.type === 'pushButton') {
      const t1Id = 'a';
      const t2Id = comp.type === 'led' || comp.type === 'diode' || comp.type === 'zener' ? 'k' : 'b';
      const n1 = terms.find((t) => t.terminalId === t1Id)?.nodeId ?? 0;
      const n2 = terms.find((t) => t.terminalId === t2Id)?.nodeId ?? 0;
      nodeCurrentOut.set(n1, (nodeCurrentOut.get(n1) ?? 0) + i);
      nodeCurrentOut.set(n2, (nodeCurrentOut.get(n2) ?? 0) - i);
    } else if (comp.type === 'currentSource') {
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      nodeCurrentOut.set(p, (nodeCurrentOut.get(p) ?? 0) + i);
      nodeCurrentOut.set(n, (nodeCurrentOut.get(n) ?? 0) - i);
    } else if (comp.type === 'speaker' || comp.type === 'lamp' || comp.type === 'dcMotor') {
      // Load components: current flows a→b
      const n1 = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const n2 = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      nodeCurrentOut.set(n1, (nodeCurrentOut.get(n1) ?? 0) + i);
      nodeCurrentOut.set(n2, (nodeCurrentOut.get(n2) ?? 0) - i);
    } else if (comp.type === 'timer555') {
      // 555: current exits OUT pin, enters VCC pin
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      const vccNode = terms.find((t) => t.terminalId === 'vcc')?.nodeId ?? 0;
      nodeCurrentOut.set(outNode, (nodeCurrentOut.get(outNode) ?? 0) + i);
      nodeCurrentOut.set(vccNode, (nodeCurrentOut.get(vccNode) ?? 0) - i);
    } else if (comp.type === 'opamp') {
      // Op-amp: current exits OUT pin
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      nodeCurrentOut.set(outNode, (nodeCurrentOut.get(outNode) ?? 0) + i);
    } else if (comp.type === 'npn' || comp.type === 'nmos') {
      // Transistor: current flows C→E or D→S
      const cOrD = comp.type === 'npn' ? 'c' : 'd';
      const eOrS = comp.type === 'npn' ? 'e' : 's';
      const cNode = terms.find((t) => t.terminalId === cOrD)?.nodeId ?? 0;
      const eNode = terms.find((t) => t.terminalId === eOrS)?.nodeId ?? 0;
      nodeCurrentOut.set(cNode, (nodeCurrentOut.get(cNode) ?? 0) + i);
      nodeCurrentOut.set(eNode, (nodeCurrentOut.get(eNode) ?? 0) - i);
    } else if (comp.type === 'pnp' || comp.type === 'pmos') {
      // PNP/PMOS: current flows E→C or S→D (reversed)
      const eOrS = comp.type === 'pnp' ? 'e' : 's';
      const cOrD = comp.type === 'pnp' ? 'c' : 'd';
      const eNode = terms.find((t) => t.terminalId === eOrS)?.nodeId ?? 0;
      const cNode = terms.find((t) => t.terminalId === cOrD)?.nodeId ?? 0;
      nodeCurrentOut.set(eNode, (nodeCurrentOut.get(eNode) ?? 0) + i);
      nodeCurrentOut.set(cNode, (nodeCurrentOut.get(cNode) ?? 0) - i);
    } else if (comp.type === 'voltmeter' || comp.type === 'ammeter' || comp.type === 'oscilloscope') {
      // Meters: negligible current (10MΩ input)
      const pNode = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const nNode = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      nodeCurrentOut.set(pNode, (nodeCurrentOut.get(pNode) ?? 0) + i);
      nodeCurrentOut.set(nNode, (nodeCurrentOut.get(nNode) ?? 0) - i);
    } else if (comp.type === 'sevenSegment') {
      // 7-segment: each segment is a conductance to com (no Vf).
      // Use the same hysteresis model as the stamp.
      const com = terms.find((t) => t.terminalId === 'com')?.nodeId ?? 0;
      const threshold = (comp.parameters.threshold as number) ?? 2.0;
      const rSeg = 220;
      const st = sim.state.__global ?? {};
      const stateKey7 = stateKey('7seg', comp, ...terms.map(t => t.nodeId));
      const segStates = (st[stateKey7] ?? {}) as Record<string, boolean>;
      for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const segNode = terms.find((t) => t.terminalId === seg)?.nodeId ?? 0;
        const v = sim.nodeVoltage[segNode] - sim.nodeVoltage[com];
        const prevOn = segStates[seg] ?? false;
        const on = prevOn ? v > threshold * 0.5 : v > threshold;
        if (on) {
          const iSeg = v / rSeg;
          nodeCurrentOut.set(segNode, (nodeCurrentOut.get(segNode) ?? 0) + iSeg);
          nodeCurrentOut.set(com, (nodeCurrentOut.get(com) ?? 0) - iSeg);
        }
      }
    } else if (comp.type === 'cd4026') {
      // CD4026: handled in a second pass below (after all 7-segment displays
      // have contributed their segment currents to nodeCurrentOut).
      // We can't compute the CD4026's VCC current here because the 7-seg
      // displays (which determine the segment currents) may not have been
      // processed yet (they appear later in the component list).
    }
    // Voltage sources, ground, junction, power symbols: skip (they define the current, not draw it)
  }

  // Second pass: add CD4026 VCC current (sum of all ON segment currents).
  // This must run AFTER all 7-segment displays have contributed to nodeCurrentOut.
  for (const comp of components) {
    if (comp.type !== 'cd4026') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const vccNode = terms.find((t) => t.terminalId === 'vcc')?.nodeId ?? 0;
    let totalSegI = 0;
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const segNode = terms.find((t) => t.terminalId === seg)?.nodeId ?? 0;
      totalSegI += Math.abs(nodeCurrentOut.get(segNode) ?? 0);
    }
    if (vccNode > 0) {
      nodeCurrentOut.set(vccNode, (nodeCurrentOut.get(vccNode) ?? 0) + totalSegI);
    }
  }

  // Second pass (computeWireCurrents): VCO — sources current from VCC.
  for (const comp of components) {
    if (comp.type !== 'vco') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const vccNode = terms.find((t) => t.terminalId === 'vcc')?.nodeId ?? 0;
    const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
    const outI = Math.abs(nodeCurrentOut.get(outNode) ?? 0);
    if (vccNode > 0) {
      nodeCurrentOut.set(vccNode, (nodeCurrentOut.get(vccNode) ?? 0) + outI);
    }
  }

  for (const wire of wires) {
    const fromComp = components.find((c) => c.id === wire.from.componentId);
    const toComp = components.find((c) => c.id === wire.to.componentId);
    if (!fromComp || !toComp) continue;
    const fromPlugin = plugins.get(fromComp.type);
    const toPlugin = plugins.get(toComp.type);
    if (!fromPlugin || !toPlugin) continue;

    // Special case: if either end is an OPEN switch/pushButton, current = 0.
    if (toComp.type === 'switch' && !toComp.parameters.closed) {
      result.set(wire.id, 0);
      continue;
    }
    if (toComp.type === 'pushButton' && !toComp.parameters.pressed) {
      result.set(wire.id, 0);
      continue;
    }
    if (fromComp.type === 'switch' && !fromComp.parameters.closed) {
      result.set(wire.id, 0);
      continue;
    }
    if (fromComp.type === 'pushButton' && !fromComp.parameters.pressed) {
      result.set(wire.id, 0);
      continue;
    }

    const fromCurrent = computeTerminalCurrent(fromComp, fromPlugin, wire.from.terminalId, nodeMap, sim, compCurrents, nodeCurrentOut);
    const toCurrent = computeTerminalCurrent(toComp, toPlugin, wire.to.terminalId, nodeMap, sim, compCurrents, nodeCurrentOut);

    const fromMag = Math.abs(fromCurrent);
    const toMag = Math.abs(toCurrent);
    let current: number;
    if (toMag > 1e-12 && (fromMag < 1e-12 || toMag < fromMag)) {
      current = -toCurrent;
    } else if (fromMag > 1e-12) {
      current = fromCurrent;
    } else {
      current = 0;
    }

    result.set(wire.id, current);
  }

  return result;
}

/**
 * Compute the current leaving a specific terminal of a component, in amperes.
 * Positive = current flowing OUT of the terminal (into the wire).
 */
function computeTerminalCurrent(
  comp: CircuitComponent,
  plugin: ComponentPlugin,
  terminalId: string,
  nodeMap: any,
  sim: SimContext,
  compCurrents: Map<string, number>,
  nodeCurrentOut: Map<number, number>,
): number {
  const terms = getTerminalsForComponent(comp, plugin, nodeMap);
  const compCurrent = compCurrents.get(comp.id) ?? 0;

  if (comp.type === 'resistor' || comp.type === 'capacitor' || comp.type === 'inductor') {
    // compCurrent > 0 = current flows a→b through component.
    // At 'a': current ENTERS component FROM wire → "leaving terminal toward wire" = -I
    // At 'b': current EXITS component TO wire → "leaving terminal toward wire" = +I
    // This means: if wire.from is at 'b', fromCurrent = +I → dots flow from→to (correct).
    //             if wire.from is at 'a', fromCurrent = -I → dots flow to→from (correct, since
    //             current actually flows from the source toward 'a').
    const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
    const termNode = terms.find((t) => t.terminalId === terminalId)?.nodeId ?? 0;
    return (termNode === a) ? -compCurrent : compCurrent;
  } else if (comp.type === 'led' || comp.type === 'diode' || comp.type === 'zener') {
    // Same as resistor: compCurrent > 0 = current flows a→k (forward).
    // At 'a': -I (enters component). At 'k': +I (exits component).
    const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
    const termNode = terms.find((t) => t.terminalId === terminalId)?.nodeId ?? 0;
    return (termNode === a) ? -compCurrent : compCurrent;
  } else if (comp.type === 'dcVoltage' || comp.type === 'acVoltage' || comp.type === 'pulseSource') {
    // Voltage source: compCurrent > 0 = current flows p→n externally (out of +, into -).
    // At 'p': current EXITS source TO wire → "leaving terminal" = +I
    // At 'n': current ENTERS source FROM wire → "leaving terminal" = -I
    const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
    const termNode = terms.find((t) => t.terminalId === terminalId)?.nodeId ?? 0;
    return (termNode === p) ? compCurrent : -compCurrent;
  } else if (comp.type === 'currentSource') {
    // Current source: same as voltage source — current flows p→n externally.
    const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
    const termNode = terms.find((t) => t.terminalId === terminalId)?.nodeId ?? 0;
    return (termNode === p) ? compCurrent : -compCurrent;
  } else if (comp.type === 'switch' || comp.type === 'pushButton') {
    // Same as resistor: a→b, at 'a' = -I, at 'b' = +I
    const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
    const termNode = terms.find((t) => t.terminalId === terminalId)?.nodeId ?? 0;
    return (termNode === a) ? -compCurrent : compCurrent;
  } else if (comp.type === 'npn' || comp.type === 'pnp' || comp.type === 'nmos' || comp.type === 'pmos') {
    // 3-terminal transistor/MOSFET
    // Physics (NPN/NMOS): current flows C→E (or D→S) THROUGH the device.
    //   At collector/drain: current ENTERS (leaves terminal = negative)
    //   At emitter/source: current EXITS (leaves terminal = positive)
    // Physics (PNP/PMOS): current flows E→C (or S→D) — reversed.
    //   At emitter/source: current ENTERS (leaves terminal = negative)
    //   At collector/drain: current EXITS (leaves terminal = positive)
    const isNpn = comp.type === 'npn' || comp.type === 'nmos';
    const cOrD = isNpn ? (comp.type === 'npn' ? 'c' : 'd') : (comp.type === 'pnp' ? 'c' : 'd');
    const eOrS = isNpn ? (comp.type === 'npn' ? 'e' : 's') : (comp.type === 'pnp' ? 'e' : 's');
    if (terminalId === eOrS) {
      // Emitter/Source: for NPN/NMOS current EXITS here; for PNP/PMOS current ENTERS here
      return isNpn ? compCurrent : -compCurrent;
    } else if (terminalId === cOrD) {
      // Collector/Drain: for NPN/NMOS current ENTERS here; for PNP/PMOS current EXITS here
      return isNpn ? -compCurrent : compCurrent;
    } else {
      // Base/Gate: small current, return 0 for flow visualization
      return 0;
    }
  } else if (comp.type === 'sevenSegment') {
    // 7-segment: current flows from segment terminal → com terminal.
    // compCurrent > 0 = current flows from each segment to com (through the LED).
    // For each segment terminal: current ENTERS the display → "leaving terminal" = -I_per_seg
    // For the com terminal: current EXITS the display → "leaving terminal" = +totalI
    const comTerm = terms.find((t) => t.terminalId === 'com')?.nodeId ?? 0;
    const termNode = terms.find((t) => t.terminalId === terminalId)?.nodeId ?? 0;
    if (terminalId === 'com') {
      // Current exits through com (sum of all segment currents)
      return compCurrent;
    } else {
      // For a segment terminal: compute this segment's current from nodeCurrentOut
      // (current leaving the segment node through the display's LED).
      // nodeCurrentOut at the segment node includes the display's draw.
      // We want -I_seg (current enters the display at this terminal).
      const segI = Math.abs(nodeCurrentOut.get(termNode) ?? 0);
      void comTerm;
      return -segI;
    }
  } else if (comp.type === 'cd4026') {
    // CD4026: segment outputs (a-g) are voltage sources driving 5V (ON) or 0V (OFF).
    // Current flows FROM the CD4026 segment pin INTO the wire → "leaving terminal" = +I_seg.
    // The current is computed from nodeCurrentOut at the segment node (the 7-seg
    // draws current through its internal resistance).
    // For the CLK, RST, VCC, GND, CO pins: return 0 (not visualized).
    const segIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    if (segIds.includes(terminalId)) {
      const termNode = terms.find((t) => t.terminalId === terminalId)?.nodeId ?? 0;
      // nodeCurrentOut at the segment node = current leaving through the 7-seg.
      // This equals the current the CD4026 is sourcing from this pin.
      const segI = Math.abs(nodeCurrentOut.get(termNode) ?? 0);
      return segI;
    }
    // VCC pin: current ENTERS the CD4026 (from the power supply).
    // "leaving terminal" = -totalSegI (negative = current enters component).
    // Compute THIS CD4026's segment currents only (not the shared VCC node total).
    if (terminalId === 'vcc') {
      let totalSegI = 0;
      for (const seg of segIds) {
        const segNode = terms.find((t) => t.terminalId === seg)?.nodeId ?? 0;
        totalSegI += Math.abs(nodeCurrentOut.get(segNode) ?? 0);
      }
      return -totalSegI;
    }
    // CO output: current flows out when HIGH (driving the next CD4026's CLK)
    if (terminalId === 'co') {
      const coNode = terms.find((t) => t.terminalId === 'co')?.nodeId ?? 0;
      return Math.abs(nodeCurrentOut.get(coNode) ?? 0);
    }
    return 0;
  } else if (comp.type === 'vco') {
    // VCO: output pin sources current, VCC pin draws current.
    const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
    if (terminalId === 'out') {
      return Math.abs(nodeCurrentOut.get(outNode) ?? 0);
    }
    if (terminalId === 'vcc') {
      const outI = Math.abs(nodeCurrentOut.get(outNode) ?? 0);
      return -outI; // current enters VCC pin from supply
    }
    return 0;
  }
  return 0;
}

/**
 * Compute the current flowing THROUGH each component (from its first terminal to
 * its second terminal), in amperes. Returns a map of componentId -> current.
 *
 * For 2-terminal components (R, C, L, diode, LED, switch): current = V(a)-V(b) / R etc.
 * For voltage sources: current = current through external circuit (from nodeCurrentOut).
 * For 3-terminal components (BJT, MOSFET): current = collector/drain current.
 *
 * Positive current = conventional current flowing from the first terminal to the
 * second terminal (for 2-terminal) or from collector/drain to emitter/source (for 3-terminal).
 */
export function computeComponentCurrents(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  sim: SimContext,
): Map<string, number> {
  const result = new Map<string, number>();
  const nodeMap = buildNodeMap(components, wires, plugins);

  // ── Compute per-node current leaving through passive components ──────
  // This is used to find the current supplied by voltage sources.
  const nodeCurrentOut = new Map<number, number>();
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);

    if (comp.type === 'resistor') {
      const r = Math.max(1e-9, comp.parameters.resistance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const i = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'capacitor') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      // Use the current computed in step() (stored as '_i' suffix).
      // This is the ACTUAL current that flowed during the step, computed
      // BEFORE vPrev was updated. Computing it here from vPrev would give 0
      // because step() already updated vPrev to the current voltage.
      const i = st[`cap_${comp.id}_i`] ?? 0;
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'inductor') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      // Use the current computed in step() (stored as '_i' suffix).
      const i = st[`ind_${comp.id}_i`] ?? 0;
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'led' || comp.type === 'diode') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      const vf = (comp.parameters.forwardV as number) || 0.7;
      const r = comp.type === 'led'
        ? Math.max(0.01, (comp.parameters.seriesR as number) ?? 220)
        : Math.max(0.001, (comp.parameters.onR as number) ?? 1);
      const st = sim.state.__global ?? {};
      const on = st[stateKey(comp.type, comp, a, k)] ?? false;
      const i = on ? Math.max(0, (v - vf) / r) : 0;
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(k, (nodeCurrentOut.get(k) ?? 0) - i);
    } else if (comp.type === 'zener') {
      // Mirror the zener stamp's piecewise model (semiconductors.ts) so the
      // current readout includes the companion source, not just G*v.
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      const vf = (comp.parameters.forwardV as number) || 0.7;
      const vz = (comp.parameters.zenerV as number) || 3.3;
      const rOn = Math.max(0.001, (comp.parameters.onR as number) ?? 1);
      const rOff = Math.max(1e3, (comp.parameters.offR as number) ?? 1e7);
      const st = sim.state.__global ?? {};
      const mode = st[stateKey('zener', comp, a, k)] ?? 'off';
      let i: number;
      if (mode === 'forward') {
        i = (v - vf) / rOn;
      } else if (mode === 'reverse') {
        // In breakdown the element current (a→k) is (v + vz)/rOn.
        i = (v + vz) / rOn;
      } else {
        i = v / rOff;
      }
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(k, (nodeCurrentOut.get(k) ?? 0) - i);
    } else if (comp.type === 'switch' || comp.type === 'pushButton') {
      const closed = comp.type === 'switch' ? comp.parameters.closed : comp.parameters.pressed;
      if (closed) {
        const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
        const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
        const i = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / 0.01;
        nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
        nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
      }
    } else if (comp.type === 'currentSource') {
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const i = comp.parameters.current as number;
      nodeCurrentOut.set(p, (nodeCurrentOut.get(p) ?? 0) + i);
      nodeCurrentOut.set(n, (nodeCurrentOut.get(n) ?? 0) - i);
    } else if (comp.type === 'speaker' || comp.type === 'lamp' || comp.type === 'dcMotor') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const r = Math.max(0.1, (comp.parameters.impedance as number) ?? (comp.parameters.resistance as number) ?? 8);
      const i = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'photoresistor') {
      const darkR = comp.parameters.darkR as number;
      const lightR = comp.parameters.lightR as number;
      const light = Math.max(0, Math.min(1, comp.parameters.light as number));
      const r = Math.max(1e-6, darkR + (lightR - darkR) * light);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const i = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'voltmeter' || comp.type === 'ammeter' || comp.type === 'oscilloscope') {
      // Meters: very high impedance (10MΩ)
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const i = (sim.nodeVoltage[p] - sim.nodeVoltage[n]) / 1e7;
      nodeCurrentOut.set(p, (nodeCurrentOut.get(p) ?? 0) + i);
      nodeCurrentOut.set(n, (nodeCurrentOut.get(n) ?? 0) - i);
    } else if (comp.type === 'sevenSegment') {
      // 7-segment: each segment draws current from its node to com.
      const com = terms.find((t) => t.terminalId === 'com')?.nodeId ?? 0;
      const threshold = (comp.parameters.threshold as number) ?? 2.0;
      const rSeg = 220;
      const st = sim.state.__global ?? {};
      const stateKey7 = stateKey('7seg', comp, ...terms.map(t => t.nodeId));
      const segStates = (st[stateKey7] ?? {}) as Record<string, boolean>;
      for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const segNode = terms.find((t) => t.terminalId === seg)?.nodeId ?? 0;
        const v = sim.nodeVoltage[segNode] - sim.nodeVoltage[com];
        const prevOn = segStates[seg] ?? false;
        const on = prevOn ? v > threshold * 0.5 : v > threshold;
        if (on) {
          const iSeg = v / rSeg;
          nodeCurrentOut.set(segNode, (nodeCurrentOut.get(segNode) ?? 0) + iSeg);
          nodeCurrentOut.set(com, (nodeCurrentOut.get(com) ?? 0) - iSeg);
        }
      }
    } else if (comp.type === 'potentiometer') {
      const r = Math.max(0.001, comp.parameters.resistance as number);
      const w = Math.max(0, Math.min(1, (comp.parameters.wiper as number) / 100));
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const wp = terms.find((t) => t.terminalId === 'w')?.nodeId ?? 0;
      const rTop = Math.max(1e-9, r * w);
      const rBot = Math.max(1e-9, r * (1 - w));
      const iTOP = (sim.nodeVoltage[a] - sim.nodeVoltage[wp]) / rTop;
      const iBot = (sim.nodeVoltage[wp] - sim.nodeVoltage[b]) / rBot;
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + iTOP);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - iBot);
      nodeCurrentOut.set(wp, (nodeCurrentOut.get(wp) ?? 0) + (-iTOP + iBot));
    } else if (comp.type === 'transformer' || comp.type === 'coupledInductor') {
      // Primary current = magnetizing companion current + the reflected
      // secondary current (−V2/V1 · I2, read from the recorded VCVS branch).
      const p1 = terms.find((t) => t.terminalId === 'p1')?.nodeId ?? 0;
      const p2 = terms.find((t) => t.terminalId === 'p2')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const lm = Math.max(1e-6, (comp.parameters.lm as number) ?? (comp.parameters.L1 as number) ?? 0.01);
      const dt = Math.max(sim.dt, 1e-12);
      const g = dt / lm;
      const v = sim.nodeVoltage[p1] - sim.nodeVoltage[p2];
      let i = v * g;
      // coupled inductor keeps its own companion state (iPrev)
      if (comp.type === 'coupledInductor') {
        const s1n = terms.find((t) => t.terminalId === 's1')?.nodeId ?? 0;
        const s2n = terms.find((t) => t.terminalId === 's2')?.nodeId ?? 0;
        i += (st[stateKey('xfmr', comp, p1, p2, s1n, s2n)] as number) ?? 0;
      }
      // reflected secondary current
      const branchIdx = st[`xfmr_branch_${comp.id}`] as number | undefined;
      if (branchIdx !== undefined && branchIdx >= 0) {
        const numNonGround = sim.nodeVoltage.length - 1;
        const relIdx = branchIdx - numNonGround;
        if (relIdx >= 0 && relIdx < sim.branchCurrent.length) {
          const i2 = sim.branchCurrent[relIdx];
          const v2v1 = comp.type === 'transformer'
            ? (comp.parameters.ratio as number) ?? 1
            : 1 / ((comp.parameters.ratio as number) ?? 1);
          i += -v2v1 * i2;
        }
      }
      nodeCurrentOut.set(p1, (nodeCurrentOut.get(p1) ?? 0) + i);
      nodeCurrentOut.set(p2, (nodeCurrentOut.get(p2) ?? 0) - i);
    } else if (comp.type === 'opamp' || comp.type === 'opampRails' || comp.type === 'opampReal') {
      if (comp.type !== 'opamp') {
        const vp = terms.find((t) => t.terminalId === 'v+')?.nodeId ?? 0;
        const vn = terms.find((t) => t.terminalId === 'v-')?.nodeId ?? 0;
        const iVp = sim.nodeVoltage[vp] * 1e-9;
        const iVn = sim.nodeVoltage[vn] * 1e-9;
        nodeCurrentOut.set(vp, (nodeCurrentOut.get(vp) ?? 0) + iVp);
        nodeCurrentOut.set(vn, (nodeCurrentOut.get(vn) ?? 0) + iVn);
      }
    } else if (comp.type === 'diodeShockley') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const Is = (comp.parameters.Is as number) ?? 1e-14;
      const N = (comp.parameters.N as number) ?? 1.5;
      const Vt = 0.02585;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      const i = Is * (Math.exp(Math.max(-50, Math.min(50, v / (N * Vt)))) - 1);
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(k, (nodeCurrentOut.get(k) ?? 0) - i);
    } else if (comp.type === 'timer555' || comp.type === 'vco' || comp.type === 'crystal' ||
               comp.type === 'and' || comp.type === 'or' || comp.type === 'nand' ||
               comp.type === 'nor' || comp.type === 'xor' || comp.type === 'not' ||
               comp.type === '7400_A' || comp.type === '7400_B' ||
               comp.type === '7400_C' || comp.type === '7400_D' ||
               comp.type === 'arduino' || comp.type === 'arduinoReal' || comp.type === 'raspberryPi') {
      const vccNode = terms.find((t) => t.terminalId === 'vcc')?.nodeId ?? 0;
      if (vccNode > 0) {
        let totalOutI = 0;
        for (const t of terms) {
          if (t.terminalId === 'vcc' || t.terminalId === 'gnd') continue;
          const nodeI = nodeCurrentOut.get(t.nodeId) ?? 0;
          if (nodeI > 0) totalOutI += nodeI;
        }
        nodeCurrentOut.set(vccNode, (nodeCurrentOut.get(vccNode) ?? 0) - totalOutI);
      }
    } else {
      // GENERIC FALLBACK for any unhandled type.
      const rParam = (comp.parameters.resistance as number) ??
                     (comp.parameters.impedance as number) ??
                     (comp.parameters.ron as number) ??
                     (comp.parameters.onR as number);
      if (rParam !== undefined && rParam > 0) {
        const a = terms.find((t) => t.terminalId === 'a' || t.terminalId === 'p')?.nodeId ?? 0;
        const b = terms.find((t) => t.terminalId === 'b' || t.terminalId === 'n')?.nodeId ?? 0;
        if (a > 0 || b > 0) {
          const r = Math.max(1e-9, rParam);
          const i = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
          nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
          nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
        }
      }
    }
    }  // end of for (const comp of components) loop

  // Second pass: add CD4026 VCC current (sum of all ON segment currents).
  // Must run after 7-segment displays have contributed to nodeCurrentOut.
  for (const comp of components) {
    if (comp.type !== 'cd4026') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const vccNode = terms.find((t) => t.terminalId === 'vcc')?.nodeId ?? 0;
    let totalSegI = 0;
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const segNode = terms.find((t) => t.terminalId === seg)?.nodeId ?? 0;
      totalSegI += Math.abs(nodeCurrentOut.get(segNode) ?? 0);
    }
    if (vccNode > 0) {
      nodeCurrentOut.set(vccNode, (nodeCurrentOut.get(vccNode) ?? 0) + totalSegI);
    }
  }

  // Second pass: VCO — sources current from VCC equal to output load current.
  for (const comp of components) {
    if (comp.type !== 'vco') continue;
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    const vccNode = terms.find((t) => t.terminalId === 'vcc')?.nodeId ?? 0;
    const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
    const outI = Math.abs(nodeCurrentOut.get(outNode) ?? 0);
    if (vccNode > 0) {
      nodeCurrentOut.set(vccNode, (nodeCurrentOut.get(vccNode) ?? 0) + outI);
    }
  }

  // Compute per-component current
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    let current = 0;

    if (comp.type === 'resistor') {
      const r = Math.max(1e-9, comp.parameters.resistance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
    } else if (comp.type === 'capacitor') {
      const C = Math.max(1e-15, comp.parameters.capacitance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const vPrev = st[`cap_${comp.id}`] ?? 0;
      current = (C / Math.max(sim.dt, 1e-12)) * ((sim.nodeVoltage[a] - sim.nodeVoltage[b]) - vPrev);
    } else if (comp.type === 'inductor') {
      const L = Math.max(1e-12, comp.parameters.inductance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const iPrev = st[`ind_${comp.id}`] ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
      const dt = Math.max(sim.dt, 1e-12);
      current = iPrev + (v / L) * dt;
    } else if (comp.type === 'led' || comp.type === 'diode') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      const vf = (comp.parameters.forwardV as number) || 0.7;
      const r = comp.type === 'led'
        ? Math.max(0.01, (comp.parameters.seriesR as number) ?? 220)
        : Math.max(0.001, (comp.parameters.onR as number) ?? 1);
      const st = sim.state.__global ?? {};
      const on = st[stateKey(comp.type, comp, a, k)] ?? false;
      current = on ? Math.max(0, (v - vf) / r) : 0;
    } else if (comp.type === 'zener') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      const vf = (comp.parameters.forwardV as number) || 0.7;
      const vz = (comp.parameters.zenerV as number) || 3.3;
      const rOn = Math.max(0.001, (comp.parameters.onR as number) ?? 1);
      const rOff = Math.max(1e3, (comp.parameters.offR as number) ?? 1e7);
      const st = sim.state.__global ?? {};
      const mode = st[stateKey('zener', comp, a, k)] ?? 'off';
      if (mode === 'forward') {
        current = (v - vf) / rOn;
      } else if (mode === 'reverse') {
        current = (v + vz) / rOn;
      } else {
        current = v / rOff;
      }
    } else if (comp.type === 'dcVoltage' || comp.type === 'acVoltage' || comp.type === 'pulseSource') {
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      current = nodeCurrentOut.get(p) ?? 0;
    } else if (comp.type === 'currentSource') {
      current = comp.parameters.current as number;
    } else if (comp.type === 'switch' || comp.type === 'pushButton') {
      const closed = comp.type === 'switch' ? comp.parameters.closed : comp.parameters.pressed;
      if (closed) {
        const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
        const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
        current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / 0.01;
      }
    } else if (comp.type === 'npn' || comp.type === 'pnp') {
      const isNpn = comp.type === 'npn';
      const cNode = terms.find((t) => t.terminalId === 'c')?.nodeId ?? 0;
      const eNode = terms.find((t) => t.terminalId === 'e')?.nodeId ?? 0;
      if (isNpn) {
        // NPN: current flows C→E. Collector is connected through load to VCC.
        current = -(nodeCurrentOut.get(cNode) ?? 0);
      } else {
        // PNP: current flows E→C. Collector is connected through load to GND.
        // Use collector node (connected to load) not emitter (connected to VCC directly).
        current = nodeCurrentOut.get(cNode) ?? 0;
      }
    } else if (comp.type === 'nmos' || comp.type === 'pmos') {
      const isNmos = comp.type === 'nmos';
      const dNode = terms.find((t) => t.terminalId === 'd')?.nodeId ?? 0;
      const sNode = terms.find((t) => t.terminalId === 's')?.nodeId ?? 0;
      if (isNmos) {
        // NMOS: current flows D→S. Current leaving drain node through load = device current.
        current = -(nodeCurrentOut.get(dNode) ?? 0);
      } else {
        // PMOS: current flows S→D. Current leaving drain node through load = device current.
        // Use drain node (connected to load) not source (connected to VCC directly).
        current = nodeCurrentOut.get(dNode) ?? 0;
      }
    } else if (comp.type === 'timer555') {
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      current = nodeCurrentOut.get(outNode) ?? 0;
    } else if (comp.type === 'opamp' || comp.type === 'opampRails') {
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      current = nodeCurrentOut.get(outNode) ?? 0;
    } else if (comp.type === 'arduino' || comp.type === 'arduinoReal' || comp.type === 'raspberryPi') {
      let totalCurrent = 0;
      for (const t of terms) {
        totalCurrent += Math.abs(nodeCurrentOut.get(t.nodeId) ?? 0);
      }
      current = totalCurrent;
    } else if (comp.type === 'voltmeter' || comp.type === 'ammeter' || comp.type === 'oscilloscope') {
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      current = (sim.nodeVoltage[p] - sim.nodeVoltage[n]) / 1e7;
    } else if (comp.type === 'vco' || comp.type === 'crystal') {
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      current = nodeCurrentOut.get(outNode) ?? 0;
    } else if (comp.type === 'speaker' || comp.type === 'lamp' || comp.type === 'dcMotor') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const r = Math.max(0.1, (comp.parameters.impedance as number) ?? (comp.parameters.resistance as number) ?? 8);
      current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
    } else if (comp.type === 'photoresistor') {
      const darkR = comp.parameters.darkR as number;
      const lightR = comp.parameters.lightR as number;
      const light = Math.max(0, Math.min(1, comp.parameters.light as number));
      const r = Math.max(1e-6, darkR + (lightR - darkR) * light);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
    } else if (comp.type === 'sevenSegment') {
      // 7-segment: current = sum of segment currents (each segment ~10mA when on)
      const st = sim.state.__global ?? {};
      let totalI = 0;
      for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const segNode = terms.find((t) => t.terminalId === seg)?.nodeId ?? 0;
        totalI += Math.abs(nodeCurrentOut.get(segNode) ?? 0);
      }
      current = totalI;
    } else if (comp.type === 'cd4026') {
      // CD4026: total current = sum of all segment output currents.
      // Each ON segment sources current into the external 7-seg display.
      let totalI = 0;
      for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const segNode = terms.find((t) => t.terminalId === seg)?.nodeId ?? 0;
        totalI += Math.abs(nodeCurrentOut.get(segNode) ?? 0);
      }
      current = totalI;
    } else if (comp.type === 'transformer') {
      const p1 = terms.find((t) => t.terminalId === 'p1')?.nodeId ?? 0;
      current = nodeCurrentOut.get(p1) ?? 0;
    } else if (comp.type === 'potentiometer') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const r = Math.max(1e-6, comp.parameters.resistance as number);
      current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
    } else if (comp.type === 'fuse') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const r = Math.max(1e-6, comp.parameters.resistance as number);
      current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
    } else if (comp.type === 'opampReal') {
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      current = nodeCurrentOut.get(outNode) ?? 0;
    } else if (comp.type === 'diodeShockley') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const Is = (comp.parameters.Is as number) ?? 1e-14;
      const N = (comp.parameters.N as number) ?? 1.5;
      const Vt = 0.02585;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      current = Is * (Math.exp(Math.max(-50, Math.min(50, v / (N * Vt)))) - 1);
    } else if (comp.type === 'bjtGPNpn' || comp.type === 'bjtGPPnp') {
      const cNode = terms.find((t) => t.terminalId === 'c')?.nodeId ?? 0;
      current = comp.type === 'bjtGPNpn' ? -(nodeCurrentOut.get(cNode) ?? 0) : (nodeCurrentOut.get(cNode) ?? 0);
    } else if (comp.type === 'jfetN' || comp.type === 'mosLevel1N') {
      const dNode = terms.find((t) => t.terminalId === 'd')?.nodeId ?? 0;
      current = -(nodeCurrentOut.get(dNode) ?? 0);
    } else if (comp.type === 'jfetP' || comp.type === 'mosLevel1P') {
      const dNode = terms.find((t) => t.terminalId === 'd')?.nodeId ?? 0;
      current = nodeCurrentOut.get(dNode) ?? 0;
    } else if (comp.type === 'vcSwitch') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const ron = Math.max(1e-6, (comp.parameters.ron as number) ?? 0.01);
      const roff = Math.max(1, (comp.parameters.roff as number) ?? 1e6);
      const vt = (comp.parameters.vt as number) ?? 1.0;
      const vh = (comp.parameters.vh as number) ?? 0.1;
      const ctlNode = terms.find((t) => t.terminalId === 'ctl')?.nodeId;
      const ctlV = ctlNode !== undefined ? sim.nodeVoltage[ctlNode] : 0;
      const st = sim.state.__global ?? {};
      const key = `vcsw_${comp.id}`;
      const prevOn = st[key] ?? false;
      const on = prevOn ? ctlV > vt - vh : ctlV > vt + vh;
      st[key] = on;
      const r = on ? ron : roff;
      current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
    } else if (comp.type === 'bvSource' || comp.type === 'customPower') {
      const pNode = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      current = nodeCurrentOut.get(pNode) ?? 0;
    } else if (comp.type === 'biSource') {
      const pNode = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      current = nodeCurrentOut.get(pNode) ?? 0;
    } else if (comp.type === 'coupledInductor') {
      const p1 = terms.find((t) => t.terminalId === 'p1')?.nodeId ?? 0;
      current = nodeCurrentOut.get(p1) ?? 0;
    } else {
      // GENERIC FALLBACK for any unhandled type.
      const vccNode = terms.find((t) => t.terminalId === 'vcc')?.nodeId;
      if (vccNode !== undefined && vccNode > 0) {
        let totalI = 0;
        for (const t of terms) {
          if (t.terminalId === 'vcc' || t.terminalId === 'gnd') continue;
          totalI += Math.abs(nodeCurrentOut.get(t.nodeId) ?? 0);
        }
        current = totalI;
      } else {
        const outTerm = terms.find((t) => t.terminalId === 'out' || t.terminalId === 'y');
        if (outTerm) {
          current = nodeCurrentOut.get(outTerm.nodeId) ?? 0;
        } else {
          const rParam = (comp.parameters.resistance as number) ??
                         (comp.parameters.impedance as number) ??
                         (comp.parameters.ron as number) ??
                         (comp.parameters.onR as number);
          if (rParam !== undefined && rParam > 0) {
            const a = terms.find((t) => t.terminalId === 'a' || t.terminalId === 'p')?.nodeId ?? 0;
            const b = terms.find((t) => t.terminalId === 'b' || t.terminalId === 'n')?.nodeId ?? 0;
            const r = Math.max(1e-9, rParam);
            current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
          }
        }
      }
    }

    result.set(comp.id, current);
  }

  return result;
}

/**
 * Run one simulation step.
 * - Stamps all components (with Newton iteration for non-linear ones; for simplicity we do fixed iterations).
 * - Solves the linear system.
 * - Calls `step` on each plugin for stateful logic (555, MCU, etc.).
 */
export interface StepResult {
  sim: SimContext;
  branchCurrentSize: number;
  nodeMap: NodeMap;
}

export interface PrevState {
  nodeVoltage: Float64Array;
  branchCurrent: Float64Array;
  time: number;
  /** persistent state map, survives across steps. Plugins store their internal state here. */
  state: Record<string, any>;
}

export function simulateStep(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  prev?: PrevState,
  dt: number = 1e-4,
  simOptions?: { initialConditions?: Record<string, number>; nodeSets?: Record<string, number> },
): StepResult | null {
  const nodeMap = buildNodeMap(components, wires, plugins);
  const numNodes = nodeMap.numNodes; // includes ground (0)
  // Per-component extra-variable demand (e.g. a discretized transmission
  // line with N internal junction nodes) — plugins declare it via extraVars().
  let declaredExtras = 0;
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (plugin?.extraVars) declaredExtras += plugin.extraVars(comp.parameters);
  }
  const maxExtras = components.length * 4 + 8 + declaredExtras;

  // Use the sparse (triplet + Markowitz LU) solver for circuits > 80 unknowns —
  // O(nnz) memory and O(flops) factorization keep large designs fast.
  // Below that threshold, the dense solver wins (less overhead per stamp).
  const useSparse = shouldUseSparseSolver(numNodes - 1, maxExtras);
  const sparseSys = useSparse ? createSparseMnaSystem(numNodes - 1, maxExtras) : null;
  const sys = useSparse ? asMnaSystem(sparseSys!) : createMnaSystem(numNodes - 1, maxExtras);

  const time = prev && prev.nodeVoltage.length > 0 ? prev.time + dt : 0;

  // initialize SimContext with previous voltages (for companion models).
  // If prev has no data yet (first step), allocate fresh arrays sized to numNodes.
  const hasPrev = prev && prev.nodeVoltage.length > 0;
  const nodeVoltage = hasPrev ? Float64Array.from(prev.nodeVoltage) : new Float64Array(numNodes);

  // Apply .IC (initial conditions) on the very first step (no prev) — these override
  // the default 0V initialization and are used when `uic` is true.
  // Apply .NODESET as a hint for the DC solver (initial guess).
  if (!hasPrev && simOptions) {
    // .IC — overrides node voltages at t=0.
    // NOTE: nodeVoltage is indexed by node id (index 0 = ground), so the
    // write slot for nodeId is `nodeId` itself — NOT `nodeId - 1`.
    if (simOptions.initialConditions) {
      for (const [termKey, voltage] of Object.entries(simOptions.initialConditions)) {
        const nodeId = nodeMap.terminalNode.get(termKey);
        if (nodeId != null && nodeId > 0 && nodeId < nodeVoltage.length) {
          nodeVoltage[nodeId] = voltage;
        }
      }
    }
    // .NODESET — same as .IC but only used as an initial guess for the DC solver
    // (it gets overwritten by the solve, but helps convergence).
    // For the transient engine, .NODESET and .IC behave the same way at t=0.
    if (simOptions.nodeSets) {
      for (const [termKey, voltage] of Object.entries(simOptions.nodeSets)) {
        const nodeId = nodeMap.terminalNode.get(termKey);
        if (nodeId != null && nodeId > 0 && nodeId < nodeVoltage.length) {
          // Only apply if not already set by .IC
          if (simOptions.initialConditions?.[termKey] === undefined) {
            nodeVoltage[nodeId] = voltage;
          }
        }
      }
    }
  }

  const branchCurrent = hasPrev ? Float64Array.from(prev.branchCurrent) : new Float64Array(maxExtras);
  // PERSISTENT state: reuse the same state object across steps so plugins (capacitors,
  // inductors, 555, MCU) keep their memory. Created once per session.
  const stateMap: Record<string, any> = prev ? prev.state : {};
  // expose per-component state objects (also persistent via comp.simState).
  // When components arrive as structured clones (e.g. worker messages), their
  // simState copies are detached from the persistent state map — always
  // (re)link comp.simState to the authoritative persistent object.
  for (const comp of components) {
    if (!comp.simState) comp.simState = {};
    const persistent = stateMap[comp.id];
    if (persistent && typeof persistent === 'object' && persistent !== comp.simState) {
      comp.simState = persistent;
    } else if (!persistent) {
      stateMap[comp.id] = comp.simState;
    }
  }

  const sim: SimContext = {
    nodeVoltage,
    branchCurrent,
    state: stateMap,
    time,
    dt,
  };

  // First pass: let plugins initialize their simState (e.g., capacitor voltage)
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    if (!comp.simState) comp.simState = {};
    if (plugin.step && !comp.simState.__inited) {
      comp.simState.__inited = true;
    }
  }

  // Stamp all components
  sys.nextExtra = numNodes - 1; // reset extra counter; extra vars start at index (numNodes-1)
  if (sparseSys) sparseSys.clearStamps(); // reset triplet buffer + RHS for fresh stamping
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin || !plugin.stamp) continue;
    const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
    try {
      (plugin.stamp as any)(comp.parameters, terminals, sys, sim, comp);
    } catch (e) {
      console.error(`stamp error in ${comp.type} (${comp.id}):`, e);
    }
  }

  // resize system: we may have allocated more extra vars than used.
  // build a smaller system to avoid singular cols
  const actualSize = sys.nextExtra;
  if (actualSize < sys.size) {
    if (sparseSys) {
      // Sparse path: drop anything outside the used block (O(nnz)) — no dense
      // copy is involved. Stamps never touch unused extras, so this is a pure
      // truncation of triplets + RHS.
      sparseSys.truncate(actualSize);
      sys.numExtra = actualSize - (numNodes - 1);
    } else {
      // shrink
      const newA = new Float64Array(actualSize * actualSize);
      const newZ = new Float64Array(actualSize);
      for (let r = 0; r < actualSize; r++) {
        for (let c = 0; c < actualSize; c++) {
          newA[r * actualSize + c] = sys.A[r * sys.size + c];
        }
        newZ[r] = sys.z[r];
      }
      sys.A = newA;
      sys.z = newZ;
      sys.size = actualSize;
      sys.numExtra = actualSize - (numNodes - 1);
    }
  }

  const x = useSparse && sparseSys ? solveSparse(sparseSys) : solveMna(sys);
  if (!x) {
    return null;
  }

  // copy results back into sim.nodeVoltage / branchCurrent
  for (let i = 0; i < numNodes; i++) {
    sim.nodeVoltage[i] = i === 0 ? 0 : x[i - 1];
  }
  for (let i = 0; i < sys.numExtra; i++) {
    sim.branchCurrent[i] = x[numNodes - 1 + i];
  }

  // call step() for stateful components
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin || !plugin.step) continue;
    const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
    try {
      plugin.step(comp.parameters, terminals, sim, comp);
    } catch (e) {
      console.error(`step error in ${comp.type} (${comp.id}):`, e);
    }
  }

  return { sim, branchCurrentSize: sys.numExtra, nodeMap };
}

/**
 * Solve a pure DC operating point (no time stepping).
 * Iterates a few times to handle non-linear components (diodes, transistors).
 */
export function solveDC(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  maxIter: number = 50,
): SimContext | null {
  // initialize simState
  for (const comp of components) {
    if (!comp.simState) comp.simState = {};
  }

  // For DC operating point: capacitors should be OPEN and inductors SHORT.
  // The companion models stamp:
  //   Capacitor: G = C/dt  (large dt → small G → open circuit)
  //   Inductor:   G = dt/L  (large dt → large G → short circuit)
  // Using dt = 1e6 seconds makes both companion models converge to their
  // DC steady-state behavior. This is the standard SPICE approach (.OP).
  const DC_DT = 1e6;

  let prev: PrevState | undefined;
  let result: SimContext | null = null;
  for (let iter = 0; iter < maxIter; iter++) {
    const r = simulateStep(components, wires, plugins, prev, DC_DT);
    if (!r) return null;
    result = r.sim;
    // check convergence
    if (prev) {
      let maxDelta = 0;
      for (let i = 0; i < r.sim.nodeVoltage.length; i++) {
        const d = Math.abs(r.sim.nodeVoltage[i] - prev.nodeVoltage[i]);
        if (d > maxDelta) maxDelta = d;
      }
      prev = {
        nodeVoltage: r.sim.nodeVoltage,
        branchCurrent: r.sim.branchCurrent,
        time: r.sim.time,
        state: r.sim.state,
      };
      if (maxDelta < 1e-6 && iter > 0) break;
    } else {
      prev = {
        nodeVoltage: r.sim.nodeVoltage,
        branchCurrent: r.sim.branchCurrent,
        time: r.sim.time,
        state: r.sim.state,
      };
    }
  }
  return result;
}
