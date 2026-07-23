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
