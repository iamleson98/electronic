// Tests for the AI teaching engines: walkthrough-tools (block detection +
// grounded analysis) and teaching-tools (level-adaptive explain, deterministic
// quiz, registry-grounded recommendations).
//
// NOTE: all circuits + walkthroughs are built inside beforeAll hooks — the
// plugin registry is only populated after the components import resolves.

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';
import {
  analyzeCircuitWalkthrough,
  buildNetlist,
  circuitWalkthroughTool,
  type CircuitWalkthrough,
} from '../src/lib/ai/tools/walkthrough-tools';
import {
  buildLeveledExplanation,
  generateQuiz,
  recommendComponents,
  listUseCases,
  conceptExplainTool,
  conceptQuizTool,
  componentRecommendTool,
} from '../src/lib/ai/tools/teaching-tools';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

function comp(type: string, id: string, params?: Record<string, unknown>): CircuitComponent {
  const p = getPlugin(type);
  const defaults: Record<string, unknown> = {};
  if (p) for (const pm of p.parameters) defaults[pm.key] = pm.default;
  return {
    id, type, position: { x: 0, y: 0 }, rotation: 0,
    parameters: { ...defaults, ...params }, simState: {},
  } as CircuitComponent;
}
function wire(id: string, fc: string, ft: string, tc: string, tt: string): Wire {
  return { id, from: { componentId: fc, terminalId: ft }, to: { componentId: tc, terminalId: tt } };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('buildNetlist', () => {
  it('unions terminals connected by wires', () => {
    const comps = [comp('resistor', 'R1'), comp('resistor', 'R2')];
    const ws = [wire('w1', 'R1', 'b', 'R2', 'a')];
    const nl = buildNetlist(comps, ws);
    expect(nl.netOf('R1', 'b')).toBe(nl.netOf('R2', 'a'));
    expect(nl.netOf('R1', 'a')).not.toBe(nl.netOf('R1', 'b'));
  });
  it('isolated terminals get their own nets', () => {
    const nl = buildNetlist([comp('resistor', 'R1')], []);
    expect(nl.netOf('R1', 'a')).not.toBe(nl.netOf('R1', 'b'));
  });
});

describe('analyzeCircuitWalkthrough — LED + resistor classic', () => {
  let wt: CircuitWalkthrough;
  beforeAll(() => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('resistor', 'R1', { resistance: 330 }),
      comp('led', 'D1', { forwardVoltage: 2 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'D1', 'a'),
      wire('w3', 'D1', 'k', 'GND', 'g'),
      wire('w4', 'V1', 'n', 'GND', 'g'),
    ];
    wt = analyzeCircuitWalkthrough(comps, ws);
  });

  it('classifies as beginner difficulty with power + output blocks', () => {
    expect(wt.difficulty).toBe('beginner');
    const kinds = wt.blocks.map((b) => b.kind);
    expect(kinds).toContain('power');
    expect(kinds).toContain('output');
  });

  it('computes the LED current from the actual values', () => {
    const outBlock = wt.blocks.find((b) => b.kind === 'output')!;
    const led = outBlock.components.find((p) => p.type === 'led')!;
    expect(led.analysis).toBeDefined();
    const current = led.analysis!.find((a) => /LED current/i.test(a.label))!;
    // (5 - 2)/330 = 9.09 mA
    expect(current.value).toContain('9.09m');
  });

  it('does not flag the LED (it has a series resistor)', () => {
    expect(wt.teachingNotes.filter((n) => /no series resistor/i.test(n.note))).toHaveLength(0);
  });

  it('summary mentions the component count and blocks', () => {
    expect(wt.summary).toContain('4');
  });
});

