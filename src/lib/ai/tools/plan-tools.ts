// AI plan-tracking tool — multi-turn task plans with visible progress.
//
// Lets the model declare a plan (spec → steps) and update step states, so
// complex multi-stage builds survive across turns instead of living only in
// prose. Plans are turn-scoped metadata returned to the model; the ChatPanel
// progress accordion renders them from tool results.

import type { Tool, ToolContext } from './types';

export interface PlanStep {
  title: string;
  status: 'pending' | 'in-progress' | 'done' | 'blocked';
  detail?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  updatedAt: number;
}

// Module-level current plan (per server instance; the turn runner includes
// it in context for follow-up turns via the tool result echo).
let currentPlan: Plan | null = null;

export function getCurrentPlan(): Plan | null {
  return currentPlan;
}

export const planTrackTool: Tool = {
  name: 'plan.track',
  category: 'AI Diagnosis & Teaching',
  description: 'Create or update a multi-step task plan (goal + ordered steps with pending/in-progress/done/blocked states). Use for complex multi-stage builds so progress is tracked across turns. Returns the current plan.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Overall goal (required when creating a plan).' },
      steps: {
        type: 'array',
        description: 'Full ordered step list (titles). Statuses merge with the existing plan by title.',
        items: { type: 'string' },
      },
      update: {
        type: 'array',
        description: 'Step status updates.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Step title (must match).' },
            status: { type: 'string', description: 'pending, in-progress, done, or blocked.' },
            detail: { type: 'string', description: 'Optional note.' },
          },
          required: ['title', 'status'],
        },
      },
      clear: { type: 'boolean', description: 'Clear the current plan.' },
    },
  },
  execute(args: {
    goal?: string;
    steps?: string[];
    update?: { title: string; status: string; detail?: string }[];
    clear?: boolean;
  }, _ctx: ToolContext) {
    if (args.clear) {
      currentPlan = null;
      return { ok: true, result: { plan: null, message: 'Plan cleared.' } };
    }
    if (args.goal || args.steps) {
      const steps: PlanStep[] = (args.steps ?? currentPlan?.steps.map((s) => s.title) ?? []).map((title) => {
        const prev = currentPlan?.steps.find((s) => s.title === title);
        return prev ?? { title, status: 'pending' as const };
      });
      currentPlan = { goal: args.goal ?? currentPlan?.goal ?? '', steps, updatedAt: Date.now() };
    }
    if (args.update && currentPlan) {
      for (const u of args.update) {
        const step = currentPlan.steps.find((s) => s.title === u.title);
        if (step && ['pending', 'in-progress', 'done', 'blocked'].includes(u.status)) {
          step.status = u.status as PlanStep['status'];
          if (u.detail !== undefined) step.detail = u.detail;
        }
      }
      currentPlan.updatedAt = Date.now();
    }
    if (!currentPlan) {
      return { ok: false, error: 'No active plan — pass goal + steps to create one.' };
    }
    const done = currentPlan.steps.filter((s) => s.status === 'done').length;
    return {
      ok: true,
      result: {
        plan: currentPlan,
        progress: `${done}/${currentPlan.steps.length} steps done`,
      },
    };
  },
};
