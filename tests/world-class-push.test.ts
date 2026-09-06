// World-class push: bias overlays, .meas upgrades, FFT windows, probe
// models, cursor stats, SPICE directives, DRC waivers, AI yield/review tools.

import { describe, it, expect } from 'vitest';
import {
  formatBiasVoltage, formatBiasCurrent,
} from '../src/lib/circuit/schematic-overlays';
import {
  evaluateMeasExpression, findTraceCrossing, measureDelay,
  fftWindowWeight, fftWindowGain, computeFFT,
  parseStrictSpiceNumber,
} from '../src/lib/circuit/measurement';
import { cursorIntervalStats, probeDcGain, probeBandwidth, PROBE_MODELS } from '../src/lib/circuit/scope-viewer';
import { parseSpiceNetlist } from '../src/lib/circuit/spice';
import { drcErrorKey } from '../src/lib/pcb/drc';
import { exportGerberPaste, exportGerberEdgeCuts } from '../src/lib/pcb/gerber-export';
import { coerceParamValue } from '../src/lib/ai/tools/schematic-component-tools';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

describe('bias overlay formatting', () => {
  it('formats voltages across scales', () => {
    expect(formatBiasVoltage(3.3)).toBe('3.30V');
    expect(formatBiasVoltage(0.005)).toContain('mV');
    expect(formatBiasVoltage(0.0005)).toContain('µV');
    expect(formatBiasVoltage(150)).toBe('150.0V');
  });
  it('formats currents across scales', () => {
    expect(formatBiasCurrent(0.0124)).toContain('mA');
    expect(formatBiasCurrent(5e-7)).toContain('nA');
    expect(formatBiasCurrent(2)).toContain('A');
  });
});

describe('.meas PARAM expressions', () => {
  it('evaluates arithmetic over scope', () => {
    expect(evaluateMeasExpression('2*gain', { gain: 10 })).toBe(20);
    expect(evaluateMeasExpression('(vmax-vmin)/2', { vmax: 5, vmin: 1 })).toBe(2);
    expect(evaluateMeasExpression('3.3')).toBe(3.3);
    expect(evaluateMeasExpression('unknown + 1', {})).toBe(1);
  });
});

describe('crossing + delay', () => {
  const trace = (n: number) => {
    const xValues = new Float64Array(n);
    const yValues = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xValues[i] = i * 1e-3;
      yValues[i] = i < n / 2 ? 0 : 5; // step at midpoint
    }
    return { name: 't', xValues, yValues };
  };
  it('finds first crossing with interpolation', () => {
    const t = findTraceCrossing(trace(11), 2.5);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0.004);
    expect(t!).toBeLessThan(0.007);
  });
  it('measureDelay across two traces', () => {
    const a = trace(11);
    const b = { name: 'b', xValues: a.xValues, yValues: Float64Array.from(a.yValues.map((v) => v)) };
    // shift b one sample later
    b.yValues.set([0, ...Array.from(a.yValues.slice(0, 10))]);
    const r = measureDelay('d', a, 2.5, b, 2.5);
    expect(r.value).toBeCloseTo(1e-3, 6);
  });
});

describe('FFT windows', () => {
  it('rect gain = N, hann ≈ N/2', () => {
    expect(fftWindowGain('rect', 64)).toBe(64);
    expect(fftWindowGain('hann', 65)).toBeCloseTo(32, 6);
  });
  it('all windows produce a spectrum', () => {
    const N = 64;
    const xValues = new Float64Array(N);
    const yValues = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      xValues[i] = i * 1e-4;
      yValues[i] = Math.sin(2 * Math.PI * 100 * xValues[i]);
    }
    for (const w of ['hann', 'rect', 'hamming', 'blackman', 'kaiser'] as const) {
      const spec = computeFFT({ name: 's', xValues, yValues }, w);
      expect(spec.yValues.length).toBeGreaterThan(0);
      // Kaiser edge samples are ~1e-8 (deep sidelobe suppression), not
      // exactly 0 — allow a small tolerance for float round-off.
      expect(fftWindowWeight(w, 0, N)).toBeGreaterThanOrEqual(-1e-12);
    }
  });
});

describe('probe models + cursor stats', () => {
  it('10x loads less than 1x', () => {
    const p1 = PROBE_MODELS[1];
    const p10 = PROBE_MODELS[2];
    expect(probeDcGain(1e6, p10)).toBeGreaterThan(probeDcGain(1e6, p1));
    expect(probeBandwidth(1e6, p10)).toBeGreaterThan(probeBandwidth(1e6, p1));
  });
  it('cursor interval stats', () => {
    const samples = [
      { time: 0, voltage: 0 },
      { time: 1e-3, voltage: 2 },
      { time: 2e-3, voltage: 4 },
    ];
    const s = cursorIntervalStats(samples, 0, 2e-3);
    expect(s).not.toBeNull();
    expect(s!.vPp).toBe(4);
    expect(s!.vAvg).toBeCloseTo(2, 9);
    expect(s!.integral).toBeCloseTo(4e-3, 9);
  });
});

describe('SPICE directives', () => {
  it('parses .options/.temp/.tran cards', () => {
    const doc = parseSpiceNetlist([
      '* test',
      'R1 a 0 1k',
      '.options reltol=0.001 method=trap',
      '.temp 50',
      '.tran 1u 10m',
      '.end',
    ].join('\n')) as unknown as { simOptions: { directives: Record<string, unknown>; temp: number; cards: string[] } };
    expect(doc.simOptions.directives['reltol']).toBeCloseTo(0.001, 9);
    expect(doc.simOptions.temp).toBe(50);
    expect(doc.simOptions.cards.length).toBeGreaterThanOrEqual(2);
  });
});

describe('DRC waivers + fab exports', () => {
  it('waiver keys are stable', () => {
    expect(drcErrorKey({ type: 'clearance', position: { x: 1.005, y: 2 } })).toBe(
      drcErrorKey({ type: 'clearance', position: { x: 1.004, y: 2.001 } }),
    );
  });
  it('paste skips THT, edge-cuts outlines board', () => {
    const fps = [{
      refdes: 'R1', position: { x: 0, y: 0 }, rotation: 0,
      bodySize: { width: 3, height: 2 }, side: 'top' as const,
      pads: [
        { id: 'p1', terminalId: 'a', position: { x: 0, y: 0 }, shape: 'rect' as const, size: { width: 1, height: 1 }, layer: 'top' as const },
        { id: 'p2', terminalId: 'b', position: { x: 5, y: 0 }, shape: 'circle' as const, size: { width: 1.8, height: 1.8 }, drill: 1, layer: 'top' as const },
      ],
    }];
    const paste = exportGerberPaste('top', fps as never, { width: 10, height: 10 });
    expect(paste).toContain('PASTE');
    // only one SMD flash (THT skipped)
    expect((paste.match(/D03\*/g) ?? []).length).toBe(1);
    const edge = exportGerberEdgeCuts({ width: 10, height: 10 });
    expect(edge).toContain('EDGE_CUTS');
  });
});

describe('AI unit-safe params', () => {
  it('coerces suffixed strings', () => {
    const plugin = getPlugin('resistor')!;
    const def = plugin.parameters.find((p) => p.key === 'resistance')!;
    expect(coerceParamValue(def, '4.7k', 1000)).toBeCloseTo(4700, 9);
    expect(coerceParamValue(def, '10k', 1000)).toBe(10000);
    expect(parseStrictSpiceNumber('1Meg')).toBe(1e6);
  });
});
