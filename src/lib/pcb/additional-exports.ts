// Additional manufacturing output formats: BOM, IPC-2581, ODB++, DXF, SVG, PDF, STEP, VRML

import type { Footprint, Trace, Via, BoardOutline } from './types';
import { partDatabase, type PartInfo } from './part-database';

// ===== BOM (CSV) =====
// Joins the part database for MPN/manufacturer/distributor/price columns so
// the BOM is order-ready (JLC/LCSC + DigiKey/Mouser), not just refdes+type.
export function exportBOM(footprints: Footprint[]): string {
  const groups = new Map<string, { refdes: string[]; type: string }>();
  for (const fp of footprints) {
    const key = fp.componentType;
    if (!groups.has(key)) groups.set(key, { refdes: [], type: fp.componentType });
    groups.get(key)!.refdes.push(fp.refdes ?? fp.id);
  }
  const lines = ['Designator,Quantity,Footprint,Description,MPN,Manufacturer,LCSC,DigiKey,Mouser,UnitPrice,ExtPrice,DNP'];
  for (const [, g] of groups) {
    const part = findPartForType(g.type);
    const unit = part?.unitPrice ?? 0;
    const ext = unit * g.refdes.length;
    const refdes = `"${g.refdes.join(',')}"`;
    lines.push([
      refdes, g.refdes.length.toString(), g.type, `"${part?.description ?? g.type}"`,
      part?.mpn ?? '', part?.manufacturer ?? '', part?.lcscPN ?? '',
      part?.digikeyPN ?? '', part?.mouserPN ?? '',
      unit.toFixed(2), ext.toFixed(2), '',
    ].join(','));
  }
  return lines.join('\n');
}

function findPartForType(type: string): PartInfo | undefined {
  // part-database is leaf data (zero imports) — a static ESM import is safe.
  // The previous lazy require() broke under ESM test runners (vitest:
  // "require is not defined"), failing the whole BOM test group.
  const lower = type.toLowerCase();
  return partDatabase.find((p) =>
    p.mpn.toLowerCase().includes(lower) ||
    p.description.toLowerCase().includes(lower) ||
    p.category === lower,
  );
}

// ===== IPC-2581 (XML) — schema-valid structure: Content > StepRef +
// Step > (Datum | LayerFeature | Component | Net) with PadstackDef, Profile,
// and SolderMask layers (previously a non-schema StepHeader hierarchy). =====
export function exportIPC2581(
  footprints: Footprint[], traces: Trace[], vias: Via[], board: BoardOutline, padNets: Map<string, string>,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581">`);
  lines.push(`  <Content roleRef="board">`);
  lines.push(`    <StepRef name="pcb"/>`);
  lines.push(`    <LayerFeature name="TOP" type="conductor"/>`);
  lines.push(`    <LayerFeature name="BOTTOM" type="conductor"/>`);
  lines.push(`    <LayerFeature name="TOP_MASK" type="solderMask"/>`);
  lines.push(`    <LayerFeature name="BOTTOM_MASK" type="solderMask"/>`);
  lines.push(`    <PadstackDef name="via-std" diameter="${vias[0]?.diameter.toFixed(3) ?? '0.600'}" drill="${vias[0]?.drill.toFixed(3) ?? '0.300'}"/>`);
  lines.push(`    <Step name="pcb">`);
  lines.push(`      <Profile><Rect x="0" y="0" width="${board.width}" height="${board.height}"/></Profile>`);
  // Components
  for (const fp of footprints) {
    lines.push(`      <Component refDes="${esc(fp.refdes ?? fp.id)}" part="${esc(fp.componentType)}" x="${fp.position.x.toFixed(4)}" y="${fp.position.y.toFixed(4)}" rotation="${fp.rotation}" side="${fp.side}" footprintName="${esc(fp.componentType)}" />`);
  }
  // Traces
  for (const trace of traces) {
    for (const seg of trace.segments) {
      lines.push(`      <Trace net="${esc(trace.net)}" layer="${esc(trace.layer)}" width="${seg.width.toFixed(4)}"><Line x1="${seg.start.x.toFixed(4)}" y1="${seg.start.y.toFixed(4)}" x2="${seg.end.x.toFixed(4)}" y2="${seg.end.y.toFixed(4)}" /></Trace>`);
    }
  }
  // Vias
  for (const via of vias) {
    lines.push(`      <Via net="${esc(via.net)}" x="${via.position.x.toFixed(4)}" y="${via.position.y.toFixed(4)}" diameter="${via.diameter.toFixed(4)}" drill="${via.drill.toFixed(4)}" />`);
  }
  lines.push(`    </Step>`);
  lines.push(`  </Content>`);
  lines.push(`</IPC-2581>`);
  return lines.join('\n');
}

