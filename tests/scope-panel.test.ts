import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ProbePanel } from '../src/components/circuit/ProbePanel';
import {
  applyCoupling, computeCursorDeltas, computeMeasurements, computeTimeWindow, computeVoltageWindow,
  createDefaultScopeConfig, formatDuration, formatFrequency, formatTimebase, formatVoltage,
  formatVoltageScale, getVoltageAtTime, mapTimeToX, mapVoltageToY, mapXToTime, meanVoltage,
  pickDefaultVoltageScale, refitVoltageScale, stepPreset,
  SCOPE_H_DIVS, SCOPE_V_DIVS, TIMEBASE_PRESETS, VOLTAGE_SCALE_PRESETS,
} from '../src/lib/circuit/scope-viewer';

// ─── Pure scope math ────────────────────────────────────────────────────────

describe('scope-panel: preset stepping (1-2-5 ladders)', () => {
  it('steps the timebase down one preset', () => {
    expect(stepPreset(TIMEBASE_PRESETS, 1e-3, -1)).toBe(5e-4);
  });
  it('steps the timebase up one preset', () => {
    expect(stepPreset(TIMEBASE_PRESETS, 1e-3, 1)).toBe(2e-3);
  });
  it('clamps at the finest timebase', () => {
    expect(stepPreset(TIMEBASE_PRESETS, 1e-9, -1)).toBe(1e-9);
  });
  it('clamps at the coarsest timebase', () => {
    expect(stepPreset(TIMEBASE_PRESETS, 5, 1)).toBe(5);
  });
  it('snaps a non-ladder value up to the next preset', () => {
    expect(stepPreset(TIMEBASE_PRESETS, 3e-3, 1)).toBe(5e-3);
  });
  it('snaps a non-ladder value down to the previous preset', () => {
    expect(stepPreset(TIMEBASE_PRESETS, 3e-3, -1)).toBe(2e-3);
  });
  it('steps the voltage ladder both ways', () => {
    expect(stepPreset(VOLTAGE_SCALE_PRESETS, 1, -1)).toBe(0.5);
    expect(stepPreset(VOLTAGE_SCALE_PRESETS, 1, 1)).toBe(2);
  });
  it('returns current for an empty preset list', () => {
    expect(stepPreset([], 7, 1)).toBe(7);
  });
});

describe('scope-panel: div windows and pixel mapping', () => {
  it('time window spans ±5 divisions around the center time', () => {
    const win = computeTimeWindow(1e-3, 1);
    expect(win.tStart).toBeCloseTo(1 - 5e-3, 12);
    expect(win.tEnd).toBeCloseTo(1 + 5e-3, 12);
  });
  it('time window total span is 10 divisions', () => {
    for (const tb of [1e-6, 1e-3, 1e-1]) {
      const win = computeTimeWindow(tb, 42);
      expect(win.tEnd - win.tStart).toBeCloseTo(tb * SCOPE_H_DIVS, 9);
    }
  });
  it('voltage window spans ±4 divisions around the offset', () => {
    const win = computeVoltageWindow(2, 1);
    expect(win.vTop).toBe(9);
    expect(win.vBottom).toBe(-7);
  });
  it('maps window edges and center to pixel coordinates', () => {
    const win = computeTimeWindow(1e-3, 0); // [-5ms, +5ms]
    expect(mapTimeToX(win.tStart, win, 10, 200)).toBeCloseTo(10, 9);
    expect(mapTimeToX(win.tEnd, win, 10, 200)).toBeCloseTo(210, 9);
    expect(mapTimeToX(0, win, 10, 200)).toBeCloseTo(110, 9);
  });
  it('mapXToTime is the inverse of mapTimeToX', () => {
    const win = computeTimeWindow(2e-3, 1.5);
    for (const t of [win.tStart, 1.49, 1.5, 1.501, win.tEnd]) {
      const px = mapTimeToX(t, win, 0, 320);
      expect(mapXToTime(px, win, 0, 320)).toBeCloseTo(t, 9);
    }
  });
  it('maps voltages to pixels with vTop on the top edge', () => {
    const vWin = computeVoltageWindow(1, 0); // ±4 V
    expect(mapVoltageToY(vWin.vTop, vWin, 20, 160)).toBeCloseTo(20, 9);
    expect(mapVoltageToY(vWin.vBottom, vWin, 20, 160)).toBeCloseTo(180, 9);
    expect(mapVoltageToY(0, vWin, 20, 160)).toBeCloseTo(100, 9); // center row
  });
});

