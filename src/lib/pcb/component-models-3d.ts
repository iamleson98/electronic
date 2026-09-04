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
  // formed leads to the pads (single curved wire, body end → pad)
  const bodyY = r + 0.25;
  g.add(bentLead(span / 2, bodyLen / 2, 0.25, bodyY));
  g.add(bentLead(-span / 2, bodyLen / 2, 0.25, bodyY));
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
  // crimp ring at the can base — the slight bulge where the aluminum can
  // is mechanically crimped around the rubber bung. A subtle torus that
  // reads as "real electrolytic" at any zoom level.
  const crimpRing = new THREE.Mesh(
    new THREE.TorusGeometry(canR * 1.04, 0.22, 8, 28),
    MAT.aluminum,
  );
  crimpRing.rotation.x = Math.PI / 2;
  crimpRing.position.y = 0.28;
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
  g.add(bentLead(span / 2, bodyLen / 2, 0.2, r));
  g.add(bentLead(-span / 2, bodyLen / 2, 0.2, r));
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

/** TO-92 transistor: D-shaped black body + 3 round splayed leads. */
function to92(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanZ = Math.max(2.0, padSpanZ(ctx.footprint));
  const bodyR = Math.min(2.6, Math.max(1.9, spanZ * 0.62));
  const bodyH = 5.2;
  const bodyY = bodyH / 2 + 0.8;
  // D-shaped body: full round section + a flat back face, built from a
  // cylinder arc (round) plus a thin flat plate on the −X face (label side).
  const body = mesh(
    new THREE.CylinderGeometry(bodyR, bodyR, bodyH, 28, 1, false, Math.PI * 0.5, Math.PI * 1.5),
    MAT.blackPlastic, 0, bodyY, 0,
  );
  g.add(body);
  // flat back panel (the molded flat face where the part number is printed)
  g.add(mesh(new RoundedBoxGeometry(0.5, bodyH, bodyR * 2, 2, 0.15), MAT.blackPlastic, -bodyR + 0.2, bodyY, 0));
  // 3 round tinned leads that splay slightly toward the pads. Real TO-92
  // leads are Ø0.45 mm round wires, not rectangular beams. The middle/edge
  // legs spread outward so they land on the footprint's pad row.
  const padPts = padPoints(ctx.footprint, 3);
  const legs = padPts.length >= 3 ? padPts : [[-bodyR * 0.5, -spanZ / 2.2], [-bodyR * 0.5, 0], [-bodyR * 0.5, spanZ / 2.2]];
  for (let i = 0; i < 3; i++) {
    const [px, pz] = legs[i];
    const topX = -bodyR * 0.35 + (i === 1 ? 0.3 : -0.15);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(px, -2.5, pz),
      new THREE.Vector3(px, 0.6, pz),
      new THREE.Vector3(topX, bodyY - 0.8, pz),
    ], false, 'centripetal', 0.5);
    const lead = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.22, 8, false), MAT.lead);
    lead.castShadow = true;
    g.add(lead);
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
  // plastic body — rounded edges for the molded look
  g.add(mesh(new RoundedBoxGeometry(3.2, 10.2, bodyW * 0.86, 2, 0.2), MAT.blackPlastic, 0.2, 5.1, 0));
  // front face label plate (subtle lighter inset)
  g.add(mesh(new THREE.BoxGeometry(0.25, 6.2, bodyW * 0.62),
    new THREE.MeshStandardMaterial({ color: 0x2e2e34, roughness: 0.5 }), 1.85, 6.0, 0));
  // 3 formed leads: they exit the body bottom, bend outward 90°, then drop
  // straight down to the pads — the signature TO-220 lead shape. Built as
  // one rounded-box per lead (flat tab, not a round wire) that bends at the
  // body edge. The middle lead exits from the body center; the two outer
  // leads splay to the pad row.
  const padPts = padPoints(ctx.footprint, 3);
  const leadDefs = padPts.length >= 3
    ? padPts.map(([px, pz]) => ({ px, pz }))
    : [{ px: 0.6, pz: -spanZ / 2.15 }, { px: 0.6, pz: 0 }, { px: 0.6, pz: spanZ / 2.15 }];
  for (const { px, pz } of leadDefs) {
    // vertical pin through the board
    g.add(mesh(new THREE.BoxGeometry(0.6, 2.6, 0.5), MAT.lead, px, 0.4, pz));
    // shoulder bend from the body down toward the pin
    g.add(mesh(new THREE.BoxGeometry(1.6, 0.5, 0.5), MAT.lead, px + 0.5, 1.6, pz));
    // body-exit connector
    g.add(mesh(new THREE.BoxGeometry(0.6, 1.4, 0.5), MAT.lead, px, 2.5, pz));
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
  // body — rounded edges for the molded epoxy look
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.15), MAT.dipBody, 0, bodyH / 2 + 0.4, 0));
  // pin-1 notch (half-cylinder cut, approximated with a dark inset cylinder)
  const notchMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.7 });
  const notch = mesh(new THREE.CylinderGeometry(0.8, 0.8, bodyW + 0.06, 16), notchMat, -bodyL / 2 + 0.8, bodyH + 0.42, 0);
  notch.rotation.x = Math.PI / 2;
  g.add(notch);
  // pin-1 dot
  g.add(mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 12),
    new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.6 }),
    -bodyL / 2 + 2.0, bodyH + 0.44, -bodyW / 2 + 0.9));
  // pins: two rows along ±Z — real DIP leads are round Ø0.45 mm tinned wire
  // with a shoulder that exits the body horizontally then bends 90° down.
  const pinCount = Math.max(2, Math.round(npins / 2));
  const pinR = 0.23;
  for (const rowZ of [-1, 1]) {
    for (let i = 0; i < pinCount; i++) {
      const px = -bodyL / 2 + (bodyL / (pinCount + 0.001)) * (i + 0.5) * 0.98 + bodyL / (pinCount * 4);
      const z = rowZ * (spanZ / 2);
      // shoulder: horizontal cylinder exiting the body side
      const shoulder = mesh(new THREE.CylinderGeometry(pinR, pinR, 1.6, 8), MAT.lead, px, bodyH / 2 - 0.2, z - rowZ * 0.5);
      shoulder.rotation.x = Math.PI / 2;
      g.add(shoulder);
      // vertical pin going down through the board
      g.add(mesh(new THREE.CylinderGeometry(pinR, pinR, 3.4, 8), MAT.lead, px, -0.9, z));
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
  g.add(mesh(new RoundedBoxGeometry(bodyL, bodyH, bodyW, 2, 0.1), MAT.dipBody, 0, bodyH / 2 + 0.15, 0));
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
  const body = mesh(new RoundedBoxGeometry(1.6, 1.1, 2.9, 2, 0.08), MAT.blackPlastic, 0, 0.65, 0);
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

/** 9 V battery (PP3): rounded metal jacket, wrap label, snap terminals.
 *  Scaled to fit the footprint's pad span (a real PP3 dwarfs small
 *  prototyping boards — this keeps the visual proportion sensible). */
function batteryModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(6, padSpanX(ctx.footprint));
  const s = Math.min(1, span / 13);
  const bodyW = 13 * s, bodyH = 16.5 * s, bodyD = 10.5 * s;
  // rounded-corner jacket (rolled steel look)
  const jacket = mesh(
    new RoundedBoxGeometry(bodyW, bodyH, bodyD, 3, 1.1 * s),
    new THREE.MeshPhysicalMaterial({ color: 0x2e3138, roughness: 0.42, metalness: 0.75, clearcoat: 0.35, clearcoatRoughness: 0.35 }),
    0, bodyH / 2, 0,
  );
  g.add(jacket);
  // paper label wrap (upper 60 %)
  const label = mesh(
    new RoundedBoxGeometry(bodyW * 1.012, bodyH * 0.58, bodyD * 1.012, 2, 1.0 * s),
    new THREE.MeshPhysicalMaterial({ color: 0xc9a441, roughness: 0.62, metalness: 0.0, clearcoat: 0.1 }),
    0, bodyH * 0.7, 0,
  );
  g.add(label);
  // printed stripe on the label
  g.add(mesh(new THREE.BoxGeometry(bodyW * 1.02, bodyH * 0.1, bodyD * 1.02),
    new THREE.MeshPhysicalMaterial({ color: 0x8c1f1f, roughness: 0.55 }), 0, bodyH * 0.55, 0));
  // PP3 snap terminals: large + stud and small − stud with rim
  const plus = mesh(new THREE.CylinderGeometry(2.9 * s, 2.9 * s, 1.1, 20), MAT.aluminum, 0, bodyH + 0.55, -bodyD * 0.14);
  g.add(plus);
  g.add(mesh(new THREE.CylinderGeometry(1.5 * s, 1.5 * s, 1.0, 14), MAT.lead, 0, bodyH + 1.3, -bodyD * 0.14));
  const minusRim = mesh(new THREE.CylinderGeometry(2.1 * s, 2.1 * s, 0.9, 18), MAT.aluminum, 0, bodyH + 0.45, bodyD * 0.22);
  g.add(minusRim);
  g.add(mesh(new THREE.CylinderGeometry(1.9 * s, 1.9 * s, 0.5, 16), MAT.darkPlastic, 0, bodyH + 0.62, bodyD * 0.22));
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
 * Arduino-style MCU MODULE: a compact blue daughter-board standing over the
 * footprint's header pads — PCB, pin headers at the ACTUAL pad positions,
 * USB-B jack, barrel jack, ATmega DIP + crystal. Scaled to the footprint's
 * real pad span (the old fixed 68×53 mm STL stuck out past the board edge
 * whenever the layout compressed the footprint).
 */
function arduinoModule(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(6, padSpanX(ctx.footprint));
  const spanZ = Math.max(10, padSpanZ(ctx.footprint));
  // module PCB: a little wider than the pad grid, Uno-blue
  const bw = Math.min(spanX + 6, 30);
  const bl = Math.min(spanZ + 4, 60);
  const pcbMat = new THREE.MeshPhysicalMaterial({
    color: 0x00457c, roughness: 0.55, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.4,
  });
  const pcb = mesh(new RoundedBoxGeometry(bw, 1.6, bl, 2, 0.3), pcbMat, 0, 2.4, 0);
  g.add(pcb);
  // pin headers — at the REAL pad positions (both rows if the footprint has
  // them), black plastic + gold pins reaching down through the board
  const pts = padPoints(ctx.footprint, 30);
  const headerMat = new THREE.MeshPhysicalMaterial({ color: 0x14161a, roughness: 0.6, metalness: 0.05 });
  for (const [x, z] of pts) {
    g.add(mesh(new THREE.BoxGeometry(0.9, 1.2, 0.9), headerMat, x, 1.9, z));
    g.add(mesh(new THREE.BoxGeometry(0.34, 2.0, 0.34), MAT.lead, x, 0.4, z));
  }
  // USB-B jack at one end
  g.add(mesh(new RoundedBoxGeometry(4.4, 3.4, 5.2, 2, 0.35),
    new THREE.MeshPhysicalMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.9, clearcoat: 0.4 }),
    0, 4.5, bl / 2 - 2.6));
  // barrel jack at the other end
  g.add(mesh(new RoundedBoxGeometry(3.4, 3.2, 4.2, 2, 0.3),
    new THREE.MeshPhysicalMaterial({ color: 0x1a1a1e, roughness: 0.5, metalness: 0.3, clearcoat: 0.25 }),
    0, 4.3, -bl / 2 + 2.2));
  // ATmega DIP chip on top, across the module
  const chipL = Math.min(spanZ * 0.55, 22);
  g.add(mesh(new RoundedBoxGeometry(bw * 0.55, 2.6, chipL, 2, 0.25), MAT.dipBody, 0, 4.4, -bl * 0.08));
  // crystal + a couple of SMD passives for texture
  g.add(mesh(new THREE.CylinderGeometry(1.1, 1.1, 2.2, 12),
    new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.85 }),
    -bw * 0.3, 4.0, bl * 0.12));
  for (const [cx, cz, cw, cl] of [[bw * 0.28, bl * 0.18, 1.2, 2.0], [bw * 0.28, bl * 0.3, 1.6, 0.8], [-bw * 0.28, -bl * 0.05, 1.0, 2.0]] as const) {
    g.add(mesh(new THREE.BoxGeometry(cw, 0.5, cl), MAT.mlcc, cx, 3.55, cz));
  }
  return g;
}

