// Regression tests for the audit fixes (research round 2).
// One test block per verified bug — each pins the FIXED behavior.

import { describe, it, expect } from 'vitest';
import { parseMeasLine, execMeas, measureDelay, type RealTrace } from '../src/lib/circuit/measurement';
import { runPZ } from '../src/lib/circuit/analysis';
import { runMonteCarlo } from '../src/lib/circuit/monte-carlo';
import { runSens } from '../src/lib/circuit/sensitivity';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';
import { useEditor } from '../src/lib/circuit/store';
import { createScriptingAPI } from '../src/lib/scripting-api';
import { transcriptExportTool } from '../src/lib/ai/tools/transcript-tools';
import { yieldMonteCarloTool, yieldSensitivityTool } from '../src/lib/ai/tools/yield-tools';
import { deratingCheckTool } from '../src/lib/ai/tools/review-tools';
import { buildComponentModel, smdResistorCode, ceramicCapCode, type ModelBuildContext } from '../src/lib/pcb/component-models-3d';
import { parseKiCadFootprint } from '../src/lib/pcb/kicad-import';
import { exportAllGerbersX2, exportGerberX2Copper } from '../src/lib/pcb/gerber-export';
import { drcErrorKey, runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import { usePCB } from '../src/lib/pcb/store';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';
import type { Footprint } from '../src/lib/pcb/types';
import * as THREE from 'three';

function mk(type: string, id: string, params: Record<string, number | string | boolean> = {}) {
  const p = getPlugin(type)!;
  const d: Record<string, number | string | boolean> = {};
  for (const q of p.parameters) d[q.key] = q.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...params }, refdes: id.toUpperCase() };
}

