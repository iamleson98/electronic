// Tests for computeFFT and complex-trace helpers in measurement.ts.
// These were the only untested exports from measurement.ts.

import { describe, it, expect } from 'vitest';
import { computeFFT, complexToMagnitude, complexToPhase, complexToDb, xyMode, type RealTrace, type ComplexTrace } from '../src/lib/circuit/measurement';

function mkTrace(ys: number[], xs?: number[]): RealTrace {
  const x = xs ?? ys.map((_, i) => i);
  return {
    name: 't', xValues: Float64Array.from(x), yValues: Float64Array.from(ys),
    xLabel: 's', yLabel: 'V',
  };
}

function mkComplexTrace(yComplex: number[], xs: number[]): ComplexTrace {
  // yComplex is interleaved [re0, im0, re1, im1, ...]
  return {
    name: 'H', xValues: Float64Array.from(xs),
    yValues: Float64Array.from(yComplex),
    xLabel: 'Hz', yLabel: 'V',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeFFT
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFFT', () => {
  it('returns empty trace for empty input', () => {
    const r = computeFFT(mkTrace([]));
    expect(r.xValues.length).toBe(0);
    expect(r.yValues.length).toBe(0);
  });

  it('returns empty trace for single sample', () => {
    const r = computeFFT(mkTrace([5]));
    expect(r.xValues.length).toBe(0);
  });

  it('DC signal: peak at frequency 0', () => {
    // All samples = 1 → DC component at bin 0
    const ys = new Array(64).fill(1);
    const r = computeFFT(mkTrace(ys, ys.map((_, i) => i * 1e-4)));
    // Bin 0 should have the highest magnitude (DC)
    let maxIdx = 0, maxVal = 0;
    for (let i = 0; i < r.yValues.length; i++) {
      if (r.yValues[i] > maxVal) { maxVal = r.yValues[i]; maxIdx = i; }
    }
    expect(maxIdx).toBe(0);
  });

  it('sine wave: peak at the signal frequency', () => {
    // 1kHz sine sampled at 10kHz → 100 samples → 1 cycle per 10 samples
    // FFT bin for 1kHz should be near 1/10 of Nyquist
    const N = 100;
    const dt = 1e-4;  // 10 kHz sample rate
    const f = 1000;   // 1 kHz signal
    const ys: number[] = [];
    for (let i = 0; i < N; i++) ys.push(Math.sin(2 * Math.PI * f * i * dt));
    const r = computeFFT(mkTrace(ys, ys.map((_, i) => i * dt)));
    // Find peak bin
    let maxIdx = 0, maxVal = 0;
    for (let i = 1; i < r.yValues.length; i++) {  // skip DC bin
      if (r.yValues[i] > maxVal) { maxVal = r.yValues[i]; maxIdx = i; }
    }
    // Expected frequency at the peak bin
    const peakFreq = r.xValues[maxIdx];
    // Should be near 1kHz (within ±100Hz tolerance due to bin resolution)
    expect(Math.abs(peakFreq - 1000)).toBeLessThan(200);
  });

  it('two-tone signal: produces two peaks', () => {
    // 1kHz + 3kHz
    const N = 200;
    const dt = 1e-4;
    const ys: number[] = [];
    for (let i = 0; i < N; i++) {
      ys.push(Math.sin(2 * Math.PI * 1000 * i * dt) + Math.sin(2 * Math.PI * 3000 * i * dt));
    }
    const r = computeFFT(mkTrace(ys, ys.map((_, i) => i * dt)));
    expect(r.yValues.length).toBeGreaterThan(0);
    // Check that there are at least 2 prominent peaks
    const mean = r.yValues.reduce((a, b) => a + b, 0) / r.yValues.length;
    const peaks = Array.from(r.yValues).filter(v => v > mean * 3).length;
    expect(peaks).toBeGreaterThanOrEqual(2);
  });

  it('output has xValues that are frequencies', () => {
    const ys = new Array(64).fill(1).map((_, i) => Math.sin(i * 0.1));
    const r = computeFFT(mkTrace(ys, ys.map((_, i) => i * 1e-3)));
    // First frequency should be 0, second should be > 0
    expect(r.xValues[0]).toBe(0);
    expect(r.xValues[1]).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complexToMagnitude / Phase / dB
// ─────────────────────────────────────────────────────────────────────────────

describe('complexToMagnitude', () => {
  it('returns a real-valued trace', () => {
    const ct = mkComplexTrace([3, 4, 0, 0], [1, 2]);
    const r = complexToMagnitude(ct);
    expect(r.yValues[0]).toBeCloseTo(5, 6);  // |3+4i| = 5
    expect(r.yValues[1]).toBeCloseTo(0, 6);
  });
  it('preserves xValues', () => {
    const ct = mkComplexTrace([1, 0, 1, 0], [10, 20]);
    const r = complexToMagnitude(ct);
    expect(r.xValues[0]).toBe(10);
    expect(r.xValues[1]).toBe(20);
  });
});

describe('complexToPhase', () => {
  it('returns phase in degrees', () => {
    const ct = mkComplexTrace([1, 1, 1, -1, -1, 0], [1, 2, 3]);
    const r = complexToPhase(ct);
    expect(r.yValues[0]).toBeCloseTo(45, 4);  // 1+i → 45°
    expect(r.yValues[1]).toBeCloseTo(-45, 4);  // 1-i → -45°
    expect(r.yValues[2]).toBeCloseTo(180, 4);  // -1+0i → 180°
  });
});

describe('complexToDb', () => {
  it('20*log10(|y|) for complex trace', () => {
    const ct = mkComplexTrace([10, 0, 100, 0], [1, 2]);
    const r = complexToDb(ct);
    expect(r.yValues[0]).toBeCloseTo(20, 4);
    expect(r.yValues[1]).toBeCloseTo(40, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// xyMode
// ─────────────────────────────────────────────────────────────────────────────

describe('xyMode', () => {
  it('returns x,y arrays of equal length', () => {
    const a = mkTrace([1, 2, 3, 4]);
    const b = mkTrace([10, 20, 30, 40]);
    const r = xyMode(a, b);
    expect(r.x.length).toBe(r.y.length);
    expect(r.x.length).toBe(4);
  });
  it('x comes from first trace, y from second', () => {
    const a = mkTrace([1, 2, 3]);
    const b = mkTrace([10, 20, 30]);
    const r = xyMode(a, b);
    expect(r.x[0]).toBe(1);
    expect(r.y[0]).toBe(10);
  });
  it('handles traces of different lengths (takes min)', () => {
    const a = mkTrace([1, 2, 3, 4, 5]);
    const b = mkTrace([10, 20]);
    const r = xyMode(a, b);
    expect(r.x.length).toBe(2);
    expect(r.y.length).toBe(2);
  });
});
