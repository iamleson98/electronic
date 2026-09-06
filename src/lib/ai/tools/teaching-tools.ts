// Teaching tools — make the AI a world-class electronics TUTOR.
//
// concept.explain   : level-adaptive structured explanation of any KB topic,
//                     with a LIVE worked example computed by the same
//                     calculators the design tools use (so every number the
//                     AI quotes is verifiable).
// concept.quiz      : generates concept-check questions — numeric ones are
//                     computed from real formulas with deterministic seeds,
//                     so answers are exact, not hallucinated.
// component.recommend : suggests concrete parts FROM THE ACTUAL REGISTRY
//                     (real parameters from the plugin definitions), with
//                     trade-offs, for common design use-cases.
//
// All generators are pure + deterministic (seeded LCG) → fully testable.

import {
  getArticle,
  searchArticles,
  getArticlesByCategory,
  KB_ARTICLES,
  type KBArticle,
} from '../knowledge/knowledge-base';
import { getAllPlugins } from '@/lib/circuit/registry';
import type { Tool, ToolContext } from './types';
import { partDatabase } from '@/lib/pcb/part-database';
import {
  calcOhmsLaw,
  calcLedResistor,
  calcVoltageDivider,
  calc555Astable,
  calcOpampGain,
  calcReactance,

  nearestStandard,
  engFormat,
} from './design-calculators';

export type ExplainLevel = 'beginner' | 'practitioner' | 'engineer';

// ─────────────────────────────────────────────────────────────────────────────
// Worked-example generator — maps KB topics to live calculator demos
// ─────────────────────────────────────────────────────────────────────────────

interface WorkedExample {
  question: string;
  formula: string;
  steps: string[];
  answer: string;
}

const EXAMPLE_TOPICS: Record<string, () => WorkedExample> = {
  'ohms-law': () => {
    const out = calcOhmsLaw(9, undefined, 1000);
    return {
      question: 'A 9 V battery drives a 1 kΩ resistor. How much current flows?',
      formula: out.formula,
      steps: [`I = V / R = 9 V / 1 kΩ`, `I = ${engFormat(9 / 1000, 'A')}`],
      answer: `I = 9 mA (and the resistor dissipates ${engFormat(9 * 0.009, 'W')} — fine for a 1/4 W part).`,
    };
  },
  'voltage-divider': () => {
    const out = calcVoltageDivider(12, 10000, 22000);
    const vout = typeof out.outputs.vout === 'number' ? out.outputs.vout : 0;
    return {
      question: 'Divide 12 V down with R1 = 10 kΩ (top) and R2 = 22 kΩ (bottom). What is Vout?',
      formula: out.formula,
      steps: [
        'Vout = Vin · R2 / (R1 + R2)',
        `Vout = 12 V · 22 kΩ / (10 kΩ + 22 kΩ) = 12 · 22/32`,
      ],
      answer: `Vout ≈ ${vout.toFixed(2)} V (divider current ≈ ${engFormat(12 / 32000, 'A')}).`,
    };
  },
  'led-current-limiting': () => {
    const out = calcLedResistor(5, 2.0, 0.015);
    const rStd = typeof out.outputs.rStandard === 'number' ? out.outputs.rStandard : 200;
    return {
      question: 'Power a red LED (Vf = 2.0 V) from 5 V at 15 mA. What series resistor?',
      formula: 'R = (Vsupply − Vf) / I',
      steps: [
        'R = (5 − 2.0) V / 0.015 A',
        `R = 200 Ω → nearest E24: ${engFormat(rStd, 'Ω')}`,
      ],
      answer: `Use ${engFormat(rStd, 'Ω')} (standard ${nearestStandard(200)} Ω); the LED then runs at ≈ 15 mA.`,
    };
  },
  'capacitor-basics': () => {
    const tau = 10000 * 10e-6;
    return {
      question: 'A 10 kΩ resistor charges a 10 µF capacitor. How long until it is ~63% charged?',
      formula: 'τ = R·C',
      steps: ['τ = 10 kΩ × 10 µF = 0.1 s', 'Fully settled (5τ) in ≈ 0.5 s'],
      answer: `τ = 100 ms; the cap reaches 63% in one τ and is practically full after 5τ = ${engFormat(5 * tau, 's')}.`,
    };
  },
  '555-timer': () => {
    const out = calc555Astable(10000, 47000, 1e-6);
    const f = typeof out.outputs.f === 'number' ? out.outputs.f : 0;
    const duty = typeof out.outputs.duty === 'number' ? out.outputs.duty : 0;
    return {
      question: 'A 555 astable uses R1 = 10 kΩ, R2 = 47 kΩ, C = 1 µF. What frequency?',
      formula: 'f = 1 / (ln2 · (R1 + 2·R2) · C)',
      steps: ['f = 1 / (0.693 × (10k + 94k) × 1µF)', `f = 1 / 0.0722 s`],
      answer: `f ≈ ${engFormat(f, 'Hz')} at a ${(duty * 100).toFixed(0)}% duty cycle.`,
    };
  },
  'opamp-basics': () => {
    const out = calcOpampGain('inverting', 1000, 10000);
    const g = typeof out.outputs.gain === 'number' ? out.outputs.gain : 0;
    return {
      question: 'An inverting amp has Rin = 1 kΩ and Rf = 10 kΩ. What is the gain?',
      formula: 'Gain = −Rf / Rin',
      steps: ['Gain = −10 kΩ / 1 kΩ'],
      answer: `Gain = ${g.toFixed(1)} (i.e. 1 V in → −10 V out; the minus sign is the phase inversion).`,
    };
  },
  'inductor-basics': () => {
    const out = calcReactance(1000, undefined, 10e-3);
    const xl = typeof out.outputs.xl === 'number' ? out.outputs.xl : 0;
    return {
      question: 'What is the reactance of a 10 mH inductor at 1 kHz?',
      formula: 'X_L = 2πfL',
      steps: ['X_L = 2π × 1000 × 0.01'],
      answer: `X_L ≈ ${engFormat(xl, 'Ω')} — the inductor resists 1 kHz current like a ${engFormat(xl, 'Ω')} resistor (but stores the energy magnetically).`,
    };
  },
};

