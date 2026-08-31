// FREQUENCY-DOMAIN ANALYSIS TOOLS — AC sweep + Fourier/THD.
// ─────────────────────────────────────────────────────────────────────────────
// These expose the app's real analysis engines (runACAnalysis, computeTHD) to
// the AI so it can answer filter / distortion questions with exact numbers:
//   • simulate.acAnalysis — Bode-style sweep: gain/phase vs frequency, −3 dB
//     cutoff, passband gain, filter-type detection.
//   • simulate.fourier   — transient capture + harmonic spectrum: THD, DC
//     offset, RMS, top harmonics.
// Both are non-mutating (they run on clones) and cap their output sizes so a
// single tool result never floods the model's context.

import type { Tool, ToolContext } from './types';
import { simulateStep, buildNodeMap, computeComponentCurrents } from '@/lib/circuit/engine';
import { runACAnalysis, findCutoffFrequency } from '@/lib/circuit/ac-analysis';
import { computeTHD } from '@/lib/circuit/fourier';
import type { RealTrace } from '@/lib/circuit/analysis';
import type { SimContext } from '@/lib/circuit/types';
import { ensurePlugins } from './helpers';

/** Max points returned to the model (log-thinned to preserve shape). */
const MAX_AC_POINTS = 40;

function thinned<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

export const acAnalysisTool: Tool = {
  name: 'simulate.acAnalysis',
  category: 'Simulation & Analysis',
  description:
    'Run an AC small-signal frequency sweep (Bode analysis): linearizes the circuit at its DC operating point and returns gain (dB) and phase (degrees) vs frequency, the −3 dB cutoff frequency, passband gain, and detected filter type (low-pass / high-pass / band-pass / flat). Use for filters, amplifiers, coupling networks — anything where frequency response matters. Non-mutating.',
  parameters: {
    type: 'object',
    properties: {
      sourceId: {
        type: 'string',
        description: 'The AC/voltage source component ID that drives the sweep (e.g. "v1"). Must have an "ac" amplitude or a nonzero voltage.',
      },
      outputNode: {
        type: 'string',
        description: 'Where to measure, as "componentId:terminalId" (e.g. "r2:a" or "c1:b").',
      },
      outputRef: {
        type: 'string',
        description: 'Optional reference node as "componentId:terminalId" (defaults to ground).',
      },
      fStart: { type: 'number', description: 'Start frequency in Hz (default 1).' },
      fStop: { type: 'number', description: 'Stop frequency in Hz (default 1e6).' },
      nPoints: { type: 'number', description: 'Number of points per decade (default 12, max 30).' },
    },
    required: ['sourceId', 'outputNode'],
  },
  execute(args, ctx: ToolContext) {
    try {
      ensurePlugins(ctx);
      const { components, wires } = ctx.doc;
      const source = components.find(c => c.id === args.sourceId);
      if (!source) {
        return { ok: false, error: `Source "${args.sourceId}" not found.`, result: { available: components.map(c => c.id) } };
      }
      if (!args.outputNode || typeof args.outputNode !== 'string' || !args.outputNode.includes(':')) {
        return { ok: false, error: 'outputNode must be "componentId:terminalId", e.g. "r2:a".' };
      }

      const fStart = Number.isFinite(args.fStart) && args.fStart > 0 ? args.fStart : 1;
      const fStop = Number.isFinite(args.fStop) && args.fStop > fStart ? args.fStop : 1e6;
      const perDecade = Math.min(30, Math.max(4, Math.round(args.nPoints ?? 12) || 12));
      const decades = Math.log10(fStop / fStart);
      const nPoints = Math.max(10, Math.min(240, Math.round(perDecade * decades)));

      const result = runACAnalysis({
        components,
        wires,
        plugins: ctx.plugins as any,
        fStart,
        fStop,
        nPoints,
        sourceId: args.sourceId,
        outputNode: args.outputNode,
        outputRef: args.outputRef,
      });

      if (!result.points || result.points.length === 0) {
        return { ok: false, error: 'AC analysis produced no points (check that the source exists and the output node is valid).' };
      }

      // Passband gain = max magnitude; classify the response shape.
      let maxMag = 0;
      let maxIdx = 0;
      for (let i = 0; i < result.points.length; i++) {
        if (result.points[i].magnitude > maxMag) { maxMag = result.points[i].magnitude; maxIdx = i; }
      }
      const first = result.points[0];
      const last = result.points[result.points.length - 1];
      const magAt = (p: typeof first) => (maxMag > 0 ? p.magnitude / maxMag : 0);
      let filterType: string;
      if (magAt(first) < 0.5 && magAt(last) < 0.5) filterType = 'band-pass';
      else if (magAt(first) < 0.5) filterType = 'high-pass';
      else if (magAt(last) < 0.5) filterType = 'low-pass';
      else filterType = maxMag > 1.05 || maxMag < 0.95 ? 'amplifier/flat' : 'flat';

      const cutoff = result.cutoffFrequency ?? findCutoffFrequency(result.points);

      return {
        ok: true,
        result: {
          filterType,
          passbandGainDb: maxMag > 0 ? Number((20 * Math.log10(maxMag)).toFixed(2)) : -Infinity,
          cutoffFrequencyHz: cutoff ? Number(cutoff.toPrecision(4)) : null,
          peakFrequencyHz: Number(result.points[maxIdx].frequency.toPrecision(4)),
          sweep: `${fStart} Hz → ${fStop} Hz (${nPoints} pts)`,
          points: thinned(result.points, MAX_AC_POINTS).map(p => ({
            fHz: Number(p.frequency.toPrecision(4)),
            gainDb: Number(p.magnitudeDb.toFixed(2)),
            phaseDeg: Number(p.phase.toFixed(1)),
          })),
          note: 'Non-mutating AC sweep. gainDb = 20·log10(|V(out)/V(in)|); cutoff = first −3 dB crossing.',
        },
      };
    } catch (e) {
      return { ok: false, error: `AC analysis failed: ${(e as Error).message}` };
    }
  },
};

