// STEP (ISO 10303-21) importer for the 3D viewer.
// Pure-TypeScript parser for the AP203/AP214 BREP subset used by KiCad's
// 3D model library. (KiCad uses OpenCASCADE to parse STEP; we can't ship
// OpenCASCADE WASM easily, so this is a leaner re-implementation.)
//
// Supported entities:
//   CARTESIAN_POINT, DIRECTION, VECTOR, AXIS2_PLACEMENT_3D, AXIS1_PLACEMENT,
//   LINE, CIRCLE, POLYLINE, PLANE, CYLINDRICAL_SURFACE, CONICAL_SURFACE
//   (best-effort, treated as a variable-radius cylinder), VERTEX_POINT,
//   EDGE_CURVE, ORIENTED_EDGE, EDGE_LOOP, VERTEX_LOOP, FACE_BOUND,
//   FACE_OUTER_BOUND, ADVANCED_FACE, FACE_SURFACE, CLOSED_SHELL,
//   OPEN_SHELL, MANIFOLD_SOLID_BREP, FACETED_BREP,
//   ADVANCED_BREP_SHAPE_REPRESENTATION.
//
// Unit convention: 1 unit = 1 mm (matches KiCad's 3D library). No unit
// conversion is performed here.

import type { LoadedModel } from './model-loader';

const EPS = 1e-9;
/** Default segment count when tessellating circular edges / cylinder strips. */
const CYL_SEGMENTS = 16;

type Vec3 = [number, number, number];
interface Vec2 { x: number; y: number; }

// ===== STEP parameter & entity model =====

/** A parsed STEP parameter value. */
export type STEPParam =
  | number
  | string
  | boolean
  | null
  | { ref: number }
  | STEPParam[]
  | { type: string; params: STEPParam[] };

/** A parsed STEP entity: `#N = TYPE(args);`. */
export interface STEPEntity {
  id: number;
  type: string;
  params: STEPParam[];
}

// ===== Tokenizer =====

interface Token {
  kind: 'REF' | 'NUMBER' | 'STRING' | 'ENUM' | 'IDENT' |
        'LPAREN' | 'RPAREN' | 'COMMA' | 'SEMI' | 'EQ' | 'DOLLAR' | 'STAR';
  value: string;
}

function isDigit(c: string | undefined): boolean {
  return !!c && c >= '0' && c <= '9';
}
function isAlpha(c: string | undefined): boolean {
  return !!c && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_');
}
function isAlphaNum(c: string | undefined): boolean {
  return isDigit(c) || isAlpha(c);
}

/**
 * Tokenize a STEP file's full text. Handles ISO-10303-21 syntax: numbers
 * (incl. exponent form), strings (with '' escape), enums (.T./.F./.U.),
 * references (#N), and `;` / `,` / `(` / `)` / `=` punctuation. Block
 * comments (`/* ... *\/`) are stripped.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '(') {
      tokens.push({ kind: 'LPAREN', value: c }); i++;
    } else if (c === ')') {
      tokens.push({ kind: 'RPAREN', value: c }); i++;
    } else if (c === ',') {
      tokens.push({ kind: 'COMMA', value: c }); i++;
    } else if (c === ';') {
      tokens.push({ kind: 'SEMI', value: c }); i++;
    } else if (c === '=') {
      tokens.push({ kind: 'EQ', value: c }); i++;
    } else if (c === '$' || c === '*') {
      tokens.push({ kind: c === '$' ? 'DOLLAR' : 'STAR', value: c }); i++;
    } else if (c === '#') {
      let j = i + 1;
      while (isDigit(text[j])) j++;
      tokens.push({ kind: 'REF', value: text.slice(i + 1, j) });
      i = j;
    } else if (c === '\'') {
      let j = i + 1;
      let str = '';
      while (j < n) {
        if (text[j] === '\'') {
          if (text[j + 1] === '\'') { str += '\''; j += 2; }
          else break;
        } else { str += text[j]; j++; }
      }
      tokens.push({ kind: 'STRING', value: str });
      i = j + 1;
    } else if (c === '.') {
      if (isDigit(text[i + 1])) {
        let j = i + 1;
        while (isDigit(text[j])) j++;
        if (text[j] === 'e' || text[j] === 'E') {
          j++;
          if (text[j] === '+' || text[j] === '-') j++;
          while (isDigit(text[j])) j++;
        }
        tokens.push({ kind: 'NUMBER', value: text.slice(i, j) });
        i = j;
      } else {
        let j = i + 1;
        while (j < n && text[j] !== '.') j++;
        tokens.push({ kind: 'ENUM', value: text.slice(i + 1, j) });
        i = j + 1;
      }
    } else if (isDigit(c) || ((c === '+' || c === '-') && isDigit(text[i + 1]))) {
      let j = i;
      if (text[j] === '+' || text[j] === '-') j++;
      while (isDigit(text[j])) j++;
      if (text[j] === '.') {
        j++;
        while (isDigit(text[j])) j++;
      }
      if (text[j] === 'e' || text[j] === 'E') {
        j++;
        if (text[j] === '+' || text[j] === '-') j++;
        while (isDigit(text[j])) j++;
      }
      tokens.push({ kind: 'NUMBER', value: text.slice(i, j) });
      i = j;
    } else if (isAlpha(c)) {
      let j = i;
      while (isAlphaNum(text[j])) j++;
      tokens.push({ kind: 'IDENT', value: text.slice(i, j) });
      i = j;
    } else {
      // Unknown character, skip silently.
      i++;
    }
  }
  return tokens;
}

// ===== Entity parser =====

/** Find the token index right after `DATA;`. Returns -1 if not found. */
function findDataSection(tokens: Token[]): number {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].kind === 'IDENT' && tokens[i].value === 'DATA' &&
        tokens[i + 1].kind === 'SEMI') {
      return i + 2;
    }
  }
  return -1;
}

