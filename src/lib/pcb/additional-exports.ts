// Additional manufacturing output formats: BOM, IPC-2581, ODB++, DXF, SVG, PDF, STEP, VRML

import type { Footprint, Trace, Via, BoardOutline } from './types';

// ===== BOM (CSV) =====
export function exportBOM(footprints: Footprint[]): string {
  const groups = new Map<string, { refdes: string[]; type: string }>();
  for (const fp of footprints) {
    const key = fp.componentType;
    if (!groups.has(key)) groups.set(key, { refdes: [], type: fp.componentType });
    groups.get(key)!.refdes.push(fp.refdes ?? fp.id);
  }
  const lines = ['Designator,Quantity,Footprint,Description'];
  for (const [, g] of groups) {
    const refdes = `"${g.refdes.join(',')}"`;
    lines.push([refdes, g.refdes.length.toString(), g.type, g.type].join(','));
  }
  return lines.join('\n');
}

// ===== IPC-2581 (XML) =====
export function exportIPC2581(
  footprints: Footprint[], traces: Trace[], vias: Via[], board: BoardOutline, padNets: Map<string, string>,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581">`);
  lines.push(`  <Content roleRef="board">`);
  lines.push(`    <Step><StepHeader name="pcb" type="panel" x="${board.width}" y="${board.height}">`);
  // Components
  for (const fp of footprints) {
    lines.push(`      <Component refDes="${esc(fp.refdes ?? fp.id)}" type="${fp.componentType}" x="${fp.position.x.toFixed(4)}" y="${fp.position.y.toFixed(4)}" rotation="${fp.rotation}" side="${fp.side}" footprintName="${fp.componentType}" />`);
  }
  // Traces
  for (const trace of traces) {
    for (const seg of trace.segments) {
      lines.push(`      <Trace net="${esc(trace.net)}" width="${seg.width.toFixed(4)}"><Line x1="${seg.start.x.toFixed(4)}" y1="${seg.start.y.toFixed(4)}" x2="${seg.end.x.toFixed(4)}" y2="${seg.end.y.toFixed(4)}" /></Trace>`);
    }
  }
  // Vias
  for (const via of vias) {
    lines.push(`      <Via net="${esc(via.net)}" x="${via.position.x.toFixed(4)}" y="${via.position.y.toFixed(4)}" diameter="${via.diameter.toFixed(4)}" drill="${via.drill.toFixed(4)}" />`);
  }
  lines.push(`    </StepHeader></Step>`);
  lines.push(`  </Content>`);
  lines.push(`</IPC-2581>`);
  return lines.join('\n');
}

// ===== ODB++ (simplified — flat file list) =====
export function exportODB(
  footprints: Footprint[], traces: Trace[], vias: Via[], board: BoardOutline, padNets: Map<string, string>,
): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  files.push({ path: 'info/info', content: `UNIT=MM\nDATE=${new Date().toISOString()}\nAPP=circuitlab` });
  files.push({ path: 'matrix/matrix', content: `SIGNAL 1 TOP TOP 0.035\nDIELECTRIC 2 FR4 fr4_1 1.5\nSIGNAL 3 BOTTOM BOTTOM 0.035` });
  // Top copper features
  const topFeatures = ['$UNITS=MM'];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const net = padNets.get(`${pad.componentId}:${pad.terminalId}`) ?? '';
      const r = Math.max(pad.size.width, pad.size.height) / 2;
      topFeatures.push(`# Pad ${pad.id} net=${net}`);
      if (pad.shape === 'circle') topFeatures.push(`P ${pad.position.x.toFixed(4)} ${pad.position.y.toFixed(4)} r${r.toFixed(4)} 0`);
      else topFeatures.push(`R ${pad.position.x.toFixed(4)} ${pad.position.y.toFixed(4)} ${pad.size.width.toFixed(4)} ${pad.size.height.toFixed(4)} 0`);
    }
  }
  for (const trace of traces) {
    if (trace.layer !== 'top') continue;
    for (const seg of trace.segments) topFeatures.push(`L ${seg.start.x.toFixed(4)} ${seg.start.y.toFixed(4)} ${seg.end.x.toFixed(4)} ${seg.end.y.toFixed(4)} w${seg.width.toFixed(4)}`);
  }
  for (const via of vias) topFeatures.push(`V ${via.position.x.toFixed(4)} ${via.position.y.toFixed(4)} d${via.diameter.toFixed(4)} ${via.drill.toFixed(4)}`);
  files.push({ path: 'steps/pcb/layers/top/features', content: topFeatures.join('\n') });
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

// ===== STEP (basic placeholder) =====
export function exportSTEP(footprints: Footprint[], board: BoardOutline): string {
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('PCB 3D Model'), '2;1');\nFILE_NAME('pcb.step', '${new Date().toISOString()}', ('circuitlab'), ('unknown'), 'circuitlab', 'circuitlab', 'unknown');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n#1 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'automotive_design', 2000, #2);\n#2 = APPLICATION_CONTEXT('automotive design');\n#100 = BOARD('${board.width}', '${board.height}', '1.6');\nENDSEC;\nEND-ISO-10303-21;`;
}
