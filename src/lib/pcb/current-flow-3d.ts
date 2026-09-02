// Live current-flow visualization for the 3D PCB view.
// ─────────────────────────────────────────────────────────────────────────────
// Physics source of truth: the ENGINE's own per-wire currents
// (computeWireCurrents). For every PCB pad we recover the terminal injection
// current via KCL:
//
//     injection(termKey) = Σ (+i_w for wires LEAVING the terminal)
//                          Σ (−i_w for wires ARRIVING at the terminal)
//
// A net's flow magnitude = max |injection| over its pads; the strongest
// injecting pad is the anchor (current source side) that orients particle
// direction along each trace. Magnitudes therefore match the schematic's
// animated flow dots exactly — same solver numbers, 3D presentation.
//
// FlowParticleField renders the particles as one additive THREE.Points cloud
// whose per-dot phase advances at a speed proportional to net current.

import * as THREE from 'three';
import type { Footprint, Trace } from './types';
import type { CircuitComponent, Wire, SimContext, ComponentPlugin } from '../circuit/types';
import { buildNodeMap, computeWireCurrents } from '../circuit/engine';
import { samplePolyline, tracePolyline, type TracePolyline } from './board-geometry-3d';

export interface NetFlowData {
  /** max |terminal injection| among pads on the net (A) */
  current: number;
  /** strongest injecting pad in BOARD coordinates (mm) — or null */
  anchor: { x: number; y: number } | null;
  /** net node voltage (V) — or null when not solvable */
  voltage: number | null;
}

/** World-space position of a footprint pad (board mm, rotation applied). */
export function padWorldPosition(fp: Footprint, pad: { position: { x: number; y: number } }): { x: number; y: number } {
  const a = (fp.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const { x, y } = pad.position;
  return { x: fp.position.x + x * c - y * s, y: fp.position.y + x * s + y * c };
}

/**
 * Per-net electrical state recovered from the live simulation.
 * Uses only exported engine APIs — no engine internals touched.
 *
 *   injection(termKey) = Σ (+i_w, wires leaving the terminal)
 *                        Σ (−i_w, wires arriving at the terminal)   [KCL]
 *
 * current = max |injection| on the net; anchor = strongest positive
 * (source-side) pad; voltage = node voltage of the strongest terminal.
 */
export function computeNetFlow(
  footprints: Footprint[],
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  sim: SimContext,
): Map<string, NetFlowData> {
  const currentOf = new Map<string, number>();   // net → max |injection|
  const bestPosOf = new Map<string, number>();   // net → strongest positive injection
  const anchorOf = new Map<string, { x: number; y: number }>();
  const seen = new Set<string>();

  // terminal injections from wire currents (KCL at every terminal)
  const injections = new Map<string, number>();
  let wireCurrents: Map<string, number> | null = null;
  try {
    wireCurrents = computeWireCurrents(components, wires, plugins, sim);
  } catch {
    wireCurrents = null;
  }
  if (wireCurrents) {
    for (const wire of wires) {
      const i = wireCurrents.get(wire.id) ?? 0;
      const fromKey = `${wire.from.componentId}:${wire.from.terminalId}`;
      const toKey = `${wire.to.componentId}:${wire.to.terminalId}`;
      injections.set(fromKey, (injections.get(fromKey) ?? 0) + i);
      injections.set(toKey, (injections.get(toKey) ?? 0) - i);
    }
  }

  // node voltages per net (via the engine's terminal→node map)
  let nodeMap: ReturnType<typeof buildNodeMap> | null = null;
  try {
    nodeMap = buildNodeMap(components, wires, plugins);
  } catch {
    nodeMap = null;
  }

  const voltageOf = new Map<string, number | null>();
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (!pad.net) continue;
      const net = pad.net;
      seen.add(net);
      const termKey = `${pad.componentId}:${pad.terminalId}`;
      const inj = injections.get(termKey) ?? 0;
      if (Math.abs(inj) > (currentOf.get(net) ?? 0)) {
        currentOf.set(net, Math.abs(inj));
        if (nodeMap) {
          const nodeId = nodeMap.terminalNode.get(termKey) ?? 0;
          voltageOf.set(net, (sim.nodeVoltage as Record<number, number>)[nodeId] ?? null);
        }
      }
      if (inj > 1e-9 && inj > (bestPosOf.get(net) ?? 0)) {
        bestPosOf.set(net, inj);
        anchorOf.set(net, padWorldPosition(fp, pad));
      }
    }
  }

  const result = new Map<string, NetFlowData>();
  for (const net of seen) {
    result.set(net, {
      current: currentOf.get(net) ?? 0,
      anchor: anchorOf.get(net) ?? null,
      voltage: voltageOf.get(net) ?? null,
    });
  }
  return result;
}

// ─── Particle field ──────────────────────────────────────────────────────────

interface Dot {
  path: number;
  phase0: number;
}