describe('analyzeCircuitWalkthrough — 555 astable detection', () => {
  let wt: CircuitWalkthrough;
  beforeAll(() => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 9 }),
      comp('timer555', 'U1'),
      comp('resistor', 'R1', { resistance: 10000 }),
      comp('resistor', 'R2', { resistance: 47000 }),
      comp('capacitor', 'C1', { capacitance: 1e-6 }),
      comp('ground', 'GND'),
    ];
    // Classic astable: R1 VCC→DIS, R2 DIS→THR, C THR→GND, TRIG tied to THR
    const ws = [
      wire('w1', 'V1', 'p', 'R1', 'a'),
      wire('w2', 'R1', 'b', 'U1', 'dis'),
      wire('w3', 'U1', 'dis', 'R2', 'a'),
      wire('w4', 'R2', 'b', 'U1', 'thr'),
      wire('w5', 'U1', 'thr', 'C1', 'a'),
      wire('w6', 'C1', 'b', 'GND', 'g'),
      wire('w7', 'U1', 'trig', 'U1', 'thr'),
      wire('w8', 'V1', 'n', 'GND', 'g'),
    ];
    wt = analyzeCircuitWalkthrough(comps, ws);
  });

  it('detects the astable mode from TRIG≡THR', () => {
    const timing = wt.blocks.find((b) => b.kind === 'timing')!;
    const t555 = timing.components.find((p) => p.type === 'timer555')!;
    expect(t555.role).toMatch(/astable/i);
  });

  it('computes frequency and duty from the actual R/C values', () => {
    const timing = wt.blocks.find((b) => b.kind === 'timing')!;
    const t555 = timing.components.find((p) => p.type === 'timer555')!;
    expect(t555.analysis).toBeDefined();
    const f = t555.analysis!.find((a) => /frequency/i.test(a.label))!;
    // f = 1/(ln2*(10k + 2*47k)*1uF) = 1/0.0721 ≈ 13.87 Hz
    expect(f.value).toMatch(/13\.\d+Hz/);
    const duty = t555.analysis!.find((a) => /duty/i.test(a.label))!;
    expect(duty.value).toContain('%');
  });

  it('flags missing decoupling for the IC', () => {
    expect(wt.teachingNotes.some((n) => /decoupling/i.test(n.note))).toBe(true);
  });

  it('suggests the sweep experiment for the timing resistors', () => {
    expect(wt.suggestedExperiments.some((e) => /sweep/i.test(e))).toBe(true);
  });
});

describe('analyzeCircuitWalkthrough — op-amp configurations', () => {
  it('detects the inverting configuration from the feedback path', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 12 }),
      comp('opamp', 'U1'),
      comp('resistor', 'RIN', { resistance: 1000 }),
      comp('resistor', 'RF', { resistance: 10000 }),
      comp('ground', 'GND'),
    ];
    // Inverting: input through RIN to in-, RF from in- to out, in+ grounded
    const ws = [
      wire('w1', 'RIN', 'b', 'U1', 'in-'),
      wire('w2', 'U1', 'in-', 'RF', 'a'),
      wire('w3', 'RF', 'b', 'U1', 'out'),
      wire('w4', 'U1', 'in+', 'GND', 'g'),
      wire('w5', 'V1', 'n', 'GND', 'g'),
    ];
    const wt = analyzeCircuitWalkthrough(comps, ws);
    const amp = wt.blocks.find((b) => b.kind === 'amplification')!;
    const oa = amp.components.find((p) => /^opamp/.test(p.type))!;
    expect(oa.role).toMatch(/inverting/i);
    expect(oa.role).not.toMatch(/non-inverting/);
    // Gain = 10 → 20 dB
    const gain = oa.analysis!.find((a) => /dB/.test(a.label))!;
    expect(gain.value).toContain('20.0 dB');
  });

  it('detects a comparator when no feedback resistor exists', () => {
    const comps = [
      comp('opamp', 'U1'),
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'U1', 'in+'),
      wire('w2', 'V1', 'n', 'GND', 'g'),
      wire('w3', 'U1', 'in-', 'GND', 'g'),
    ];
    const wt = analyzeCircuitWalkthrough(comps, ws);
    const amp = wt.blocks.find((b) => b.kind === 'amplification')!;
    const oa = amp.components.find((p) => /^opamp/.test(p.type))!;
    expect(oa.role).toMatch(/comparator/i);
  });

  it('detects a unity buffer when OUT is netted directly to IN−', () => {
    const comps = [
      comp('opamp', 'U1'),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'U1', 'out', 'U1', 'in-'),
    ];
    const wt = analyzeCircuitWalkthrough(comps, ws);
    const amp = wt.blocks.find((b) => b.kind === 'amplification')!;
    const oa = amp.components.find((p) => /^opamp/.test(p.type))!;
    expect(oa.role).toMatch(/buffer/i);
  });
});

describe('analyzeCircuitWalkthrough — RC low-pass filter', () => {
  it('detects the RC filter and computes fc = 159 Hz', () => {
    const comps = [
      comp('resistor', 'R1', { resistance: 1000 }),
      comp('capacitor', 'C1', { capacitance: 1e-6 }),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'R1', 'b', 'C1', 'a'),
      wire('w2', 'C1', 'b', 'GND', 'g'),
    ];
    const wt = analyzeCircuitWalkthrough(comps, ws);
    const filter = wt.blocks.find((b) => b.kind === 'filter');
    expect(filter).toBeDefined();
    const r = filter!.components.find((p) => p.type === 'resistor')!;
    const fc = r.analysis!.find((a) => /cutoff/i.test(a.label))!;
    expect(fc.value).toContain('159');
  });
});

