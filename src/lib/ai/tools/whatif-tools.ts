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

export const faultInjectionTool: Tool = {
  name: 'simulate.fault',
  category: 'AI Diagnosis & Teaching',
  description: 'Inject a fault into a CLONE and simulate: short a component (0.01Ω), open it, add leakage, or stick a logic output high/low. Answers "what if C1 shorts?" for failure analysis. Non-mutating — the real circuit is untouched.',
  parameters: {
    type: 'object',
    properties: {
      componentId: {
        type: 'string',
        description: 'Component to fault (e.g. "c1").',
      },
      fault: {
        type: 'string',
        description: '"short" (0.01Ω across it), "open" (1TΩ), "leak" (10kΩ across it), "stuckHigh" (output forced to VCC), "stuckLow" (output forced to 0).',
      },
      steps: { type: 'number', description: 'Transient steps (default 100).' },
      dt: { type: 'number', description: 'Timestep in seconds (default 1e-4).' },
      probes: {
        type: 'array',
        description: 'Terminal keys to measure (e.g. ["r1:b"]).',
        items: { type: 'string' },
      },
    },
    required: ['componentId', 'fault'],
  },
  execute(args: {
    componentId: string;
    fault: string;
    steps?: number;
    dt?: number;
    probes?: string[];
  }, ctx: ToolContext) {
    ensurePlugins(ctx);
    const plugins = ctx.plugins;
    const src = ctx.doc.components.find((c) => c.id === args.componentId);
    if (!src) return { ok: false, error: `Component "${args.componentId}" not found.` };
    const cloned: CircuitComponent[] = ctx.doc.components.map((c) => ({
      ...c,
      parameters: { ...c.parameters },
      position: { ...c.position },
      simState: undefined,
    }));
    const target = cloned.find((c) => c.id === args.componentId)!;
    const fault = args.fault.toLowerCase();
    let applied = '';
    if (fault === 'short') {
      // Bridge the first two terminals with a 10mΩ resistor clone.
      const plugin = plugins.get(target.type);
      const terms = plugin?.terminals.slice(0, 2) ?? [];
      if (terms.length < 2) return { ok: false, error: 'Component has fewer than 2 terminals — cannot short.' };
      cloned.push({
        id: `__fault_${Date.now().toString(36)}`,
        type: 'resistor',
        position: { ...target.position },
        rotation: 0,
        parameters: { resistance: 0.01 },
      });
      const bridge = cloned[cloned.length - 1];
      const wires: Wire[] = ctx.doc.wires.map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to } }));
      wires.push(
        { id: `__fw1_${bridge.id}`, from: { componentId: target.id, terminalId: terms[0].id }, to: { componentId: bridge.id, terminalId: 'a' } },
        { id: `__fw2_${bridge.id}`, from: { componentId: target.id, terminalId: terms[1].id }, to: { componentId: bridge.id, terminalId: 'b' } },
      );
      applied = `shorted ${target.id} with 10mΩ`;
      return runFaultSim(cloned, wires, plugins, applied, args, ctx);
    }
    if (fault === 'open') {
      // Remove all wires touching the component (leaves it unconnected).
      const wires: Wire[] = ctx.doc.wires
        .filter((w) => w.from.componentId !== target.id && w.to.componentId !== target.id)
        .map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to } }));
      applied = `opened ${target.id} (all wires lifted)`;
      return runFaultSim(cloned, wires, plugins, applied, args, ctx);
    }
    if (fault === 'leak') {
      cloned.push({
        id: `__fault_${Date.now().toString(36)}`,
        type: 'resistor',
        position: { ...target.position },
        rotation: 0,
        parameters: { resistance: 10000 },
      });
      const bridge = cloned[cloned.length - 1];
      const plugin = plugins.get(target.type);
      const terms = plugin?.terminals.slice(0, 2) ?? [];
      if (terms.length < 2) return { ok: false, error: 'Component has fewer than 2 terminals — cannot add leakage.' };
      const wires: Wire[] = ctx.doc.wires.map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to } }));
      wires.push(
        { id: `__fw1_${bridge.id}`, from: { componentId: target.id, terminalId: terms[0].id }, to: { componentId: bridge.id, terminalId: 'a' } },
        { id: `__fw2_${bridge.id}`, from: { componentId: target.id, terminalId: terms[1].id }, to: { componentId: bridge.id, terminalId: 'b' } },
      );
      applied = `10kΩ leakage across ${target.id}`;
      return runFaultSim(cloned, wires, plugins, applied, args, ctx);
    }
    if (fault === 'stuckhigh' || fault === 'stucklow') {
      const plugin = plugins.get(target.type);
      const outTerm = plugin?.terminals.find((t) => t.id === 'y' || t.id === 'out' || t.id === 'q');
      if (!outTerm) return { ok: false, error: 'Component has no logic output terminal (y/out/q) to stick.' };
      // Force via a 1Ω Thevenin: add a dcVoltage source wired onto the node.
      const vccGuess = 5;
      cloned.push({
        id: `__fault_${Date.now().toString(36)}`,
        type: 'dcVoltage',
        position: { ...target.position },
        rotation: 0,
        parameters: { voltage: fault === 'stuckhigh' ? vccGuess : 0 },
      });
      const srcComp = cloned[cloned.length - 1];
      const wires: Wire[] = ctx.doc.wires.map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to } }));
      // Tie source n to ground net: reuse any ground component, else node 0 via target's gnd pin if present.
      const gnd = cloned.find((c) => c.type === 'ground');
      if (gnd) {
        wires.push({ id: `__fwg_${srcComp.id}`, from: { componentId: srcComp.id, terminalId: 'n' }, to: { componentId: gnd.id, terminalId: 'g' } });
      }
      wires.push({ id: `__fw1_${srcComp.id}`, from: { componentId: srcComp.id, terminalId: 'p' }, to: { componentId: target.id, terminalId: outTerm.id } });
      applied = `${target.id}.${outTerm.id} stuck ${fault === 'stuckhigh' ? 'HIGH' : 'LOW'}`;
      return runFaultSim(cloned, wires, plugins, applied, args, ctx);
    }
    return { ok: false, error: `Unknown fault "${args.fault}" — use short, open, leak, stuckHigh, or stuckLow.` };
  },
};

