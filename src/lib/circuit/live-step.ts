// Shared "one UI frame of live simulation" logic.
//
// Used by BOTH the main-thread path (store.step) and the off-thread worker
// (sim-live-host.ts) so the two backends are numerically identical by
// construction: same sub-step count, same digital fast-forward, same options.

import { simulateStep, getTerminalsForComponent, type StepResult, type PrevState, type NodeMap } from './engine';
import { runFullERC } from './erc';
import { snapshotSheet, flattenHierarchy } from './hierarchy';
import { getPlugin } from './registry';
import type { CircuitComponent, ComponentPlugin, SimContext, Wire } from './types';

/** Live-sim backend: 'auto' (worker for big circuits), 'main', or 'worker'. */
export type SimBackend = 'auto' | 'main' | 'worker';

export interface LiveSimOptions {
  initialConditions?: Record<string, number>;
  nodeSets?: Record<string, number>;
  method?: 'euler' | 'trap' | 'gear';
  temp?: number;
}

/** Plugins needed by a component list (types without a plugin are skipped). */
export function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of components) {
    if (plugins.has(c.type)) continue;
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return plugins;
}

/**
 * How many sub-steps to run on this UI frame.
 *  - speed >= 1: floor(speed) sub-steps every frame
 *  - speed < 1: one step every ceil(1/speed)-th frame (0 = skip this frame)
 *  - speed <= 0 / NaN: -1 (invalid; caller must not simulate)
 * `frameCounter` is the number of frames already counted (0-based).
 */
export function subStepsForFrame(speed: number, frameCounter: number): number {
  if (!(speed > 0)) return -1;
  if (speed >= 1) return Math.max(1, Math.floor(speed));
  const skipInterval = Math.ceil(1 / speed);
  return frameCounter % skipInterval === 0 ? 1 : 0;
}

interface ClockInfo { minFreq: number }

/** Minimum digital clock frequency present in the circuit (Infinity = none). */
function digitalClockInfo(simComponents: CircuitComponent[]): ClockInfo {
  const hasCapacitor = simComponents.some((c) => c.type === 'capacitor' || c.type === 'inductor');
  const hasPulseSource = simComponents.some((c) => c.type === 'pulseSource');
  const hasArduino = simComponents.some((c) => c.type === 'arduinoReal' || c.type === 'arduino');
  const hasAstable555 = simComponents.some((c) =>
    c.type === 'timer555' && (c.parameters.astable as boolean) === true);
  let minFreq = Infinity;
  if (hasPulseSource && !hasCapacitor && !hasArduino) {
    for (const c of simComponents) {
      if (c.type === 'pulseSource') {
        const f = c.parameters.frequency as number;
        if (f > 0 && f < minFreq) minFreq = f;
      }
    }
  }
  if (hasAstable555) {
    for (const c of simComponents) {
      if (c.type === 'timer555' && (c.parameters.astable as boolean) === true) {
        const r1 = (c.parameters.r1 as number) || 47000;
        const r2 = (c.parameters.r2 as number) || 47000;
        const cap = (c.parameters.c as number) || 1e-5;
        const period = 0.693 * (r1 + 2 * r2) * cap;
        const f = 1 / period;
        if (f > 0 && f < minFreq) minFreq = f;
      }
    }
  }
  return { minFreq };
}

/**
 * Run `subSteps` engine steps (mutating `prev` to carry state forward) with
 * the digital fast-forward used by the live sim. Returns the last step's
 * result, or null when the solver failed.
 */
export function runFrameSubSteps(
  simComponents: CircuitComponent[],
  simWires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  prev: PrevState,
  dt: number,
  simOpts: LiveSimOptions,
  subSteps: number,
): StepResult | null {
  let result: StepResult | null = null;
  const { minFreq } = digitalClockInfo(simComponents);
  for (let i = 0; i < subSteps; i++) {
    result = simulateStep(simComponents, simWires, plugins, prev, dt, {
      ...simOpts,
      recordTerminalCurrents: i === subSteps - 1,
    });
    if (!result) break;
    prev.nodeVoltage = result.sim.nodeVoltage;
    prev.branchCurrent = result.sim.branchCurrent;
    prev.time = result.sim.time;
    prev.state = result.sim.state;

    // Digital fast-forward: advance sim.time toward the next clock edge so a
    // 1 Hz clock doesn't need ~10000 steps per cycle.
    if (minFreq !== Infinity && minFreq > 0) {
      const currentTime = result.sim.time;
      const phase = (currentTime * minFreq) % 1;
      const timeToRisingEdge = (1.0 - phase) / minFreq;
      const advance = Math.min(0.016, timeToRisingEdge + 0.001);
      if (advance > dt) {
        const newTime = currentTime + advance;
        prev.time = newTime;
        result.sim.time = newTime;
      }
    }
  }
  return result;
}

/** Human-readable reason a step failed (names the real topology culprit). */
export function describeSimFailure(simComponents: CircuitComponent[], simWires: Wire[]): string {
  const hasGround = simComponents.some((c) => c.type === 'ground' || c.type === 'powerGND');
  const topo = runFullERC(simComponents, simWires).errors;
  const loop = topo.find((e) => e.type === 'voltage_source_loop');
  const floating = topo.find((e) => e.type === 'no_dc_path');
  if (!hasGround) {
    return 'Simulation failed: No ground reference found. Add a Ground component to your circuit.';
  } else if (loop) {
    return `Simulation failed: ${loop.message}.`;
  } else if (floating) {
    return `Simulation failed: ${floating.message}.`;
  }
  return 'Simulation failed: Singular matrix. Check for: (1) floating nodes with no DC path to ground, (2) voltage source loops with no series resistance, (3) capacitor-only branches with no DC path. Try adding a 1MΩ resistor from the floating node to ground.';
}

/** Oscilloscope channel reading for one step (first measurement, numeric). */
export function scopeSampleValue(
  comp: CircuitComponent,
  plugin: ComponentPlugin,
  nodeMap: NodeMap,
  sim: SimContext,
): number {
  if (!plugin.measure) return 0;
  const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
  const measurements = plugin.measure(comp.parameters, terminals, sim, comp);
  return parseFloat(measurements[0]?.value ?? '0');
}

/**
 * Resolve the (components, wires) pair the engine should simulate. With
 * sub-sheets this flattens the hierarchy (prefixed ids); otherwise it returns
 * the editor's arrays untouched.
 */
export function flattenForSim(s: {
  components: CircuitComponent[];
  wires: Wire[];
  sheets: any[];
  activeSheet: string | null;
  childSheets: Record<string, any>;
}): { components: CircuitComponent[]; wires: Wire[]; usingHierarchy: boolean } {
  if (!(s.activeSheet || s.sheets.length > 0)) {
    return { components: s.components, wires: s.wires, usingHierarchy: false };
  }
  let childSheets = s.childSheets;
  if (s.activeSheet) {
    childSheets = { ...childSheets, [s.activeSheet]: snapshotSheet(s.components, s.wires, s.sheets) };
  }
  const rootDoc = s.activeSheet
    ? (childSheets as any).__root__ ?? { version: 1 as const, components: [], wires: [], sheets: [] }
    : { version: 1 as const, components: s.components, wires: s.wires, sheets: s.sheets };
  const flat = flattenHierarchy(rootDoc as any, childSheets as any);
  return { components: flat.components, wires: flat.wires, usingHierarchy: true };
}
