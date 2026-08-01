// 3D model parsers for PCB component bodies.
// Supports STL (binary + ASCII auto-detection), VRML 2.0 (basic subset),
// and simple OBJ. All parsers produce a `LoadedModel` (plain typed arrays)
// which can be converted to a THREE.BufferGeometry for rendering.
//
// Unit convention: 1 unit = 1 mm (matches KiCad's 3D library).
// No unit conversion is performed here.

import * as THREE from 'three/webgpu';

/**
 * Triangulated geometry ready to feed into a THREE.BufferGeometry.
 * All arrays are flattened: positions/normal stride = 3 (XYZ).
 */
export interface LoadedModel {
  /** Triangulated vertices, flattened [x,y,z, x,y,z, ...] in mm. */
  positions: Float32Array;
  /** Per-vertex normals, same length / 3 as positions. */
  normals: Float32Array;
  /** Optional index buffer. If absent, geometry is non-indexed. */
  indices?: Uint32Array;
  /** Optional RGB color override in 0..1 range. */
  color?: [number, number, number];
}

/** Supported file formats for PCB 3D models. */
export type ModelFormat = 'stl-binary' | 'stl-ascii' | 'vrml' | 'obj';

const EPS = 1e-9;

/**
 * Detect whether an ArrayBuffer or string is binary STL, ASCII STL, or
 * something else entirely.
 *
 * Binary STL files frequently start with the bytes "solid" (a common header
 * string), so we additionally probe for the `facet normal` token within the
 * first 512 bytes to distinguish ASCII from binary.
 */
export function detectSTLFormat(data: ArrayBuffer | string): 'stl-binary' | 'stl-ascii' | 'unknown' {
  let head = '';
  if (typeof data === 'string') {
    head = data.slice(0, 512);
  } else {
    // Binary STL has an 80-byte header that may contain printable ASCII.
    head = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(512, data.byteLength)));
  }
  const hasSolid = /^\s*solid/i.test(head);
  if (!hasSolid) {
    // No "solid" prefix → almost certainly binary STL (or non-STL).
    return typeof data === 'string' ? 'unknown' : 'stl-binary';
  }
  // Verify ASCII by looking for the `facet normal` keyword.
  return /facet\s+normal/i.test(head) ? 'stl-ascii' : 'stl-binary';
}

/**
 * Compute a per-triangle normal from three vertex positions.
 * Returns a unit vector; falls back to [0,0,1] if the triangle is degenerate.
 */
function triangleNormal(ax: number, ay: number, az: number,
                        bx: number, by: number, bz: number,
                        cx: number, cy: number, cz: number): [number, number, number] {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < EPS) return [0, 0, 1];
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
}

/**
 * Parse a binary STL file.
 *
 * Layout: 80-byte header, Uint32 triangle count, then per triangle:
 * 12 floats (normal + 3 vertices) + 2-byte attribute. Big-endian is never
 * used in practice; we always read little-endian.
 *
 * @throws Error if the buffer is malformed or too short.
 */
