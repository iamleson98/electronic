// Procedural realistic 3D component models (Three.js scene graphs).
// ─────────────────────────────────────────────────────────────────────────────
// Each factory builds a THREE.Group with MULTIPLE meshes and PBR materials —
// bodies, markings, metal leads, translucent domes — so components look like
// the real parts (vs the old single-gray-STL approximation).
//
// Conventions (same as the rest of the 3D viewer):
//   • 1 unit = 1 mm
//   • origin = footprint center on the board's top surface (y = 0)
//   • +Y = up (away from board), +X = along the footprint's local X
//   • the viewer applies fp.position / fp.rotation / side mirroring
//
// Model sizing adapts to the footprint's pad span so parts always land on
// their pads (KiCad WRL-parity behavior).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Footprint } from './types';

export interface ModelBuildContext {
  /** PCB footprint (pads drive span/scale) */
  footprint: Footprint;
  /** schematic component parameters (e.g. resistance → color bands) */
  params: Record<string, any>;
}

export type ModelFactory = (ctx: ModelBuildContext) => THREE.Group | null;

// ─── Shared materials (module-level cache — few instances, reused) ──────────
// Body materials are MeshPhysicalMaterial with clearcoat: molded epoxy and
// ABS plastics have a thin glossy surface layer over a diffuse bulk — the
// clearcoat term is what separates "looks real" from "looks like clay".
const MAT = {
  // Epoxy / molded plastic bodies
  blackPlastic: new THREE.MeshPhysicalMaterial({ color: 0x1c1c20, roughness: 0.5, metalness: 0.05, clearcoat: 0.45, clearcoatRoughness: 0.35 }),
  darkPlastic: new THREE.MeshPhysicalMaterial({ color: 0x2a2a30, roughness: 0.55, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.4 }),
  // DIP body (matte black epoxy — real DIP is very matte, almost no gloss)
  dipBody: new THREE.MeshPhysicalMaterial({ color: 0x141416, roughness: 0.7, metalness: 0.02, clearcoat: 0.12, clearcoatRoughness: 0.5 }),
  // Bright tinned-steel leads / pins — slightly brighter for ENIG-matching look
  lead: new THREE.MeshPhysicalMaterial({ color: 0xc0c5cc, roughness: 0.26, metalness: 1.0, clearcoat: 0.25, clearcoatRoughness: 0.18 }),
  // Aluminum can tops (crystals, electrolytics)
  aluminum: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.9 }),
  // Copper windings
  copper: new THREE.MeshPhysicalMaterial({ color: 0xb87333, roughness: 0.25, metalness: 0.95, clearcoat: 0.3, clearcoatRoughness: 0.25 }),
  // Resistor body (Yageo carbon-film beige — slightly lighter, warmer lacquer)
  resistorBody: new THREE.MeshPhysicalMaterial({ color: 0xe8d5a3, roughness: 0.5, metalness: 0.0, clearcoat: 0.2, clearcoatRoughness: 0.45 }),
  // ── Modern SMD chip bodies (real-world mini sizes) ──
  // Thick-film chip resistor: near-black epoxy, matte
  chipResistor: new THREE.MeshPhysicalMaterial({ color: 0x111114, roughness: 0.55, metalness: 0.05, clearcoat: 0.25, clearcoatRoughness: 0.4 }),
  // SMD ceramic / MLCC: warm tan for Class-II, dark for C0G
  mlccDark: new THREE.MeshPhysicalMaterial({ color: 0x3a3a3e, roughness: 0.5, metalness: 0.05, clearcoat: 0.2, clearcoatRoughness: 0.4 }),
  // SMD tantalum (yellow-orange molded)
  tantalum: new THREE.MeshPhysicalMaterial({ color: 0xc98a2e, roughness: 0.5, metalness: 0.0, clearcoat: 0.3, clearcoatRoughness: 0.35 }),
  // SMD LED reflector (white PPA plastic)
  ledReflector: new THREE.MeshPhysicalMaterial({ color: 0xf2f2f0, roughness: 0.4, metalness: 0.0, clearcoat: 0.3, clearcoatRoughness: 0.3 }),
  // SMD SOD-123 diode body (black epoxy, smaller than DO-41)
  sodBody: new THREE.MeshPhysicalMaterial({ color: 0x141416, roughness: 0.55, metalness: 0.05, clearcoat: 0.25, clearcoatRoughness: 0.4 }),
  // Nickel barrier layer for SMD terminations (dull silver between body + tin)
  nickel: new THREE.MeshPhysicalMaterial({ color: 0x8a8f96, roughness: 0.35, metalness: 1.0 }),
  // Bright tin termination (outer wrap)
  tin: new THREE.MeshPhysicalMaterial({ color: 0xd7dbe0, roughness: 0.18, metalness: 1.0, clearcoat: 0.5, clearcoatRoughness: 0.2 }),
  // Electrolytic can (dark navy plastic sleeve)
  elecCan: new THREE.MeshPhysicalMaterial({ color: 0x1a2440, roughness: 0.4, metalness: 0.15, clearcoat: 0.5, clearcoatRoughness: 0.3 }),
  // Ceramic disc (orange-tan)
  ceramic: new THREE.MeshPhysicalMaterial({ color: 0xd9a066, roughness: 0.7, metalness: 0.0, clearcoat: 0.12, clearcoatRoughness: 0.5 }),
  // MLCC / SMD tan body
  mlcc: new THREE.MeshPhysicalMaterial({ color: 0xc9a876, roughness: 0.65, metalness: 0.0, clearcoat: 0.15, clearcoatRoughness: 0.45 }),
  // Glass diode (translucent red-brown — DO-35 glass is quite transparent)
  diodeGlass: new THREE.MeshPhysicalMaterial({
    color: 0x8b1a1a, roughness: 0.12, metalness: 0.0,
    transparent: true, opacity: 0.65, transmission: 0.55,
  }),
  // Black diode body (DO-41 power diodes)
  diodeBody: new THREE.MeshPhysicalMaterial({ color: 0x16161a, roughness: 0.45, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.35 }),
  // TO-220 metal tab
  tab: new THREE.MeshPhysicalMaterial({ color: 0x8f959c, roughness: 0.28, metalness: 0.95, clearcoat: 0.2, clearcoatRoughness: 0.25 }),
  // Gold ENIG pad finish
  enig: new THREE.MeshPhysicalMaterial({ color: 0xd4b96a, roughness: 0.22, metalness: 1.0, clearcoat: 0.35, clearcoatRoughness: 0.2 }),
  // Lead-free solder (fillets, joints) — brighter, shinier for realism
  solder: new THREE.MeshPhysicalMaterial({ color: 0xd9dde2, roughness: 0.12, metalness: 0.95, clearcoat: 0.7, clearcoatRoughness: 0.12 }),
  // ── Extended realism palette (covers the full ~170-part catalog) ──
  // Blue relay cube / sensor breakout soldermask
  bluePlastic: new THREE.MeshPhysicalMaterial({ color: 0x1d4ed8, roughness: 0.45, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.3 }),
  // Yellow tantalum / ceramic resonator
  yellowPlastic: new THREE.MeshPhysicalMaterial({ color: 0xd9a821, roughness: 0.5, metalness: 0.0, clearcoat: 0.3, clearcoatRoughness: 0.35 }),
  // Green LCD soldermask / module PCB
  greenPcb: new THREE.MeshPhysicalMaterial({ color: 0x0b5e33, roughness: 0.55, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
  // Red PCB (sensor breakouts, ESP32 devkit)
  redPcb: new THREE.MeshPhysicalMaterial({ color: 0x7f1d1d, roughness: 0.55, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
  // LCD glass (transmissive green-gray)
  lcdGlass: new THREE.MeshPhysicalMaterial({ color: 0x9fb8a4, roughness: 0.15, metalness: 0.0, transparent: true, opacity: 0.92, transmission: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.12 }),
  // LCD backlight diffuser (pale green when off)
  lcdBack: new THREE.MeshPhysicalMaterial({ color: 0x8aa88f, roughness: 0.6, metalness: 0.0 }),
  // White silkscreen plastic (optocoupler, relay top)
  whitePlastic: new THREE.MeshPhysicalMaterial({ color: 0xe8e8e6, roughness: 0.5, metalness: 0.0, clearcoat: 0.25, clearcoatRoughness: 0.35 }),
  // Brass / gold pins (headers, crystal pins)
  brass: new THREE.MeshPhysicalMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 1.0 }),
  // Dark ferrite / motor steel
  steel: new THREE.MeshPhysicalMaterial({ color: 0x555a63, roughness: 0.4, metalness: 0.85 }),
  // Rubber / buzzer diaphragm
  rubber: new THREE.MeshPhysicalMaterial({ color: 0x111114, roughness: 0.85, metalness: 0.0 }),
  // Solar cell blue-black with grid
  solar: new THREE.MeshPhysicalMaterial({ color: 0x10243e, roughness: 0.25, metalness: 0.4, clearcoat: 0.7, clearcoatRoughness: 0.15 }),
};

/** Clone-safe helper: mesh with geometry + material, positioned. */
function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** X-extent of the footprint's pads (how far the leads must reach). */
function padSpanX(fp: Footprint): number {
  if (!fp.pads.length) return 8;
  let min = Infinity, max = -Infinity;
  for (const p of fp.pads) {
    min = Math.min(min, p.position.x);
    max = Math.max(max, p.position.x);
  }
  return max - min;
}

/** Z-extent (board-Y) of the footprint's pads. */
function padSpanZ(fp: Footprint): number {
  if (!fp.pads.length) return 4;
  let min = Infinity, max = -Infinity;
  for (const p of fp.pads) {
    min = Math.min(min, p.position.y);
    max = Math.max(max, p.position.y);
  }
  return max - min;
}

/**
 * Actual pad positions as (x, z) — radial components place their legs
 * HERE so models always land on the copper, whatever the layout engine
 * chose (guarantees the “match PCB layout” requirement).
 */
/**
 * Model-LOCAL leg positions for the footprint's pads. Pad.position is
 * board-ABSOLUTE (rotation baked in), so subtract the footprint center and
 * UN-rotate by the footprint angle — the result is the original def offset,
 * which is exactly where legs belong in the model's un-rotated frame (the
 * viewer then applies rotation.y = −θ, mapping them back onto the pads).
 */
function padPoints(fp: Footprint, maxPads = 4): [number, number][] {
  const a = (fp.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts: [number, number][] = fp.pads.slice(0, maxPads).map((p) => {
    const dx = p.position.x - fp.position.x;
    const dy = p.position.y - fp.position.y;
    return [dx * c + dy * s, -dx * s + dy * c];
  });
  return pts.length ? pts : [[-2.5, 0], [2.5, 0]];
}

/** Radial through-hole lead at (x, z) going down through the board. */
function radialLead(x: number, z: number, r = 0.25, depth = 2.4): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(r, r, depth, 12), MAT.lead, x, -depth / 2 + r, z);
}

/**
 * Formed IC / transistor leg: flat stamped pin that exits the package,
 * bends at a shoulder, and drops straight through its pad — with a slight
 * solder meniscus cone where it meets the copper. This is what makes DIP /
 * TO-92 / TO-220 legs read as REAL stamped metal instead of floating sticks:
 * flat cross-section (0.5×0.25mm, like real DIP leadframes), a visible
 * shoulder bend, and a solder cone hugging the pad.
 */
function formedPin(px: number, pz: number, topX: number, topY: number, topZ: number, w = 0.5, t = 0.25): THREE.Group {
  const g = new THREE.Group();
  // vertical pin through the board (flat stamped section)
  g.add(mesh(new THREE.BoxGeometry(w, 3.2, t), MAT.lead, px, -0.9, pz));
  // solder meniscus cone at the pad surface
  const cone = mesh(new THREE.CylinderGeometry(w * 0.9, w * 1.5, 0.7, 10), MAT.solder, px, 0.35, pz);
  g.add(cone);
  // shoulder: angled flat section from pad top up to the package exit point
  const dx = topX - px, dy = topY - 0.6, dz = topZ - pz;
  const len = Math.max(0.4, Math.hypot(dx, dy, dz));
  const shoulder = mesh(new THREE.BoxGeometry(w * 0.9, len, t * 0.9), MAT.lead, (px + topX) / 2, 0.6 + dy / 2, (pz + topZ) / 2);
  // orient the shoulder along the (dx,dy,dz) direction
  shoulder.lookAt(new THREE.Vector3(topX, topY, topZ).add(shoulder.position.clone().sub(new THREE.Vector3((px + topX) / 2, 0.6 + dy / 2, (pz + topZ) / 2))));
  shoulder.rotateX(Math.PI / 2);
  g.add(shoulder);
  return g;
}

/**
 * Gull-wing SMD leg: flat J-bend from the package edge down to a foot that
 * sits ON the pad copper, plus a solder fillet wedge climbing the heel.
 * Real SOIC/SOT-23 legs are flat stamped metal, never round wire.
 */
function gullWing(px: number, pz: number, edgeX: number, edgeZ: number, bodyExitY: number, w = 0.4): THREE.Group {
  const g = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(edgeX, bodyExitY, edgeZ),
    new THREE.Vector3((edgeX + px) / 2, 0.45, (edgeZ + pz) / 2),
    new THREE.Vector3(px, 0.12, pz),
  ], false, 'centripetal', 0.5);
  // flat wing: extrude a thin box along the curve via tube + squash
  const wing = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, w * 0.32, 4, false), MAT.lead);
  wing.scale.y = 0.55;
  wing.castShadow = true;
  g.add(wing);
  // flat foot ON the pad copper
  g.add(mesh(new THREE.BoxGeometry(w, 0.1, w * 1.8), MAT.lead, px, 0.06, pz));
  // solder fillet wedge at the heel
  const fillet = mesh(new THREE.CylinderGeometry(w * 0.7, w * 1.1, 0.35, 8), MAT.solder, px, 0.2, pz);
  g.add(fillet);
  return g;
}

/**
 * Is this footprint an SMD (surface-mount) part? SMD pads have no drill;
 * THT pads carry drill > 0. When the footprint mixes both, treat as THT.
 */
function isSMD(fp: Footprint): boolean {
  if (!fp.pads.length) return false;
  return fp.pads.every((p) => !p.drill || p.drill <= 0);
}

/**
 * Canvas-texture label cache — tiny printed markings (value codes, polarity,
 * part numbers) drawn once per unique string and reused. Real parts always
 * carry printed text; without it models read as toys.
 */
const labelCache = new Map<string, THREE.CanvasTexture>();
function textLabel(
  text: string,
  opts: { w?: number; h?: number; fontPx?: number; fg?: string; bg?: string; bold?: boolean } = {},
): THREE.CanvasTexture {
  const key = `${text}|${opts.w ?? 128}|${opts.h ?? 32}|${opts.fontPx ?? 22}|${opts.fg ?? '#fff'}|${opts.bg ?? 'clear'}|${opts.bold ?? true}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const w = opts.w ?? 128;
  const h = opts.h ?? 32;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  if (opts.bg && opts.bg !== 'clear') { g.fillStyle = opts.bg; g.fillRect(0, 0, w, h); }
  else g.clearRect(0, 0, w, h);
  g.fillStyle = opts.fg ?? '#ffffff';
  g.font = `${opts.bold === false ? '' : 'bold '}${opts.fontPx ?? 22}px ui-monospace, Menlo, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  labelCache.set(key, tex);
  return tex;
}

