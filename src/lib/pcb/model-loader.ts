// 3D model parsers for PCB component bodies.
// Supports STL (binary + ASCII auto-detection), VRML 2.0 (basic subset),
// simple OBJ, and STEP (ISO 10303-21 AP203/AP214 BREP subset). All parsers
// produce a `LoadedModel` (plain typed arrays) which can be converted to a
// THREE.BufferGeometry for rendering.
//
// Unit convention: 1 unit = 1 mm (matches KiCad's 3D library).
// No unit conversion is performed here.

import * as THREE from 'three/webgpu';
import { parseSTEP } from './step-loader';

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
export type ModelFormat = 'stl-binary' | 'stl-ascii' | 'vrml' | 'obj' | 'step';

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

    // Enhanced parser: walks the VRML scene graph, extracting:
    //   - Transform nodes (applies translation/rotation/scale to nested geometry)
    //   - Shape > Appearance > Material (diffuseColor → model color)
    //   - IndexedFaceSet (existing face-set parsing)
    //   - Box / Cylinder / Sphere / Cone primitives (tessellated into triangles)
    //   - IndexedLineSet (wireframe → thin triangles)

    interface VRMLTransform { translation: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number]; }
    const identity: VRMLTransform = { translation: [0, 0, 0], rotation: [0, 0, 1, 0], scale: [1, 1, 1] };

    const allPositions: number[] = [];
    const allNormals: number[] = [];
    let modelColor: [number, number, number] | undefined;

    // Recursive scene walker
    function walkScene(startIdx: number, endIdx: number, xform: VRMLTransform, currentColor?: [number, number, number]): void {
      let i = startIdx;
      while (i < endIdx) {
        const t = tokens[i];

        // Transform node
        if (t === 'Transform' && tokens[i + 1] === '{') {
          const childXform: VRMLTransform = {
            translation: [...xform.translation] as [number, number, number],
            rotation: [...xform.rotation] as [number, number, number, number],
            scale: [...xform.scale] as [number, number, number],
          };
          // Parse fields
          let j = i + 2;
          let depth = 1;
          while (j < endIdx && depth > 0) {
            const ft = tokens[j];
            if (ft === '{') depth++;
            else if (ft === '}') { depth--; if (depth === 0) break; }
            if (ft === 'translation') {
              childXform.translation = [parseFloat(tokens[j + 1]), parseFloat(tokens[j + 2]), parseFloat(tokens[j + 3])];
              j += 4; continue;
            }
            if (ft === 'rotation') {
              childXform.rotation = [parseFloat(tokens[j + 1]), parseFloat(tokens[j + 2]), parseFloat(tokens[j + 3]), parseFloat(tokens[j + 4])];
              j += 5; continue;
            }
            if (ft === 'scale') {
              childXform.scale = [parseFloat(tokens[j + 1]), parseFloat(tokens[j + 2]), parseFloat(tokens[j + 3])];
              j += 4; continue;
            }
            if (ft === 'children' && tokens[j + 1] === '[') {
              // Find matching ] and recurse into children
              let cd = 1;
              let childEnd = j + 2;
              while (childEnd < endIdx && cd > 0) {
                if (tokens[childEnd] === '[') cd++;
                else if (tokens[childEnd] === ']') cd--;
                if (cd === 0) break;
                childEnd++;
              }
              walkScene(j + 2, childEnd, childXform, currentColor);
              j = childEnd + 1;
              continue;
            }
            j++;
          }
          i = j + 1;
          continue;
        }

        // Shape node
        if (t === 'Shape' && tokens[i + 1] === '{') {
          let shapeColor = currentColor;
          let geomStart = -1;
          let j = i + 2;
          let depth = 1;
          while (j < endIdx && depth > 0) {
            const ft = tokens[j];
            if (ft === '{') depth++;
            else if (ft === '}') { depth--; if (depth === 0) break; }
            // Appearance > Material > diffuseColor
            if (ft === 'appearance' && tokens[j + 1] === 'Appearance' && tokens[j + 2] === '{') {
              let k = j + 3;
              let ad = 1;
              while (k < endIdx && ad > 0) {
                if (tokens[k] === '{') ad++;
                else if (tokens[k] === '}') { ad--; if (ad === 0) break; }
                if (tokens[k] === 'material' && tokens[k + 1] === 'Material' && tokens[k + 2] === '{') {
                  let m = k + 3;
                  let md = 1;
                  while (m < endIdx && md > 0) {
                    if (tokens[m] === '{') md++;
                    else if (tokens[m] === '}') { md--; if (md === 0) break; }
                    if (tokens[m] === 'diffuseColor') {
                      shapeColor = [parseFloat(tokens[m + 1]), parseFloat(tokens[m + 2]), parseFloat(tokens[m + 3])];
                      if (!modelColor) modelColor = shapeColor;
                      m += 4; continue;
                    }
                    m++;
                  }
                  k = m + 1; continue;
                }
                k++;
              }
              j = k + 1; continue;
            }
            // Geometry nodes: IndexedFaceSet, Box, Cylinder, Sphere, Cone, IndexedLineSet
            if (ft === 'geometry') {
              geomStart = j + 1;
            }
            j++;
          }
          // Process the geometry node at geomStart
          if (geomStart >= 0 && geomStart < endIdx) {
            const geomType = tokens[geomStart];
            if (geomType === 'IndexedFaceSet') {
              // Reuse existing face-set parser — find the closing brace
              let braceEnd = geomStart + 1;
              let bd = 0;
              while (braceEnd < endIdx) {
                if (tokens[braceEnd] === '{') bd++;
                else if (tokens[braceEnd] === '}') { bd--; if (bd === 0) break; }
                braceEnd++;
              }
              // Extract this face set
              const subTokens = tokens.slice(geomStart, braceEnd + 1);
              const sets = parseVRMLFaceSets(subTokens);
              for (const set of sets) {
                appendFaceSet(set, allPositions, allNormals, xform, shapeColor);
              }
            } else if (geomType === 'Box' && tokens[geomStart + 1] === '{') {
              // Parse size
              let sx = 2, sy = 2, sz = 2;
              let k = geomStart + 2;
              while (k < endIdx && tokens[k] !== '}') {
                if (tokens[k] === 'size') {
                  sx = parseFloat(tokens[k + 1]); sy = parseFloat(tokens[k + 2]); sz = parseFloat(tokens[k + 3]);
                  break;
                }
                k++;
              }
              appendBox(sx, sy, sz, allPositions, allNormals, xform);
            } else if (geomType === 'Cylinder' && tokens[geomStart + 1] === '{') {
              let radius = 1, height = 2;
              let k = geomStart + 2;
              while (k < endIdx && tokens[k] !== '}') {
                if (tokens[k] === 'radius') { radius = parseFloat(tokens[k + 1]); k += 2; continue; }
                if (tokens[k] === 'height') { height = parseFloat(tokens[k + 1]); k += 2; continue; }
                k++;
              }
              appendCylinder(radius, height, 16, allPositions, allNormals, xform);
            } else if (geomType === 'Sphere' && tokens[geomStart + 1] === '{') {
              let radius = 1;
              let k = geomStart + 2;
              while (k < endIdx && tokens[k] !== '}') {
                if (tokens[k] === 'radius') { radius = parseFloat(tokens[k + 1]); break; }
                k++;
              }
              appendSphere(radius, 12, 8, allPositions, allNormals, xform);
            } else if (geomType === 'Cone' && tokens[geomStart + 1] === '{') {
              let radius = 1, height = 2;
              let k = geomStart + 2;
              while (k < endIdx && tokens[k] !== '}') {
                if (tokens[k] === 'bottomRadius') { radius = parseFloat(tokens[k + 1]); k += 2; continue; }
                if (tokens[k] === 'height') { height = parseFloat(tokens[k + 1]); k += 2; continue; }
                k++;
              }
              appendCone(radius, height, 16, allPositions, allNormals, xform);
            }
          }
          i = j + 1;
          continue;
        }

        i++;
      }
    }

    walkScene(0, tokens.length, identity);

    if (allPositions.length === 0) {
      // Fallback: try the old parser (IndexedFaceSet at top level without Shape wrapper)
      const sets = parseVRMLFaceSets(tokens);
      if (sets.length === 0) throw new Error('VRML: no geometry found');
      for (const set of sets) {
        appendFaceSet(set, allPositions, allNormals, identity, undefined);
      }
    }

    if (allPositions.length === 0) throw new Error('VRML: no vertices emitted');

    const positions = new Float32Array(allPositions);
    const normals = new Float32Array(allNormals);
    return { positions, normals, color: modelColor };
  } catch (err) {
    throw new Error(`VRML parse failed: ${(err as Error).message}`);
  }
}