/** Parse a single STEP parameter starting at `start`. */
function parseParam(tokens: Token[], start: number): { value: STEPParam; nextIndex: number } {
  const t = tokens[start];
  if (!t) throw new Error('STEP: unexpected end of input while parsing parameter');
  switch (t.kind) {
    case 'NUMBER': return { value: parseFloat(t.value), nextIndex: start + 1 };
    case 'STRING': return { value: t.value, nextIndex: start + 1 };
    case 'ENUM':
      if (t.value === 'T') return { value: true, nextIndex: start + 1 };
      if (t.value === 'F') return { value: false, nextIndex: start + 1 };
      return { value: t.value, nextIndex: start + 1 };
    case 'DOLLAR': case 'STAR': return { value: null, nextIndex: start + 1 };
    case 'REF': return { value: { ref: parseInt(t.value, 10) }, nextIndex: start + 1 };
    case 'LPAREN': {
      const r = parseParamList(tokens, start + 1);
      return { value: r.params, nextIndex: r.nextIndex + 1 };
    }
    case 'IDENT': {
      if (tokens[start + 1]?.kind === 'LPAREN') {
        const r = parseParamList(tokens, start + 2);
        return { value: { type: t.value, params: r.params }, nextIndex: r.nextIndex + 1 };
      }
      return { value: t.value, nextIndex: start + 1 };
    }
    default:
      throw new Error(`STEP: unexpected token ${t.kind} (${t.value})`);
  }
}

/** Parse a comma-separated parameter list, stopping at the closing RPAREN. */
function parseParamList(tokens: Token[], start: number): { params: STEPParam[]; nextIndex: number } {
  const params: STEPParam[] = [];
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'RPAREN') return { params, nextIndex: i };
    const r = parseParam(tokens, i);
    params.push(r.value);
    i = r.nextIndex;
    if (tokens[i]?.kind === 'COMMA') i++;
    else if (tokens[i]?.kind === 'RPAREN') return { params, nextIndex: i };
  }
  return { params, nextIndex: i };
}

/** Parse all `#N = TYPE(params);` entities from the token stream. */
function parseEntities(tokens: Token[]): Map<number, STEPEntity> {
  const entities = new Map<number, STEPEntity>();
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i]?.kind === 'IDENT' && tokens[i].value === 'ENDSEC') break;
    if (tokens[i]?.kind !== 'REF' || tokens[i + 1]?.kind !== 'EQ') {
      i++;
      continue;
    }
    const id = parseInt(tokens[i].value, 10);
    const typeTok = tokens[i + 2];
    if (!typeTok || typeTok.kind !== 'IDENT') {
      throw new Error(`STEP: expected type name after #${id} =`);
    }
    const type = typeTok.value;
    let j = i + 3;
    const params: STEPParam[] = [];
    if (tokens[j]?.kind === 'LPAREN') {
      const r = parseParamList(tokens, j + 1);
      params.push(...r.params);
      j = r.nextIndex;
      if (tokens[j]?.kind === 'RPAREN') j++;
    }
    if (tokens[j]?.kind !== 'SEMI') {
      throw new Error(`STEP: expected ';' after entity #${id} (got ${tokens[j]?.kind})`);
    }
    j++;
    entities.set(id, { id, type, params });
    i = j;
  }
  return entities;
}

// ===== Type guards & param accessors =====

function isRef(p: STEPParam | undefined): p is { ref: number } {
  return !!p && typeof p === 'object' && !Array.isArray(p) && 'ref' in p && !('type' in p);
}
function isInline(p: STEPParam | undefined): p is { type: string; params: STEPParam[] } {
  return !!p && typeof p === 'object' && !Array.isArray(p) && 'type' in p;
}
function asNumber(p: STEPParam | undefined, name: string): number {
  if (typeof p === 'number') return p;
  throw new Error(`STEP: expected number for ${name}, got ${typeof p}`);
}
function asRef(p: STEPParam | undefined, name: string): number {
  if (isRef(p)) return p.ref;
  throw new Error(`STEP: expected reference for ${name}`);
}
function asList(p: STEPParam | undefined, name: string): STEPParam[] {
  if (Array.isArray(p)) return p;
  throw new Error(`STEP: expected list for ${name}`);
}

