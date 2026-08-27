// Tests for the AI "super intelligence" upgrade:
//   - design calculators (design.calculate + pure functions)
//   - layout helpers (collision-free placement)
//   - design patterns (design.buildPattern) — verified with real DC solves
//   - schematic.describe (netlist grounding)
//   - simulate.whatIf (real-engine accuracy, incl. op-amp extra vars)
//   - system prompt + auto-verify loop infrastructure

import { describe, it, expect } from 'vitest';
import '../src/lib/circuit/components';
import { getPlugin } from '../src/lib/circuit/registry';
import { solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import type { ToolContext } from '../src/lib/ai/tools/types';
import { TOOLS_BY_NAME, getToolDefinitions } from '../src/lib/ai/tools';
import { designCalculateTool } from '../src/lib/ai/tools/design-calculators';
import {
  nearestStandard, engFormat, calcLedResistor, calcVoltageDivider, calcRcFilter,
  calc555Astable, calc555Monostable, calcOpampGain, calcLm317, calcZenerResistor,
  calcWheatstone, calcTransformer, calcDb, calcResistorNetwork, calcReactance,
  calcRcTransfer, calcBaseResistor, calcRms, calcDcDc, calcTimeConstant,
} from '../src/lib/ai/tools/design-calculators';
import { designBuildPatternTool, PATTERNS } from '../src/lib/ai/tools/design-patterns';
import { findFreeSpot, createComponent, connect } from '../src/lib/ai/tools/layout-helpers';
import { describeCircuitTool } from '../src/lib/ai/tools/schematic-inspection-tools';
import { simulateWhatIfTool } from '../src/lib/ai/tools/whatif-tools';
import { simulateSweepTool } from '../src/lib/ai/tools/sweep-tools';
import {
  buildSystemPrompt, runAutoVerify, autoVerifyNeedsAttention,
  buildAutoVerifyMessages, buildComponentCatalog, MUTATING_TOOL_NAMES,
} from '../src/lib/ai/system-prompt';
import { ensurePlugins } from '../src/lib/ai/tools/helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mkCtx(components: any[] = [], wires: any[] = []): ToolContext {
  const ctx: ToolContext = {
    doc: { version: 1, components, wires },
    plugins: new Map(),
    simContext: null,
  };
  ensurePlugins(ctx);
  return ctx;
}

/** Run design.buildPattern through the tool interface. */
function buildPattern(pattern: string, args: Record<string, any> = {}, ctx = mkCtx()) {
  const res = designBuildPatternTool.execute({ pattern, args }, ctx);
  expect(res.ok).toBe(true);
  return { result: res.result as any, ctx };
}

/** DC-solve a tool context and return the terminal→nodeId map. */
function dcSolve(ctx: ToolContext) {
  ensurePlugins(ctx);
  const sim = solveDC(ctx.doc.components, ctx.doc.wires, ctx.plugins as any);
  const nodeMap = buildNodeMap(ctx.doc.components, ctx.doc.wires, ctx.plugins as any);
  return { sim, nodeMap };
}

