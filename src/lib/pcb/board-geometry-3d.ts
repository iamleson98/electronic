// World-class PCB board geometry for the 3D viewer.
// ─────────────────────────────────────────────────────────────────────────────
// Pure geometry/material builders for the board side of the 3D scene:
//   • rounded-corner, rounded-end copper traces (the classic etched-copper
//     look — segment boxes + cylindrical joint/cap discs merged per net)
//   • real pad shapes: circle / rounded-rect / oval / polygon
//   • plated vias (gold barrel + dark drill)
//   • shiny solder fillets (meniscus domes) on populated THT pads
//   • a photographic silkscreen layer: component outlines, refdes, pin-1
//     dots and a board title block
//   • per-net color control (net-color mode / voltage heat-map mode)
//   • flattenModel(): merges a component model's meshes per material so a
//     30-mesh procedural model becomes ~5 draw calls (visual identity is
//     preserved because meshes sharing one material merge into one mesh).
//
// Everything here is DOM-free except buildSilkscreenTexture (canvas) —
// so the geometry logic is unit-testable in Node.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Footprint, Pad, Trace, Via, BoardOutline } from './types';

/** 1 oz copper ≈ 35 µm — visualized at 80 µm so it reads as a raised metal
 *  layer in close-ups (35 µm is sub-pixel at board zoom). */
export const COPPER_THICKNESS = 0.08;

/**
 * mergeGeometries() requires ALL inputs to agree on indexed/non-indexed.
 * ExtrudeGeometry is non-indexed while Box/Cylinder/Sphere are indexed, so
 * any bucket mixing pad shapes + trace primitives would silently fail.
 * mergeAll normalizes first, then merges — and tolerates single-element lists.
 */
export function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geos.length === 0) throw new Error('mergeAll: empty list');
  if (geos.length === 1) return geos[0];
  const anyNonIndexed = geos.some((g) => !g.index);
  const list = anyNonIndexed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos;
  let merged: THREE.BufferGeometry | null = null;
  try {
    merged = mergeGeometries(list, false);
  } catch {
    merged = null;
  }
  if (!merged) merged = list[0].clone();
  // dispose the temporaries (originals are caller-owned single-use anyway;
  // the toNonIndexed() clones are always ours to free)
  if (anyNonIndexed) {
    geos.forEach((g) => { if (g.index) g.dispose(); });
    list.forEach((g) => { if (g !== merged) g.dispose(); });
  }
  return merged;
}

// ─── Stable per-net colors ───────────────────────────────────────────────────

/** Deterministic 32-bit string hash (FNV-1a). */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable hue for a net name (0..1). GND/VCC get fixed, readable hues. */
export function netHue(net: string): number {
  if (net === 'GND') return 0.58; // blue
  if (net === 'VCC' || net === '+5V' || net === '+3V3' || net === 'VDD') return 0.02; // red
  return (hash32(net) % 1000) / 1000;
}

/** Per-net display color for net-color mode. */
export function netColor(net: string): THREE.Color {
  return new THREE.Color().setHSL(netHue(net), 0.75, 0.55);
}

/** Voltage heat color: 0 V → deep blue, mid → green/yellow, max → red. */
export function voltageColor(v: number, vMin: number, vMax: number): THREE.Color {
  const span = Math.max(1e-9, vMax - vMin);
  const t = Math.min(1, Math.max(0, (v - vMin) / span));
  // blue → cyan → green → yellow → red (perceptual-ish ramp)
  const stops: [number, number, number][] = [
    [0.05, 0.1, 0.75], [0.0, 0.75, 0.95], [0.1, 0.9, 0.2],
    [0.95, 0.9, 0.05], [0.95, 0.1, 0.05],
  ];
  const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  const f = t * (stops.length - 1) - seg;
  const a = stops[seg];
  const b = stops[seg + 1];
  return new THREE.Color(
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  );
}

// ─── Trace geometry (rounded corners + rounded ends) ─────────────────────────

export interface TracePolyline {
  /** ordered path points in board space (mm) */
  pts: { x: number; y: number }[];
  /** cumulative arc length at each point; cum[0] = 0 */
  cum: number[];
  /** total path length (mm) */
  total: number;
  net: string;
  layer: string;
}

/**
 * World-space geometries for one trace: a box per segment + a vertical
 * cylinder disc at EVERY polyline vertex (interior vertices become rounded
 * corner joins, the two endpoints become rounded trace ends).
 */
