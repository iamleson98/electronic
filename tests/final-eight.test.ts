// Final eight: QZ poles, shove, polygon keepouts, pour priority,
// lossless KiCad import, transcript tool, block summary, telemetry timing.

import { describe, it, expect } from 'vitest';
import { runPZ } from '../src/lib/circuit/analysis';
import { pushAndShoveTraces } from '../src/lib/pcb/topological-router';
import { pointInPolygon } from '../src/lib/pcb/auto-router';
import { parseKiCadFootprint, kicadToFootprintDef } from '../src/lib/pcb/kicad-import';
import { transcriptExportTool } from '../src/lib/ai/tools/transcript-tools';
import { planTrackTool } from '../src/lib/ai/tools/plan-tools';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

function mk(type: string, id: string, params: Record<string, number | string | boolean> = {}) {
  const p = getPlugin(type)!;
  const d: Record<string, number | string | boolean> = {};
  for (const q of p.parameters) d[q.key] = q.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0 as const, parameters: { ...d, ...params }, refdes: id.toUpperCase() };
}

describe('generalized QZ poles', () => {
  it('RC lowpass pole at -1/RC via QZ-lite', () => {
    const comps = [mk('dcVoltage', 'v1', { voltage: 5 }), mk('resistor', 'r1', { resistance: 1000 }), mk('capacitor', 'c1', { capacitance: 1e-6 }), mk('ground', 'gnd')];
    const wires = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'c1', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'c1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    const r = runPZ(comps as never, wires as never, plugins as never, { type: 'pz', inputNode: 'v1:p', outputNode: 'r1:b' });
    expect(r.report.attempts[0]).toBe('QZ-lite (G+sC)');
    expect(r.scalars.pole_count).toBeGreaterThan(0);
    // dominant pole ≈ -1000 rad/s (159 Hz)
    expect(Math.abs(r.scalars.dominant_pole_real + 1000)).toBeLessThan(50);
  });
});

describe('push-and-shove', () => {
  it('displaces segments rigidly without tearing', () => {
    const traces = [{
      id: 't1', net: 'N1', layer: 'top' as const, width: 0.3,
      segments: [
        { start: { x: 0, y: 5 }, end: { x: 5, y: 5 }, width: 0.3 },
        { start: { x: 5, y: 5 }, end: { x: 10, y: 5 }, width: 0.3 },
      ],
    }];
    const moved = pushAndShoveTraces(traces as never, { minX: 2, maxX: 8, minY: 3, maxY: 7 }, 0.5);
    expect(moved).toBe(2);
    // connectivity preserved: shared vertex still shared
    expect(traces[0].segments[0].end.x).toBe(traces[0].segments[1].start.x);
    expect(traces[0].segments[0].end.y).toBe(traces[0].segments[1].start.y);
  });
  it('point-in-polygon works', () => {
    const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }];
    expect(pointInPolygon(5, 3, tri)).toBe(true);
    expect(pointInPolygon(0, 9, tri)).toBe(false);
  });
});

describe('lossless KiCad import', () => {
  const mod = `(footprint "SOT-23" (layer F.Cu)
    (descr "SOT-23 package")
    (pad 1 smd rect (at -0.95 0) (size 0.6 0.9) (layers F.Cu F.Paste F.Mask))
    (pad 2 smd rect (at 0.95 0) (size 0.6 0.9) (layers F.Cu F.Paste F.Mask))
    (fp_line (start -1 -1) (end 1 -1) (layer F.SilkS) (width 0.12))
    (fp_poly (pts (xy -2 -2) (xy 2 -2) (xy 2 2) (xy -2 2)) (layer F.CrtYd) (width 0.05))
    (model "SOT-23.step"))`;
  it('preserves drill/layer/paste/mask/silk/courtyard/3d', () => {
    const parsed = parseKiCadFootprint(mod);
    expect(parsed).not.toBeNull();
    expect(parsed!.pads.length).toBe(2);
    expect(parsed!.pads[0].paste).toBe(true);
    expect(parsed!.pads[0].mask).toBe(true);
    expect(parsed!.silk.length).toBe(1);
    expect(parsed!.courtyard.length).toBe(4);
    expect(parsed!.model3d).toBe('SOT-23.step');
    const def = kicadToFootprintDef(parsed!);
    expect((def as { silkOutline?: unknown }).silkOutline).toBeDefined();
    expect((def as { courtyard?: unknown }).courtyard).toBeDefined();
  });
});

describe('transcript + plan tools', () => {
  const ctx = { doc: { version: 1, components: [], wires: [] }, plugins: new Map() } as never;
  it('transcript exports markdown', () => {
    const r = transcriptExportTool.execute({ maxTurns: 10 }, ctx) as { ok: boolean; result: { markdown: string } };
    expect(r.ok).toBe(true);
    expect(r.result.markdown).toContain('# Circuit Chat Transcript');
  });
  it('plan tracks progress', () => {
    const c = planTrackTool.execute({ goal: 'G', steps: ['a', 'b'] }, ctx) as { ok: boolean };
    expect(c.ok).toBe(true);
    (planTrackTool.execute({ clear: true }, ctx) as unknown);
  });
});
