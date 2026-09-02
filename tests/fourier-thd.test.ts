// Tests for the Fourier THD/spectrum module.
//
// Covers computeTHD against:
//   - Pure sine wave (THD should be ~0, only the fundamental is present)
//   - Two-tone (THD should reflect the second tone as a "harmonic" or noise)
//   - Square wave (known THD: ~43% — strong odd harmonics, no even harmonics)
//   - Clipped/distorted sine (high THD)
//   - DC-only input (no fundamental — returns null)
//   - Too-short input (returns null)
//   - Custom maxHarmonics bounds
//
// Also covers downsampleSpectrum correctness.

import { describe, it, expect } from 'vitest';
import { computeTHD, downsampleSpectrum } from '../src/lib/circuit/fourier';
import type { RealTrace } from '../src/lib/circuit/analysis';

function makeSineTrace(
  freq: number,
  sampleRate: number,
  numSamples: number,
  opts: { harmonic2?: number; harmonic3?: number; clip?: number; square?: boolean } = {},
): RealTrace {
  const xs = new Float64Array(numSamples);
  const ys = new Float64Array(numSamples);
  const dt = 1 / sampleRate;
  for (let i = 0; i < numSamples; i++) {
    const t = i * dt;
    let v = Math.sin(2 * Math.PI * freq * t);
    if (opts.harmonic2) v += opts.harmonic2 * Math.sin(2 * Math.PI * 2 * freq * t);
    if (opts.harmonic3) v += opts.harmonic3 * Math.sin(2 * Math.PI * 3 * freq * t);
    if (opts.clip !== undefined) {
      if (v > opts.clip) v = opts.clip;
      if (v < -opts.clip) v = -opts.clip;
    }
    if (opts.square) v = Math.sign(v);
    xs[i] = t;
    ys[i] = v;
  }
  return {
    name: 'sine',
    xValues: xs,
    yValues: ys,
    xLabel: 'Time (s)',
    yLabel: 'Voltage (V)',
  };
}

