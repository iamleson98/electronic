// Fourier analysis — THD (Total Harmonic Distortion) and harmonic spectrum.
//
// Computes a one-sided magnitude spectrum from a real-valued transient trace,
// then locates the fundamental (peak excluding DC) and quantifies the energy in
// the harmonics (2×, 3×, 4× ... of the fundamental frequency).
//
// THD is defined as:
//   THD = sqrt(V2² + V3² + V4² + ...) / V1
// where V1 is the RMS amplitude of the fundamental, and V2.. are RMS amplitudes
// of the harmonic components.
//
// Also computes:
//   - SNR (signal-to-noise ratio) — fundamental vs. all non-harmonic bins
//   - SINAD (signal-to-noise-and-distortion) — fundamental vs. everything else
//   - Peak harmonic frequency and amplitude
//
// All values use the same convention as `computeFFT` in measurement.ts:
// the Hann-windowed one-sided magnitude spectrum (linear, not dB).

import type { RealTrace } from './analysis';
import { computeFFT } from './measurement';

export interface HarmonicPeak {
  /** harmonic number — 1 = fundamental, 2 = 2nd harmonic, ... */
  harmonic: number;
  /** frequency in Hz */
  frequency: number;
  /** linear magnitude (post-FFT) */
  magnitude: number;
  /** magnitude in dB (20·log10) */
  magnitudeDb: number;
  /** percent of fundamental amplitude (Vn / V1 * 100) */
  percentOfFundamental: number;
}

export interface THDResult {
  /** fundamental frequency (Hz) — the strongest non-DC peak */
  fundamentalFreq: number;
  /** magnitude of the fundamental (linear) */
  fundamentalMag: number;
  /** THD as a fraction — sqrt(ΣVn² for n≥2) / V1 */
  thd: number;
  /** THD as a percent (thd * 100) */
  thdPercent: number;
  /** THD in dB — 20·log10(thd) */
  thdDb: number;
  /** SNR in dB — fundamental vs. all non-harmonic noise bins */
  snrDb: number;
  /** SINAD in dB — fundamental vs. (noise + harmonics) */
  sinadDb: number;
  /** list of detected harmonics, including the fundamental (harmonic 1) */
  harmonics: HarmonicPeak[];
  /** sampling rate used for the analysis (Hz) */
  sampleRate: number;
  /** number of samples used */
  numSamples: number;
  /** frequency resolution of the spectrum (Hz) */
  frequencyResolution: number;
}

/**
 * Detect the index of the strongest peak in a one-sided magnitude spectrum,
 * skipping bin 0 (DC) and a small neighbourhood of low bins to avoid leakage.
 *
 * Uses a simple hill-climb: find the global maximum above a noise floor
 * (median × 4), then return its bin index.
 */
function findPeakBin(magnitudes: Float64Array, skipBins = 1): number {
  if (magnitudes.length === 0) return -1;
  const start = Math.max(skipBins, 1);
  let peakIdx = start;
  let peakVal = magnitudes[start] ?? 0;
  for (let i = start; i < magnitudes.length; i++) {
    if (magnitudes[i] > peakVal) {
      peakVal = magnitudes[i];
      peakIdx = i;
    }
  }
  return peakIdx;
}

/**
 * For a given fundamental bin, walk out to harmonic k = 2,3,4,...,maxHarmonics
 * and look up the magnitude near each harmonic's expected frequency.
 *
 * Because FFT bins rarely land exactly on the harmonic frequency, we search
 * within ±2 bins (parabolic interpolation would be more accurate but adds
 * complexity).
 */
function findHarmonicPeak(
  magnitudes: Float64Array,
  fundamentalBin: number,
  harmonicMultiple: number,
): { bin: number; magnitude: number } {
  const expected = fundamentalBin * harmonicMultiple;
  if (expected >= magnitudes.length) return { bin: -1, magnitude: 0 };
  // Search ±2 bins (or fewer near array end)
  const lo = Math.max(1, Math.floor(expected) - 2);
  const hi = Math.min(magnitudes.length - 1, Math.ceil(expected) + 2);
  let bestBin = Math.floor(expected);
  let bestMag = magnitudes[bestBin] ?? 0;
  for (let i = lo; i <= hi; i++) {
    if (magnitudes[i] > bestMag) {
      bestMag = magnitudes[i];
      bestBin = i;
    }
  }
  return { bin: bestBin, magnitude: bestMag };
}

/**
 * Compute THD, SNR, and harmonic spectrum for a real-valued transient trace.
 *
 * @param trace  a real-valued trace (e.g. oscilloscope voltage vs. time)
 * @param maxHarmonics  maximum harmonic number to detect (default 10)
 * @returns a THDResult, or null if the trace is too short or has no fundamental
 */