/** Resolve a parameter that may be either a `#N` reference or an inline TYPE(...). */
function resolveEntity(entities: Map<number, STEPEntity>, param: STEPParam | undefined): STEPEntity | null {
  if (isRef(param)) return entities.get(param.ref) ?? null;
  if (isInline(param)) return { id: -1, type: param.type, params: param.params };
  return null;
}

// ===== Vec3 helpers =====

function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function lengthV(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
function normalize(a: Vec3): Vec3 {
  const l = lengthV(a);
  if (l < EPS) return [0, 0, 1];
  return [a[0] / l, a[1] / l, a[2] / l];
}

// ===== Geometry resolvers =====

/** Resolve a CARTESIAN_POINT reference into a Vec3. */
function resolvePoint(entities: Map<number, STEPEntity>, refId: number): Vec3 {
  const e = entities.get(refId);
  if (!e) throw new Error(`STEP: unknown point #${refId}`);
  if (e.type !== 'CARTESIAN_POINT') {
    throw new Error(`STEP: #${refId} is not a CARTESIAN_POINT (got ${e.type})`);
  }
  const coords = asList(e.params[1], 'point coords');
  const x = asNumber(coords[0], 'x');
  const y = asNumber(coords[1], 'y');
  const z = coords.length >= 3 ? asNumber(coords[2], 'z') : 0;
  return [x, y, z];
}

/** Resolve a DIRECTION reference into a normalized Vec3. */
function resolveDirection(entities: Map<number, STEPEntity>, refId: number): Vec3 {
  const e = entities.get(refId);
  if (!e) throw new Error(`STEP: unknown direction #${refId}`);
  if (e.type !== 'DIRECTION') {
    throw new Error(`STEP: #${refId} is not a DIRECTION (got ${e.type})`);
  }
  const ratios = asList(e.params[1], 'direction ratios');
  const x = ratios.length >= 1 ? asNumber(ratios[0], 'x') : 0;
  const y = ratios.length >= 2 ? asNumber(ratios[1], 'y') : 0;
  const z = ratios.length >= 3 ? asNumber(ratios[2], 'z') : 0;
  return normalize([x, y, z]);
}

interface Placement { origin: Vec3; axis: Vec3; refDir: Vec3; }

/** Resolve AXIS2_PLACEMENT_3D into an origin + orthonormal axis/refDir basis. */
function resolvePlacement(entities: Map<number, STEPEntity>, refId: number): Placement {
  const e = entities.get(refId);
  if (!e) throw new Error(`STEP: unknown placement #${refId}`);
  if (e.type !== 'AXIS2_PLACEMENT_3D' && e.type !== 'AXIS1_PLACEMENT') {
    throw new Error(`STEP: #${refId} is not an AXIS2_PLACEMENT_3D (got ${e.type})`);
  }
  const locRef = asRef(e.params[1], 'placement location');
  const origin = resolvePoint(entities, locRef);
  let axis: Vec3 = [0, 0, 1];
  let refDir: Vec3 = [1, 0, 0];
  if (isRef(e.params[2])) axis = resolveDirection(entities, e.params[2].ref);
  if (isRef(e.params[3])) refDir = resolveDirection(entities, e.params[3].ref);
  axis = normalize(axis);
  // Orthogonalize refDir with respect to axis (Gram-Schmidt).
  refDir = normalize(sub(refDir, scale(axis, dot(refDir, axis))));
  if (lengthV(refDir) < EPS) {
    const dummy: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    refDir = normalize(cross(dummy, axis));
  }
  return { origin, axis, refDir };
}

/** Resolve a VERTEX_POINT reference into a Vec3. */
function resolveVertex(entities: Map<number, STEPEntity>, refId: number): Vec3 {
  const e = entities.get(refId);
  if (!e) throw new Error(`STEP: unknown vertex #${refId}`);
  if (e.type !== 'VERTEX_POINT') {
    throw new Error(`STEP: #${refId} is not a VERTEX_POINT (got ${e.type})`);
  }
  const pRef = asRef(e.params[1], 'vertex point');
  return resolvePoint(entities, pRef);
}

// ===== Curve evaluation =====

/** Evaluate a CIRCLE arc from `start` to `end` into a list of Vec3 points. */
function evalCircleArc(entities: Map<number, STEPEntity>, e: STEPEntity, start: Vec3, end: Vec3): Vec3[] {
  // CIRCLE(name, position, radius)
  const posRef = asRef(e.params[1], 'circle position');
  const placement = resolvePlacement(entities, posRef);
  const radius = asNumber(e.params[2], 'radius');
  const { origin: center, axis, refDir } = placement;
  const binormal = cross(axis, refDir);
  // Project start/end onto the circle plane to compute their angles.
  const projectAngle = (p: Vec3): number => {
    const d = sub(p, center);
    const radial = sub(d, scale(axis, dot(d, axis)));
    return Math.atan2(dot(radial, binormal), dot(radial, refDir));
  };
  const startAngle = projectAngle(start);
  let endAngle = projectAngle(end);
  const dist = lengthV(sub(start, end));
  const isFullCircle = dist < Math.max(EPS, radius * 1e-3);
  let dAngle: number;
  if (isFullCircle) {
    dAngle = 2 * Math.PI;
  } else {
    dAngle = endAngle - startAngle;
    // Take the shorter arc.
    while (dAngle > Math.PI) dAngle -= 2 * Math.PI;
    while (dAngle < -Math.PI) dAngle += 2 * Math.PI;
  }
  const segs = Math.max(2, Math.ceil(Math.abs(dAngle) / (2 * Math.PI) * CYL_SEGMENTS));
  const points: Vec3[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = startAngle + dAngle * (i / segs);
    const p: Vec3 = add(center, add(
      scale(refDir, radius * Math.cos(a)),
      scale(binormal, radius * Math.sin(a)),
    ));
    points.push(p);
  }
  return points;
}

/** Evaluate a POLYLINE into a list of Vec3 points. */
function evalPolyline(entities: Map<number, STEPEntity>, e: STEPEntity): Vec3[] {
  const pointsList = asList(e.params[1], 'polyline points');
  const points: Vec3[] = [];
  for (const pRef of pointsList) {
    if (isRef(pRef)) points.push(resolvePoint(entities, pRef.ref));
  }
  return points;
}

/** Evaluate an EDGE_CURVE into a list of points (start → end, or full loop). */
function evaluateEdgeCurveEntity(
  entities: Map<number, STEPEntity>,
  edge: STEPEntity,
  orientation: boolean,
): Vec3[] {
  if (edge.type !== 'EDGE_CURVE') {
    throw new Error(`STEP: expected EDGE_CURVE, got ${edge.type}`);
  }
  // EDGE_CURVE(name, vertex_start, vertex_end, edge_geometry, same_sense)
  const startRef = asRef(edge.params[1], 'edge vertex_start');
  const endRef = asRef(edge.params[2], 'edge vertex_end');
  const curveRef = asRef(edge.params[3], 'edge_geometry');
  const start = resolveVertex(entities, startRef);
  const end = resolveVertex(entities, endRef);
  const curve = entities.get(curveRef);
  if (!curve) throw new Error(`STEP: unknown curve #${curveRef}`);
  let points: Vec3[];
  switch (curve.type) {
    case 'LINE': points = [start, end]; break;
    case 'CIRCLE': points = evalCircleArc(entities, curve, start, end); break;
    case 'POLYLINE': points = evalPolyline(entities, curve); break;
    default: points = [start, end]; // Best-effort for unknown curve types.
  }
  if (!orientation) points.reverse();
  return points;
}

/** Evaluate an EDGE_LOOP into an ordered list of Vec3 points along the loop. */
function evaluateEdgeLoopEntity(
  loop: STEPEntity,
  entities: Map<number, STEPEntity>,
): Vec3[] {
  if (loop.type === 'VERTEX_LOOP') {
    const vRef = asRef(loop.params[1], 'vertex loop vertex');
    return [resolveVertex(entities, vRef)];
  }
  if (loop.type !== 'EDGE_LOOP') return [];
  const edgeList = asList(loop.params[1], 'edge loop edges');
  const points: Vec3[] = [];
  for (const edgeParam of edgeList) {
    const edgeEntity = resolveEntity(entities, edgeParam);
    if (!edgeEntity) continue;
    let edgePoints: Vec3[];
    if (edgeEntity.type === 'ORIENTED_EDGE') {
      // ORIENTED_EDGE(name, edge_start, edge_end, edge_element, orientation)
      // The 5-param form is standard; some compact files use 3 params:
      // (name, edge_element, orientation).
      let innerEdgeParam: STEPParam | undefined;
      let orientationParam: STEPParam | undefined;
      if (edgeEntity.params.length >= 5) {
        innerEdgeParam = edgeEntity.params[3];
        orientationParam = edgeEntity.params[4];
      } else if (edgeEntity.params.length >= 3) {
        innerEdgeParam = edgeEntity.params[1];
        orientationParam = edgeEntity.params[2];
      } else {
        continue;
      }
      const innerEdge = resolveEntity(entities, innerEdgeParam);
      if (!innerEdge) continue;
      const orientation = orientationParam !== false;
      edgePoints = evaluateEdgeCurveEntity(entities, innerEdge, orientation);
    } else if (edgeEntity.type === 'EDGE_CURVE') {
      edgePoints = evaluateEdgeCurveEntity(entities, edgeEntity, true);
    } else {
      continue;
    }
    // De-duplicate the junction point between consecutive edges.
    if (points.length > 0 && edgePoints.length > 0) {
      const last = points[points.length - 1];
      const first = edgePoints[0];
      if (lengthV(sub(last, first)) < EPS) {
        edgePoints = edgePoints.slice(1);
      }
    }
    points.push(...edgePoints);
  }
  // Drop the duplicate closing vertex if the loop is closed.
  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (lengthV(sub(first, last)) < EPS) {
      points.pop();
    }
  }
  return points;
}

