// SIMULATION TOOLS
// Auto-extracted from the original ai/tools/index.ts during refactor.

import type { Tool } from './types';
import type { ToolContext } from './types';
import { genId, findComponent } from './helpers';
import type { CircuitDocument, CircuitComponent, Wire, SimContext } from '@/lib/circuit/types';
import { simulateStep, buildNodeMap, getTerminalsForComponent, computeComponentCurrents, computeWireCurrents, solveDC } from '@/lib/circuit/engine';
import { getPlugin, getAllPlugins, getPluginsByCategory } from '@/lib/circuit/registry';
import { validatePhysics } from '@/lib/circuit/physics-validator';
import { exampleCategories } from '@/lib/circuit/examples';
import { exportSPICENetlist, exportBOMCSV, exportKiCadNetlist } from '@/lib/circuit/netlist-export';
import { runDRC } from '@/lib/pcb/drc';
import { verifyNetlist } from '@/lib/pcb/netlist-verify';
import { autoRoute } from '@/lib/pcb/auto-router';
import { routeTopologically, DEFAULT_ROUTER_OPTIONS } from '@/lib/pcb/topological-router';
import { runAutoVerify } from '@/lib/ai/system-prompt';

// ─────────────────────────────────────────────────────────────────────────────

const runSimulationTool: Tool = {
  name: 'simulate.run',
  category: 'Simulation & Analysis',
  description: 'Run the simulation for N steps and return the final node voltages, branch currents, and component currents. This is the main tool for analyzing circuit behavior.',
  parameters: {
    type: 'object',
    properties: {
      steps: { type: 'number', description: 'Number of simulation steps to run (default 200, max 2000). Each step is dt seconds.' },
      dt: { type: 'number', description: 'Time step in seconds (default 1e-4 = 100µs). Smaller = more accurate but slower.' },
      method: { type: 'string', enum: ['euler', 'trap', 'gear'], description: 'Integration method for capacitors/inductors: "euler" (backward Euler, most stable, damps oscillators), "trap" (trapezoidal, 2nd-order, conserves LC energy — best for oscillators/filters), "gear" (Gear/BDF-2, 2nd-order, extra damping for stiff circuits). Default "euler".' },
    },
  },
  async execute(args, ctx) {
    const steps = Math.min(Math.max(args.steps || 200, 1), 2000);
    const dt = args.dt || 1e-4;
    const plugins = ctx.plugins;
    const method: 'euler' | 'trap' | 'gear' =
      args.method === 'trap' || args.method === 'gear' ? args.method : 'euler';

    // Reset simState for fresh run
    for (const c of ctx.doc.components) if (!c.simState) c.simState = {};

    let prev: any = undefined;
    let sim: SimContext | null = null;
    let lastError: string | null = null;
    let stepsCompleted = 0;

    for (let i = 0; i < steps; i++) {
      try {
        const r = simulateStep(ctx.doc.components, ctx.doc.wires, plugins, prev, dt, { method });
        if (!r) { lastError = `Simulation returned null at step ${i} (singular matrix — likely a floating node or conflicting voltage sources)`; break; }
        sim = r.sim;
        stepsCompleted = i + 1;
        prev = {
          nodeVoltage: r.sim.nodeVoltage,
          branchCurrent: r.sim.branchCurrent,
          time: r.sim.time,
          state: r.sim.state,
        };
      } catch (e) {
        lastError = `Simulation error at step ${i}: ${(e as Error).message}`;
        break;
      }
    }

    if (!sim) return { ok: false, error: lastError || 'Simulation failed' };
    ctx.simContext = sim;

    // Build node map for terminal → node lookup
    const nodeMap = buildNodeMap(ctx.doc.components, ctx.doc.wires, plugins);
    const compCurrents = computeComponentCurrents(ctx.doc.components, ctx.doc.wires, plugins, sim);
    const wireCurrents = computeWireCurrents(ctx.doc.components, ctx.doc.wires, plugins, sim);

    // Map terminal → voltage
    const voltages: Record<string, number> = {};
    for (const [key, nodeIdx] of nodeMap.terminalNode) {
      voltages[key] = sim.nodeVoltage[nodeIdx] ?? 0;
    }

    // Trapezoidal ringing-guard telemetry: how many times the (−1)^n mode was
    // detected and suppressed. A large count hints the timestep is too coarse
    // for the circuit's time constants (or there are very sharp edges).
    const trapRings = method === 'trap'
      ? ((sim.state as any)?.__global?.__trapRingCount as number | undefined) ?? 0
      : undefined;

    return {
      ok: true,
      result: {
        stepsCompleted,
        ...(lastError ? { stoppedEarly: true, stopReason: lastError } : {}),
        ...(trapRings !== undefined ? { trapRingsSuppressed: trapRings } : {}),
        finalTime: sim.time,
        nodeVoltages: voltages,
        componentCurrents: Array.from(compCurrents.entries()).map(([id, i]) => ({ componentId: id, currentA: i })),
        wireCurrents: Array.from(wireCurrents.entries()).map(([id, i]) => ({ wireId: id, currentA: i })),
      },
    };
  },
};