export function parseSTLBinary(data: ArrayBuffer): LoadedModel {
  if (data.byteLength < 84) {
    throw new Error(`Binary STL too short: ${data.byteLength} bytes (need >= 84)`);
  }
  const view = new DataView(data);
  const triCount = view.getUint32(80, true);
  const expectedBytes = 84 + triCount * 50;
  if (data.byteLength < expectedBytes) {
    throw new Error(`Binary STL truncated: ${data.byteLength} bytes, expected ${expectedBytes}`);
  }
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  let pIdx = 0;
  let nIdx = 0;
  for (let t = 0; t < triCount; t++) {
    const off = 84 + t * 50;
    let nx = view.getFloat32(off, true);
    let ny = view.getFloat32(off + 4, true);
    let nz = view.getFloat32(off + 8, true);
    const v0x = view.getFloat32(off + 12, true);
    const v0y = view.getFloat32(off + 16, true);
    const v0z = view.getFloat32(off + 20, true);
    const v1x = view.getFloat32(off + 24, true);
    const v1y = view.getFloat32(off + 28, true);
    const v1z = view.getFloat32(off + 32, true);
    const v2x = view.getFloat32(off + 36, true);
    const v2y = view.getFloat32(off + 40, true);
    const v2z = view.getFloat32(off + 44, true);

    // STL files often have zero normals (exporters skip them). Recompute.
    if (Math.hypot(nx, ny, nz) < EPS) {
      const n = triangleNormal(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
      nx = n[0]; ny = n[1]; nz = n[2];
    }
    positions[pIdx++] = v0x; positions[pIdx++] = v0y; positions[pIdx++] = v0z;
    positions[pIdx++] = v1x; positions[pIdx++] = v1y; positions[pIdx++] = v1z;
    positions[pIdx++] = v2x; positions[pIdx++] = v2y; positions[pIdx++] = v2z;
    for (let i = 0; i < 3; i++) {
      normals[nIdx++] = nx; normals[nIdx++] = ny; normals[nIdx++] = nz;
    }
  }
  return { positions, normals };
}

/**
 * Parse ASCII STL.
 *
 * Format:
 * ```
 * solid name
 *   facet normal nx ny nz
 *     outer loop
 *       vertex x y z
 *       vertex x y z
 *       vertex x y z
 *     endloop
 *   endfacet
 * endsolid
 * ```
 *
 * @throws Error on malformed input.
 */
export function parseSTLAscii(text: string): LoadedModel {
  try {
    const lines = text.split(/\r?\n/);
    // Pre-count facets so we can allocate the right sized array.
    let facetCount = 0;
    for (const ln of lines) if (/^\s*facet\b/i.test(ln)) facetCount++;
    if (facetCount === 0) throw new Error('ASCII STL: no facets found');
    const positions = new Float32Array(facetCount * 9);
    const normals = new Float32Array(facetCount * 9);
    let pIdx = 0;
    let nIdx = 0;
    let curNormal: [number, number, number] = [0, 0, 0];
    let curVerts: number[] = [];
    let inFacet = false;
    const flushFacet = () => {
      if (!inFacet) return;
      if (curVerts.length !== 9) {
        throw new Error(`ASCII STL: facet has ${curVerts.length / 3} vertices (expected 3)`);
      }
      let [nx, ny, nz] = curNormal;
      if (Math.hypot(nx, ny, nz) < EPS) {
        const n = triangleNormal(curVerts[0], curVerts[1], curVerts[2],
                                 curVerts[3], curVerts[4], curVerts[5],
                                 curVerts[6], curVerts[7], curVerts[8]);
        nx = n[0]; ny = n[1]; nz = n[2];
      }
      for (let i = 0; i < 9; i++) positions[pIdx++] = curVerts[i];
      for (let i = 0; i < 3; i++) { normals[nIdx++] = nx; normals[nIdx++] = ny; normals[nIdx++] = nz; }
      curVerts = [];
      inFacet = false;
    };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      if (/^facet\b/i.test(line)) {
        inFacet = true;
        const m = line.match(/^facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)/i);
        curNormal = m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : [0, 0, 0];
        curVerts = [];
      } else if (/^vertex\b/i.test(line)) {
        const m = line.match(/^vertex\s+(\S+)\s+(\S+)\s+(\S+)/i);
        if (!m) throw new Error(`ASCII STL: malformed vertex line: ${line}`);
        curVerts.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
      } else if (/^endfacet\b/i.test(line)) {
        flushFacet();
      }
    }
    flushFacet();
    if (pIdx === 0) throw new Error('ASCII STL: no vertices parsed');
    return { positions, normals };
  } catch (err) {
    throw new Error(`ASCII STL parse failed: ${(err as Error).message}`);
  }
}

/**
 * Auto-detect binary vs ASCII STL and dispatch to the right parser.
 * @throws Error if the format can't be detected or the file is malformed.
 */
export function parseSTL(data: ArrayBuffer | string): LoadedModel {
  try {
    const fmt = detectSTLFormat(data);
    if (fmt === 'stl-ascii') {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      return parseSTLAscii(text);
    }
    if (fmt === 'stl-binary') {
      if (typeof data === 'string') {
        // Caller passed a string but it looks binary — encode to bytes.
        const buf = new TextEncoder().encode(data).buffer;
        return parseSTLBinary(buf);
      }
      return parseSTLBinary(data);
    }
    throw new Error('STL format could not be detected (no "solid" header and not enough bytes for binary)');
  } catch (err) {
    throw new Error(`STL parse failed: ${(err as Error).message}`);
  }
}

// ===== VRML 2.0 =====

interface VRMLFaceSet {
  points: number[];      // flat [x,y,z,...]
  coordIndex: number[];  // flat [-1-terminated face indices]
  normals: number[];
  normalIndex: number[];
  hasNormals: boolean;
}

/**
 * Tokenise a VRML 2.0 text file: returns an array of "words", treating
 * bracket/brace characters as standalone tokens and stripping comments.
 */