/** Flat printed label plane (decals: value codes, polarity marks, logos). */
function labelPlane(
  text: string, w: number, h: number,
  opts: { fontPx?: number; fg?: string; rotationX?: number } = {},
): THREE.Mesh {
  const tex = textLabel(text, { w: 256, h: Math.max(32, Math.round((256 * h) / Math.max(0.01, w))), fontPx: opts.fontPx ?? 44, fg: opts.fg ?? '#ffffff' });
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false }),
  );
  m.rotation.x = opts.rotationX ?? -Math.PI / 2;
  return m;
}

/**
 * SMD chip termination: 3-layer wrap (nickel barrier + tin outer) that
 * visually GRIPS the pad. Built as two nested boxes — inner nickel slightly
 * larger than the body end, outer tin slightly larger still — so the end cap
 * reads as plated wrap-around, not a painted box.
 */
function chipTermination(w: number, h: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const ni = mesh(new THREE.BoxGeometry(w * 1.06, h * 1.04, d * 1.04), MAT.nickel, 0, 0, 0);
  const sn = mesh(new THREE.BoxGeometry(w * 1.12, h * 1.08, d * 1.08), MAT.tin, 0, 0, 0);
  // tin is a thin SHELL: scale trick — outer tin box with inner nickel
  // showing through reads as layered plating at board zoom.
  g.add(ni, sn);
  // hide the tin's inner faces by making nickel poke out top/bottom slightly
  ni.scale.set(1.0, 1.02, 1.0);
  return g;
}

/**
 * SMD reflow solder fillet at a chip end: a concave meniscus wedge that
 * climbs from the pad surface up the termination face. Unlike the board-level
 * dome fillet, this one is part of the COMPONENT model so it always hugs the
 * exact termination — the "solder holds the leg" requirement.
 */
function smdFillet(padW: number, padH: number, termH: number): THREE.Mesh {
  // wedge: wide at pad, tapering up the termination wall
  const shape = new THREE.Shape();
  const L = padW * 0.55;   // fillet length along pad
  const H = termH * 0.75;  // climb height up the termination
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(L * 0.9, H * 0.08, L, H); // concave meniscus curve
  shape.lineTo(L, 0);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: padH * 0.9, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 1 });
  geo.translate(0, 0, -padH * 0.45);
  const m = new THREE.Mesh(geo, MAT.solder);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * Formed axial THT lead: ONE continuous tinned wire — a vertical pin through
 * the board joined to a horizontal run toward the component body by a smooth
 * 90° bend. Built as a single TubeGeometry along a centripetal Catmull-Rom
 * curve, so the bend reads as a real bent lead, not two dismembered sticks
 * (the old two-cylinder approach left a gap at the elbow and an octagonal
 * cross-section that faceted at every angle).
 *
 * @param padX        pad position on the X axis (board coordinates, model-local)
 * @param bodyHalfLen half-length of the body cylinder (the horizontal run
 *                    must reach the body end this far from the body center)
 * @param r           wire radius (mm)
 * @param bodyY       body center height above the board (mm) — where the lead
 *                    exits the end cap
 */
function bentLead(padX: number, bodyHalfLen: number, r = 0.25, bodyY = 0.9): THREE.Group {
  const g = new THREE.Group();
  const bendR = 0.9;                      // bend radius (centerline)
  const dir = padX >= 0 ? -1 : 1;         // horizontal run points toward the body center
  const bodyEndX = dir * bodyHalfLen;     // X of the body's end cap on this side
  const pts = [
    new THREE.Vector3(padX, -2.5, 0),             // through the board bottom edge
    new THREE.Vector3(padX, bodyY, 0),            // rise to the body axis height
    new THREE.Vector3(padX + dir * bendR, bodyY, 0), // bend shoulder
    new THREE.Vector3(bodyEndX, bodyY, 0),        // horizontal run into the body end
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, r, 10, false), MAT.lead);
  tube.castShadow = true;
  tube.receiveShadow = true;
  g.add(tube);
  return g;
}

// ─── Resistor color code (from the actual resistance value!) ────────────────
const BAND_COLORS: Record<number, number> = {
  0: 0x1a1a1a, 1: 0x8b4513, 2: 0xd0021b, 3: 0xd97706, 4: 0xd4b106,
  5: 0x16a34a, 6: 0x2563eb, 7: 0x7c3aed, 8: 0x9ca3af, 9: 0xf5f5f4,
};

/** Compute the 4-band color code digits for a resistance in ohms. */
function resistorBands(rOhms: number): number[] {
  let r = Math.max(0.1, rOhms);
  let mult = 0;
  while (r < 1 && mult > -6) { r *= 10; mult--; }
  while (r >= 100 && mult < 6) { r /= 10; mult++; }
  // 2 significant digits + multiplier exponent. `mult` is the power-of-ten
  // exponent in `d1d2 × 10^mult`, so it maps directly to the resistor band
  // color index (0 = black / ×10⁰, 1 = brown / ×10¹, 2 = red / ×10², …).
  // (The old `(mult + 9) % 10` was off by one — it produced brown instead of
  // red for 1 kΩ — and wrapped wrong for the negative sub-ohm exponents.)
  const d1 = Math.floor(r / 10);
  const d2 = Math.floor(r) % 10;
  const band = Math.max(0, Math.min(9, mult));
  return [d1, d2, band]; // multiplier index 0 = black
}

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Modern SMD chip resistor (0603/0805/1206): mini black body with wraparound
 * tin terminations + white value code on top + reflow fillets that climb the
 * termination walls. Real 0805 = 2.0×1.25×0.5mm; 0603 = 1.6×0.8×0.45mm.
 * Body size adapts to the pad span so it never overhangs the copper.
 */
function chipResistor(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(1.2, padSpanX(ctx.footprint));
  // body length ≈ 55% of pad-center span (terminations cover the rest)
  const bodyL = Math.min(3.0, Math.max(1.0, span * 0.55));
  const bodyW = Math.min(1.6, Math.max(0.7, bodyL * 0.55));
  const bodyH = Math.min(0.65, Math.max(0.4, bodyW * 0.45));
  const y = bodyH / 2 + 0.06; // sits on a solder paste film
  const pts = padPoints(ctx.footprint, 2);
  // body — slightly rounded black epoxy
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.08), MAT.chipResistor, 0, y, 0));
  // wraparound terminations at the EXACT pad positions (grip the copper)
  const termL = Math.min(0.6, bodyL * 0.22);
  for (const [px] of pts) {
    const t = chipTermination(termL, bodyH * 1.02, bodyW * 1.02);
    t.position.set(px > 0 ? bodyL / 2 - termL / 2 : -(bodyL / 2 - termL / 2), y, 0);
    g.add(t);
    // reflow fillet: climbs from pad up the termination outer face
    const f = smdFillet(0.7, bodyW, bodyH);
    f.position.set(px > 0 ? bodyL / 2 - termL * 0.4 : -(bodyL / 2 - termL * 0.4) - 0.7, 0.02, 0);
    if (px < 0) { f.rotation.y = Math.PI; f.position.x = -(bodyL / 2 - termL * 0.4); }
    g.add(f);
  }
  // white value code on top (e.g. "103" for 10k) — the #1 "real chip" cue
  try {
    const r = (ctx.params.resistance as number) ?? 10000;
    const code = r >= 1000 ? `${Math.round(r / 1000)}${r % 1000 === 0 ? '3' : '2'}` : `${Math.round(r)}`;
    const label = labelPlane(code.slice(0, 3), bodyL * 0.5, bodyW * 0.42, { fg: '#e8e8e8', fontPx: 40 });
    label.position.set(0, y + bodyH / 2 + 0.005, 0);
    g.add(label);
  } catch { /* label optional */ }
  return g;
}

/** Axial THT resistor: beige cylinder body, 4 color bands, dome ends, leads. */
function axialResistor(ctx: ModelBuildContext): THREE.Group {
  // Modern boards use SMD chips — route to the mini chip model when the
  // footprint has no drills (pads at ±2.1mm = 1206-ish SMD).
  if (isSMD(ctx.footprint)) return chipResistor(ctx);
  const g = new THREE.Group();
  const span = Math.max(6, Math.min(padSpanX(ctx.footprint), 16));
  // Real 1/4W axial: Ø2.3mm × 6.3mm body, Ø0.6mm leads. Old r=1.15 was chunky.
  const bodyLen = Math.min(span * 0.62, 6.4);
  const r = 1.0;
  // body
  const body = mesh(new THREE.CylinderGeometry(r, r, bodyLen, 20), MAT.resistorBody, 0, r + 0.25, 0);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  // domed ends (capsules give the classic rounded look)
  for (const s of [-1, 1]) {
    const cap = mesh(
      new THREE.SphereGeometry(r, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      MAT.resistorBody, s * bodyLen / 2, r + 0.25, 0,
    );
    cap.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(cap);
  }
  // color bands from the actual resistance — real 1/4W: 4 bands, first
  // band ~1mm from body end, 5th gold tolerance band near other end
  const bands = resistorBands((ctx.params.resistance as number) ?? 1000);
  const bandR = r * 1.04;
  const bandLen = bodyLen * 0.055;
  const start = -bodyLen / 2 + bodyLen * 0.14;
  const gap = bodyLen * 0.12;
  const bandMats = bands.map((d) =>
    new THREE.MeshStandardMaterial({ color: BAND_COLORS[d] ?? 0x333333, roughness: 0.5 }));
  for (let i = 0; i < bands.length; i++) {
    const band = mesh(
      new THREE.CylinderGeometry(bandR, bandR, bandLen, 20),
      bandMats[i], start + i * gap, r + 0.25, 0,
    );
    band.rotation.z = Math.PI / 2;
    g.add(band);
  }
  // gold tolerance band (5%) near the far end — the classic 4-band look
  const tol = mesh(
    new THREE.CylinderGeometry(bandR, bandR, bandLen, 20),
    new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.8, roughness: 0.35 }),
    bodyLen / 2 - bodyLen * 0.12, r + 0.25, 0,
  );
  tol.rotation.z = Math.PI / 2;
  g.add(tol);
  // formed leads to the pads (single curved wire, body end → pad)
  const bodyY = r + 0.25;
  g.add(bentLead(span / 2, bodyLen / 2, 0.25, bodyY));
  g.add(bentLead(-span / 2, bodyLen / 2, 0.25, bodyY));
  return g;
}

/** Electrolytic capacitor: can + polarity stripe + scored top + 2 leads. */
function electrolyticCap(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  // Real mini radial electrolytics: Ø5×11mm, Ø6.3×11mm most common.
  // Old canR up to 4.0 (Ø8mm) + canH up to 11.5 was oversized for logic boards.
  const spanZ = Math.max(1.6, padSpanZ(ctx.footprint));
  const canR = Math.max(1.6, Math.min(spanZ * 1.1, 3.2));
  const canH = Math.max(5, Math.min(canR * 2.4, 9));
  // can body
  const can = mesh(new THREE.CylinderGeometry(canR, canR * 1.03, canH, 28), MAT.elecCan, 0, canH / 2, 0);
  g.add(can);
  // rubber bung at the can base (black ring under the crimp)
  g.add(mesh(new THREE.CylinderGeometry(canR * 0.98, canR * 1.0, 0.5, 28), MAT.rubber, 0, 0.25, 0));
  // crimp ring at the can base — the slight bulge where the aluminum can
  // is mechanically crimped around the rubber bung. A subtle torus that
  // reads as "real electrolytic" at any zoom level.
  const crimpRing = new THREE.Mesh(
    new THREE.TorusGeometry(canR * 1.04, 0.22, 8, 28),
    MAT.aluminum,
  );
  crimpRing.rotation.x = Math.PI / 2;
  crimpRing.position.y = 0.55;
  crimpRing.castShadow = true;
  g.add(crimpRing);
  // aluminum top with a subtle bevel
  const top = mesh(new THREE.CylinderGeometry(canR * 0.97, canR * 0.97, 0.3, 28), MAT.aluminum, 0, canH + 0.1, 0);
  g.add(top);
  // scored vent cross on top (two thin dark strips)
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x3a4050, roughness: 0.6 });
  for (const rot of [0, Math.PI / 2]) {
    const strip = mesh(new THREE.BoxGeometry(canR * 1.5, 0.06, canR * 0.12), ventMat, 0, canH + 0.28, 0);
    strip.rotation.y = rot;
    g.add(strip);
  }
  // polarity stripe (light band on the negative side, -Y board direction)
  const stripe = mesh(
    new THREE.CylinderGeometry(canR * 1.01, canR * 1.01, canH * 0.86, 28, 1, true, Math.PI / 2 + 0.35, Math.PI - 0.7),
    new THREE.MeshStandardMaterial({ color: 0xbfc9d9, roughness: 0.5 }), 0, canH / 2, 0,
  );
  g.add(stripe);
  // minus glyphs on the stripe — the actual polarity marking on real cans
  // (a column of small dark "−" bars inside the light stripe)
  const minusMat = new THREE.MeshStandardMaterial({ color: 0x1a2440, roughness: 0.55 });
  const stripeAngle = Math.PI / 2 + 0.35 + (Math.PI - 0.7) / 2; // stripe center angle
  const glyphR = canR * 1.03;
  for (let i = -2; i <= 2; i++) {
    const gx = Math.cos(stripeAngle) * glyphR;
    const gz = Math.sin(stripeAngle) * glyphR;
    const bar = mesh(new THREE.BoxGeometry(0.55, 0.1, 0.14), minusMat, gx, canH / 2 + i * (canH / 6.5), gz);
    bar.lookAt(0, canH / 2 + i * (canH / 6.5), 0);
    g.add(bar);
  }
  // sleeve seam (vertical line where the PVC sleeve overlaps)
  g.add(mesh(new THREE.BoxGeometry(0.08, canH * 0.86, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x0d1526, roughness: 0.5 }), canR * 0.99, canH / 2, -canR * 0.2));
  // stripe + two kinked leads at the ACTUAL pad positions (match PCB layout)
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x * 0.5, 0.6, z * 0.5),
      new THREE.Vector3(x, 0.4, z),
      new THREE.Vector3(x, -2.4, z),
    ], false, 'centripetal', 0.5);
    const lead = new THREE.Mesh(new THREE.TubeGeometry(curve, 14, 0.25, 8, false), MAT.lead);
    lead.castShadow = true;
    g.add(lead);
    g.add(mesh(new THREE.CylinderGeometry(0.42, 0.68, 0.6, 10), MAT.solder, x, 0.3, z));
  }
  // printed capacitance/voltage rating on the sleeve (e.g. "100µ 16V")
  try {
    const cap = (ctx.params.capacitance as number) ?? 1e-4;
    const uf = cap >= 1e-6 ? `${Math.round(cap * 1e6)}µ` : `${Math.round(cap * 1e9)}n`;
    const label = labelPlane(`${uf} 16V`, canR * 1.6, canH * 0.16, { fg: '#dfe6f2', fontPx: 34 });
    // place on the can side opposite the stripe (angle 0 = +X)
    label.rotation.z = Math.PI / 2;
    label.position.set(canR * 1.005, canH * 0.55, 0);
    label.rotation.y = Math.PI / 2;
    g.add(label);
  } catch { /* label optional */ }
  return g;
}

