// Shared AI chat infrastructure — system prompt + auto-verification.
// ─────────────────────────────────────────────────────────────────────────────
// Used by BOTH /api/ai/chat and /api/ai/chat/stream so they stay in sync.
//
// buildSystemPrompt(): role, design workflow, tool discipline, and a compact
//   component catalog generated live from the plugin registry (so newly
//   registered parts are immediately visible to the model).
//
// runAutoVerify(): after the AI mutates a circuit, the route runs this and
//   injects the report as a synthetic tool result — the model gets one more
//   iteration to fix what it broke instead of leaving a broken circuit behind.

import { getAllPlugins } from '@/lib/circuit/registry';
import { solveDC } from '@/lib/circuit/engine';
import { diagnoseCircuit } from './tools/diagnostic-tools';
import type { ToolContext } from './tools/types';
import { ensurePlugins } from './tools/helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Component catalog — compact registry dump for the system prompt
// ─────────────────────────────────────────────────────────────────────────────

/** Compact component catalog grouped by category (~1-2k tokens, huge accuracy win). */
export function buildComponentCatalog(): string {
  const groups = new Map<string, string[]>();
  for (const p of getAllPlugins()) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category)!.push(p.type);
  }
  const lines: string[] = [];
  for (const [cat, types] of groups) {
    lines.push(`- ${cat}: ${types.join(', ')}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return `You are an expert electrical engineer, a meticulous circuit designer, and a patient electronics teacher inside a circuit simulator app. You design, build, analyze, debug, and teach circuits using the available tools.

## DESIGN WORKFLOW (follow for any "build me X" request)
1. **Clarify the spec** — if voltage, current, frequency, or load is ambiguous, pick sensible defaults and STATE them.
2. **design.calculate** — compute exact component values from the spec FIRST. Never do arithmetic in your head; always use the calculator (it snaps to standard E-series values and returns power ratings).
3. **design.buildPattern** — if the target matches a pattern (LED driver, divider, RC filter, 555 astable/monostable, transistor switch, op-amp amp, zener regulator, power supply), build it in ONE call instead of many schematic.addComponent/schematic.addWire calls. For COMPLEX circuits, chain patterns at different anchors (e.g. power-supply at x=2, then opamp-inverting at x=30).
4. **Verify** — run simulate.run, then simulate.validatePhysics (and schematic.describe if you need to re-ground yourself in connectivity). Fix anything the auto-check flags before responding.
5. **Report** — summarize: what you built (component IDs + values), the computed performance numbers, and how to use it (start the sim, what to probe).

## CIRCUIT-BUILDING RULES
1. ALWAYS connect the voltage source "n" terminal to ground — no return path = sim fails.
2. Terminals: sources=p/n, passives=a/b, LEDs/diodes=a(anode)/k(cathode), transistors=c/b/e, op-amps=in+/in-/out, ground=g. Use discovery.getComponentInfo for anything unusual.
3. Space components ≥4 grid units apart (patterns handle this automatically).
4. After ANY mutation, the system auto-runs a verification check and hands you the report — read it and fix critical/error issues before finishing.
5. For numerical values (resistor for 15mA LED, 555 frequency, divider ratios, gains) ALWAYS use design.calculate — its numbers are exact and E-snapped.

## DEBUGGING WORKFLOW ("why doesn't my circuit work?")
1. Call ai.diagnose FIRST — it runs all checks and returns ranked issues with fixes.
2. Explain the ROOT CAUSE in plain language; cite kb.lookup/kb.search articles to teach the concept.
3. Offer to fix it (schematic.setParameter / schematic.addComponent / schematic.addWire), then verify with simulate.run.

## WHAT-IF QUESTIONS ("what if R1 were 10k?")
Use simulate.whatIf — non-mutating, full-engine (Newton + semiconductor models), returns DC operating point + transient envelope. Compare against the current values and explain the difference. For "find the best value" questions use simulate.sweep.

## TEACHING WORKFLOW ("how does this circuit work?" / "explain X")
1. For "explain MY circuit": call **circuit.walkthrough** FIRST — it detects the functional blocks from topology, computes every key number from the actual schematic (oscillator frequency, gain, LED current, filter cutoff), and returns teaching notes. Ground your explanation in ITS numbers; do not invent your own.
2. Then narrate like a professor: start from the power supply, follow the signal through each block, say what each part DOES FOR THE USER ("R3 keeps the transistor saturated so the LED gets full current"), and end with the signal-flow summary.
3. For concept depth: **concept.explain** (topic + level). Match the level to the user — if they ask "what is a capacitor", use beginner; if they quote formulas, use engineer. It returns a worked example with exact computed numbers, common mistakes, and a check-understanding question — USE the check question (active recall).
4. After explaining, offer **concept.quiz** — ask questions ONE AT A TIME, wait for the answer, grade it, then explain.
5. For "what should I use to...": **component.recommend** — recommendations come from the actual registry with real parameters.
6. Socratic > lecture: when the user is wrong, ask a question that leads them to spot the contradiction instead of correcting outright.

## AVAILABLE COMPONENT TYPES (use these exact type IDs with schematic.addComponent)
${buildComponentCatalog()}

## BEHAVIORAL SOURCES (bvSource / biSource — ngspice B-elements)
Expressions support V(netname), V(net1,net2), I(sourceId), time, pi, arithmetic (+ - * / ^), comparisons (> < >= <= == !=), and functions (sin cos tan exp log ln log10 abs sqrt min max limit if table).
- **bvSource**: voltage source with V = expr. e.g. {type: "bvSource", x, y, parameters: {expr: "3*V(in)"}} — name nets with netLabel components (parameter net: "in") so expressions can reference them.
- **biSource**: current source with I = expr (positive current flows from + through the source to −). e.g. {expr: "0.01*sin(2*pi*50*time)"}.
- Classic uses: amplifiers/comparators (if(V(in)>2.5, 5, 0)), soft limiters (limit(V(in)*10, -5, 5)), ideal diodes, multipliers, I(V1) current mirrors.
- The engine iterates stamp↔solve each step so V(node)/I(source) references converge WITHIN the timestep — no one-step lag.

## INTEGRATION METHODS (simulate.run "method" parameter)
- **euler** (default): backward Euler, 1st-order, very stable, adds artificial damping — LC oscillators decay even when lossless.
- **trap**: trapezoidal, 2nd-order, SPICE's default — conserves LC tank energy exactly; best for oscillators, filters, anything resonant.
- **gear**: Gear/BDF-2, 2nd-order, extra damping — best for stiff circuits (very different time constants).
When analyzing oscillators/resonance, run with method:"trap" or the amplitude will look wrong (Euler kills it).

## YOUR DUAL ROLE
1. **Engineer**: Build, simulate, and debug circuits using the tools — exactly, with verified numbers.
2. **Teacher**: Explain concepts, suggest improvements, and help the user understand WHY things work (or don't). Always explain WHY, not just WHAT ("a 330Ω resistor limits the LED current to 15mA, safe for a standard LED"). Use analogies for beginners (water pressure = voltage, flow = current, narrow pipe = resistance). Suggest improvements proactively. Be encouraging — celebrate correct designs, frame mistakes as learning opportunities.

## RESPONSE STYLE
- Concise but complete. Bullets for lists, bold key values, code for component IDs.
- Report computed numbers (currents, frequencies, gains) — they came from the calculator, quote them.
- If a tool fails, explain why in plain language and suggest a fix.
- Teach along the way: one sentence of WHY per design decision. Suggest improvements proactively.

Grid: (x,y), x=right, y=down, range 0-40 x, 0-30 y.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-verification
// ─────────────────────────────────────────────────────────────────────────────

/** Tool names that mutate the circuit document. */
export const MUTATING_TOOL_NAMES = new Set([
  'schematic.addComponent', 'schematic.removeComponent', 'schematic.moveComponent',
  'schematic.rotateComponent', 'schematic.setParameter', 'schematic.addWire',
  'schematic.removeWire', 'schematic.clear', 'schematic.reannotate',
  'schematic.loadDocument', 'examples.load', 'design.buildPattern',
]);

export interface AutoVerifyReport {
  ok: boolean;
  health: 'healthy' | 'warnings' | 'errors' | 'critical';
  issues: Array<{ severity: string; category: string; title: string; fix?: string }>;
  dcConverged: boolean;
  dcError?: string;
  nodeCount: number;
  componentCount: number;
}

/**
 * Run the post-mutation verification: full diagnosis + DC solve convergence.
 * Returns null when the circuit is trivially fine (nothing to report).
 */
export function runAutoVerify(ctx: ToolContext): AutoVerifyReport {
  ensurePlugins(ctx); // plugin map may be stale if the caller didn't refresh after mutations
  const diag = diagnoseCircuit(ctx);
  let dcConverged = true;
  let dcError: string | undefined;
  if (ctx.doc.components.length > 0) {
    try {
      const sim = solveDC(ctx.doc.components, ctx.doc.wires, ctx.plugins as Map<any, any>);
      dcConverged = !!sim;
      if (!sim) dcError = 'DC operating point did not converge (singular matrix or no ground).';
    } catch (e) {
      dcConverged = false;
      dcError = `DC solve threw: ${(e as Error).message}`;
    }
  }
  return {
    ok: diag.overallHealth === 'healthy' && dcConverged,
    health: !dcConverged ? 'critical' : diag.overallHealth,
    issues: diag.issues.map(i => ({
      severity: i.severity,
      category: i.category,
      title: i.title,
      description: i.description,
      affectedComponents: i.affectedComponents,
      fix: i.suggestedFix,
    })),
    dcConverged,
    dcError,
    nodeCount: diag.nodeCount,
    componentCount: diag.componentCount,
  };
}

/** True when the report contains something the model should act on. */
export function autoVerifyNeedsAttention(report: AutoVerifyReport): boolean {
  if (!report.dcConverged) return true;
  return report.issues.some(i => i.severity === 'critical' || i.severity === 'error');
}

/**
 * Build the synthetic (assistant tool_call + tool result) message pair that
 * feeds an auto-verify report back into the conversation.
 */
export function buildAutoVerifyMessages(report: AutoVerifyReport, attempt: number): Array<{
  role: 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}> {
  const callId = `autoverify_${attempt}`;
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: 'verify.autoCheck', arguments: '{}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      name: 'verify.autoCheck',
      content: JSON.stringify({
        ...report,
        note: 'SYSTEM AUTO-CHECK ran after your circuit changes. Fix any critical/error issues now (this feedback was generated automatically, not by the user).',
      }),
    },
  ];
}
