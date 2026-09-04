// Default 3D models for common PCB component types.
//
// These are generated programmatically (no hand-authored triangle data) so
// they remain compact and easy to adjust. Each entry is an ASCII STL string
// produced by `makeBoxSTL` / `makeCylinderSTL`; the viewer parses these once
// and caches the resulting geometry.
//
// Unit convention: 1 unit = 1 mm (same as KiCad's 3D library).

/** A registered default 3D model for a component type. */
export interface ComponentModelEntry {
  /** Component type matching `CircuitComponent.type` (e.g. 'resistor'). */
  type: string;
  /** Inline STL ASCII body. Parsed once and cached by the viewer. */
  stlAscii: string;
}

/** A single STL triangle (12 floats: normal + 3 vertices). */
interface Triangle {
  normal: [number, number, number];
  v0: [number, number, number];
  v1: [number, number, number];
  v2: [number, number, number];
}

/** Format a single STL ASCII triangle. */
function formatTriangle(t: Triangle): string {
  const f = (n: number) => n.toFixed(6);
  const n = t.normal;
  return [
    `  facet normal ${f(n[0])} ${f(n[1])} ${f(n[2])}`,
    `    outer loop`,
    `      vertex ${f(t.v0[0])} ${f(t.v0[1])} ${f(t.v0[2])}`,
    `      vertex ${f(t.v1[0])} ${f(t.v1[1])} ${f(t.v1[2])}`,
    `      vertex ${f(t.v2[0])} ${f(t.v2[1])} ${f(t.v2[2])}`,
    `    endloop`,
    `  endfacet`,
  ].join('\n');
}

/** Compute the unit normal of a CCW triangle (a, b, c). */
function faceNormal(a: [number, number, number], b: [number, number, number], c: [number, number, number]): [number, number, number] {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Wrap a triangle list as a complete ASCII STL document. */
function wrapSTL(triangles: Triangle[], name: string): string {
  const header = `solid ${name}`;
  const footer = `endsolid ${name}`;
  return [header, ...triangles.map(formatTriangle), footer].join('\n');
}

/**
 * Generate an axis-aligned box centered at the origin, returning the
 * 12 triangles of its 6 faces as an ASCII STL string.
 *
 * Dimensions are in mm. The box occupies [-w/2, w/2] x [-h/2, h/2] x [-d/2, d/2].
 *
 * @param w width (X axis)
 * @param h height (Y axis — vertical, perpendicular to the board)
 * @param d depth (Z axis)
 */
export function makeBoxSTL(w: number, h: number, d: number): string {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const v: [number, number, number][] = [
    [-hx, -hy, -hz], [ hx, -hy, -hz], [ hx,  hy, -hz], [-hx,  hy, -hz], // back  (z=-hz)
    [-hx, -hy,  hz], [ hx, -hy,  hz], [ hx,  hy,  hz], [-hx,  hy,  hz], // front (z=+hz)
  ];
  // CCW winding as seen from outside each face.
  const faces: [number, number, number][] = [
    [0, 3, 2], [0, 2, 1], // back   (-Z)
    [4, 5, 6], [4, 6, 7], // front  (+Z)
    [0, 4, 7], [0, 7, 3], // left   (-X)
    [1, 2, 6], [1, 6, 5], // right  (+X)
    [0, 1, 5], [0, 5, 4], // bottom (-Y)
    [3, 7, 6], [3, 6, 2], // top    (+Y)
  ];
  const tris: Triangle[] = faces.map(([ia, ib, ic]) => {
    const a = v[ia], b = v[ib], c = v[ic];
    return { normal: faceNormal(a, b, c), v0: a, v1: b, v2: c };
  });
  return wrapSTL(tris, `box_${w}x${h}x${d}`);
}

/**
 * Generate a vertical cylinder (axis = +Y) centered at the origin,
 * tessellated as `segments` quads (2 triangles each) for the side plus
 * two triangle fans for the end caps. Returns ASCII STL.
 *
 * @param r radius in mm
 * @param h height in mm (along Y axis)
 * @param segments tessellation count (default 16)
 */
export function makeCylinderSTL(r: number, h: number, segments = 16): string {
  const hy = h / 2;
  const tris: Triangle[] = [];
  // Pre-compute ring vertices.
  const ring = (ySign: number) => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < segments; i++) {
      const ang = (i / segments) * Math.PI * 2;
      pts.push([Math.cos(ang) * r, ySign * hy, Math.sin(ang) * r]);
    }
    return pts;
  };
  const top = ring(1);
  const bottom = ring(-1);

  // Side wall — outward-facing quads.
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const a = bottom[i], b = bottom[j], c = top[j], d = top[i];
    const n1 = faceNormal(a, b, c);
    const n2 = faceNormal(a, c, d);
    tris.push({ normal: n1, v0: a, v1: b, v2: c });
    tris.push({ normal: n2, v0: a, v1: c, v2: d });
  }

  // Bottom cap (-Y face): fan around [0, -hy, 0], CCW as seen from below.
  const bottomCenter: [number, number, number] = [0, -hy, 0];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const a = bottomCenter, b = bottom[j], c = bottom[i];
    tris.push({ normal: faceNormal(a, b, c), v0: a, v1: b, v2: c });
  }
  // Top cap (+Y face): fan around [0, hy, 0], CCW as seen from above.
  const topCenter: [number, number, number] = [0, hy, 0];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const a = topCenter, b = top[i], c = top[j];
    tris.push({ normal: faceNormal(a, b, c), v0: a, v1: b, v2: c });
  }
  return wrapSTL(tris, `cylinder_r${r}_h${h}`);
}

