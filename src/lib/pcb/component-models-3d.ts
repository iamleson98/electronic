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
import type { Footprint } from './types';

export interface ModelBuildContext {
  /** PCB footprint (pads drive span/scale) */
  footprint: Footprint;
  /** schematic component parameters (e.g. resistance → color bands) */
  params: Record<string, any>;
}

export type ModelFactory = (ctx: ModelBuildContext) => THREE.Group | null;

// ─── Shared materials (module-level cache — few instances, reused) ──────────
const MAT = {
  // Epoxy / molded plastic bodies
  blackPlastic: new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.55, metalness: 0.05 }),
  darkPlastic: new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.6, metalness: 0.05 }),
  // DIP body (matte black epoxy)
  dipBody: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.65, metalness: 0.02 }),
  // Bright tinned-steel leads / pins
  lead: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.25, metalness: 1.0 }),
  // Aluminum can tops (crystals, electrolytics)
  aluminum: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.9 }),
  // Copper windings
  copper: new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 0.3, metalness: 0.9 }),
  // Resistor body (beige ceramic)
  resistorBody: new THREE.MeshStandardMaterial({ color: 0xc8b088, roughness: 0.7, metalness: 0.0 }),
  // Electrolytic can (dark navy)
  elecCan: new THREE.MeshStandardMaterial({ color: 0x1a2440, roughness: 0.45, metalness: 0.15 }),
  // Ceramic disc (orange-tan)
  ceramic: new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.8, metalness: 0.0 }),
  // MLCC / SMD tan body
  mlcc: new THREE.MeshStandardMaterial({ color: 0xc9a876, roughness: 0.75, metalness: 0.0 }),
  // Glass diode (translucent red-brown)
  diodeGlass: new THREE.MeshPhysicalMaterial({
    color: 0x8b1a1a, roughness: 0.15, metalness: 0.0,
    transparent: true, opacity: 0.85, transmission: 0.35,
  }),
  // Black diode body (DO-41 power diodes)
  diodeBody: new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.5, metalness: 0.05 }),
  // TO-220 metal tab
  tab: new THREE.MeshStandardMaterial({ color: 0x8f959c, roughness: 0.3, metalness: 0.95 }),
  // Gold ENIG pad finish
  enig: new THREE.MeshStandardMaterial({ color: 0xd4b96a, roughness: 0.25, metalness: 0.85 }),
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
function padPoints(fp: Footprint, maxPads = 4): [number, number][] {
  const pts: [number, number][] = fp.pads.slice(0, maxPads).map((p) => [p.position.x, p.position.y]);
  return pts.length ? pts : [[-2.5, 0], [2.5, 0]];
}

/** Radial through-hole lead at (x, z) going down through the board. */
function radialLead(x: number, z: number, r = 0.25, depth = 2.4): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(r, r, depth, 8), MAT.lead, x, -depth / 2 + r, z);
}

/** Radial lead (wire) with a bend: horizontal then vertical through-board. */
function bentLead(x: number, leadLen: number, r = 0.25): THREE.Group {
  const g = new THREE.Group();
  // horizontal segment along X from leadLen toward the body center
  const hGeo = new THREE.CylinderGeometry(r, r, leadLen, 8);
  const h = mesh(hGeo, MAT.lead, x - Math.sign(x) * leadLen / 2, r, 0);
  h.rotation.z = Math.PI / 2;
  g.add(h);
  // vertical segment going down through the board
  const vGeo = new THREE.CylinderGeometry(r, r, 2.2, 8);
  const v = mesh(vGeo, MAT.lead, x, -1.1 + r, 0);
  g.add(v);
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
  // 2 significant digits + multiplier
  const d1 = Math.floor(r / 10);
  const d2 = Math.floor(r) % 10;
  return [d1, d2, (mult + 9) % 10]; // multiplier index 0 = black
}

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

