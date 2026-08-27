// Parameter sweep tool — exposes the batch-runner to the AI.
//
// Lets the AI answer questions like "find the R value that gives I_LED = 10mA"
// by sweeping a parameter across a range and returning the measured output at
// each step.

import { runBatch } from '../../circuit/batch-runner';
import type { Tool, ToolContext } from './types';
import { ensurePlugins } from './helpers';

export const simulateSweepTool: Tool = {
  name: 'simulate.sweep',
  category: 'Simulation & Analysis',
  description: 'Sweep a component parameter across a range and measure the output at each step. Use this to find the optimal value (e.g. "find R that gives I_LED = 10mA") or to characterize circuit behavior. Non-mutating — does NOT modify the actual circuit.',
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
        description: 'Component ID to measure (e.g. "led1" to measure LED current).',
      },
      steps: {
        type: 'number',
        description: 'Number of simulation steps per sweep point (default 50).',
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
    steps?: number;
  }, ctx: ToolContext) {
    const { componentId, param, start, stop, step, probeComponentId, steps = 50 } = args;

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
      // Run the batch sweep with a transient inner analysis
      const batchConfig = {
        type: 'step' as const,
        componentId,
        param,
        start,
        stop,
        step,
        inner: {
          type: 'tran' as const,
          tStop: (steps ?? 50) * 1e-4,
          tStep: 1e-4,
          probes: [`${probeComponentId}:a`],
        },
      };
      const result = runBatch(ctx.doc.components, ctx.doc.wires, ctx.plugins, batchConfig);

      // Extract the measured values at the probe component
      const sweepResults: { value: number; output: number; voltage: number }[] = [];
      for (let i = 0; i < result.traces.length; i++) {
        const trace = result.traces[i];
        const sweepValue = result.sweepValues[i]?.value ?? 0;
        // Get the final voltage/current from the trace
        if (trace.yValues.length > 0) {
          const finalV = trace.yValues[trace.yValues.length - 1];
          sweepResults.push({
            value: sweepValue,
            output: finalV,
            voltage: finalV,
          });
        }
      }

      // Find the optimal value (closest to a target, if specified)
      // For now, just return all results
      return {
        ok: true,
        result: {
          sweepParam: `${componentId}.${param}`,
          probeComponent: probeComponentId,
          points: sweepResults,
          count: sweepResults.length,
          note: 'This was a non-mutating parameter sweep. The actual circuit is unchanged.',
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
