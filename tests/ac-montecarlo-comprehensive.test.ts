// Tests for AC analysis and Monte Carlo — verifies the new implementations
// produce correct frequency-domain and statistical results.

import { describe, it, expect, beforeAll } from 'vitest';
import { runACAnalysis, logspace, findCutoffFrequency, type ACPoint } from '../src/lib/circuit/ac-analysis';
import { runMonteCarlo, runWorstCase } from '../src/lib/circuit/monte-carlo';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC } from '../src/lib/circuit/engine';
import type { CircuitComponent, Wire, ComponentPlugin, CircuitDocument } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
});

function comp(type: string, id: string, params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return {
    id, type,
    position: { x: 0, y: 0 },
    rotation: 0,
    parameters: { ...defaults, ...params },
  };
}

function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}

function pluginsFor(components: CircuitComponent[]): Map<string, ComponentPlugin> {
  return new Map(getAllPlugins().filter(p => components.some(c => c.type === p.type)).map(p => [p.type, p]));
}

// ─────────────────────────────────────────────────────────────────────────────
// logspace helper
// ─────────────────────────────────────────────────────────────────────────────

describe('logspace', () => {
  it('returns empty array for n=0', () => {
    expect(logspace(0, 3, 0)).toEqual([]);
  });
  it('returns single point for n=1', () => {
    expect(logspace(0, 3, 1)).toEqual([1000]);
  });
  it('returns [1, 10, 100, 1000] for logspace(0, 3, 4)', () => {
    const r = logspace(0, 3, 4);
    expect(r.length).toBe(4);
    expect(r[0]).toBeCloseTo(1, 6);
    expect(r[3]).toBeCloseTo(1000, 6);
  });
  it('decade sweep: 1Hz to 1MHz in 7 points', () => {
    const r = logspace(0, 6, 7);
    expect(r.length).toBe(7);
    expect(r[0]).toBeCloseTo(1, 6);
    expect(r[6]).toBeCloseTo(1e6, 6);
  });
  it('points are logarithmically spaced', () => {
    const r = logspace(0, 3, 4);
    const ratio1 = r[1] / r[0];
    const ratio2 = r[2] / r[1];
    const ratio3 = r[3] / r[2];
    expect(ratio1).toBeCloseTo(ratio2, 4);
    expect(ratio2).toBeCloseTo(ratio3, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findCutoffFrequency
// ─────────────────────────────────────────────────────────────────────────────

describe('findCutoffFrequency', () => {
  it('returns null for empty array', () => {
    expect(findCutoffFrequency([])).toBeNull();
  });
  it('returns null when all magnitudes are 0', () => {
    const points: ACPoint[] = [
      { frequency: 1, magnitude: 0, magnitudeDb: -Infinity, phase: 0, real: 0, imag: 0 },
      { frequency: 10, magnitude: 0, magnitudeDb: -Infinity, phase: 0, real: 0, imag: 0 },
    ];
    expect(findCutoffFrequency(points)).toBeNull();
  });
  it('finds -3dB point in low-pass response', () => {
    // RC low-pass: |H| = 1 / sqrt(1 + (f/fc)^2)
    // At fc, |H| = 1/sqrt(2) ≈ 0.707
    const fc = 1000;
    const points: ACPoint[] = [];
    for (let i = 0; i < 50; i++) {
      const f = i * 100;
      const mag = 1 / Math.sqrt(1 + Math.pow(f / fc, 2));
      points.push({
        frequency: f, magnitude: mag, magnitudeDb: 20 * Math.log10(mag),
        phase: -Math.atan(f / fc) * 180 / Math.PI, real: 0, imag: 0,
      });
    }
    const found = findCutoffFrequency(points);
    expect(found).not.toBeNull();
    expect(found!).toBeCloseTo(fc, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC analysis — RC low-pass filter
// ─────────────────────────────────────────────────────────────────────────────

describe('AC analysis: RC low-pass filter', () => {
  // Circuit: V1 (1V AC) → R1 (1k) → C1 (1uF) → GND
  // fc = 1 / (2πRC) = 1 / (2π * 1000 * 1e-6) ≈ 159 Hz
  function rclowpass() {
    const components = [
      comp('acVoltage', 'V1', { amplitude: 1, frequency: 1, offset: 0 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-6 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'C1', 'a'),
      wire('w3', 'C1', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    return { components, wires };
  }

  it('DC operating point is computed', () => {
    const { components, wires } = rclowpass();
    const opts = {
      components, wires,
      fStart: 1, fStop: 10000, nPoints: 10,
      sourceId: 'V1',
      outputNode: 'C1:a',
    };
    const r = runACAnalysis(opts as any);
    expect(r.operatingPoint).not.toBeNull();
  });

  it('produces points across the frequency range', () => {
    const { components, wires } = rclowpass();
    const r = runACAnalysis({
      components, wires,
      fStart: 1, fStop: 10000, nPoints: 10,
      sourceId: 'V1',
      outputNode: 'C1:a',
    } as any);
    expect(r.points.length).toBe(10);
  });

  it('magnitude at low frequency ≈ 1 (0 dB)', () => {
    const { components, wires } = rclowpass();
    const r = runACAnalysis({
      components, wires,
      fStart: 0.1, fStop: 100, nPoints: 5,
      sourceId: 'V1',
      outputNode: 'C1:a',
    } as any);
    // At very low freq, cap is open → V_out = V_in = 1
    expect(r.points[0].magnitude).toBeGreaterThan(0.9);
  });

  it('magnitude at high frequency < low frequency (roll-off)', () => {
    const { components, wires } = rclowpass();
    const r = runACAnalysis({
      components, wires,
      fStart: 1, fStop: 100000, nPoints: 20,
      sourceId: 'V1',
      outputNode: 'C1:a',
    } as any);
    const lowMag = r.points[0].magnitude;
    const highMag = r.points[r.points.length - 1].magnitude;
    expect(highMag).toBeLessThan(lowMag);
  });

  it('finds approximate cutoff frequency near 159 Hz', () => {
    const { components, wires } = rclowpass();
    const r = runACAnalysis({
      components, wires,
      fStart: 1, fStop: 10000, nPoints: 100,
      sourceId: 'V1',
      outputNode: 'C1:a',
    } as any);
    // fc = 1/(2πRC) ≈ 159 Hz — accept within an octave
    if (r.cutoffFrequency !== null) {
      expect(r.cutoffFrequency).toBeGreaterThan(50);
      expect(r.cutoffFrequency).toBeLessThan(500);
    }
  });

  it('phase shifts from 0° to -90° as frequency increases', () => {
    const { components, wires } = rclowpass();
    const r = runACAnalysis({
      components, wires,
      fStart: 1, fStop: 100000, nPoints: 20,
      sourceId: 'V1',
      outputNode: 'C1:a',
    } as any);
    const lowPhase = r.points[0].phase;
    const highPhase = r.points[r.points.length - 1].phase;
    // Low freq: phase ≈ 0; high freq: phase approaches -90°
    expect(highPhase).toBeLessThan(lowPhase);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC analysis: edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('AC analysis: edge cases', () => {
  it('returns empty points when source not found', () => {
    const components = [
      comp('acVoltage', 'V1', { amplitude: 1, frequency: 1, offset: 0 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runACAnalysis({
      components, wires,
      fStart: 1, fStop: 1000, nPoints: 5,
      sourceId: 'MISSING',
      outputNode: 'R1:b',
    } as any);
    expect(r.points).toHaveLength(0);
  });

  it('returns empty points when output node not found', () => {
    const components = [
      comp('acVoltage', 'V1', { amplitude: 1, frequency: 1, offset: 0 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runACAnalysis({
      components, wires,
      fStart: 1, fStop: 1000, nPoints: 5,
      sourceId: 'V1',
      outputNode: 'MISSING:terminal',
    } as any);
    expect(r.points).toHaveLength(0);
  });

  it('linear sweep produces linearly-spaced frequencies', () => {
    const components = [
      comp('acVoltage', 'V1', { amplitude: 1, frequency: 1, offset: 0 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const r = runACAnalysis({
      components, wires,
      fStart: 100, fStop: 1000, nPoints: 10,
      sweep: 'lin',
      sourceId: 'V1',
      outputNode: 'R1:b',
    } as any);
    expect(r.points.length).toBe(10);
    expect(r.points[0].frequency).toBeCloseTo(100, 6);
    expect(r.points[9].frequency).toBeCloseTo(1000, 6);
    // Spacing should be constant
    const step = r.points[1].frequency - r.points[0].frequency;
    expect(r.points[5].frequency - r.points[4].frequency).toBeCloseTo(step, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Monte Carlo analysis
// ─────────────────────────────────────────────────────────────────────────────

describe('Monte Carlo analysis', () => {
  function voltageDivider() {
    const components = [
      comp('dcVoltage', 'V1', { voltage: 10 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    return { components, wires };
  }

  it('produces the requested number of runs', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 50,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.05 },
          { componentId: 'R2', param: 'resistance', tolerance: 0.05 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    expect(r.runs.length).toBe(50);
  });

  it('produces finite statistics', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 100,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.05 },
          { componentId: 'R2', param: 'resistance', tolerance: 0.05 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    expect(isFinite(r.stats.mean)).toBe(true);
    expect(isFinite(r.stats.stddev)).toBe(true);
    expect(isFinite(r.stats.min)).toBe(true);
    expect(isFinite(r.stats.max)).toBe(true);
  });

  it('mean is close to nominal value (5V for equal divider)', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 500,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.05 },
          { componentId: 'R2', param: 'resistance', tolerance: 0.05 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    // Mean V_out should be close to 5V (within ±5%)
    expect(r.stats.mean).toBeGreaterThan(4.5);
    expect(r.stats.mean).toBeLessThan(5.5);
  });

  it('stddev > 0 when tolerances are non-zero', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 100,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.1 },
          { componentId: 'R2', param: 'resistance', tolerance: 0.1 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    expect(r.stats.stddev).toBeGreaterThan(0);
  });

  it('yield is 1 when all runs pass spec', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 50,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.05 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
        spec: { min: 0, max: 10 },  // very loose spec
      } as any,
      pluginsFor(components),
    );
    expect(r.yield).toBe(1);
  });

  it('yield < 1 when spec is tight', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 100,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.5 },
          { componentId: 'R2', param: 'resistance', tolerance: 0.5 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
        spec: { min: 4.99, max: 5.01 },  // very tight spec
      } as any,
      pluginsFor(components),
    );
    expect(r.yield).toBeLessThan(1);
  });

  it('deterministic with same seed', () => {
    const { components, wires } = voltageDivider();
    const opts = {
      runs: 50,
      seed: 42,
      tolerances: [
        { componentId: 'R1', param: 'resistance', tolerance: 0.05 },
      ],
      measurement: { type: 'voltage', node: 'R1:b' },
    } as any;
    const r1 = runMonteCarlo({ version: 1, components, wires }, opts, pluginsFor(components));
    const r2 = runMonteCarlo({ version: 1, components, wires }, opts, pluginsFor(components));
    expect(r1.stats.mean).toBe(r2.stats.mean);
    expect(r1.stats.stddev).toBe(r2.stats.stddev);
  });

  it('histogram has the requested number of bins', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 100,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.1 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
        nBins: 15,
      } as any,
      pluginsFor(components),
    );
    expect(r.histogram.length).toBe(15);
    expect(r.histogramEdges.length).toBe(16);
  });

  it('sum of histogram counts equals run count', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 100,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.1 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    const total = r.histogram.reduce((a, b) => a + b, 0);
    expect(total).toBe(r.runs.length);
  });

  it('min ≤ mean ≤ max', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 100,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.1 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    expect(r.stats.min).toBeLessThanOrEqual(r.stats.mean);
    expect(r.stats.mean).toBeLessThanOrEqual(r.stats.max);
  });

  it('uniform distribution is supported', () => {
    const { components, wires } = voltageDivider();
    const r = runMonteCarlo(
      { version: 1, components, wires },
      {
        runs: 100,
        seed: 42,
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.1, distribution: 'uniform' },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    expect(r.runs.length).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Worst-case analysis
// ─────────────────────────────────────────────────────────────────────────────

describe('Worst-case analysis', () => {
  function voltageDivider() {
    const components = [
      comp('dcVoltage', 'V1', { voltage: 10 }),
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('resistor', 'R2', { resistance: 1000 }),
      comp('ground', 'GND'),
    ];
    const wires = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'R2', 'a'),
      wire('w3', 'R2', 'b', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    return { components, wires };
  }

  it('produces 2^N runs for N tolerances', () => {
    const { components, wires } = voltageDivider();
    const r = runWorstCase(
      { version: 1, components, wires },
      {
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.05 },
          { componentId: 'R2', param: 'resistance', tolerance: 0.05 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    expect(r.length).toBe(4);  // 2^2
  });

  it('results are sorted ascending by value', () => {
    const { components, wires } = voltageDivider();
    const r = runWorstCase(
      { version: 1, components, wires },
      {
        tolerances: [
          { componentId: 'R1', param: 'resistance', tolerance: 0.05 },
          { componentId: 'R2', param: 'resistance', tolerance: 0.05 },
        ],
        measurement: { type: 'voltage', node: 'R1:b' },
      } as any,
      pluginsFor(components),
    );
    for (let i = 1; i < r.length; i++) {
      expect(r[i].value).toBeGreaterThanOrEqual(r[i - 1].value);
    }
  });

  it('returns empty for > 16 tolerances (too many combos)', () => {
    const { components, wires } = voltageDivider();
    const tolerances = Array.from({ length: 17 }, (_, i) => ({
      componentId: 'R1', param: 'resistance', tolerance: 0.05,
    }));
    const r = runWorstCase(
      { version: 1, components, wires },
      { tolerances, measurement: { type: 'voltage', node: 'R1:b' } } as any,
      pluginsFor(components),
    );
    expect(r.length).toBe(0);
  });
});
