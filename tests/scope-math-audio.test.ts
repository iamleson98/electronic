// Tests for scope math channels, the circuit audio helpers, and the
// persistent user symbol library.

import { describe, it, expect, beforeEach } from 'vitest';
import { computeMathSamples } from '../src/lib/circuit/scope-viewer';
import {
  clampVoiceFrequency,
  buzzVolumeFromVoltage,
  speakerVolumeFromVpp,
  MIN_AUDIBLE_HZ,
  MAX_AUDIBLE_HZ,
} from '../src/lib/circuit/audio';

// ─── Math channels ───────────────────────────────────────────────────────────

describe('computeMathSamples (scope math channels)', () => {
  const a = [
    { time: 0, voltage: 1 },
    { time: 0.001, voltage: 2 },
    { time: 0.002, voltage: 3 },
  ];
  const b = [
    { time: 0, voltage: 0.5 },
    { time: 0.001, voltage: 1 },
    { time: 0.002, voltage: -1 },
  ];

  it('add: A + B per sample', () => {
    const out = computeMathSamples(a, b, 'add');
    expect(out.map((s) => s.voltage)).toEqual([1.5, 3, 2]);
    expect(out.map((s) => s.time)).toEqual([0, 0.001, 0.002]);
  });

  it('sub: A − B per sample', () => {
    const out = computeMathSamples(a, b, 'sub');
    expect(out.map((s) => s.voltage)).toEqual([0.5, 1, 4]);
  });

  it('mul: A × B per sample', () => {
    const out = computeMathSamples(a, b, 'mul');
    expect(out.map((s) => s.voltage)).toEqual([0.5, 2, -3]);
  });

  it('different lengths: tail-aligned pairing', () => {
    const longer = [{ time: -0.001, voltage: 100 }, ...a];
    const out = computeMathSamples(longer, b, 'add');
    // n = 3, the FIRST sample of `longer` drops, latest samples pair
    expect(out.map((s) => s.voltage)).toEqual([1.5, 3, 2]);
  });

  it('empty input → empty output', () => {
    expect(computeMathSamples([], b, 'add')).toHaveLength(0);
    expect(computeMathSamples(a, [], 'mul')).toHaveLength(0);
  });
});

// ─── Audio helpers ──────────────────────────────────────────────────────────

describe('circuit audio helpers', () => {
  it('clampVoiceFrequency: silent for 0/NaN, clamped into the audible band', () => {
    expect(clampVoiceFrequency(0)).toBe(0);
    expect(clampVoiceFrequency(NaN)).toBe(0);
    expect(clampVoiceFrequency(-5)).toBe(0);
    expect(clampVoiceFrequency(30)).toBe(MIN_AUDIBLE_HZ); // too low → 40
    expect(clampVoiceFrequency(440)).toBe(440);
    expect(clampVoiceFrequency(20000)).toBe(MAX_AUDIBLE_HZ); // too high → 12000
  });

  it('buzzVolumeFromVoltage: silent below 80% of rated, scales up above', () => {
    expect(buzzVolumeFromVoltage(0, 5)).toBe(0);
    expect(buzzVolumeFromVoltage(3.9, 5)).toBe(0); // 78% < 80%
    expect(buzzVolumeFromVoltage(4.0, 5)).toBeCloseTo(0.24, 4); // exactly 80%
    expect(buzzVolumeFromVoltage(5, 5)).toBeCloseTo(0.36, 4);
    expect(buzzVolumeFromVoltage(7, 5)).toBeCloseTo(0.6, 4); // capped region
    expect(buzzVolumeFromVoltage(1000, 5)).toBeLessThanOrEqual(0.6);
    // negative voltage: |v| — buzzer is polarity-insensitive in activity terms
    expect(buzzVolumeFromVoltage(-4.2, 5)).toBeGreaterThan(0);
  });

  it('speakerVolumeFromVpp: scales with amplitude, caps at 0.7', () => {
    expect(speakerVolumeFromVpp(0)).toBe(0);
    expect(speakerVolumeFromVpp(-1)).toBe(0);
    expect(speakerVolumeFromVpp(1)).toBeCloseTo(0.5, 4);
    expect(speakerVolumeFromVpp(4)).toBeCloseTo(0.7, 4);
    expect(speakerVolumeFromVpp(100)).toBeLessThanOrEqual(0.7);
  });
});