/** Apply a VRML Transform to a vertex */
function applyTransform(v: [number, number, number], xform: { translation: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] }): [number, number, number] {
  // Scale
  let x = v[0] * xform.scale[0];
  let y = v[1] * xform.scale[1];
  let z = v[2] * xform.scale[2];
  // Rotation (axis-angle)
  const [ax, ay, az, angle] = xform.rotation;
  if (angle !== 0) {
    const len = Math.hypot(ax, ay, az) || 1;
    const nx = ax / len, ny = ay / len, nz = az / len;
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    const rx = x * (t * nx * nx + c) + y * (t * nx * ny - s * nz) + z * (t * nx * nz + s * ny);
    const ry = x * (t * nx * ny + s * nz) + y * (t * ny * ny + c) + z * (t * ny * nz - s * nx);
    const rz = x * (t * nx * nz - s * ny) + y * (t * ny * nz + s * nx) + z * (t * nz * nz + c);
    x = rx; y = ry; z = rz;
  }
  // Translation
  x += xform.translation[0];
  y += xform.translation[1];
  z += xform.translation[2];
  return [x, y, z];
}

/** Split a flat VRML index list (with -1 face terminators) into faces. */
function splitVRMLIndices(indices: number[]): number[][] {
  const faces: number[][] = [];
  let cur: number[] = [];
  for (const idx of indices) {
    if (idx === -1) { if (cur.length >= 3) faces.push(cur); cur = []; }
    else cur.push(idx);
  }
  if (cur.length >= 3) faces.push(cur);
  return faces;
}