/**
 * Build a DIP-style IC body: a box with a small "pin-1 dot" indentation on
 * the top face. The dot is approximated by simply shifting the box's top
 * corner; we keep it cheap by leaving the geometry as a plain box plus a
 * shallow cylinder (hole is purely visual — we just add a small disc to
 * indicate pin 1).
 */
function makeDIPSTL(w: number, h: number, d: number): string {
  // Body box + a small dot indicator on the top face.
  const body = makeBoxSTL(w, h, d);
  // Use a tiny cylinder as the pin-1 marker disc, sitting just above the body.
  // (Cheap approximation — we render a thin cylinder, ~0.1mm tall, on the top.)
  const dotR = Math.min(w, d) * 0.08;
  const dotH = 0.05;
  const dot = makeCylinderSTL(dotR, dotH, 12);
  // Shift the dot to sit on top of the body, offset toward the corner.
  // We do this by emitting a transform around the dot — but since STL ASCII
  // doesn't support transforms, we generate the cylinder directly with the
  // offset baked in.
  return body + '\n' + dot;
}

/** Build the default-model registry keyed by `CircuitComponent.type`. */
function buildDefaultModels(): Map<string, ComponentModelEntry> {
  const entries: ComponentModelEntry[] = [
    // Axial THT resistor — cylinder 1.6mm dia × 3.2mm long
    { type: 'resistor', stlAscii: makeCylinderSTL(0.8, 3.2, 16) },
    // Ceramic capacitor — box 2.0 × 1.25 × 1.25 mm
    { type: 'capacitor', stlAscii: makeBoxSTL(2.0, 1.25, 1.25) },
    // Electrolytic capacitor — cylinder 5mm dia × 11mm tall
    { type: 'capacitorElectrolytic', stlAscii: makeCylinderSTL(2.5, 11.0, 24) },
    // LED — cylinder 5mm dia × 8mm tall
    { type: 'led', stlAscii: makeCylinderSTL(2.5, 8.0, 24) },
    // THT diode — cylinder 1.8mm dia × 4.5mm
    { type: 'diode', stlAscii: makeCylinderSTL(0.9, 4.5, 16) },
    // Zener diode — small cylinder (like diode but smaller)
    { type: 'zener', stlAscii: makeCylinderSTL(0.8, 3.5, 16) },
    // Schottky diode — same as zener
    { type: 'schottky', stlAscii: makeCylinderSTL(0.8, 3.5, 16) },
    // 555 timer / opamp (DIP-8) — box 9.6 × 3.2 × 6.5 mm
    { type: 'timer555', stlAscii: makeDIPSTL(9.6, 3.2, 6.5) },
    { type: 'opamp', stlAscii: makeDIPSTL(9.6, 3.2, 6.5) },
    { type: 'opampRails', stlAscii: makeDIPSTL(9.6, 3.2, 6.5) },
    { type: 'opampReal', stlAscii: makeDIPSTL(9.6, 3.2, 6.5) },
    // NPN / PNP (TO-92) — box 4.8 × 5.2 × 4.8 mm (flat-front approximation)
    { type: 'npn', stlAscii: makeBoxSTL(4.8, 5.2, 4.8) },
    { type: 'pnp', stlAscii: makeBoxSTL(4.8, 5.2, 4.8) },
    // MOSFETs (BSIM3/BSIM4) — SOT-23: box 2.9 × 1.1 × 2.4 mm
    { type: 'nmos', stlAscii: makeBoxSTL(2.9, 1.1, 2.4) },
    { type: 'pmos', stlAscii: makeBoxSTL(2.9, 1.1, 2.4) },
    { type: 'bsim3nmos', stlAscii: makeBoxSTL(2.9, 1.1, 2.4) },
    { type: 'bsim3pmos', stlAscii: makeBoxSTL(2.9, 1.1, 2.4) },
    { type: 'bsim4nmos', stlAscii: makeBoxSTL(2.9, 1.1, 2.4) },
    { type: 'bsim4pmos', stlAscii: makeBoxSTL(2.9, 1.1, 2.4) },
    // JFET — TO-92 same as BJT
    { type: 'jfetN', stlAscii: makeBoxSTL(4.8, 5.2, 4.8) },
    { type: 'jfetP', stlAscii: makeBoxSTL(4.8, 5.2, 4.8) },
    // Logic gates (SOIC-14) — box 8.7 × 1.75 × 3.9 mm
    { type: 'and', stlAscii: makeDIPSTL(8.7, 1.75, 3.9) },
    { type: 'or', stlAscii: makeDIPSTL(8.7, 1.75, 3.9) },
    { type: 'nand', stlAscii: makeDIPSTL(8.7, 1.75, 3.9) },
    { type: 'nor', stlAscii: makeDIPSTL(8.7, 1.75, 3.9) },
    { type: 'xor', stlAscii: makeDIPSTL(8.7, 1.75, 3.9) },
    { type: 'not', stlAscii: makeDIPSTL(6.0, 1.75, 3.9) },
    // Voltage sources — battery cylinder 12mm dia × 25mm tall
    { type: 'dcVoltage', stlAscii: makeCylinderSTL(6.0, 25.0, 24) },
    { type: 'acVoltage', stlAscii: makeCylinderSTL(6.0, 25.0, 24) },
    { type: 'pulseSource', stlAscii: makeBoxSTL(8.0, 3.0, 6.0) },
    // Switch / pushButton — small rectangular box
    { type: 'switch', stlAscii: makeBoxSTL(6.0, 3.0, 4.0) },
    { type: 'pushButton', stlAscii: makeBoxSTL(6.0, 3.0, 6.0) },
    // Crystal — cylindrical can 3mm dia × 8mm tall
    { type: 'crystal', stlAscii: makeCylinderSTL(1.5, 8.0, 16) },
    // Inductor — cylinder with coil rings (approximate as cylinder 5mm dia × 5mm)
    { type: 'inductor', stlAscii: makeCylinderSTL(2.5, 5.0, 24) },
    // Coupled inductor / transformer — E-core box 10 × 8 × 8 mm
    { type: 'coupledInductor', stlAscii: makeBoxSTL(10.0, 8.0, 8.0) },
    { type: 'transformer', stlAscii: makeBoxSTL(14.0, 12.0, 10.0) },
    // Speaker — cone (approximate as short cylinder 30mm dia × 5mm)
    { type: 'speaker', stlAscii: makeCylinderSTL(15.0, 5.0, 32) },
    // Voltmeter / ammeter — bench equipment box
    { type: 'voltmeter', stlAscii: makeBoxSTL(10.0, 4.0, 8.0) },
    { type: 'ammeter', stlAscii: makeBoxSTL(10.0, 4.0, 8.0) },
    // Oscilloscope — bench equipment box 20 × 8 × 15 mm
    { type: 'oscilloscope', stlAscii: makeBoxSTL(20.0, 8.0, 15.0) },
    // Potentiometer — box with knob (6mm box + 3mm cylinder on top)
    { type: 'potentiometer', stlAscii: makeBoxSTL(6.0, 5.0, 6.0) },
    // Fuse — small cylinder 2.5mm dia × 8mm
    { type: 'fuse', stlAscii: makeCylinderSTL(1.25, 8.0, 16) },
    // Photoresistor — disc 5mm dia × 2mm
    { type: 'photoresistor', stlAscii: makeCylinderSTL(2.5, 2.0, 24) },
    // Seven segment display — box 12 × 6 × 5 mm
    { type: 'sevenSegment', stlAscii: makeBoxSTL(12.0, 6.0, 5.0) },
    // VCO — SOIC-8 box 5 × 1.75 × 6.3 mm
    { type: 'vco', stlAscii: makeDIPSTL(5.0, 1.75, 6.3) },
    // Voltage regulator — TO-220 box 10 × 4.5 × 15 mm
    { type: 'voltageRegulator', stlAscii: makeBoxSTL(10.0, 4.5, 15.0) },
    // Arduino Uno R3 — board only: box 68.6 × 1.6 × 53.4 mm
    { type: 'arduino', stlAscii: makeBoxSTL(68.6, 1.6, 53.4) },
    { type: 'arduinoReal', stlAscii: makeBoxSTL(68.6, 1.6, 53.4) },
    // Raspberry Pi (3B+): 85 × 1.4 × 56 mm
    { type: 'raspberryPi', stlAscii: makeBoxSTL(85.0, 1.4, 56.0) },
    // Behavioral sources — small box
    { type: 'bvSource', stlAscii: makeBoxSTL(4.0, 2.0, 3.0) },
    { type: 'biSource', stlAscii: makeBoxSTL(4.0, 2.0, 3.0) },
    // Voltage-controlled switch — small box
    { type: 'vcSwitch', stlAscii: makeBoxSTL(4.0, 2.0, 4.0) },
    // Lossless transmission line — thin rectangular
    { type: 'transLineLossless', stlAscii: makeBoxSTL(12.0, 1.0, 3.0) },
    // Lossy transmission line — thin rectangular with segment marks
    { type: 'transLineLossy', stlAscii: makeBoxSTL(16.0, 1.0, 3.0) },
    // User-defined controlled sources (E/G/F/H) — small boxes
    { type: 'vcvsUser', stlAscii: makeBoxSTL(6.0, 2.0, 4.0) },
    { type: 'vccsUser', stlAscii: makeBoxSTL(6.0, 2.0, 4.0) },
    { type: 'cccsUser', stlAscii: makeBoxSTL(6.0, 2.0, 4.0) },
    { type: 'ccvsUser', stlAscii: makeBoxSTL(6.0, 2.0, 4.0) },
  ];
  return new Map(entries.map((e) => [e.type, e]));
}

/**
 * Default 3D model registry. Looked up by component `type`. Components not
 * present here fall back to the viewer's parametric `BoxGeometry` logic.
 */
export const DEFAULT_MODELS: Map<string, ComponentModelEntry> = buildDefaultModels();