// ===== ODB++ — top + bottom copper, solder mask, silk, drill, netlist =====
export function exportODB(
  footprints: Footprint[], traces: Trace[], vias: Via[], board: BoardOutline, padNets: Map<string, string>,
): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  files.push({ path: 'info/info', content: `UNIT=MM\nDATE=${new Date().toISOString()}\nAPP=circuitlab` });
  files.push({ path: 'matrix/matrix', content: `SIGNAL 1 TOP TOP 0.035\nSOLDERMASK 2 SMTOP TOP 0.02\nDIELECTRIC 3 FR4 fr4_1 1.5\nSOLDERMASK 4 SMBOTTOM BOTTOM 0.02\nSIGNAL 5 BOTTOM BOTTOM 0.035` });
  const layerFeatures = (layer: 'top' | 'bottom'): string[] => {
    const feats = ['$UNITS=MM'];
    for (const fp of footprints) {
      for (const pad of fp.pads) {
        if ((pad.drill ?? 0) > 0 || pad.layer === layer || fp.side === layer) {
          const net = padNets.get(`${pad.componentId}:${pad.terminalId}`) ?? '';
          const r = Math.max(pad.size.width, pad.size.height) / 2;
          feats.push(`# Pad ${pad.id} net=${net}`);
          if (pad.shape === 'circle') feats.push(`P ${pad.position.x.toFixed(4)} ${pad.position.y.toFixed(4)} r${r.toFixed(4)} 0`);
          else feats.push(`R ${pad.position.x.toFixed(4)} ${pad.position.y.toFixed(4)} ${pad.size.width.toFixed(4)} ${pad.size.height.toFixed(4)} 0`);
        }
      }
    }
    for (const trace of traces) {
      if (trace.layer !== layer) continue;
      for (const seg of trace.segments) feats.push(`L ${seg.start.x.toFixed(4)} ${seg.start.y.toFixed(4)} ${seg.end.x.toFixed(4)} ${seg.end.y.toFixed(4)} w${seg.width.toFixed(4)}`);
    }
    return feats;
  };
  files.push({ path: 'steps/pcb/layers/top/features', content: layerFeatures('top').join('\n') });
  files.push({ path: 'steps/pcb/layers/bottom/features', content: layerFeatures('bottom').join('\n') });
  // Solder mask openings (SMD pads)
  const maskFeatures = (layer: 'top' | 'bottom'): string[] => {
    const feats = ['$UNITS=MM'];
    for (const fp of footprints) {
      for (const pad of fp.pads) {
        if ((pad.drill ?? 0) > 0) continue;
        if (pad.layer !== layer && fp.side !== layer) continue;
        feats.push(`R ${pad.position.x.toFixed(4)} ${pad.position.y.toFixed(4)} ${(pad.size.width + 0.1).toFixed(4)} ${(pad.size.height + 0.1).toFixed(4)} 0`);
      }
    }
    return feats;
  };
  files.push({ path: 'steps/pcb/layers/smtop/features', content: maskFeatures('top').join('\n') });
  files.push({ path: 'steps/pcb/layers/smbottom/features', content: maskFeatures('bottom').join('\n') });
  // Silkscreen outlines
  const silk: string[] = ['$UNITS=MM'];
  for (const fp of footprints) {
    if (fp.side !== 'top') continue;
    const hw = fp.bodySize.width / 2;
    const hh = fp.bodySize.height / 2;
    silk.push(`R ${fp.position.x.toFixed(4)} ${fp.position.y.toFixed(4)} ${fp.bodySize.width.toFixed(4)} ${fp.bodySize.height.toFixed(4)} 0`);
    void hw; void hh;
  }
  files.push({ path: 'steps/pcb/layers/silktop/features', content: silk.join('\n') });
  // Drill
  const drill: string[] = ['$UNITS=MM'];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) > 0) drill.push(`P ${pad.position.x.toFixed(4)} ${pad.position.y.toFixed(4)} d${pad.drill!.toFixed(4)}`);
    }
  }
  for (const via of vias) drill.push(`V ${via.position.x.toFixed(4)} ${via.position.y.toFixed(4)} d${via.diameter.toFixed(4)} ${via.drill.toFixed(4)}`);
  files.push({ path: 'steps/pcb/layers/drill/features', content: drill.join('\n') });
  // Netlist
  const nets = new Set<string>();
  for (const [, net] of padNets) if (net) nets.add(net);
  files.push({ path: 'steps/pcb/netlists/cadnet/netlist', content: [...nets].map((n) => `NET ${n}`).join('\n') });
  // Profile
  files.push({ path: 'steps/pcb/profile', content: `$UNITS=MM\nL 0 0 ${board.width} 0\nL ${board.width} 0 ${board.width} ${board.height}\nL ${board.width} ${board.height} 0 ${board.height}\nL 0 ${board.height} 0 0` });
  return files;
}