function tokenizeVRML(text: string): string[] {
  // Strip comments (#... to end of line).
  const cleaned = text.replace(/#[^\n]*/g, ' ');
  // Bracket/brace punctuation becomes its own token.
  const bracketed = cleaned.replace(/([{}[\]])/g, ' $1 ');
  return bracketed.split(/\s+/).filter(Boolean);
}

/** Extract a numeric array that follows a `fieldName [ ... ]` block. */
function extractNumberArray(tokens: string[], startIndex: number): { values: number[]; nextIndex: number } {
  // tokens[startIndex-1] is the fieldName; tokens[startIndex] should be '['.
  let i = startIndex;
  if (tokens[i] !== '[') {
    // Single-value form: `point 1 2 3` (rare but legal).
    const values: number[] = [];
    while (i < tokens.length && !/^[{}[\]]$/.test(tokens[i]) && !isNaN(Number(tokens[i]))) {
      values.push(Number(tokens[i]));
      i++;
    }
    return { values, nextIndex: i };
  }
  i++; // skip '['
  const values: number[] = [];
  while (i < tokens.length && tokens[i] !== ']') {
    const n = Number(tokens[i]);
    if (isNaN(n)) { i++; continue; }
    values.push(n);
    i++;
  }
  if (tokens[i] === ']') i++;
  return { values, nextIndex: i };
}

/** Parse all IndexedFaceSet nodes from a VRML 2.0 token stream. */
function parseVRMLFaceSets(tokens: string[]): VRMLFaceSet[] {
  const sets: VRMLFaceSet[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'IndexedFaceSet' && tokens[i + 1] === '{') {
      const set: VRMLFaceSet = {
        points: [], coordIndex: [], normals: [], normalIndex: [], hasNormals: false,
      };
      // Scan inside this node (depth-1).
      let j = i + 2;
      let depth = 1;
      while (j < tokens.length && depth > 0) {
        const t = tokens[j];
        if (t === '{') depth++;
        else if (t === '}') { depth--; if (depth === 0) break; }
        if (t === 'coord' && tokens[j + 1] === 'Coordinate' && tokens[j + 2] === '{') {
          // Find `point [ ... ]` inside the Coordinate node.
          let k = j + 3;
          let cd = 1;
          while (k < tokens.length && cd > 0) {
            if (tokens[k] === '{') cd++;
            else if (tokens[k] === '}') { cd--; if (cd === 0) break; }
            if (tokens[k] === 'point') {
              const arr = extractNumberArray(tokens, k + 1);
              set.points = arr.values;
              k = arr.nextIndex;
              continue;
            }
            k++;
          }
          j = k + 1;
          continue;
        }
        if (t === 'normal' && tokens[j + 1] === 'Normal' && tokens[j + 2] === '{') {
          let k = j + 3;
          let cd = 1;
          while (k < tokens.length && cd > 0) {
            if (tokens[k] === '{') cd++;
            else if (tokens[k] === '}') { cd--; if (cd === 0) break; }
            if (tokens[k] === 'vector') {
              const arr = extractNumberArray(tokens, k + 1);
              set.normals = arr.values;
              set.hasNormals = true;
              k = arr.nextIndex;
              continue;
            }
            k++;
          }
          j = k + 1;
          continue;
        }
        if (t === 'coordIndex') {
          const arr = extractNumberArray(tokens, j + 1);
          set.coordIndex = arr.values;
          j = arr.nextIndex;
          continue;
        }
        if (t === 'normalIndex') {
          const arr = extractNumberArray(tokens, j + 1);
          set.normalIndex = arr.values;
          j = arr.nextIndex;
          continue;
        }
        j++;
      }
      sets.push(set);
      i = j;
    }
  }
  return sets;
}

/** Triangulate a polygon (3+ vertices) into a fan. Returns vertex indices. */
function triangulateFan(face: number[]): number[] {
  if (face.length < 3) return [];
  const out: number[] = [];
  for (let i = 1; i < face.length - 1; i++) {
    out.push(face[0], face[i], face[i + 1]);
  }
  return out;
}

interface VRMLFace {
  /** coord indices for this face (one per vertex) */
  coord: number[];
  /** normal indices for this face (one per vertex, or empty if no normals) */
  normal: number[];
}

/**
 * Parse a basic VRML 2.0 file: looks for `IndexedFaceSet` nodes with
 * `coord Coordinate { point [...] }`, optional `coordIndex [...]`,
 * `normal Normal { vector [...] }`, optional `normalIndex [...]`.
 *
 * Appearance/texture/material are ignored (the viewer supplies its own
 * material).
 *
 * @throws Error on malformed input or no face sets found.
 */