/** Ceramic disc capacitor: coated disc with dipped meniscus, value print, kinked leads. */
function ceramicCap(ctx: ModelBuildContext): THREE.Group {
  // Modern boards: SMD MLCC mini box with layered terminations + fillets
  if (isSMD(ctx.footprint)) return mlccChip(ctx);
  const g = new THREE.Group();
  const span = Math.max(2.5, padSpanX(ctx.footprint));
  // dipped disc: flattened sphere with glossy epoxy coating
  const r = Math.min(span * 0.42, 3.2);
  const coatMat = new THREE.MeshPhysicalMaterial({ color: 0xc2571b, roughness: 0.35, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  const disc = mesh(new THREE.SphereGeometry(r, 28, 18), coatMat, 0, 2.4, 0);
  disc.scale.set(1, 0.42, 0.55);
  g.add(disc);
  // dipped meniscus blobs where the leads exit the coating
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.SphereGeometry(0.55, 12, 10), coatMat, s * r * 0.45, 1.15, 0));
  }
  // value print (e.g. "104") on the disc face
  try {
    const cap = (ctx.params.capacitance as number) ?? 1e-7;
    const pf = Math.round(cap * 1e12);
    const code = pf >= 1000 ? `${Math.round(pf / 100)}${pf % 100 === 0 ? '3' : '2'}`.slice(0, 3) : `${pf}`;
    const label = labelPlane(code.slice(0, 3), r * 0.9, r * 0.4, { fg: '#1c0a00', fontPx: 40 });
    label.rotation.z = Math.PI / 2;
    label.position.set(r * 0.42, 2.4, 0);
    label.rotation.y = Math.PI / 2;
    g.add(label);
  } catch { /* label optional */ }
  // kinked radial leads (real discs have a stress-relief kink) + solder cones
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x * 0.35, 1.3, z * 0.35),
      new THREE.Vector3(x * 0.9, 0.9, z * 0.9),
      new THREE.Vector3(x, 0.5, z),
      new THREE.Vector3(x, -2.4, z),
    ], false, 'centripetal', 0.5);
    const lead = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.2, 8, false), MAT.lead);
    lead.castShadow = true;
    g.add(lead);
    g.add(mesh(new THREE.CylinderGeometry(0.38, 0.6, 0.55, 10), MAT.solder, x, 0.28, z));
  }
  return g;
}

/** Modern SMD MLCC chip (0603/0805): layered terminations, solder meniscus, value print. */
function mlccChip(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(1.2, padSpanX(ctx.footprint));
  const bodyL = Math.min(2.8, Math.max(0.9, span * 0.52));
  const bodyW = Math.min(1.5, Math.max(0.65, bodyL * 0.55));
  const bodyH = Math.min(0.9, Math.max(0.4, bodyW * 0.6));
  const y = bodyH / 2 + 0.05;
  const pts = padPoints(ctx.footprint, 2);
  // Class-II tan vs C0G dark by capacitance value when known
  const cap = (ctx.params.capacitance as number) ?? 1e-7;
  const bodyMat = cap < 1e-9 ? MAT.mlccDark : MAT.mlcc;
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.07), bodyMat, 0, y, 0));
  // top glaze stripe (fired ceramic sheen)
  g.add(mesh(new THREE.BoxGeometry(bodyL * 0.7, 0.04, bodyW * 0.7),
    new THREE.MeshPhysicalMaterial({ color: 0xd9b98a, roughness: 0.3, clearcoat: 0.6 }), 0, y + bodyH / 2 + 0.01, 0));
  const termL = Math.min(0.55, bodyL * 0.24);
  for (const [px] of pts) {
    const t = chipTermination(termL, bodyH * 1.02, bodyW * 1.02);
    t.position.set(px > 0 ? bodyL / 2 - termL / 2 : -(bodyL / 2 - termL / 2), y, 0);
    g.add(t);
    // concave solder meniscus climbing the termination wall
    const f = smdFillet(0.65, bodyW, bodyH);
    f.position.set(px > 0 ? bodyL / 2 - termL * 0.4 - 0.65 : -(bodyL / 2 - termL * 0.4), 0.02, 0);
    if (px < 0) f.rotation.y = Math.PI;
    g.add(f);
  }
  return g;
}

/** SOD-123 SMD diode: mini black molded body, cathode bar, wrap terminals. */
function sodDiode(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(1.6, padSpanX(ctx.footprint));
  const bodyL = Math.min(2.4, Math.max(1.2, span * 0.5));
  const bodyW = Math.min(1.4, Math.max(0.8, bodyL * 0.55));
  const bodyH = Math.min(0.8, Math.max(0.45, bodyW * 0.5));
  const y = bodyH / 2 + 0.05;
  const pts = padPoints(ctx.footprint, 2);
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.07), MAT.sodBody, 0, y, 0));
  // cathode bar (white band near the k terminal = +X side)
  const bar = mesh(new THREE.BoxGeometry(bodyL * 0.12, bodyH * 0.2, bodyW * 0.9),
    new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 }), bodyL * 0.32, y + bodyH * 0.32, 0);
  g.add(bar);
  const termL = Math.min(0.5, bodyL * 0.24);
  for (const [px] of pts) {
    const t = chipTermination(termL, bodyH * 1.02, bodyW * 1.02);
    t.position.set(px > 0 ? bodyL / 2 - termL / 2 : -(bodyL / 2 - termL / 2), y, 0);
    g.add(t);
    const f = smdFillet(0.6, bodyW, bodyH);
    f.position.set(px > 0 ? bodyL / 2 - termL * 0.4 - 0.6 : -(bodyL / 2 - termL * 0.4), 0.02, 0);
    if (px < 0) f.rotation.y = Math.PI;
    g.add(f);
  }
  return g;
}

/** SMD LED (0805/PLCC): white reflector + tinted dome + live sim glow. */
function smdLed(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const colorMap: Record<string, number> = {
    red: 0xff2418, green: 0x30d158, blue: 0x2f6bff, yellow: 0xffd60a, white: 0xf5f5f5, orange: 0xff9f0a,
  };
  const color = colorMap[(ctx.params.color as string) ?? 'red'] ?? 0xff2418;
  const span = Math.max(1.4, padSpanX(ctx.footprint));
  const bodyL = Math.min(2.6, Math.max(1.2, span * 0.55));
  const bodyW = Math.min(1.5, Math.max(0.8, bodyL * 0.55));
  const bodyH = Math.min(0.9, Math.max(0.5, bodyW * 0.55));
  const y = bodyH / 2 + 0.05;
  const pts = padPoints(ctx.footprint, 2);
  // white PPA reflector body
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.07), MAT.ledReflector, 0, y, 0));
  // tinted lens dome in the center
  const lensMat = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.9,
    transmission: 0.3, ior: 1.54, thickness: 0.6,
    clearcoat: 1.0, clearcoatRoughness: 0.08,
    emissive: color, emissiveIntensity: 0,
  });
  const dome = mesh(new THREE.SphereGeometry(Math.min(bodyL, bodyW) * 0.32, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), lensMat, 0, y + bodyH / 2 - 0.05, 0);
  dome.scale.y = 0.7;
  g.add(dome);
  const termL = Math.min(0.5, bodyL * 0.24);
  for (const [px] of pts) {
    const t = chipTermination(termL, bodyH * 1.02, bodyW * 1.02);
    t.position.set(px > 0 ? bodyL / 2 - termL / 2 : -(bodyL / 2 - termL / 2), y, 0);
    g.add(t);
    const f = smdFillet(0.6, bodyW, bodyH);
    f.position.set(px > 0 ? bodyL / 2 - termL * 0.4 - 0.6 : -(bodyL / 2 - termL * 0.4), 0.02, 0);
    if (px < 0) f.rotation.y = Math.PI;
    g.add(f);
  }
  const glow = new THREE.PointLight(color, 0, 18, 2);
  glow.position.set(0, y + 1.2, 0);
  g.add(glow);
  (g as any).__updateEmissive = (amps: number) => {
    const lit = Math.min(1, Math.abs(amps) / 0.008);
    lensMat.emissiveIntensity = lit * 2.4;
    glow.intensity = lit * 5;
  };
  return g;
}

/** DO-35/DO-41 glass diode: cylinder + white cathode stripe + leads. */
function glassDiode(ctx: ModelBuildContext): THREE.Group {
  // Modern boards: SOD-123 mini molded diode with cathode bar + fillets
  if (isSMD(ctx.footprint)) return sodDiode(ctx);
  const g = new THREE.Group();
  const span = Math.max(6, Math.min(padSpanX(ctx.footprint), 14));
  const bodyLen = Math.min(span * 0.55, 5.2);
  const r = 0.85;
  const body = mesh(new THREE.CylinderGeometry(r, r, bodyLen, 18), MAT.diodeGlass, 0, r, 0);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  // cathode stripe(s)
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 });
  for (const off of [bodyLen * 0.36, bodyLen * 0.26]) {
    const st = mesh(new THREE.CylinderGeometry(r * 1.03, r * 1.03, bodyLen * 0.07, 18), stripeMat, off, r, 0);
    st.rotation.z = Math.PI / 2;
    g.add(st);
  }
  g.add(bentLead(span / 2, bodyLen / 2, 0.2, r));
  g.add(bentLead(-span / 2, bodyLen / 2, 0.2, r));
  return g;
}

/** 5 mm LED: colored lens dome + flange + 2 legs (long anode). When powered,
 *  the lens glows AND a PointLight inside the dome actually illuminates the
 *  board and neighboring components (like a real lit LED). */
function ledModel(ctx: ModelBuildContext): THREE.Group {
  // Modern boards: SMD PLCC/0805 LED with reflector + dome + live glow
  if (isSMD(ctx.footprint)) return smdLed(ctx);
  const g = new THREE.Group();
  const colorMap: Record<string, number> = {
    red: 0xff2418, green: 0x30d158, blue: 0x2f6bff, yellow: 0xffd60a, white: 0xf5f5f5, orange: 0xff9f0a,
  };
  const colorName = (ctx.params.color as string) ?? 'red';
  const color = colorMap[colorName] ?? 0xff2418;
  const tint = new THREE.Color(color);
  // Water-clear / tinted epoxy dome: IOR 1.54, real transmission, a hint of
  // attenuation — reads as glass, not painted plastic. When the sim runs,
  // emissive + attenuation shift make the whole lens light up.
  const lensMat = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.07, metalness: 0.0,
    transparent: true, opacity: 0.92, transmission: 0.55, ior: 1.54, thickness: 2.2,
    attenuationColor: tint, attenuationDistance: 3.2,
    clearcoat: 1.0, clearcoatRoughness: 0.06,
    emissive: color, emissiveIntensity: 0,
  });
  const domeR = 2.5;
  // base cylinder + dome + flange — flange BOTTOM sits at y = 0 (on the
  // board); legs reach up inside the flange. (A stray +1.4 offset on every
  // part used to float the whole lens 1.4 mm above its own legs.)
  g.add(mesh(new THREE.CylinderGeometry(domeR, domeR * 1.02, 2.2, 24), lensMat, 0, 1.1, 0));
  const dome = mesh(new THREE.SphereGeometry(domeR, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), lensMat, 0, 2.2, 0);
  g.add(dome);
  // flange ring with the classic FLAT SPOT (cathode marker on real 5 mm LEDs).
  // Previous approach: full cylinder + a separate BoxGeometry "cut" — looked
  // like a glued-on chunk. Now uses an extruded Shape with a flat segment
  // so the flange is ONE seamless mesh with a machined-in flat.
  const flangeR = domeR * 1.12;
  const flangeH = 0.7;
  {
    const shape = new THREE.Shape();
    const segments = 48;
    const flatAngle = 0.55; // radians the flat chord spans (~32°)
    // flat is centered on the −X side (cathode side); the arc wraps from
    // just past the flat all the way around back to the flat's other edge.
    const startAngle = Math.PI + flatAngle / 2;
    const totalAngle = Math.PI * 2 - flatAngle;
    for (let i = 0; i <= segments; i++) {
      const a = startAngle + (totalAngle / segments) * i;
      const px = Math.cos(a) * flangeR;
      const py = Math.sin(a) * flangeR;
      if (i === 0) shape.moveTo(px, py);
      else shape.lineTo(px, py);
    }
    shape.closePath(); // straight line across the flat
    const flangeGeo = new THREE.ExtrudeGeometry(shape, { depth: flangeH, bevelEnabled: false, curveSegments: 1 });
    // ExtrudeGeometry extrudes along +Z; rotate so the shape lies in XZ and
    // extrusion runs along Y (like a CylinderGeometry standing on the board).
    flangeGeo.rotateX(-Math.PI / 2);
    const flangeMesh = new THREE.Mesh(flangeGeo, lensMat);
    flangeMesh.castShadow = true;
    flangeMesh.receiveShadow = true;
    g.add(flangeMesh);
  }
  // inner structure visible through the transmissive epoxy: metal reflector
  // cup + die post (the "anvil") — the #1 detail that makes LEDs read real
  const cup = mesh(
    new THREE.CylinderGeometry(0.75, 0.35, 0.55, 16),
    new THREE.MeshPhysicalMaterial({ color: 0xd9dde2, metalness: 1.0, roughness: 0.25 }),
    0.28, 0.55, 0,
  );
  const post = mesh(
    new THREE.BoxGeometry(0.3, 1.1, 0.3),
    new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.3 }),
    -0.28, 1.0, 0,
  );
  g.add(cup, post);
  // legs at the actual pad positions; anode ('a') is the longer one — tops
  // reach y = 1.6, inside the lens body
  const padPts = padPoints(ctx.footprint, 2);
  for (let i = 0; i < padPts.length; i++) {
    const [x, z] = padPts[i];
    const padId = ctx.footprint.pads[i]?.terminalId;
    const isAnode = padId === 'a' || i === 0;
    const len = isAnode ? 4.4 : 3.4;
    g.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, len, 8), MAT.lead, x, -len / 2 + 1.6, z));
  }
  // real light inside the dome — illuminates the board + neighbors when lit
  const glowLight = new THREE.PointLight(color, 0, 30, 2);
  glowLight.position.set(0, 3.4, 0);
  g.add(glowLight);
  // emissive die (visible through the transmissive dome)
  const core = mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: color, emissiveIntensity: 0, roughness: 0.4,
  }), 0, 2.4, 0);
  g.add(core);
  // emissive hook — the render loop calls this with live sim current.
  // Tuned so a 10 mA LED reads clearly lit WITHOUT blowing out tone
  // mapping + bloom (previous 4.0/15 cd washed the whole board white).
  (g as any).__updateEmissive = (amps: number) => {
    const lit = Math.min(1, Math.abs(amps) / 0.008); // full glow at ~8 mA
    lensMat.emissiveIntensity = lit * 2.2;
    (core.material as THREE.MeshStandardMaterial).emissiveIntensity = lit * 3.5;
    glowLight.intensity = lit * 8;
  };
  return g;
}

