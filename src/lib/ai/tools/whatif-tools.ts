// What-if simulation tool — non-mutating exploration.
//
// Lets the AI ask "what if I change R1 to 10k?" without proposing a circuit
// change. Clones the circuit, applies the modifications, runs a sim, returns
// the results, and DISCARDS the clone.

import { simulateStep, solveDC, buildNodeMap, type PrevState } from '../../circuit/engine';
import type { CircuitComponent, CircuitDocument, Wire, SimContext } from '../../circuit/types';
import { parseStrictSpiceNumber } from '../../circuit/measurement';
import type { Tool, ToolContext } from './types';
import { ensurePlugins } from './helpers';

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
    // The plugin map may be stale if the AI added new component types since
    // the request snapshot — refresh before simulating.
    ensurePlugins(ctx);
    const plugins = ctx.plugins;
    // Deep clone the circuit (strip simState — the clone gets fresh state)
    const clonedDoc: CircuitDocument = {
      version: 1,
      components: ctx.doc.components.map(c => ({
        ...c,
        parameters: { ...c.parameters },
        position: { ...c.position },
        simState: undefined,
      })) as CircuitComponent[],
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
      // Parse the value according to the parameter's declared type.
      // Bare parseFloat silently corrupts suffixed values ("10k" → 10 Ω,
      // a 1000× error) and would mangle expression strings ("2*V(in)" → 2).
      const plugin = plugins.get(comp.type);
      const paramDef = plugin?.parameters.find(p => p.key === mod.key);
      let parsed: number | string | boolean;
      if (typeof mod.value === 'boolean') {
        parsed = mod.value;
      } else if (typeof mod.value === 'number') {
        parsed = mod.value;
      } else {
        const asStr = String(mod.value);
        if (paramDef?.type === 'string') {
          parsed = asStr;
        } else if (paramDef?.type === 'boolean' || paramDef?.type === 'select') {
          parsed = asStr;
        } else {
          // numeric (or unknown) parameter — strict SPICE-suffix parse;
          // expressions / non-numeric strings stay strings.
          const num = parseStrictSpiceNumber(asStr);
          parsed = num !== null ? num : asStr;
        }
      }
      comp.parameters[mod.key] = parsed;
      appliedMods.push(`${mod.componentId}.${mod.key} = ${mod.value}`);
    }

    // Run the simulation on the clone
    const steps = Math.min(Math.max(Math.floor(args.steps ?? 100) || 1, 1), 2000);
    const dt = args.dt ?? 1e-4;

    try {
      const sim = simulateCircuit(clonedDoc.components, clonedDoc.wires, plugins, steps, dt);

      // DC operating point of the modified circuit (Newton-converged, includes
      // semiconductor/op-amp extra variables — far more accurate than the
      // transient's final sample for "what does this change do?" questions).
      const dcSim = solveDC(clonedDoc.components, clonedDoc.wires, plugins);

      // Collect probe results
      const probeResults: Record<string, { finalVoltage: number; minVoltage: number; maxVoltage: number; dcVoltage: number }> = {};
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

          // Track voltage over the sim (guard the empty case — a failed first
          // step used to leak literal ±Infinity into the response)
          let minV = Infinity, maxV = -Infinity;
          for (let i = 0; i < sim.length; i++) {
            const v = sim[i].nodeVoltage[nodeId] ?? 0;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
          }
          if (sim.length === 0) { minV = 0; maxV = 0; }
          const finalV = sim.length > 0 ? sim[sim.length - 1].nodeVoltage[nodeId] ?? 0 : 0;
          const dcV = dcSim ? dcSim.nodeVoltage[nodeId] ?? 0 : finalV;
          probeResults[probe] = {
            finalVoltage: finalV,
            minVoltage: minV,
            maxVoltage: maxV,
            dcVoltage: dcV,
          };
        }
      }

      return {
        ok: true,
        result: {
          modifications: appliedMods,
          steps,
          stepsCompleted: sim.length,
          dt,
          simTime: sim.length * dt,
          probes: probeResults,
          note: 'This was a non-mutating simulation using the full engine (Newton iteration + semiconductor models). dcVoltage is the converged DC operating point of the modified circuit; finalVoltage is the last transient sample. The actual circuit is unchanged. To apply these changes permanently, use schematic.setParameter.',
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

// Helper: run a transient simulation on a set of components using the REAL
// engine (Newton iteration, extra unknowns for op-amps/semiconductors, sparse
// solver for large circuits, persistent plugin state across steps).
function simulateCircuit(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, any>,
  steps: number,
  dt: number,
): SimContext[] {
  const results: SimContext[] = [];
  let prev: PrevState | undefined;
  for (let step = 0; step < steps; step++) {
    const r = simulateStep(components, wires, plugins as Map<any, any>, prev, dt);
    if (!r) break;
    results.push(r.sim);
    prev = {
      nodeVoltage: r.sim.nodeVoltage,
      branchCurrent: r.sim.branchCurrent,
      time: r.sim.time,
      state: r.sim.state,
    };
  }
  return results;
}
