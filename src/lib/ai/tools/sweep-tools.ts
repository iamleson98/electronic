// Parameter sweep tool — DC operating-point sweep with correctly labeled
// voltage AND current measurements at every point.
//
// Lets the AI answer questions like "find the R value that gives I_LED = 10mA"
// by sweeping a parameter across a range and returning the measured output at
// each step. Each point runs a fresh Newton-converged DC solve on a clone, so
// both the probe component's CURRENT and any terminal's VOLTAGE are exact.

import { solveDC, buildNodeMap, computeComponentCurrents } from '../../circuit/engine';
import type { CircuitComponent } from '../../circuit/types';
import type { Tool, ToolContext } from './types';
import { ensurePlugins } from './helpers';

export const simulateSweepTool: Tool = {
  name: 'simulate.sweep',
  category: 'Simulation & Analysis',
  description: 'Sweep a component parameter across a range and measure the DC operating point at each step — returns BOTH the probe component\'s current (A) and its first terminal\'s voltage (V). Use this to find the optimal value (e.g. "find R that gives I_LED = 10mA" — read the `current` field) or to characterize DC behavior. Non-mutating — does NOT modify the actual circuit.',
  parameters: {
    type: 'object',
    properties: {
      componentId: {
        type: 'string',
        description: 'The component ID whose parameter to sweep (e.g. "r1").',
      },
      param: {
        type: 'string',
        description: 'The parameter key to sweep (e.g. "resistance", "voltage", "capacitance").',
      },
      start: {
        type: 'number',
        description: 'Start value of the sweep.',
      },
      stop: {
        type: 'number',
        description: 'Stop value of the sweep.',
      },
      step: {
        type: 'number',
        description: 'Step size between sweep values.',
      },
      probeComponentId: {
        type: 'string',
        description: 'Component ID to measure (e.g. "led1"). Returns its current in A and its first terminal voltage in V.',
      },
      probeTerminal: {
        type: 'string',
        description: 'Optional terminal ID of the probe component to read the voltage from (default: the component\'s first terminal, e.g. "a" for resistors, "p" for sources).',
      },
    },
    required: ['componentId', 'param', 'start', 'stop', 'step', 'probeComponentId'],
  },
  execute(args: {
    componentId: string;
    param: string;
    start: number;
    stop: number;
    step: number;
    probeComponentId: string;
    probeTerminal?: string;
  }, ctx: ToolContext) {
    const { componentId, param, start, stop, step, probeComponentId } = args;

    // Verify the components exist
    const sweepComp = ctx.doc.components.find(c => c.id === componentId);
    if (!sweepComp) {
      return {
        ok: false,
        error: `Component "${componentId}" not found.`,
        result: { availableComponents: ctx.doc.components.map(c => ({ id: c.id, type: c.type })) },
      };
    }
    const probeComp = ctx.doc.components.find(c => c.id === probeComponentId);
    if (!probeComp) {
      return {
        ok: false,
        error: `Probe component "${probeComponentId}" not found.`,
        result: { availableComponents: ctx.doc.components.map(c => ({ id: c.id, type: c.type })) },
      };
    }

    try {
      // The plugin map may be stale if the AI added new component types since
      // the request snapshot — refresh before simulating.
      ensurePlugins(ctx);
      const plugins = ctx.plugins;

      // Resolve the probe terminal: explicit, or the plugin's first terminal
      // (was hardcoded ':a' — for sources with p/n terminals the old probe
      // silently measured ground).
      const probePlugin = plugins.get(probeComp.type);
      const probeTerm = args.probeTerminal ?? probePlugin?.terminals[0]?.id;
      if (!probeTerm) {
        return { ok: false, error: `Probe component "${probeComponentId}" has no terminals.` };
      }

      // Generate sweep values (same inclusive-range semantics as batch-runner)
      if (!Number.isFinite(step) || step === 0) {
        return { ok: false, error: 'step must be a nonzero number.' };
      }
      const rising = step > 0;
      if (rising !== (stop >= start)) {
        return { ok: false, error: `Invalid sweep range: start=${start}, stop=${stop}, step=${step}.` };
      }
      const maxPoints = 200;
      const nPoints = Math.floor((stop - start) / step) + 1;
      if (nPoints < 1 || nPoints > maxPoints) {
        return { ok: false, error: `Sweep produces ${nPoints} points (max ${maxPoints}). Widen the step.` };
      }

      const points: { value: number; current: number; voltage: number; converged: boolean }[] = [];
      let failed = 0;
      for (let i = 0; i < nPoints; i++) {
        const value = start + i * step;
        // Clone with the swept parameter (non-mutating — the real doc is untouched)
        const modified: CircuitComponent[] = ctx.doc.components.map(c =>
          c.id === componentId
            ? { ...c, parameters: { ...c.parameters, [param]: value } }
            : c,
        );
        const dc = solveDC(modified, ctx.doc.wires, plugins);
        if (!dc) {
          failed++;
          points.push({ value, current: NaN, voltage: NaN, converged: false });
          continue;
        }
        const nodeMap = buildNodeMap(modified, ctx.doc.wires, plugins);
        const nodeId = nodeMap.terminalNode.get(`${probeComponentId}:${probeTerm}`) ?? 0;
        const currents = computeComponentCurrents(modified, ctx.doc.wires, plugins, dc);
        points.push({
          value,
          current: currents.get(probeComponentId) ?? 0,
          voltage: dc.nodeVoltage[nodeId] ?? 0,
          converged: true,
        });
      }

      const okPoints = points.filter(p => p.converged);
      if (okPoints.length === 0) {
        return {
          ok: false,
          error: 'No sweep point converged (DC solve failed everywhere — check for floating nodes or conflicting voltage sources).',
        };
      }

      return {
        ok: true,
        result: {
          sweepParam: `${componentId}.${param}`,
          probeComponent: probeComponentId,
          probeTerminal: probeTerm,
          points,
          count: okPoints.length,
          failedPoints: failed,
          note: `DC operating-point sweep (non-mutating). "current" is the component current in AMPS (positive = into terminal a/p), "voltage" is V(${probeComponentId}:${probeTerm}). Use the current field for "find R for I=..." questions.`,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: `Sweep failed: ${(err as Error).message}`,
      };
    }
  },
};
