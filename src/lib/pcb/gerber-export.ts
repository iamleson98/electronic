// Gerber (RS-274X), Excellon drill, and Pick-and-Place export.
// Generates industry-standard manufacturing files from the PCB layout.

import type { Footprint, Trace, Via, BoardOutline, Pad } from './types';

/**
 * Generate a Gerber file (RS-274X format) for a copper layer.
 * Returns the Gerber file content as a string.
 */
export function exportGerberCopper(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
): string {
  const lines: string[] = [];
  const fmt = (n: number) => (n * 1e6).toFixed(0).padStart(7, '0');

  // Header
  lines.push('%FSLAX26Y26*%');  // Format: 2.6 leading, 2.6 trailing
  lines.push('%MOMM*%');        // Units: millimeters
  lines.push(`%LPD*%`);         // Layer polarity: dark
  lines.push(`%LN${layer.toUpperCase()}_COPPER*%`);

  // Apertures
  let apNum = 10;
  const apertures: string[] = [];

  // Standard apertures
  apertures.push(`%ADD10C,0.200*%`);  // 0.2mm circle (thin)
  apertures.push(`%ADD11C,0.300*%`);  // 0.3mm circle
  apertures.push(`%ADD12C,0.500*%`);  // 0.5mm circle
  apertures.push(`%ADD13C,0.800*%`);  // 0.8mm circle
  apertures.push(`%ADD14C,1.000*%`);  // 1.0mm circle
  apertures.push(`%ADD15C,1.800*%`);  // 1.8mm circle (THT pad)
  apertures.push(`%ADD16R,1.500X0.800*%`); // 1.5x0.8mm rect (SMD pad)
  apertures.push(`%ADD17R,1.000X1.000*%`); // 1x1mm rect (small SMD)
  apertures.push(`%ADD18R,1.800X1.800*%`); // 1.8x1.8mm rect (THT)

  // Board outline aperture
  apertures.push(`%ADD20C,0.150*%`);  // outline line width

  lines.push(...apertures);

  // Begin region
  lines.push('G54D10*');  // Select default aperture

  // Draw board outline
  lines.push('G54D20*');
  lines.push(`X${fmt(0)}Y${fmt(0)}D02*`);
  lines.push(`X${fmt(board.width)}Y${fmt(0)}D01*`);
  lines.push(`X${fmt(board.width)}Y${fmt(board.height)}D01*`);
  lines.push(`X${fmt(0)}Y${fmt(board.height)}D01*`);
  lines.push(`X${fmt(0)}Y${fmt(0)}D01*`);

  // Draw pads
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (pad.layer !== layer && fp.side !== layer) continue;
      const size = Math.max(pad.size.width, pad.size.height);
      let ap = 10;
      if (pad.shape === 'circle') {
        if (size >= 1.7) ap = 15;
        else if (size >= 0.9) ap = 14;
        else if (size >= 0.7) ap = 13;
        else if (size >= 0.4) ap = 12;
        else ap = 11;
      } else {
        if (size >= 1.5) ap = 18;
        else if (size >= 1.0) ap = 17;
        else ap = 16;
      }
      lines.push(`G54D${ap}*`);
      lines.push(`X${fmt(pad.position.x)}Y${fmt(pad.position.y)}D03*`);
    }
  }

  // Draw traces as flashes with line draws
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    // Find closest aperture for trace width
    const w = trace.width;
    let ap = 11;
    if (w >= 0.7) ap = 13;
    else if (w >= 0.4) ap = 12;
    else ap = 11;
    lines.push(`G54D${ap}*`);
    for (const seg of trace.segments) {
      lines.push(`X${fmt(seg.start.x)}Y${fmt(seg.start.y)}D02*`);
      lines.push(`X${fmt(seg.end.x)}Y${fmt(seg.end.y)}D01*`);
    }
  }

  // Draw vias
  for (const via of vias) {
    const ap = via.diameter >= 0.9 ? 14 : 13;
    lines.push(`G54D${ap}*`);
    lines.push(`X${fmt(via.position.x)}Y${fmt(via.position.y)}D03*`);
  }

  // End
  lines.push('M02*');

  return lines.join('\n');
}

/**
 * Generate a Gerber solder mask file.
 */
export function exportGerberSolderMask(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  board: BoardOutline,
): string {
  const lines: string[] = [];
  const fmt = (n: number) => (n * 1e6).toFixed(0).padStart(7, '0');

  lines.push('%FSLAX26Y26*%');
  lines.push('%MOMM*%');
  lines.push('%LPC*%');  // Clear polarity (solder mask is negative)
  lines.push(`%LN${layer.toUpperCase()}_SOLDERMASK*%`);
  lines.push('%ADD10C,0.200*%');

  // Open solder mask openings at each pad (slightly larger than pad)
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (pad.layer !== layer && fp.side !== layer) continue;
      const r = Math.max(pad.size.width, pad.size.height) / 2 + 0.1; // 0.1mm expansion
      const apNum = 20 + Math.floor(r * 100);
      lines.push(`%ADD${apNum}C,${(r * 2).toFixed(3)}*%`);
      lines.push(`G54D${apNum}*`);
      lines.push(`X${fmt(pad.position.x)}Y${fmt(pad.position.y)}D03*`);
    }
  }

  // Board outline as mask area
  lines.push('%ADD50C,0.150*%');
  lines.push('G54D50*');
  lines.push(`X${fmt(0)}Y${fmt(0)}D02*`);
  lines.push(`X${fmt(board.width)}Y${fmt(0)}D01*`);
  lines.push(`X${fmt(board.width)}Y${fmt(board.height)}D01*`);
  lines.push(`X${fmt(0)}Y${fmt(board.height)}D01*`);
  lines.push(`X${fmt(0)}Y${fmt(0)}D01*`);

  lines.push('M02*');
  return lines.join('\n');
}