/** Axial THT resistor: beige cylinder body, 4 color bands, dome ends, leads. */
function axialResistor(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(6, Math.min(padSpanX(ctx.footprint), 16));
  const bodyLen = Math.min(span * 0.62, 9.2);
  const r = 1.15;
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
  // color bands from the actual resistance — deliberately chunky so they
  // read clearly at board zoom (real 1/8-W bands are ~6% body length)
  const bands = resistorBands((ctx.params.resistance as number) ?? 1000);
  const bandR = r * 1.07;
  const bandLen = bodyLen * 0.07;
  const start = -bodyLen / 2 + bodyLen * 0.16;
  const gap = bodyLen * 0.14;
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
  // leads to the pads
  const leadX = span / 2;
  g.add(bentLead(leadX, span / 2 - bodyLen / 2 + 1.2));
  g.add(bentLead(-leadX, span / 2 - bodyLen / 2 + 1.2));
  return g;
}

/** Electrolytic capacitor: can + polarity stripe + scored top + 2 leads. */
function electrolyticCap(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(1.6, padSpanZ(ctx.footprint));
  const canR = Math.max(1.6, Math.min(spanZ * 1.1, 4.0));
  const canH = Math.max(6, Math.min(canR * 2.8, 11.5));
  // can body
  const can = mesh(new THREE.CylinderGeometry(canR, canR * 1.03, canH, 28), MAT.elecCan, 0, canH / 2, 0);
  g.add(can);
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
  // stripe + two leads at the ACTUAL pad positions (match PCB layout)
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    g.add(radialLead(x, z, 0.25));
  }
  return g;
}

/** Ceramic disc capacitor (small orange dome) or MLCC box for tight spans. */
function ceramicCap(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(2.5, padSpanX(ctx.footprint));
  if (span < 4) {
    // MLCC box (SMD-ish)
    const w = Math.min(span * 0.7, 2.0);
    const box = mesh(new THREE.BoxGeometry(w, 1.5, 1.25), MAT.mlcc, 0, 0.75, 0);
    g.add(box);
    // metallic end caps
    for (const s of [-1, 1]) {
      g.add(mesh(new THREE.BoxGeometry(w * 0.22, 1.5, 1.25), MAT.enig, s * (w / 2 - w * 0.11), 0.75, 0));
    }
    return g;
  }
  // radial ceramic disc
  const r = Math.min(span * 0.42, 3.0);
  const disc = mesh(new THREE.SphereGeometry(r, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.45), MAT.ceramic, 0, 1.0, 0);
  disc.scale.y = 0.75;
  g.add(disc);
  for (const [x, z] of padPoints(ctx.footprint, 2)) {
    g.add(radialLead(x, z, 0.2));
  }
  return g;
}

/** DO-35/DO-41 glass diode: cylinder + white cathode stripe + leads. */
function glassDiode(ctx: ModelBuildContext): THREE.Group {
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
  g.add(bentLead(span / 2, span / 2 - bodyLen / 2 + 0.8, 0.2));
  g.add(bentLead(-span / 2, span / 2 - bodyLen / 2 + 0.8, 0.2));
  return g;
}

/** 5 mm LED: colored lens dome + flange + 2 legs (long anode). When powered,
 *  the lens glows AND a PointLight inside the dome actually illuminates the
 *  board and neighboring components (like a real lit LED). */
function ledModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const colorMap: Record<string, number> = {
    red: 0xff2418, green: 0x30d158, blue: 0x2f6bff, yellow: 0xffd60a, white: 0xf5f5f5, orange: 0xff9f0a,
  };
  const colorName = (ctx.params.color as string) ?? 'red';
  const color = colorMap[colorName] ?? 0xff2418;
  const lensMat = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.08, metalness: 0.0,
    transparent: true, opacity: 0.9, transmission: 0.25, thickness: 1.2,
    emissive: color, emissiveIntensity: 0,
  });
  const domeR = 2.5;
  // base cylinder + dome
  g.add(mesh(new THREE.CylinderGeometry(domeR, domeR * 1.02, 2.2, 24), lensMat, 0, 1.1 + 1.4, 0));
  const dome = mesh(new THREE.SphereGeometry(domeR, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), lensMat, 0, 2.2 + 1.4, 0);
  g.add(dome);
  // flange ring
  g.add(mesh(new THREE.CylinderGeometry(domeR * 1.12, domeR * 1.12, 0.7, 24), lensMat, 0, 0.35 + 1.4, 0));
  // legs at the actual pad positions; anode ('a') is the longer one
  const padPts = padPoints(ctx.footprint, 2);
  for (let i = 0; i < padPts.length; i++) {
    const [x, z] = padPts[i];
    const padId = ctx.footprint.pads[i]?.terminalId;
    const isAnode = padId === 'a' || i === 0;
    const len = isAnode ? 3.6 : 2.8;
    g.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, len, 8), MAT.lead, x, -len / 2 + 0.4, z));
  }
  // real light inside the dome — illuminates the board + neighbors when lit
  const glowLight = new THREE.PointLight(color, 0, 30, 2);
  glowLight.position.set(0, 4.2, 0);
  g.add(glowLight);
  // emissive hook — the render loop calls this with live sim current
  (g as any).__updateEmissive = (amps: number) => {
    const lit = Math.min(1, Math.abs(amps) / 0.008); // full glow at ~8 mA
    lensMat.emissiveIntensity = lit * 4.0;
    glowLight.intensity = lit * 15;
  };
  return g;
}

/** TO-92 transistor: half-round black body + 3 flat legs. */
function to92(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(2.0, padSpanZ(ctx.footprint));
  const bodyR = Math.min(2.6, Math.max(1.9, spanZ * 0.62));
  const bodyH = 5.2;
  // half-cylinder (theta arc) + flat face toward -X
  const body = mesh(
    new THREE.CylinderGeometry(bodyR, bodyR, bodyH, 24, 1, false, Math.PI, Math.PI),
    MAT.blackPlastic, 0, bodyH / 2 + 0.8, 0,
  );
  g.add(body);
  // flat face panel
  g.add(mesh(new THREE.BoxGeometry(0.35, bodyH, bodyR * 2), MAT.blackPlastic, -bodyR + 0.18, bodyH / 2 + 0.8, 0));
  // 3 legs
  for (let i = -1; i <= 1; i++) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 3.4, 0.35), MAT.lead, -bodyR * 0.5, -0.9, i * spanZ / 2.2));
  }
  return g;
}

/** TO-220 (regulators, power MOSFETs): black body + metal tab + 3 legs. */
function to220(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(2.2, padSpanZ(ctx.footprint));
  const bodyW = Math.max(7, spanZ + 2.5);
  // metal tab (behind the plastic)
  const tab = mesh(new THREE.BoxGeometry(1.5, 9.5, bodyW), MAT.tab, -1.6, 4.75, 0);
  g.add(tab);
  // mounting hole in the tab
  const hole = mesh(new THREE.CylinderGeometry(1.4, 1.4, 1.7, 16),
    new THREE.MeshStandardMaterial({ color: 0x0a1628 }), -1.6, 8.4, 0);
  hole.rotation.z = Math.PI / 2;
  g.add(hole);
  // plastic body
  g.add(mesh(new THREE.BoxGeometry(3.2, 10.2, bodyW * 0.86), MAT.blackPlastic, 0.2, 5.1, 0));
  // front face label plate (subtle lighter inset)
  g.add(mesh(new THREE.BoxGeometry(0.25, 6.2, bodyW * 0.62),
    new THREE.MeshStandardMaterial({ color: 0x2e2e34, roughness: 0.5 }), 1.85, 6.0, 0));
  // 3 thick legs
  for (let i = -1; i <= 1; i++) {
    g.add(mesh(new THREE.BoxGeometry(0.65, 4.2, 0.55), MAT.lead, 0.6, -1.6, i * spanZ / 2.15));
  }
  return g;
}