describe('scope-panel: AC coupling', () => {
  const samples = [
    { time: 0, voltage: 1 },
    { time: 1, voltage: 2 },
    { time: 2, voltage: 3 },
  ];
  it('DC coupling returns the same array reference', () => {
    expect(applyCoupling(samples, 'DC')).toBe(samples);
  });
  it('AC coupling subtracts the mean', () => {
    const ac = applyCoupling(samples, 'AC');
    expect(ac.map((s) => s.voltage)).toEqual([-1, 0, 1]);
    expect(ac.map((s) => s.time)).toEqual([0, 1, 2]);
  });
  it('AC coupling on an empty array returns the same reference', () => {
    const empty = applyCoupling([], 'AC');
    expect(empty).toEqual([]);
  });
  it('meanVoltage: empty → 0, known values', () => {
    expect(meanVoltage([])).toBe(0);
    expect(meanVoltage(samples)).toBeCloseTo(2, 12);
  });
  it('AC-coupled measurements have ~zero average and unchanged Vpp', () => {
    // 1 V sine riding on a 5 V DC offset
    const raw = Array.from({ length: 1000 }, (_, i) => ({
      time: i * 1e-5,
      voltage: 5 + Math.sin(2 * Math.PI * 1000 * i * 1e-5),
    }));
    const m = computeMeasurements(applyCoupling(raw, 'AC'));
    expect(m.find((x) => x.name === 'Vavg')!.value).toBeCloseTo(0, 6);
    expect(m.find((x) => x.name === 'Vpp')!.value).toBeCloseTo(2, 1);
  });
});

describe('scope-panel: measurements', () => {
  it('computes true RMS of a sine wave', () => {
    const samples = Array.from({ length: 2000 }, (_, i) => ({
      time: i * 1e-5,
      voltage: 5 * Math.sin(2 * Math.PI * 500 * i * 1e-5),
    }));
    const m = computeMeasurements(samples);
    expect(m.find((x) => x.name === 'Vrms')!.value).toBeCloseTo(5 / Math.sqrt(2), 3);
    expect(m.find((x) => x.name === 'Vpp')!.value).toBeCloseTo(10, 1);
  });
  it('single-sample measurements are exact', () => {
    const m = computeMeasurements([{ time: 0, voltage: 3 }]);
    expect(m.find((x) => x.name === 'Vmax')!.value).toBe(3);
    expect(m.find((x) => x.name === 'Vrms')!.value).toBe(3);
    expect(m.find((x) => x.name === 'Vavg')!.value).toBe(3);
  });
});

describe('scope-panel: A/B cursor math', () => {
  it('Δt is signed B − A and 1/Δt is its reciprocal', () => {
    const d = computeCursorDeltas(1e-3, 3e-3);
    expect(d.dt).toBeCloseTo(2e-3, 15);
    expect(d.freq).toBeCloseTo(500, 9);
  });
  it('reversed cursors give a negative Δt but a positive frequency', () => {
    const d = computeCursorDeltas(3e-3, 1e-3);
    expect(d.dt).toBeCloseTo(-2e-3, 15);
    expect(d.freq).toBeCloseTo(500, 9);
  });
  it('coincident cursors give a null frequency', () => {
    expect(computeCursorDeltas(2e-3, 2e-3).freq).toBeNull();
  });
  it('getVoltageAtTime interpolates on coupled samples', () => {
    const raw = [
      { time: 0, voltage: 4 },
      { time: 1, voltage: 6 },
    ];
    const v = getVoltageAtTime(applyCoupling(raw, 'AC'), 0.5);
    expect(v).toBeCloseTo(0, 12); // raw midpoint 5 V minus mean 5 V
  });
});