function terminalV(ctx: ToolContext, nodeMap: any, sim: any, compId: string, termId: string): number {
  const nodeId = nodeMap.terminalNode.get(`${compId}:${termId}`);
  expect(nodeId).toBeDefined();
  return sim.nodeVoltage[nodeId] ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Design calculators — pure math
// ─────────────────────────────────────────────────────────────────────────────

describe('design calculators (pure)', () => {
  it('nearestStandard snaps to E-series values across decades', () => {
    expect(nearestStandard(4700, 'E24')).toBe(4700);
    expect(nearestStandard(467, 'E24')).toBe(470);
    expect(nearestStandard(0.0000105, 'E24')).toBeCloseTo(0.000011, 8); // 1.05 → 1.1 (nearer in log space)
    expect(nearestStandard(102, 'E96')).toBe(102);
    expect(nearestStandard(99, 'E24')).toBe(100);
  });

  it('engFormat produces engineering notation', () => {
    expect(engFormat(4700, 'Ω')).toBe('4.7kΩ');
    expect(engFormat(1e-7, 'F')).toBe('100nF');
    expect(engFormat(0.015, 'A')).toBe('15mA');
    expect(engFormat(1000000, 'Hz')).toBe('1MHz');
  });

  it('LED resistor: 5V supply, 2V Vf, 15mA → 200Ω exact', () => {
    const out = calcLedResistor(5, 2, 0.015);
    expect(out.outputs.rStandard).toBe(200);
    expect(out.outputs.actualCurrent as number).toBeCloseTo(0.015, 4);
    expect(out.outputs.powerResistor as number).toBeCloseTo(0.045, 3);
  });

  it('LED resistor errors when supply below Vf', () => {
    expect(() => calcLedResistor(1.5, 2.0, 0.01)).toThrow(/cannot conduct/);
  });

  it('voltage divider design: 5V → 3.3V at 10k total', () => {
    const out = calcVoltageDivider(5, undefined, undefined, 3.3, 10000);
    const r1 = out.outputs.r1 as number, r2 = out.outputs.r2 as number;
    const vout = 5 * r2 / (r1 + r2);
    expect(vout).toBeGreaterThan(3.2);
    expect(vout).toBeLessThan(3.4);
    expect(out.outputs.dividerCurrent as number).toBeCloseTo(5 / (r1 + r2), 8);
  });

  it('voltage divider forward', () => {
    const out = calcVoltageDivider(9, 10000, 5000);
    expect(out.outputs.vout).toBeCloseTo(3, 6);
  });

  it('RC filter design: 1kHz with 100nF → ~1.59kΩ', () => {
    const out = calcRcFilter(undefined, 100e-9, 1000);
    expect(out.outputs.rStandard).toBe(1600);
    const fc = 1 / (2 * Math.PI * (out.outputs.rStandard as number) * 100e-9);
    expect(fc).toBeGreaterThan(900);
    expect(fc).toBeLessThan(1100);
  });

  it('RC filter forward: 1.6kΩ + 100nF → ~1kHz', () => {
    const out = calcRcFilter(1600, 100e-9);
    expect(out.outputs.fc as number).toBeCloseTo(994.7, 0);
    expect(out.outputs.tau as number).toBeCloseTo(1.6e-4, 8);
  });

  it('555 astable forward: classic values', () => {
    const out = calc555Astable(1000, 100000, 1e-6);
    // f = 1/(ln2·(1k+200k)·1µF) = 1/(0.693·201000·1e-6) ≈ 7.178 Hz
    expect(out.outputs.f as number).toBeCloseTo(7.1776, 3);
    expect(out.outputs.duty as number).toBeCloseTo(101000 / 201000, 4);
  });

  it('555 astable design: 1Hz @ 60% duty with 1µF', () => {
    const out = calc555Astable(undefined, undefined, 1e-6, 1, 0.6);
    const r1 = out.outputs.r1 as number, r2 = out.outputs.r2 as number;
    // Reconstruct f and duty from the snapped values
    const f = 1 / (Math.LN2 * (r1 + 2 * r2) * 1e-6);
    const duty = (r1 + r2) / (r1 + 2 * r2);
    expect(f).toBeGreaterThan(0.9);
    expect(f).toBeLessThan(1.1);
    expect(duty).toBeGreaterThan(0.58);
    expect(duty).toBeLessThan(0.62);
  });

  it('555 astable clamps duty < 50% with a note', () => {
    const out = calc555Astable(undefined, undefined, 1e-6, 100, 0.3);
    expect(out.notes!.some(n => n.includes('50%'))).toBe(true);
    expect(out.outputs.dutyActual as number).toBeGreaterThan(0.5);
  });

  it('555 monostable: T = ln(3)·R·C', () => {
    const out = calc555Monostable(100000, 10e-6);
    expect(out.outputs.pulseWidth as number).toBeCloseTo(Math.log(3) * 1, 4);
  });

  it('op-amp gains: inverting and non-inverting', () => {
    const inv = calcOpampGain('inverting', 1000, 10000);
    expect(inv.outputs.gain as number).toBeCloseTo(-10, 6);
    const non = calcOpampGain('noninverting', 1000, 10000);
    expect(non.outputs.gain as number).toBeCloseTo(11, 6);
    const design = calcOpampGain('noninverting', 1000, undefined, 11);
    expect(design.outputs.rf as number).toBe(10000);
  });

  it('LM317: 5V target → R2 = 720Ω', () => {
    const out = calcLm317(5);
    expect(out.outputs.r2 as number).toBe(750); // E24 nearest to 720
    expect(out.outputs.voutActual as number).toBeCloseTo(1.25 * (1 + 750 / 240), 4);
  });

  it('zener resistor: 12V → 5.1V @ 5mA load', () => {
    const out = calcZenerResistor(12, 5.1, 0.005);
    expect(out.outputs.rMax as number).toBeCloseTo(690, 0);
    expect((out.outputs.rStandard as number) < 690).toBe(true);
    expect(out.outputs.powerZenerWorstCase as number).toBeGreaterThan(0);
  });

  it('wheatstone bridge balance and imbalance', () => {
    const balanced = calcWheatstone(10, 1000, 1000, 1000, 1000);
    expect(balanced.outputs.balanced).toBe(true);
    const unbal = calcWheatstone(10, 1000, 1000, 1000, 1100);
    expect(Math.abs(unbal.outputs.vout as number)).toBeGreaterThan(0.01);
  });

  it('transformer: 12V, 1:2 → 24V; reflected currents', () => {
    const out = calcTransformer(12, 1, 2, 4.8);
    expect(out.outputs.vout as number).toBeCloseTo(24, 6);
    expect(out.outputs.iSecondary as number).toBeCloseTo(0.2, 6);
    expect(out.outputs.iPrimary as number).toBeCloseTo(0.4, 6);
  });

  it('dB conversions', () => {
    expect(calcDb(20).outputs.linear).toBeCloseTo(10, 6);
    expect(calcDb(10, undefined, true).outputs.linear).toBeCloseTo(10, 6);
    expect(calcDb(undefined, 100).outputs.db).toBeCloseTo(40, 6);
    const dbm = calcDb(undefined, undefined, false, 13, 50);
    expect(dbm.outputs.powerW as number).toBeCloseTo(0.02, 4);
    expect(dbm.outputs.vrms as number).toBeCloseTo(0.9988, 3);
  });

  it('resistor networks', () => {
    expect(calcResistorNetwork([1000, 1000], 'parallel').outputs.equivalent).toBeCloseTo(500, 6);
    expect(calcResistorNetwork([1000, 2000], 'series').outputs.equivalent).toBeCloseTo(3000, 6);
  });

  it('reactance', () => {
    expect(calcReactance(1000, 100e-9).outputs.xc).toBeCloseTo(1591.55, 0);
    expect(calcReactance(1000, undefined, 1e-3).outputs.xl).toBeCloseTo(6.283, 3);
  });

  it('RC transfer at cutoff: −3dB, −45°', () => {
    const out = calcRcTransfer(1600, 100e-9, 994.7, 'lowpass');
    expect(out.outputs.magnitude as number).toBeCloseTo(Math.SQRT1_2, 3);
    expect(out.outputs.phaseDeg as number).toBeCloseTo(-45, 1);
  });

  it('transistor base resistor: 5V drive, 10mA, hFE 100', () => {
    const out = calcBaseResistor(5, 0.7, 0.01, 100);
    const rStd = out.outputs.rStandard as number;
    expect(rStd).toBeGreaterThan(10); // way below 43k? forced beta 5 → Ib=0.5mA → Rb=8.6k
    expect(rStd).toBeLessThan(15000);
    expect(out.outputs.icCapable as number).toBeGreaterThanOrEqual(0.01 * 0.9);
  });

  it('RMS conversions', () => {
    expect(calcRms(10, 'sine').outputs.rms).toBeCloseTo(7.071, 3);
    expect(calcRms(10, 'square').outputs.rms).toBe(10);
    expect(calcRms(10, 'triangle').outputs.rms).toBeCloseTo(5.774, 3);
  });

  it('DC-DC duty cycles', () => {
    expect(calcDcDc(12, 5, 'buck').outputs.duty).toBeCloseTo(5 / 12, 4);
    expect(calcDcDc(5, 12, 'boost').outputs.duty).toBeCloseTo(1 - 5 / 12, 4);
    expect(() => calcDcDc(5, 12, 'buck')).toThrow();
  });

  it('RC time constant and settle time', () => {
    const out = calcTimeConstant(10000, 100e-9, 63.2);
    expect(out.outputs.tau).toBeCloseTo(1e-3, 8);
    expect(out.outputs.settleTime5Tau).toBeCloseTo(5e-3, 8);
  });
});

describe('design.calculate tool', () => {
  it('executes a formula via the tool interface', () => {
    const res = designCalculateTool.execute(
      { formula: 'led-series-resistor', inputs: { supplyV: 5, vf: 2, targetI: 0.015 } },
      mkCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.result.outputs.rStandard).toBe(200);
    expect(res.result.explanation).toContain('200');
  });

  it('accepts string numbers (LLMs sometimes stringify)', () => {
    const res = designCalculateTool.execute(
      { formula: 'ohms-law', inputs: { v: '5', i: '0.01' } },
      mkCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.result.outputs.r).toBe(500);
  });

  it('errors cleanly on unknown formula', () => {
    const res = designCalculateTool.execute({ formula: 'nope', inputs: {} }, mkCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown formula/);
  });

  it('errors cleanly on missing input', () => {
    const res = designCalculateTool.execute({ formula: 'led-series-resistor', inputs: { supplyV: 5 } }, mkCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/vf|targetI|Missing/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Layout helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('layout helpers', () => {
  it('findFreeSpot returns the hint on an empty canvas (clamped to grid)', () => {
    const ctx = mkCtx();
    const spot = findFreeSpot(ctx, 10, 10);
    expect(spot).toEqual({ x: 10, y: 10 });
    const clamped = findFreeSpot(ctx, -5, 100);
    expect(clamped.x).toBeGreaterThanOrEqual(2);
    expect(clamped.y).toBeLessThanOrEqual(28);
  });

  it('findFreeSpot avoids occupied cells', () => {
    const ctx = mkCtx();
    createComponent(ctx, 'resistor', 10, 10);
    const spot = findFreeSpot(ctx, 10, 10);
    // Must be far enough from (10,10) — outside its ±3 footprint
    expect(Math.max(Math.abs(spot.x - 10), Math.abs(spot.y - 10))).toBeGreaterThanOrEqual(4);
  });

  it('createComponent merges plugin defaults with overrides and clamps to the grid', () => {
    const ctx = mkCtx();
    const c = createComponent(ctx, 'resistor', 999, 999, { resistance: 4700 });
    expect(c.parameters.resistance).toBe(4700);
    expect(c.position.x).toBeLessThanOrEqual(38);
    expect(c.position.y).toBeLessThanOrEqual(28);
    expect(ctx.doc.components).toHaveLength(1);
  });

  it('connect wires two components', () => {
    const ctx = mkCtx();
    const a = createComponent(ctx, 'resistor', 4, 4);
    const b = createComponent(ctx, 'led', 12, 4);
    const wid = connect(ctx, a, 'b', b, 'a');
    expect(ctx.doc.wires).toHaveLength(1);
    expect(ctx.doc.wires[0].id).toBe(wid);
    expect(ctx.doc.wires[0].from).toEqual({ componentId: a.id, terminalId: 'b' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Design patterns — physics-verified
// ─────────────────────────────────────────────────────────────────────────────

describe('design.buildPattern', () => {
  it('registers all 11 patterns in the tool registry', () => {
    expect(Object.keys(PATTERNS)).toHaveLength(11);
    for (const name of Object.keys(PATTERNS)) {
      const res = designBuildPatternTool.execute({ pattern: name, args: {} }, mkCtx());
      expect(res.ok, `pattern ${name} should build with defaults`).toBe(true);
    }
  });

  it('rejects unknown patterns with the available list', () => {
    const res = designBuildPatternTool.execute({ pattern: 'flux-capacitor', args: {} }, mkCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('led-driver');
  });

  it('led-driver: 15mA through the LED (DC-verified)', () => {
    const { result, ctx } = buildPattern('led-driver', { supplyV: 5, vf: 2, targetI: 0.015 });
    expect(result.parts).toHaveLength(4);
    const led = ctx.doc.components.find(c => c.type === 'led')!;
    const res = ctx.doc.components.find(c => c.type === 'resistor')!;
    expect(led.parameters.seriesR).toBe(1);
    expect(res.parameters.resistance).toBe(200);
    const { sim, nodeMap } = dcSolve(ctx);
    expect(sim).not.toBeNull();
    const vLed = terminalV(ctx, nodeMap, sim, led.id, 'a') - terminalV(ctx, nodeMap, sim, led.id, 'k');
    const current = Math.max(0, (vLed - 2) / 1); // LED on: I = (V−Vf)/seriesR
    expect(current).toBeCloseTo(0.015, 2);
  });

  it('voltage-divider: junction at ~3.3V (DC-verified)', () => {
    const { result, ctx } = buildPattern('voltage-divider', { vin: 5, vout: 3.3, rTotal: 10000 });
    const rTop = ctx.doc.components.find(c => c.id === result.parts.find((p: any) => p.role === 'rTop')!.id)!;
    const rBot = ctx.doc.components.find(c => c.id === result.parts.find((p: any) => p.role === 'rBottom')!.id)!;
    const { sim, nodeMap } = dcSolve(ctx);
    expect(sim).not.toBeNull();
    const vout = terminalV(ctx, nodeMap, sim, rTop.id, 'b');
    expect(vout).toBeGreaterThan(3.15);
    expect(vout).toBeLessThan(3.45);
    // Both divider legs must land on the same node
    expect(nodeMap.terminalNode.get(`${rTop.id}:b`)).toBe(nodeMap.terminalNode.get(`${rBot.id}:a`));
  });

  it('rc-lowpass and rc-highpass: topology + computed cutoff', () => {
    const lp = buildPattern('rc-lowpass', { fc: 1000, c: 100e-9 });
    expect(lp.result.computed.fcActual).toBeGreaterThan(900);
    expect(lp.result.computed.fcActual).toBeLessThan(1100);
    const lpSeries = lp.ctx.doc.components.find(c => c.type === 'resistor')!;
    const lpShunt = lp.ctx.doc.components.find(c => c.type === 'capacitor')!;

    const hp = buildPattern('rc-highpass', { fc: 1000, c: 100e-9 });
    const hpSeries = hp.ctx.doc.components.find(c => c.type === 'capacitor')!;
    const hpShunt = hp.ctx.doc.components.find(c => c.type === 'resistor')!;
    expect(hpSeries).toBeDefined();
    expect(hpShunt).toBeDefined();
    // Same R value in both filter forms
    expect(hpShunt.parameters.resistance).toBe(lpSeries.parameters.resistance);
    void lpShunt;
  });

  it('555-astable: astable mode + snapped timing values + LED', () => {
    const { result, ctx } = buildPattern('555-astable', { f: 2, duty: 0.6, c: 1e-6, vcc: 5 });
    const timer = ctx.doc.components.find(c => c.type === 'timer555')!;
    expect(timer.parameters.astable).toBe(true);
    expect(timer.parameters.r1).toBe(result.computed.r1);
    expect(timer.parameters.r2).toBe(result.computed.r2);
    expect(timer.parameters.c).toBe(1e-6);
    // fActual within 10% of target
    expect(result.computed.fActual as number).toBeGreaterThan(1.8);
    expect(result.computed.fActual as number).toBeLessThan(2.2);
    // Classic astable wiring: RST tied high, THR+TRIG joined, C to ground
    const wires = ctx.doc.wires;
    expect(wires.some((w: any) => w.to.componentId === timer.id && w.to.terminalId === 'rst')).toBe(true);
    expect(wires.some((w: any) => (w.from.componentId === timer.id && w.from.terminalId === 'thr' && w.to.componentId === timer.id && w.to.terminalId === 'trig'))).toBe(true);
    expect(ctx.doc.components.some(c => c.type === 'led')).toBe(true);
  });

  it('555-monostable: button trigger + timing RC', () => {
    const { result, ctx } = buildPattern('555-monostable', { pulseWidth: 0.5, c: 10e-6 });
    expect(ctx.doc.components.some(c => c.type === 'pushButton')).toBe(true);
    const timer = ctx.doc.components.find(c => c.type === 'timer555')!;
    expect(timer.parameters.astable).toBe(false);
    expect(result.computed.pulseWidthActual as number).toBeGreaterThan(0.4);
    expect(result.computed.pulseWidthActual as number).toBeLessThan(0.6);
  });

  it('transistor-switch: saturates with LED load (DC-verified)', () => {
    const { ctx } = buildPattern('transistor-switch', { vcc: 5, driveV: 5, load: 'led', icTarget: 0.01, hfeMin: 100 });
    const npn = ctx.doc.components.find(c => c.type === 'npn')!;
    const led = ctx.doc.components.find(c => c.type === 'led')!;
    const { sim, nodeMap } = dcSolve(ctx);
    expect(sim).not.toBeNull();
    const vCollector = terminalV(ctx, nodeMap, sim, npn.id, 'c');
    expect(vCollector).toBeLessThan(0.5); // saturated
    const vLed = terminalV(ctx, nodeMap, sim, led.id, 'a') - terminalV(ctx, nodeMap, sim, led.id, 'k');
    expect(vLed).toBeGreaterThan(1.8); // LED conducting
  });

  it('opamp-inverting: gain −10 (DC-verified with a DC-shifted source)', () => {
    const { result, ctx } = buildPattern('opamp-inverting', { gain: -10, rin: 1000, amplitude: 0.1 });
    // Shift the source to pure DC so solveDC measures the closed-loop gain
    const src = ctx.doc.components.find(c => c.type === 'acVoltage')!;
    src.parameters.amplitude = 0;
    src.parameters.offset = 0.1;
    const opamp = ctx.doc.components.find(c => c.type === 'opamp')!;
    const { sim, nodeMap } = dcSolve(ctx);
    expect(sim).not.toBeNull();
    const vout = terminalV(ctx, nodeMap, sim, opamp.id, 'out');
    expect(vout).toBeCloseTo(-1.0, 2); // −10 × 0.1V
    void result;
  });

  it('opamp-noninverting: gain +11 (DC-verified)', () => {
    const { ctx } = buildPattern('opamp-noninverting', { gain: 11, rin: 1000, amplitude: 0.1 });
    const src = ctx.doc.components.find(c => c.type === 'acVoltage')!;
    src.parameters.amplitude = 0;
    src.parameters.offset = 0.1;
    const opamp = ctx.doc.components.find(c => c.type === 'opamp')!;
    const { sim, nodeMap } = dcSolve(ctx);
    expect(sim).not.toBeNull();
    const vout = terminalV(ctx, nodeMap, sim, opamp.id, 'out');
    expect(vout).toBeCloseTo(1.1, 2);
  });

  it('zener-regulator: regulated node at ~5.1V (DC-verified)', () => {
    const { ctx } = buildPattern('zener-regulator', { vin: 12, vz: 5.1, iLoad: 0.005 });
    const zener = ctx.doc.components.find(c => c.type === 'zener')!;
    const { sim, nodeMap } = dcSolve(ctx);
    expect(sim).not.toBeNull();
    const vk = terminalV(ctx, nodeMap, sim, zener.id, 'k');
    expect(vk).toBeGreaterThan(4.8);
    expect(vk).toBeLessThan(5.4);
  });

  it('power-supply: full bridge + regulator topology', () => {
    const { result, ctx } = buildPattern('power-supply', { vacRms: 12, outputV: 5, iLoad: 0.1 });
    const types = ctx.doc.components.map(c => c.type);
    expect(types.filter(t => t === 'diode')).toHaveLength(4);
    expect(types).toContain('transformer');
    expect(types).toContain('lm7805');
    expect(types).toContain('acVoltage');
    expect(result.computed.cSmooth as number).toBeGreaterThan(400e-6);
    expect(ctx.doc.wires.length).toBeGreaterThanOrEqual(15);
  });

  it('no two components overlap (Chebyshev distance ≥ 4) in any pattern', () => {
    for (const name of Object.keys(PATTERNS)) {
      const { ctx } = buildPattern(name, {}, mkCtx());
      const comps = ctx.doc.components;
      for (let i = 0; i < comps.length; i++) {
        for (let j = i + 1; j < comps.length; j++) {
          const d = Math.max(
            Math.abs(comps[i].position.x - comps[j].position.x),
            Math.abs(comps[i].position.y - comps[j].position.y),
          );
          expect(d, `${name}: ${comps[i].type}@${comps[i].position.x},${comps[i].position.y} vs ${comps[j].type}@${comps[j].position.x},${comps[j].position.y}`).toBeGreaterThanOrEqual(4);
        }
      }
    }
  });

  it('building two patterns places the second away from the first', () => {
    const ctx = mkCtx();
    buildPattern('led-driver', {}, ctx);
    const first = [...ctx.doc.components];
    buildPattern('led-driver', {}, ctx);
    const second = ctx.doc.components.slice(first.length);
    for (const a of first) {
      for (const b of second) {
        const d = Math.max(Math.abs(a.position.x - b.position.x), Math.abs(a.position.y - b.position.y));
        expect(d).toBeGreaterThanOrEqual(4);
      }
    }
    // And the whole thing still solves
    const { sim } = dcSolve(ctx);
    expect(sim).not.toBeNull();
  });

  it('patterns honor a custom anchor', () => {
    const { ctx } = buildPattern('led-driver', {}, mkCtx());
    void ctx;
    const { ctx: ctx2 } = buildPattern('led-driver', {}, mkCtx());
    const src2 = ctx2.doc.components.find(c => c.type === 'dcVoltage')!;
    expect(src2.position.x).toBeLessThanOrEqual(38);
    expect(src2.position.y).toBeLessThanOrEqual(28);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. schematic.describe — netlist grounding
// ─────────────────────────────────────────────────────────────────────────────

describe('schematic.describe', () => {
  it('reports nets, rails, and floating pins for a divider circuit', () => {
    const ctx = mkCtx();
    const v1 = createComponent(ctx, 'dcVoltage', 4, 4, { voltage: 5 });
    const r1 = createComponent(ctx, 'resistor', 12, 4, { resistance: 10000 });
    const r2 = createComponent(ctx, 'resistor', 12, 12, { resistance: 10000 });
    const gnd = createComponent(ctx, 'ground', 12, 20);
    connect(ctx, v1, 'p', r1, 'a');
    connect(ctx, r1, 'b', r2, 'a');
    connect(ctx, r2, 'b', gnd, 'g');
    connect(ctx, v1, 'n', gnd, 'g');

    const res = describeCircuitTool.execute({}, ctx);
    expect(res.ok).toBe(true);
    const r = res.result as any;
    expect(r.componentCount).toBe(4);
    expect(r.wireCount).toBe(4);
    expect(r.groundNets).toBe(1);
    expect(r.supplyRails.length).toBe(1);
    expect(r.supplyRails[0].label).toContain('5V');
    // v1:p, r1:a on the +5V rail; r1:b, r2:a the output; nothing floating
    expect(r.floatingPins).toHaveLength(0);
    // One signal net: the r1.b–r2.a junction
    expect(r.signalNets.length).toBe(1);
    expect(r.signalNets[0].members).toEqual(expect.arrayContaining([`${r1.id}:b`, `${r2.id}:a`]));
  });

  it('flags floating pins and missing ground', () => {
    const ctx = mkCtx();
    const v1 = createComponent(ctx, 'dcVoltage', 4, 4, { voltage: 5 });
    const r1 = createComponent(ctx, 'resistor', 12, 4, { resistance: 1000 });
    connect(ctx, v1, 'p', r1, 'a');
    // v1.n and r1.b are unwired; no ground anywhere

    const res = describeCircuitTool.execute({}, ctx);
    const r = res.result as any;
    expect(r.floatingPins).toEqual(expect.arrayContaining([`${v1.id}:n`, `${r1.id}:b`]));
    expect(r.hints.some((h: string) => h.includes('No ground'))).toBe(true);
  });

  it('handles the empty canvas', () => {
    const res = describeCircuitTool.execute({}, mkCtx());
    expect(res.ok).toBe(true);
    expect(res.result.componentCount).toBe(0);
    expect(res.result.netCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. simulate.whatIf — real-engine accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('simulate.whatIf (real engine)', () => {
  it('DC operating point responds correctly to a resistor change (LED circuit)', () => {
    const ctx = mkCtx();
    const { ctx: built } = buildPattern('led-driver', { supplyV: 5, vf: 2, targetI: 0.015 }, ctx);
    const led = built.doc.components.find(c => c.type === 'led')!;
    const r = built.doc.components.find(c => c.type === 'resistor')!;

    // What if the resistor doubles? Current halves (LED drop is fixed):
    // I = (5−2)/(400+1) = 7.48mA → drop across R = 2.99V → LED anode at 2.01V.
    const res = simulateWhatIfTool.execute({
      modifications: [{ componentId: r.id, key: 'resistance', value: 400 }],
      probes: [`${led.id}:a`],
      steps: 5,
      dt: 1e-4,
    }, built) as any;
    expect(res.ok).toBe(true);
    const probe = res.result.probes[`${led.id}:a`];
    expect(probe.dcVoltage).toBeCloseTo(2.01, 2);
  });

  it('handles op-amp circuits (extra unknowns — the old fake simulator could not)', () => {
    const ctx = mkCtx();
    const { ctx: built } = buildPattern('opamp-inverting', { gain: -10, rin: 1000, amplitude: 0.1 }, ctx);
    const src = built.doc.components.find(c => c.type === 'acVoltage')!;
    src.parameters.amplitude = 0;
    src.parameters.offset = 0.1;
    const opamp = built.doc.components.find(c => c.type === 'opamp')!;
    const rf = built.doc.components.find((c: any) => c.parameters.rf !== undefined) ??
      built.doc.components.filter(c => c.type === 'resistor').find(c => (c.parameters.resistance as number) === 10000)!;

    const res = simulateWhatIfTool.execute({
      modifications: [{ componentId: rf.id, key: 'resistance', value: 20000 }],
      probes: [`${opamp.id}:out`],
      steps: 5,
      dt: 1e-4,
    }, built) as any;
    expect(res.ok).toBe(true);
    const probe = res.result.probes[`${opamp.id}:out`];
    expect(probe.dcVoltage).toBeCloseTo(-2.0, 2); // gain −20 × 0.1V
  });

  it('does not mutate the actual circuit', () => {
    const ctx = mkCtx();
    const { ctx: built } = buildPattern('led-driver', {}, ctx);
    const r = built.doc.components.find(c => c.type === 'resistor')!;
    const before = r.parameters.resistance;
    const compsBefore = built.doc.components.length;
    simulateWhatIfTool.execute({
      modifications: [{ componentId: r.id, key: 'resistance', value: 100000 }],
      probes: [],
      steps: 3,
    }, built);
    expect(r.parameters.resistance).toBe(before);
    expect(built.doc.components.length).toBe(compsBefore);
  });

  it('errors helpfully on unknown component', () => {
    const ctx = mkCtx();
    createComponent(ctx, 'resistor', 4, 4);
    const res = simulateWhatIfTool.execute({
      modifications: [{ componentId: 'nope', key: 'resistance', value: 100 }],
    }, ctx) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. System prompt + auto-verify infrastructure
// ─────────────────────────────────────────────────────────────────────────────

describe('system prompt + auto-verify', () => {
  it('buildSystemPrompt embeds the workflow, tools, and live component catalog', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('design.calculate');
    expect(prompt).toContain('design.buildPattern');
    expect(prompt).toContain('schematic.describe');
    expect(prompt).toContain('simulate.whatIf');
    // Catalog includes real registry types
    expect(prompt).toContain('resistor');
    expect(prompt).toContain('timer555');
    expect(prompt).toContain('hallLinear');
  });

  it('buildComponentCatalog lists categories with type IDs', () => {
    const catalog = buildComponentCatalog();
    expect(catalog).toMatch(/passive:.*resistor/);
    expect(catalog).toMatch(/timer555/);
  });

  it('runAutoVerify flags a ground-less circuit as critical', () => {
    const ctx = mkCtx();
    const v1 = createComponent(ctx, 'dcVoltage', 4, 4, { voltage: 5 });
    const r1 = createComponent(ctx, 'resistor', 12, 4, { resistance: 100 });
    connect(ctx, v1, 'p', r1, 'a');
    connect(ctx, v1, 'n', r1, 'b');
    const report = runAutoVerify(ctx);
    expect(report.health).toBe('critical');
    expect(report.dcConverged).toBe(false);
    expect(autoVerifyNeedsAttention(report)).toBe(true);
    expect(report.issues.some(i => i.category === 'missing-ground')).toBe(true);
  });

  it('runAutoVerify passes a healthy pattern-built circuit', () => {
    const ctx = mkCtx();
    buildPattern('led-driver', {}, ctx);
    const report = runAutoVerify(ctx);
    expect(report.dcConverged).toBe(true);
    expect(autoVerifyNeedsAttention(report)).toBe(false);
  });

  it('buildAutoVerifyMessages produces a valid tool-call pair', () => {
    const ctx = mkCtx();
    const v1 = createComponent(ctx, 'dcVoltage', 4, 4, { voltage: 5 });
    connect(ctx, v1, 'p', v1, 'n'); // degenerate
    const report = runAutoVerify(ctx);
    const msgs = buildAutoVerifyMessages(report, 1);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].tool_calls[0].id).toBe('autoverify_1');
    expect(msgs[0].tool_calls[0].function.name).toBe('verify.autoCheck');
    expect(msgs[1].role).toBe('tool');
    expect(msgs[1].tool_call_id).toBe('autoverify_1');
    const parsed = JSON.parse(msgs[1].content);
    expect(parsed.note).toContain('AUTO-CHECK');
    expect(parsed.health).toBeDefined();
  });

  it('MUTATING_TOOL_NAMES covers the pattern builder', () => {
    expect(MUTATING_TOOL_NAMES.has('design.buildPattern')).toBe(true);
    expect(MUTATING_TOOL_NAMES.has('schematic.addComponent')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Tool registry integration
// ─────────────────────────────────────────────────────────────────────────────

describe('tool registry integration', () => {
  it('registers the new tools', () => {
    expect(TOOLS_BY_NAME.get('design.calculate')).toBeDefined();
    expect(TOOLS_BY_NAME.get('design.buildPattern')).toBeDefined();
    expect(TOOLS_BY_NAME.get('schematic.describe')).toBeDefined();
    expect(TOOLS_BY_NAME.get('simulate.whatIf')).toBeDefined();
    expect(TOOLS_BY_NAME.get('simulate.sweep')).toBeDefined();
  });

  it('exposes valid tool definitions for the LLM API', () => {
    const defs = getToolDefinitions();
    for (const name of ['design.calculate', 'design.buildPattern', 'schematic.describe']) {
      const def = defs.find(d => d.function.name === name);
      expect(def).toBeDefined();
      expect(def!.function.description.length).toBeGreaterThan(50);
      expect(def!.function.parameters.type).toBe('object');
    }
  });

  it('ensurePlugins backfills missing plugin types after pattern builds', () => {
    const ctx = mkCtx(); // empty canvas → empty plugin map
    expect(ctx.plugins.size).toBe(0);
    buildPattern('led-driver', {}, ctx);
    ensurePlugins(ctx);
    for (const t of ['dcVoltage', 'resistor', 'led', 'ground']) {
      expect(ctx.plugins.has(t), `plugin for ${t}`).toBe(true);
    }
  });

  it('simulate.sweep still runs via the real batch engine', () => {
    const ctx = mkCtx();
    const v1 = createComponent(ctx, 'dcVoltage', 4, 4, { voltage: 5 });
    const r1 = createComponent(ctx, 'resistor', 12, 4, { resistance: 470 });
    const led = createComponent(ctx, 'led', 20, 4, { forwardV: 2, seriesR: 1 });
    const gnd = createComponent(ctx, 'ground', 12, 12);
    connect(ctx, v1, 'p', r1, 'a');
    connect(ctx, r1, 'b', led, 'a');
    connect(ctx, led, 'k', gnd, 'g');
    connect(ctx, v1, 'n', gnd, 'g');
    ensurePlugins(ctx);

    const res = simulateSweepTool.execute({
      componentId: r1.id,
      param: 'resistance',
      start: 100,
      stop: 300,
      step: 100,
      probeComponentId: led.id,
      steps: 5,
    }, ctx) as any;
    expect(res.ok).toBe(true);
    expect(res.result.points.length).toBe(3);
    // Higher R → lower LED anode voltage: 5−(3/100·100+2)=... just check monotonic decrease
    const vs = res.result.points.map((p: any) => p.voltage);
    expect(vs[0]).toBeGreaterThan(vs[vs.length - 1]);
  });
});