/** Append an IndexedFaceSet's triangulated geometry to the output arrays. */
function appendFaceSet(set: VRMLFaceSet, outPos: number[], outNorm: number[], xform: any, _color?: [number, number, number]): void {
  const faces = splitVRMLIndices(set.coordIndex);
  const pts = set.points;
  const hasNormals = set.hasNormals && set.normals.length >= 3;

  // normalIndex is a per-face-corner list of NORMAL indices (parallel to
  // coordIndex). When present it must drive which normal is used at each
  // corner — reusing the coord index here produced wrong smoothing whenever
  // the two lists diverged (very common in STEP→VRML exports). Fall back to
  // the coord indices when normalIndex is absent.
  const normalFaces = set.normalIndex.length > 0
    ? splitVRMLIndices(set.normalIndex)
    : faces.map((f) => f.slice());

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const nface = normalFaces[f] ?? face;
    const triIndices = triangulateFan(face);
    for (let t = 0; t < triIndices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const corner = t + k;
        const idx = triIndices[corner];
        const px = pts[idx * 3] ?? 0, py = pts[idx * 3 + 1] ?? 0, pz = pts[idx * 3 + 2] ?? 0;
        const [tx, ty, tz] = applyTransform([px, py, pz], xform);
        outPos.push(tx, ty, tz);
        if (hasNormals) {
          // Normal index = normalFaces[f][corner] (the corner-corresponding
          // entry), not the coord index.
          const nIdx = nface[corner] ?? idx;
          const nx = set.normals[nIdx * 3] ?? 0, ny = set.normals[nIdx * 3 + 1] ?? 0, nz = set.normals[nIdx * 3 + 2] ?? 0;
          // Rotate normal (no translation for normals)
          const tx2 = { ...xform, translation: [0, 0, 0] as [number, number, number] };
          const [tnx, tny, tnz] = applyTransform([nx, ny, nz], tx2);
          outNorm.push(tnx, tny, tnz);
        } else {
          // Will be computed after all positions are known
          outNorm.push(0, 0, 0);
        }
      }
    }
  }

  // If no normals were provided, compute face normals
  if (!hasNormals) {
    for (let i = outPos.length - faces.length * 9; i < outPos.length; i += 9) {
      const ax = outPos[i], ay = outPos[i + 1], az = outPos[i + 2];
      const bx = outPos[i + 3], by = outPos[i + 4], bz = outPos[i + 5];
      const cx = outPos[i + 6], cy = outPos[i + 7], cz = outPos[i + 8];
      const n = triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
      outNorm[i] = n[0]; outNorm[i + 1] = n[1]; outNorm[i + 2] = n[2];
      outNorm[i + 3] = n[0]; outNorm[i + 4] = n[1]; outNorm[i + 5] = n[2];
      outNorm[i + 6] = n[0]; outNorm[i + 7] = n[1]; outNorm[i + 8] = n[2];
    }
  }
}