/** TO-92 transistor: D-shaped black body + 3 stamped splayed legs with solder cones. */
function to92(ctx: ModelBuildContext): THREE.Group {
  // Modern SOT-23 footprints (no drills) get the mini SMD model instead
  if (isSMD(ctx.footprint)) return sot23(ctx);
  const g = new THREE.Group();
  // Real TO-92: Ø4.5mm body, 1.27mm pitch inline leads, flat stamped legs
  const spanZ = Math.max(2.0, padSpanZ(ctx.footprint));
  const bodyR = Math.min(2.3, Math.max(1.9, spanZ * 0.62));
  const bodyH = 4.6;
  const bodyY = bodyH / 2 + 0.8;
  // D-shaped body: round front + molded flat back face (label side).
  // Built as a full cylinder PLUS a flat back plate that overlaps it, so the
  // silhouette reads D-shaped from every angle (the old arc-only body showed
  // a hollow gap from behind).
  const body = mesh(new THREE.CylinderGeometry(bodyR, bodyR * 1.02, bodyH, 28), MAT.blackPlastic, 0, bodyY, 0);
  g.add(body);
  // flat back face: dark inset panel with beveled look
  g.add(mesh(new RoundedBoxGeometry(0.6, bodyH * 0.94, bodyR * 1.7, 2, 0.12), MAT.dipBody, -bodyR + 0.25, bodyY, 0));
  // molded top bevel ring
  const bevel = mesh(new THREE.CylinderGeometry(bodyR * 0.92, bodyR, 0.35, 28), MAT.blackPlastic, 0, bodyY + bodyH / 2 - 0.1, 0);
  g.add(bevel);
  // laser-etched part marking on the flat face (the "real transistor" cue)
  try {
    const marking = (ctx.params.partNumber as string) || ctx.footprint.refdes || '2N3904';
    const label = labelPlane(String(marking).slice(0, 8), bodyR * 1.3, 0.9, { fg: '#b8b8bc', fontPx: 34 });
    label.rotation.z = Math.PI / 2;
    label.position.set(-bodyR - 0.06, bodyY + 0.4, 0);
    label.rotation.y = -Math.PI / 2;
    g.add(label);
  } catch { /* label optional */ }
  // 3 FLAT stamped legs (real TO-92 legs are 0.5×0.25mm stamped strip, not
  // round wire) that splay from the body bottom to the pad row, each with a
  // solder meniscus cone where it meets the copper.
  const padPts = padPoints(ctx.footprint, 3);
  const legs = padPts.length >= 3 ? padPts : [[-bodyR * 0.5, -spanZ / 2.2], [-bodyR * 0.5, 0], [-bodyR * 0.5, spanZ / 2.2]];
  for (let i = 0; i < 3; i++) {
    const [px, pz] = legs[i];
    const topX = -bodyR * 0.3 + (i === 1 ? 0.35 : -0.1);
    g.add(formedPin(px, pz, topX, bodyY - bodyH / 2, pz * 0.55));
  }
  return g;
}

/** TO-220 (regulators, power MOSFETs): black body + metal tab + hole + 3 stamped legs. */
function to220(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(2.2, padSpanZ(ctx.footprint));
  const bodyW = Math.max(7, spanZ + 2.5);
  // metal tab with brushed finish + REAL mounting hole (dark inner cylinder
  // so it reads as a through-hole, not a painted dot)
  const tab = mesh(new THREE.BoxGeometry(1.5, 9.5, bodyW), MAT.tab, -1.6, 4.75, 0);
  g.add(tab);
  const holeOuter = mesh(new THREE.CylinderGeometry(1.6, 1.6, 1.7, 20), MAT.tab, -1.6, 8.4, 0);
  holeOuter.rotation.z = Math.PI / 2;
  g.add(holeOuter);
  const holeInner = mesh(new THREE.CylinderGeometry(1.15, 1.15, 1.75, 20),
    new THREE.MeshStandardMaterial({ color: 0x05080e, roughness: 0.9 }), -1.6, 8.4, 0);
  holeInner.rotation.z = Math.PI / 2;
  g.add(holeInner);
  // plastic body — rounded edges for the molded look + parting line
  g.add(mesh(new RoundedBoxGeometry(3.2, 10.2, bodyW * 0.86, 2, 0.2), MAT.blackPlastic, 0.2, 5.1, 0));
  g.add(mesh(new THREE.BoxGeometry(3.25, 0.12, bodyW * 0.86),
    new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.7 }), 0.2, 5.1, 0));
  // front face: laser-etched part number (the "real regulator" cue)
  try {
    const marking = (ctx.params.partNumber as string) || ctx.footprint.refdes || '7805';
    const label = labelPlane(String(marking).slice(0, 8), bodyW * 0.5, 1.2, { fg: '#c8c8cc', fontPx: 36 });
    label.rotation.z = Math.PI / 2;
    label.position.set(1.86, 6.2, 0);
    label.rotation.y = Math.PI / 2;
    g.add(label);
  } catch { /* label optional */ }
  // 3 FLAT stamped legs with the signature TO-220 dogleg: exit body bottom,
  // step outward, drop straight through the pad — each with a solder cone.
  const padPts = padPoints(ctx.footprint, 3);
  const leadDefs = padPts.length >= 3
    ? padPts.map(([px, pz]) => ({ px, pz }))
    : [{ px: 0.6, pz: -spanZ / 2.15 }, { px: 0.6, pz: 0 }, { px: 0.6, pz: spanZ / 2.15 }];
  for (const { px, pz } of leadDefs) {
    g.add(formedPin(px, pz, 0.6, 1.2, pz, 0.7, 0.4));
  }
  return g;
}

/** DIP IC: black body, pin-1 notch + dot, stamped legs with solder cones. */
function dipIC(ctx: ModelBuildContext): THREE.Group {
  // SMD IC footprints (SOIC pads, no drills) get the gull-wing model
  if (isSMD(ctx.footprint)) return soicIC(ctx);
  const g = new THREE.Group();
  const spanZ = Math.max(6, padSpanZ(ctx.footprint)); // across pin rows
  const npins = Math.max(4, ctx.footprint.pads.length);
  const spanX = Math.max(6, padSpanX(ctx.footprint));
  // Real DIP: 2.54mm pitch, 7.62mm row span (300mil), 3.3mm tall body
  const pinCount = Math.max(2, Math.round(npins / 2));
  const bodyL = Math.max(spanX * 0.92, (pinCount - 1) * 2.54 + 3.2);
  const bodyW = 6.2;
  const bodyH = 3.3;
  const bodyBaseY = 0.4;
  // body — rounded edges for the molded epoxy look + top bevel
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.15), MAT.dipBody, 0, bodyH / 2 + bodyBaseY, 0));
  g.add(mesh(new THREE.BoxGeometry(bodyL * 0.98, 0.18, bodyW * 0.96),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.65 }), 0, bodyH + bodyBaseY - 0.05, 0));
  // pin-1 notch: REAL semicircular cutout at the body end (dark inset
  // half-cylinder sunk into the end face, not a floating disc)
  const notchMat = new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.85 });
  const notch = mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.5, 16, 1, false, 0, Math.PI), notchMat, -bodyL / 2 + 0.1, bodyH / 2 + bodyBaseY, 0);
  notch.rotation.z = Math.PI / 2;
  notch.rotation.y = Math.PI / 2;
  g.add(notch);
  // pin-1 dot: circular dimple (dark ring + lighter center)
  g.add(mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.1, 16),
    new THREE.MeshStandardMaterial({ color: 0x2e2e34, roughness: 0.6 }),
    -bodyL / 2 + 2.0, bodyH + bodyBaseY + 0.02, -bodyW / 2 + 0.9));
  // laser-etched part number + date code on top (two lines, like real chips)
  try {
    const partNo = (ctx.params.partNumber as string) || ctx.footprint.refdes || 'NE555';
    const label = labelPlane(String(partNo).slice(0, 12), Math.min(bodyL * 0.5, 6), 1.0, { fg: '#c8c8cc', fontPx: 36 });
    label.position.set(0.3, bodyH + bodyBaseY + 0.06, 0);
    g.add(label);
    const dateCode = labelPlane('2418 PH', Math.min(bodyL * 0.35, 4), 0.8, { fg: '#8a8a90', fontPx: 32 });
    dateCode.position.set(0.3, bodyH + bodyBaseY + 0.06, 1.3);
    g.add(dateCode);
  } catch { /* label optional */ }
  // legs: FLAT stamped leadframe pins (0.5×0.25mm) with shoulder bend +
  // solder cone at each pad — land on the EXACT pad positions.
  const pts = padPoints(ctx.footprint, pinCount * 2);
  if (pts.length >= 2) {
    for (const [px, pz] of pts) {
      const edgeZ = pz > 0 ? bodyW / 2 : -bodyW / 2;
      g.add(formedPin(px, pz, px, 1.6, edgeZ * 0.85));
    }
  } else {
    for (const rowZ of [-1, 1]) {
      for (let i = 0; i < pinCount; i++) {
        const px = -bodyL / 2 + (bodyL / (pinCount + 0.001)) * (i + 0.5) * 0.98 + bodyL / (pinCount * 4);
        const z = rowZ * (spanZ / 2);
        g.add(formedPin(px, z, px, 1.6, rowZ * (bodyW / 2) * 0.85));
      }
    }
  }
  return g;
}

/** SOIC / SMD IC: low-profile body + gull-wing pins. */
function soicIC(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const npins = Math.max(4, ctx.footprint.pads.length);
  const spanZ = Math.max(3, padSpanZ(ctx.footprint));
  // body length adapts to the pad span along X so long ICs (CD4017, 74245)
  // never overhang short footprints
  const spanX = Math.max(3.8, padSpanX(ctx.footprint));
  // Real SOIC-8: 5×4mm body, 1.27mm pitch, 1.75mm tall
  const pinCount = Math.max(2, Math.round(npins / 2));
  const bodyL = Math.max(3.8, (pinCount - 1) * 1.27 + 2.2);
  const bodyW = Math.min(4.0, Math.max(spanZ * 0.62, 2.5));
  const bodyH = 1.75;
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.12), MAT.dipBody, 0, bodyH / 2 + 0.15, 0));
  // pin-1 chamfer marker (small beige dot)
  g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 10),
    new THREE.MeshStandardMaterial({ color: 0x8a8a90, roughness: 0.5 }),
    -bodyL / 2 + 0.8, bodyH + 0.16, -bodyW / 2 + 0.6));
  // laser-etched refdes on top
  try {
    const label = labelPlane(ctx.footprint.refdes || 'U', Math.min(bodyL * 0.45, 4), 0.9, { fg: '#c8c8cc', fontPx: 36 });
    label.position.set(0, bodyH + 0.2, 0);
    g.add(label);
  } catch { /* label optional */ }
  // gull-wing legs: FLAT stamped J-bends with feet ON the copper + solder
  // fillets — land on EXACT pad positions.
  const pts = padPoints(ctx.footprint, pinCount * 2);
  const pinDefs = pts.length >= 2
    ? pts.map(([px, pz]) => ({ px, pz }))
    : (() => {
      const arr: { px: number; pz: number }[] = [];
      for (const rowZ of [-1, 1]) {
        for (let i = 0; i < pinCount; i++) {
          arr.push({ px: -bodyL / 2 + (bodyL / pinCount) * (i + 0.5), pz: rowZ * (spanZ / 2) });
        }
      }
      return arr;
    })();
  for (const { px, pz } of pinDefs) {
    const dir = pz > 0 ? 1 : -1;
    const edgeZ = dir * (bodyW / 2);
    g.add(gullWing(px, pz, px, edgeZ - dir * 0.15, bodyH * 0.7));
  }
  return g;
}

/** SOT-23 (small-signal MOSFET/JFET): tiny body + 3 flat gull wings. */
function sot23(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  // Real SOT-23: 2.9×1.3mm body, 0.95mm pitch, 1.1mm tall
  const pts = padPoints(ctx.footprint, 3);
  const body = mesh(new RoundedBoxGeometry(1.4, 1.1, 2.9, 2, 0.08), MAT.blackPlastic, 0, 0.65, 0);
  // NOTE: body X=1.4 (along leads), Z=2.9 (across) — matches SOT-23 def
  // pads at x=±1.0 / y=±1.0. Rotate body so long axis spans the pad row.
  body.rotation.y = Math.PI / 2;
  // swap: after rotation the 2.9 length lies along X
  g.add(body);
  // top marking dot (pin-1)
  g.add(mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.06, 10),
    new THREE.MeshStandardMaterial({ color: 0x8a8a90, roughness: 0.5 }), -0.9, 1.22, -0.9));
  // flat gull-wing feet land on the EXACT pad positions
  const defs = pts.length >= 3 ? pts : [[0.55, -1], [0.55, 1], [-0.55, 0]] as [number, number][];
  for (const [px, pz] of defs) {
    const dir = px > 0 ? 1 : -1;
    g.add(gullWing(px, pz, dir * 0.6, pz, 0.8, 0.35));
  }
  return g;
}

/** HC-49 crystal: metal oval can + base + 2 leads. */
function crystal(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  // Modern SMD crystals are 3.2×2.5mm ceramic; THT HC-49S is 11×4.5mm.
  // Footprint span decides: tight SMD span → mini SMD can.
  const span = Math.max(1.5, padSpanZ(ctx.footprint));
  if (isSMD(ctx.footprint) || span < 4) {
    const bodyL = Math.min(3.4, Math.max(2.0, span * 0.8));
    const bodyW = bodyL * 0.75;
    const bodyH = 0.8;
    const y = bodyH / 2 + 0.05;
    g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.1), MAT.aluminum, 0, y, 0));
    try {
      const label = labelPlane('16.0', bodyL * 0.5, bodyW * 0.35, { fg: '#3a3a3e', fontPx: 36 });
      label.position.set(0, y + bodyH / 2 + 0.005, 0);
      g.add(label);
    } catch { /* label optional */ }
    const pts = padPoints(ctx.footprint, 2);
    const termL = 0.5;
    for (const [px] of pts) {
      const t = chipTermination(termL, bodyH, bodyW);
      t.position.set(px > 0 ? bodyL / 2 - termL / 2 : -(bodyL / 2 - termL / 2), y, 0);
      g.add(t);
    }
    return g;
  }
  const canR = Math.min(3.2, Math.max(2.2, span / 2 + 0.5));
  const canH = 3.0;
  // oval can (scaled cylinder)
  const can = mesh(new THREE.CylinderGeometry(canR, canR, canH, 28), MAT.aluminum, 0, canH / 2 + 0.9, 0);
  can.scale.x = 0.62;
  g.add(can);
  const cap = mesh(new THREE.SphereGeometry(canR, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), MAT.aluminum, 0, canH + 0.9, 0);
  cap.scale.x = 0.62;
  cap.scale.y = 0.55;
  g.add(cap);
  // base flange
  g.add(mesh(new THREE.BoxGeometry(canR * 0.9, 0.7, canR * 2), MAT.aluminum, 0, 0.55, 0));
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.8, 8), MAT.lead, 0, -0.5, s * span / 2));
  }
  return g;
}