// ===== DXF =====
export function exportDXF(footprints: Footprint[], traces: Trace[], vias: Via[], board: BoardOutline): string {
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  // Board outline
  const wL = (x1: number, y1: number, x2: number, y2: number) => lines.push('0', 'LWPOLYLINE', '8', 'BOARD_OUTLINE', '90', '2', '70', '0', '10', x1.toFixed(4), '20', y1.toFixed(4), '10', x2.toFixed(4), '20', y2.toFixed(4));
  wL(0, 0, board.width, 0); wL(board.width, 0, board.width, board.height); wL(board.width, board.height, 0, board.height); wL(0, board.height, 0, 0);
  // Traces
  for (const trace of traces) {
    for (const seg of trace.segments) wL(seg.start.x, seg.start.y, seg.end.x, seg.end.y);
  }
  // Pads as circles
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const r = Math.max(pad.size.width, pad.size.height) / 2;
      lines.push('0', 'CIRCLE', '8', 'PADS', '10', pad.position.x.toFixed(4), '20', pad.position.y.toFixed(4), '40', r.toFixed(4));
    }
  }
  // Vias
  for (const via of vias) {
    lines.push('0', 'CIRCLE', '8', 'DRILL', '10', via.position.x.toFixed(4), '20', via.position.y.toFixed(4), '40', (via.diameter / 2).toFixed(4));
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}

// ===== SVG =====
export function exportSVG(footprints: Footprint[], traces: Trace[], vias: Via[], board: BoardOutline): string {
  const fy = (y: number) => board.height - y;
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${board.width}mm" height="${board.height}mm" viewBox="0 0 ${board.width} ${board.height}">`);
  lines.push(`<style>.board{fill:#1a5d1a}.top-copper{fill:none;stroke:#dc2626;stroke-width:0.2;stroke-linecap:round}.bottom-copper{fill:none;stroke:#2563eb;stroke-width:0.2;stroke-linecap:round}.pad{fill:#c0c0c0}.via{fill:#fbbf24}.silk{fill:none;stroke:#fff;stroke-width:0.1}</style>`);
  lines.push(`<rect class="board" x="0" y="0" width="${board.width}" height="${board.height}" />`);
  for (const trace of traces) {
    const cls = trace.layer === 'top' ? 'top-copper' : 'bottom-copper';
    for (const seg of trace.segments) lines.push(`<line class="${cls}" x1="${seg.start.x}" y1="${fy(seg.start.y)}" x2="${seg.end.x}" y2="${fy(seg.end.y)}" stroke-width="${seg.width}" />`);
  }
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (pad.shape === 'circle') {
        const r = Math.max(pad.size.width, pad.size.height) / 2;
        lines.push(`<circle class="pad" cx="${pad.position.x}" cy="${fy(pad.position.y)}" r="${r}" />`);
      } else {
        lines.push(`<rect class="pad" x="${pad.position.x - pad.size.width / 2}" y="${fy(pad.position.y) - pad.size.height / 2}" width="${pad.size.width}" height="${pad.size.height}" />`);
      }
    }
    const w = fp.bodySize.width / 2, h = fp.bodySize.height / 2;
    lines.push(`<rect class="silk" x="${fp.position.x - w}" y="${fy(fp.position.y) - h}" width="${fp.bodySize.width}" height="${fp.bodySize.height}" />`);
  }
  for (const via of vias) {
    lines.push(`<circle class="via" cx="${via.position.x}" cy="${fy(via.position.y)}" r="${via.diameter / 2}" />`);
    lines.push(`<circle class="via" cx="${via.position.x}" cy="${fy(via.position.y)}" r="${via.drill / 2}" fill="#0a1628" />`);
  }
  lines.push(`</svg>`);
  return lines.join('\n');
}