export function traceGeometries(trace: Trace, layerY: number): THREE.BufferGeometry[] {
  const t = COPPER_THICKNESS;
  // visual width floor: 0.25 mm autorouter traces are sub-pixel at board
  // zoom (pure shimmer, impossible to anti-alias) — 0.32 mm keeps geometry
  // honest-to-scale while staying renderable at default framing
  const width = Math.max(0.32, trace.width);
  const r = width / 2;
  const geos: THREE.BufferGeometry[] = [];
  const pts: { x: number; y: number }[] = [];
  for (const seg of trace.segments) {
    if (pts.length === 0) pts.push(seg.start);
    // drop duplicated consecutive points
    const last = pts[pts.length - 1];
    if (Math.hypot(seg.end.x - last.x, seg.end.y - last.y) > 1e-6) pts.push(seg.end);
  }
  // segment boxes
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const box = new THREE.BoxGeometry(len, t, width);
    const m = new THREE.Matrix4().makeRotationY(Math.atan2(dy, dx));
    m.setPosition((a.x + b.x) / 2, layerY, (a.y + b.y) / 2);
    box.applyMatrix4(m);
    geos.push(box);
  }
  // joint/end discs
  for (const p of pts) {
    const disc = new THREE.CylinderGeometry(r, r, t, 12);
    disc.translate(p.x, layerY, p.y);
    geos.push(disc);
  }
  return geos;
}

/** Polyline + arc length bookkeeping for one trace (particle flow paths). */
export function tracePolyline(trace: Trace): TracePolyline {
  const pts: { x: number; y: number }[] = [];
  for (const seg of trace.segments) {
    if (pts.length === 0) pts.push(seg.start);
    const last = pts[pts.length - 1];
    if (Math.hypot(seg.end.x - last.x, seg.end.y - last.y) > 1e-6) pts.push(seg.end);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { pts, cum, total: cum[cum.length - 1] ?? 0, net: trace.net, layer: trace.layer };
}

/** Point at normalized phase u ∈ [0,1) along a polyline. */
export function samplePolyline(p: TracePolyline, u: number): { x: number; y: number } {
  if (p.pts.length === 0) return { x: 0, y: 0 };
  if (p.pts.length === 1 || p.total <= 0) return { ...p.pts[0] };
  const target = Math.min(0.999999, Math.max(0, u)) * p.total;
  // binary search for segment
  let lo = 0;
  let hi = p.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= target) lo = mid; else hi = mid;
  }
  const segLen = Math.max(1e-9, p.cum[hi] - p.cum[lo]);
  const f = (target - p.cum[lo]) / segLen;
  const a = p.pts[lo];
  const b = p.pts[hi];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// ─── Pad geometry (real shapes) ──────────────────────────────────────────────

/** Rounded-rectangle outline shape (used by pads + substrate + selection). */
export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  const s = new THREE.Shape();
  s.moveTo(rr, 0);
  s.lineTo(w - rr, 0);
  s.quadraticCurveTo(w, 0, w, rr);
  s.lineTo(w, h - rr);
  s.quadraticCurveTo(w, h, w - rr, h);
  s.lineTo(rr, h);
  s.quadraticCurveTo(0, h, 0, h - rr);
  s.lineTo(0, rr);
  s.quadraticCurveTo(0, 0, rr, 0);
  return s;
}

/**
 * World-space pad geometry at (x, z) board coordinates, top of copper at
 * layerY. Handles circle / rounded-rect / oval / polygon pads.
 */
export function padGeometry(pad: Pad, x: number, z: number, layerY: number, rotZ = 0): THREE.BufferGeometry | null {
  const w = pad.size?.width || 0.6;
  const h = pad.size?.height || 0.6;
  const t = COPPER_THICKNESS;
  let geo: THREE.BufferGeometry | null = null;
  if (pad.shape === 'circle') {
    geo = new THREE.CylinderGeometry(Math.max(w, h) / 2, Math.max(w, h) / 2, t, 20);
  } else if (pad.shape === 'oval') {
    // capsule: box + 2 end cylinders
    const len = Math.max(0.01, Math.abs(w - h));
    const r = Math.min(w, h) / 2;
    const parts: THREE.BufferGeometry[] = [
      new THREE.BoxGeometry(len, t, Math.min(w, h)),
      new THREE.CylinderGeometry(r, r, t, 14),
      new THREE.CylinderGeometry(r, r, t, 14),
    ];
    parts[1].translate(-len / 2, 0, 0);
    parts[2].translate(len / 2, 0, 0);
    geo = mergeAll(parts);
    parts.forEach((p) => p.dispose());
  } else if (pad.shape === 'polygon' && pad.polygon?.length) {
    const s = new THREE.Shape();
    const vs = pad.polygon;
    s.moveTo(vs[0].x, vs[0].y);
    for (let i = 1; i < vs.length; i++) s.lineTo(vs[i].x, vs[i].y);
    s.closePath();
    geo = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, h / 2); // center polygon on pad
  } else {
    // rect with softly rounded corners (etched-copper look)
    const s = roundedRectShape(w, h, Math.min(w, h) * 0.2);
    geo = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 4 });
    geo.rotateX(-Math.PI / 2);
    // after rotateX(−π/2): x∈[0,w], y∈[0,t] (extrude depth), z∈[−h,0] → center it
    geo.translate(-w / 2, -t / 2, h / 2);
  }
  if (!geo) return null;
  if (rotZ) geo.rotateY(rotZ);
  geo.translate(x, layerY - t / 2, z);
  // normalize attribute sets so mergeGeometries never chokes
  if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
  return geo;
}