// ===== Surface resolution =====

interface SurfaceSpec {
  kind: 'plane' | 'cylinder' | 'cone' | 'unknown';
  origin: Vec3;
  axis: Vec3;
  refDir: Vec3;
  radius: number;
  /** Cone semi-angle (radians); 0 for planes/cylinders. */
  halfAngle: number;
}

/** Resolve a SURFACE reference into a SurfaceSpec. */
function resolveSurface(entities: Map<number, STEPEntity>, surfaceParam: STEPParam): SurfaceSpec {
  const e = resolveEntity(entities, surfaceParam);
  if (!e) throw new Error('STEP: missing surface reference');
  switch (e.type) {
    case 'PLANE': {
      // PLANE(name, position)
      const posRef = asRef(e.params[1], 'plane position');
      const p = resolvePlacement(entities, posRef);
      return { kind: 'plane', origin: p.origin, axis: p.axis, refDir: p.refDir, radius: 0, halfAngle: 0 };
    }
    case 'CYLINDRICAL_SURFACE': {
      // CYLINDRICAL_SURFACE(name, position, radius)
      const posRef = asRef(e.params[1], 'cylinder position');
      const p = resolvePlacement(entities, posRef);
      const radius = asNumber(e.params[2], 'cylinder radius');
      return { kind: 'cylinder', origin: p.origin, axis: p.axis, refDir: p.refDir, radius, halfAngle: 0 };
    }
    case 'CONICAL_SURFACE': {
      // CONICAL_SURFACE(name, position, radius, semi_angle)
      const posRef = asRef(e.params[1], 'cone position');
      const p = resolvePlacement(entities, posRef);
      const radius = asNumber(e.params[2], 'cone radius');
      const semiAngle = asNumber(e.params[3], 'cone semi_angle');
      return { kind: 'cone', origin: p.origin, axis: p.axis, refDir: p.refDir, radius, halfAngle: semiAngle };
    }
    default:
      return { kind: 'unknown', origin: [0, 0, 0], axis: [0, 0, 1], refDir: [1, 0, 0], radius: 0, halfAngle: 0 };
  }
}

