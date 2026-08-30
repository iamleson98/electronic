// Gerber (RS-274X), Excellon drill, and Pick-and-Place export.
// Generates industry-standard manufacturing files from the PCB layout.

import type { Footprint, Trace, Via, BoardOutline, Pad } from './types';

/**
 * Generate a Gerber file (RS-274X format) for a copper layer.
 * Returns the Gerber file content as a string.
 *
 * Aperture note: pads/traces/vias get EXACT-size apertures (a `%ADDxxC,D*%`
 * circle or `%ADDxxR,WxH%` rect generated per unique size). The previous
 * fixed-aperture table snapped every feature to the nearest of 9 preset
 * sizes — e.g. every 1.5×0.8mm SMD pad was exported as a 1.8×1.8mm square
 * and 0.6mm vias as 0.8mm circles, silently changing the manufactured
 * geometry.
 */
export function exportGerberCopper(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
): string {
  const lines: string[] = [];
  const fmt = (n: number) => {
    // Sign-aware X26Y26 coordinate (2 int + 6 dec digits). A naive
    // padStart would inject a zero BETWEEN the minus sign and the digits
    // for small negative coordinates (e.g. -0.5mm → "0-500000").
    const mag = (Math.abs(n) * 1e6).toFixed(0).padStart(8, '0');
    return n < 0 ? `-${mag}` : mag;
  };

  // Header
  lines.push('%FSLAX26Y26*%');  // Format: 2 integer + 6 decimal digits
  lines.push('%MOMM*%');        // Units: millimeters
  lines.push(`%LPD*%`);         // Layer polarity: dark
  lines.push(`%LN${layer.toUpperCase()}_COPPER*%`);

  // ── Dynamic aperture allocator ─────────────────────────────────────────
  // Aperture numbers 10..999 are allocated on demand per unique size so
  // every feature is drawn at its exact dimensions.
  let nextAp = 10;
  const circleAps = new Map<string, number>();
  const rectAps = new Map<string, number>();
  const apDefs: string[] = [];
  const getCircleAp = (d: number): number => {
    const key = d.toFixed(4);
    let ap = circleAps.get(key);
    if (ap === undefined) {
      ap = nextAp++;
      circleAps.set(key, ap);
      apDefs.push(`%ADD${ap}C,${d.toFixed(4)}*%`);
    }
    return ap;
  };
  const getRectAp = (w: number, h: number): number => {
    const key = `${w.toFixed(4)}x${h.toFixed(4)}`;
    let ap = rectAps.get(key);
    if (ap === undefined) {
      ap = nextAp++;
      rectAps.set(key, ap);
      apDefs.push(`%ADD${ap}R,${w.toFixed(4)}X${h.toFixed(4)}*%`);
    }
    return ap;
  };

  // Reserve the outline aperture up-front (D10) so the numbering is stable
  const outlineAp = getCircleAp(0.15);

  /** Pad layer filter: THT pads (drill > 0) exist on BOTH copper layers. */
  const padOnLayer = (pad: Pad, fp: Footprint, l: 'top' | 'bottom'): boolean =>
    (pad.drill ?? 0) > 0 || pad.layer === l || fp.side === l;

  // Pre-scan: allocate every aperture first so all definitions can be
  // emitted BEFORE any of them is selected (Gerber requires def-before-use).
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (!padOnLayer(pad, fp, layer)) continue;
      if (pad.shape === 'circle') getCircleAp(Math.max(pad.size.width, pad.size.height));
      else getRectAp(pad.size.width, pad.size.height);
    }
  }
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    getCircleAp(trace.width);
  }
  for (const via of vias) {
    getCircleAp(via.diameter);
  }

  // Emit all aperture definitions (must precede their first use)
  lines.push(...apDefs);

  // Draw board outline
  lines.push(`G54D${outlineAp}*`);
  lines.push(`X${fmt(0)}Y${fmt(0)}D02*`);
  lines.push(`X${fmt(board.width)}Y${fmt(0)}D01*`);
  lines.push(`X${fmt(board.width)}Y${fmt(board.height)}D01*`);
  lines.push(`X${fmt(0)}Y${fmt(board.height)}D01*`);
  lines.push(`X${fmt(0)}Y${fmt(0)}D01*`);

  // Draw pads
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (!padOnLayer(pad, fp, layer)) continue;
      const ap = pad.shape === 'circle'
        ? getCircleAp(Math.max(pad.size.width, pad.size.height))
        : getRectAp(pad.size.width, pad.size.height);
      lines.push(`G54D${ap}*`);
      lines.push(`X${fmt(pad.position.x)}Y${fmt(pad.position.y)}D03*`);
    }
  }

  // Draw traces — one exact-width circular aperture per unique width
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    const ap = getCircleAp(trace.width);
    lines.push(`G54D${ap}*`);
    for (const seg of trace.segments) {
      lines.push(`X${fmt(seg.start.x)}Y${fmt(seg.start.y)}D02*`);
      lines.push(`X${fmt(seg.end.x)}Y${fmt(seg.end.y)}D01*`);
    }
  }

  // Draw vias — exact outer diameter
  for (const via of vias) {
    const ap = getCircleAp(via.diameter);
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
  const fmt = (n: number) => {
    // Sign-aware X26Y26 coordinate (2 int + 6 dec digits). A naive
    // padStart would inject a zero BETWEEN the minus sign and the digits
    // for small negative coordinates (e.g. -0.5mm → "0-500000").
    const mag = (Math.abs(n) * 1e6).toFixed(0).padStart(8, '0');
    return n < 0 ? `-${mag}` : mag;
  };

  lines.push('%FSLAX26Y26*%');
  lines.push('%MOMM*%');
  lines.push('%LPC*%');  // Clear polarity (solder mask is negative)
  lines.push(`%LN${layer.toUpperCase()}_SOLDERMASK*%`);

  // Open solder mask openings at each pad (slightly larger than pad).
  // THT pads need openings on BOTH mask layers (the hole spans the board);
  // SMD pads only on their own side.
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) <= 0 && pad.layer !== layer && fp.side !== layer) continue;
      const r = Math.max(pad.size.width, pad.size.height) / 2 + 0.1; // 0.1mm expansion
      // Aperture numbers: 10 + round(diameter in 0.01mm units). Max diameter
      // is bounded by the board size, so 10..~10010 — well within Gerber's
      // 3-digit D-code range for any realistic pad. (The old formula could
      // collide with the D50 outline aperture.)
      const apNum = 10 + Math.round(r * 2 * 100);
      lines.push(`%ADD${apNum}C,${(r * 2).toFixed(3)}*%`);
      lines.push(`G54D${apNum}*`);
      lines.push(`X${fmt(pad.position.x)}Y${fmt(pad.position.y)}D03*`);
    }
  }

  // Board outline as mask area
  lines.push('%ADD900C,0.150*%');
  lines.push('G54D900*');
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
  const fmt = (n: number) => {
    // Sign-aware X26Y26 coordinate (2 int + 6 dec digits). A naive
    // padStart would inject a zero BETWEEN the minus sign and the digits
    // for small negative coordinates (e.g. -0.5mm → "0-500000").
    const mag = (Math.abs(n) * 1e6).toFixed(0).padStart(8, '0');
    return n < 0 ? `-${mag}` : mag;
  };

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

  // THT pads — any pad with drill > 0 needs a hole (rect/oval THT pads
  // included; previously only circle pads were drilled). Pads without a
  // drill field fall back to the historical ~60%-of-pad estimate.
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const hasDrill = pad.drill != null && pad.drill > 0;
      if (!hasDrill && pad.shape !== 'circle') continue;
      const drillSize = hasDrill
        ? pad.drill!
        : Math.min(pad.size.width, pad.size.height) * 0.6; // estimated ~60% of pad
      if (drillSize <= 0) continue;
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