export function parseVRML(text: string): LoadedModel {
  try {
    const tokens = tokenizeVRML(text);
    if (tokens.length === 0) throw new Error('VRML: empty input');
    const sets = parseVRMLFaceSets(tokens);
    if (sets.length === 0) throw new Error('VRML: no IndexedFaceSet nodes found');

    // First pass: split coordIndex into faces and pair with normalIndex
    // (also -1-terminated, one index per vertex per face).
    const parsedFaces = sets.map((set) => {
      const faces: VRMLFace[] = [];
      let curC: number[] = [];
      let curN: number[] = [];
      let ni = 0;
      for (const idx of set.coordIndex) {
        if (idx === -1) {
          if (curC.length >= 3) faces.push({ coord: curC, normal: curN });
          curC = []; curN = [];
        } else {
          curC.push(idx);
          if (set.normalIndex.length > 0) {
            curN.push(set.normalIndex[ni] ?? -1);
          }
          ni++;
        }
      }
      if (curC.length >= 3) faces.push({ coord: curC, normal: curN });
      return faces;
    });

    // Pre-size the output buffers via a triangle count.
    let totalTris = 0;
    for (const faces of parsedFaces) {
      for (const f of faces) totalTris += Math.max(0, f.coord.length - 2);
    }
    if (totalTris === 0) throw new Error('VRML: no triangles in any IndexedFaceSet');

    const positions = new Float32Array(totalTris * 9);
    const normals = new Float32Array(totalTris * 9);
    let pIdx = 0;
    let nIdx = 0;

    for (let s = 0; s < sets.length; s++) {
      const set = sets[s];
      const pts = set.points;
      const norms = set.normals;
      const hasNormals = set.hasNormals && set.normals.length >= 3;
      const useNormalIndex = set.normalIndex.length > 0;

      for (const face of parsedFaces[s]) {
        const triIndices = triangulateFan(face.coord);
        // For each emitted triangle vertex we also need a normal index.
        // `triangulateFan` returns triples (a, b, c) where b's source position
        // in `face.coord` is `i` and c's is `i+1`. Re-derive them.
        for (let t = 0; t < triIndices.length; t += 3) {
          const a = triIndices[t];
          const b = triIndices[t + 1];
          const c = triIndices[t + 2];
          const ai = a * 3, bi = b * 3, ci = c * 3;
          const ax = pts[ai] ?? 0, ay = pts[ai + 1] ?? 0, az = pts[ai + 2] ?? 0;
          const bx = pts[bi] ?? 0, by = pts[bi + 1] ?? 0, bz = pts[bi + 2] ?? 0;
          const cx = pts[ci] ?? 0, cy = pts[ci + 1] ?? 0, cz = pts[ci + 2] ?? 0;
          positions[pIdx++] = ax; positions[pIdx++] = ay; positions[pIdx++] = az;
          positions[pIdx++] = bx; positions[pIdx++] = by; positions[pIdx++] = bz;
          positions[pIdx++] = cx; positions[pIdx++] = cy; positions[pIdx++] = cz;

          // For fan triangulation, the b index at position k=1..n-2 in the
          // original face corresponds to face.coord[k]; c to face.coord[k+1].
          // Recover which face-vertex each fan index came from.
          const fanPosB = (t / 3) + 1;
          const fanPosC = fanPosB + 1;
          const triVertFacePos = [0, fanPosB, fanPosC];

          let nx = 0, ny = 0, nz = 0;
          let haveNormal = false;
          if (hasNormals) {
            const sum: [number, number, number] = [0, 0, 0];
            let got = 0;
            for (const fp of triVertFacePos) {
              let ni2: number;
              if (useNormalIndex) ni2 = face.normal[fp] ?? -1;
              else ni2 = face.coord[fp];
              if (ni2 >= 0 && ni2 * 3 + 2 < norms.length) {
                sum[0] += norms[ni2 * 3];
                sum[1] += norms[ni2 * 3 + 1];
                sum[2] += norms[ni2 * 3 + 2];
                got++;
              }
            }
            if (got > 0) {
              nx = sum[0] / got; ny = sum[1] / got; nz = sum[2] / got;
              haveNormal = true;
            }
          }
          if (!haveNormal) {
            const n = triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
            nx = n[0]; ny = n[1]; nz = n[2];
          }
          const ln = Math.hypot(nx, ny, nz) || 1;
          nx /= ln; ny /= ln; nz /= ln;
          for (let k = 0; k < 3; k++) {
            normals[nIdx++] = nx; normals[nIdx++] = ny; normals[nIdx++] = nz;
          }
        }
      }
    }
    if (pIdx === 0) throw new Error('VRML: no vertices emitted (coordIndex may be empty)');
    return { positions, normals };
  } catch (err) {
    throw new Error(`VRML parse failed: ${(err as Error).message}`);
  }
}