// ===== Ear-clipping triangulation =====

/** Test whether 2D point `p` lies inside triangle `(a, b, c)`. */
function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clip a 2D polygon into triangle indices. Polygon orientation is
 * auto-detected from the signed area; the returned triangles are CCW.
 * Returns an empty array for degenerate inputs.
 */
function earClip(points: Vec2[]): number[] {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  if (Math.abs(area) < EPS) return [];
  const ccw = area > 0;
  const indices = points.map((_, i) => ccw ? i : n - 1 - i);
  const triangles: number[] = [];
  let guard = n * n;
  while (indices.length > 3 && guard-- > 0) {
    let earFound = false;
    for (let i = 0; i < indices.length; i++) {
      const i0 = indices[i];
      const i1 = indices[(i + 1) % indices.length];
      const i2 = indices[(i + 2) % indices.length];
      const a = points[i0], b = points[i1], c = points[i2];
      // Skip reflex vertices (triangle is CW = non-ear).
      const cross_ = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross_ <= 0) continue;
      let inside = false;
      for (const idx of indices) {
        if (idx === i0 || idx === i1 || idx === i2) continue;
        if (pointInTriangle(points[idx], a, b, c)) { inside = true; break; }
      }
      if (inside) continue;
      triangles.push(i0, i1, i2);
      indices.splice(i + 1, 1);
      earFound = true;
      break;
    }
    if (!earFound) break;
  }
  if (indices.length === 3) triangles.push(indices[0], indices[1], indices[2]);
  return triangles;
}

/** Unwrap atan2 results in-place to avoid 2π discontinuities along a polygon. */
function unwrapAngles(points: Vec2[]): void {
  for (let i = 1; i < points.length; i++) {
    let dx = points[i].x - points[i - 1].x;
    while (dx > Math.PI) { points[i].x -= 2 * Math.PI; dx = points[i].x - points[i - 1].x; }
    while (dx < -Math.PI) { points[i].x += 2 * Math.PI; dx = points[i].x - points[i - 1].x; }
  }
}

/** Compute the signed area of a 2D polygon (positive = CCW). */
function polygonArea2D(points: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return area / 2;
}

/** Compute a polygon normal from a 3D loop using Newell's method. */
function newellNormal(points: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const cur = points[i], next = points[j];
    n[0] += (cur[1] - next[1]) * (cur[2] + next[2]);
    n[1] += (cur[2] - next[2]) * (cur[0] + next[0]);
    n[2] += (cur[0] - next[0]) * (cur[1] + next[1]);
  }
  return normalize(n);
}

// ===== Face-bound & face evaluation =====

interface FaceLoop {
  points: Vec3[];
  orientation: boolean;
}