const getVoltageTool: Tool = {
  name: 'simulate.getVoltage',
  category: 'Simulation & Analysis',
  description: 'Get the voltage at a specific component terminal. Requires that simulate.run was called first. Returns the voltage in volts.',
  parameters: {
    type: 'object',
    properties: {
      componentId: { type: 'string', description: 'Component ID.' },
      terminalId: { type: 'string', description: 'Terminal ID, e.g. "p", "a", "out", "c".' },
    },
    required: ['componentId', 'terminalId'],
  },
  execute(args, ctx) {
    if (!ctx.simContext) return { ok: false, error: 'No simulation has been run. Call simulate.run first.' };
    const nodeMap = buildNodeMap(ctx.doc.components, ctx.doc.wires, ctx.plugins);
    const nodeIdx = nodeMap.terminalNode.get(`${args.componentId}:${args.terminalId}`);
    if (nodeIdx === undefined) return { ok: false, error: `Terminal ${args.componentId}:${args.terminalId} not found` };
    return { ok: true, result: { voltage: ctx.simContext.nodeVoltage[nodeIdx] } };
  },
};

const getCurrentTool: Tool = {
  name: 'simulate.getCurrent',
  category: 'Simulation & Analysis',
  description: 'Get the current flowing through a component (in amperes). Requires that simulate.run was called first.',
  parameters: {
    type: 'object',
    properties: {
      componentId: { type: 'string', description: 'Component ID.' },
    },
    required: ['componentId'],
  },
  execute(args, ctx) {
    if (!ctx.simContext) return { ok: false, error: 'No simulation has been run. Call simulate.run first.' };
    const currents = computeComponentCurrents(ctx.doc.components, ctx.doc.wires, ctx.plugins, ctx.simContext);
    const i = currents.get(args.componentId);
    if (i === undefined) return { ok: false, error: `Component ${args.componentId} not found or has no current` };
    return { ok: true, result: { currentA: i } };
  },
};

const validatePhysicsTool: Tool = {
  name: 'simulate.validatePhysics',
  category: 'Simulation & Analysis',
  description: 'Run the physics validator on the current circuit state. Checks KCL (current conservation), Ohm\'s law, voltage source law, power conservation, diode/transistor laws. Returns a list of any violations.',
  parameters: {
    type: 'object',
    properties: {
      runSim: { type: 'boolean', description: 'If true (default), run a 200-step simulation before validating. If false, use the existing simContext.' },
    },
  },
  async execute(args, ctx) {
    if (args.runSim !== false || !ctx.simContext) {
      // Run a sim first
      const runResult = await runSimulationTool.execute({ steps: 200, dt: 1e-4 }, ctx);
      if (!runResult.ok) return runResult;
    }
    if (!ctx.simContext) return { ok: false, error: 'No simulation context available' };
    const result = validatePhysics(ctx.doc.components, ctx.doc.wires, ctx.plugins, ctx.simContext);
    return {
      ok: true,
      result: {
        passed: result.passed,
        violationCount: result.violations.length,
        errors: result.violations.filter(v => v.severity === 'error'),
        warnings: result.violations.filter(v => v.severity === 'warning'),
        checkedAt: result.checkedAt,
      },
    };
  },
};

const solveDCTool: Tool = {
  name: 'simulate.solveDC',
  category: 'Simulation & Analysis',
  description: 'Solve the DC operating point of the circuit (no time-stepping). Returns the steady-state node voltages. Useful for bias analysis.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    const sim = solveDC(ctx.doc.components, ctx.doc.wires, ctx.plugins);
    if (!sim) return { ok: false, error: 'DC solve failed (singular matrix — check for floating nodes or conflicting sources)' };
    ctx.simContext = sim;
    const nodeMap = buildNodeMap(ctx.doc.components, ctx.doc.wires, ctx.plugins);
    const voltages: Record<string, number> = {};
    for (const [key, nodeIdx] of nodeMap.terminalNode) {
      voltages[key] = sim.nodeVoltage[nodeIdx] ?? 0;
    }
    return { ok: true, result: { nodeVoltages: voltages } };
  },
};

// The system injects an automatic verify.autoCheck tool-call/result pair into
// the conversation after circuit mutations; this registers the tool FOR REAL
// so the model can also call it explicitly (previously the injected history
// referenced an unregistered tool — imitating it returned "Unknown tool").
const autoCheckTool: Tool = {
  name: 'verify.autoCheck',
  category: 'Simulation & Analysis',
  description: 'Run the automatic verification suite on the current circuit: ERC diagnostics plus a DC operating-point solve. Returns health, ranked issues, and convergence status.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    const report = runAutoVerify(ctx);
    return {
      ok: true,
      result: {
        ...report,
        note: 'Auto-check: fix critical/error issues before finishing your answer.',
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { runSimulationTool, getVoltageTool, getCurrentTool, validatePhysicsTool, solveDCTool, autoCheckTool };