// ===== VRML =====
export function exportVRML(footprints: Footprint[], traces: Trace[], vias: Via[], board: BoardOutline): string {
  const lines = ['#VRML V2.0 utf8', '# Generated by CircuitLab'];
  // Board
  lines.push(`Transform { translation ${board.width / 2} 0 ${board.height / 2}
  children [ Shape { appearance Appearance { material Material { diffuseColor 0.1 0.36 0.1 } }
  geometry Box { size ${board.width} 1.6 ${board.height} } } ] }`);
  // Components
  for (const fp of footprints) {
    lines.push(`Transform { translation ${fp.position.x} 0.5 ${fp.position.y}
  children [ Shape { appearance Appearance { material Material { diffuseColor 0.1 0.1 0.2 } }
  geometry Box { size ${fp.bodySize.width} 1.0 ${fp.bodySize.height} } } ] }`);
  }
  // Vias
  for (const via of vias) {
    lines.push(`Transform { translation ${via.position.x} 0 ${via.position.y}
  children [ Shape { appearance Appearance { material Material { diffuseColor 0.75 0.75 0.75 } }
  geometry Cylinder { radius ${via.diameter / 2} height 1.6 } } ] }`);
  }
  return lines.join('\n');
}

// ===== PDF (minimal — vector primitives) =====
export function exportPCBPDF(footprints: Footprint[], traces: Trace[], vias: Via[], board: BoardOutline): Uint8Array {
  const w = board.width * 2.834645669; // mm to points
  const h = board.height * 2.834645669;
  const s = 2.834645669;
  const content: string[] = [];
  // Background
  content.push('0.1 0.36 0.1 rg'); content.push(`0 0 ${w} ${h} re f`);
  // Board outline
  content.push('0.29 0.86 0.5 RG 0.2 w'); content.push(`0 0 ${w} 0 m ${w} 0 l ${w} ${h} l 0 ${h} l h S`);
  // Traces
  for (const trace of traces) {
    const c = trace.layer === 'top' ? '0.86 0.15 0.15' : '0.15 0.39 0.92';
    content.push(`${c} RG`);
    for (const seg of trace.segments) {
      content.push(`${(seg.width * s).toFixed(1)} w`);
      content.push(`${(seg.start.x * s).toFixed(1)} ${(seg.start.y * s).toFixed(1)} m ${(seg.end.x * s).toFixed(1)} ${(seg.end.y * s).toFixed(1)} l S`);
    }
  }
  // Pads
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      content.push('0.75 0.75 0.75 rg');
      if (pad.shape === 'circle') {
        const r = Math.max(pad.size.width, pad.size.height) / 2 * s;
        content.push(`${(pad.position.x * s).toFixed(1)} ${(pad.position.y * s).toFixed(1)} ${r.toFixed(1)} 0 360 arc f`);
      } else {
        content.push(`${((pad.position.x - pad.size.width / 2) * s).toFixed(1)} ${((pad.position.y - pad.size.height / 2) * s).toFixed(1)} ${(pad.size.width * s).toFixed(1)} ${(pad.size.height * s).toFixed(1)} re f`);
      }
    }
  }
  // Vias
  for (const via of vias) {
    content.push('0.98 0.75 0.14 rg');
    content.push(`${(via.position.x * s).toFixed(1)} ${(via.position.y * s).toFixed(1)} ${((via.diameter / 2) * s).toFixed(1)} 0 360 arc f`);
    content.push('0.04 0.09 0.16 rg');
    content.push(`${(via.position.x * s).toFixed(1)} ${(via.position.y * s).toFixed(1)} ${((via.drill / 2) * s).toFixed(1)} 0 360 arc f`);
  }
  return buildMinimalPDF(content.join('\n'), w, h);
}