describe('scope-panel: default / grow-only voltage fitting', () => {
  it('picks the smallest preset covering ±5 V around zero', () => {
    expect(pickDefaultVoltageScale(-5, 5)).toBe(2); // 5/4 = 1.25 → 2 V/div
  });
  it('picks a millivolt preset for small signals', () => {
    expect(pickDefaultVoltageScale(-0.004, 0.004)).toBe(1e-3);
  });
  it('respects the offset when fitting', () => {
    expect(pickDefaultVoltageScale(4, 6, 5)).toBe(0.5);
  });
  it('clamps huge signals to the largest preset', () => {
    expect(pickDefaultVoltageScale(-1000, 1000)).toBe(50);
  });
  it('refit keeps a scale that still fits', () => {
    expect(refitVoltageScale(5, -3, 3, 0)).toBe(5);
  });
  it('refit bumps a scale that clips the signal', () => {
    expect(refitVoltageScale(1, -5, 5, 0)).toBe(2);
  });
  it('refit is grow-only: a shrunken signal never shrinks the scale', () => {
    expect(refitVoltageScale(5, -1, 1, 0)).toBe(5);
  });
});

describe('scope-panel: formatting', () => {
  it('formatDuration picks s/ms/µs/ns', () => {
    expect(formatDuration(2.5e-3)).toBe('2.500 ms');
    expect(formatDuration(3e-6)).toBe('3.000 µs');
    expect(formatDuration(4e-9)).toBe('4.000 ns');
    expect(formatDuration(1.5)).toBe('1.500 s');
    expect(formatDuration(0)).toBe('0.000 s');
  });
  it('formatFrequency picks Hz/kHz/MHz/GHz', () => {
    expect(formatFrequency(500)).toBe('500.000 Hz');
    expect(formatFrequency(2500)).toBe('2.500 kHz');
    expect(formatFrequency(2.5e6)).toBe('2.500 MHz');
    expect(formatFrequency(1e9)).toBe('1.000 GHz');
  });
  it('formatVoltage picks V/mV', () => {
    expect(formatVoltage(-2.5)).toBe('-2.500 V');
    expect(formatVoltage(0.5)).toBe('500.000 mV');
    expect(formatVoltage(0)).toBe('0.000 V');
  });
  it('formatTimebase / formatVoltageScale keep their div suffixes', () => {
    expect(formatTimebase(5e-3)).toContain('ms/div');
    expect(formatVoltageScale(0.5)).toContain('mV/div');
  });
});

describe('scope-panel: default scope config', () => {
  it('exposes a fully typed default trigger', () => {
    const c = createDefaultScopeConfig();
    expect(c.trigger).toEqual({ mode: 'auto', source: 0, edge: 'rising', level: 0, armed: true });
    expect(c.maxSamples).toBe(5000);
    expect(c.cursorA).toEqual({ enabled: false, time: 0, channel: -1 });
    expect(c.cursorB).toEqual({ enabled: false, time: 0, channel: -1 });
  });
  it('grid constants are the standard 10 × 8 divisions', () => {
    expect(SCOPE_H_DIVS).toBe(10);
    expect(SCOPE_V_DIVS).toBe(8);
  });
});

// ─── Component render smoke test ────────────────────────────────────────────
// The repo has no jsdom/@testing-library setup, so we follow the established
// light-render pattern (tests/error-boundary.test.ts renders React elements
// directly). renderToString exercises hook initialization and the default
// 'scope' tab markup without needing a DOM.

describe('scope-panel: ProbePanel render smoke test', () => {
  const html = renderToString(React.createElement(ProbePanel));

  it('renders the scope toolbar controls', () => {
    expect(html).toContain('Decrease timebase');
    expect(html).toContain('Increase timebase');
    expect(html).toContain('Decrease volts per division');
    expect(html).toContain('Increase volts per division');
    expect(html).toContain('Decrease vertical offset');
    expect(html).toContain('Toggle cursor A');
    expect(html).toContain('Toggle cursor B');
    expect(html).toContain('Move cursor A left (0.1 div)');
  });
  it('renders default readouts (1 ms/div timebase, armed trigger)', () => {
    expect(html).toContain('ms/div');
    expect(html).toContain('ARMED');
    expect(html).toContain('CH1');
  });
  it('renders the cursor hint row and canvas', () => {
    expect(html).toContain('Enable cursor A/B');
    expect(html).toContain('Oscilloscope waveform display');
  });
  it('keeps all four tabs and the header buttons intact', () => {
    expect(html).toContain('>scope<');
    expect(html).toContain('>measurements<');
    expect(html).toContain('>.meas<');
    expect(html).toContain('>spectrum<');
    expect(html).toContain('Toggle cursor A');
    expect(html).toContain('Ask AI to diagnose this circuit');
  });
});