/** 7-segment display: black body + 8 emissive segment bars. */
function sevenSegmentModel(ctx: ModelBuildContext): THREE.Group {
  const g = new THREE.Group();
  const spanX = Math.max(8, padSpanX(ctx.footprint));
  const w = spanX * 0.8;
  const h = w * 0.6;
  const bodyH = 3;
  // black epoxy body with rounded edges
  g.add(mesh(new RoundedBoxGeometry(w, bodyH, h, 2, 0.2), MAT.blackPlastic, 0, bodyH / 2, 0));
  // recessed face well: a slightly inset dark plate (the diffuser face real
  // displays have) with a raised bezel frame around it — segments glow from
  // INSIDE the well, not floating on a flat top
  const faceY = bodyH + 0.02;
  const faceMat = new THREE.MeshPhysicalMaterial({
    color: 0x40060a, roughness: 0.35, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25,
  });
  g.add(mesh(new THREE.BoxGeometry(w * 0.9, 0.12, h * 0.8), faceMat, 0, faceY - 0.03, 0));
  // bezel frame (4 thin bars around the face)
  const bez = new THREE.MeshPhysicalMaterial({ color: 0x101013, roughness: 0.55, metalness: 0.05 });
  g.add(mesh(new THREE.BoxGeometry(w * 0.96, 0.34, h * 0.06), bez, 0, faceY + 0.06, h * 0.42));
  g.add(mesh(new THREE.BoxGeometry(w * 0.96, 0.34, h * 0.06), bez, 0, faceY + 0.06, -h * 0.42));
  g.add(mesh(new THREE.BoxGeometry(w * 0.07, 0.34, h * 0.8), bez, w * 0.445, faceY + 0.06, 0));
  g.add(mesh(new THREE.BoxGeometry(w * 0.07, 0.34, h * 0.8), bez, -w * 0.445, faceY + 0.06, 0));
  // emissive segments (a–g + dp) — recessed into the face well, glowing
  // through; lit state driven by __updateSegments. Off-state color = the
  // dark red of unlit segment plastic (never fully invisible).
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
  const sw = w * 0.09, sl = w * 0.26;
  for (const [sx, sz] of segs) {
    const vertical = Math.abs(sx) > 0.01;
    // per-segment material CLONE — each segment glows independently
    const segMatClone = new THREE.MeshStandardMaterial({
      color: 0x551111, emissive: 0xff2020, emissiveIntensity: 0, roughness: 0.3,
    });
    const seg = mesh(
      new THREE.BoxGeometry(vertical ? sw : sl, 0.14, vertical ? sl : sw),
      segMatClone, sx, faceY, sz,
    );
    g.add(seg);
    segMeshes.push(seg);
  }
  // decimal point (bottom-right, same glow treatment)
  const dpMat = new THREE.MeshStandardMaterial({
    color: 0x551111, emissive: 0xff2020, emissiveIntensity: 0, roughness: 0.3,
  });
  const dp = mesh(new THREE.CylinderGeometry(sw * 0.5, sw * 0.5, 0.14, 12), dpMat, w * 0.38, faceY, -h * 0.32);
  dp.rotation.x = Math.PI / 2;
  g.add(dp);
  (g as any).__updateSegments = (onMask: number) => {
    // bit0..6 = a..g — segments stay visible (red plastic) and GLOW when lit
    for (let i = 0; i < 7; i++) {
      const on = ((onMask >> i) & 1) === 1;
      (segMeshes[i].material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 2.4 : 0;
    }
  };
  (g as any).__updateSegments(0); // start dark; the render loop lights them
  // DIP-style round leads — two rows along ±Z at the REAL pad positions.
  // Round Ø0.45 mm tinned pins (real 7-seg modules use a 10-pin DIP header),
  // not the old square beams.
  const padPts = padPoints(ctx.footprint, 12);
  if (padPts.length >= 2) {
    for (const [px, pz] of padPts) {
      g.add(radialLead(px, pz, 0.22, 2.6));
    }
  } else {
    const pinCount = Math.max(4, Math.min(10, ctx.footprint.pads.length));
    for (let i = 0; i < pinCount; i++) {
      const px = -w / 2 + (w / pinCount) * (i + 0.5);
      for (const rowZ of [-1, 1]) {
        g.add(radialLead(px, rowZ * (h / 2 - 0.5), 0.22, 2.6));
      }
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
  arduinoReal: arduinoModule,
  arduino: arduinoModule,
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