function workedExampleFor(articleId: string): WorkedExample | null {
  const gen = EXAMPLE_TOPICS[articleId];
  return gen ? gen() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-adaptive explanation
// ─────────────────────────────────────────────────────────────────────────────

export interface LeveledExplanation {
  topic: string;
  level: ExplainLevel;
  title: string;
  definition: string;
  analogy?: string;
  coreFormula?: string;
  workedExample?: WorkedExample;
  commonMistakes: string[];
  goToNext: string[];
  checkUnderstanding: string;
  relatedTopics: string[];
}

const ANALOGIES: Record<string, string> = {
  'ohms-law': 'Think of a water pipe: voltage is the pressure pushing water, current is how much water flows, and resistance is how narrow the pipe is. More pressure → more flow; narrower pipe → less flow.',
  'voltage-divider': 'A ladder: the total height is the supply voltage, and each rung gives you a fraction of that height depending on where you stand.',
  'capacitor-basics': 'A rubber membrane in a pipe: push water one way and it stretches (stores charge), but no water passes THROUGH it — so steady DC is blocked while changes get through.',
  'inductor-basics': 'A heavy water wheel: it resists being sped up or slowed down. Current keeps flowing even when you remove the pressure (that is why disconnecting an inductor sparks).',
  'diode-basics': 'A one-way valve: current flows forward with a small push (0.7 V), and is blocked in reverse.',
  'led-current-limiting': 'An LED is like a race car with no brakes — it will take whatever current you give it until it burns. The resistor is the brakes.',
  'transistor-basics': 'A faucet valve: a small current on the base (the handle) controls a large flow from collector to emitter.',
  'mosfet-basics': 'A voltage-operated valve: no steady gate current needed — the electric field of the gate opens the channel, like a magnet sliding a door.',
  'opamp-basics': 'A super-sensitive steering servo: it drives its output with enormous force in whichever direction makes its two inputs equal.',
  '555-timer': 'A filling-draining bucket with two marks: fill until the top mark, dump until the bottom mark, repeat — the resistor and capacitor set how fast the bucket fills.',
  'kvl-kcl': 'KCL: water flowing into a junction must flow out (no water is created). KVL: walking a loop of hills, you end at the same altitude — every climb is paid back by a descent.',
  'decoupling': 'A small water tower next to every house: when the neighborhood draws a sudden gulp, the local tower supplies it instead of the distant reservoir (whose long pipe has resistance and inductance).',
};

const MISTAKES: Record<string, string[]> = {
  'ohms-law': [
    'Using the LED\'s rated current AND forgetting the forward voltage drop when sizing its resistor.',
    'Mixing unit prefixes mid-calculation (kΩ with mA) without converting to base units.',
  ],
  'voltage-divider': [
    'Connecting a load directly across the divider output — the load becomes part of the bottom resistor and shifts the ratio. Keep load impedance ≥ 10× the divider impedance, or buffer it.',
    'Trying to power anything meaningful from a divider (it has no regulation; the voltage sags with load).',
  ],
  'capacitor-basics': [
    'Forgetting the 2× voltage rating margin — run a 25 V cap on a 24 V rail and it ages fast.',
    'Assuming a polarized electrolytic can go either way — reversed polarity heats and vents it.',
  ],
  'led-current-limiting': [
    'Putting LEDs in parallel on ONE resistor — the LED with the lower Vf hogs the current.',
    'Assuming the resistor can be any wattage: a 5 V supply, 2 V LED and 68 Ω resistor burns 44 mA × 3 V ≈ 0.13 W — a 1/8 W resistor is already marginal.',
  ],
  '555-timer': [
    'Forgetting the decoupling cap on pin 5 (control voltage) — noise modulates the thresholds and jitters the frequency.',
    'Making R2 (or R1) tiny to chase a high frequency — the discharge transistor can only sink so much current; keep R1 ≥ 1 kΩ.',
  ],
  'opamp-basics': [
    'Using an inverting stage where input impedance matters — Rin IS the input impedance.',
    'Expecting rail-to-rail output from a classic LM741 on ±15 V supplies (it saturates ~2 V from each rail).',
  ],
  'transistor-basics': [
    'Omitting the base resistor — the base-emitter junction is a diode to ground and will clamp the driving logic output.',
    'Assuming hFE is a constant — it varies with current, temperature, and between parts; design for the datasheet minimum.',
  ],
};

const NEXT_STEPS: Record<string, string[]> = {
  'ohms-law': ['voltage-divider', 'led-current-limiting', 'power (P = V·I) ratings'],
  'voltage-divider': ['opamp-basics (buffering a divider)', 'reading sensors with dividers (thermistor/LDR)'],
  'capacitor-basics': ['RC time constants', 'filters (low-pass / high-pass)', 'decoupling'],
  'inductor-basics': ['flyback-diode (why inductive loads need protection)', 'RL filters', 'switch-mode power supplies'],
  'led-current-limiting': ['transistor-switch (driving LEDs from logic)', 'PWM dimming'],
  '555-timer': ['monostable vs astable wiring', 'duty-cycle tricks with a diode across R2'],
  'opamp-basics': ['inverting vs non-inverting configurations', 'comparators vs op-amps'],
};

const CHECK_QUESTIONS: Record<string, string> = {
  'ohms-law': 'Quick check: if you double the voltage across a fixed resistor, what happens to the current?',
  'voltage-divider': 'Quick check: if you halve the BOTTOM resistor\'s value, does Vout go up or down?',
  'capacitor-basics': 'Quick check: after 5 time constants, roughly what fraction of the final voltage is on the capacitor?',
  'inductor-basics': 'Quick check: when you suddenly open a switch in an inductor circuit, what does the inductor try to do?',
  'led-current-limiting': 'Quick check: raising the series resistor from 220 Ω to 470 Ω — does LED current rise or fall?',
  '555-timer': 'Quick check: in an astable, which resistor(s) set how long the output is LOW?',
  'opamp-basics': 'Quick check: in a negative-feedback amplifier, what is the op-amp trying to keep equal?',
  'transistor-basics': 'Quick check: to turn an NPN switch OFF, what do you do to its base?',
};

export function buildLeveledExplanation(topicQuery: string, level: ExplainLevel): LeveledExplanation | null {
  // Find the article: exact id first, then a RELEVANCE-CHECKED search
  // (body-text matches alone are too loose — "warp drive" must not resolve
  // to an article that merely mentions "drives" in a paragraph).
  let article: KBArticle | null | undefined = getArticle(topicQuery.toLowerCase().trim());
  if (!article) {
    const q = topicQuery.toLowerCase().trim();
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    const results = searchArticles(topicQuery, 5);
    article = results.find((a) => {
      const titleTagsId = (a.title + ' ' + a.tags.join(' ') + ' ' + a.id).toLowerCase();
      // accept if the full query matches, or any query word hits title/tags/id
      return titleTagsId.includes(q) || words.some((w) => titleTagsId.includes(w));
    }) ?? null;
  }
  if (!article) return null;

  const example = workedExampleFor(article.id) ?? undefined;
  const analogy = ANALOGIES[article.id];
  const mistakes = MISTAKES[article.id] ?? [];
  const next = NEXT_STEPS[article.id] ?? [];
  const check = CHECK_QUESTIONS[article.id]
    ?? `Quick check: in one sentence, how would you explain "${article.title}" to a friend?`;

  return {
    topic: article.id,
    level,
    title: article.title,
    definition: article.summary,
    analogy,
    coreFormula: example?.formula,
    workedExample: example,
    commonMistakes: mistakes,
    goToNext: next,
    checkUnderstanding: check,
    relatedTopics: article.related ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Quiz generation — deterministic (seeded), numeric answers from real formulas
// ─────────────────────────────────────────────────────────────────────────────

export interface QuizQuestion {
  kind: 'formula' | 'numeric' | 'concept';
  question: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
}

/** Deterministic LCG — same seed, same quiz. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffleWithAnswer<T>(items: T[], answer: T, rng: () => number): { choices: T[]; answerIndex: number } {
  // Dedupe: keep the answer, drop duplicates and near-identical items.
  const seen = new Set<string>([String(answer)]);
  const wrong: T[] = [];
  for (const item of items) {
    if (String(item) === String(answer)) continue;
    if (seen.has(String(item))) continue; // duplicate distractor
    seen.add(String(item));
    wrong.push(item);
  }
  const picked = [answer];
  // pick 3 wrong answers (or fewer if not enough)
  while (picked.length < 4 && wrong.length > 0) {
    const idx = Math.floor(rng() * wrong.length);
    picked.push(wrong.splice(idx, 1)[0]);
  }
  // shuffle
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return { choices: picked, answerIndex: picked.indexOf(answer) };
}

const FORMULA_BANK: Array<{ topic: string; question: string; correct: string; wrong: string[]; why: string }> = [
  { topic: 'ohms-law', question: 'Which law relates voltage, current and resistance?', correct: 'V = I·R', wrong: ['P = V·I', 'Q = C·V', 'X_L = 2πfL'], why: 'Ohm\'s law: the voltage across a resistance equals current times resistance.' },
  { topic: 'voltage-divider', question: 'What is the output of a resistor divider (Vin, R1 top, R2 bottom)?', correct: 'Vout = Vin·R2/(R1+R2)', wrong: ['Vout = Vin·R1/(R1+R2)', 'Vout = Vin·(R1+R2)/R2', 'Vout = Vin/2 always'], why: 'The bottom resistor takes the fraction of the total resistance that matches its share of the voltage.' },
  { topic: 'capacitor-basics', question: 'What does an RC time constant equal?', correct: 'τ = R·C', wrong: ['τ = R/C', 'τ = C/R', 'τ = 1/(RC)'], why: 'One time constant is R·C seconds; the capacitor reaches ~63% then.' },
  { topic: 'inductor-basics', question: 'What is the reactance of an inductor?', correct: 'X_L = 2πfL', wrong: ['X_L = 1/(2πfL)', 'X_C = 1/(2πfC)', 'X_L = f/L'], why: 'Inductive reactance grows with frequency (opposite of a capacitor).' },
  { topic: '555-timer', question: 'What sets the frequency of a 555 astable?', correct: 'f = 1/(ln2·(R1+2R2)·C)', wrong: ['f = 1/(RC)', 'f = R/C', 'f = (R1+R2)/(2C)'], why: 'Charge runs through R1+R2, discharge through R2 only — hence the asymmetric ln2(R1+2R2)C period.' },
  { topic: 'opamp-basics', question: 'What is the gain of an inverting op-amp stage?', correct: '−Rf/Rin', wrong: ['1 + Rf/Rin', 'Rf/Rin (no sign)', 'Rin/Rf'], why: 'The minus sign is the phase inversion; magnitude is the resistor ratio.' },
  { topic: 'diode-basics', question: 'About how much forward voltage does a silicon diode drop?', correct: '≈ 0.7 V', wrong: ['≈ 0.2 V', '≈ 1.8 V', '≈ 3.3 V'], why: 'Silicon junctions conduct around 0.6–0.7 V; Schottky ~0.2–0.3 V; LEDs 1.8–3.3 V depending on color.' },
];

export function generateQuiz(topic: string, count: number, seed: number): QuizQuestion[] {
  const rng = makeRng(seed);
  const questions: QuizQuestion[] = [];

  // Numeric questions computed from real formulas — the strongest kind.
  const numericBank: Array<() => QuizQuestion> = [
    () => {
      const v = [5, 9, 12, 24][Math.floor(rng() * 4)];
      const r = [100, 470, 1000, 2200][Math.floor(rng() * 4)];
      const i = v / r;
      const { choices, answerIndex } = shuffleWithAnswer(
        [
          engFormat(i, 'A'),
          engFormat(v / (r * 2), 'A'),
          engFormat(i * 2, 'A'),
          engFormat(r / v, 'A'),
        ],
        engFormat(i, 'A'),
        rng,
      );
      return { kind: 'numeric', question: `${v} V is applied across a ${engFormat(r, 'Ω')} resistor. How much current flows?`, choices, answerIndex, explanation: `I = V/R = ${v}/${engFormat(r, 'Ω')} = ${engFormat(i, 'A')}.` };
    },
    () => {
      const vin = [5, 9, 12][Math.floor(rng() * 3)];
      const r1 = [10000, 4700][Math.floor(rng() * 2)];
      let r2 = [10000, 22000][Math.floor(rng() * 2)];
      if (r1 === r2) r2 = 22000; // equal resistors make half-supply distractors collide
      const vout = vin * r2 / (r1 + r2);
      const { choices, answerIndex } = shuffleWithAnswer(
        [
          `${vout.toFixed(2)} V`,
          `${(vin * r1 / (r1 + r2)).toFixed(2)} V`,
          `${(vin / 2).toFixed(2)} V`,
          `${(vin * r2 / r1).toFixed(2)} V`,
        ],
        `${vout.toFixed(2)} V`,
        rng,
      );
      return { kind: 'numeric', question: `A divider runs from ${vin} V with R1 = ${engFormat(r1, 'Ω')} on top and R2 = ${engFormat(r2, 'Ω')} at the bottom. Vout = ?`, choices, answerIndex, explanation: `Vout = ${vin}·${engFormat(r2, 'Ω')}/(${engFormat(r1, 'Ω')}+${engFormat(r2, 'Ω')}) = ${vout.toFixed(2)} V.` };
    },
    () => {
      const r = [10000, 47000][Math.floor(rng() * 2)];
      const c = [1e-6, 10e-6][Math.floor(rng() * 2)];
      const fc = 1 / (2 * Math.PI * r * c);
      const { choices, answerIndex } = shuffleWithAnswer(
        [
          engFormat(fc, 'Hz'),
          engFormat(fc * 10, 'Hz'),
          engFormat(fc / (2 * Math.PI), 'Hz'),
          engFormat(2 * fc, 'Hz'),
        ],
        engFormat(fc, 'Hz'),
        rng,
      );
      return { kind: 'numeric', question: `An RC low-pass uses R = ${engFormat(r, 'Ω')} and C = ${engFormat(c, 'F')}. Where is its −3 dB cutoff?`, choices, answerIndex, explanation: `fc = 1/(2πRC) = 1/(2π·${engFormat(r, 'Ω')}·${engFormat(c, 'F')}) = ${engFormat(fc, 'Hz')}.` };
    },
    () => {
      const supply = 5;
      const vf = 2.0;
      const r = [220, 330, 470][Math.floor(rng() * 3)];
      const i = (supply - vf) / r;
      const { choices, answerIndex } = shuffleWithAnswer(
        [
          engFormat(i, 'A'),
          engFormat(supply / r, 'A'),
          engFormat((supply - 1.2) / r, 'A'),
          engFormat(i / 2, 'A'),
        ],
        engFormat(i, 'A'),
        rng,
      );
      return { kind: 'numeric', question: `An LED (Vf = 2.0 V) runs from 5 V through ${engFormat(r, 'Ω')}. Current ≈ ?`, choices, answerIndex, explanation: `I = (5 − 2.0)/${engFormat(r, 'Ω')} = ${engFormat(i, 'A')} — always subtract the forward voltage first.` };
    },
  ];

  const includeTopic = topic.toLowerCase();
  const formulaPool = FORMULA_BANK.filter((f) => includeTopic === 'mixed' || f.topic.includes(includeTopic) || includeTopic.includes(f.topic));

  for (let n = 0; n < count; n++) {
    const pickFormula = rng() < 0.45 && formulaPool.length > 0;
    if (pickFormula) {
      const f = formulaPool[Math.floor(rng() * formulaPool.length)];
      const { choices, answerIndex } = shuffleWithAnswer([f.correct, ...f.wrong], f.correct, rng);
      questions.push({ kind: 'formula', question: f.question, choices, answerIndex, explanation: f.why });
    } else {
      const gen = numericBank[Math.floor(rng() * numericBank.length)];
      questions.push(gen());
    }
  }
  return questions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component recommendation — grounded in the real plugin registry
// ─────────────────────────────────────────────────────────────────────────────

export interface Recommendation {
  type: string;
  name: string;
  why: string;
  keyParameters: { label: string; value: string }[];
  /** footprint/package for PCB planning */
  footprint?: string;
  /** distributor info for ordering (best-effort from the part database) */
  mpn?: string;
  unitPrice?: number;
  datasheet?: string;
}

const RECOMMENDATION_RULES: Array<{
  useCase: string;
  label: string;
  want: string[];
  why: (name: string) => string;
}> = [
  {
    useCase: 'audio-preamp',
    label: 'audio preamplification / line-level buffering',
    want: ['opampReal', 'opamp'],
    why: (n) => `${n}: low-noise audio op-amp — the classic choice for mic/preamp stages.`,
  },
  {
    useCase: 'power-regulation-5v',
    label: 'regulated 5 V supply',
    want: ['lm7805', 'lm317', 'lm1117'],
    why: (n) => n === 'lm7805' ? 'Fixed 5 V at up to 1 A — bulletproof classic.' : n === 'lm317' ? 'Adjustable 1.25–37 V; set with two resistors.' : 'LM1117 LDO: 3.3 V/5 V with low dropout for battery projects.',
  },
  {
    useCase: 'power-regulation-3v3',
    label: 'regulated 3.3 V supply',
    want: ['lm1117', 'lt3045'],
    why: (n) => n === 'lm1117' ? 'LM1117-3.3: the standard 3.3 V LDO for logic and sensors.' : 'LT3045: ultra-low-noise LDO when clean analog rails matter.',
  },
  {
    useCase: 'switching-load',
    label: 'switching a load from logic',
    want: ['npn', 'nmos', 'relay', 'ssr', 'igbt'],
    why: (n) => n === 'npn' ? 'BJT switch: cheapest for <100 mA loads; needs a base resistor.' : n === 'nmos' ? 'Logic-level MOSFET: voltage-driven, near-zero gate current — best for higher currents.' : n === 'relay' ? 'Electromechanical relay: isolates and switches AC/mains-level loads (add a flyback diode).' : n === 'ssr' ? 'Solid-state relay: silent, fast, no contacts to wear.' : 'IGBT: high-voltage + high-current switching (motor drives, inverters).',
  },
  {
    useCase: 'led-driving',
    label: 'driving LEDs',
    want: ['resistor', 'npn', 'ws2812b', 'rgbLed'],
    why: (n) => n === 'resistor' ? 'A single series resistor is all a discrete LED needs (R = (Vsupply−Vf)/I).' : n === 'npn' ? 'Transistor lets a logic pin control high-current or many LEDs.' : n === 'ws2812b' ? 'WS2812B addressable RGB — one data pin drives long chains.' : 'RGB LED for manual color mixing with three resistors.',
  },
  {
    useCase: 'sensor-interface',
    label: 'interfacing analog sensors',
    want: ['opampReal', 'comparator', 'adc', 'mpu6050', 'ds18b20'],
    why: (n) => n === 'opampReal' ? 'Op-amp buffer (gain 1) keeps the sensor reading accurate under load.' : n === 'comparator' ? 'Comparator turns an analog threshold into a clean digital signal.' : n === 'adc' ? 'The 8-bit ADC converts a sensor voltage to a digital code.' : n === 'ds18b20' ? 'Digital temperature sensor — no analog conditioning needed, one data line.' : 'MPU-6050 IMU over I²C for motion sensing.',
  },
  {
    useCase: 'timer-oscillator',
    label: 'timing / clock generation',
    want: ['timer555', 'crystalOscillator', 'crystal', 'pll4046', 'lm565'],
    why: (n) => n === 'timer555' ? '555: from blinkies to PWM — the most forgiving timer IC ever made.' : n === 'crystalOscillator' ? 'Packaged oscillator: ready-made precise clock, just add power.' : n === 'crystal' ? 'Bare crystal + inverter gates when you need µs-accurate timing.' : n === 'pll4046' ? '74HC4046 CMOS PLL for frequency synthesis and locking.' : 'LM565 analog PLL for demodulation and tracking filters.',
  },
  {
    useCase: 'mcu-brain',
    label: 'programmable controller',
    want: ['arduinoReal', 'esp32dev', 'arduino'],
    why: (n) => n === 'arduinoReal' ? 'Arduino: run a sketch right in the simulator — blink, read pins, drive loads.' : 'ESP32 DevKit: Wi-Fi + Bluetooth; a real IoT brain with 3.3 V logic.',
  },
  {
    useCase: 'wireless-link',
    label: 'wireless communication',
    want: ['nrf24l01', 'esp32dev', 'optocoupler'],
    why: (n) => n === 'nrf24l01'
      ? 'nRF24L01: cheap 2.4 GHz SPI radios that pair with any MCU.'
      : n === 'esp32dev'
        ? 'ESP32: Wi-Fi built in — no extra radio needed.'
        : 'Optocoupler: not radio, but the classic way to pass a signal across isolation.',
  },
];

export function recommendComponents(useCase: string): Recommendation[] {
  const rule = RECOMMENDATION_RULES.find((r) => r.useCase === useCase);
  if (!rule) {
    return [];
  }
  const plugins = new Map(getAllPlugins().map((p) => [p.type, p]));
  // Best-effort part-database join for footprint/price/datasheet.
  // Static ESM import (part-database is leaf data — no cycle); the old lazy
  // require() broke under ESM test runners.
  const partDb: Array<{ mpn: string; manufacturer: string; description: string; package: string; category: string; digikeyPN?: string; mouserPN?: string; lcscPN?: string; datasheet?: string; unitPrice?: number }> = partDatabase;
  const out: Recommendation[] = [];
  for (const type of rule.want) {
    const p = plugins.get(type);
    if (!p) continue;
    const keyParameters: { label: string; value: string }[] = [];
    for (const def of p.parameters.slice(0, 4)) {
      if (def.type === 'number' && typeof def.default === 'number') {
        keyParameters.push({ label: def.label || def.key, value: engFormat(def.default, def.unit || '') });
      } else if (def.type === 'select' && def.options) {
        keyParameters.push({ label: def.label || def.key, value: def.options.slice(0, 4).join(' / ') });
      }
    }
    const part = partDb.find((q) =>
      q.description.toLowerCase().includes(p.name.toLowerCase().split(' ')[0]) ||
      p.name.toLowerCase().includes(q.mpn.toLowerCase().split('-')[0]));
    out.push({
      type, name: p.name, why: rule.why(type), keyParameters,
      footprint: p.defaultFootprint ?? part?.package,
      mpn: part?.mpn,
      unitPrice: part?.unitPrice,
      datasheet: p.datasheet ?? part?.datasheet,
    });
  }
  return out;
}

export function listUseCases(): Array<{ useCase: string; label: string }> {
  return RECOMMENDATION_RULES.map((r) => ({ useCase: r.useCase, label: r.label }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

export const conceptExplainTool: Tool = {
  name: 'concept.explain',
  category: 'Teaching',
  description:
    'Structured, level-adaptive explanation of an electronics concept. Returns definition, a physical analogy, the core formula, a WORKED EXAMPLE with exact numbers computed by the built-in calculators, common mistakes, what to learn next, and a check-understanding question. Levels: beginner (analogy-first), practitioner (formula-first), engineer (trade-offs). Use when the user asks to explain/teach/learn a concept, or after circuit.walkthrough when they want depth on a topic found in their circuit.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Concept to explain (e.g. "ohms-law", "voltage divider", "how capacitors work", "opamp"). Free text is searched against the knowledge base.' },
      level: { type: 'string', enum: ['beginner', 'practitioner', 'engineer'], description: 'Depth of the explanation (default: practitioner).' },
    },
    required: ['topic'],
  },
  execute(args: { topic: string; level?: ExplainLevel }, _ctx: ToolContext) {
    const level = (args.level ?? 'practitioner') as ExplainLevel;
    const explanation = buildLeveledExplanation(args.topic, level);
    if (!explanation) {
      return {
        ok: false,
        error: `No knowledge-base article matched "${args.topic}".`,
        result: {
          suggestion: 'Try kb.search to find a close article, or explain from your own knowledge.',
          availableTopics: KB_ARTICLES.slice(0, 40).map((a) => a.id),
        },
      };
    }
    return { ok: true, result: explanation };
  },
};

export const conceptQuizTool: Tool = {
  name: 'concept.quiz',
  category: 'Teaching',
  description:
    'Generate a multiple-choice quiz to check understanding of electronics concepts. Numeric answers are computed from the real formulas (Ohm\'s law, dividers, RC cutoffs, LED currents) — exact, not approximations. Use after explaining a concept (active recall beats re-reading), or whenever the user wants to test themselves.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Topic to focus on (e.g. "ohms-law", "555-timer") or "mixed" for anything (default mixed).' },
      count: { type: 'number', description: 'Number of questions (default 4, max 10).' },
      seed: { type: 'number', description: 'Random seed for reproducible quizzes (default 42).' },
    },
  },
  execute(args: { topic?: string; count?: number; seed?: number }, _ctx: ToolContext) {
    const topic = args.topic ?? 'mixed';
    const count = Math.max(1, Math.min(10, Math.floor(args.count ?? 4)));
    const seed = args.seed ?? 42;
    const questions = generateQuiz(topic, count, seed);
    return {
      ok: true,
      result: {
        topic,
        count: questions.length,
        // Answer key is included so the model can grade the user's replies.
        questions,
        gradingNote: 'Ask the questions one at a time, wait for the user to answer, then reveal the correct choice and explanation before moving on.',
      },
    };
  },
};

export const componentRecommendTool: Tool = {
  name: 'component.recommend',
  category: 'Teaching',
  description:
    'Recommend concrete parts from the simulator\'s actual component registry for a design use-case, with the reasoning and real default parameters. Use when the user asks "what should I use to..." (amplify a signal, regulate power, switch a load, drive LEDs, interface a sensor, generate timing, add a brain, go wireless).',
  parameters: {
    type: 'object',
    properties: {
      useCase: { type: 'string', description: 'One of the supported use-cases; call with listUseCases=true to see them all.' },
      listUseCases: { type: 'boolean', description: 'Set true to return the list of supported use-cases instead of recommendations.' },
    },
  },
  execute(args: { useCase?: string; listUseCases?: boolean }, _ctx: ToolContext) {
    if (args.listUseCases) {
      return { ok: true, result: { useCases: listUseCases() } };
    }
    const recs = recommendComponents(args.useCase ?? '');
    if (recs.length === 0) {
      return {
        ok: false,
        error: `Unknown use-case "${args.useCase}".`,
        result: { availableUseCases: listUseCases() },
      };
    }
    return { ok: true, result: { useCase: args.useCase, recommendations: recs } };
  },
};

export { getArticlesByCategory };