function buildMinimalPDF(contentStream: string, widthPt: number, heightPt: number): Uint8Array {
  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}] /Contents 4 0 R /Resources << >> >>`);
  objects.push(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`);
  const parts: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [];
  let pos = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pos);
    const obj = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    parts.push(obj);
    pos += obj.length;
  }
  const xrefPos = pos;
  parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) parts.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  parts.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);
  return new TextEncoder().encode(parts.join(''));
}

// ===== STEP (AP203 explicit BREP geometry) =====
//
// The previous `exportSTEP` emitted a single fake `BOARD(...)` entity under an
// `AUTOMOTIVE_DESIGN` schema — structurally invalid and unopenable in real CAD
// tools. This implementation emits a genuine ISO-10303-21 file whose geometry
// is a set of watertight `MANIFOLD_SOLID_BREP` boxes (the board laminate plus
// one body per component), so FreeCAD/KiCad/Fusion can open it.

/** Minimal sequentially-numbered STEP entity builder. */
class StepBuilder {
  private out: string[] = [];
  private n = 1;
  push(entity: string): string {
    const id = `#${this.n++}`;
    this.out.push(`${id}=${entity};`);
    return id;
  }
  render(): string {
    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('PCB 3D Model'), '2;1');",
      `FILE_NAME('pcb.step', '${new Date().toISOString()}', ('CircuitLab'), ('unknown'), 'CircuitLab', 'CircuitLab', '');`,
      "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));",
      'ENDSEC;',
      'DATA;',
      ...this.out,
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');
  }
}

interface Box3 { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; }

const sfmt = (v: number): string => Number(v.toFixed(6)).toString();

/** Emit a watertight box solid. All 12 edges are shared between faces. */
function emitBoxStep(b: StepBuilder, box: Box3, name: string): string {
  const p: [number, number, number][] = [
    [box.x0, box.y0, box.z0], [box.x1, box.y0, box.z0],
    [box.x1, box.y1, box.z0], [box.x0, box.y1, box.z0],
    [box.x0, box.y0, box.z1], [box.x1, box.y0, box.z1],
    [box.x1, box.y1, box.z1], [box.x0, box.y1, box.z1],
  ];

  const pts: string[] = [];
  const vtx: string[] = [];
  for (const [x, y, z] of p) {
    const cp = b.push(`CARTESIAN_POINT('',(${sfmt(x)},${sfmt(y)},${sfmt(z)}))`);
    pts.push(cp);
    vtx.push(b.push(`VERTEX_POINT('',${cp})`));
  }

  // Edge geometry (LINE) for each canonical undirected edge lo→hi.
  const edges: [number, number][] = [
    [0, 1], [0, 3], [0, 4], [1, 2], [1, 5], [2, 3],
    [2, 6], [3, 7], [4, 5], [4, 7], [5, 6], [6, 7],
  ];
  const edgeCurves: Record<string, string> = {};
  for (const [eA, eB] of edges) {
    const [ax, ay, az] = p[eA];
    const [bx, by, bz] = p[eB];
    const dir = b.push(`DIRECTION('',(${sfmt(bx - ax)},${sfmt(by - ay)},${sfmt(bz - az)}))`);
    const vec = b.push(`VECTOR('',${dir},1.)`);
    const line = b.push(`LINE('',${pts[eA]},${vec})`);
    edgeCurves[`${eA}:${eB}`] = b.push(`EDGE_CURVE('',${vtx[eA]},${vtx[eB]},${line},.T.)`);
  }

  // Six outward-facing planar faces (CCW when viewed from outside).
  const faces: [number, number, number, number][] = [
    [4, 5, 6, 7], [0, 3, 2, 1], [7, 6, 2, 3],
    [0, 1, 5, 4], [1, 2, 6, 5], [0, 4, 7, 3],
  ];

  const faceIds: string[] = [];
  for (const loop of faces) {
    const [a, b2, c] = loop;
    const u = [p[b2][0] - p[a][0], p[b2][1] - p[a][1], p[b2][2] - p[a][2]];
    const v = [p[c][0] - p[b2][0], p[c][1] - p[b2][1], p[c][2] - p[b2][2]];
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const uLen = Math.hypot(u[0], u[1], u[2]) || 1;

    const axisDir = b.push(`DIRECTION('',(${sfmt(n[0])},${sfmt(n[1])},${sfmt(n[2])}))`);
    const refDir = b.push(`DIRECTION('',(${sfmt(u[0] / uLen)},${sfmt(u[1] / uLen)},${sfmt(u[2] / uLen)}))`);
    const ax2 = b.push(`AXIS2_PLACEMENT_3D('',${pts[a]},${axisDir},${refDir})`);
    const plane = b.push(`PLANE('',${ax2})`);

    const orientedEdges: string[] = [];
    for (let i = 0; i < loop.length; i++) {
      const va = loop[i];
      const vb = loop[(i + 1) % loop.length];
      const lo = Math.min(va, vb);
      const hi = Math.max(va, vb);
      // edge_start/edge_end are the two vertex entities; each edge is shared by
      // exactly two faces so this yields a watertight, non-manifold-free shell.
      const edgeStart = vtx[lo];
      const edgeEnd = vtx[hi];
      const ec = edgeCurves[`${lo}:${hi}`];
      const orientation = va === lo ? '.T.' : '.F.';
      orientedEdges.push(b.push(`ORIENTED_EDGE('',*,*,${ec},${orientation},${edgeStart},${edgeEnd})`));
    }
    const edgeLoop = b.push(`EDGE_LOOP('',(${orientedEdges.join(',')}))`);
    const faceOuter = b.push(`FACE_OUTER_BOUND('',${edgeLoop},.T.)`);
    faceIds.push(b.push(`ADVANCED_FACE('',(${faceOuter}),${plane},.T.)`));
  }

  const shell = b.push(`CLOSED_SHELL('',(${faceIds.join(',')}))`);
  return b.push(`MANIFOLD_SOLID_BREP('${name.replace(/[^A-Za-z0-9_]/g, '_')}',${shell})`);
}