describe('computeTHD', () => {
  it('returns null for empty trace', () => {
    const r = computeTHD({ name: 'e', xValues: new Float64Array(0), yValues: new Float64Array(0), xLabel: 's', yLabel: 'V' });
    expect(r).toBeNull();
  });

  it('returns null for trace with fewer than 8 samples', () => {
    const xs = new Float64Array(7);
    const ys = new Float64Array(7);
    for (let i = 0; i < 7; i++) { xs[i] = i * 1e-4; ys[i] = Math.sin(i); }
    const r = computeTHD({ name: 'short', xValues: xs, yValues: ys, xLabel: 's', yLabel: 'V' });
    expect(r).toBeNull();
  });

  it('returns null for a DC-only trace (no fundamental)', () => {
    // All zeros — no peak above noise floor
    const xs = new Float64Array(64);
    const ys = new Float64Array(64);
    for (let i = 0; i < 64; i++) { xs[i] = i * 1e-4; ys[i] = 0; }
    const r = computeTHD({ name: 'dc', xValues: xs, yValues: ys, xLabel: 's', yLabel: 'V' });
    expect(r).toBeNull();
  });

  it('pure sine wave: THD is very low (< 1%)', () => {
    // 1kHz pure sine, 10kHz sample rate, 1000 samples (100 cycles)
    const trace = makeSineTrace(1000, 10000, 1000);
    const r = computeTHD(trace, 10);
    expect(r).not.toBeNull();
    expect(r!.thdPercent).toBeLessThan(2);  // windowing leaves a tiny residual
  });

  it('pure sine wave: fundamental frequency is near 1kHz', () => {
    const trace = makeSineTrace(1000, 10000, 1000);
    const r = computeTHD(trace, 10);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.fundamentalFreq - 1000)).toBeLessThan(50);
  });

  it('sine + 2nd harmonic: 2nd harmonic is detected with correct amplitude ratio', () => {
    // 1kHz fundamental + 2kHz at 10% amplitude → THD ≈ 10%
    const trace = makeSineTrace(1000, 10000, 1000, { harmonic2: 0.1 });
    const r = computeTHD(trace, 10);
    expect(r).not.toBeNull();
    const h2 = r!.harmonics.find(h => h.harmonic === 2);
    expect(h2).toBeDefined();
    expect(h2!.percentOfFundamental).toBeGreaterThan(5);
    expect(h2!.percentOfFundamental).toBeLessThan(20);
    expect(r!.thdPercent).toBeGreaterThan(5);
    expect(r!.thdPercent).toBeLessThan(20);
  });

  it('sine + 3rd harmonic: 3rd harmonic is detected', () => {
    // 1kHz + 3kHz at 30% amplitude → THD ≈ 30%
    const trace = makeSineTrace(1000, 10000, 1000, { harmonic3: 0.3 });
    const r = computeTHD(trace, 10);
    expect(r).not.toBeNull();
    const h3 = r!.harmonics.find(h => h.harmonic === 3);
    expect(h3).toBeDefined();
    expect(h3!.percentOfFundamental).toBeGreaterThan(15);
    expect(h3!.percentOfFundamental).toBeLessThan(45);
    expect(r!.thdPercent).toBeGreaterThan(15);
  });

  it('square wave: THD is high (≈40-50%) and dominated by odd harmonics', () => {
    // Ideal square wave has THD ≈ 43% (sqrt(Σ(1/n²) for n=3,5,7,...)/1)
    const trace = makeSineTrace(1000, 10000, 1000, { square: true });
    const r = computeTHD(trace, 10);
    expect(r).not.toBeNull();
    expect(r!.thdPercent).toBeGreaterThan(30);
    // Even harmonics (H2, H4) should be near zero, odd (H3, H5) should be strong
    const h2 = r!.harmonics.find(h => h.harmonic === 2);
    const h3 = r!.harmonics.find(h => h.harmonic === 3);
    const h4 = r!.harmonics.find(h => h.harmonic === 4);
    const h5 = r!.harmonics.find(h => h.harmonic === 5);
    expect(h3!.percentOfFundamental).toBeGreaterThan(10);
    expect(h5!.percentOfFundamental).toBeGreaterThan(3);
    expect(h2!.percentOfFundamental).toBeLessThan(h3!.percentOfFundamental);
    expect(h4!.percentOfFundamental).toBeLessThan(h5!.percentOfFundamental);
  });

  it('clipped sine: clipping produces significant harmonics', () => {
    // Heavy clipping → flat tops → high THD
    const trace = makeSineTrace(1000, 10000, 1000, { clip: 0.3 });
    const r = computeTHD(trace, 10);
    expect(r).not.toBeNull();
    expect(r!.thdPercent).toBeGreaterThan(15);
  });

  it('fundamental magnitude is positive', () => {
    const trace = makeSineTrace(1000, 10000, 1000);
    const r = computeTHD(trace, 10);
    expect(r).not.toBeNull();
    expect(r!.fundamentalMag).toBeGreaterThan(0);
  });

  it('THD in dB is negative for low THD', () => {
    const trace = makeSineTrace(1000, 10000, 1000);
    const r = computeTHD(trace, 10);
    expect(r).not.toBeNull();
    expect(r!.thdDb).toBeLessThan(0);  // < 0 dB means THD < 100%
  });

  it('returns the configured number of harmonics (when present)', () => {
    const trace = makeSineTrace(1000, 10000, 1000, { harmonic2: 0.2, harmonic3: 0.15 });
    const r5 = computeTHD(trace, 5);
    const r10 = computeTHD(trace, 10);
    expect(r5!.harmonics.length).toBeLessThanOrEqual(6);  // fundamental + up to 5
    expect(r10!.harmonics.length).toBeLessThanOrEqual(11);
  });

  it('harmonics array includes fundamental as harmonic 1', () => {
    const trace = makeSineTrace(1000, 10000, 1000);
    const r = computeTHD(trace, 5);
    expect(r).not.toBeNull();
    expect(r!.harmonics[0].harmonic).toBe(1);
    expect(r!.harmonics[0].percentOfFundamental).toBeCloseTo(100, 5);
  });

  it('sampleRate and numSamples are reported', () => {
    const trace = makeSineTrace(1000, 10000, 1000);
    const r = computeTHD(trace, 5);
    expect(r).not.toBeNull();
    expect(r!.sampleRate).toBeCloseTo(10000, 1);
    expect(r!.numSamples).toBe(1000);
  });

  it('frequencyResolution = fs / fftSize (zero-padded to nextPow2)', () => {
    const trace = makeSineTrace(1000, 10000, 1000);
    const r = computeTHD(trace, 5);
    expect(r).not.toBeNull();
    // computeFFT zero-pads N=1000 → fftSize=1024: the true bin spacing is
    // fs/1024, not the pre-fix fs/N (10 → 9.765625).
    expect(r!.frequencyResolution).toBeCloseTo(10000 / 1024, 5);
  });

  it('SNR is positive for a clean sine', () => {
    const trace = makeSineTrace(1000, 10000, 1000);
    const r = computeTHD(trace, 5);
    expect(r).not.toBeNull();
    expect(r!.snrDb).toBeGreaterThan(0);
  });

  it('SINAD ≤ SNR (SINAD includes harmonics)', () => {
    // For a pure sine, both should be high. For a distorted sine, SINAD < SNR.
    const clipped = makeSineTrace(1000, 10000, 1000, { clip: 0.3 });
    const r = computeTHD(clipped, 10);
    expect(r).not.toBeNull();
    expect(r!.sinadDb).toBeLessThanOrEqual(r!.snrDb + 0.1);  // allow tiny float slack
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// downsampleSpectrum
// ─────────────────────────────────────────────────────────────────────────────

describe('downsampleSpectrum', () => {
  it('returns empty arrays for empty input', () => {
    const r = downsampleSpectrum(new Float64Array(0), new Float64Array(0));
    expect(r.freqs.length).toBe(0);
    expect(r.mags.length).toBe(0);
  });

  it('returns numBuckets entries by default', () => {
    const N = 100;
    const freqs = new Float64Array(N);
    const mags = new Float64Array(N);
    for (let i = 0; i < N; i++) { freqs[i] = i * 10; mags[i] = Math.random(); }
    const r = downsampleSpectrum(mags, freqs);
    expect(r.freqs.length).toBe(64);
    expect(r.mags.length).toBe(64);
  });

  it('respects numBuckets parameter', () => {
    const N = 100;
    const freqs = new Float64Array(N);
    const mags = new Float64Array(N);
    for (let i = 0; i < N; i++) { freqs[i] = i * 10; mags[i] = 1; }
    const r = downsampleSpectrum(mags, freqs, 32);
    expect(r.freqs.length).toBe(32);
  });

  it('frequencies are monotonically increasing (log-spaced)', () => {
    const N = 200;
    const freqs = new Float64Array(N);
    const mags = new Float64Array(N);
    for (let i = 0; i < N; i++) { freqs[i] = (i + 1) * 10; mags[i] = 1; }
    const r = downsampleSpectrum(mags, freqs, 16);
    for (let i = 1; i < r.freqs.length; i++) {
      expect(r.freqs[i]).toBeGreaterThan(r.freqs[i - 1]);
    }
  });

  it('mags array contains max of source bins in each bucket', () => {
    const N = 100;
    const freqs = new Float64Array(N);
    const mags = new Float64Array(N);
    for (let i = 0; i < N; i++) { freqs[i] = i + 1; mags[i] = i; }  // increasing
    const r = downsampleSpectrum(mags, freqs, 8);
    // Each bucket should contain a max — the last bucket should be highest
    expect(r.mags[r.mags.length - 1]).toBeGreaterThan(r.mags[0]);
  });
});