/** DIP IC: black body, pin-1 notch + dot, two rows of gull-wing pins. */
function dipIC(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(6, padSpanZ(ctx.footprint)); // across pin rows
  const npins = Math.max(4, ctx.footprint.pads.length);
  const spanX = Math.max(6, padSpanX(ctx.footprint));
  const bodyL = Math.max(spanX * 0.92, npins / 2 * 1.35 + 1.2);
  const bodyW = Math.max(spanZ * 0.8, 4);
  const bodyH = 3.2;
  // body
  g.add(mesh(new THREE.BoxGeometry(bodyL, bodyH, bodyW), MAT.dipBody, 0, bodyH / 2 + 0.4, 0));
  // pin-1 notch (half-cylinder cut, approximated with a dark inset cylinder)
  const notchMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.7 });
  const notch = mesh(new THREE.CylinderGeometry(0.8, 0.8, bodyW + 0.06, 16), notchMat, -bodyL / 2 + 0.8, bodyH + 0.42, 0);
  notch.rotation.x = Math.PI / 2;
  g.add(notch);
  // pin-1 dot
  g.add(mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 12),
    new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.6 }),
    -bodyL / 2 + 2.0, bodyH + 0.44, -bodyW / 2 + 0.9));
  // pins: two rows along ±Z, angled shoulder + pin
  const pinCount = Math.max(2, Math.round(npins / 2));
  for (const rowZ of [-1, 1]) {
    for (let i = 0; i < pinCount; i++) {
      const px = -bodyL / 2 + (bodyL / (pinCount + 0.001)) * (i + 0.5) * 0.98 + bodyL / (pinCount * 4);
      const z = rowZ * (spanZ / 2);
      // shoulder going out
      g.add(mesh(new THREE.BoxGeometry(0.55, 0.9, 1.1), MAT.lead, px, bodyH / 2 + 0.1, z - rowZ * 0.55));
      // leg going down
      g.add(mesh(new THREE.BoxGeometry(0.5, 3.2, 0.55), MAT.lead, px, -0.8, z));
    }
  }
  return g;
}

/** SOIC / SMD IC: low-profile body + gull-wing pins. */
function soicIC(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const npins = Math.max(4, ctx.footprint.pads.length);
  const spanZ = Math.max(3, padSpanZ(ctx.footprint));
  const spanX = Math.max(3.8, padSpanX(ctx.footprint));
  const bodyL = spanX * 0.9;
  const bodyW = Math.max(spanZ * 0.78, 2.5);
  const bodyH = 1.6;
  g.add(mesh(new THREE.BoxGeometry(bodyL, bodyH, bodyW), MAT.dipBody, 0, bodyH / 2 + 0.15, 0));
  // pin-1 chamfer marker (small beige dot)
  g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 10),
    new THREE.MeshStandardMaterial({ color: 0x8a8a90, roughness: 0.5 }),
    -bodyL / 2 + 0.8, bodyH + 0.16, -bodyW / 2 + 0.6));
  const pinCount = Math.max(2, Math.round(npins / 2));
  for (const rowZ of [-1, 1]) {
    for (let i = 0; i < pinCount; i++) {
      const px = -bodyL / 2 + (bodyL / pinCount) * (i + 0.5);
      const z = rowZ * (spanZ / 2);
      g.add(mesh(new THREE.BoxGeometry(0.42, 0.5, 1.2), MAT.lead, px, bodyH * 0.55, z - rowZ * 0.4));
      g.add(mesh(new THREE.BoxGeometry(0.42, 0.35, 0.5), MAT.lead, px, 0.18, z));
    }
  }
  return g;
}