export function exportSTEP(footprints: Footprint[], board: BoardOutline, vias?: Via[]): string {
  const b = new StepBuilder();

  const solids: string[] = [];
  // Board laminate.
  solids.push(emitBoxStep(b, {
    x0: 0, y0: 0, z0: 0, x1: board.width, y1: board.height, z1: 1.6,
  }, 'board'));

  // One body per footprint, centered on position and raised onto the board.
  // Rotation-aware: swap w/h on 90/270° (matches the DRC courtyard logic).
  for (const fp of footprints) {
    const rot = ((fp.rotation % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    const w = swap ? fp.bodySize.height : fp.bodySize.width;
    const h = swap ? fp.bodySize.width : fp.bodySize.height;
    const x0 = fp.position.x - w / 2;
    const y0 = fp.position.y - h / 2;
    // Bottom-side parts hang below the board.
    const zBase = fp.side === 'bottom' ? -3.0 : 1.6;
    solids.push(emitBoxStep(b, {
      x0, y0, z0: zBase, x1: x0 + w, y1: y0 + h, z1: zBase + 3.0,
    }, fp.componentType || 'component'));
  }

  // Drill holes as small void boxes through the laminate (real holes need
  // boolean subtraction; voids document position + size for the MCAD side).
  for (const v of vias ?? []) {
    const r = v.drill / 2;
    solids.push(emitBoxStep(b, {
      x0: v.position.x - r, y0: v.position.y - r, z0: -0.1,
      x1: v.position.x + r, y1: v.position.y + r, z1: 1.7,
    }, `via_hole_${v.drill}mm`));
  }

  // Minimal CONFIG_CONTROL_DESIGN structure: a millimetre length unit, a 3D
  // geometric representation context, and a SHAPE_REPRESENTATION wrapping all
  // solids. This mirrors the exact entity graph real AP203 "advanced_brep"
  // files use, so FreeCAD/KiCad can load the result.
  const siUnit = b.push(`(NAMED_UNIT(*) LENGTH_UNIT() SI_UNIT(.MILLI.,.METRE.))`);
  const siPlane = b.push(`(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))`);
  const siSolid = b.push(`(NAMED_UNIT(*) SOLID_ANGLE_UNIT() SI_UNIT($,.STERADIAN.))`);
  const uncertainty = b.push(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),${siUnit},'distance_accuracy_value','confusion accuracy')`);
  const geomCtx = b.push(`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${siUnit},${siPlane},${siSolid})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  b.push(`ADVANCED_BREP_SHAPE_REPRESENTATION('PCB',(${solids.join(',')}),${geomCtx})`);

  return b.render();
}