/**
 * Solder fillet (meniscus): a squashed shiny dome on a THT pad where a
 * component lead is soldered. Only drawn for populated footprints.
 */
export function solderFilletGeometry(pad: Pad, x: number, z: number, layerY: number): THREE.BufferGeometry | null {
  const w = pad.size?.width || 0.8;
  const h = pad.size?.height || 0.8;
  const r = Math.max(0.22, Math.min(w, h) * 0.52);
  const geo = new THREE.SphereGeometry(r, 14, 10);
  geo.scale(1, 0.38, 1);
  geo.translate(x, layerY + r * 0.1, z);
  if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
  return geo;
}

/**
 * Via: gold annular barrel spanning the board + dark drill hole.
 * Returns [goldGeo, drillGeo].
 */
export function viaGeometries(via: Via, boardThickness: number): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const outerR = Math.max(0.2, via.diameter / 2);
  const drillR = Math.max(0.08, via.drill / 2);
  const gold = new THREE.CylinderGeometry(outerR, outerR, boardThickness + COPPER_THICKNESS, 16);
  gold.translate(via.position.x, 0, via.position.y);
  const drill = new THREE.CylinderGeometry(drillR, drillR, boardThickness + COPPER_THICKNESS + 0.04, 16);
  drill.translate(via.position.x, 0, via.position.y);
  return [gold, drill];
}

// ─── Board substrate ─────────────────────────────────────────────────────────

/** Rounded-rect extruded substrate, top surface at y = 0. */
export function boardGeometry(bw: number, bh: number, depth: number, corner: number): THREE.ExtrudeGeometry {
  const shape = roundedRectShape(bw, bh, corner);
  // curveSegments 24: a 6-segment arc renders a visibly polygonal corner
  // (read as "jagged edge" at any zoom); 24 is visually circular.
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
  // shape's +Y becomes board -Z (unmirrored), extrusion +Z becomes world -Y,
  // then translate so the top cap sits at y = 0.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -depth, 0);
  return geo;
}

// ─── Silkscreen (photographic) ───────────────────────────────────────────────

export interface SilkscreenResult {
  texture: THREE.CanvasTexture;
  widthPx: number;
  heightPx: number;
}

/**
 * Photographic silkscreen: component courtyard outlines (rotated with the
 * footprint), refdes labels, pin-1 dots, and a title block. Drawn onto a
 * transparent canvas and used as an alpha-mapped plane just above the mask.
 */
