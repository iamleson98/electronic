// Schematic plot / export — KiCad eeschema "File → Plot" parity.
// Generates PDF, SVG, and PNG from the current schematic.
// All coordinates are converted from grid units to mm using a fixed scale.

import type { CircuitComponent, CircuitDocument, Wire, ComponentPlugin, DrawingPrimitive } from './types';
import { getPlugin } from './registry';
import { terminalPos } from './endpoint-position';

const GRID_TO_MM = 2.54; // 1 grid unit = 2.54mm (0.1 inch) — KiCad default

interface BBox { minX: number; minY: number; maxX: number; maxY: number; }

function computeBBox(components: CircuitComponent[]): BBox {
  if (components.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of components) {
    const plugin = getPlugin(c.type);
    if (!plugin) continue;
    const bb = plugin.boundingBox;
    const w = bb.width, h = bb.height;
    minX = Math.min(minX, c.position.x);
    minY = Math.min(minY, c.position.y);
    maxX = Math.max(maxX, c.position.x + w);
    maxY = Math.max(maxY, c.position.y + h);
  }
  return { minX, minY, maxX, maxY };
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG export
// ─────────────────────────────────────────────────────────────────────────────

export function exportSchematicSVG(doc: CircuitDocument): string {
  const bbox = computeBBox(doc.components);
  const padGrid = 4;
  const wGrid = bbox.maxX - bbox.minX + padGrid * 2;
  const hGrid = bbox.maxY - bbox.minY + padGrid * 2;
  const wMm = wGrid * GRID_TO_MM;
  const hMm = hGrid * GRID_TO_MM;
  const offX = (padGrid - bbox.minX) * GRID_TO_MM;
  const offY = (padGrid - bbox.minY) * GRID_TO_MM;

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${wMm}mm" height="${hMm}mm" viewBox="0 0 ${wMm} ${hMm}">`);
  lines.push(`<rect width="${wMm}" height="${hMm}" fill="#fafafa"/>`);

  // grid (light)
  for (let x = 0; x <= wGrid; x++) {
    const px = offX + x * GRID_TO_MM;
    lines.push(`<line x1="${px.toFixed(2)}" y1="0" x2="${px.toFixed(2)}" y2="${hMm.toFixed(2)}" stroke="#eee" stroke-width="0.1"/>`);
  }
  for (let y = 0; y <= hGrid; y++) {
    const py = offY + y * GRID_TO_MM;
    lines.push(`<line x1="0" y1="${py.toFixed(2)}" x2="${wMm.toFixed(2)}" y2="${py.toFixed(2)}" stroke="#eee" stroke-width="0.1"/>`);
  }

  // wires
  for (const wire of doc.wires) {
    const fromComp = doc.components.find((c) => c.id === wire.from.componentId);
    const toComp = doc.components.find((c) => c.id === wire.to.componentId);
    if (!fromComp || !toComp) continue;
    const fromPlugin = getPlugin(fromComp.type);
    const toPlugin = getPlugin(toComp.type);
    if (!fromPlugin || !toPlugin) continue;
    const fromTerm = fromPlugin.terminals.find((t) => t.id === wire.from.terminalId);
    const toTerm = toPlugin.terminals.find((t) => t.id === wire.to.terminalId);
    if (!fromTerm || !toTerm) continue;
    const fromR = terminalPos(fromComp, fromTerm, fromPlugin);
    const toR = terminalPos(toComp, toTerm, toPlugin);
    const x1 = offX + fromR.x * GRID_TO_MM;
    const y1 = offY + fromR.y * GRID_TO_MM;
    const x2 = offX + toR.x * GRID_TO_MM;
    const y2 = offY + toR.y * GRID_TO_MM;
    lines.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#475569" stroke-width="0.5"/>`);
  }

  // components — we draw a bounding box and refdes since we don't have a vector renderer for the canvas2d plugin render()
  for (const comp of doc.components) {
    const plugin = getPlugin(comp.type);
    if (!plugin) continue;
    const bb = plugin.boundingBox;
    const x = offX + comp.position.x * GRID_TO_MM;
    const y = offY + comp.position.y * GRID_TO_MM;
    const w = bb.width * GRID_TO_MM;
    const h = bb.height * GRID_TO_MM;
    lines.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="rgba(255,255,255,0.5)" stroke="#94a3b8" stroke-width="0.3" stroke-dasharray="1,1"/>`);
    // refdes
    const refdes = comp.refdes ?? comp.id;
    lines.push(`<text x="${(x + w / 2).toFixed(2)}" y="${(y - 1).toFixed(2)}" font-family="ui-monospace,monospace" font-size="3" text-anchor="middle" fill="#0f172a">${escapeXML(refdes)}</text>`);
    // type name
    lines.push(`<text x="${(x + w / 2).toFixed(2)}" y="${(y + h / 2 + 1).toFixed(2)}" font-family="ui-monospace,monospace" font-size="2.5" text-anchor="middle" fill="#475569">${escapeXML(plugin.name)}</text>`);
    // terminals
    for (const t of plugin.terminals) {
      const r = terminalPos(comp, t, plugin);
      const tx = offX + r.x * GRID_TO_MM;
      const ty = offY + r.y * GRID_TO_MM;
      lines.push(`<circle cx="${tx.toFixed(2)}" cy="${ty.toFixed(2)}" r="0.7" fill="#64748b"/>`);
    }
  }

  // drawings
  if (doc.drawings) {
    for (const d of doc.drawings) {
      lines.push(drawingToSVG(d, offX, offY));
    }
  }

  lines.push(`</svg>`);
  return lines.join('\n');
}

function drawingToSVG(d: DrawingPrimitive, offX: number, offY: number): string {
  const x = (gx: number) => offX + gx * GRID_TO_MM;
  const y = (gy: number) => offY + gy * GRID_TO_MM;
  switch (d.type) {
    case 'line':
      return `<line x1="${x(d.points[0].x).toFixed(2)}" y1="${y(d.points[0].y).toFixed(2)}" x2="${x(d.points[1].x).toFixed(2)}" y2="${y(d.points[1].y).toFixed(2)}" stroke="${d.color}" stroke-width="${(d.strokeWidth * 0.4).toFixed(2)}"/>`;
    case 'polyline': {
      const pts = d.points.map((p) => `${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`).join(' ');
      return `<polyline points="${pts}" stroke="${d.color}" stroke-width="${(d.strokeWidth * 0.4).toFixed(2)}" fill="${d.fill ?? 'none'}" ${d.closed ? 'stroke-linejoin="round"' : ''}/>`;
    }
    case 'polygon': {
      const pts = d.points.map((p) => `${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`).join(' ');
      return `<polygon points="${pts}" fill="${d.fill}" stroke="${d.stroke ?? 'none'}" stroke-width="${((d.strokeWidth ?? 1) * 0.4).toFixed(2)}"/>`;
    }
    case 'arc':
      return `<path d="M ${x(d.center.x + d.radius * Math.cos(d.startAngle)).toFixed(2)} ${y(d.center.y + d.radius * Math.sin(d.startAngle)).toFixed(2)} A ${(d.radius * GRID_TO_MM).toFixed(2)} ${(d.radius * GRID_TO_MM).toFixed(2)} 0 0 1 ${x(d.center.x + d.radius * Math.cos(d.endAngle)).toFixed(2)} ${y(d.center.y + d.radius * Math.sin(d.endAngle)).toFixed(2)}" stroke="${d.color}" stroke-width="${(d.strokeWidth * 0.4).toFixed(2)}" fill="none"/>`;
    case 'circle':
      return `<circle cx="${x(d.center.x).toFixed(2)}" cy="${y(d.center.y).toFixed(2)}" r="${(d.radius * GRID_TO_MM).toFixed(2)}" stroke="${d.color}" stroke-width="${(d.strokeWidth * 0.4).toFixed(2)}" fill="${d.fill ?? 'none'}"/>`;
    case 'text':
      return `<text x="${x(d.position.x).toFixed(2)}" y="${y(d.position.y).toFixed(2)}" font-family="ui-monospace,monospace" font-size="${d.fontSize.toFixed(2)}" fill="${d.color}" transform="rotate(${d.rotation ?? 0},${x(d.position.x).toFixed(2)},${y(d.position.y).toFixed(2)})">${escapeXML(d.text)}</text>`;
    case 'image':
      return `<image x="${x(d.position.x).toFixed(2)}" y="${y(d.position.y).toFixed(2)}" width="${(d.size.width * GRID_TO_MM).toFixed(2)}" height="${(d.size.height * GRID_TO_MM).toFixed(2)}" href="${d.dataUrl}"/>`;
  }
}

function escapeXML(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG export (via SVG → canvas → PNG, browser-only)
// ─────────────────────────────────────────────────────────────────────────────

export async function exportSchematicPNG(doc: CircuitDocument, scale: number = 2): Promise<Blob> {
  if (typeof window === 'undefined') throw new Error('PNG export requires a browser');
  const svg = exportSchematicSVG(doc);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Failed to load SVG image: ' + String(e)));
    img.src = url;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF export — minimal PDF with one page showing the SVG-rendered schematic.
// Uses jsPDF-style hand-rolled PDF with embedded SVG rasterization via canvas.
// (For a proper vector PDF we'd embed PostScript-like ops, but this is good enough
//  for "plot schematic to PDF" — it's rasterized at 2x for crisp text.)
// ─────────────────────────────────────────────────────────────────────────────

export async function exportSchematicPDF(doc: CircuitDocument): Promise<Blob> {
  if (typeof window === 'undefined') throw new Error('PDF export requires a browser');

  // Render the schematic SVG to a raster at 3x scale, then encode as JPEG so
  // the image can be embedded with the /DCTDecode filter — the only image
  // filter broadly supported by PDF viewers for photographic data. (The old
  // code wrote raw base64 PNG bytes under a non-existent /Base64Decode filter,
  // producing a corrupt/blank image in every strict PDF reader.)
  const { dataUrl, pxWidth, pxHeight } = await renderSchematicToJPEG(doc, 3);
  // Strip the "data:image/jpeg;base64," prefix to get the raw base64 bytes.
  const jpegBase64 = dataUrl.split(',')[1] ?? '';

  const bbox = computeBBox(doc.components);
  const padGrid = 4;
  const wMm = (bbox.maxX - bbox.minX + padGrid * 2) * GRID_TO_MM;
  const hMm = (bbox.maxY - bbox.minY + padGrid * 2) * GRID_TO_MM;
  // convert mm to PostScript points (1mm = 2.834645pt)
  const wPt = Math.ceil(wMm * 2.834645);
  const hPt = Math.ceil(hMm * 2.834645);

  // minimal PDF — single page, embedded JPEG (DCTDecode)
  const objects: string[] = [];
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`);
  // content stream: draw image scaled to page
  const stream = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`;
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
  // image XObject — a JPEG stream with the DCTDecode (lossy) filter
  objects.push(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxWidth} /Height ${pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBase64.length} >>\nstream\n${jpegBase64}\nendstream\nendobj\n`);

  const header = `%PDF-1.4\n`;
  let body = '';
  const offsets: number[] = [0];
  let offset = header.length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    body += objects[i];
    offset += objects[i].length;
  }
  const xrefStart = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += `0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i++) {
    xref += `${String(offsets[i + 1]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  const pdf = header + body + xref + trailer;
  return new Blob([pdf], { type: 'application/pdf' });
}

/**
 * Rasterize the schematic SVG to a JPEG data URL at the given scale.
 * Returns the encoded data URL and the exact pixel dimensions so the PDF
 * image XObject is self-consistent with its stream contents.
 */
async function renderSchematicToJPEG(
  doc: CircuitDocument,
  scale: number,
): Promise<{ dataUrl: string; pxWidth: number; pxHeight: number }> {
  const svg = exportSchematicSVG(doc);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d')!;
    // White background (JPEG has no alpha channel) to match the SVG's paper.
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    return { dataUrl, pxWidth: canvas.width, pxHeight: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger a browser download of a blob
// ─────────────────────────────────────────────────────────────────────────────

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, mime: string = 'text/plain') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