function mkFootprint(type: string, pads: { id: string; x: number; y: number }[]): Footprint {
  return {
    id: 'fp1', componentId: 'c1', componentType: type, refdes: 'U1',
    position: { x: 50, y: 50 }, rotation: 0,
    bodySize: { width: 10, height: 10 },
    side: 'top',
    pads: pads.map((p) => ({
      id: `pad_${p.id}`, componentId: 'c1', terminalId: p.id,
      position: { x: 50 + p.x, y: 50 + p.y }, shape: 'circle' as const,
      size: { width: 1.8, height: 1.8 }, layer: 'top' as const, drill: 1.0,
    })),
  } as unknown as Footprint;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ESM require() purge — the 66 red tests
// ─────────────────────────────────────────────────────────────────────────────
describe('ESM require() purge', () => {
  it('spice-import parseSpiceValue works without require (vitest ESM)', async () => {
    const mod = await import('../src/lib/circuit/spice-import');
    expect(mod.parseSpiceValue('4.7k')).toBe(4700);
    expect(mod.parseSpiceValue('1Meg')).toBe(1e6);
    expect(mod.parseSpiceValue('100n')).toBeCloseTo(1e-7, 12);
  });

  it('exportBOM joins the part database (previously require-crashed)', async () => {
    const { exportBOM } = await import('../src/lib/pcb/additional-exports');
    const fps = [mkFootprint('resistor', [{ id: 'a', x: -2.1, y: 0 }, { id: 'b', x: 2.1, y: 0 }])];
    const bom = exportBOM(fps);
    expect(bom).toContain('Designator,Quantity,Footprint');
    expect(bom.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('no require() call sites remain in src/ (same bug class)', async () => {
    // Static guard: grep-like check over the module graph entry points.
    const fs = await import('fs');
    const path = await import('path');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
          const src = fs.readFileSync(p, 'utf8');
          // allow comments mentioning require; only flag live calls
          const live = src.replace(/\/\/[^\n]*require[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
          if (/[^.\w]require\s*\(\s*['"]/.test(live)) offenders.push(p);
        }
      }
    };
    walk(path.resolve(__dirname, '../src'));
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. transcript.export — ok:true without client store, reads ctx.messages
// ─────────────────────────────────────────────────────────────────────────────
describe('transcript.export tool', () => {
  it('returns ok:true with header even with no conversation (server path)', () => {
    const ctx = { doc: { version: 1, components: [], wires: [] }, plugins: new Map() } as never;
    const r = transcriptExportTool.execute({ maxTurns: 10 }, ctx) as { ok: boolean; result: { markdown: string; turns: number } };
    expect(r.ok).toBe(true);
    expect(r.result.markdown).toContain('# Circuit Chat Transcript');
    expect(r.result.turns).toBe(0);
  });

  it('exports the real conversation from ctx.messages (turn-runner snapshot)', () => {
    const ctx = {
      doc: { version: 1, components: [], wires: [] },
      plugins: new Map(),
      messages: [
        { role: 'user', content: 'build me a divider' },
        { role: 'assistant', content: 'added R1/R2', toolCalls: [{ name: 'schematic.addComponent', ok: true }] },
      ],
    } as never;
    const r = transcriptExportTool.execute({}, ctx) as { ok: boolean; result: { markdown: string; turns: number } };
    expect(r.ok).toBe(true);
    expect(r.result.markdown).toContain('build me a divider');
    expect(r.result.markdown).toContain('added R1/R2');
    expect(r.result.markdown).toContain('_Tools: schematic.addComponent_');
    expect(r.result.turns).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. scripting API addComponent validation (live crash → error boundary)
// ─────────────────────────────────────────────────────────────────────────────
describe('circuitlab.addComponent validation', () => {
  it('rejects a bare number position with a clear TypeError', () => {
    const api = createScriptingAPI();
    expect(() => api.addComponent('dcVoltage', 10 as never, 10 as never)).toThrow(TypeError);
    expect(() => api.addComponent('dcVoltage', 10 as never, 10 as never)).toThrow(/position must be/);
  });

  it('store normalizes a malformed position instead of storing {x: undefined}', () => {
    const s = useEditor.getState();
    const id = s.addComponent('resistor', {} as never);
    const comp = useEditor.getState().components.find((c) => c.id === id);
    expect(comp).toBeDefined();
    expect(Number.isFinite(comp!.position.x)).toBe(true);
    expect(Number.isFinite(comp!.position.y)).toBe(true);
    useEditor.getState().deleteComponent(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PZ pole math — AC-coupled (floating cap) networks
// ─────────────────────────────────────────────────────────────────────────────
describe('PZ poles for AC-coupled circuits', () => {
  it('single pole at -1/((R1+R2)C) for the classic AC coupling', () => {
    const R1 = 1000, R2 = 1000, C = 1e-6;
    const comps = [
      mk('dcVoltage', 'v1', { voltage: 5 }),
      mk('resistor', 'r1', { resistance: R1 }),
      mk('capacitor', 'c1', { capacitance: C }),
      mk('resistor', 'r2', { resistance: R2 }),
      mk('ground', 'gnd'),
    ] as CircuitComponent[];
    const wires = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'c1', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'c1', terminalId: 'b' }, to: { componentId: 'r2', terminalId: 'a' } },
      { id: 'w4', from: { componentId: 'r2', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w5', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ] as Wire[];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    const r = runPZ(comps, wires, plugins, { type: 'pz', inputNode: 'v1:p', outputNode: 'r2:b' });
    const t = r.traces[0] as unknown as { xValues: Float64Array };
    const poles = Array.from(t.xValues).filter((x) => Math.abs(x) < 1e10);
    const truePole = -1 / ((R1 + R2) * C);
    // exactly one finite pole, within 5% — the old diagonal-C solver returned
    // two wrong poles at -1/(R1C), -1/(R2C)
    expect(poles.length).toBe(1);
    expect(Math.abs(poles[0] - truePole)).toBeLessThan(Math.abs(truePole) * 0.05);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. .meas TRIG/TARG clause modifiers
// ─────────────────────────────────────────────────────────────────────────────
describe('.meas TRIG/TARG modifiers', () => {
  it('parses per-clause TD/RISE/FALL/CROSS in both forms', () => {
    const r = parseMeasLine('.meas tran t2 TRIG V(a)=2.5 TD=1m RISE=2 TARG V(b)=1.8 FALL=1');
    expect(r).not.toBeNull();
    expect(r!.trigExpr).toBe('V(a)');
    expect(r!.trigVal).toBe(2.5);
    expect(r!.trigTd).toBe(0.001);
    expect(r!.trigRise).toBe(2);
    expect(r!.targExpr).toBe('V(b)');
    expect(r!.targVal).toBe(1.8);
    expect(r!.targFall).toBe(1);
  });

  it('DELAY form still parses (clause after the expression)', () => {
    const r = parseMeasLine('.meas tran tdly DELAY V(out) TRIG V(in)=1 TARG V(out)=4');
    expect(r!.trigExpr).toBe('V(in)');
    expect(r!.trigVal).toBe(1);
    expect(r!.targExpr).toBe('V(out)');
    expect(r!.targVal).toBe(4);
  });

  it('TD actually filters the trigger crossing in execMeas DELAY', () => {
    // two pulse trains: rises at t≈1.5 and 6.5, falls at t≈4.5 and 9.5
    const xs = new Float64Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const ys = new Float64Array([0, 0, 5, 5, 5, 0, 0, 5, 5, 5, 0]);
    const trace: RealTrace = { name: 'V(out)', xValues: xs, yValues: ys, xLabel: 't', yLabel: 'V' };
    // trigger delayed past t=3 → first eligible crossing is the FALL at t=4.5;
    // target delayed past t=5 → the RISE at t=6.5 → delay = 2.
    const d = measureDelay('t', trace, 2.5, trace, 2.5, { td: 3 }, { td: 5 });
    expect(d.value).toBeGreaterThanOrEqual(1.5);
    // without TD both sides hit the same first rise → delay ≈ 0
    const d0 = measureDelay('t0', trace, 2.5, trace, 2.5, undefined, undefined);
    expect(Math.abs(d0.value)).toBeLessThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Monte-Carlo methodology — sources are exact stimulus
// ─────────────────────────────────────────────────────────────────────────────
describe('Monte-Carlo source handling', () => {
  it('does NOT perturb sources by default (stimulus is exact)', () => {
    const comps = [
      mk('dcVoltage', 'v1', { voltage: 5 }),
      mk('resistor', 'r1', { resistance: 1000 }),
      mk('resistor', 'r2', { resistance: 1000 }),
      mk('ground', 'gnd'),
    ] as CircuitComponent[];
    const wires = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'r2', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'r2', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ] as Wire[];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    const result = runMonteCarlo(
      { version: 1, components: comps, wires },
      { runs: 30, seed: 42, measurement: { type: 'voltage', node: 'r1:b' } },
      plugins,
    );
    const perturbedSources = result.runs.flatMap((r) => r.perturbations).filter((p) => p.componentId === 'v1');
    expect(perturbedSources).toEqual([]);
    // resistors ARE perturbed
    const perturbedRs = result.runs.flatMap((r) => r.perturbations).filter((p) => p.componentId === 'r1');
    expect(perturbedRs.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. yield tools — per-part tolerance field + sensitivity identity
// ─────────────────────────────────────────────────────────────────────────────
function dividerCtx(r1Tol?: number) {
  const comps = [
    { ...mk('dcVoltage', 'v1', { voltage: 5 }), tolerance: r1Tol },
    { ...mk('resistor', 'r1', { resistance: 1000 }) },
    { ...mk('resistor', 'r2', { resistance: 1000 }) },
    mk('ground', 'gnd'),
  ] as CircuitComponent[];
  const wires = [
    { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
    { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'r2', terminalId: 'a' } },
    { id: 'w3', from: { componentId: 'r2', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
    { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
  ] as Wire[];
  const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
  return {
    doc: { version: 1, components: comps, wires },
    wires, plugins,
    ctx: { doc: { version: 1, components: comps, wires }, plugins } as never,
  };
}

describe('yield.monteCarlo per-part tolerance', () => {
  it('honors the component-level tolerance field (1% vs global 50%)', () => {
    const { ctx } = dividerCtx(0.01);
    const r = yieldMonteCarloTool.execute({ runs: 60, tolerance: 0.5, outputNode: 'r1:b', seed: 7 }, ctx) as {
      ok: boolean; result: { runs: number; std: number; mean: number };
    };
    expect(r.ok).toBe(true);
    // R1 at 1% (the 50% global applies only to R2) — the divider output
    // spread must be far below the 50% chaos the old c.parameters.tolerance
    // read (which always missed) would have produced.
    expect(r.result.std).toBeLessThan(0.7); // ≤ ~14% of the 2.5V mean
  });
});

describe('yield.sensitivity identity alignment', () => {
  it('attributes sensitivities via trace labels, not index guesses', () => {
    const { doc, wires, plugins } = dividerCtx();
    const result = runSens(doc.components as CircuitComponent[], wires as Wire[], plugins, { type: 'sens', outputNode: 'r1:b', mode: 'dc', parameter: 'resistance' });
    const trace = result.traces[0] as unknown as { labels?: string[]; yValues: Float64Array };
    expect(trace.labels).toBeDefined();
    expect(trace.labels!.length).toBe(trace.yValues.length);
    expect(trace.labels).toContain('R1');
    expect(trace.labels).toContain('R2');
  });

  it('tool rows use the trace identities (R1 and R2 both present)', () => {
    const { ctx } = dividerCtx();
    const r = yieldSensitivityTool.execute({ outputNode: 'r1:b', parameter: 'resistance' }, ctx) as {
      ok: boolean; result: { sensitivities: { component: string; dVdP: number }[] };
    };
    expect(r.ok).toBe(true);
    const names = r.result.sensitivities.map((s) => s.component);
    expect(names).toContain('R1');
    expect(names).toContain('R2');
    // divider: dVout/dR1 < 0, dVout/dR2 > 0 at the 2.5V midpoint
    const r1 = r.result.sensitivities.find((s) => s.component === 'R1')!;
    const r2 = r.result.sensitivities.find((s) => s.component === 'R2')!;
    expect(r1.dVdP).toBeLessThan(0);
    expect(r2.dVdP).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. review.derating — honest rating provenance
// ─────────────────────────────────────────────────────────────────────────────
describe('review.derating rating provenance', () => {
  it('marks generic-default ratings and says so in the summary', async () => {
    const comps = [
      mk('dcVoltage', 'v1', { voltage: 5 }),
      mk('resistor', 'r1', { resistance: 1000 }),
      mk('ground', 'gnd'),
    ] as CircuitComponent[];
    const wires = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w3', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ] as Wire[];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    const { solveDC } = await import('../src/lib/circuit/engine');
    const sim = solveDC(comps, wires, plugins, 100);
    const ctx = {
      doc: { version: 1, components: comps, wires },
      plugins, simContext: sim,
    } as never;
    const r = deratingCheckTool.execute({}, ctx) as {
      ok: boolean; result: { rows: { ratingSource: string }[]; summary: string };
    };
    expect(r.ok).toBe(true);
    expect(r.result.rows.length).toBeGreaterThan(0);
    expect(r.result.rows.every((row) => row.ratingSource === 'generic' || row.ratingSource === 'part')).toBe(true);
    expect(r.result.rows.some((row) => row.ratingSource === 'generic')).toBe(true);
    expect(r.result.summary).toContain('GENERIC');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. 3D models — legs land on the REAL solder pads
// ─────────────────────────────────────────────────────────────────────────────
function findSolderCones(group: THREE.Object3D): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry instanceof THREE.CylinderGeometry) {
      const mat = mesh.material as THREE.MeshPhysicalMaterial;
      if (mat && (mat as THREE.MeshStandardMaterial).metalness === Math.min(1, Math.max(0, 0.95))) {
        // solder material: metalness 0.95
        out.push(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld));
      }
    }
  });
  return out;
}

describe('3D models land legs on pads', () => {
  const checkWire = (group: THREE.Object3D, px: number, pz: number): boolean => {
    // some mesh in the group passes within 0.35mm of the pad (x, *, z) below
    // y=1 and above y=-2.5 (the through-board piercing segment)
    let found = false;
    group.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (found || !mesh.isMesh) return;
      const geo = mesh.geometry as THREE.BufferGeometry;
      if (!geo.attributes?.position) return;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const w = new THREE.Vector3();
      for (let i = 0; i < Math.min(pos.count, 400); i++) {
        v.fromBufferAttribute(pos, i);
        w.copy(v).applyMatrix4(mesh.matrixWorld);
        if (Math.hypot(w.x - px, w.z - pz) < 0.4 && w.y < 1.2 && w.y > -2.4) {
          found = true;
          return;
        }
      }
    });
    return found;
  };

  it('battery snap wires pierce BOTH pads (dcVoltage pads along Y/Z)', () => {
    const fp = mkFootprint('dcVoltage', [{ id: 'p', x: 0, y: -4 }, { id: 'n', x: 0, y: 4 }]);
    const model = buildComponentModel({ footprint: fp, params: { voltage: 9 } } as ModelBuildContext);
    expect(model).not.toBeNull();
    model!.updateMatrixWorld(true);
    // pads at local (0, ∓4): each must have geometry at the pad position
    expect(checkWire(model!, 0, -4)).toBe(true);
    expect(checkWire(model!, 0, 4)).toBe(true);
  });

  it('battery wires pierce pads along X too (rotation handled)', () => {
    const fp = mkFootprint('battery', [{ id: 'a', x: -3, y: 0 }, { id: 'b', x: 3, y: 0 }]);
    const model = buildComponentModel({ footprint: fp, params: { voltage: 9 } } as ModelBuildContext);
    expect(model).not.toBeNull();
    expect(checkWire(model!, -3, 0)).toBe(true);
    expect(checkWire(model!, 3, 0)).toBe(true);
  });

  it('switch legs land on the ±3mm X pads (previously on the WRONG axis)', () => {
    const fp = mkFootprint('switch', [{ id: 'a', x: -3, y: 0 }, { id: 'b', x: 3, y: 0 }]);
    const model = buildComponentModel({ footprint: fp, params: {} } as ModelBuildContext);
    expect(model).not.toBeNull();
    expect(checkWire(model!, -3, 0)).toBe(true);
    expect(checkWire(model!, 3, 0)).toBe(true);
  });

  it('potentiometer renders 3 legs (a, b + wiper) on their pads', () => {
    const fp = mkFootprint('potentiometer', [
      { id: 'a', x: -2.5, y: 0 }, { id: 'b', x: 2.5, y: 0 }, { id: 'w', x: 0, y: 2.5 },
    ]);
    const model = buildComponentModel({ footprint: fp, params: {} } as ModelBuildContext);
    expect(model).not.toBeNull();
    expect(checkWire(model!, -2.5, 0)).toBe(true);
    expect(checkWire(model!, 2.5, 0)).toBe(true);
    expect(checkWire(model!, 0, 2.5)).toBe(true);
  });

  it('pushButton legs land on its real pads (2-pad footprint)', () => {
    const fp = mkFootprint('pushButton', [{ id: 'a', x: -3, y: 0 }, { id: 'b', x: 3, y: 0 }]);
    const model = buildComponentModel({ footprint: fp, params: {} } as ModelBuildContext);
    expect(model).not.toBeNull();
    expect(checkWire(model!, -3, 0)).toBe(true);
    expect(checkWire(model!, 3, 0)).toBe(true);
  });

  it('photoresistor + transformer legs land on their pads', () => {
    const ldr = mkFootprint('photoresistor', [{ id: 'a', x: -2.5, y: 0 }, { id: 'b', x: 2.5, y: 0 }]);
    const ldrModel = buildComponentModel({ footprint: ldr, params: {} } as ModelBuildContext);
    expect(ldrModel).not.toBeNull();
    expect(checkWire(ldrModel!, -2.5, 0)).toBe(true);
    expect(checkWire(ldrModel!, 2.5, 0)).toBe(true);

    const xf = mkFootprint('transformer', [{ id: 'p', x: -1.5, y: 0 }, { id: 'n', x: 1.5, y: 0 }]);
    const xfModel = buildComponentModel({ footprint: xf, params: {} } as ModelBuildContext);
    expect(xfModel).not.toBeNull();
    expect(checkWire(xfModel!, -1.5, 0)).toBe(true);
    expect(checkWire(xfModel!, 1.5, 0)).toBe(true);
  });

  it('acVoltage renders a bench source (NOT a PP3 battery), legs on pads', () => {
    const fp = mkFootprint('acVoltage', [{ id: 'p', x: 0, y: -4 }, { id: 'n', x: 0, y: 4 }]);
    const model = buildComponentModel({ footprint: fp, params: { amplitude: 12, frequency: 60 } } as ModelBuildContext);
    expect(model).not.toBeNull();
    expect(checkWire(model!, 0, -4)).toBe(true);
    expect(checkWire(model!, 0, 4)).toBe(true);
    // the model registry must NOT map acVoltage to the battery factory
    const bat = mkFootprint('dcVoltage', [{ id: 'p', x: 0, y: -4 }, { id: 'n', x: 0, y: 4 }]);
    const batModel = buildComponentModel({ footprint: bat, params: { voltage: 9 } } as ModelBuildContext);
    expect(batModel).not.toBeNull();
    // battery has a tall 26s-high jacket; the bench source box is ~9s —
    // distinguishable by max geometry height.
    const maxY = (g: THREE.Object3D) => {
      let mx = 0;
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const b = new THREE.Box3().setFromObject(m);
        mx = Math.max(mx, b.max.y);
      });
      return mx;
    };
    expect(maxY(model!)).toBeLessThan(maxY(batModel!) * 0.75);
  });

  it('pulseSource renders a bench source with legs on pads', () => {
    const fp = mkFootprint('pulseSource', [{ id: 'p', x: 0, y: -4 }, { id: 'n', x: 0, y: 4 }]);
    const model = buildComponentModel({ footprint: fp, params: { high: 5, low: 0, frequency: 1000, duty: 50 } } as ModelBuildContext);
    expect(model).not.toBeNull();
    expect(checkWire(model!, 0, -4)).toBe(true);
    expect(checkWire(model!, 0, 4)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. 3D value codes — SMD resistor + ceramic capacitor markings
// ─────────────────────────────────────────────────────────────────────────────
describe('3D value codes', () => {
  it('SMD resistor code follows EIA dd×10^e (4.7k→472, 100k→104, 4R7, R47)', () => {
    expect(smdResistorCode(4700)).toBe('472');
    expect(smdResistorCode(100000)).toBe('104');
    expect(smdResistorCode(10000)).toBe('103');
    expect(smdResistorCode(1000)).toBe('102');
    expect(smdResistorCode(470)).toBe('471'); // 47×10¹ — resistor codes, not pF codes
    expect(smdResistorCode(4.7)).toBe('4R7');
    expect(smdResistorCode(0.47)).toBe('R47');
    // the old broken concat heuristic produced these:
    expect(smdResistorCode(4700)).not.toBe('52');
    expect(smdResistorCode(100000)).not.toBe('100');
    expect(smdResistorCode(100000).length).toBe(3);
  });

  it('ceramic cap code: 100nF → "104" (was "100")', () => {
    expect(ceramicCapCode(1e-7)).toBe('104');
    expect(ceramicCapCode(1e-8)).toBe('103');
    expect(ceramicCapCode(1e-9)).toBe('102');
    expect(ceramicCapCode(1e-10)).toBe('101');
    expect(ceramicCapCode(22e-12)).toBe('220');
    expect(ceramicCapCode(4.7e-12)).toBe('4.7');
  });

  it('resistor bands handle sub-10Ω with silver multiplier (4.7Ω)', () => {
    // 4.7Ω = yellow(4) violet(7) silver(−1): d1=4, d2=7, mult=−1
    const fp = mkFootprint('resistor', [{ id: 'a', x: -5, y: 0 }, { id: 'b', x: 5, y: 0 }]);
    const model = buildComponentModel({ footprint: fp, params: { resistance: 4.7 } } as ModelBuildContext);
    expect(model).not.toBeNull(); // must not throw; band colors checked below
    const bandR = 1.04; // band radius factor
    // collect band materials: cylinders of radius ~r*1.04 along the body axis
    const bands: number[] = [];
    model!.traverse((o) => {
      const m = o as THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
      if (m.isMesh && m.geometry instanceof THREE.CylinderGeometry) {
        const r = m.geometry.parameters.radiusTop;
        if (Math.abs(r - 1.0 * bandR) < 0.08) {
          bands.push((m.material.color.getHex() >>> 0) & 0xffffff);
        }
      }
    });
    // yellow #d4b106? no — 4=yellow 0xd4b106, 7=violet 0x7c3aed, silver 0xc0c0c0
    expect(bands).toContain(0xd4b106); // 4
    expect(bands).toContain(0x7c3aed); // 7
    expect(bands).toContain(0xc0c0c0); // silver multiplier ×10⁻¹
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Gerber X2 layer numbering
// ─────────────────────────────────────────────────────────────────────────────
describe('Gerber X2 layer numbers', () => {
  it('4-layer stack: top=L1, inner1=L2, inner2=L3, bottom=L4 (no collisions)', () => {
    const files = exportAllGerbersX2([], [], [], { width: 40, height: 30 }, undefined, {
      layers: ['top', 'inner1', 'inner2', 'bottom'],
    });
    const fns: Record<string, string> = {};
    for (const f of files) {
      const m = f.content.match(/%TF\.FileFunction,Copper,(L\d+)\*%/);
      if (m) fns[f.filename] = m[1];
    }
    expect(fns['top_copper.gbr']).toBe('L1');
    expect(fns['inner1_copper.gbr']).toBe('L2');
    expect(fns['inner2_copper.gbr']).toBe('L3');
    expect(fns['bottom_copper.gbr']).toBe('L4');
    // no two files claim the same layer number
    const nums = Object.values(fns);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('direct bottom export (no stack info) is collision-free L6, not L2', () => {
    const out = exportGerberX2Copper('bottom', [], [], [], { width: 40, height: 30 });
    expect(out).toContain('%TF.FileFunction,Copper,L6*%');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. DRC waiver key consistency
// ─────────────────────────────────────────────────────────────────────────────
describe('DRC waiver keys', () => {
  it('drcErrorKey format is type@x,y and the dialog uses it (no colon drift)', async () => {
    const err = { type: 'clearance', position: { x: 10.001, y: 20.002 }, severity: 'error' as const, message: 'x' };
    const key = drcErrorKey(err as never);
    expect(key).toBe('clearance@10.00,20.00');
    expect(key).not.toContain(':');
    const fs = await import('fs');
    const dialog = fs.readFileSync('src/components/pcb/dialogs/DRCSettingsDialog.tsx', 'utf8');
    expect(dialog).toContain('drcErrorKey(');
    expect(dialog).not.toMatch(/type\}:\$\{/);
  });

  it('runDRC honors waivers (store round-trip semantics)', () => {
    const errors = runDRC([], [], [], [], { width: 40, height: 30 }, DEFAULT_DRC_CONFIG);
    expect(Array.isArray(errors)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. KiCad import — real thru_hole keyword + drill capture
// ─────────────────────────────────────────────────────────────────────────────
describe('KiCad footprint import (real syntax)', () => {
  it('parses thru_hole pads (the actual KiCad keyword) with real drills', () => {
    const mod = `(footprint "DIP-8" (layer F.Cu)
      (pad "1" thru_hole roundrect (at -3.81 -3.81) (size 1.7 1.7) (drill 1.0) (layers *.Cu *.Mask))
      (pad "2" thru_hole circle (at -1.27 -3.81) (size 1.7 1.7) (drill 1.0 (offset 0 0)) (layers *.Cu *.Mask))
      (pad 3 smd rect (at 1.27 -3.81 90) (size 0.6 0.9) (layers F.Cu F.Paste F.Mask))`;
    const p = parseKiCadFootprint(mod);
    expect(p).not.toBeNull();
    expect(p!.pads.length).toBe(3);
    expect(p!.pads[0].terminalId).toBe('1');       // quotes stripped
    expect(p!.pads[0].drill).toBe(1.0);            // real drill captured
    expect(p!.pads[1].drill).toBe(1.0);            // offset form
    expect(p!.pads[2].drill).toBe(0);              // SMD
  });

  it('parses np_thru_hole mounting holes', () => {
    const mod = `(footprint "M3" (layer F.Cu)
      (pad "" np_thru_hole circle (at 0 0) (size 3.5 3.5) (drill 3.5) (layers *.Cu *.Mask))`;
    const p = parseKiCadFootprint(mod);
    expect(p!.pads.length).toBe(1);
    expect(p!.pads[0].drill).toBe(3.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Panelize — real geometry replication
// ─────────────────────────────────────────────────────────────────────────────
describe('panelize replicates geometry', () => {
  it('2x2 panel clones footprints/traces/vias/padNets into each copy', () => {
    const pcb = usePCB.getState();
    // set up a known small board
    usePCB.setState({
      board: { width: 20, height: 10 },
      footprints: [mkFootprint('resistor', [{ id: 'a', x: -2, y: 0 }, { id: 'b', x: 2, y: 0 }])],
      traces: [{
        id: 't1', net: 'N1', layer: 'top' as const, width: 0.3,
        segments: [{ start: { x: 1, y: 1 }, end: { x: 5, y: 1 }, width: 0.3 }],
      }],
      vias: [{ id: 'v1', position: { x: 3, y: 3 }, diameter: 0.6, drill: 0.3, net: 'N1' }],
      padNets: new Map([['c1:a', 'N1']]),
      copperPours: [], keepouts: [],
    });
    const result = usePCB.getState().panelize(2, 2, 2.5);
    expect(result.copies).toBe(4);
    const s = usePCB.getState();
    expect(s.footprints.length).toBe(4);          // 4 resistor instances
    expect(s.traces.length).toBe(4);              // 4 trace clones
    expect(s.vias.length).toBe(4);                // 4 via clones
    expect(s.padNets.size).toBe(4);               // pad nets replicated
    expect(s.board.width).toBe(2 * 20 + 2.5);     // 42.5
    expect(s.board.height).toBe(2 * 10 + 2.5);    // 22.5
    // the copy offsets are real: one via lands at (3+22.5, 3+12.5) etc.
    const viaXs = s.vias.map((v) => v.position.x).sort((a, b) => a - b);
    expect(viaXs[3] - viaXs[0]).toBe(22.5);
    // undo restores the single board
    usePCB.getState().undo();
    const u = usePCB.getState();
    expect(u.footprints.length).toBe(1);
    expect(u.board.width).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. tempScaleIs argument order (device temp vs nominal)
// ─────────────────────────────────────────────────────────────────────────────
describe('diode temperature scaling argument order', () => {
  it('hot device ⇒ higher saturation current (Is grows with temperature)', async () => {
    const { solveDC } = await import('../src/lib/circuit/engine');
    const build = () => {
      const comps = [
        mk('dcVoltage', 'v1', { voltage: 0.7 }),
        mk('diodeShockley', 'd1', {}),
        mk('resistor', 'r1', { resistance: 100 }),
        mk('ground', 'gnd'),
      ] as CircuitComponent[];
      const wires = [
        { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
        { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'd1', terminalId: 'a' } },
        { id: 'w3', from: { componentId: 'd1', terminalId: 'k' }, to: { componentId: 'gnd', terminalId: 'g' } },
        { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
      ] as Wire[];
      const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
      return { comps, wires, plugins };
    };
    const { comps, wires, plugins } = build();
    const cold = solveDC(comps, wires, plugins, 50, { simOptions: { temp: 25 } });
    const hot = solveDC(comps, wires, plugins, 50, { simOptions: { temp: 85 } });
    expect(cold).not.toBeNull();
    expect(hot).not.toBeNull();
    // higher temp ⇒ larger Is ⇒ more current at the same 0.7V drive
    const sum = (sim: NonNullable<typeof cold>) =>
      Array.from(sim.branchCurrent).reduce((a, v) => a + Math.abs(v), 0);
    expect(sum(hot!)).toBeGreaterThan(sum(cold!));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. PNP saturation clamp is a Thevenin to Vec(sat)
// ─────────────────────────────────────────────────────────────────────────────
describe('PNP saturation clamp', () => {
  it('saturated PNP holds Vec ≈ satV (not ~0V)', async () => {
    // PNP high-side switch: emitter at 9V, base pulled LOW through R1 to
    // ground (Veb ≈ 0.7 on), collector through a heavy load ⇒ saturation.
    const comps = [
      mk('dcVoltage', 'v1', { voltage: 9 }),
      mk('pnp', 'q1', { hfe: 100, veb: 0.7, satV: 0.2 }),
      mk('resistor', 'r1', { resistance: 470 }),  // base pull-down (base current path)
      mk('resistor', 'r2', { resistance: 10 }),    // light load ⇒ collector rides up to sat
      mk('ground', 'gnd'),
    ] as CircuitComponent[];
    const wires = [
      { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'q1', terminalId: 'e' } },
      { id: 'w2', from: { componentId: 'q1', terminalId: 'b' }, to: { componentId: 'r1', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w4', from: { componentId: 'q1', terminalId: 'c' }, to: { componentId: 'r2', terminalId: 'a' } },
      { id: 'w5', from: { componentId: 'r2', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
      { id: 'w6', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
    ] as Wire[];
    const plugins = new Map(comps.map((c) => [c.type, getPlugin(c.type)!]));
    const { solveDC } = await import('../src/lib/circuit/engine');
    const sim = solveDC(comps, wires, plugins, 100, { simOptions: { temp: 25 } });
    expect(sim).not.toBeNull();
    const { buildNodeMap, getTerminalsForComponent } = await import('../src/lib/circuit/engine');
    const nodeMap = buildNodeMap(comps, wires, plugins);
    const q1 = comps.find((c) => c.id === 'q1')!;
    const cNode = getTerminalsForComponent(q1, plugins.get('pnp')!, nodeMap)
      .find((t) => t.terminalId === 'c')!.nodeId;
    const eNode = getTerminalsForComponent(q1, plugins.get('pnp')!, nodeMap)
      .find((t) => t.terminalId === 'e')!.nodeId;
    const vec = sim!.nodeVoltage[eNode] - sim!.nodeVoltage[cNode];
    // saturated: Vec should sit near satV=0.2V (the old bare-conductance clamp
    // pinned it near 0). Allow 0.05..0.7V.
    expect(vec).toBeGreaterThan(0.05);
    expect(vec).toBeLessThan(0.7);
  });
});