export function buildSilkscreenTexture(
  footprints: Footprint[],
  board: BoardOutline,
  title = 'CircuitLab',
  rev = 'Rev A',
): SilkscreenResult {
  const S = 12; // texels per mm (12 = crisp refdes at zoom, ~1.5k canvas for 120 mm board)
  const cw = Math.max(64, Math.round(board.width * S));
  const ch = Math.max(64, Math.round(board.height * S));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, cw, ch);
  ctx.strokeStyle = '#f2f4f6';
  ctx.fillStyle = '#f2f4f6';
  ctx.lineWidth = Math.max(1, S * 0.12);
  ctx.lineJoin = 'round';

  for (const fp of footprints) {
    const cx = fp.position.x * S;
    const cy = fp.position.y * S;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((fp.rotation * Math.PI) / 180);
    const bw = fp.bodySize.width * S;
    const bh = fp.bodySize.height * S;
    const r = Math.min(bw, bh) * 0.18;
    // courtyard outline (rounded rect)
    ctx.beginPath();
    ctx.moveTo(-bw / 2 + r, -bh / 2);
    ctx.lineTo(bw / 2 - r, -bh / 2);
    ctx.quadraticCurveTo(bw / 2, -bh / 2, bw / 2, -bh / 2 + r);
    ctx.lineTo(bw / 2, bh / 2 - r);
    ctx.quadraticCurveTo(bw / 2, bh / 2, bw / 2 - r, bh / 2);
    ctx.lineTo(-bw / 2 + r, bh / 2);
    ctx.quadraticCurveTo(-bw / 2, bh / 2, -bw / 2, bh / 2 - r);
    ctx.lineTo(-bw / 2, -bh / 2 + r);
    ctx.quadraticCurveTo(-bw / 2, -bh / 2, -bw / 2 + r, -bh / 2);
    ctx.stroke();
    // pin-1 dot
    const p1 = fp.pads[0];
    if (p1) {
      ctx.beginPath();
      ctx.arc(p1.position.x * S, p1.position.y * S, S * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // refdes (always horizontal for readability — silkscreen can rotate but
    // readability wins; offset above the outline)
    ctx.font = `bold ${Math.max(10, Math.round(S * 1.35))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fp.refdes || fp.id, cx, cy - bh / 2 - S * 0.15);
  }

  // title block — bottom-left, like a real fab drawing
  ctx.font = `bold ${Math.round(S * 1.6)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, S * 0.8, ch - S * 1.4);
  ctx.font = `${Math.round(S * 1.1)}px ui-monospace, monospace`;
  ctx.fillText(rev, S * 0.8, ch - S * 0.35);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, widthPx: cw, heightPx: ch };
}

// ─── Component model flattening (draw-call reduction) ────────────────────────

/**
 * Merge a component model's meshes per material (world transforms applied).
 * A 30-mesh procedural model becomes ~5 meshes. Material instances are kept
 * as-is — so shared MAT.* materials still merge only within this instance,
 * and per-instance emissive materials (LED lens, 7-seg segment clones) keep
 * working because the closures capture the material, not the mesh.
 * Non-mesh children (the LED's PointLight) are carried over.
 */
export function flattenModel(root: THREE.Object3D): THREE.Group {
  const byMaterial = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; castShadow: boolean }>();
  const carryOver: THREE.Object3D[] = [];
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (child === root) return;
    if (!(child instanceof THREE.Mesh)) {
      if (child instanceof THREE.Light) carryOver.push(child);
      return;
    }
    const mat = child.material as THREE.Material;
    if (Array.isArray(mat)) return; // multi-material meshes stay separate
    const clone = child.geometry.clone();
    clone.applyMatrix4(child.matrixWorld);
    if (!clone.getAttribute('uv')) {
      clone.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(clone.getAttribute('position').count * 2), 2));
    }
    const entry = byMaterial.get(mat) ?? { geos: [], castShadow: false };
    entry.geos.push(clone);
    entry.castShadow = entry.castShadow || child.castShadow;
    byMaterial.set(mat, entry);
  });

  const out = new THREE.Group();
  for (const [mat, { geos, castShadow }] of byMaterial) {
    if (!geos.length) continue;
    let merged: THREE.BufferGeometry;
    try {
      merged = mergeAll(geos);
    } catch {
      merged = geos[0].clone();
    }
    geos.forEach((g) => { if (g !== merged) g.dispose(); });
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    out.add(m);
  }
  // carry lights (LED glow PointLight etc.) at their world positions
  for (const light of carryOver) {
    const pos = new THREE.Vector3();
    pos.setFromMatrixPosition(light.matrixWorld);
    light.position.copy(pos);
    out.add(light);
  }
  return out;
}

// ─── Materials (board furniture) ─────────────────────────────────────────────

/** ENIG gold — exposed copper after surface finish. */
export function goldMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xd9b96c, roughness: 0.24, metalness: 1.0,
    clearcoat: 0.35, clearcoatRoughness: 0.25,
  });
}

/** Glossy solder mask — the real FR4 + mask look (dark green, clearcoat sheen). */
export function solderMaskMaterial(color = 0x0b5e33): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.42, metalness: 0.05,
    clearcoat: 0.75, clearcoatRoughness: 0.28,
    sheen: 0.15, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x66ff99),
  });
  // micro-surface normal noise — real solder mask has fine Orange-peel grain
  if (typeof document !== 'undefined') {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      const img = g.createImageData(128, 128);
      for (let i = 0; i < 128 * 128; i++) {
        // small random normal perturbation around (0.5, 0.5) = flat
        img.data[i * 4] = 128 + (Math.random() - 0.5) * 14;
        img.data[i * 4 + 1] = 128 + (Math.random() - 0.5) * 14;
        img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(6, 6);
      mat.normalMap = tex;
      mat.normalScale = new THREE.Vector2(0.08, 0.08);
    } catch { /* grain optional */ }
  }
  return mat;
}

/** FR4 core (visible on board edges / cross-section). */
export function fr4Material(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xa89a5e, roughness: 0.85, metalness: 0.0 });
}

/** Lead-free solder — bright, slightly warm silver. */
export function solderMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xd9dde2, roughness: 0.18, metalness: 0.95,
    clearcoat: 0.5, clearcoatRoughness: 0.15,
  });
}

/** Dark drill bore. */
export function drillMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9, metalness: 0.1 });
}