/** Resolve a FACE_BOUND / FACE_OUTER_BOUND parameter into an ordered point loop. */
function evaluateFaceBound(entities: Map<number, STEPEntity>, boundParam: STEPParam): FaceLoop | null {
  const boundEntity = resolveEntity(entities, boundParam);
  if (!boundEntity) return null;
  if (boundEntity.type !== 'FACE_BOUND' && boundEntity.type !== 'FACE_OUTER_BOUND') return null;
  const loopEntity = resolveEntity(entities, boundEntity.params[1]);
  if (!loopEntity) return null;
  const points = evaluateEdgeLoopEntity(loopEntity, entities);
  if (points.length < 1) return null;
  const orientation = boundEntity.params[2] !== false;
  if (!orientation) points.reverse();
  return { points, orientation };
}

/** Fan-triangulate an unknown-surface face using Newell's normal. */
function fanTriangulate(
  loop: Vec3[],
  sameSense: boolean,
  positions: number[],
  normals: number[],
): void {
  if (loop.length < 3) return;
  const n = newellNormal(loop);
  const finalN = sameSense ? n : scale(n, -1);
  for (let i = 1; i < loop.length - 1; i++) {
    const a = loop[0], b = loop[i], c = loop[i + 1];
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    normals.push(finalN[0], finalN[1], finalN[2],
                 finalN[0], finalN[1], finalN[2],
                 finalN[0], finalN[1], finalN[2]);
  }
}

/** Triangulate a planar face by projecting onto the plane and ear-clipping. */
function triangulatePlanar(
  surface: SurfaceSpec,
  outerLoop: Vec3[],
  sameSense: boolean,
  positions: number[],
  normals: number[],
): void {
  if (outerLoop.length < 3) return;
  const normal: Vec3 = sameSense ? surface.axis : scale(surface.axis, -1);
  const refDir = surface.refDir;
  const binormal = cross(normal, refDir);
  const origin = surface.origin;
  const to2D = (p: Vec3): Vec2 => {
    const d = sub(p, origin);
    return { x: dot(d, refDir), y: dot(d, binormal) };
  };
  // Snap each 3D point onto the plane (defensive against numerical drift).
  const snapped = outerLoop.map((p) => {
    const d = sub(p, origin);
    return sub(p, scale(normal, dot(d, normal)));
  });
  const outer2D = snapped.map(to2D);
  const triangles = earClip(outer2D);
  for (const idx of triangles) {
    const p = snapped[idx];
    positions.push(p[0], p[1], p[2]);
    normals.push(normal[0], normal[1], normal[2]);
  }
}

/** Compute a 3D point on a (possibly conical) surface at (angle, height). */
function cylinderPoint(surface: SurfaceSpec, angle: number, height: number): Vec3 {
  const { origin, axis, refDir, radius, halfAngle } = surface;
  const binormal = cross(axis, refDir);
  const r = radius + height * Math.tan(halfAngle);
  return add(add(origin, scale(axis, height)),
             add(scale(refDir, r * Math.cos(angle)),
                 scale(binormal, r * Math.sin(angle))));
}

/** Compute the outward radial normal at a given angle on a cylinder/cone. */
function cylinderNormal(surface: SurfaceSpec, angle: number, sameSense: boolean): Vec3 {
  const binormal = cross(surface.axis, surface.refDir);
  const n = normalize(add(scale(surface.refDir, Math.cos(angle)),
                          scale(binormal, Math.sin(angle))));
  return sameSense ? n : scale(n, -1);
}

/** Compute the average height (along the surface axis) of a loop. */
function avgHeight(loop: Vec3[], surface: SurfaceSpec): number {
  if (loop.length === 0) return 0;
  let sum = 0;
  for (const p of loop) {
    const d = sub(p, surface.origin);
    sum += dot(d, surface.axis);
  }
  return sum / loop.length;
}

/**
 * Emit a quad strip between two circular loops at different heights — the
 * standard topology for a closed cylindrical face (top + bottom circles as
 * two separate FACE_BOUNDs). Both loops are resampled at the angles taken
 * from the longer loop to produce a watertight strip.
 */
function triangulateCylinderStrip(
  surface: SurfaceSpec,
  loop1: Vec3[],
  loop2: Vec3[],
  sameSense: boolean,
  positions: number[],
  normals: number[],
): void {
  const h1 = avgHeight(loop1, surface);
  const h2 = avgHeight(loop2, surface);
  const topH = Math.max(h1, h2);
  const botH = Math.min(h1, h2);
  const { origin, axis, refDir } = surface;
  const binormal = cross(axis, refDir);
  // Sample angles from the longer loop (more angular detail).
  const longer = loop1.length >= loop2.length ? loop1 : loop2;
  const angles: number[] = longer.map((p) => {
    const d = sub(p, origin);
    const radial = sub(d, scale(axis, dot(d, axis)));
    return Math.atan2(dot(radial, binormal), dot(radial, refDir));
  });
  for (let i = 1; i < angles.length; i++) {
    while (angles[i] - angles[i - 1] > Math.PI) angles[i] -= 2 * Math.PI;
    while (angles[i] - angles[i - 1] < -Math.PI) angles[i] += 2 * Math.PI;
  }
  const N = angles.length;
  if (N < 2) return;
  // Close the loop only if the first and last angles differ by ~2π.
  const closes = Math.abs(angles[N - 1] - angles[0]) > Math.PI;
  const limit = closes ? N : N - 1;
  for (let i = 0; i < limit; i++) {
    const j = (i + 1) % N;
    const a = cylinderPoint(surface, angles[i], topH);
    const b = cylinderPoint(surface, angles[j], topH);
    const c = cylinderPoint(surface, angles[j], botH);
    const d = cylinderPoint(surface, angles[i], botH);
    const na = cylinderNormal(surface, angles[i], sameSense);
    const nb = cylinderNormal(surface, angles[j], sameSense);
    // Quad (a, b, c, d) → 2 triangles.
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    normals.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nb[0], nb[1], nb[2]);
    positions.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    normals.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], na[0], na[1], na[2]);
  }
}