/** Radial inductor: ferrite drum core wrapped with copper rings. */
function inductorModel(ctx: ModelBuildContext): THREE.Group {
  // Modern boards: SMD wirewound chip inductor (0805: 2×1.25mm) when SMD
  if (isSMD(ctx.footprint)) {
    const g = new THREE.Group();
    const span = Math.max(1.2, padSpanX(ctx.footprint));
    const bodyL = Math.min(2.6, Math.max(1.0, span * 0.55));
    const bodyW = Math.min(1.5, Math.max(0.7, bodyL * 0.55));
    const bodyH = Math.min(1.0, Math.max(0.5, bodyW * 0.6));
    const y = bodyH / 2 + 0.05;
    const pts = padPoints(ctx.footprint, 2);
    // dark ferrite body with visible copper winding band in the middle
    g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.07),
      new THREE.MeshStandardMaterial({ color: 0x2e2e33, roughness: 0.6, metalness: 0.2 }), 0, y, 0));
    g.add(mesh(new THREE.BoxGeometry(bodyL * 0.4, bodyH * 1.02, bodyW * 1.02), MAT.copper, 0, y, 0));
    const termL = Math.min(0.5, bodyL * 0.24);
    for (const [px] of pts) {
      const t = chipTermination(termL, bodyH * 1.02, bodyW * 1.02);
      t.position.set(px > 0 ? bodyL / 2 - termL / 2 : -(bodyL / 2 - termL / 2), y, 0);
      g.add(t);
      const f = smdFillet(0.6, bodyW, bodyH);
      f.position.set(px > 0 ? bodyL / 2 - termL * 0.4 - 0.6 : -(bodyL / 2 - termL * 0.4), 0.02, 0);
      if (px < 0) f.rotation.y = Math.PI;
      g.add(f);
    }
    return g;
  }
  const g = new THREE.Group();
  const spanZ = Math.max(2, padSpanZ(ctx.footprint));
  // Real radial drum: ferrite drum (top/bottom flanges + core) with copper
  // wound BETWEEN the flanges — not floating rings around a plain cylinder.
  const coreR = Math.max(1.8, Math.min(spanZ * 0.85, 2.6));
  const windH = Math.max(2.6, coreR * 1.3);
  const flangeT = 0.7;
  const baseY = 0.8;
  const ferrite = new THREE.MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.55, metalness: 0.35 });
  // bottom + top flanges
  g.add(mesh(new THREE.CylinderGeometry(coreR * 1.15, coreR * 1.15, flangeT, 24), ferrite, 0, baseY + flangeT / 2, 0));
  g.add(mesh(new THREE.CylinderGeometry(coreR * 1.15, coreR * 1.15, flangeT, 24), ferrite, 0, baseY + flangeT + windH + flangeT / 2, 0));
  // core between flanges (mostly hidden by winding)
  g.add(mesh(new THREE.CylinderGeometry(coreR * 0.7, coreR * 0.7, windH, 20), ferrite, 0, baseY + flangeT + windH / 2, 0));
  // copper winding: tight helix between the flanges (tube along a helix curve)
  const turns = Math.max(8, Math.floor(windH / 0.45));
  const helixPts: THREE.Vector3[] = [];
  for (let i = 0; i <= turns * 12; i++) {
    const t = i / 12;
    const a = (t / turns) * Math.PI * 2 * turns;
    helixPts.push(new THREE.Vector3(
      Math.cos(a) * coreR * 0.92,
      baseY + flangeT + (t / turns) * windH,
      Math.sin(a) * coreR * 0.92,
    ));
  }
  const helix = new THREE.CatmullRomCurve3(helixPts);
  const winding = new THREE.Mesh(new THREE.TubeGeometry(helix, turns * 12, 0.2, 6, false), MAT.copper);
  winding.castShadow = true;
  g.add(winding);
  // value print on the top flange (e.g. "100µ")
  try {
    const l = (ctx.params.inductance as number) ?? 1e-4;
    const txt = l >= 1e-3 ? `${Math.round(l * 1e3)}mH` : `${Math.round(l * 1e6)}µH`;
    const label = labelPlane(txt, coreR * 1.4, 0.8, { fg: '#d4d4d8', fontPx: 34 });
    label.position.set(0, baseY + flangeT * 2 + windH + 0.05, 0);
    g.add(label);
  } catch { /* label optional */ }
  // kinked radial leads from the winding down through the pads
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x * 0.4, baseY + flangeT, z * 0.4),
      new THREE.Vector3(x, 0.7, z),
      new THREE.Vector3(x, -2.4, z),
    ], false, 'centripetal', 0.5);
    const lead = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.22, 8, false), MAT.lead);
    lead.castShadow = true;
    g.add(lead);
    // solder cone at the pad
    g.add(mesh(new THREE.CylinderGeometry(0.4, 0.65, 0.6, 10), MAT.solder, x, 0.3, z));
  }
  return g;
}

/** 9V PP3 battery: steel jacket, paper wrap with brand print, snap terminals, formed leads. */
function batteryModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(6, padSpanX(ctx.footprint));
  const s = Math.min(1, span / 13);
  const bodyW = 17 * s, bodyH = 26 * s, bodyD = 12 * s;
  // rolled-steel jacket with vertical seam
  const jacket = mesh(
    new RoundedBoxGeometry(bodyW, bodyH, bodyD, 3, 1.2 * s),
    new THREE.MeshPhysicalMaterial({ color: 0x3a3f47, roughness: 0.35, metalness: 0.85, clearcoat: 0.4, clearcoatRoughness: 0.3 }),
    0, bodyH / 2, 0,
  );
  g.add(jacket);
  g.add(mesh(new THREE.BoxGeometry(0.15, bodyH * 0.9, bodyD * 0.9),
    new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.5, metalness: 0.7 }), bodyW / 2 - 0.1, bodyH / 2, 0));
  // paper label wrap (upper 62%) with gold band + red stripe + print
  const label = mesh(
    new RoundedBoxGeometry(bodyW * 1.015, bodyH * 0.62, bodyD * 1.015, 2, 1.1 * s),
    new THREE.MeshPhysicalMaterial({ color: 0xc9a441, roughness: 0.6, metalness: 0.0, clearcoat: 0.12 }),
    0, bodyH * 0.68, 0,
  );
  g.add(label);
  g.add(mesh(new THREE.BoxGeometry(bodyW * 1.02, bodyH * 0.09, bodyD * 1.02),
    new THREE.MeshPhysicalMaterial({ color: 0x8c1f1f, roughness: 0.55 }), 0, bodyH * 0.52, 0));
  try {
    const brand = labelPlane('9V ALKALINE', bodyW * 0.7, bodyH * 0.07, { fg: '#2a1f00', fontPx: 36 });
    brand.rotation.z = Math.PI / 2;
    brand.position.set(bodyW * 0.52, bodyH * 0.72, 0);
    brand.rotation.y = Math.PI / 2;
    g.add(brand);
  } catch { /* label optional */ }
  // black plastic top cap
  g.add(mesh(new RoundedBoxGeometry(bodyW * 0.96, 1.6 * s, bodyD * 0.94, 2, 0.4 * s), MAT.darkPlastic, 0, bodyH + 0.6 * s, 0));
  // PP3 snap terminals: hex + stud (+) and round socket (−) with rims
  const plusBase = mesh(new THREE.CylinderGeometry(3.0 * s, 3.0 * s, 1.0 * s, 6), MAT.aluminum, 0, bodyH + 1.6 * s, -bodyD * 0.16);
  g.add(plusBase);
  g.add(mesh(new THREE.CylinderGeometry(1.5 * s, 1.5 * s, 1.2 * s, 14), MAT.brass, 0, bodyH + 2.4 * s, -bodyD * 0.16));
  const minusRim = mesh(new THREE.CylinderGeometry(2.2 * s, 2.2 * s, 1.0 * s, 18), MAT.aluminum, 0, bodyH + 1.6 * s, bodyD * 0.2);
  g.add(minusRim);
  g.add(mesh(new THREE.CylinderGeometry(1.8 * s, 1.8 * s, 0.6 * s, 16), MAT.rubber, 0, bodyH + 1.8 * s, bodyD * 0.2));
  // snap leads: red (+) and black (−) wires from terminals down to the pads
  const pts = padPoints(ctx.footprint, 2);
  if (pts.length >= 2) {
    const colors = [0xb91c1c, 0x17171a];
    for (let i = 0; i < 2; i++) {
      const [px] = pts[i];
      const wireMat = new THREE.MeshPhysicalMaterial({ color: colors[i], roughness: 0.6 });
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(i === 0 ? -bodyW * 0.2 : bodyW * 0.2, bodyH + 1.2 * s, 0),
        new THREE.Vector3(px * 0.6, bodyH * 0.5, 0),
        new THREE.Vector3(px, 1.2, 0),
        new THREE.Vector3(px, -2.2, 0),
      ], false, 'centripetal', 0.5);
      const wire = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.45 * s, 8, false), wireMat);
      wire.castShadow = true;
      g.add(wire);
    }
  }
  return g;
}

/** Panel-mount switch: body + actuator lever. */
function switchModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(4, padSpanZ(ctx.footprint));
  const w = Math.max(6, spanZ + 1);
  g.add(mesh(new RoundedBoxGeometry(4.5, 4, w, 2, 0.3), MAT.darkPlastic, 0, 2, 0));
  // metal bushing + lever
  g.add(mesh(new THREE.CylinderGeometry(1.5, 1.5, 1.2, 16), MAT.aluminum, 0, 4.6, 0));
  const lever = mesh(new THREE.BoxGeometry(0.9, 3.6, 0.9), MAT.lead, 0, 6.8, 0);
  lever.rotation.z = 0.5;
  g.add(lever);
  // 2 legs
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 2.4, 8), MAT.lead, 0, -0.9, s * spanZ / 2));
  }
  return g;
}

/** Push button: square body + round actuator. */
function pushButtonModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(4, padSpanZ(ctx.footprint));
  const w = Math.max(5.5, spanZ + 0.5);
  g.add(mesh(new RoundedBoxGeometry(w, 3.4, w, 2, 0.3), MAT.darkPlastic, 0, 1.7, 0));
  g.add(mesh(new THREE.CylinderGeometry(w * 0.28, w * 0.28, 2.0, 20),
    new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.35 }), 0, 4.2, 0));
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      g.add(mesh(new THREE.CylinderGeometry(0.25, 0.25, 2.2, 8), MAT.lead, t * w * 0.35, -0.8, s * spanZ / 2));
    }
  }
  return g;
}

/** Potentiometer: body + shaft + knob. */
function potentiometerModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(3.5, padSpanZ(ctx.footprint));
  const w = Math.max(6, spanZ + 1.5);
  g.add(mesh(new RoundedBoxGeometry(5, 5.5, w, 2, 0.3), MAT.darkPlastic, 0, 2.75, 0));
  g.add(mesh(new THREE.CylinderGeometry(1.5, 1.5, 6, 16), MAT.aluminum, 0, 8.2, 0));
  g.add(mesh(new THREE.CylinderGeometry(2.6, 2.6, 2.6, 20), MAT.blackPlastic, 0, 11.4, 0));
  // pointer groove on the knob
  g.add(mesh(new THREE.BoxGeometry(0.5, 0.3, 2.4), MAT.lead, 0, 12.8, 0));
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 2.4, 8), MAT.lead, 0, -0.9, s * spanZ / 2));
  }
  return g;
}

/** Cylindrical fuse: glass body + metal end caps + internal wire. */
function fuseModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(6, padSpanX(ctx.footprint));
  const bodyLen = Math.min(span * 0.6, 8);
  const r = 1.4;
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xc8dcE8, roughness: 0.05, transparent: true, opacity: 0.4, transmission: 0.6,
  });
  const body = mesh(new THREE.CylinderGeometry(r, r, bodyLen, 18), glass, 0, r, 0);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  for (const s of [-1, 1]) {
    const cap = mesh(new THREE.CylinderGeometry(r * 1.08, r * 1.08, bodyLen * 0.18, 18), MAT.aluminum, s * bodyLen * 0.44, r, 0);
    cap.rotation.z = Math.PI / 2;
    g.add(cap);
  }
  // internal wire
  const wire = mesh(new THREE.CylinderGeometry(0.09, 0.09, bodyLen * 0.8, 6), MAT.copper, 0, r, 0);
  wire.rotation.z = Math.PI / 2;
  g.add(wire);
  // formed leads from the fuse end caps down to the pads (body axis at r)
  g.add(bentLead(span / 2, bodyLen / 2, 0.22, r));
  g.add(bentLead(-span / 2, bodyLen / 2, 0.22, r));
  return g;
}

/** Photoresistor (LDR): orange disc with squiggle face + 2 leads. */
function photoresistorModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(2, padSpanZ(ctx.footprint));
  const r = 2.5;
  g.add(mesh(new THREE.CylinderGeometry(r, r, 1.8, 24), MAT.ceramic, 0, 2.6, 0));
  // zig-zag face (3 dark strips)
  const faceMat = new THREE.MeshStandardMaterial({ color: 0x6b3a1f, roughness: 0.65 });
  for (const off of [-0.9, 0, 0.9]) {
    g.add(mesh(new THREE.BoxGeometry(1.6, 0.12, 0.5), faceMat, off * 0.8, 3.55, 0));
  }
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.25, 0.25, 2.4, 8), MAT.lead, 0, -0.9, s * spanZ / 2));
  }
  return g;
}

/**
 * Arduino Uno R3 MODULE: full-size teal-blue board (68.6×53.4mm) with
 * cream silkscreen edge, USB-B + barrel jack, pin headers at the REAL pad
 * positions, ATmega328 DIP with notch, crystal, reset button, electrolytics,
 * and power LED. Scaled DOWN only when the footprint is smaller than a real
 * Uno (prototyping layouts) — full-size when the pads allow it.
 */
