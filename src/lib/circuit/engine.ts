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
export function buildNodeMap(components: CircuitComponent[], wires: Wire[], plugins: Map<string, ComponentPlugin>): NodeMap {
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
        comp.type === 'led' || comp.type === 'diode' || comp.type === 'switch' || comp.type === 'pushButton') {
      const t1Id = 'a';
      const t2Id = comp.type === 'led' || comp.type === 'diode' ? 'k' : 'b';
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
    }
    // Voltage sources, ground, junction, power symbols: skip (they define the current, not draw it)
  }

  for (const wire of wires) {
    // For each wire, compute current from BOTH the from and to components.
    //
    // Sign convention:
    //   computeTerminalCurrent returns "current leaving the component terminal toward the wire"
    //   Positive = current flowing OUT of the terminal INTO the wire.
    //
    // For a wire from→to:
    //   fromCurrent > 0 means current flows FROM the from-component INTO the wire → flows from→to ✓
    //   toCurrent > 0 means current flows FROM the to-component INTO the wire → flows to→from
    //   So wire current (from→to positive) = fromCurrent = -toCurrent
    //
    // In a series circuit: fromCurrent = -toCurrent (KCL).
    // Take the one with larger magnitude for reliability.
    const fromComp = components.find((c) => c.id === wire.from.componentId);
    const toComp = components.find((c) => c.id === wire.to.componentId);
    if (!fromComp || !toComp) continue;
    const fromPlugin = plugins.get(fromComp.type);
    const toPlugin = plugins.get(toComp.type);
    if (!fromPlugin || !toPlugin) continue;

    const fromCurrent = computeTerminalCurrent(fromComp, fromPlugin, wire.from.terminalId, nodeMap, sim, compCurrents, nodeCurrentOut);
    const toCurrent = computeTerminalCurrent(toComp, toPlugin, wire.to.terminalId, nodeMap, sim, compCurrents, nodeCurrentOut);

    // fromCurrent = current leaving from-component → entering wire at from end → flows from→to
    // toCurrent = current leaving to-component → entering wire at to end → flows to→from
    // Wire current (from→to positive) = fromCurrent = -toCurrent
    const fromMag = Math.abs(fromCurrent);
    const toMag = Math.abs(toCurrent);
    let current: number;
    if (fromMag > toMag && fromMag > 1e-12) {
      current = fromCurrent;
    } else if (toMag > 1e-12) {
      current = -toCurrent;
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
  } else if (comp.type === 'led' || comp.type === 'diode') {
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

  // Build nodeCurrentOut (same as in computeWireCurrents)
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
      const C = Math.max(1e-15, comp.parameters.capacitance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const vPrev = st[`cap_${a}_${b}`] ?? 0;
      const i = (C / Math.max(sim.dt, 1e-12)) * ((sim.nodeVoltage[a] - sim.nodeVoltage[b]) - vPrev);
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'inductor') {
      // Compute fresh inductor current (no one-step lag)
      const L = Math.max(1e-12, comp.parameters.inductance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const iPrev = st[`ind_${a}_${b}`] ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
      const dt = Math.max(sim.dt, 1e-12);
      const i = iPrev + (v / L) * dt;
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'led' || comp.type === 'diode') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      const vf = (comp.parameters.forwardV as number) || 0.7;
      const r = comp.type === 'led'
        ? Math.max(0.01, comp.parameters.seriesR as number)
        : Math.max(0.001, comp.parameters.onR as number);
      const st = sim.state.__global ?? {};
      // The stamp function stores state as `led_${a}_${k}` or `diode_${a}_${k}`.
      // The state key in the stamp is: `led_${a}_${k}` for LED, `diode_${a}_${k}` for diode.
      // The state key here uses `${comp.type}_${a}_${k}` which is the same. ✓
      const on = st[`${comp.type}_${a}_${k}`] ?? false;
      // Current flows a→k when on: I = (V_a - V_k - Vf) / R
      // Positive I = current leaves node 'a' (goes into component), enters node 'k'.
      const i = on ? Math.max(0, (v - vf) / r) : 0;
      // KCL: current leaving node 'a' = +i (flows into component at 'a')
      //       current leaving node 'k' = -i (flows out of component at 'k')
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
      current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r; // a→b
    } else if (comp.type === 'capacitor') {
      const C = Math.max(1e-15, comp.parameters.capacitance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const vPrev = st[`cap_${a}_${b}`] ?? 0;
      current = (C / Math.max(sim.dt, 1e-12)) * ((sim.nodeVoltage[a] - sim.nodeVoltage[b]) - vPrev);
    } else if (comp.type === 'inductor') {
      // Compute fresh inductor current from V = L·dI/dt using current voltage
      // This avoids the one-step-behind bug from reading stored state
      const L = Math.max(1e-12, comp.parameters.inductance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const iPrev = st[`ind_${a}_${b}`] ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
      const dt = Math.max(sim.dt, 1e-12);
      // I_now = I_prev + (V/L)*dt — uses current voltage (no lag)
      current = iPrev + (v / L) * dt;
    } else if (comp.type === 'led' || comp.type === 'diode') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      const vf = (comp.parameters.forwardV as number) || 0.7;
      const r = comp.type === 'led'
        ? Math.max(0.01, comp.parameters.seriesR as number)
        : Math.max(0.001, comp.parameters.onR as number);
      const st = sim.state.__global ?? {};
      const on = st[`${comp.type}_${a}_${k}`] ?? false;
      current = on ? Math.max(0, (v - vf) / r) : 0; // a→k
    } else if (comp.type === 'dcVoltage' || comp.type === 'acVoltage' || comp.type === 'pulseSource') {
      // Voltage source: current = total current drawn by passive components at + node.
      // nodeCurrentOut was built from passive components only (resistors, LEDs, etc.)
      // so it represents the current LEAVING the + node through the external circuit.
      // Positive = current flowing out of + through external circuit = current the source supplies.
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
      // BJT: collector→emitter current (NPN) or emitter→collector (PNP)
      // nodeCurrentOut at collector = current LEAVING collector node
      // For NPN: current ENTERS collector (leaves node = negative), so negate
      // For PNP: current ENTERS emitter, EXITS collector
      const isNpn = comp.type === 'npn';
      const cNode = terms.find((t) => t.terminalId === 'c')?.nodeId ?? 0;
      const eNode = terms.find((t) => t.terminalId === 'e')?.nodeId ?? 0;
      if (isNpn) {
        // NPN: current flows C→E. At collector node, current leaves toward transistor (negative out).
        // So component current = -nodeCurrentOut(cNode) = current entering collector
        current = -(nodeCurrentOut.get(cNode) ?? 0);
      } else {
        // PNP: current flows E→C. At emitter node, current leaves toward transistor (negative out).
        current = -(nodeCurrentOut.get(eNode) ?? 0);
      }
    } else if (comp.type === 'nmos' || comp.type === 'pmos') {
      // MOSFET: drain→source (NMOS) or source→drain (PMOS)
      const isNmos = comp.type === 'nmos';
      const dNode = terms.find((t) => t.terminalId === 'd')?.nodeId ?? 0;
      const sNode = terms.find((t) => t.terminalId === 's')?.nodeId ?? 0;
      if (isNmos) {
        // NMOS: current flows D→S. At drain, current enters (leaves node = negative).
        current = -(nodeCurrentOut.get(dNode) ?? 0);
      } else {
        // PMOS: current flows S→D. At source, current enters (leaves node = negative).
        current = -(nodeCurrentOut.get(sNode) ?? 0);
      }
    } else if (comp.type === 'timer555') {
      // 555: current flows from VCC through OUT pin
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      current = nodeCurrentOut.get(outNode) ?? 0;
    } else if (comp.type === 'opamp') {
      // Op-amp: output current
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      current = nodeCurrentOut.get(outNode) ?? 0;
    } else if (comp.type === 'arduino' || comp.type === 'arduinoReal' || comp.type === 'raspberryPi') {
      // MCU: sum of currents on all digital pins
      let totalCurrent = 0;
      for (const t of terms) {
        totalCurrent += Math.abs(nodeCurrentOut.get(t.nodeId) ?? 0);
      }
      current = totalCurrent;
    } else if (comp.type === 'voltmeter' || comp.type === 'ammeter' || comp.type === 'oscilloscope') {
      // Meters: very high impedance, negligible current
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      current = (sim.nodeVoltage[p] - sim.nodeVoltage[n]) / 1e7; // 10MΩ input impedance
    } else if (comp.type === 'vco' || comp.type === 'crystal') {
      // Oscillators: output current
      const outNode = terms.find((t) => t.terminalId === 'out')?.nodeId ?? 0;
      current = nodeCurrentOut.get(outNode) ?? 0;
    } else if (comp.type === 'speaker' || comp.type === 'lamp' || comp.type === 'dcMotor') {
      // Load components: same as resistor
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const r = (comp.type === 'speaker') ? Math.max(1, comp.parameters.resistance as number) :
                (comp.type === 'lamp') ? Math.max(1, comp.parameters.resistance as number) :
                Math.max(1, comp.parameters.resistance as number);
      current = (sim.nodeVoltage[a] - sim.nodeVoltage[b]) / r;
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
  const maxExtras = components.length * 4 + 8;

  // Use the sparse solver for circuits > 80 nodes — much faster for big designs.
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
    // .IC — overrides node voltages at t=0
    if (simOptions.initialConditions) {
      for (const [termKey, voltage] of Object.entries(simOptions.initialConditions)) {
        const nodeId = nodeMap.terminalNode.get(termKey);
        if (nodeId != null && nodeId > 0 && nodeId - 1 < nodeVoltage.length) {
          nodeVoltage[nodeId - 1] = voltage;
        }
      }
    }
    // .NODESET — same as .IC but only used as an initial guess for the DC solver
    // (it gets overwritten by the solve, but helps convergence).
    // For the transient engine, .NODESET and .IC behave the same way at t=0.
    if (simOptions.nodeSets) {
      for (const [termKey, voltage] of Object.entries(simOptions.nodeSets)) {
        const nodeId = nodeMap.terminalNode.get(termKey);
        if (nodeId != null && nodeId > 0 && nodeId - 1 < nodeVoltage.length) {
          // Only apply if not already set by .IC
          if (simOptions.initialConditions?.[termKey] === undefined) {
            nodeVoltage[nodeId - 1] = voltage;
          }
        }
      }
    }
  }

  const branchCurrent = hasPrev ? Float64Array.from(prev.branchCurrent) : new Float64Array(maxExtras);
  // PERSISTENT state: reuse the same state object across steps so plugins (capacitors,
  // inductors, 555, MCU) keep their memory. Created once per session.
  const stateMap: Record<string, any> = prev ? prev.state : {};
  // expose per-component state objects (also persistent via comp.simState)
  for (const comp of components) {
    if (!comp.simState) comp.simState = {};
    if (!stateMap[comp.id]) stateMap[comp.id] = comp.simState;
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
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin || !plugin.stamp) continue;
    const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
    try {
      plugin.stamp(comp.parameters, terminals, sys, sim);
    } catch (e) {
      console.error(`stamp error in ${comp.type} (${comp.id}):`, e);
    }
  }

  // resize system: we may have allocated more extra vars than used.
  // build a smaller system to avoid singular cols
  const actualSize = sys.nextExtra;
  if (actualSize < sys.size) {
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

  let prev: PrevState | undefined;
  let result: SimContext | null = null;
  for (let iter = 0; iter < maxIter; iter++) {
    const r = simulateStep(components, wires, plugins, prev, 1e-6);
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