/** SOT-23 (small-signal MOSFET/JFET): tiny body + 3 gull wings. */
function sot23(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(1.8, padSpanZ(ctx.footprint));
  const body = mesh(new THREE.BoxGeometry(1.6, 1.1, 2.9), MAT.blackPlastic, 0, 0.65, 0);
  g.add(body);
  // 2 pins one side, 1 pin the other (classic SOT-23)
  const pinMat = MAT.lead;
  for (const z of [-spanZ / 2, spanZ / 2]) {
    g.add(mesh(new THREE.BoxGeometry(0.5, 0.3, 0.8), pinMat, 0.55, 0.15, z));
  }
  g.add(mesh(new THREE.BoxGeometry(0.5, 0.3, 0.8), pinMat, -0.55, 0.15, 0));
  return g;
}

/** HC-49 crystal: metal oval can + base + 2 leads. */
function crystal(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(3, padSpanZ(ctx.footprint));
  const canR = Math.min(4.5, Math.max(2.2, span / 2 + 0.5));
  const canH = 3.4;
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
  const g = new THREE.Group();
  const spanZ = Math.max(2, padSpanZ(ctx.footprint));
  const coreR = Math.max(1.8, Math.min(spanZ * 0.85, 3.2));
  const coreH = Math.max(4.5, coreR * 2.2);
  const ferrite = new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.6, metalness: 0.3 });
  g.add(mesh(new THREE.CylinderGeometry(coreR, coreR, coreH, 24), ferrite, 0, coreH / 2 + 0.8, 0));
  // copper winding rings
  const nRings = Math.max(6, Math.floor(coreH / 0.7));
  for (let i = 0; i < nRings; i++) {
    const y = 0.8 + (coreH / nRings) * (i + 0.5);
    g.add(mesh(new THREE.TorusGeometry(coreR * 1.04, 0.22, 10, 28), MAT.copper, 0, y, 0));
    (g.children[g.children.length - 1] as THREE.Mesh).rotation.x = Math.PI / 2;
  }
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.25, 0.25, 2.4, 8), MAT.lead, 0, -0.9, s * spanZ / 2));
  }
  return g;
}

/** 9 V battery style source: boxy cell + snap terminals. Scaled to fit
 *  the footprint's pad span (a real PP3 dwarfs small prototyping boards —
 *  this keeps the visual proportion sensible). */
function batteryModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(6, padSpanX(ctx.footprint));
  const s = Math.min(1, span / 13); // scale down on tight footprints
  const bodyW = 13 * s, bodyH = 16 * s, bodyD = 10 * s;
  const body = mesh(new THREE.BoxGeometry(bodyW, bodyH, bodyD), new THREE.MeshStandardMaterial({
    color: 0x22262c, roughness: 0.6,
  }), 0, bodyH / 2, 0);
  g.add(body);
  // top cap + terminal
  g.add(mesh(new THREE.CylinderGeometry(2.6 * s, 2.6 * s, 0.7, 20), MAT.aluminum, 0, bodyH + 0.35, 0));
  g.add(mesh(new THREE.CylinderGeometry(1.1 * s, 1.1 * s, 1.2, 12), MAT.lead, 0, bodyH + 1.0, 0));
  // label band
  g.add(mesh(new THREE.BoxGeometry(bodyW * 1.01, bodyH * 0.32, bodyD * 1.01), new THREE.MeshStandardMaterial({
    color: 0xd9a441, roughness: 0.55,
  }), 0, bodyH * 0.78, 0));
  return g;
}

/** Panel-mount switch: body + actuator lever. */
function switchModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(4, padSpanZ(ctx.footprint));
  const w = Math.max(6, spanZ + 1);
  g.add(mesh(new THREE.BoxGeometry(4.5, 4, w), MAT.darkPlastic, 0, 2, 0));
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
  g.add(mesh(new THREE.BoxGeometry(w, 3.4, w), MAT.darkPlastic, 0, 1.7, 0));
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
  g.add(mesh(new THREE.BoxGeometry(5, 5.5, w), MAT.darkPlastic, 0, 2.75, 0));
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
  g.add(bentLead(span / 2, span / 2 - bodyLen / 2 + 1.0, 0.22));
  g.add(bentLead(-span / 2, span / 2 - bodyLen / 2 + 1.0, 0.22));
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

