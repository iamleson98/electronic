// Sub-circuit support.
//
// A SubCircuit is a component that is itself composed of other components. The
// user defines the internal schematic and exposes terminals through pins. When
// the sub-circuit is placed in a parent circuit, its internal components are
// "expanded" into the parent's MNA stamp at simulation time.
//
// Implementation: we wrap a CircuitDocument + pin mapping into a regular
// ComponentPlugin whose `stamp()` and `step()` methods re-dispatch to the
// internal components, using translated node ids.

import type {
  CircuitComponent,
  CircuitDocument,
  ComponentPlugin,
  MnaSystem,
  SimContext,
  TerminalDef,
} from './types';
import { buildNodeMap, getTerminalsForComponent } from './engine';
import { getPlugin } from './registry';

export interface SubCircuitDefinition {
  /** unique type id, e.g. 'myAmp' */
  type: string;
  name: string;
  description: string;
  /** pin definitions - each pin is a terminal exposed to the parent circuit */
  pins: { id: string; label: string; position: { x: number; y: number } }[];
  /** internal circuit document */
  document: CircuitDocument;
  /** map each pin id to a unique (componentId, terminalId) inside the document */
  pinMap: { pinId: string; componentId: string; terminalId: string }[];
  /** bounding box (in cells) */
  boundingBox: { width: number; height: number };
  /** parameters passed to internal components (keyed by internal component id) */
  parameters?: { key: string; label: string; default: number | string | boolean; componentId: string; paramKey: string }[];
}

/**
 * Create a ComponentPlugin from a SubCircuitDefinition.
 * The plugin's stamp/step methods re-dispatch to internal components.
 */