export const fourierTool: Tool = {
  name: 'simulate.fourier',
  category: 'Simulation & Analysis',
  description:
    'Run a transient capture of one node (or component current) and compute its harmonic spectrum: THD %, DC offset, RMS, and the strongest harmonics. Use it to quantify distortion in amplifiers/oscillators, check sine purity, or find ripple frequency in power supplies. Non-mutating.',
  parameters: {
    type: 'object',
    properties: {
      probe: {
        type: 'string',
        description: 'What to analyze: "componentId:terminalId" for a node voltage (e.g. "r1:a") or a bare "componentId" for that component\'s current (e.g. "led1").',
      },
      fundamentalHz: { type: 'number', description: 'Expected fundamental frequency in Hz — sets the capture window to ~8 periods (default: auto-detect).' },
      steps: { type: 'number', description: 'Simulation steps to run (default 2000, max 8000).' },
      dt: { type: 'number', description: 'Timestep in seconds (default 1e-4).' },
      method: { type: 'string', enum: ['euler', 'trap', 'gear'], description: 'Integration method (default "trap" — best for oscillators).' },
    },
    required: ['probe'],
  },
  execute(args, ctx: ToolContext) {
    try {
      ensurePlugins(ctx);
      const probe = String(args.probe ?? '');
      const isCurrentProbe = !probe.includes(':');
      const compId = isCurrentProbe ? probe : probe.split(':')[0];
      const terminalId = isCurrentProbe ? undefined : probe.split(':')[1];
      const comp = ctx.doc.components.find(c => c.id === compId);
      if (!comp) {
        return { ok: false, error: `Component "${compId}" not found.`, result: { available: ctx.doc.components.map(c => c.id) } };
      }

      const method: 'euler' | 'trap' | 'gear' =
        args.method === 'euler' || args.method === 'gear' ? args.method : 'trap';
      const dt = Number.isFinite(args.dt) && args.dt > 0 ? args.dt : 1e-4;
      const steps = Math.min(8000, Math.max(64, Math.round(args.steps ?? 2000) || 2000));

      // Node resolution for voltage probes.
      const nodeMap = buildNodeMap(ctx.doc.components, ctx.doc.wires, ctx.plugins as any);
      let nodeIdx: number | null = null;
      if (!isCurrentProbe) {
        nodeIdx = nodeMap.terminalNode.get(`${compId}:${terminalId}`) ?? null;
        if (nodeIdx === null) {
          return { ok: false, error: `Terminal ${probe} not found.` };
        }
      }

      // Transient capture (fresh state — non-mutating snapshot semantics).
      const components = JSON.parse(JSON.stringify(ctx.doc.components)) as typeof ctx.doc.components;
      for (const c of components) if (!c.simState) c.simState = {};
      const times: number[] = [];
      const values: number[] = [];
      let prev: any = undefined;
      let sim: SimContext | null = null;
      let lastError: string | null = null;
      for (let i = 0; i < steps; i++) {
        const r = simulateStep(components, ctx.doc.wires, ctx.plugins as any, prev, dt, { method });
        if (!r) { lastError = `Simulation returned null at step ${i} (singular matrix).`; break; }
        sim = r.sim;
        prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
        times.push(sim.time);
        if (isCurrentProbe) {
          const currents = computeComponentCurrents(components, ctx.doc.wires, ctx.plugins as any, sim);
          values.push(currents.get(compId) ?? 0);
        } else {
          values.push(sim.nodeVoltage[nodeIdx!] ?? 0);
        }
      }
      if (values.length < 64) {
        return { ok: false, error: lastError ?? 'Transient capture too short for Fourier analysis.' };
      }

      // Trim the first ~1 period of settling transient for a cleaner spectrum.
      const expectedFund = Number.isFinite(args.fundamentalHz) && args.fundamentalHz > 0 ? args.fundamentalHz : null;
      let trim = 0;
      if (expectedFund) {
        const period = 1 / expectedFund;
        trim = Math.min(Math.floor(values.length / 3), Math.ceil(period / dt));
      }
      const trace: RealTrace = {
        name: probe,
        xValues: Float64Array.from(times.slice(trim)),
        yValues: Float64Array.from(values.slice(trim)),
      };
      // A diverged sim produces NaN/Infinity — FFT would return garbage.
      for (let i = 0; i < trace.yValues.length; i++) {
        if (!Number.isFinite(trace.yValues[i])) {
          return { ok: false, error: 'Transient capture diverged (non-finite values) — check the circuit for shorts, floating nodes, or conflicting sources.' };
        }
      }

      const thd = computeTHD(trace, 10);
      if (!thd) {
        return { ok: false, error: 'Fourier analysis found no fundamental (signal may be pure DC — try a longer capture or check the probe).' };
      }

      // DC + RMS of the captured window.
      const y = trace.yValues;
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < y.length; i++) { sum += y[i]; sumSq += y[i] * y[i]; }
      const dc = sum / y.length;
      const rms = Math.sqrt(sumSq / y.length);

      return {
        ok: true,
        result: {
          probe,
          quantity: isCurrentProbe ? 'component current (A)' : 'node voltage (V)',
          fundamentalHz: Number(thd.fundamentalFreq.toPrecision(4)),
          thdPercent: Number(thd.thdPercent.toFixed(2)),
          thdDb: Number(thd.thdDb.toFixed(1)),
          snrDb: Number(thd.snrDb.toFixed(1)),
          dc: Number(dc.toPrecision(4)),
          rms: Number(rms.toPrecision(4)),
          capture: `${y.length} samples @ dt=${dt}s (t=${(trace.xValues[0] || 0).toPrecision(3)}s…${(trace.xValues[trace.xValues.length - 1] || 0).toPrecision(3)}s, method=${method})`,
          harmonics: thd.harmonics.slice(0, 6).map(h => ({
            n: h.harmonic,
            fHz: Number(h.frequency.toPrecision(4)),
            percentOfFundamental: Number(h.percentOfFundamental.toFixed(1)),
          })),
          note: 'Non-mutating transient + FFT (Hann window). THD = sqrt(Σ harmonics²≥2)/fundamental ×100%.',
        },
      };
    } catch (e) {
      return { ok: false, error: `Fourier analysis failed: ${(e as Error).message}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Undo / redo — see document-tools.ts (server-side, turn-scoped history)
// ─────────────────────────────────────────────────────────────────────────────