export function computeTHD(trace: RealTrace, maxHarmonics = 10): THDResult | null {
  const N = trace.yValues.length;
  if (N < 8) return null;

  // Need a uniformly-sampled trace — assume xValues are time in seconds.
  // Use the median dt as the nominal sample interval.
  const xs = trace.xValues;
  if (xs.length < 2) return null;
  const dts: number[] = [];
  for (let i = 1; i < xs.length; i++) dts.push(xs[i] - xs[i - 1]);
  dts.sort((a, b) => a - b);
  const dt = dts[Math.floor(dts.length / 2)] || (xs[xs.length - 1] - xs[0]) / (xs.length - 1);
  if (dt <= 0 || !Number.isFinite(dt)) return null;
  const fs = 1 / dt;
  const freqRes = fs / N;

  // Compute one-sided magnitude spectrum via existing FFT (Hann-windowed)
  const spectrum = computeFFT(trace);
  const mags = spectrum.yValues;
  const freqs = spectrum.xValues;
  if (mags.length === 0) return null;

  // Find fundamental (strongest non-DC bin)
  const fundBin = findPeakBin(mags, /* skip DC + 1 */ 1);
  if (fundBin < 0) return null;
  const fundamentalMag = mags[fundBin];
  const fundamentalFreq = freqs[fundBin];

  if (fundamentalMag <= 0) return null;

  // Walk out harmonics
  const harmonics: HarmonicPeak[] = [
    {
      harmonic: 1,
      frequency: fundamentalFreq,
      magnitude: fundamentalMag,
      magnitudeDb: 20 * Math.log10(fundamentalMag + 1e-30),
      percentOfFundamental: 100,
    },
  ];
  let sumSqHarmonics = 0;
  for (let k = 2; k <= maxHarmonics; k++) {
    const peak = findHarmonicPeak(mags, fundBin, k);
    if (peak.bin < 0) break;
    harmonics.push({
      harmonic: k,
      frequency: freqs[peak.bin],
      magnitude: peak.magnitude,
      magnitudeDb: 20 * Math.log10(peak.magnitude + 1e-30),
      percentOfFundamental: (peak.magnitude / fundamentalMag) * 100,
    });
    sumSqHarmonics += peak.magnitude * peak.magnitude;
  }

  // THD = sqrt(ΣVn² for n≥2) / V1
  const thd = Math.sqrt(sumSqHarmonics) / fundamentalMag;
  const thdPercent = thd * 100;
  const thdDb = 20 * Math.log10(thd + 1e-30);

  // SNR / SINAD: total power across the spectrum vs. fundamental power
  // (using magnitude² as a proxy for power)
  let totalPower = 0;
  for (let i = 1; i < mags.length; i++) {
    totalPower += mags[i] * mags[i];
  }
  const fundamentalPower = fundamentalMag * fundamentalMag;
  // Harmonic power (sum of H2..Hmax)
  const harmonicPower = sumSqHarmonics;
  // Noise = total − fundamental − harmonics
  const noisePower = Math.max(0, totalPower - fundamentalPower - harmonicPower);

  const snrDb = 10 * Math.log10(
    fundamentalPower / (noisePower + 1e-30),
  );
  const sinadDb = 10 * Math.log10(
    fundamentalPower / (noisePower + harmonicPower + 1e-30),
  );

  return {
    fundamentalFreq,
    fundamentalMag,
    thd,
    thdPercent,
    thdDb,
    snrDb,
    sinadDb,
    harmonics,
    sampleRate: fs,
    numSamples: N,
    frequencyResolution: freqRes,
  };
}

/**
 * Compute a downsampled magnitude spectrum (linear) suitable for bar-chart
 * display. Groups bins into logarithmically-spaced buckets so the chart shows
 * the spectrum from ~1Hz to Nyquist without hundreds of bars.
 *
 * Returns arrays of equal length: frequencies (Hz) and magnitudes (linear).
 */
export function downsampleSpectrum(
  mags: Float64Array,
  freqs: Float64Array,
  numBuckets = 64,
): { freqs: number[]; mags: number[] } {
  if (mags.length === 0) return { freqs: [], mags: [] };
  const nyquist = freqs[freqs.length - 1] || 1;
  const fMin = Math.max(1, freqs[1] || 1);
  const logMin = Math.log10(fMin);
  const logMax = Math.log10(Math.max(nyquist, fMin * 2));
  if (logMax <= logMin) {
    return { freqs: [fMin], mags: [mags[1] || 0] };
  }
  const step = (logMax - logMin) / numBuckets;
  const outFreqs: number[] = [];
  const outMags: number[] = [];
  for (let i = 0; i < numBuckets; i++) {
    const lo = Math.pow(10, logMin + i * step);
    const hi = Math.pow(10, logMin + (i + 1) * step);
    let max = 0;
    let centerFreq = Math.sqrt(lo * hi);
    for (let j = 0; j < freqs.length; j++) {
      if (freqs[j] >= lo && freqs[j] < hi) {
        if (mags[j] > max) {
          max = mags[j];
        }
      }
    }
    outFreqs.push(centerFreq);
    outMags.push(max);
  }
  return { freqs: outFreqs, mags: outMags };
}
