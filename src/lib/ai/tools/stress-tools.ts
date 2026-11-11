// AI tool: component stress check (PSpice "Smoke"-style).
//
// Simulates the circuit on private copies (DC, then transient) and compares
// each part's peak voltage / peak current / average power with its datasheet
// absolute-maximum ratings. Non-mutating.

import { runStressAnalysis, formatStressValue } from '../../circuit/stress-check';
import type { Tool, ToolContext } from './types';
import { ensurePlugins } from './helpers';

export const stressCheckTool: Tool = {
  name: 'stress_check',
  category: 'Simulation & Analysis',
  description: 'PSpice-"Smoke"-style stress check: simulates the circuit and compares every part\'s peak voltage, peak current and AVERAGE power with its datasheet absolute-maximum ratings (resistor power, capacitor voltage / reverse polarity, LED If, diode If/Vr, BJT Vceo/Ic/Pd/Vebo, MOSFET Vds/Vgs/Id/Pd, 555 / 7805 / LM317 / op-amp / 74HC / CD4000 supply limits). Returns one row per rating with value, limit, derated limit, ratio and status ok / warn (above derated limit) / fail (above absolute max). Parts without known ratings are not listed. Use to catch a 1/8 W resistor dissipating 5 W, an LED at 100 mA, a reversed electrolytic or Vgs beyond ±20 V. Non-mutating.',
  parameters: {
    type: 'object',
    properties: {
      derating: {
        type: 'number',
        description: 'Fraction of the absolute maximum allowed before a WARN, 0-1. 1 (default) = absolute max only; 0.8 = "professional" 20% margin.',
      },
      mode: { type: 'string', enum: ['dc', 'tran'], description: "'tran' (default) = DC seed + transient; 'dc' = operating point only." },
      tStop: { type: 'number', description: 'Transient stop time in seconds (default 10 ms).' },
      tStep: { type: 'number', description: 'Transient step in seconds (default 100 µs).' },
      onlyProblems: { type: 'boolean', description: 'Return only warn / fail rows (default false).' },
    },
    required: [],
  },
  execute(args: { derating?: number; mode?: 'dc' | 'tran'; tStop?: number; tStep?: number; onlyProblems?: boolean }, ctx: ToolContext) {
    try {
      ensurePlugins(ctx);
      const report = runStressAnalysis(ctx.doc.components, ctx.doc.wires, ctx.plugins, {
        derating: args.derating,
        mode: args.mode ?? 'tran',
        tStop: args.tStop ?? 10e-3,
        tStep: args.tStep ?? 1e-4,
      });
      if (report.error && report.rows.length === 0) return { ok: false, error: report.error };
      const rows = (args.onlyProblems ? report.rows.filter((r) => r.status !== 'ok') : report.rows).map((r) => ({
        ref: r.ref,
        componentId: r.componentId,
        part: r.part ?? r.type,
        metric: r.metric,
        value: formatStressValue(r.value, r.unit),
        limit: formatStressValue(r.rating, r.unit),
        deratedLimit: formatStressValue(r.deratedLimit, r.unit),
        percentOfAbsMax: Math.round(r.ratio * 100),
        status: r.status,
        ...(r.note ? { note: r.note } : {}),
      }));
      const { summary } = report;
      return {
        ok: true,
        result: {
          verdict: summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'pass',
          summary: `${summary.fail} fail, ${summary.warn} warn, ${summary.ok} ok across ${summary.parts} rated part(s) (derating ${Math.round(report.derating * 100)}%, ${report.mode === 'tran' ? 'transient' : 'DC'}; peak V/I, average power)`,
          counts: summary,
          rows,
          ...(report.error ? { warning: report.error } : {}),
        },
      };
    } catch (e) {
      return { ok: false, error: `stress check failed: ${(e as Error).message}` };
    }
  },
};