/**
 * One additive-blended point cloud animating dots along every trace.
 * Dot speed and brightness are proportional to the net current; direction
 * is oriented away from each net's source anchor.
 */
export class FlowParticleField {
  readonly points: THREE.Points;
  private paths: (TracePolyline & { layerY: number; reversed: boolean })[] = [];
  private dots: Dot[] = [];
  private speeds: number[] = [];
  private brightness: number[] = [];
  private positions: Float32Array;
  private colors: Float32Array;
  private netOfPath: string[] = [];
  private lastT = 0;

  constructor(
    traces: Trace[],
    layerYOf: (layer: string) => number,
    opts: { spacing?: number; dotSize?: number } = {},
  ) {
    const spacing = opts.spacing ?? 3.2;
    const dotSize = opts.dotSize ?? 1.05;

    for (const t of traces) {
      if (!t.segments.length) continue;
      const poly = tracePolyline(t);
      if (poly.total < 1.2) continue;
      this.paths.push({ ...poly, layerY: layerYOf(t.layer), reversed: false });
    }
    for (let pi = 0; pi < this.paths.length; pi++) {
      const p = this.paths[pi];
      const count = Math.max(1, Math.min(48, Math.round(p.total / spacing)));
      for (let d = 0; d < count; d++) {
        this.dots.push({ path: pi, phase0: d / count + Math.random() * 0.02 });
      }
      this.netOfPath.push(p.net);
    }

    const n = Math.max(1, this.dots.length);
    this.positions = new Float32Array(n * 3);
    this.colors = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setDrawRange(0, this.dots.length);

    const mat = new THREE.PointsMaterial({
      size: dotSize,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // soft round sprite (DOM-guarded so Node tests can construct the field)
    if (typeof document !== 'undefined') {
      try {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const g = c.getContext('2d')!;
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.35, 'rgba(255,255,255,0.85)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        const tex = new THREE.CanvasTexture(c);
        mat.map = tex;
        mat.alphaTest = 0;
      } catch { /* sprite optional */ }
    }

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    // initial state: hidden until currents arrive
    this.points.visible = false;
    this.speeds = new Array(this.paths.length).fill(0);
    this.brightness = new Array(this.paths.length).fill(0);
    for (let i = 0; i < this.dots.length; i++) {
      this.colors[i * 3] = 0; this.colors[i * 3 + 1] = 0; this.colors[i * 3 + 2] = 0;
    }
  }

  /**
   * Feed live per-net electrical state: sets per-path speed, brightness and
   * direction (away from the net's anchor pad).
   */
  setNetFlow(netFlow: Map<string, NetFlowData>) {
    let anyVisible = false;
    for (let pi = 0; pi < this.paths.length; pi++) {
      const p = this.paths[pi];
      const data = netFlow.get(p.net);
      const amps = data?.current ?? 0;
      // speed: 4 mm/s at ~0, scaling up with current; clamp for sanity
      const v = Math.min(70, 3 + Math.abs(amps) * 2600);
      this.speeds[pi] = p.total > 0 ? v / p.total : 0;
      // brightness: visible from ~20 µA, saturated at ~30 mA
      const b = Math.min(1, Math.max(0, (Math.abs(amps) - 2e-5) / 0.03));
      this.brightness[pi] = b;
      if (b > 0.01) anyVisible = true;
      // orientation: particles flow AWAY from the anchor (source) pad
      if (data?.anchor) {
        const ds = Math.hypot(p.pts[0].x - data.anchor.x, p.pts[0].y - data.anchor.y);
        const de = Math.hypot(p.pts[p.pts.length - 1].x - data.anchor.x, p.pts[p.pts.length - 1].y - data.anchor.y);
        p.reversed = de < ds;
      }
    }
    this.points.visible = anyVisible && this.dots.length > 0;
  }

  /** Advance the animation. timeSec = wall-clock seconds. */
  update(timeSec: number) {
    if (!this.points.visible) return;
    const dt = this.lastT ? Math.min(0.1, Math.max(0, timeSec - this.lastT)) : 0;
    this.lastT = timeSec;
    const pos = this.positions;
    const col = this.colors;
    for (let i = 0; i < this.dots.length; i++) {
      const d = this.dots[i];
      const p = this.paths[d.path];
      const speed = this.speeds[d.path] * dt;
      d.phase0 = (d.phase0 + speed) % 1;
      let phase = d.phase0;
      if (p.reversed) phase = 1 - phase;
      const pt = samplePolyline(p, phase);
      pos[i * 3] = pt.x;
      pos[i * 3 + 1] = p.layerY + 0.12;
      pos[i * 3 + 2] = pt.y;
      // color: cyan-green core tinted toward warm yellow with current
      const b = this.brightness[d.path];
      col[i * 3] = 0.25 * b + 0.55 * b * b;
      col[i * 3 + 1] = 1.0 * b;
      col[i * 3 + 2] = 0.55 * b * (1 - 0.35 * b);
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    const mat = this.points.material as THREE.PointsMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}