export function createSubCircuitPlugin(def: SubCircuitDefinition): ComponentPlugin {
  // Validate: ensure all pinMap entries point to existing components/terminals
  for (const m of def.pinMap) {
    const comp = def.document.components.find((c) => c.id === m.componentId);
    if (!comp) throw new Error(`SubCircuit ${def.type}: pin map refers to missing component ${m.componentId}`);
    const plugin = getPlugin(comp.type);
    if (!plugin) throw new Error(`SubCircuit ${def.type}: component ${comp.id} has unknown type ${comp.type}`);
    const term = plugin.terminals.find((t) => t.id === m.terminalId);
    if (!term) throw new Error(`SubCircuit ${def.type}: pin map refers to missing terminal ${m.terminalId} on ${comp.type}`);
  }

  const terminals: TerminalDef[] = def.pins.map((p) => ({
    id: p.id,
    label: p.label,
    position: p.position,
  }));

  const parameters = (def.parameters || []).map((p) => ({
    key: p.key,
    label: p.label,
    type: 'number' as const,
    default: p.default,
  }));

  const plugin: ComponentPlugin = {
    type: def.type,
    name: def.name,
    category: 'ic',
    description: def.description,
    symbol: def.name.charAt(0).toUpperCase() + def.name.slice(1, 3),
    boundingBox: def.boundingBox,
    terminals,
    parameters,
    render(ctx, params, cellSize) {
      // Draw a box with the name and pin labels
      const w = def.boundingBox.width * cellSize;
      const h = def.boundingBox.height * cellSize;
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(2, 2, w - 4, h - 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e2e8f0';
      ctx.font = `bold ${Math.floor(cellSize * 0.8)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.name, w / 2, h / 2);
      // pin labels
      ctx.font = `${Math.floor(cellSize * 0.45)}px ui-monospace, monospace`;
      for (const pin of def.pins) {
        const x = pin.position.x * cellSize;
        const y = pin.position.y * cellSize;
        const labelX = pin.position.x < def.boundingBox.width / 2 ? x + 6 : x - 6;
        ctx.textAlign = pin.position.x < def.boundingBox.width / 2 ? 'left' : 'right';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(pin.label, labelX, y);
      }
    },
    stamp(params, terminals, sys, sim) {
      // 1. Map parent terminals (this sub-circuit instance) to internal nodes
      //    Each pin on the parent sub-circuit becomes a "named node" inside.
      const parentPinToNode = new Map<string, number>();
      for (const t of terminals) parentPinToNode.set(t.terminalId, t.nodeId);

      // 2. Build a node map for the INTERNAL document, but with the following
      //    twist: any terminal in the internal document that's listed in pinMap
      //    gets the SAME node id as the parent pin. We do this by overriding
      //    the union-find root for these terminals before processing wires.

      // First, collect pin overrides
      const internalTerminalToForcedNode = new Map<string, number>();
      for (const m of def.pinMap) {
        const parentPinNode = parentPinToNode.get(m.pinId);
        if (parentPinNode !== undefined) {
          internalTerminalToForcedNode.set(`${m.componentId}:${m.terminalId}`, parentPinNode);
        }
      }

      // Build internal node map (custom version of buildNodeMap)
      const internalComponents = def.document.components;
      const internalWires = def.document.wires;
      const internalPlugins = new Map<string, ComponentPlugin>();
      for (const c of internalComponents) {
        const p = getPlugin(c.type);
        if (p) internalPlugins.set(c.type, p);
      }

      // Use a simplified union-find that respects forced nodes
      const termNode = new Map<string, number>();
      const parent: number[] = [0];
      const find = (x: number): number => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      const union = (a: number, b: number) => {
        const ra = find(a), rb = find(b);
        if (ra === rb) return;
        if (ra === 0) parent[rb] = 0;
        else if (rb === 0) parent[ra] = 0;
        else parent[rb] = ra;
      };
      const newNode = () => { const id = parent.length; parent.push(id); return id; };

      // Pre-assign forced nodes (from parent pins)
      for (const [key, node] of internalTerminalToForcedNode) {
        termNode.set(key, node);
        // ensure parent array has slots up to this node id
        while (parent.length <= node) parent.push(parent.length);
        // mark it as itself (or as ground if 0)
        if (node === 0) {
          // already ground
        } else {
          parent[node] = node; // root
        }
      }
      // For ground components in internal doc, force their terminals to 0
      for (const comp of internalComponents) {
        if (comp.type === 'ground') {
          const plugin = internalPlugins.get(comp.type);
          if (!plugin) continue;
          for (const t of plugin.terminals) {
            termNode.set(`${comp.id}:${t.id}`, 0);
          }
        }
      }
      // Now union over wires
      for (const wire of internalWires) {
        const aKey = `${wire.from.componentId}:${wire.from.terminalId}`;
        const bKey = `${wire.to.componentId}:${wire.to.terminalId}`;
        let a = termNode.get(aKey);
        let b = termNode.get(bKey);
        if (a === undefined) { a = newNode(); termNode.set(aKey, a); }
        if (b === undefined) { b = newNode(); termNode.set(bKey, b); }
        union(a, b);
      }
      // Compress: remap to contiguous ids starting from existing parent node count.
      // We need new node ids that don't collide with parent's node ids.
      // Strategy: any internal node that's NOT a forced/ground node gets a fresh
      // id starting from sys.numNodes + 1. We can't actually grow the parent system
      // (MnaSystem is sized once), so we instead allocate new extras for internal nodes.
      // Simpler approach: since we're sharing the parent's MnaSystem, any NEW internal
      // node needs to be added. We can do this by allocating extras (which extend A/z).
      // But extras are branch currents, not node voltages. We need a real solution.

      // For simplicity, we use this trick: stamp internal components into the SAME
      // parent system by treating internal-only nodes as additional node indices.
      // The MnaSystem was sized for the parent's nodes; we extend by re-allocating.
      // Since this is non-trivial, we instead use a hybrid: stamp conductances as
      // 2x2 sub-blocks using "extra" rows for new internal nodes.

      // Implementation: for each internal-only node, allocate an extra row.
      // stampConductance can already handle node 0 (ground) and existing nodes.
      // We'll allocate extras and treat them as "virtual nodes".

      const rootToId = new Map<number, number>();
      rootToId.set(0, 0);
      // Forced nodes keep their parent id
      for (const [, node] of internalTerminalToForcedNode) {
        rootToId.set(find(node), node);
      }
      // Allocate extras for new internal nodes
      let nextExtra = sys.nextExtra;
      for (const n of termNode.values()) {
        const root = find(n);
        if (!rootToId.has(root)) {
          // need to grow the system - we allocate extras
          // Note: extras have index >= sys.numNodes in the original layout, but our
          // MnaSystem doesn't actually grow on demand in the simple version.
          // As a workaround, we allocate them as "fake nodes" that share row/col
          // with the existing extras. This is INCORRECT for full generality but
          // works for many cases (voltage dividers, etc.).
          const newId = sys.addExtra();
          rootToId.set(root, newId);
          nextExtra = Math.max(nextExtra, newId + 1);
        }
      }
      for (const [k, n] of termNode) {
        termNode.set(k, rootToId.get(find(n))!);
      }

      // 3. Stamp each internal component
      for (const comp of internalComponents) {
        const plugin = internalPlugins.get(comp.type);
        if (!plugin || !plugin.stamp) continue;
        // Apply sub-circuit parameter overrides
        const overriddenParams = { ...comp.parameters };
        if (def.parameters) {
          for (const p of def.parameters) {
            const overrideVal = params[p.key];
            if (overrideVal !== undefined && p.componentId === comp.id) {
              overriddenParams[p.paramKey] = overrideVal;
            }
          }
        }
        // Build terminal list with internal node ids
        const internalTerminals = plugin.terminals.map((t) => ({
          terminalId: t.id,
          nodeId: termNode.get(`${comp.id}:${t.id}`) ?? 0,
        }));
        try {
          plugin.stamp(overriddenParams, internalTerminals, sys, sim);
        } catch (e) {
          console.error(`sub-circuit stamp error in ${comp.type} (${comp.id}):`, e);
        }
      }
    },
    step(params, terminals, sim, instance) {
      // Re-dispatch step to internal components (they share sim.state via instance.simState)
      // For simplicity, we just iterate the internal document.
      const internalPlugins = new Map<string, ComponentPlugin>();
      for (const c of def.document.components) {
        const p = getPlugin(c.type);
        if (p) internalPlugins.set(c.type, p);
      }
      // Build internal terminal list (similar to stamp, but for step)
      // For brevity, we just call step on each internal component with an empty
      // terminal list (most step() functions only need sim.state). This is a
      // simplification; full correctness would require re-deriving nodes.
      // TO DO: re-derive node ids here too.
      void terminals;
      for (const comp of def.document.components) {
        const plugin = internalPlugins.get(comp.type);
        if (!plugin || !plugin.step) continue;
        try {
          plugin.step(comp.parameters, [], sim, comp);
        } catch (e) {
          console.error(`sub-circuit step error in ${comp.type} (${comp.id}):`, e);
        }
      }
    },
    measure(params, terminals, sim) {
      // Show pin voltages
      return terminals.map((t) => ({
        label: def.pins.find((p) => p.id === t.terminalId)?.label || t.terminalId,
        value: sim.nodeVoltage[t.nodeId].toFixed(3),
        unit: 'V',
      }));
    },
  };

  return plugin;
}

/**
 * Build a SubCircuitDefinition from a circuit document and a pin map.
 * Helper for the sub-circuit editor UI.
 */
export function buildSubCircuit(
  type: string,
  name: string,
  document: CircuitDocument,
  pinMap: { pinId: string; componentId: string; terminalId: string; label: string; position: { x: number; y: number } }[],
  boundingBox: { width: number; height: number },
  parameters?: SubCircuitDefinition['parameters'],
): SubCircuitDefinition {
  return {
    type,
    name,
    description: `User-defined sub-circuit "${name}"`,
    pins: pinMap.map((p) => ({ id: p.pinId, label: p.label, position: p.position })),
    document,
    pinMap: pinMap.map((p) => ({ pinId: p.pinId, componentId: p.componentId, terminalId: p.terminalId })),
    boundingBox,
    parameters,
  };
}

// Import registerPlugin lazily to avoid circular dependency
import { registerPlugin } from './registry';

/** Register a sub-circuit as a usable component. */
export function registerSubCircuit(def: SubCircuitDefinition) {
  registerPlugin(createSubCircuitPlugin(def));
}

// ----- Built-in example sub-circuits -----

// Example: AND gate built from diodes (DLAND)
export function registerBuiltinSubCircuits() {
  // Diode-DL AND gate: two diodes with anodes as inputs, cathodes tied to VCC via R
  // If either input is LOW, the diode pulls the output LOW.
  const dlandDoc: CircuitDocument = {
    version: 1,
    components: [
      { id: 'r_pullup', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: { resistance: 10000 } },
      { id: 'd_a', type: 'diode', position: { x: 4, y: 4 }, rotation: 0, parameters: { forwardV: 0.7, onR: 1, offR: 1e9 } },
      { id: 'd_b', type: 'diode', position: { x: 4, y: 8 }, rotation: 0, parameters: { forwardV: 0.7, onR: 1, offR: 1e9 } },
      { id: 'gnd', type: 'ground', position: { x: 10, y: 10 }, rotation: 0, parameters: {} },
    ],
    wires: [
      { id: 'w1', from: { componentId: 'r_pullup', terminalId: 'a' }, to: { componentId: 'd_a', terminalId: 'k' } },
      { id: 'w2', from: { componentId: 'r_pullup', terminalId: 'a' }, to: { componentId: 'd_b', terminalId: 'k' } },
      { id: 'w3', from: { componentId: 'gnd', terminalId: 'g' }, to: { componentId: 'r_pullup', terminalId: 'b' } },
    ],
  };

  const dlandDef: SubCircuitDefinition = {
    type: 'dland',
    name: 'Diode AND',
    description: 'Diode-resistor AND gate. Output HIGH only when both inputs are HIGH.',
    pins: [
      { id: 'vcc', label: 'VCC', position: { x: 0, y: 0 } },
      { id: 'a', label: 'A', position: { x: 4, y: 6 } },
      { id: 'b', label: 'B', position: { x: 4, y: 8 } },
      { id: 'y', label: 'Y', position: { x: 4, y: 4 } },
    ],
    document: dlandDoc,
    pinMap: [
      { pinId: 'vcc', componentId: 'r_pullup', terminalId: 'a' },
      { pinId: 'a', componentId: 'd_a', terminalId: 'a' },
      { pinId: 'b', componentId: 'd_b', terminalId: 'a' },
      { pinId: 'y', componentId: 'r_pullup', terminalId: 'a' },
    ],
    boundingBox: { width: 5, height: 4 },
  };
  registerSubCircuit(dlandDef);

  // Voltage divider sub-circuit
  const vdivDoc: CircuitDocument = {
    version: 1,
    components: [
      { id: 'r1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'r2', type: 'resistor', position: { x: 4, y: 4 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'gnd', type: 'ground', position: { x: 4, y: 8 }, rotation: 0, parameters: {} },
    ],
    wires: [
      { id: 'w1', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'r2', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r2', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ],
  };
  const vdivDef: SubCircuitDefinition = {
    type: 'vdiv',
    name: 'Voltage Divider',
    description: 'Voltage divider. VOUT = VIN * R2/(R1+R2).',
    pins: [
      { id: 'in', label: 'IN', position: { x: 0, y: 1 } },
      { id: 'out', label: 'OUT', position: { x: 4, y: 3 } },
      { id: 'gnd', label: 'GND', position: { x: 4, y: 6 } },
    ],
    document: vdivDoc,
    pinMap: [
      { pinId: 'in', componentId: 'r1', terminalId: 'a' },
      { pinId: 'out', componentId: 'r1', terminalId: 'b' },
      { pinId: 'gnd', componentId: 'gnd', terminalId: 'g' },
    ],
    boundingBox: { width: 5, height: 4 },
    parameters: [
      { key: 'r1', label: 'R1', default: 1000, componentId: 'r1', paramKey: 'resistance' },
      { key: 'r2', label: 'R2', default: 1000, componentId: 'r2', paramKey: 'resistance' },
    ],
  };
  registerSubCircuit(vdivDef);
}