// ===== OBJ =====

/**
 * Parse a minimal subset of the OBJ format: `v x y z`, `vn nx ny nz`,
 * `f i j k` or `f i//ni j//nj k//nk` (1-indexed, negative = relative).
 *
 * Only triangular faces are emitted. Polygons with > 3 verts are fan-
 * triangulated. `vt` (texture) coordinates are ignored.
 *
 * @throws Error on malformed input or no geometry found.
 */
export function parseOBJ(text: string): LoadedModel {
  try {
    const verts: number[] = [];
    const norms: number[] = [];
    const outPos: number[] = [];
    const outNorm: number[] = [];
    const lines = text.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      const tag = parts[0];
      if (tag === 'v') {
        if (parts.length < 4) throw new Error(`OBJ: malformed vertex line: ${line}`);
        verts.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
      } else if (tag === 'vn') {
        if (parts.length < 4) throw new Error(`OBJ: malformed normal line: ${line}`);
        norms.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
      } else if (tag === 'f') {
        if (parts.length < 4) throw new Error(`OBJ: face needs >=3 verts: ${line}`);
        const idxList: { v: number; n: number }[] = [];
        for (let i = 1; i < parts.length; i++) {
          const tok = parts[i];
          // Formats: "v", "v/vt", "v//vn", "v/vt/vn"
          const comps = tok.split('/');
          const v = parseInt(comps[0], 10);
          if (isNaN(v)) throw new Error(`OBJ: bad face vertex: ${tok}`);
          // OBJ is 1-indexed; negative = relative to current vertex count.
          const vi = v < 0 ? verts.length / 3 + v : v - 1;
          let ni = -1;
          if (comps.length === 3 && comps[2]) {
            const n = parseInt(comps[2], 10);
            ni = n < 0 ? norms.length / 3 + n : n - 1;
          }
          idxList.push({ v: vi, n: ni });
        }
        // Fan-triangulate.
        for (let i = 1; i < idxList.length - 1; i++) {
          const tri = [idxList[0], idxList[i], idxList[i + 1]];
          const triVerts: number[] = [];
          for (const t of tri) {
            const vi = t.v * 3;
            triVerts.push(verts[vi] ?? 0, verts[vi + 1] ?? 0, verts[vi + 2] ?? 0);
          }
          outPos.push(...triVerts);
          let n0: [number, number, number] | null = null;
          if (tri[0].n >= 0) {
            const n0i = tri[0].n * 3;
            n0 = [norms[n0i] ?? 0, norms[n0i + 1] ?? 0, norms[n0i + 2] ?? 0];
          }
          if (n0) {
            for (let k = 0; k < 3; k++) outNorm.push(n0[0], n0[1], n0[2]);
          } else {
            const n = triangleNormal(triVerts[0], triVerts[1], triVerts[2],
                                     triVerts[3], triVerts[4], triVerts[5],
                                     triVerts[6], triVerts[7], triVerts[8]);
            for (let k = 0; k < 3; k++) outNorm.push(n[0], n[1], n[2]);
          }
        }
      }
    }
    if (outPos.length === 0) throw new Error('OBJ: no faces emitted');
    return { positions: new Float32Array(outPos), normals: new Float32Array(outNorm) };
  } catch (err) {
    throw new Error(`OBJ parse failed: ${(err as Error).message}`);
  }
}

/**
 * Top-level dispatcher: choose a parser by file extension.
 * @param filename file name (used only for its extension)
 * @param data raw bytes (for STL binary) or text (for STL ASCII / VRML / OBJ)
 * @throws Error if the format is unsupported or parsing fails.
 */
export function parseModel(filename: string, data: ArrayBuffer | string): LoadedModel {
  const lower = filename.toLowerCase();
  try {
    if (lower.endsWith('.stl')) return parseSTL(data);
    if (lower.endsWith('.wrl') || lower.endsWith('.vrml') || lower.endsWith('.x3dv')) {
      return parseVRML(typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
    if (lower.endsWith('.obj')) {
      return parseOBJ(typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
    throw new Error(`Unsupported file extension: ${filename}`);
  } catch (err) {
    throw new Error(`parseModel(${filename}) failed: ${(err as Error).message}`);
  }
}

/**
 * Build a THREE.BufferGeometry from a LoadedModel, setting the `position`
 * and `normal` attributes. The geometry is centered on the origin; callers
 * are responsible for translating it to the footprint position.
 */
export function modelToGeometry(model: LoadedModel): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3));
  if (model.indices && model.indices.length > 0) {
    geo.setIndex(new THREE.BufferAttribute(model.indices, 1));
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