function arduinoModule(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(6, padSpanX(ctx.footprint));
  const spanZ = Math.max(10, padSpanZ(ctx.footprint));
  // Real Uno: 68.6 × 53.4mm. Fit the footprint but prefer full size.
  const fullW = 68.6, fullD = 53.4;
  const s = Math.min(1, Math.max(spanX + 6, 20) / fullW, Math.max(spanZ + 4, 16) / fullD);
  const bw = fullW * s, bl = fullD * s;
  const unoBlue = new THREE.MeshPhysicalMaterial({
    color: 0x008184, roughness: 0.5, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.35,
  });
  const pcb = mesh(new RoundedBoxGeometry(bw, 1.6 * s, bl, 2, 0.4 * s), unoBlue, 0, 2.4 * s, 0);
  g.add(pcb);
  // cream silkscreen border (thin inset frame on top)
  g.add(mesh(new THREE.BoxGeometry(bw * 0.96, 0.06, bl * 0.94),
    new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.6 }), 0, 3.22 * s, 0));
  g.add(mesh(new THREE.BoxGeometry(bw * 0.93, 0.07, bl * 0.91), unoBlue, 0, 3.23 * s, 0));
  // "ARDUINO UNO" silkscreen text
  try {
    const logo = labelPlane('ARDUINO UNO', bw * 0.4, 2.2 * s, { fg: '#e8e4d8', fontPx: 40 });
    logo.position.set(0, 3.3 * s, bl * 0.18);
    g.add(logo);
  } catch { /* label optional */ }
  // pin headers — black plastic strips + gold square pins at REAL pads
  const pts = padPoints(ctx.footprint, 30);
  const headerMat = new THREE.MeshPhysicalMaterial({ color: 0x14161a, roughness: 0.6, metalness: 0.05 });
  // header plastic strips along both long edges
  for (const hx of [-bw * 0.42, bw * 0.42]) {
    g.add(mesh(new THREE.BoxGeometry(1.2 * s, 1.4 * s, bl * 0.8), headerMat, hx, 3.8 * s, 0));
  }
  for (const [x, z] of pts) {
    g.add(mesh(new THREE.BoxGeometry(0.5 * s, 3.2 * s, 0.5 * s), MAT.brass, x, 2.2 * s, z));
  }
  // USB-B jack (silver, with dark mouth)
  g.add(mesh(new RoundedBoxGeometry(7.5 * s, 5 * s, 8 * s, 2, 0.4 * s),
    new THREE.MeshPhysicalMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.9, clearcoat: 0.4 }),
    -bw * 0.32, 5.2 * s, bl / 2 - 4.5 * s));
  g.add(mesh(new THREE.BoxGeometry(5.5 * s, 2.5 * s, 0.6), MAT.darkPlastic, -bw * 0.32, 4.6 * s, bl / 2 - 0.8 * s));
  // barrel jack (black, with center hole)
  g.add(mesh(new RoundedBoxGeometry(6 * s, 5.5 * s, 9 * s, 2, 0.4 * s),
    new THREE.MeshPhysicalMaterial({ color: 0x1a1a1e, roughness: 0.5, metalness: 0.3 }),
    bw * 0.3, 5.4 * s, -bl / 2 + 5 * s));
  g.add(mesh(new THREE.CylinderGeometry(1.4 * s, 1.4 * s, 0.6, 14), MAT.rubber, bw * 0.3, 5.4 * s, -bl / 2 + 9.2 * s));
  // ATmega328 DIP-28 with notch + dot + label
  const chipL = 22 * s, chipW = 7.5 * s;
  g.add(mesh(new RoundedBoxGeometry(chipW, 2.8 * s, chipL, 2, 0.25 * s), MAT.dipBody, 0, 4.6 * s, -bl * 0.05));
  g.add(mesh(new THREE.CylinderGeometry(0.9 * s, 0.9 * s, 0.4 * s, 12),
    new THREE.MeshStandardMaterial({ color: 0x2e2e34, roughness: 0.6 }), 0, 6.1 * s, -bl * 0.05 - chipL / 2 + 2 * s));
  try {
    const chipLabel = labelPlane('ATMEGA328P', chipW * 0.7, 1.4 * s, { fg: '#c8c8cc', fontPx: 32 });
    chipLabel.position.set(0, 6.1 * s, -bl * 0.05);
    g.add(chipLabel);
  } catch { /* label optional */ }
  // DIP legs: two rows of stamped pins with solder cones
  for (const rowX of [-chipW / 2 - 0.6 * s, chipW / 2 + 0.6 * s]) {
    for (let i = 0; i < 14; i++) {
      const pz = -bl * 0.05 - chipL / 2 + 2 * s + i * ((chipL - 4 * s) / 13);
      g.add(mesh(new THREE.BoxGeometry(0.4 * s, 2.4 * s, 0.3 * s), MAT.lead, rowX, 3.4 * s, pz));
    }
  }
  // HC-49 crystal (silver oval can)
  const xtal = mesh(new THREE.CylinderGeometry(1.6 * s, 1.6 * s, 4.5 * s, 16), MAT.aluminum, -bw * 0.28, 4.4 * s, bl * 0.12);
  xtal.scale.x = 0.6;
  xtal.rotation.z = Math.PI / 2;
  g.add(xtal);
  // reset button (small tactile, blue plunger)
  g.add(mesh(new THREE.BoxGeometry(2.5 * s, 1.2 * s, 2.5 * s), MAT.darkPlastic, bw * 0.35, 3.8 * s, bl * 0.28));
  g.add(mesh(new THREE.CylinderGeometry(0.8 * s, 0.8 * s, 0.8 * s, 10),
    new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.4 }), bw * 0.35, 4.6 * s, bl * 0.28));
  // electrolytic caps (2x, navy sleeve + silver top)
  for (const [cx, cz] of [[-bw * 0.35, -bl * 0.3], [bw * 0.15, -bl * 0.32]] as const) {
    g.add(mesh(new THREE.CylinderGeometry(1.8 * s, 1.8 * s, 4 * s, 16), MAT.elecCan, cx, 5 * s, cz));
    g.add(mesh(new THREE.CylinderGeometry(1.75 * s, 1.75 * s, 0.3 * s, 16), MAT.aluminum, cx, 7 * s, cz));
  }
  // green power LED + amber L LED (tiny 0805 with lens)
  for (const [cx, cz, col] of [[bw * 0.4, bl * 0.05, 0x30d158], [bw * 0.4, bl * 0.12, 0xffd60a]] as const) {
    g.add(mesh(new THREE.BoxGeometry(1.2 * s, 0.5 * s, 0.8 * s), MAT.ledReflector, cx, 3.5 * s, cz));
    g.add(mesh(new THREE.BoxGeometry(0.8 * s, 0.3 * s, 0.5 * s),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.6 }), cx, 3.8 * s, cz));
  }
  // voltage regulator (SOT-223, black + tab)
  g.add(mesh(new THREE.BoxGeometry(3 * s, 1.2 * s, 4 * s), MAT.dipBody, bw * 0.2, 3.8 * s, -bl * 0.3));
  return g;
}

/** 7-segment display: red epoxy package, slanted segments, formed DIP legs. */
function sevenSegmentModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(8, padSpanX(ctx.footprint));
  // Real 0.56" single digit: 19×12.6mm body, 2.54mm pitch DIP-10
  const w = Math.min(spanX * 0.8, 19);
  const h = Math.min(w * 0.62, 12.6);
  const bodyH = 4.5;
  // deep-red epoxy package (real displays are red-tinted, not black)
  const pkgMat = new THREE.MeshPhysicalMaterial({ color: 0x5c0a0e, roughness: 0.4, metalness: 0.0, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  g.add(mesh(new RoundedBoxGeometry(w, bodyH, h, 2, 0.3), pkgMat, 0, bodyH / 2, 0));
  // light-gray face plate around the digit window (real Kingbright look)
  const faceY = bodyH + 0.02;
  g.add(mesh(new THREE.BoxGeometry(w * 0.62, 0.15, h * 0.72),
    new THREE.MeshPhysicalMaterial({ color: 0xd8d4cc, roughness: 0.55 }), 0, faceY - 0.02, 0));
  // dark-red diffuser window the segments glow through
  const faceMat = new THREE.MeshPhysicalMaterial({
    color: 0x3d0508, roughness: 0.3, metalness: 0.0, clearcoat: 0.7, clearcoatRoughness: 0.2,
  });
  g.add(mesh(new THREE.BoxGeometry(w * 0.56, 0.14, h * 0.66), faceMat, 0, faceY + 0.02, 0));
  // SLANTED segments (real 7-seg digits lean ~5°): a–g + dp, each an
  // independent emissive bar recessed into the window
  const segs: [number, number, boolean][] = [
    [0, h * 0.24, false],          // a — top
    [-w * 0.17, h * 0.12, true],   // b — upper right
    [-w * 0.17, -h * 0.12, true],  // c — lower right
    [0, -h * 0.24, false],         // d — bottom
    [w * 0.17, -h * 0.12, true],   // e — lower left
    [w * 0.17, h * 0.12, true],    // f — upper left
    [0, 0, false],                 // g — middle
  ];
  const segMeshes: THREE.Mesh[] = [];
  const sw = w * 0.055, sl = w * 0.17;
  for (const [sx, sz, vertical] of segs) {
    const segMatClone = new THREE.MeshStandardMaterial({
      color: 0x4a0d10, emissive: 0xff2020, emissiveIntensity: 0, roughness: 0.3,
    });
    const seg = mesh(
      new THREE.BoxGeometry(vertical ? sw : sl, 0.16, vertical ? sl : sw),
      segMatClone, sx, faceY + 0.06, sz,
    );
    seg.rotation.y = 0.09; // digit slant
    g.add(seg);
    segMeshes.push(seg);
  }
  // decimal point (bottom-right, same glow treatment)
  const dpMat = new THREE.MeshStandardMaterial({
    color: 0x4a0d10, emissive: 0xff2020, emissiveIntensity: 0, roughness: 0.3,
  });
  const dp = mesh(new THREE.CylinderGeometry(sw * 0.55, sw * 0.55, 0.16, 12), dpMat, w * 0.24, faceY + 0.06, -h * 0.28);
  g.add(dp);
  (g as unknown as { __updateSegments: (onMask: number) => void }).__updateSegments = (onMask: number) => {
    for (let i = 0; i < 7; i++) {
      const on = ((onMask >> i) & 1) === 1;
      (segMeshes[i].material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 2.4 : 0;
    }
  };
  (g as unknown as { __updateSegments: (onMask: number) => void }).__updateSegments(0);
  // formed DIP legs with solder cones at the REAL pad positions
  const padPts = padPoints(ctx.footprint, 12);
  if (padPts.length >= 2) {
    for (const [px, pz] of padPts) {
      g.add(formedPin(px, pz, px, 1.4, pz * 0.8, 0.45, 0.22));
    }
  } else {
    const pinCount = Math.max(4, Math.min(10, ctx.footprint.pads.length));
    for (let i = 0; i < pinCount; i++) {
      const px = -w / 2 + (w / pinCount) * (i + 0.5);
      for (const rowZ of [-1, 1]) {
        g.add(formedPin(px, rowZ * (h / 2 - 0.5), px, 1.4, rowZ * (h / 2 - 0.5) * 0.8, 0.45, 0.22));
      }
    }
  }
  return g;
}

/** Speaker: stamped basket + paper cone + surround + dust cap + magnet + terminals. */
function speakerModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const r = Math.max(8, Math.min(padSpanX(ctx.footprint) * 0.5, 20));
  // stamped steel basket: outer ring + 4 arms + bottom hub
  const basketMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.7 });
  g.add(mesh(new THREE.TorusGeometry(r * 0.96, r * 0.07, 10, 40), basketMat, 0, r * 0.28, 0));
  const basketRing = g.children[g.children.length - 1] as THREE.Mesh;
  basketRing.rotation.x = Math.PI / 2;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const arm = mesh(new THREE.BoxGeometry(r * 0.85, r * 0.06, r * 0.12), basketMat, Math.cos(a) * r * 0.5, r * 0.16, Math.sin(a) * r * 0.5);
    arm.rotation.y = -a;
    g.add(arm);
  }
  // magnet + back plate under the hub
  g.add(mesh(new THREE.CylinderGeometry(r * 0.32, r * 0.32, r * 0.22, 24),
    new THREE.MeshStandardMaterial({ color: 0x71717a, roughness: 0.4, metalness: 0.8 }), 0, r * 0.1, 0));
  g.add(mesh(new THREE.CylinderGeometry(r * 0.36, r * 0.36, r * 0.05, 24), MAT.steel, 0, r * 0.02, 0));
  // paper cone (ribbed look via two stacked cones)
  const coneMat = new THREE.MeshStandardMaterial({ color: 0x1c1917, roughness: 0.9 });
  g.add(mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.88, r * 0.32, 32, 1, true), coneMat, 0, r * 0.32, 0));
  // rubber surround (torus at the rim)
  const surround = mesh(new THREE.TorusGeometry(r * 0.88, r * 0.06, 10, 40), MAT.rubber, 0, r * 0.48, 0);
  surround.rotation.x = Math.PI / 2;
  g.add(surround);
  // dust cap (aluminum dome)
  g.add(mesh(new THREE.SphereGeometry(r * 0.28, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), MAT.aluminum, 0, r * 0.42, 0));
  // solder terminals + braided leads to the voice coil
  const pts = padPoints(ctx.footprint, 2);
  for (let i = 0; i < Math.max(2, pts.length); i++) {
    const [tx, tz] = pts[i] ?? [(i === 0 ? -1 : 1) * r * 0.6, r * 0.9];
    g.add(mesh(new THREE.BoxGeometry(0.8, 0.5, 1.2), MAT.brass, tx, 0.3, tz));
    const braid = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(tx, 0.5, tz),
      new THREE.Vector3(tx * 0.5, r * 0.3, tz * 0.5),
      new THREE.Vector3(0, r * 0.4, 0),
    ]), 12, 0.09, 6, false), MAT.copper);
    braid.castShadow = true;
    g.add(braid);
  }
  return g;
}

/** Transformer: E-core stack + bobbin. */
function transformerModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(10, padSpanX(ctx.footprint));
  const w = Math.min(14, spanX * 0.8);
  // laminated core (stack of dark plates)
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x555a63, roughness: 0.45, metalness: 0.7 });
  g.add(mesh(new THREE.BoxGeometry(w, 6.5, w * 0.5), coreMat, 0, 3.25, -w * 0.28));
  g.add(mesh(new THREE.BoxGeometry(w, 6.5, w * 0.5), coreMat, 0, 3.25, w * 0.28));
  // winding bobbin (copper rings between the cores)
  for (let i = 0; i < 8; i++) {
    const ring = mesh(new THREE.TorusGeometry(w * 0.2, 0.28, 8, 24), MAT.copper, 0, 1.2 + i * 0.62, 0);
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
  }
  // pins
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.2, 8), MAT.lead, s * w * 0.4, -0.8, (i - 0.5) * w * 0.3));
    }
  }
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extended realistic families — cover the remaining ~140 catalog types so
// NOTHING falls back to a plain gray box. Each family is pad-span adaptive
// and lands its legs on the footprint's real pads.
// ─────────────────────────────────────────────────────────────────────────────

/** Generic DIP IC with pin count from pads — covers all 74xx/CD40xx/logic. */
function genericDipIC(ctx: ModelBuildContext): THREE.Group {
  return dipIC(ctx);
}

/** Generic SOIC/SMD IC — small logic, op-amps, comparators, regulators. */
function genericSoicIC(ctx: ModelBuildContext): THREE.Group {
  return soicIC(ctx);
}

/** TO-220 power device: regulators (lm7805/lm317/lm1117/lt3045), IGBT, SCR/TRIAC. */
function powerTabDevice(ctx: ModelBuildContext): THREE.Group {
  return to220(ctx);
}

/** SOT-223 / SOT-89 small regulator (lm1117 SMD, tl431, lm336...). */
function sot223(_ctx: ModelBuildContext): THREE.Group {
  const ctx = _ctx;
  const g = new THREE.Group();
  const pts = padPoints(ctx.footprint, 4);
  const bodyW = 3.5, bodyL = 6.5, bodyH = 1.6;
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.15), MAT.dipBody, 0, bodyH / 2 + 0.1, 0));
  // large tab on one side
  g.add(mesh(new THREE.BoxGeometry(1.6, 0.3, bodyW), MAT.tab, bodyL / 2 + 0.6, 0.2, 0));
  try {
    const label = labelPlane(ctx.footprint.refdes || 'VR', 3, 0.9, { fg: '#c8c8cc', fontPx: 36 });
    label.position.set(0, bodyH + 0.15, 0);
    g.add(label);
  } catch { /* label optional */ }
  const defs = pts.length >= 3 ? pts : [[-1.2, -1.1], [-1.2, 1.1], [1.2, 0]] as [number, number][];
  for (const [px, pz] of defs) {
    g.add(mesh(new THREE.BoxGeometry(0.6, 0.12, 0.8), MAT.lead, px, 0.06, pz));
  }
  return g;
}