describe('analyzeCircuitWalkthrough — teaching notes', () => {
  it('flags relay without flyback diode', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('relay', 'K1'),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'K1', 'coilA'),
      wire('w2', 'K1', 'coilB', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const wt = analyzeCircuitWalkthrough(comps, ws);
    expect(wt.teachingNotes.some((n) => /flyback/i.test(n.note))).toBe(true);
  });

  it('accepts the flyback diode and drops the warning', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('relay', 'K1'),
      comp('diode', 'D1'),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'K1', 'coilA'),
      wire('w2', 'K1', 'coilB', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
      wire('w4', 'D1', 'k', 'K1', 'coilA'), // reversed across the coil
      wire('w5', 'D1', 'a', 'K1', 'coilB'),
    ];
    const wt = analyzeCircuitWalkthrough(comps, ws);
    expect(wt.teachingNotes.some((n) => /flyback/i.test(n.note))).toBe(false);
  });

  it('errors on LED wired straight to a source', () => {
    const comps = [
      comp('dcVoltage', 'V1', { voltage: 5 }),
      comp('led', 'D1'),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'V1', 'p', 'D1', 'a'),
      wire('w2', 'D1', 'k', 'GND', 'g'),
      wire('w3', 'V1', 'n', 'GND', 'g'),
    ];
    const wt = analyzeCircuitWalkthrough(comps, ws);
    const err = wt.teachingNotes.find((n) => n.severity === 'error' && /no series resistor/i.test(n.note));
    expect(err).toBeDefined();
  });

  it('flags open-drain output without pull-up', () => {
    const comps = [
      comp('dcVoltage', 'VCC', { voltage: 5 }),
      comp('hallSwitch', 'H1'),
      comp('voltmeter', 'VM'),
      comp('ground', 'GND'),
    ];
    const ws = [
      wire('w1', 'H1', 'vcc', 'VCC', 'p'),
      wire('w2', 'H1', 'gnd', 'GND', 'g'),
      wire('w3', 'H1', 'out', 'VM', 'p'),
      wire('w4', 'VM', 'n', 'GND', 'g'),
      wire('w5', 'VCC', 'n', 'GND', 'g'),
    ];
    const wt = analyzeCircuitWalkthrough(comps, ws);
    expect(wt.teachingNotes.some((n) => /open-drain/i.test(n.note))).toBe(true);
  });

  it('empty canvas returns a graceful summary', () => {
    const wt = analyzeCircuitWalkthrough([], []);
    expect(wt.summary).toMatch(/empty/i);
    expect(wt.blocks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildLeveledExplanation', () => {
  it('explains ohms-law at beginner level with analogy + worked example', () => {
    const exp = buildLeveledExplanation('ohms-law', 'beginner')!;
    expect(exp).not.toBeNull();
    expect(exp.level).toBe('beginner');
    expect(exp.analogy).toMatch(/water/i);
    expect(exp.workedExample).toBeDefined();
    expect(exp.workedExample!.answer).toContain('9');
    expect(exp.commonMistakes.length).toBeGreaterThan(0);
    expect(exp.checkUnderstanding).toContain('Quick check');
  });

  it('finds articles by free-text query, not just exact ids', () => {
    const exp = buildLeveledExplanation('how capacitors work', 'beginner');
    expect(exp).not.toBeNull();
    expect(exp!.topic).toBe('capacitor-basics');
  });

  it('worked example for the 555 matches the formula exactly', () => {
    const exp = buildLeveledExplanation('555-timer', 'engineer')!;
    expect(exp.workedExample).toBeDefined();
    expect(exp.workedExample!.answer).toMatch(/13\.\d+Hz/);
  });

  it('returns null for unknown topics (relevance check)', () => {
    expect(buildLeveledExplanation('quantum chromodynamics', 'beginner')).toBeNull();
    expect(buildLeveledExplanation('warp drive', 'beginner')).toBeNull();
  });

  it('every topic in the example map resolves to a real KB article', () => {
    const ids = ['ohms-law', 'voltage-divider', 'led-current-limiting', 'capacitor-basics', '555-timer', 'opamp-basics', 'inductor-basics'];
    for (const id of ids) {
      const exp = buildLeveledExplanation(id, 'practitioner');
      expect(exp, id).not.toBeNull();
    }
  });
});

describe('generateQuiz — deterministic, exact', () => {
  it('same seed → identical quiz', () => {
    const a = generateQuiz('mixed', 5, 42);
    const b = generateQuiz('mixed', 5, 42);
    expect(a).toEqual(b);
  });

  it('every question has 4 unique choices and a valid answer index', () => {
    const qs = generateQuiz('mixed', 10, 7);
    expect(qs).toHaveLength(10);
    for (const q of qs) {
      expect(q.choices.length).toBe(4);
      expect(new Set(q.choices).size).toBe(4);
      expect(q.answerIndex).toBeGreaterThanOrEqual(0);
      expect(q.answerIndex).toBeLessThan(q.choices.length);
      expect(q.explanation.length).toBeGreaterThan(10);
    }
  });

  it('numeric answers are physically correct (Ohm law question)', () => {
    const qs = generateQuiz('mixed', 20, 123);
    const ohmQ = qs.find((q) => /resistor\. How much current/i.test(q.question));
    expect(ohmQ).toBeDefined();
    const m = ohmQ!.question.match(/(\d+) V is applied across a (\S+) resistor/);
    expect(m).toBeDefined();
    const v = Number(m![1]);
    const rStr = m![2];
    const mult = rStr.includes('k') ? 1000 : rStr.includes('M') ? 1e6 : 1;
    const r = parseFloat(rStr) * mult;
    const expected = v / r;
    const answer = ohmQ!.choices[ohmQ!.answerIndex];
    const val = parseFloat(answer.replace(/[^\d.]/g, ''));
    const scale = answer.includes('m') ? 1e-3 : answer.includes('u') ? 1e-6 : answer.includes('k') ? 1e3 : 1;
    expect(val * scale).toBeCloseTo(expected, 2);
  });

  it('topic filter biases toward the requested topic', () => {
    const qs = generateQuiz('ohms-law', 8, 5);
    const ohmish = qs.filter((q) => /V = I|current|resistor|voltage/i.test(q.question + q.explanation));
    expect(ohmish.length).toBeGreaterThanOrEqual(4);
  });
});

describe('recommendComponents — registry-grounded', () => {
  it('recommends real, registered parts only', () => {
    const recs = recommendComponents('power-regulation-5v');
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(getPlugin(r.type)).toBeTruthy(); // must exist in the registry
      expect(r.why.length).toBeGreaterThan(10);
    }
    const types = recs.map((r) => r.type);
    expect(types).toContain('lm7805');
  });

  it('every advertised use-case returns at least one part', () => {
    for (const { useCase } of listUseCases()) {
      const recs = recommendComponents(useCase);
      expect(recs.length, useCase).toBeGreaterThan(0);
    }
  });

  it('key parameters come from the plugin definitions', () => {
    const recs = recommendComponents('led-driving');
    const res = recs.find((r) => r.type === 'resistor')!;
    expect(res.keyParameters.length).toBeGreaterThan(0);
    expect(res.keyParameters[0].label).toMatch(/res/i);
  });

  it('unknown use-case returns empty (tool reports available list)', () => {
    expect(recommendComponents('time-travel')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('tool wrappers', () => {
  const ctx = {
    doc: { components: [], wires: [] },
    plugins: new Map(),
  } as never;

  it('circuit.walkthrough executes against the document', () => {
    const res = circuitWalkthroughTool.execute({}, ctx);
    expect(res.ok).toBe(true);
    expect(res.result.summary).toMatch(/empty/i);
  });

  it('circuit.walkthrough reads the ctx document', () => {
    const doc = {
      components: [comp('resistor', 'R1', { resistance: 1000 })],
      wires: [],
    };
    const res = circuitWalkthroughTool.execute({}, { ...ctx, doc });
    expect(res.ok).toBe(true);
    expect(res.result.blocks.length).toBeGreaterThan(0);
  });

  it('concept.explain resolves topics and levels', () => {
    const res = conceptExplainTool.execute({ topic: 'voltage divider', level: 'beginner' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.result.level).toBe('beginner');
    expect(res.result.workedExample).toBeDefined();
  });

  it('concept.explain fails gracefully for unknown topics with suggestions', () => {
    const res = conceptExplainTool.execute({ topic: 'warp drive' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result.availableTopics.length).toBeGreaterThan(0);
  });

  it('concept.quiz honors count clamping and includes the grading note', () => {
    const res = conceptQuizTool.execute({ count: 99, seed: 1 }, ctx);
    expect(res.ok).toBe(true);
    expect(res.result.count).toBe(10);
    expect(res.result.gradingNote).toMatch(/one at a time/i);
  });

  it('component.recommend lists use-cases on demand', () => {
    const res = componentRecommendTool.execute({ listUseCases: true }, ctx);
    expect(res.ok).toBe(true);
    expect(res.result.useCases.length).toBeGreaterThanOrEqual(8);
  });

  it('component.recommend reports unknown use-cases with the available list', () => {
    const res = componentRecommendTool.execute({ useCase: 'banana' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result.availableUseCases.length).toBeGreaterThan(0);
  });
});