/**
 * Triangulate a cylindrical / conical face.
 *
 * Two topologies are supported:
 *   - Two loops at different heights → standard closed cylinder wall
 *     (top + bottom circles) → quad strip mesh.
 *   - Single loop (partial cylinder with vertical edges) → ear-clip in
 *     (angle, height) parametric space.
 */
function triangulateCylindrical(
  surface: SurfaceSpec,
  loops: Vec3[][],
  sameSense: boolean,
  positions: number[],
  normals: number[],
): void {
  if (loops.length === 0) return;
  // Special case: 2 loops at clearly different heights → cylinder strip.
  if (loops.length === 2) {
    const h1 = avgHeight(loops[0], surface);
    const h2 = avgHeight(loops[1], surface);
    const avgH = (Math.abs(h1) + Math.abs(h2)) / 2;
    const threshold = Math.max(EPS, Math.abs(avgH) * 1e-6, surface.radius * 1e-3);
    if (typeof process !== 'undefined' && process.env?.STEP_DEBUG) {
      console.warn(`STEP: cyl face h1=${h1} h2=${h2} threshold=${threshold} ` +
                   `diff=${Math.abs(h1 - h2)} willStrip=${Math.abs(h1 - h2) > threshold}`);
    }
    if (Math.abs(h1 - h2) > threshold) {
      triangulateCylinderStrip(surface, loops[0], loops[1], sameSense, positions, normals);
      return;
    }
  }
  // Default: ear-clip the outer loop in (angle, height) 2D space.
  const outerLoop = loops[0];
  if (outerLoop.length < 3) return;
  const { origin, axis, refDir } = surface;
  const binormal = cross(axis, refDir);
  const to2D = (p: Vec3): Vec2 => {
    const d = sub(p, origin);
    const height = dot(d, axis);
    const radial = sub(d, scale(axis, height));
    return { x: Math.atan2(dot(radial, binormal), dot(radial, refDir)), y: height };
  };
  const outer2D = outerLoop.map(to2D);
  unwrapAngles(outer2D);
  const triangles = earClip(outer2D);
  for (const idx of triangles) {
    const p2 = outer2D[idx];
    const p3 = cylinderPoint(surface, p2.x, p2.y);
    const n = cylinderNormal(surface, p2.x, sameSense);
    positions.push(p3[0], p3[1], p3[2]);
    normals.push(n[0], n[1], n[2]);
  }
}

/** Triangulate a single ADVANCED_FACE / FACE_SURFACE. */
function triangulateFace(
  entities: Map<number, STEPEntity>,
  face: STEPEntity,
  positions: number[],
  normals: number[],
): void {
  // ADVANCED_FACE(name, bounds, face_geometry, same_sense)
  if (face.params.length < 3) return;
  const boundsList = asList(face.params[1], 'face bounds');
  const surface = resolveSurface(entities, face.params[2]);
  const sameSense = face.params[3] !== false;
  const loops: Vec3[][] = [];
  for (const b of boundsList) {
    const loop = evaluateFaceBound(entities, b);
    if (loop && loop.points.length >= 3) loops.push(loop.points);
  }
  if (typeof process !== 'undefined' && process.env?.STEP_DEBUG) {
    console.warn(`STEP: face #${face.id} surface=${surface.kind} loops=${loops.length} ` +
                 `(sizes: ${loops.map((l) => l.length).join(',')})`);
  }
  if (loops.length === 0) return;
  // Sort loops by signed-area magnitude (largest first = outer loop).
  loops.sort((a, b) => Math.abs(polygonArea2D(projectToXY(a, surface))) -
                       Math.abs(polygonArea2D(projectToXY(b, surface))));
  const outerLoop = loops[0];
  switch (surface.kind) {
    case 'plane':
      triangulatePlanar(surface, outerLoop, sameSense, positions, normals);
      break;
    case 'cylinder':
    case 'cone':
      triangulateCylindrical(surface, loops, sameSense, positions, normals);
      break;
    default:
      fanTriangulate(outerLoop, sameSense, positions, normals);
  }
}

/** Project a 3D loop to 2D using the surface's local frame (used only for sorting). */
function projectToXY(points: Vec3[], surface: SurfaceSpec): Vec2[] {
  const refDir = surface.refDir;
  const binormal = cross(surface.axis, refDir);
  const origin = surface.origin;
  return points.map((p) => {
    const d = sub(p, origin);
    return { x: dot(d, refDir), y: dot(d, binormal) };
  });
}