/**
 * Generate a Gerber silkscreen file (component outlines + refdes).
 */
export function exportGerberSilkscreen(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  board: BoardOutline,
): string {
  const lines: string[] = [];
  const fmt = (n: number) => (n * 1e6).toFixed(0).padStart(7, '0');

  lines.push('%FSLAX26Y26*%');
  lines.push('%MOMM*%');
  lines.push(`%LPD*%`);
  lines.push(`%LN${layer.toUpperCase()}_SILKSCREEN*%`);
  lines.push('%ADD10C,0.150*%');  // silkscreen line width
  lines.push('G54D10*');

  // Draw footprint outlines
  for (const fp of footprints) {
    if (fp.side !== layer) continue;
    const w = fp.bodySize.width / 2;
    const h = fp.bodySize.height / 2;
    const cx = fp.position.x;
    const cy = fp.position.y;
    // Simplified: draw bounding box (rotation 0 only for export)
    lines.push(`X${fmt(cx - w)}Y${fmt(cy - h)}D02*`);
    lines.push(`X${fmt(cx + w)}Y${fmt(cy - h)}D01*`);
    lines.push(`X${fmt(cx + w)}Y${fmt(cy + h)}D01*`);
    lines.push(`X${fmt(cx - w)}Y${fmt(cy + h)}D01*`);
    lines.push(`X${fmt(cx - w)}Y${fmt(cy - h)}D01*`);
  }

  lines.push('M02*');
  return lines.join('\n');
}

/**
 * Generate an Excellon drill file for all through-hole pads and vias.
 */
export function exportExcellonDrill(
  footprints: Footprint[],
  vias: Via[],
): string {
  const lines: string[] = [];

  // Header
  lines.push('M48');              // Start of header
  lines.push(';FORMAT={-:-/ absolute / metric / decimal}');
  lines.push('FMAT,2');
  lines.push('METRIC,TZ');        // Metric, trailing zeros

  // Collect unique drill sizes
  const drillSizes = new Map<number, { size: number; count: number }>();
  const drillEntries: { x: number; y: number; size: number }[] = [];

  // THT pads
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (pad.shape !== 'circle') continue; // only THT (circular) pads need drills
      const drillSize = Math.min(pad.size.width, pad.size.height) * 0.6; // drill is ~60% of pad
      drillEntries.push({ x: pad.position.x, y: pad.position.y, size: drillSize });
      const key = Math.round(drillSize * 100);
      if (!drillSizes.has(key)) drillSizes.set(key, { size: drillSize, count: 0 });
      drillSizes.get(key)!.count++;
    }
  }

  // Vias
  for (const via of vias) {
    drillEntries.push({ x: via.position.x, y: via.position.y, size: via.drill });
    const key = Math.round(via.drill * 100);
    if (!drillSizes.has(key)) drillSizes.set(key, { size: via.drill, count: 0 });
    drillSizes.get(key)!.count++;
  }

  // Define tools
  let toolNum = 1;
  const sizeToTool = new Map<number, number>();
  for (const [key, info] of drillSizes) {
    lines.push(`T${toolNum}C${info.size.toFixed(3)}`);
    sizeToTool.set(key, toolNum);
    toolNum++;
  }
  lines.push('%');  // End of header

  // Drill hits
  const fmt = (n: number) => n.toFixed(3);
  for (const entry of drillEntries) {
    const key = Math.round(entry.size * 100);
    const tool = sizeToTool.get(key) ?? 1;
    lines.push(`T${tool}`);
    lines.push(`X${fmt(entry.x)}Y${fmt(entry.y)}`);
  }

  lines.push('M30');  // End of program
  return lines.join('\n');
}

/**
 * Generate a Pick-and-Place file (CSV format) for SMD assembly.
 */
export function exportPickAndPlace(
  footprints: Footprint[],
): string {
  const lines: string[] = [];
  lines.push('Designator,Footprint,PosX,PosY,Rotation,Side,Comment');

  for (const fp of footprints) {
    lines.push([
      fp.refdes,
      fp.componentType,
      fp.position.x.toFixed(3),
      fp.position.y.toFixed(3),
      fp.rotation.toString(),
      fp.side,
      fp.componentType,
    ].join(','));
  }

  return lines.join('\n');
}

/**
 * Generate all manufacturing files as a set of downloadable strings.
 */
export function exportAllGerbers(
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
): { filename: string; content: string }[] {
  const files: { filename: string; content: string }[] = [];

  // Copper layers
  files.push({ filename: 'top_copper.gbr', content: exportGerberCopper('top', footprints, traces, vias, board) });
  files.push({ filename: 'bottom_copper.gbr', content: exportGerberCopper('bottom', footprints, traces, vias, board) });

  // Solder masks
  files.push({ filename: 'top_soldermask.gbr', content: exportGerberSolderMask('top', footprints, board) });
  files.push({ filename: 'bottom_soldermask.gbr', content: exportGerberSolderMask('bottom', footprints, board) });

  // Silkscreen
  files.push({ filename: 'top_silkscreen.gbr', content: exportGerberSilkscreen('top', footprints, board) });
  files.push({ filename: 'bottom_silkscreen.gbr', content: exportGerberSilkscreen('bottom', footprints, board) });

  // Drill file
  files.push({ filename: 'drill.drl', content: exportExcellonDrill(footprints, vias) });

  // Pick and place
  files.push({ filename: 'pick_and_place.csv', content: exportPickAndPlace(footprints) });

  return files;
}
