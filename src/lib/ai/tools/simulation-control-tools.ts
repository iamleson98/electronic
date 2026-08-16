// SIMULATION CONTROL TOOLS (start/pause/step/reset — client-side)
// These return a "request" that the client executes.
// Auto-extracted from the original ai/tools/index.ts during refactor.

import type { Tool } from './types';

export const startSimulationTool: Tool = {
  name: 'simulate.start',
  category: 'Simulation & Analysis',
  description: 'Start the live simulation (begins animating current flow on the canvas). Use this after building a circuit so the user can see it run.',
  parameters: { type: 'object', properties: {} },
  execute() { return { ok: true, result: { action: 'start', message: 'Simulation started — client will begin animating' } }; },
};

export const pauseSimulationTool: Tool = {
  name: 'simulate.pause',
  category: 'Simulation & Analysis',
  description: 'Pause the running simulation.',
  parameters: { type: 'object', properties: {} },
  execute() { return { ok: true, result: { action: 'pause' } }; },
};

export const resetSimulationTool: Tool = {
  name: 'simulate.reset',
  category: 'Simulation & Analysis',
  description: 'Stop and reset the simulation, clearing all state and oscilloscope traces.',
  parameters: { type: 'object', properties: {} },
  execute() { return { ok: true, result: { action: 'reset' } }; },
};

export const setSimulationSpeedTool: Tool = {
  name: 'simulate.setSpeed',
  category: 'Simulation & Analysis',
  description: 'Set the simulation speed multiplier (1 = real-time, 0.1 = slow-motion for debugging, 10 = fast-forward).',
  parameters: {
    type: 'object',
    properties: {
      speed: { type: 'number', description: 'Speed multiplier (0.01 to 100).' },
    },
    required: ['speed'],
  },
  execute(args) { return { ok: true, result: { action: 'setSpeed', speed: args.speed } }; },
};