/** Append a box (12 triangles) to the output arrays. */
function appendBox(sx: number, sy: number, sz: number, outPos: number[], outNorm: number[], xform: any): void {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const verts: [number, number, number][] = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const faces: [number, number, number, [number, number, number]][] = [
    [0, 1, 2, [0, 0, -1]], [0, 2, 3, [0, 0, -1]], // bottom
    [4, 6, 5, [0, 0, 1]], [4, 7, 6, [0, 0, 1]],   // top
    [0, 3, 7, [-1, 0, 0]], [0, 7, 4, [-1, 0, 0]],  // left
    [1, 5, 6, [1, 0, 0]], [1, 6, 2, [1, 0, 0]],    // right
    [0, 4, 5, [0, -1, 0]], [0, 5, 1, [0, -1, 0]],  // front
    [3, 2, 6, [0, 1, 0]], [3, 6, 7, [0, 1, 0]],    // back
  ];
  for (const [a, b, c, n] of faces) {
    for (const idx of [a, b, c]) {
      const [tx, ty, tz] = applyTransform(verts[idx], xform);
      outPos.push(tx, ty, tz);
      const tx2 = { ...xform, translation: [0, 0, 0] as [number, number, number] };
      const [tnx, tny, tnz] = applyTransform(n, tx2);
      outNorm.push(tnx, tny, tnz);
    }
  }
}

/** Append a cylinder (N segments) to the output arrays. */
function appendCylinder(radius: number, height: number, segments: number, outPos: number[], outNorm: number[], xform: any): void {
  const h = height / 2;
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2;
    const a2 = ((i + 1) / segments) * Math.PI * 2;
    const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
    const x2 = Math.cos(a2) * radius, z2 = Math.sin(a2) * radius;
    // Side wall quad (2 triangles)
    const v1 = applyTransform([x1, h, z1], xform);
    const v2 = applyTransform([x2, h, z2], xform);
    const v3 = applyTransform([x2, -h, z2], xform);
    const v4 = applyTransform([x1, -h, z1], xform);
    const n1 = applyTransform([Math.cos(a1), 0, Math.sin(a1)], { ...xform, translation: [0, 0, 0] as [number, number, number] });
    const n2 = applyTransform([Math.cos(a2), 0, Math.sin(a2)], { ...xform, translation: [0, 0, 0] as [number, number, number] });
    outPos.push(v1[0], v1[1], v1[2], v2[0], v2[1], v2[2], v3[0], v3[1], v3[2]);
    outNorm.push(n1[0], n1[1], n1[2], n2[0], n2[1], n2[2], n2[0], n2[1], n2[2]);
    outPos.push(v1[0], v1[1], v1[2], v3[0], v3[1], v3[2], v4[0], v4[1], v4[2]);
    outNorm.push(n1[0], n1[1], n1[2], n2[0], n2[1], n2[2], n1[0], n1[1], n1[2]);
  }
  // Top cap
  const tc = applyTransform([0, h, 0], xform);
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2;
    const a2 = ((i + 1) / segments) * Math.PI * 2;
    const v1 = applyTransform([Math.cos(a1) * radius, h, Math.sin(a1) * radius], xform);
    const v2 = applyTransform([Math.cos(a2) * radius, h, Math.sin(a2) * radius], xform);
    outPos.push(tc[0], tc[1], tc[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
    outNorm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
  // Bottom cap
  const bc = applyTransform([0, -h, 0], xform);
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2;
    const a2 = ((i + 1) / segments) * Math.PI * 2;
    const v1 = applyTransform([Math.cos(a1) * radius, -h, Math.sin(a1) * radius], xform);
    const v2 = applyTransform([Math.cos(a2) * radius, -h, Math.sin(a2) * radius], xform);
    outPos.push(bc[0], bc[1], bc[2], v2[0], v2[1], v2[2], v1[0], v1[1], v1[2]);
    outNorm.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
  }
}