/** 7-segment display: black body + 8 emissive segment bars. */
function sevenSegmentModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(8, padSpanX(ctx.footprint));
  const w = spanX * 0.8;
  const h = w * 0.6;
  g.add(mesh(new THREE.BoxGeometry(w, 3, h), MAT.blackPlastic, 0, 1.5, 0));
  g.add(mesh(new THREE.BoxGeometry(w * 0.82, 0.1, h * 0.68),
    new THREE.MeshStandardMaterial({ color: 0x3a0d0d, roughness: 0.3 }), 0, 3.02, 0));
  // emissive segments (a–g + dp) — lit state driven by __updateEmissive
  const segMat = new THREE.MeshStandardMaterial({
    color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 0, roughness: 0.3,
  });
  const sw = w * 0.09, sl = w * 0.26;
  const segs: [number, number][] = [
    [0, h * 0.28],          // a — top
    [-w * 0.25, h * 0.14],  // b
    [-w * 0.25, -h * 0.14], // c
    [0, -h * 0.28],         // d — bottom
    [w * 0.25, -h * 0.14],  // e
    [w * 0.25, h * 0.14],   // f
    [0, 0],                 // g — middle
  ];
  const segMeshes: THREE.Mesh[] = [];
  for (const [sx, sz] of segs) {
    const vertical = Math.abs(sx) > 0.01;
    // per-segment material CLONE — each segment glows independently
    const segMatClone = segMat.clone();
    const seg = mesh(
      new THREE.BoxGeometry(vertical ? sw : sl, 0.14, vertical ? sl : sw),
      segMatClone, sx, 3.12, sz,
    );
    g.add(seg);
    segMeshes.push(seg);
  }
  (g as any).__updateSegments = (onMask: number) => {
    // bit0..6 = a..g — segments stay visible (red plastic) and GLOW when lit
    for (let i = 0; i < 7; i++) {
      const on = ((onMask >> i) & 1) === 1;
      (segMeshes[i].material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 1.8 : 0;
    }
  };
  (g as any).__updateSegments(0); // start dark; the render loop lights them
  // pins
  const pinCount = Math.max(4, Math.min(10, ctx.footprint.pads.length));
  for (let i = 0; i < pinCount; i++) {
    const px = -w / 2 + (w / pinCount) * (i + 0.5);
    for (const rowZ of [-1, 1]) {
      g.add(mesh(new THREE.BoxGeometry(0.4, 2.0, 0.4), MAT.lead, px, -0.8, rowZ * (h / 2 - 0.5)));
    }
  }
  return g;
}

/** Speaker: cone driver (basket + cone + magnet). */
function speakerModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const r = Math.max(10, padSpanX(ctx.footprint) * 0.5);
  // basket ring
  g.add(mesh(new THREE.CylinderGeometry(r, r, 1.5, 28), MAT.darkPlastic, 0, 0.75, 0));
  // cone (open cone shape)
  const cone = mesh(new THREE.CylinderGeometry(r * 0.25, r * 0.85, 2.6, 28),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.85 }), 0, 2.2, 0);
  g.add(cone);
  // center dome
  g.add(mesh(new THREE.SphereGeometry(r * 0.28, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), MAT.aluminum, 0, 3.4, 0));
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.2, 8), MAT.lead, s * r * 0.6, -0.8, 0));
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
};

/**
 * Build a realistic procedural 3D model for a footprint.
 * Returns null when no factory exists (the viewer falls back to the
 * STL / parametric-box path).
 */
export function buildComponentModel(ctx: ModelBuildContext): THREE.Group | null {
  const factory = FACTORIES[ctx.footprint.componentType];
  if (!factory) return null;
  try {
    return factory(ctx);
  } catch {
    return null;
  }
}

/** Does a procedural factory exist for this component type? */
export function hasProceduralModel(componentType: string): boolean {
  return componentType in FACTORIES;
}
