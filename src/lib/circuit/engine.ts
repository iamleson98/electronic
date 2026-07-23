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

export interface NodeMap {
  /** key = `${componentId}:${terminalId}` -> node id (0 = ground) */
  terminalNode: Map<string, number>;
  /** total number of nodes (including ground) */
  numNodes: number;
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
    if (comp.type === 'ground') {
      // any terminal on a ground component is node 0
      for (const t of plugin.terminals) {
        const k = termKey(comp.id, t.id);
        terminalNode.set(k, 0);
      }
    }
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
  const result = new Map<string, number>();
  const nodeMap = buildNodeMap(components, wires, plugins);

  // Build a map: for each node, sum of currents LEAVING that node through all
  // passive components (resistors, LEDs, diodes). This helps us compute wire
  // currents at junctions where multiple components meet.
  const nodeCurrentOut = new Map<number, number>(); // nodeId -> net current leaving

  // First pass: compute current through each passive component and accumulate
  // at its terminals.
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);

    if (comp.type === 'resistor') {
      const r = Math.max(1e-9, comp.parameters.resistance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
      const i = v / r; // current from a to b through resistor
      // At node 'a': current i is LEAVING (going into resistor)
      // At node 'b': current i is ENTERING (coming from resistor), so -i leaving
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'capacitor') {
      const C = Math.max(1e-15, comp.parameters.capacitance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const vPrev = st[`cap_${a}_${b}`] ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
      const i = (C / Math.max(sim.dt, 1e-12)) * (v - vPrev); // current from a to b
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
    } else if (comp.type === 'inductor') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const i = st[`ind_${a}_${b}`] ?? 0; // current from a to b
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
      const on = st[`${comp.type}_${a}_${k}`] ?? false;
      const i = on ? Math.max(0, (v - vf) / r) : 0; // current from a to k (forward only)
      nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
      nodeCurrentOut.set(k, (nodeCurrentOut.get(k) ?? 0) - i);
    } else if (comp.type === 'switch' || comp.type === 'pushButton') {
      const closed = comp.type === 'switch'
        ? comp.parameters.closed
        : comp.parameters.pressed;
      if (closed) {
        const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
        const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
        const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
        const i = v / 0.01; // current from a to b
        nodeCurrentOut.set(a, (nodeCurrentOut.get(a) ?? 0) + i);
        nodeCurrentOut.set(b, (nodeCurrentOut.get(b) ?? 0) - i);
      }
    } else if (comp.type === 'dcVoltage' || comp.type === 'acVoltage' || comp.type === 'pulseSource') {
      // Voltage source: conventional current flows OUT of + terminal, INTO - terminal.
      // The current magnitude = current through the external circuit.
      // We can compute this from KCL: the current leaving the + node through the
      // source = -(sum of currents leaving + node through passive components).
      // But that's done in the second pass. Here we just note that the source
      // delivers current at + and absorbs at -.
      // We'll handle this in the wire loop below by using nodeCurrentOut.
    } else if (comp.type === 'currentSource') {
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const i = comp.parameters.current as number; // current from p to n externally
      // Current source pushes current OUT of p, INTO n (externally)
      // So at node p: current i is ENTERING from the source (source delivers to p)
      // Wait — stampCurrentSource pushes from p to n externally, meaning current
      // leaves the source at p and enters the external circuit at p.
      // So at node p: +i leaving (into external circuit)
      // At node n: -i leaving (returning from external circuit)
      nodeCurrentOut.set(p, (nodeCurrentOut.get(p) ?? 0) + i);
      nodeCurrentOut.set(n, (nodeCurrentOut.get(n) ?? 0) - i);
    }
  }

  // Second pass: for each wire, compute the current flowing from `from` to `to`.
  // The current through a wire = the current that the `from` component is pushing
  // into the wire (i.e., current leaving the `from` terminal).
  //
  // For a wire connected to a passive component at `from`:
  //   The current leaving the `from` terminal = the component's current at that terminal.
  //   We computed nodeCurrentOut[node] = net current leaving that node through ALL
  //   passive components. But a wire connects two terminals that share the same node,
  //   so the wire current isn't simply nodeCurrentOut — we need the component-specific current.
  //
  // Simplified approach: for each wire, compute the current through the component
  // at the `from` end, and determine the sign based on which terminal the wire is on.
  // Positive = current flowing from wire.from to wire.to (conventional current direction).

  for (const wire of wires) {
    const fromComp = components.find((c) => c.id === wire.from.componentId);
    if (!fromComp) continue;
    const plugin = plugins.get(fromComp.type);
    if (!plugin) continue;
    const fromTerm = plugin.terminals.find((t) => t.id === wire.from.terminalId);
    if (!fromTerm) continue;
    const fromNode = nodeMap.terminalNode.get(`${fromComp.id}:${fromTerm.id}`) ?? 0;
    const terms = getTerminalsForComponent(fromComp, plugin, nodeMap);

    let current = 0; // positive = from wire.from to wire.to

    if (fromComp.type === 'resistor') {
      const r = Math.max(1e-9, fromComp.parameters.resistance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
      const i = v / r; // current from a to b THROUGH resistor
      // If wire is at 'a': current i enters the resistor at 'a', meaning the wire
      //   is delivering i to 'a'. So current flows from wire to component.
      //   The wire's from→to direction: if from='a', current leaving 'a' toward
      //   the wire = -i (the resistor is sinking current at 'a').
      //   But we want current flowing from from to to. The wire connects 'a' to
      //   some other terminal. Current flows from high V to low V.
      //   If V(a) > V(b), current flows a→b through resistor. The wire at 'a'
      //   is the SOURCE of this current (current comes FROM the wire INTO 'a').
      //   So from the wire's perspective, current flows from the other end TO 'a',
      //   i.e., from wire.to to wire.from. That's negative (from→to is opposite).
      //   Wait, that's wrong. Let me think again.
      //
      // Conventional current: flows from + to - through external circuit.
      // Resistor: current enters at the higher-voltage terminal, leaves at lower.
      // If V(a) > V(b): current flows a→b through resistor.
      //   The wire at 'a' brings current TO 'a' (from the rest of the circuit).
      //   So current in the wire flows TOWARD 'a', i.e., from wire.to to wire.from
      //   (if from='a'). That means from→to current = -i.
      //   If from='b': current leaves 'b' toward the wire, flowing from 'b' away.
      //   So from→to current = +i (current flows from 'b' to the other end).
      //
      // Summary: if from='a', wire current (from→to) = -i
      //          if from='b', wire current (from→to) = +i
      // But this seems backwards. Let me verify with a simple example:
      //   Battery(+) → wire1 → resistor(a→b) → wire2 → Battery(-)
      //   V(a) > V(b), so i > 0 (a→b through resistor)
      //   wire1: from=Battery(+), to=Resistor(a). Current should flow +→a, i.e., from→to = +i
      //     But from is Battery(+), not resistor. So this case is handled by the voltage source logic.
      //   wire2: from=Resistor(b), to=Battery(-). Current should flow b→-, i.e., from→to = +i
      //     from='b', so wire current = +i. ✓
      //   If wire1 were from=Resistor(a), to=Battery(+): current flows +→a, so from→to = a→+ = -i
      //     from='a', so wire current = -i. ✓
      //
      // So: if from='a', current = -i; if from='b', current = +i
      current = (fromNode === a) ? -i : i;
    } else if (fromComp.type === 'capacitor') {
      const C = Math.max(1e-15, fromComp.parameters.capacitance as number);
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const vPrev = st[`cap_${a}_${b}`] ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
      const i = (C / Math.max(sim.dt, 1e-12)) * (v - vPrev);
      current = (fromNode === a) ? -i : i;
    } else if (fromComp.type === 'inductor') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const i = st[`ind_${a}_${b}`] ?? 0;
      current = (fromNode === a) ? -i : i;
    } else if (fromComp.type === 'led' || fromComp.type === 'diode') {
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const k = terms.find((t) => t.terminalId === 'k')?.nodeId ?? 0;
      const v = sim.nodeVoltage[a] - sim.nodeVoltage[k];
      const vf = (fromComp.parameters.forwardV as number) || 0.7;
      const r = fromComp.type === 'led'
        ? Math.max(0.01, fromComp.parameters.seriesR as number)
        : Math.max(0.001, fromComp.parameters.onR as number);
      const st = sim.state.__global ?? {};
      const on = st[`${fromComp.type}_${a}_${k}`] ?? false;
      const i = on ? Math.max(0, (v - vf) / r) : 0;
      // Same as resistor: current flows a→k (anode→cathode) when forward biased
      current = (fromNode === a) ? -i : i;
    } else if (fromComp.type === 'dcVoltage' || fromComp.type === 'acVoltage' || fromComp.type === 'pulseSource') {
      // Voltage source: conventional current flows OUT of + terminal.
      // The current magnitude = current through the external circuit.
      // We can get this from KCL: current leaving + node through source =
      //   -(sum of currents leaving + node through all other components)
      // But simpler: the current through the voltage source = current flowing
      // from + to - externally. We can compute this as the net current leaving
      // the + node through all passive components (which must return through the source).
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      // Current leaving + node through passive components = nodeCurrentOut[p]
      // This current must come FROM the voltage source (source pushes it out at +).
      // So the source current (out of +) = nodeCurrentOut[p].
      const sourceCurrentOut = nodeCurrentOut.get(p) ?? 0;
      // If wire is at '+': current flows OUT of + into the wire. from→to = +sourceCurrentOut
      // If wire is at '-': current flows INTO - from the wire. from→to = -sourceCurrentOut
      //   (because current enters the source at '-', so from the wire's perspective
      //    it flows from wire.to to wire.from if from='-')
      // Wait: if from='-', the wire delivers current TO '-'. So current flows from
      //   wire.to toward wire.from (the '-' terminal). from→to = -sourceCurrentOut.
      //   But sourceCurrentOut is the current leaving '+'. The current entering '-' = sourceCurrentOut.
      //   So if from='-', the wire brings sourceCurrentOut INTO '-'. from→to = -sourceCurrentOut.
      //   Hmm, but from='-' means the wire starts at '-' and goes to some other terminal.
      //   Current flows from the other terminal TO '-'. So from→to = -(current into '-') = -sourceCurrentOut.
      //   Actually no. If current flows INTO '-', and the wire is connected to '-', then
      //   current flows FROM wire.to TO wire.from ('-'). So from→to = -sourceCurrentOut.
      // Let me verify: Battery(+) → wire1 → R → wire2 → Battery(-)
      //   wire1: from=Battery(+), to=R. Current flows +→R. sourceCurrentOut > 0.
      //     from='p', so current = +sourceCurrentOut. from→to = positive. ✓ (dots flow from + to R)
      //   wire2: from=R, to=Battery(-). But this is handled by resistor logic, not source.
      //   If wire2 were from=Battery(-), to=R: current flows R→- (into battery).
      //     from='n', current = -sourceCurrentOut. from→to = -sourceCurrentOut < 0.
      //     Negative means dots flow from to→from = from R to '-'. ✓ (current enters battery at -)
      current = (fromNode === p) ? sourceCurrentOut : -sourceCurrentOut;
    } else if (fromComp.type === 'currentSource') {
      // Current source: pushes current from + to - externally.
      // Current leaves + , enters -.
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      const n = terms.find((t) => t.terminalId === 'n')?.nodeId ?? 0;
      const i = fromComp.parameters.current as number;
      current = (fromNode === p) ? i : -i;
    } else if (fromComp.type === 'switch' || fromComp.type === 'pushButton') {
      const closed = fromComp.type === 'switch'
        ? fromComp.parameters.closed
        : fromComp.parameters.pressed;
      if (closed) {
        const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
        const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
        const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
        const i = v / 0.01;
        current = (fromNode === a) ? -i : i;
      }
    }

    result.set(wire.id, current);
  }

  return result;
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
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      const i = st[`ind_${a}_${b}`] ?? 0;
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
      const on = st[`${comp.type}_${a}_${k}`] ?? false;
      const i = on ? Math.max(0, (v - vf) / r) : 0;
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
      const a = terms.find((t) => t.terminalId === 'a')?.nodeId ?? 0;
      const b = terms.find((t) => t.terminalId === 'b')?.nodeId ?? 0;
      const st = sim.state.__global ?? {};
      current = st[`ind_${a}_${b}`] ?? 0; // a→b
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
      // Current through voltage source = current leaving + node through passive components
      const p = terms.find((t) => t.terminalId === 'p')?.nodeId ?? 0;
      current = nodeCurrentOut.get(p) ?? 0; // p→n externally (conventional current out of +)
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
      // BJT: collector/emitter current
      const cOrE = comp.type === 'npn' ? 'c' : 'e';
      const eOrC = comp.type === 'npn' ? 'e' : 'c';
      const cNode = terms.find((t) => t.terminalId === cOrE)?.nodeId ?? 0;
      const eNode = terms.find((t) => t.terminalId === eOrC)?.nodeId ?? 0;
      // For NPN: current flows C→E. For PNP: current flows E→C.
      // Use the nodeCurrentOut at the "input" terminal.
      current = nodeCurrentOut.get(cNode) ?? 0;
    } else if (comp.type === 'nmos' || comp.type === 'pmos') {
      // MOSFET: drain/source current
      const dOrS = comp.type === 'nmos' ? 'd' : 's';
      const dNode = terms.find((t) => t.terminalId === dOrS)?.nodeId ?? 0;
      current = nodeCurrentOut.get(dNode) ?? 0;
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
): StepResult | null {
  const nodeMap = buildNodeMap(components, wires, plugins);
  const numNodes = nodeMap.numNodes; // includes ground (0)
  const maxExtras = components.length * 4 + 8;

  const sys = createMnaSystem(numNodes - 1, maxExtras);

  const time = prev && prev.nodeVoltage.length > 0 ? prev.time + dt : 0;

  // initialize SimContext with previous voltages (for companion models).
  // If prev has no data yet (first step), allocate fresh arrays sized to numNodes.
  const hasPrev = prev && prev.nodeVoltage.length > 0;
  const nodeVoltage = hasPrev ? Float64Array.from(prev.nodeVoltage) : new Float64Array(numNodes);
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

  const x = solveMna(sys);
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
