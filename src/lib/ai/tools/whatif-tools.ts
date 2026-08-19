// What-if simulation tool — non-mutating exploration.
//
// Lets the AI ask "what if I change R1 to 10k?" without proposing a circuit
// change. Clones the circuit, applies the modifications, runs a sim, returns
// the results, and DISCARDS the clone.

import { simulateStep, buildNodeMap, getTerminalsForComponent } from '../../circuit/engine';
import { createMnaSystem, solveMna } from '../../circuit/solver';
import type { CircuitComponent, CircuitDocument, Wire, SimContext } from '../../circuit/types';
import type { Tool, ToolContext } from './types';

interface WhatIfModification {
  componentId: string;
  key: string;
  value: number | string | boolean;
}

export const simulateWhatIfTool: Tool = {
  name: 'simulate.whatIf',
  category: 'AI Diagnosis & Teaching',
  description: 'Run a non-mutating "what-if" simulation. Clones the circuit, applies the specified parameter modifications, runs a short transient simulation, and returns the results WITHOUT modifying the actual circuit. Use this to answer "what if R1 were 10k?" questions without proposing a circuit change.',
  parameters: {
    type: 'object',
    properties: {
      modifications: {
        type: 'array',
        description: 'List of parameter changes to apply to the clone.',
        items: {
          type: 'object',
          properties: {
            componentId: { type: 'string', description: 'The component ID to modify (e.g. "r1").' },
            key: { type: 'string', description: 'The parameter key (e.g. "resistance").' },
            value: { type: 'string', description: 'The new value (as a string; will be parsed appropriately).' },
          },
          required: ['componentId', 'key', 'value'],
        },
      },
      steps: {
        type: 'number',
        description: 'Number of simulation steps (default 100).',
      },
      dt: {
        type: 'number',
        description: 'Timestep in seconds (default 1e-4 = 100µs).',
      },
      probes: {
        type: 'array',
        description: 'List of terminal IDs to measure (e.g. ["r1:a", "led1:k"]). Returns voltage at each.',
        items: { type: 'string' },
      },
    },
    required: ['modifications'],
  },
  execute(args: {
    modifications: WhatIfModification[];
    steps?: number;
    dt?: number;
    probes?: string[];
  }, ctx: ToolContext) {
    // Deep clone the circuit
    const clonedDoc: CircuitDocument = {
      version: 1,
      components: ctx.doc.components.map(c => ({
        ...c,
        parameters: { ...c.parameters },
        position: { ...c.position },
      })),
      wires: ctx.doc.wires.map(w => ({
        ...w,
        from: { ...w.from },
        to: { ...w.to },
      })),
    };

    // Apply modifications to the clone
    const appliedMods: string[] = [];
    for (const mod of args.modifications) {
      const comp = clonedDoc.components.find(c => c.id === mod.componentId);
      if (!comp) {
        return {
          ok: false,
          error: `Component "${mod.componentId}" not found.`,
          result: {
            availableComponents: ctx.doc.components.map(c => ({ id: c.id, type: c.type })),
          },
        };
      }
      // Try to parse the value as number, fall back to string
      const numVal = parseFloat(mod.value as string);
      comp.parameters[mod.key] = isNaN(numVal) ? mod.value : numVal;
      appliedMods.push(`${mod.componentId}.${mod.key} = ${mod.value}`);
    }

    // Run the simulation on the clone
    const steps = args.steps ?? 100;
    const dt = args.dt ?? 1e-4;
    const plugins = ctx.plugins;

    try {
      const sim = simulateCircuit(clonedDoc.components, clonedDoc.wires, plugins, steps, dt);

      // Collect probe results
      const probeResults: Record<string, { finalVoltage: number; minVoltage: number; maxVoltage: number }> = {};
      if (args.probes) {
        const nodeMap = buildNodeMap(clonedDoc.components, clonedDoc.wires, plugins);
        for (const probe of args.probes) {
          const [compId, termId] = probe.split(':');
          const comp = clonedDoc.components.find(c => c.id === compId);
          if (!comp) continue;
          const plugin = plugins.get(comp.type);
          if (!plugin) continue;
          const nodeId = nodeMap.terminalNode.get(`${compId}:${termId}`);
          if (nodeId === undefined) continue;

          // Track voltage over the sim
          let minV = Infinity, maxV = -Infinity;
          for (let i = 0; i < sim.length; i++) {
            const v = sim[i].nodeVoltage[nodeId] ?? 0;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
          }
          const finalV = sim[sim.length - 1].nodeVoltage[nodeId] ?? 0;
          probeResults[probe] = {
            finalVoltage: finalV,
            minVoltage: minV,
            maxVoltage: maxV,
          };
        }
      }

      return {
        ok: true,
        result: {
          modifications: appliedMods,
          steps,
          dt,
          simTime: steps * dt,
          probes: probeResults,
          note: 'This was a non-mutating simulation. The actual circuit is unchanged. To apply these changes permanently, use schematic.setParameter.',
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: `Simulation failed: ${(err as Error).message}`,
        result: { modifications: appliedMods },
      };
    }
  },
};

// Helper: run a simple transient simulation on a set of components
function simulateCircuit(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, any>,
  steps: number,
  dt: number,
): SimContext[] {
  const nodeMap = buildNodeMap(components, wires, plugins);
  const numNodes = nodeMap.numNodes;
  const sys = createMnaSystem(numNodes, 100);
  const state: Record<string, any> = {};

  const results: SimContext[] = [];
  let simTime = 0;
  const nodeVoltage = new Float64Array(numNodes);
  const branchCurrent = new Float64Array(100);

  for (let step = 0; step < steps; step++) {
    simTime += dt;
    const simContext: SimContext = {
      nodeVoltage,
      branchCurrent,
      state,
      time: simTime,
      dt,
    };

    // Re-stamp by creating a fresh MNA system each step
    const freshSys = createMnaSystem(numNodes, 100);
    for (const comp of components) {
      const plugin = plugins.get(comp.type);
      if (!plugin) continue;
      const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
      plugin.stamp?.(comp.parameters, terminals, freshSys, simContext);
    }

    // Solve
    const sol = solveMna(freshSys);
    if (sol) {
      for (let i = 0; i < numNodes; i++) {
        nodeVoltage[i] = sol[i] ?? 0;
      }
    }

    results.push({
      nodeVoltage: new Float64Array(nodeVoltage),
      branchCurrent: new Float64Array(branchCurrent),
      state,
      time: simTime,
      dt,
    });
  }

  return results;
}