// ─── User symbol library (persistence) ──────────────────────────────────────

describe('user-library persistence', () => {
  class MockLS {
    private s = new Map<string, string>();
    getItem(k: string) { return this.s.get(k) ?? null; }
    setItem(k: string, v: string) { this.s.set(k, v); }
    removeItem(k: string) { this.s.delete(k); }
    clear() { this.s.clear(); }
  }

  beforeEach(() => {
    const ls = new MockLS();
    (globalThis as any).window = { localStorage: ls };
    (globalThis as any).localStorage = ls;
  });

  it('save → list round-trip preserves the design', async () => {
    const lib = await import('../src/lib/circuit/user-library');
    const design = {
      name: 'My Gate',
      type: 'myGate',
      description: '',
      boundingBox: { width: 4, height: 4 },
      pins: [{ id: 'a', position: { x: 0, y: 1 }, label: 'A', name: 'A', number: '1', electricalType: 'input' as const, shape: 'line' as const, length: 1, direction: 'left' as const }],
      rects: [],
      lines: [],
      texts: [],
    };
    expect(lib.saveUserDesign(design, 'symbol-editor')).toBe(true);
    const entries = lib.listUserDesigns();
    expect(entries).toHaveLength(1);
    expect(entries[0].design.type).toBe('myGate');
    expect(entries[0].source).toBe('symbol-editor');
  });

  it('saving the same type replaces (no duplicate)', async () => {
    const lib = await import('../src/lib/circuit/user-library');
    const mk = (name: string) => ({
      name, type: 'dup', description: '', boundingBox: { width: 2, height: 2 },
      pins: [], rects: [], lines: [], texts: [],
    });
    lib.saveUserDesign(mk('first'), 'symbol-editor');
    lib.saveUserDesign(mk('second'), 'kicad-import');
    const entries = lib.listUserDesigns();
    expect(entries).toHaveLength(1);
    expect(entries[0].design.name).toBe('second');
    expect(entries[0].source).toBe('kicad-import');
  });

  it('remove deletes the entry', async () => {
    const lib = await import('../src/lib/circuit/user-library');
    const design = { name: 'x', type: 'removeme', description: '', boundingBox: { width: 2, height: 2 }, pins: [], rects: [], lines: [], texts: [] };
    lib.saveUserDesign(design, 'symbol-editor');
    lib.removeUserDesign('removeme');
    expect(lib.listUserDesigns()).toHaveLength(0);
  });

  it('registerAllUserSymbols registers persisted designs as plugins', async () => {
    const lib = await import('../src/lib/circuit/user-library');
    const { hasPlugin, getPlugin } = await import('../src/lib/circuit/registry');
    const design = {
      name: 'Test Sym',
      type: 'testSymUnique',
      description: '',
      boundingBox: { width: 3, height: 3 },
      pins: [{ id: 'a', position: { x: 0, y: 1 }, label: 'A', name: 'A', number: '1', electricalType: 'input' as const, shape: 'line' as const, length: 1, direction: 'left' as const }],
      rects: [], lines: [], texts: [],
    };
    lib.saveUserDesign(design, 'kicad-import');
    const count = lib.registerAllUserSymbols();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(hasPlugin('testSymUnique')).toBe(true);
    expect(getPlugin('testSymUnique')!.terminals).toHaveLength(1);
  });

  it('corrupted storage degrades to an empty library (no throw)', async () => {
    (globalThis as any).window.localStorage.setItem('circuitlab-user-library-v1', '{{{not json');
    const lib = await import('../src/lib/circuit/user-library');
    expect(lib.listUserDesigns()).toHaveLength(0);
  });
});