/** Axial diode family: zener/schottky/shockley/diac/crd/photodiode — black
 *  epoxy DO-41 with cathode band (power diodes are NOT glass). */
function axialPowerDiode(ctx: ModelBuildContext): THREE.Group {
  if (isSMD(ctx.footprint)) return sodDiode(ctx);
  const g = new THREE.Group();
  const span = Math.max(6, Math.min(padSpanX(ctx.footprint), 14));
  const bodyLen = Math.min(span * 0.55, 5.2);
  const r = 1.0;
  const body = mesh(new THREE.CylinderGeometry(r, r, bodyLen, 18), MAT.diodeBody, 0, r + 0.2, 0);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  const stripe = mesh(new THREE.CylinderGeometry(r * 1.03, r * 1.03, bodyLen * 0.09, 18),
    new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 }), bodyLen * 0.34, r + 0.2, 0);
  stripe.rotation.z = Math.PI / 2;
  g.add(stripe);
  g.add(bentLead(span / 2, bodyLen / 2, 0.22, r + 0.2));
  g.add(bentLead(-span / 2, bodyLen / 2, 0.22, r + 0.2));
  return g;
}

/** Thermistor/PTC/MOV disc: blue/teal coated disc with kinked radial leads. */
function discSensor(ctx: ModelBuildContext, color = 0x1d4ed8): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(2.5, padSpanX(ctx.footprint));
  const r = Math.min(span * 0.42, 3.2);
  const coat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, metalness: 0.0, clearcoat: 0.4, clearcoatRoughness: 0.3 });
  const disc = mesh(new THREE.CylinderGeometry(r, r, 1.2, 24), coat, 0, 2.2, 0);
  disc.rotation.x = Math.PI / 2;
  g.add(disc);
  // epoxy meniscus ring around leads
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    g.add(radialLead(x, z, 0.22));
  }
  return g;
}

/** Film box capacitor: yellow molded box + stenciled value + radial leads. */
function filmBoxCap(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(4, padSpanX(ctx.footprint));
  const w = Math.min(span * 0.6, 8), h = Math.min(w * 0.8, 6), d = Math.min(w * 0.5, 3.5);
  g.add(mesh(new RoundedBoxGeometry(w, h, d, 2, 0.3), MAT.yellowPlastic, 0, h / 2, 0));
  try {
    const cap = (ctx.params.capacitance as number) ?? 1e-7;
    const txt = cap >= 1e-6 ? `${Math.round(cap * 1e6)}µ` : `${Math.round(cap * 1e9)}n`;
    const label = labelPlane(txt, w * 0.6, h * 0.25, { fg: '#3a2a00', fontPx: 36 });
    label.rotation.z = Math.PI / 2;
    label.position.set(w * 0.51, h * 0.55, 0);
    label.rotation.y = Math.PI / 2;
    g.add(label);
  } catch { /* label optional */ }
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    g.add(radialLead(x, z, 0.25));
  }
  return g;
}

/** Tantalum SMD (also used for film box): yellow-orange molded body. */
function tantalumCap(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(1.6, padSpanX(ctx.footprint));
  const bodyL = Math.min(3.2, Math.max(1.4, span * 0.55));
  const bodyW = bodyL * 0.55, bodyH = bodyW * 0.6;
  const y = bodyH / 2 + 0.05;
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.08), MAT.tantalum, 0, y, 0));
  // polarity bar (+ side)
  g.add(mesh(new THREE.BoxGeometry(bodyL * 0.1, bodyH * 0.25, bodyW * 0.9),
    new THREE.MeshStandardMaterial({ color: 0x7c2d12, roughness: 0.5 }), bodyL * 0.36, y + bodyH * 0.3, 0));
  const termL = Math.min(0.55, bodyL * 0.24);
  for (const [px] of padPoints(ctx.footprint, 2)) {
    const t = chipTermination(termL, bodyH * 1.02, bodyW * 1.02);
    t.position.set(px > 0 ? bodyL / 2 - termL / 2 : -(bodyL / 2 - termL / 2), y, 0);
    g.add(t);
  }
  return g;
}

/** Trimmer potentiometer (blue 3296 box + brass screw). */
function trimmerPot(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new RoundedBoxGeometry(4.5, 3.5, 4.5, 2, 0.25), MAT.bluePlastic, 0, 1.75, 0));
  g.add(mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.8, 16), MAT.brass, 0, 3.9, 0));
  // screwdriver slot
  g.add(mesh(new THREE.BoxGeometry(1.6, 0.2, 0.3), MAT.darkPlastic, 0, 4.3, 0));
  for (const [x, z] of padPoints(ctx.footprint, 3)) {
    g.add(radialLead(x, z, 0.22));
  }
  return g;
}

/** Relay cube: blue translucent-ish cube + white top + pins. */
function relayCube(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(8, padSpanX(ctx.footprint));
  const w = Math.min(spanX * 0.7, 15), d = w * 0.7, h = w * 0.65;
  g.add(mesh(new RoundedBoxGeometry(w, h, d, 2, 0.4), MAT.bluePlastic, 0, h / 2, 0));
  g.add(mesh(new THREE.BoxGeometry(w * 0.9, 0.3, d * 0.9), MAT.whitePlastic, 0, h + 0.1, 0));
  try {
    const label = labelPlane('5V 10A', w * 0.6, 1.2, { fg: '#1e3a8a', fontPx: 36 });
    label.position.set(0, h + 0.28, 0);
    g.add(label);
  } catch { /* label optional */ }
  for (const [x, z] of padPoints(ctx.footprint, 8)) {
    g.add(radialLead(x, z, 0.25));
  }
  return g;
}

/** Optocoupler: white 4-pin DIP with black top window. */
function optocouplerModel(ctx: ModelBuildContext): THREE.Group {
  const g = dipIC(ctx);
  // white body overlay cue: thin white top plate
  const spanZ = Math.max(6, padSpanZ(ctx.footprint));
  g.add(mesh(new THREE.BoxGeometry(4, 0.3, Math.min(spanZ * 0.7, 5)), MAT.whitePlastic, 0, 3.9, 0));
  return g;
}

/** Buzzer: black cylinder with sound hole + pins. */
function buzzerModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const r = 4.5, h = 3.5;
  g.add(mesh(new THREE.CylinderGeometry(r, r, h, 28), MAT.darkPlastic, 0, h / 2, 0));
  // sound port
  g.add(mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.3, 16), MAT.rubber, 0, h + 0.05, 0));
  try {
    const label = labelPlane('5V', 3, 1, { fg: '#c8c8cc', fontPx: 36 });
    label.position.set(0, h + 0.08, -r * 0.5);
    g.add(label);
  } catch { /* label optional */ }
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    g.add(radialLead(x, z, 0.25));
  }
  return g;
}

/** DC motor: silver can + end cap + shaft + terminals. */
function dcMotorModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const r = 3, len = 10;
  const can = mesh(new THREE.CylinderGeometry(r, r, len, 24), MAT.aluminum, 0, r, 0);
  can.rotation.z = Math.PI / 2;
  g.add(can);
  // rear cap
  const cap = mesh(new THREE.CylinderGeometry(r * 0.95, r * 0.95, 1, 20), MAT.darkPlastic, -len / 2, r, 0);
  cap.rotation.z = Math.PI / 2;
  g.add(cap);
  // shaft
  const shaft = mesh(new THREE.CylinderGeometry(0.5, 0.5, 3, 12), MAT.steel, len / 2 + 1.2, r, 0);
  shaft.rotation.z = Math.PI / 2;
  g.add(shaft);
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    g.add(radialLead(x, z, 0.25));
  }
  return g;
}

/** Servo: blue box + mounting ears + white spline + cable. */
function servoModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const w = 12, d = 23, h = 12;
  g.add(mesh(new RoundedBoxGeometry(w, h, d, 2, 0.5), MAT.bluePlastic, 0, h / 2, 0));
  // mounting flange
  g.add(mesh(new THREE.BoxGeometry(w + 8, 1.5, d * 0.5), MAT.bluePlastic, 0, h - 1, 0));
  // output spline
  g.add(mesh(new THREE.CylinderGeometry(2.2, 2.2, 2.5, 16), MAT.whitePlastic, 0, h + 1, 2));
  for (const [x, z] of padPoints(ctx.footprint, 3)) {
    g.add(radialLead(x, z, 0.25));
  }
  return g;
}

/** LCD 1602: green PCB + glass + backlight + header pins. */
function lcdModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const w = 36, d = 14;
  g.add(mesh(new RoundedBoxGeometry(w, 1.6, d, 2, 0.3), MAT.greenPcb, 0, 2.2, 0));
  // glass
  g.add(mesh(new THREE.BoxGeometry(w * 0.85, 0.8, d * 0.6), MAT.lcdGlass, 0, 3.4, 0));
  // backlight diffuser under glass
  g.add(mesh(new THREE.BoxGeometry(w * 0.8, 0.3, d * 0.55), MAT.lcdBack, 0, 3.0, 0));
  // contrast pot + header
  g.add(mesh(new THREE.CylinderGeometry(1.5, 1.5, 1.5, 12), MAT.bluePlastic, -w * 0.4, 3.8, 0));
  for (const [x, z] of padPoints(ctx.footprint, 16)) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 3, 0.5), MAT.brass, x, 1.2, z));
  }
  return g;
}

/** OLED SSD1306: tiny blue PCB + glass + 4 pins. */
function oledModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new RoundedBoxGeometry(12, 1.2, 8, 2, 0.2), MAT.darkPlastic, 0, 1.8, 0));
  g.add(mesh(new THREE.BoxGeometry(10, 0.6, 5), MAT.lcdGlass, 0, 2.7, 0));
  for (const [x, z] of padPoints(ctx.footprint, 4)) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 2.5, 0.5), MAT.brass, x, 0.8, z));
  }
  return g;
}

/** RGB LED / WS2812B: diffused white 5050 body + 4 pads + glow. */
function rgbLedModel(ctx: ModelBuildContext): THREE.Group {
  const g = smdLed(ctx);
  // WS2812B has 4 pads — add two extra terminations on the sides
  const pts = padPoints(ctx.footprint, 4);
  if (pts.length >= 4) {
    for (let i = 2; i < 4; i++) {
      const [px, pz] = pts[i];
      g.add(mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), MAT.lead, px, 0.05, pz));
    }
  }
  return g;
}

/** ESP32 devkit: red/black PCB + USB + buttons + headers. */
function esp32Model(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const bw = 18, bl = 40;
  g.add(mesh(new RoundedBoxGeometry(bw, 1.6, bl, 2, 0.3), MAT.redPcb, 0, 2.2, 0));
  // USB-C jack
  g.add(mesh(new RoundedBoxGeometry(4, 1.6, 3.5, 2, 0.3), MAT.aluminum, 0, 3.6, bl / 2 - 2));
  // ESP32 shield can
  g.add(mesh(new RoundedBoxGeometry(10, 1.8, 12, 2, 0.2), MAT.aluminum, 0, 3.9, -bl / 2 + 8));
  // boot/en buttons
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(2, 1, 2), MAT.darkPlastic, s * 6, 3.5, bl / 2 - 8));
  }
  for (const [x, z] of padPoints(ctx.footprint, 30)) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 2.5, 0.5), MAT.brass, x, 0.8, z));
  }
  return g;
}

/** Raspberry Pi: green credit-card PCB + SoC + USB/Ethernet + GPIO. */
function raspberryPiModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const bw = 30, bl = 45;
  g.add(mesh(new RoundedBoxGeometry(bw, 1.4, bl, 2, 0.3), MAT.greenPcb, 0, 2.0, 0));
  // SoC + RAM
  g.add(mesh(new RoundedBoxGeometry(8, 1.2, 8, 2, 0.15), MAT.dipBody, -4, 3.2, -6));
  g.add(mesh(new RoundedBoxGeometry(6, 1.0, 8, 2, 0.15), MAT.dipBody, 5, 3.1, -6));
  // USB + Ethernet jacks
  g.add(mesh(new RoundedBoxGeometry(8, 4, 7, 2, 0.3), MAT.aluminum, 8, 4.5, 8));
  g.add(mesh(new RoundedBoxGeometry(7, 4, 8, 2, 0.3), MAT.aluminum, 8, 4.5, -2));
  // GPIO header
  for (const [x, z] of padPoints(ctx.footprint, 40)) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 3, 0.5), MAT.brass, x, 1.5, z));
  }
  return g;
}

/** Sensor breakout: small blue/red PCB + sensor element + header. */
function sensorBreakout(ctx: ModelBuildContext, accentColor?: number): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(6, padSpanX(ctx.footprint));
  const bw = Math.min(spanX + 4, 16), bl = Math.min(bw * 1.2, 20);
  const pcbMat = accentColor !== undefined
    ? new THREE.MeshPhysicalMaterial({ color: accentColor, roughness: 0.55, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.4 })
    : MAT.redPcb;
  g.add(mesh(new RoundedBoxGeometry(bw, 1.2, bl, 2, 0.2), pcbMat, 0, 1.8, 0));
  // sensor element: silver can or black chip in the middle
  g.add(mesh(new RoundedBoxGeometry(bw * 0.4, 1.5, bl * 0.3, 2, 0.15), MAT.aluminum, 0, 3.0, 0));
  for (const [x, z] of padPoints(ctx.footprint, 8)) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 2.2, 0.5), MAT.brass, x, 0.7, z));
  }
  return g;
}

/** PIR / ultrasonic HC-SR04: PCB + two transducer cans + crystal. */
function hcsr04Model(ctx: ModelBuildContext): THREE.Group {
  const g = sensorBreakout(ctx, 0x00457c);
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(3.5, 3.5, 3, 20), MAT.aluminum, s * 7, 4.5, 0));
    // transducer mesh face
    g.add(mesh(new THREE.CylinderGeometry(3.0, 3.0, 0.3, 20), MAT.steel, s * 7, 6.1, 0));
  }
  return g;
}

/** Electret mic: small silver cylinder with hole + leads. */
function electretMicModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const r = 2.2, h = 2;
  g.add(mesh(new THREE.CylinderGeometry(r, r, h, 20), MAT.aluminum, 0, h / 2 + 0.5, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 10), MAT.rubber, 0, h + 0.6, 0));
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    g.add(radialLead(x, z, 0.2));
  }
  return g;
}

/** Solar cell: blue-black panel with busbar grid + frame. */
function solarCellModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(10, padSpanX(ctx.footprint));
  const w = Math.min(spanX * 0.85, 30), d = w * 0.6;
  g.add(mesh(new RoundedBoxGeometry(w, 0.8, d, 2, 0.15), MAT.darkPlastic, 0, 0.4, 0));
  g.add(mesh(new THREE.BoxGeometry(w * 0.94, 0.3, d * 0.9), MAT.solar, 0, 0.9, 0));
  // busbars
  for (let i = -1; i <= 1; i++) {
    g.add(mesh(new THREE.BoxGeometry(w * 0.94, 0.34, 0.15), MAT.aluminum, 0, 0.9, (i * d) / 4));
  }
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    g.add(mesh(new THREE.BoxGeometry(0.6, 0.15, 0.8), MAT.lead, x, 0.1, z));
  }
  return g;
}