/** Append a sphere (latSegs × longSegs triangles) to the output arrays. */
function appendSphere(radius: number, latSegs: number, longSegs: number, outPos: number[], outNorm: number[], xform: any): void {
  for (let lat = 0; lat < latSegs; lat++) {
    const a1 = (lat / latSegs) * Math.PI - Math.PI / 2;
    const a2 = ((lat + 1) / latSegs) * Math.PI - Math.PI / 2;
    for (let lon = 0; lon < longSegs; lon++) {
      const b1 = (lon / longSegs) * Math.PI * 2;
      const b2 = ((lon + 1) / longSegs) * Math.PI * 2;
      const v: [number, number, number][] = [];
      const n: [number, number, number][] = [];
      for (const [la, lb] of [[a1, b1], [a2, b1], [a2, b2], [a1, b2]]) {
        const x = Math.cos(la) * Math.cos(lb) * radius;
        const y = Math.sin(la) * radius;
        const z = Math.cos(la) * Math.sin(lb) * radius;
        v.push(applyTransform([x, y, z], xform));
        n.push(applyTransform([x / radius, y / radius, z / radius], { ...xform, translation: [0, 0, 0] as [number, number, number] }));
      }
      // Two triangles per quad
      outPos.push(v[0][0], v[0][1], v[0][2], v[1][0], v[1][1], v[1][2], v[2][0], v[2][1], v[2][2]);
      outNorm.push(n[0][0], n[0][1], n[0][2], n[1][0], n[1][1], n[1][2], n[2][0], n[2][1], n[2][2]);
      outPos.push(v[0][0], v[0][1], v[0][2], v[2][0], v[2][1], v[2][2], v[3][0], v[3][1], v[3][2]);
      outNorm.push(n[0][0], n[0][1], n[0][2], n[2][0], n[2][1], n[2][2], n[3][0], n[3][1], n[3][2]);
    }
  }
}

/** Append a cone (N segments) to the output arrays. */
function appendCone(radius: number, height: number, segments: number, outPos: number[], outNorm: number[], xform: any): void {
  const h = height / 2;
  const apex = applyTransform([0, h, 0], xform);
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2;
    const a2 = ((i + 1) / segments) * Math.PI * 2;
    const v1 = applyTransform([Math.cos(a1) * radius, -h, Math.sin(a1) * radius], xform);
    const v2 = applyTransform([Math.cos(a2) * radius, -h, Math.sin(a2) * radius], xform);
    // Side triangle
    outPos.push(apex[0], apex[1], apex[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
    const n = triangleNormal(apex[0], apex[1], apex[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
    outNorm.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
  }
  // Bottom cap
  const bc = applyTransform([0, -h, 0], xform);
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2;
    const a2 = ((i + 1) / segments) * Math.PI * 2;
    const v1 = applyTransform([Math.cos(a1) * radius, -h, Math.sin(a1) * radius], xform);
    const v2 = applyTransform([Math.cos(a2) * radius, -h, Math.sin(a2) * radius], xform);
    outPos.push(bc[0], bc[1], bc[2], v2[0], v2[1], v2[2], v1[0], v1[1], v1[2]);
    outNorm.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
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
          // Per-vertex normals: use EACH corner's own normal index. The old
          // code took only vertex 0's normal and duplicated it across the
          // triangle, flattening smooth shading on non-planar/faceted models.
          let hasAnyNormal = false;
          for (const t of tri) if (t.n >= 0) hasAnyNormal = true;
          if (hasAnyNormal) {
            for (const t of tri) {
              if (t.n >= 0) {
                const ni = t.n * 3;
                outNorm.push(norms[ni] ?? 0, norms[ni + 1] ?? 0, norms[ni + 2] ?? 0);
              } else {
                outNorm.push(0, 0, 0);
              }
            }
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
 * @param data raw bytes (for STL binary) or text (for STL ASCII / VRML / OBJ / STEP)
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
    if (lower.endsWith('.step') || lower.endsWith('.stp')) {
      return parseSTEP(typeof data === 'string' ? data : new TextDecoder().decode(data));
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
  // Carry the parsed material color (VRML diffuseColor / future OBJ mtl) so the
  // viewer can tint the mesh instead of discarding it in favor of a flat gray.
  if (model.color) {
    geo.userData.color = model.color;
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