/** Triangulate all faces of a CLOSED_SHELL / OPEN_SHELL. */
function triangulateShell(
  entities: Map<number, STEPEntity>,
  shell: STEPEntity,
  positions: number[],
  normals: number[],
): void {
  // CLOSED_SHELL(name, face_list)
  if (shell.params.length < 2) {
    if (typeof process !== 'undefined' && process.env?.STEP_DEBUG) {
      console.warn(`STEP: shell #${shell.id} has too few params (${shell.params.length})`);
    }
    return;
  }
  const faceList = asList(shell.params[1], 'shell faces');
  if (typeof process !== 'undefined' && process.env?.STEP_DEBUG) {
    console.warn(`STEP: shell #${shell.id} type=${shell.type} faces=${faceList.length}`);
  }
  for (const faceParam of faceList) {
    const face = resolveEntity(entities, faceParam);
    if (!face) {
      if (typeof process !== 'undefined' && process.env?.STEP_DEBUG) {
        console.warn(`STEP: shell #${shell.id} - could not resolve face param`);
      }
      continue;
    }
    if (face.type !== 'ADVANCED_FACE' && face.type !== 'FACE_SURFACE') {
      if (typeof process !== 'undefined' && process.env?.STEP_DEBUG) {
        console.warn(`STEP: shell #${shell.id} - face #${face.id} is ${face.type}, skipping`);
      }
      continue;
    }
    const before = positions.length;
    try {
      triangulateFace(entities, face, positions, normals);
    } catch (err) {
      // Skip faces that fail to triangulate rather than aborting the whole model.
      if (typeof process !== 'undefined' && process.env?.STEP_DEBUG) {
        console.warn(`STEP: skipping face #${face.id}: ${(err as Error).message}`);
      }
    }
    if (typeof process !== 'undefined' && process.env?.STEP_DEBUG) {
      const emitted = (positions.length - before) / 9;
      console.warn(`STEP: face #${face.id} emitted ${emitted} triangles`);
    }
  }
}

/**
 * Parse a STEP (ISO 10303-21) text file into a LoadedModel.
 *
 * Extracts BREP (Boundary Representation) geometry from the common AP203 /
 * AP214 subset used by KiCad's 3D model library: CARTESIAN_POINT,
 * DIRECTION, VECTOR, AXIS2_PLACEMENT_3D, LINE, CIRCLE, POLYLINE, PLANE,
 * CYLINDRICAL_SURFACE, CONICAL_SURFACE, VERTEX_POINT, EDGE_CURVE,
 * ORIENTED_EDGE, EDGE_LOOP, FACE_BOUND, ADVANCED_FACE, CLOSED_SHELL,
 * MANIFOLD_SOLID_BREP, and ADVANCED_BREP_SHAPE_REPRESENTATION.
 *
 * Planar faces are ear-clipped; cylindrical / conical faces are
 * tessellated into `CYL_SEGMENTS` angular segments. Surfaces of
 * unknown type fall back to fan triangulation using Newell's normal.
 *
 * @throws Error if the input is not a STEP file or no BREP geometry is found.
 */
export function parseSTEP(text: string): LoadedModel {
  try {
    if (!text || !/^\s*ISO-10303-21/i.test(text)) {
      throw new Error('Not a STEP file (missing ISO-10303-21 header)');
    }
    const tokens = tokenize(text);
    const dataStart = findDataSection(tokens);
    if (dataStart === -1) {
      throw new Error('STEP: no DATA section found');
    }
    const entities = parseEntities(tokens.slice(dataStart));
    if (entities.size === 0) {
      throw new Error('STEP: no entities in DATA section');
    }
    const positions: number[] = [];
    const normals: number[] = [];
    const processedShells = new Set<number>();
    // Pass 1: walk MANIFOLD_SOLID_BREP / FACETED_BREP → outer CLOSED_SHELL.
    for (const e of entities.values()) {
      if (e.type !== 'MANIFOLD_SOLID_BREP' && e.type !== 'FACETED_BREP') continue;
      if (e.params.length < 2) continue;
      const outerRef = asRef(e.params[1], 'brep outer');
      if (processedShells.has(outerRef)) continue;
      processedShells.add(outerRef);
      const shell = entities.get(outerRef);
      if (shell) triangulateShell(entities, shell, positions, normals);
    }
    // Pass 2: fallback — pick up any standalone CLOSED_SHELL / OPEN_SHELL.
    if (positions.length === 0) {
      for (const e of entities.values()) {
        if (e.type !== 'CLOSED_SHELL' && e.type !== 'OPEN_SHELL') continue;
        if (processedShells.has(e.id)) continue;
        processedShells.add(e.id);
        triangulateShell(entities, e, positions, normals);
      }
    }
    if (positions.length === 0) {
      throw new Error('STEP: no BREP geometry found (looking for MANIFOLD_SOLID_BREP / CLOSED_SHELL)');
    }
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
    };
  } catch (err) {
    throw new Error(`STEP parse failed: ${(err as Error).message}`);
  }
}