/** Connector / screw terminal: green/blue block + metal cage + screws. */
function connectorModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const n = Math.max(2, Math.min(ctx.footprint.pads.length, 8));
  const w = n * 3.5;
  const blockMat = new THREE.MeshPhysicalMaterial({ color: 0x0f766e, roughness: 0.5, metalness: 0.0, clearcoat: 0.3, clearcoatRoughness: 0.35 });
  g.add(mesh(new RoundedBoxGeometry(w, 6, 6, 2, 0.3), blockMat, 0, 3, 0));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (i + 0.5) * 3.5;
    // wire entry + screw
    g.add(mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.5, 12), MAT.darkPlastic, x, 6.1, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.6, 6), MAT.steel, x, 4.5, 2.2));
  }
  for (const [x, z] of padPoints(ctx.footprint, 8)) {
    g.add(radialLead(x, z, 0.3));
  }
  return g;
}

/** Test point: small gold loop / turret. */
function testPointModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pts = padPoints(ctx.footprint, 1);
  const [x, z] = pts[0] ?? [0, 0];
  g.add(mesh(new THREE.CylinderGeometry(0.6, 0.8, 1.2, 12), MAT.brass, x, 0.6, z));
  const loop = mesh(new THREE.TorusGeometry(0.7, 0.25, 8, 16), MAT.brass, x, 1.8, z);
  g.add(loop);
  return g;
}

/** Crystal oscillator can (4-pin metal SMD): rounded can + dot + pads. */
function crystalOscModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(4, padSpanX(ctx.footprint));
  const w = Math.min(spanX * 0.7, 7), d = w * 0.7, h = 1.8;
  g.add(mesh(new RoundedBoxGeometry(w, h, d, 2, 0.2), MAT.aluminum, 0, h / 2 + 0.1, 0));
  // pin-1 dot
  g.add(mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 10),
    new THREE.MeshStandardMaterial({ color: 0x333336, roughness: 0.5 }), -w / 2 + 0.8, h + 0.12, -d / 2 + 0.8));
  try {
    const label = labelPlane('16M', w * 0.4, 0.8, { fg: '#3a3a3e', fontPx: 36 });
    label.position.set(0, h + 0.12, 0);
    g.add(label);
  } catch { /* label optional */ }
  for (const [x, z] of padPoints(ctx.footprint, 4)) {
    g.add(mesh(new THREE.BoxGeometry(0.7, 0.12, 0.9), MAT.lead, x, 0.06, z));
  }
  return g;
}

/** Rotary encoder: metal can + knurled shaft + threaded bushing + pins. */
function rotaryEncoderModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new RoundedBoxGeometry(6, 5, 6, 2, 0.3), MAT.steel, 0, 2.5, 0));
  g.add(mesh(new THREE.CylinderGeometry(1.8, 1.8, 2, 16), MAT.aluminum, 0, 6, 0));
  // knurled shaft
  g.add(mesh(new THREE.CylinderGeometry(1.2, 1.2, 4, 12), MAT.steel, 0, 9, 0));
  for (const [x, z] of padPoints(ctx.footprint, 5)) {
    g.add(radialLead(x, z, 0.22));
  }
  return g;
}

/** NRF24L01 module: green PCB + chip + crystal + PCB antenna zigzag. */
function nrf24Model(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new RoundedBoxGeometry(12, 1.2, 18, 2, 0.2), MAT.greenPcb, 0, 1.8, 0));
  g.add(mesh(new RoundedBoxGeometry(4, 1.2, 4, 2, 0.1), MAT.dipBody, 0, 2.9, -3));
  g.add(mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.8, 12), MAT.aluminum, 3, 2.8, -3));
  // meander antenna (copper zigzag at the end)
  for (let i = 0; i < 4; i++) {
    g.add(mesh(new THREE.BoxGeometry(8, 0.15, 0.4), MAT.copper, 0, 2.45, 5 + i * 1.2));
  }
  for (const [x, z] of padPoints(ctx.footprint, 8)) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 2.2, 0.5), MAT.brass, x, 0.7, z));
  }
  return g;
}

/** Voltage reference (ICL8069/LM336/LM385/TL431): TO-92 or SOT-23 by pads. */
function voltageRefModel(ctx: ModelBuildContext): THREE.Group {
  if (isSMD(ctx.footprint)) return sot23(ctx);
  return to92(ctx);
}

/** Current source / behavioral source: small black box + label. */
function sourceBoxModel(ctx: ModelBuildContext, label: string): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(4, padSpanX(ctx.footprint));
  const w = Math.min(span * 0.6, 6);
  g.add(mesh(new RoundedBoxGeometry(w, 2.5, 3, 2, 0.2), MAT.dipBody, 0, 1.6, 0));
  try {
    const l = labelPlane(label, w * 0.6, 1, { fg: '#c8c8cc', fontPx: 36 });
    l.position.set(0, 2.9, 0);
    g.add(l);
  } catch { /* label optional */ }
  for (const [x, z] of padPoints(ctx.footprint, 4)) {
    g.add(radialLead(x, z, 0.22));
  }
  return g;
}

/** Transmission line: thin microstrip segment with launch pads. */
function transLineModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(6, padSpanX(ctx.footprint));
  const w = Math.min(span * 0.8, 14);
  g.add(mesh(new THREE.BoxGeometry(w, 0.15, 1.2), MAT.copper, 0, 0.1, 0));
  // launch connectors at ends
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(1.5, 0.8, 2), MAT.brass, s * w * 0.45, 0.4, 0));
  }
  return g;
}

/** VCO / PLL module: shield can + trimmer + pins. */
function vcoModule(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(6, padSpanX(ctx.footprint));
  const w = Math.min(spanX * 0.7, 12);
  g.add(mesh(new RoundedBoxGeometry(w, 3, w * 0.7, 2, 0.2), MAT.aluminum, 0, 1.5, 0));
  g.add(mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.8, 12), MAT.brass, -w * 0.25, 3.3, 0));
  for (const [x, z] of padPoints(ctx.footprint, 8)) {
    g.add(radialLead(x, z, 0.22));
  }
  return g;
}

/**
 * Ground tie: a real copper-pour tie — plated via barrel, annular ring, and
 * 4 thermal-relief spokes reaching into the surrounding pour, plus a GND
 * silkscreen tag. Reads as an actual grounded mounting point instead of an
 * empty pad or a floating box.
 */
function groundModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const pts = padPoints(ctx.footprint, 1);
  const [x, z] = pts[0] ?? [0, 0];
  // plated via barrel + annular ring
  g.add(mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.2, 16), MAT.copper, x, -0.6, z));
  g.add(mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.25, 20), MAT.enig, x, 0.12, z));
  // thermal-relief spokes (4 copper traces into the pour)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const spoke = mesh(new THREE.BoxGeometry(2.6, 0.12, 0.7), MAT.copper, x + Math.cos(a) * 2.2, 0.08, z + Math.sin(a) * 2.2);
    spoke.rotation.y = -a;
    g.add(spoke);
  }
  // solder dome over the via
  g.add(mesh(new THREE.SphereGeometry(0.7, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), MAT.solder, x, 0.2, z));
  // GND tag
  try {
    const label = labelPlane('GND', 3.2, 0.9, { fg: '#e8e8e8', fontPx: 38 });
    label.position.set(x, 0.06, z + 2.6);
    g.add(label);
  } catch { /* label optional */ }
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

const FACTORIES: Record<string, ModelFactory> = {
  resistor: axialResistor,
  capacitor: ceramicCap,
  capacitorElectrolytic: electrolyticCap,
  diode: glassDiode,
  zener: glassDiode,
  schottky: glassDiode,
  diodeShockley: glassDiode,
  led: ledModel,
  npn: to92,
  pnp: to92,
  bjtGPNpn: to92,
  bjtGPPnp: to92,
  jfetN: sot23,
  jfetP: sot23,
  nmos: sot23,
  pmos: sot23,
  mosLevel1N: sot23,
  mosLevel1P: sot23,
  bsim3nmos: sot23,
  bsim3pmos: sot23,
  bsim4nmos: sot23,
  bsim4pmos: sot23,
  timer555: dipIC,
  opamp: dipIC,
  opampRails: dipIC,
  opampReal: dipIC,
  vco: soicIC,
  and: soicIC,
  or: soicIC,
  nand: soicIC,
  nor: soicIC,
  xor: soicIC,
  not: soicIC,
  comparator: soicIC,
  crystal: crystal,
  inductor: inductorModel,
  dcVoltage: batteryModel,
  acVoltage: batteryModel,
  pulseSource: batteryModel,
  switch: switchModel,
  pushButton: pushButtonModel,
  potentiometer: potentiometerModel,
  fuse: fuseModel,
  photoresistor: photoresistorModel,
  sevenSegment: sevenSegmentModel,
  speaker: speakerModel,
  transformer: transformerModel,
  coupledInductor: transformerModel,
  voltageRegulator: to220,
  arduinoReal: arduinoModule,
  arduino: arduinoModule,
  // Ground: copper-pour tie with thermal spokes (never a floating box)
  ground: groundModel,
  // ── Extended coverage: every remaining catalog type maps to a realistic
  // family (no more plain gray boxes). Parametric-DIP parts (logic, sensors)
  // size from their real pad count via dipIC/soicIC.
  // Power-tab devices (TO-220)
  lm7805: to220, lm317: to220, lm1117: powerTabDevice, lt3045: powerTabDevice,
  igbt: to220, scr: to220, triac: to220,
  // Small regulators / references
  tl431: voltageRefModel, lm336: voltageRefModel, lm385: voltageRefModel,
  icl8069: voltageRefModel, lm1117sot: sot223,
  // Axial power diodes (black epoxy DO-41, NOT glass)
  photodiode: axialPowerDiode, crd: axialPowerDiode, diac: axialPowerDiode,
  // Phototransistor / hall: TO-92 style
  phototransistor: to92, hallSwitch: to92, hallLinear: to92,
  // Disc sensors: thermistor/PTC blue, MOV red, electret separate
  thermistor: (ctx) => discSensor(ctx, 0x1d4ed8),
  ptc: (ctx) => discSensor(ctx, 0x0f766e),
  mov: (ctx) => discSensor(ctx, 0xb91c1c),
  electretMic: electretMicModel,
  // Film / tantalum caps
  transLineLossless: transLineModel, transLineLossy: transLineModel,
  capacitorFilm: filmBoxCap, capacitorTantalum: tantalumCap,
  // Trimmer
  // (potentiometer keeps its panel-pot model; vdiv = trimmer)
  vdiv: trimmerPot,
  // Relay / SSR / opto
  relay: relayCube, ssr: relayCube, optocoupler: optocouplerModel,
  // Buzzers / motors
  buzzer: buzzerModel, dcMotor: dcMotorModel, servoMotor: servoModel,
  stepperMotor: servoModel,
  // Displays
  lcd1602: lcdModel, ssd1306: oledModel,
  rgbLed: rgbLedModel, ws2812b: rgbLedModel,
  // MCU modules
  esp32dev: esp32Model, raspberryPi: raspberryPiModel,
  adc: genericSoicIC, dac: genericSoicIC,
  // Sensor breakouts (blue PCB + can)
  dht22: sensorBreakout, ds18b20: sensorBreakout, mpu6050: sensorBreakout,
  adxl335: sensorBreakout, mq2: sensorBreakout, pir501: sensorBreakout,
  acs712: (ctx) => sensorBreakout(ctx, 0x00457c),
  rotaryEncoder: rotaryEncoderModel,
  hcsr04: hcsr04Model,
  nrf24l01: nrf24Model,
  // Crystal oscillator can
  crystalOscillator: crystalOscModel,
  // Connector / test point
  connector: connectorModel, testPoint: testPointModel,
  junction: testPointModel,
  // Behavioral / dependent sources: labeled black boxes
  bvSource: (ctx) => sourceBoxModel(ctx, 'Bv'),
  biSource: (ctx) => sourceBoxModel(ctx, 'Bi'),
  vcSwitch: (ctx) => sourceBoxModel(ctx, 'SW'),
  cccsUser: (ctx) => sourceBoxModel(ctx, 'F'),
  ccvsUser: (ctx) => sourceBoxModel(ctx, 'H'),
  vccsUser: (ctx) => sourceBoxModel(ctx, 'G'),
  vcvsUser: (ctx) => sourceBoxModel(ctx, 'E'),
  currentSource: (ctx) => sourceBoxModel(ctx, 'I'),
  // VCO/PLL shield modules
  pll4046: vcoModule,
  // Op-amps / comparators / logic ICs (DIP or SOIC by footprint)
  lm741: dipIC, lm358: dipIC, lm324: dipIC, lm393: dipIC, lm311: dipIC,
  ne5532: dipIC, tl072: dipIC, lm565: dipIC,
  // All 74xx / CD40xx / flip-flops / latches → generic DIP (pin count adapts)
  cd4013: genericDipIC, cd4017: genericDipIC, cd4026: genericDipIC,
  cd4027: genericDipIC, cd4060: genericDipIC, cd4066: genericDipIC,
  cd4093: genericDipIC, cd4511: genericDipIC,
  dff: genericDipIC, jkff: genericDipIC, srlatch: genericDipIC,
  tristate: genericDipIC, schmitt_nand: genericSoicIC, schmitt_not: genericSoicIC,
  dland: genericSoicIC,
  // Meters: bench boxes with glass face
  voltmeter: (ctx) => sourceBoxModel(ctx, 'V'),
  ammeter: (ctx) => sourceBoxModel(ctx, 'A'),
  oscilloscope: (ctx) => sourceBoxModel(ctx, 'SCOPE'),
  // Solar
  solarCell: solarCellModel,
  // Battery (9V PP3 style already exists)
  battery: batteryModel,
};

/**
 * Build a realistic procedural 3D model for a footprint.
 * Returns null when no factory exists (the viewer falls back to the
 * STL / parametric-box path).
 */
export function buildComponentModel(ctx: ModelBuildContext): THREE.Group | null {
  const factory = FACTORIES[ctx.footprint.componentType]
    // Dynamic fallback by naming convention — any FUTURE logic/IC type
    // (e.g. ic74xxx, 74xx_X, cd4xxx) gets a pin-count-adaptive DIP/SOIC
    // instead of a plain gray box. SMD footprints → gull-wing SOIC.
    ?? (/^(ic\d|74\d{2}|cd4\d|schmitt|dff|jkff|srlatch|tristate|dland|lm\d|ne\d|tl\d)/i.test(ctx.footprint.componentType)
      ? (isSMD(ctx.footprint) ? soicIC : dipIC)
      : undefined);
  if (!factory) return null;
  try {
    return factory(ctx);
  } catch {
    return null;
  }
}

/** Does a procedural factory exist for this component type? */
export function hasProceduralModel(componentType: string): boolean {
  if (componentType in FACTORIES) return true;
  return /^(ic\d|74\d{2}|cd4\d|schmitt|dff|jkff|srlatch|tristate|dland|lm\d|ne\d|tl\d)/i.test(componentType);
}