function runFaultSim(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, any>,
  applied: string,
  args: { steps?: number; dt?: number; probes?: string[] },
  _ctx: ToolContext,
) {
  const steps = Math.min(Math.max(Math.floor(args.steps ?? 100) || 1, 1), 2000);
  const dt = args.dt ?? 1e-4;
  try {
    const sim = simulateCircuit(components, wires, plugins, steps, dt);
    const dcSim = solveDC(components, wires, plugins as never);
    const probeResults: Record<string, { finalVoltage: number; dcVoltage: number }> = {};
    if (args.probes) {
      const nodeMap = buildNodeMap(components, wires, plugins as never);
      for (const probe of args.probes) {
        const nodeId = nodeMap.terminalNode.get(probe);
        if (nodeId === undefined) continue;
        const finalV = sim.length > 0 ? sim[sim.length - 1].nodeVoltage[nodeId] ?? 0 : 0;
        probeResults[probe] = { finalVoltage: finalV, dcVoltage: dcSim ? dcSim.nodeVoltage[nodeId] ?? 0 : finalV };
      }
    }
    return {
      ok: true,
      result: {
        fault: applied,
        stepsCompleted: sim.length,
        probes: probeResults,
        note: 'Non-mutating fault simulation on a clone. The actual circuit is unchanged.',
      },
    };
  } catch (err) {
    return { ok: false, error: `Fault simulation failed: ${(err as Error).message}`, result: { fault: applied } };
  }
}