// ─────────────────────────────────────────────────────────────────────────────
// Gerber X2 (RS-274X revision 2) export.
//
// Gerber X2 adds:
//   - Standardized metadata via %TF.* % attributes (file function, generation software, etc.)
//   - Aperture attributes (%TA.* %) for pad/trace roles (conductor, via, component)
//   - Object attributes (%TO.* %) for component reference designator, MPN, etc.
//   - Net attributes (%TN.* %) for trace net name
//
// X2 is what modern fabricators (JLC, PCBWay, etc.) actually want — it eliminates
// the need to interpret layer filenames.
// ─────────────────────────────────────────────────────────────────────────────

export function exportGerberX2Copper(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
): string {
  const lines: string[] = [];
  const fmt = (n: number) => {
    // Sign-aware X26Y26 coordinate (2 int + 6 dec digits). A naive
    // padStart would inject a zero BETWEEN the minus sign and the digits
    // for small negative coordinates (e.g. -0.5mm → "0-500000").
    const mag = (Math.abs(n) * 1e6).toFixed(0).padStart(8, '0');
    return n < 0 ? `-${mag}` : mag;
  };

  // X2 file attributes
  lines.push('%TF.GenerationSoftware,CircuitLab,v1.0*%');
  lines.push(`%TF.CreationDate,${new Date().toISOString()}*%`);
  lines.push(`%TF.ProjectId,CircuitLab-PCB,rev1,*%`);
  lines.push(`%TF.FileFunction,Copper,${layer === 'top' ? 'L1' : 'L2'}*%`);
  lines.push('%TF.FilePolarity,Positive*%');
  lines.push('%TF.SameCoordinates*%');
  lines.push('%MOMM*%');
  lines.push('%FSLAX26Y26*%');
  lines.push('%LPD*%');

  // Aperture attributes
  lines.push('%TA.AperFunction,Conductor*%');
  lines.push('%TA.AperFunction,ViaPad*%');
  lines.push('%TA.AperFunction,ComponentPad*%');

  // ── Dynamic exact-size aperture allocator (see exportGerberCopper) ──────
  let nextAp = 10;
  const circleAps = new Map<string, number>();
  const rectAps = new Map<string, number>();
  const apDefs: string[] = [];
  const getCircleAp = (d: number): number => {
    const key = d.toFixed(4);
    let ap = circleAps.get(key);
    if (ap === undefined) {
      ap = nextAp++;
      circleAps.set(key, ap);
      apDefs.push(`%ADD${ap}C,${d.toFixed(4)}*%`);
    }
    return ap;
  };
  const getRectAp = (w: number, h: number): number => {
    const key = `${w.toFixed(4)}x${h.toFixed(4)}`;
    let ap = rectAps.get(key);
    if (ap === undefined) {
      ap = nextAp++;
      rectAps.set(key, ap);
      apDefs.push(`%ADD${ap}R,${w.toFixed(4)}X${h.toFixed(4)}*%`);
    }
    return ap;
  };
  const outlineAp = getCircleAp(0.15);

  // Pre-scan: allocate all apertures before emitting definitions (def-before-use)
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) <= 0 && pad.layer !== layer && fp.side !== layer) continue;
      if (pad.shape === 'circle') getCircleAp(Math.max(pad.size.width, pad.size.height));
      else getRectAp(pad.size.width, pad.size.height);
    }
  }
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    getCircleAp(trace.width);
  }
  for (const via of vias) {
    getCircleAp(via.diameter);
  }
  lines.push(...apDefs);

  // Board outline
  lines.push('%TO.N,*%'); // no net for outline
  lines.push(`G54D${outlineAp}*`);
  lines.push(`X${fmt(0)}Y${fmt(0)}D02*`);
  lines.push(`X${fmt(board.width)}Y${fmt(0)}D01*`);
  lines.push(`X${fmt(board.width)}Y${fmt(board.height)}D01*`);
  lines.push(`X${fmt(0)}Y${fmt(board.height)}D01*`);
  lines.push(`X${fmt(0)}Y${fmt(0)}D01*`);

  // Pads — with component attributes
  for (const fp of footprints) {
    // Component object open
    lines.push(`%TO.C,${fp.refdes}*%`);
    lines.push(`%TO.P,${fp.refdes},${fp.componentType}*%`);
    for (const pad of fp.pads) {
      // THT pads (drill > 0) appear on both copper layers
      if ((pad.drill ?? 0) <= 0 && pad.layer !== layer && fp.side !== layer) continue;
      // Net attribute
      lines.push(`%TO.N,${pad.net ?? 'unconnected'}*%`);
      const ap = pad.shape === 'circle'
        ? getCircleAp(Math.max(pad.size.width, pad.size.height))
        : getRectAp(pad.size.width, pad.size.height);
      lines.push(`G54D${ap}*`);
      lines.push(`X${fmt(pad.position.x)}Y${fmt(pad.position.y)}D03*`);
    }
    lines.push('%TD*%'); // close component attributes
  }

  // Traces — with net attributes
  for (const trace of traces) {
    if (trace.layer !== layer) continue;
    lines.push(`%TO.N,${trace.net}*%`);
    const ap = getCircleAp(trace.width);
    lines.push(`G54D${ap}*`);
    for (const seg of trace.segments) {
      lines.push(`X${fmt(seg.start.x)}Y${fmt(seg.start.y)}D02*`);
      lines.push(`X${fmt(seg.end.x)}Y${fmt(seg.end.y)}D01*`);
    }
  }

  // Vias — with via function attribute
  lines.push('%TA.AperFunction,ViaPad*%');
  for (const via of vias) {
    lines.push(`%TO.N,${via.net}*%`);
    const ap = getCircleAp(via.diameter);
    lines.push(`G54D${ap}*`);
    lines.push(`X${fmt(via.position.x)}Y${fmt(via.position.y)}D03*`);
  }
  lines.push('%TD*%');

  lines.push('M02*');

  return lines.join('\n');
}

/**
 * Export all Gerber X2 files (copper top + bottom + masks + silk + drill).
 */
export function exportAllGerbersX2(
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
): { filename: string; content: string }[] {
  const files: { filename: string; content: string }[] = [];
  files.push({ filename: 'top_copper.gbr', content: exportGerberX2Copper('top', footprints, traces, vias, board) });
  files.push({ filename: 'bottom_copper.gbr', content: exportGerberX2Copper('bottom', footprints, traces, vias, board) });
  files.push({ filename: 'top_soldermask.gbr', content: exportGerberSolderMask('top', footprints, board) });
  files.push({ filename: 'bottom_soldermask.gbr', content: exportGerberSolderMask('bottom', footprints, board) });
  files.push({ filename: 'top_silkscreen.gbr', content: exportGerberSilkscreen('top', footprints, board) });
  files.push({ filename: 'bottom_silkscreen.gbr', content: exportGerberSilkscreen('bottom', footprints, board) });
  files.push({ filename: 'drill.drl', content: exportExcellonDrill(footprints, vias) });
  files.push({ filename: 'pick_and_place.csv', content: exportPickAndPlace(footprints) });
  return files;
}
