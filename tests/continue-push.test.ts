// Continuation push: trigger acquisition, S-expr/DNP, directive import,
// noise inoise/NF, fab bundle/presets/waivers/BOM/PnP, KB + tool registry.

import { describe, it, expect } from 'vitest';
import {
  findTriggerEvents, resolveTriggerAnchor, type ScopeSample,
} from '../src/lib/circuit/scope-viewer';
import { validateFootprint, autoGenerateFootprintLayers } from '../src/lib/pcb/footprint-editor';
import { generateBGA } from '../src/lib/pcb/parametric-footprints';
import { planTrackTool } from '../src/lib/ai/tools/plan-tools';
import { estimateCost } from '../src/lib/ai/chat-session';
import { buildSystemPrompt } from '../src/lib/ai/system-prompt';

describe('real trigger acquisition', () => {
  const step: ScopeSample[] = Array.from({ length: 11 }, (_, i) => ({
    time: i * 1e-3,
    voltage: i < 5 ? 0 : 5,
  }));
  it('detects the rising edge with interpolation', () => {
    const ev = findTriggerEvents(step, 2.5, 'rising');
    expect(ev.length).toBe(1);
    expect(ev[0].time).toBeGreaterThan(0.004);
    expect(ev[0].time).toBeLessThan(0.005);
  });
  it('falling edge finds nothing on a rising step', () => {
    expect(findTriggerEvents(step, 2.5, 'falling').length).toBe(0);
  });
  it('holdoff suppresses chatter', () => {
    const noisy: ScopeSample[] = [
      { time: 0, voltage: 0 }, { time: 1e-3, voltage: 5 },
      { time: 1.5e-3, voltage: 0 }, { time: 2e-3, voltage: 5 },
    ];
    expect(findTriggerEvents(noisy, 2.5, 'rising', 0).length).toBe(2);
    expect(findTriggerEvents(noisy, 2.5, 'rising', 5e-3).length).toBe(1);
  });
  it('auto anchors at now, normal at the edge', () => {
    const trig = { mode: 'auto' as const, source: 0, edge: 'rising' as const, level: 2.5, armed: true };
    expect(resolveTriggerAnchor(step, trig, 0.01)).toBe(0.01);
    const normal = { ...trig, mode: 'normal' as const };
    const anchor = resolveTriggerAnchor(step, normal, 0.01);
    expect(anchor).toBeGreaterThan(0.004);
    expect(anchor).toBeLessThan(0.005);
  });
});

describe('footprint validation + auto-layers', () => {
  it('flags duplicates, overlaps, thin rings', () => {
    const fp = {
      bodySize: { width: 5, height: 5 },
      pads: [
        { id: 'p1', terminalId: '1', position: { x: 0, y: 0 }, size: { width: 1.6, height: 1.6 }, drill: 1.4 },
        { id: 'p2', terminalId: '1', position: { x: 0.1, y: 0 }, size: { width: 1.6, height: 1.6 }, drill: 0 },
      ],
    };
    const issues = validateFootprint(fp);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });
  it('auto-generates courtyard/silk/pin1', () => {
    const fp: Record<string, unknown> = { bodySize: { width: 4, height: 4 }, pads: [{ position: { x: -1, y: 0 } }] };
    const out = autoGenerateFootprintLayers(fp);
    expect(out.courtyard.length).toBe(4);
    expect(out.silk.length).toBe(4);
    expect(out.pin1).not.toBeNull();
  });
  it('BGA grid has N*N balls with A1 naming', () => {
    const def = generateBGA(4, 0.8, 0.45);
    expect(def.pads.length).toBe(16);
    expect(def.pads[0].terminalId).toBe('A1');
    expect(def.pads[15].terminalId).toBe('D4');
  });
});

describe('plan tracking + cost estimate', () => {
  it('creates and advances a plan', () => {
    const ctx = { doc: { version: 1, components: [], wires: [] }, plugins: new Map() } as never;
    const created = planTrackTool.execute({ goal: 'Build PSU', steps: ['rectifier', 'regulator'] }, ctx) as { ok: boolean; result: { progress: string } };
    expect(created.ok).toBe(true);
    expect(created.result.progress).toBe('0/2 steps done');
    const updated = planTrackTool.execute({ update: [{ title: 'rectifier', status: 'done' }] }, ctx) as { ok: boolean; result: { progress: string } };
    expect(updated.result.progress).toBe('1/2 steps done');
    (planTrackTool.execute({ clear: true }, ctx) as unknown);
  });
  it('estimates known-model cost', () => {
    const c = estimateCost('gpt-4o-mini', 1e6, 1e6);
    expect(c).toBeCloseTo(0.75, 9);
    expect(estimateCost('unknown-model-xyz', 100, 100)).toBeUndefined();
  });
  it('system prompt advertises the new tools', () => {
    const prompt = buildSystemPrompt();
    for (const name of ['yield.monteCarlo', 'review.derating', 'simulate.fault', 'export.designReport']) {
      expect(prompt).toContain(name);
    }
  });
});
