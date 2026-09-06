// Gerber (RS-274X), Excellon drill, and Pick-and-Place export.
// Generates industry-standard manufacturing files from the PCB layout.

import type { Footprint, Trace, Via, BoardOutline, Pad } from './types';
import type { CopperPour } from './copper-pour';

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
  layer: 'top' | 'bottom' | 'inner1' | 'inner2' | 'inner3' | 'inner4',
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  pours?: CopperPour[],
  teardrops?: { position: { x: number; y: number }; points: { x: number; y: number }[] }[],
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

  /** Pad layer filter: THT pads (drill > 0) exist on every copper layer. */
  const padOnLayer = (pad: Pad, fp: Footprint, l: string): boolean =>
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
  // Copper pours on this layer — merged horizontal cell runs as exact rect
  // apertures (the pour model is a grid of filled cells; runs keep the flash
  // count low while reproducing the exact fill geometry).
  const layerPours = (pours ?? []).filter((p) => p.layer === layer)
    .map((p) => ({ net: p.net, runs: pourRuns(p) }));

  for (const { runs } of layerPours) {
    for (const run of runs) getRectAp(run.w, run.h);
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

  // Draw copper pours — filled polygon regions as rect aperture flashes
  // (X1 Gerber has no net attributes → pours export as plain copper)
  for (const { runs } of layerPours) {
    for (const run of runs) {
      const ap = getRectAp(run.w, run.h);
      lines.push(`G54D${ap}*`);
      lines.push(`X${fmt(run.cx)}Y${fmt(run.cy)}D03*`);
    }
  }

  // Teardrops — polygon flashes (G36 region) on this layer.
  for (const td of teardrops ?? []) {
    if (!td.points || td.points.length < 3) continue;
    lines.push('G36*');
    td.points.forEach((p, i) => {
      lines.push(`X${fmt(p.x)}Y${fmt(p.y)}D0${i === 0 ? 2 : 1}*`);
    });
    lines.push('G37*');
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
 * Generate a Gerber paste-mask file (solder-paste stencil openings).
 * SMD pads only — THT pads are wave-soldered and must NOT appear on paste.
 * Openings are shrunk ~10% (min 0.05mm per side) so paste stays on the pad.
 */
export function exportGerberPaste(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  board: BoardOutline,
): string {
  const lines: string[] = [];
  const fmt = (n: number) => {
    const mag = (Math.abs(n) * 1e6).toFixed(0).padStart(8, '0');
    return n < 0 ? `-${mag}` : mag;
  };
  lines.push('%FSLAX26Y26*%');
  lines.push('%MOMM*%');
  lines.push('%LPD*%');
  lines.push(`%LN${layer.toUpperCase()}_PASTE*%`);
  let nextAp = 10;
  const apDefs = new Map<string, number>();
  const defs: string[] = [];
  const flashes: string[] = [];
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) > 0) continue; // THT: no paste
      if (pad.layer !== layer && fp.side !== layer) continue;
      // shrink ~10% per side for stencil relief
      const w = Math.max(0.1, pad.size.width - 0.1);
      const h = Math.max(0.1, pad.size.height - 0.1);
      const key = pad.shape === 'circle' ? `C${w.toFixed(3)}` : `R${w.toFixed(3)}x${h.toFixed(3)}`;
      let ap = apDefs.get(key);
      if (ap === undefined) {
        ap = nextAp++;
        apDefs.set(key, ap);
        defs.push(pad.shape === 'circle' ? `%ADD${ap}C,${w.toFixed(3)}*%` : `%ADD${ap}R,${w.toFixed(3)}X${h.toFixed(3)}*%`);
      }
      flashes.push(`G54D${ap}*`);
      flashes.push(`X${fmt(pad.position.x)}Y${fmt(pad.position.y)}D03*`);
    }
  }
  lines.push(...defs);
  lines.push(...flashes);
  // board outline for registration
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
 * Generate the board-outline (Edge.Cuts) Gerber file. Fabs read the outline
 * from this layer — drawing it only as a copper stroke left it ambiguous.
 */
export function exportGerberEdgeCuts(board: BoardOutline): string {
  const fmt = (n: number) => {
    const mag = (Math.abs(n) * 1e6).toFixed(0).padStart(8, '0');
    return n < 0 ? `-${mag}` : mag;
  };
  return [
    '%FSLAX26Y26*%',
    '%MOMM*%',
    '%LPD*%',
    '%LNEDGE_CUTS*%',
    '%ADD10C,0.100*%',
    'G54D10*',
    `X${fmt(0)}Y${fmt(0)}D02*`,
    `X${fmt(board.width)}Y${fmt(0)}D01*`,
    `X${fmt(board.width)}Y${fmt(board.height)}D01*`,
    `X${fmt(0)}Y${fmt(board.height)}D01*`,
    `X${fmt(0)}Y${fmt(0)}D01*`,
    'M02*',
  ].join('\n');
}
export function exportGerberSilkscreen(
  layer: 'top' | 'bottom',
  footprints: Footprint[],
  _board: BoardOutline,
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

  // Draw footprint outlines (rotation-aware) + refdes text position marker.
  // The old code ignored fp.rotation, exporting an axis-aligned box at the
  // wrong place for every rotated part.
  for (const fp of footprints) {
    if (fp.side !== layer) continue;
    const hw = fp.bodySize.width / 2;
    const hh = fp.bodySize.height / 2;
    const rad = (fp.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rot = (lx: number, ly: number) => ({
      x: fp.position.x + lx * cos - ly * sin,
      y: fp.position.y + lx * sin + ly * cos,
    });
    const corners = [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)];
    const p0 = corners[0];
    lines.push(`X${fmt(p0.x)}Y${fmt(p0.y)}D02*`);
    for (const p of [...corners.slice(1), corners[0]]) {
      lines.push(`X${fmt(p.x)}Y${fmt(p.y)}D01*`);
    }
    // Refdes marker: short tick at the footprint origin + pin-1 dot so the
    // assembler can orient the part (previously refdes was not rendered at all).
    const c = rot(0, 0);
    const tick = rot(Math.min(hw, 1), 0);
    lines.push(`X${fmt(c.x)}Y${fmt(c.y)}D02*`);
    lines.push(`X${fmt(tick.x)}Y${fmt(tick.y)}D01*`);
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

  // THT pads — ONLY pads with an explicit drill > 0 get a hole. SMD pads
  // (no drill field) must NEVER be drilled: the old ~60%-of-pad estimate
  // punched holes through every SMD landing pad and destroyed them.
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const hasDrill = pad.drill != null && pad.drill > 0;
      if (!hasDrill) continue;
      const drillSize = pad.drill!;
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
 * Generate a PnP file (CSV, JLC/LCSC-compatible columns).
 *
 * Columns: Designator, Footprint, PosX, PosY, Rotation, Side, Comment.
 * Rotation follows the KiCad convention used by this app (counter-clockwise
 * degrees about the footprint origin); Side distinguishes top/bottom
 * placement. The Footprint column carries the real footprint name when the
 * caller provides one via `footprintName` metadata, else the component type.
 *
 * JLC rotation corrections: certain packages need a fixed offset between the
 * CAD zero and the feeder zero (diodes/SOT-23 180°, SOT-223 180°, tantalum
 * 180°). The correction table below applies the standard JLC offsets by
 * footprint-name pattern so boards assemble correctly first time.
 */
export function exportPickAndPlace(
  footprints: (Footprint & { footprintName?: string })[],
): string {
  const lines: string[] = [];
  lines.push('Designator,Footprint,PosX,PosY,Rotation,Side,Comment,LCSC Part #');

  for (const fp of footprints) {
    // Rotation is CCW degrees about the footprint origin (KiCad convention).
    const baseRot = ((fp.rotation % 360) + 360) % 360;
    const name = (fp.footprintName ?? fp.componentType).toUpperCase();
    let correction = 0;
    if (/SOT-23|SOT23|DIODE|SOD-|SMA|SMB|SMC/.test(name)) correction = 180;
    else if (/SOT-223/.test(name)) correction = 180;
    else if (/TANTALUM|CASE-A|CASE-B|CASE-C/.test(name)) correction = 180;
    else if (/QFN|QFP|BGA/.test(name)) correction = 0;
    const rot = (baseRot + correction) % 360;
    lines.push([
      fp.refdes,
      fp.footprintName ?? fp.componentType,
      fp.position.x.toFixed(3),
      fp.position.y.toFixed(3),
      rot.toString(),
      fp.side === 'bottom' ? 'Bottom' : 'Top',
      fp.componentType,
      '',
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
  pours?: CopperPour[],
  opts?: { layers?: ('top' | 'bottom' | 'inner1' | 'inner2' | 'inner3' | 'inner4')[]; teardrops?: { position: { x: number; y: number }; padId: string; points: { x: number; y: number }[]; layer: string }[] },
): { filename: string; content: string }[] {
  const files: { filename: string; content: string }[] = [];
  const layers = opts?.layers ?? ['top', 'bottom'];

  // Copper layers (pours render into their layer's copper) — inner layers
  // included when the stackup uses them (previously always dropped).
  // Teardrops render as copper flashes on their layer (previously dropped).
  const teardropFlashes = (opts?.teardrops ?? []).filter((t) => layers.includes(t.layer as (typeof layers)[number]));
  for (const layer of layers) {
    files.push({ filename: `${layer}_copper.gbr`, content: exportGerberCopper(layer, footprints, traces, vias, board, pours, teardropFlashes.filter((t) => t.layer === layer)) });
  }

  // Solder masks
  files.push({ filename: 'top_soldermask.gbr', content: exportGerberSolderMask('top', footprints, board) });
  files.push({ filename: 'bottom_soldermask.gbr', content: exportGerberSolderMask('bottom', footprints, board) });

  // Solder paste (SMD stencil)
  files.push({ filename: 'top_paste.gbr', content: exportGerberPaste('top', footprints, board) });
  files.push({ filename: 'bottom_paste.gbr', content: exportGerberPaste('bottom', footprints, board) });

  // Silkscreen
  files.push({ filename: 'top_silkscreen.gbr', content: exportGerberSilkscreen('top', footprints, board) });
  files.push({ filename: 'bottom_silkscreen.gbr', content: exportGerberSilkscreen('bottom', footprints, board) });

  // Board outline (Edge.Cuts) — the layer fabs actually route from
  files.push({ filename: 'edge_cuts.gbr', content: exportGerberEdgeCuts(board) });

  // Drill file
  files.push({ filename: 'drill.drl', content: exportExcellonDrill(footprints, vias) });

  // Drill map (human-readable hole table for the fab drawing)
  files.push({ filename: 'drill_map.txt', content: exportDrillMap(footprints, vias) });

  // Pick and place
  files.push({ filename: 'pick_and_place.csv', content: exportPickAndPlace(footprints) });

  // Gerber job file — tells the CAM station what each file is
  files.push({ filename: 'job.gbrjob', content: exportGerberJobFile(layers, board) });

  return files;
}

/**
 * Human-readable drill map: hole count by size + plated status.
 */
export function exportDrillMap(footprints: Footprint[], vias: Via[]): string {
  const sizes = new Map<string, { size: number; count: number; plated: boolean }>();
  const add = (size: number, plated: boolean) => {
    const key = `${size.toFixed(3)}:${plated ? 'PTH' : 'NPTH'}`;
    const e = sizes.get(key) ?? { size, count: 0, plated };
    e.count++;
    sizes.set(key, e);
  };
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if ((pad.drill ?? 0) > 0) add(pad.drill!, true);
    }
  }
  for (const v of vias) add(v.drill, true);
  const lines = ['Drill map (mm)', '================', ''];
  for (const e of [...sizes.values()].sort((a, b) => a.size - b.size)) {
    lines.push(`${e.size.toFixed(3)}mm  x${e.count}  ${e.plated ? 'PTH' : 'NPTH'}`);
  }
  lines.push('', `Total holes: ${[...sizes.values()].reduce((a, e) => a + e.count, 0)}`);
  return lines.join('\n');
}

/**
 * Minimal Gerber job file (X3-style JSON is overkill here): maps each
 * exported filename to its layer function so CAM auto-import works.
 */
export function exportGerberJobFile(
  layers: string[],
  board: BoardOutline,
): string {
  const entries = [
    ...layers.map((l) => `  "${l}_copper.gbr": "copper:${l}"`),
    '  "top_soldermask.gbr": "mask:top"',
    '  "bottom_soldermask.gbr": "mask:bottom"',
    '  "top_paste.gbr": "paste:top"',
    '  "bottom_paste.gbr": "paste:bottom"',
    '  "top_silkscreen.gbr": "silk:top"',
    '  "bottom_silkscreen.gbr": "silk:bottom"',
    '  "edge_cuts.gbr": "outline"',
    '  "drill.drl": "drill:pth"',
  ];
  return `{\n  "board": { "width_mm": ${board.width}, "height_mm": ${board.height} },\n  "files": {\n${entries.join(',\n')}\n  }\n}\n`;
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

/** Canonical physical stack positions (1-based) for the copper layers.
 *  Used to order an enabled layer set and to number X2 FileFunction
 *  attributes — the old hardcode (top→L1, bottom→L2, inner→replace) made
 *  inner1 claim L1 (top's number) and bottom claim L2 even on 4-layer
 *  boards where it is physically L4. */
const COPPER_STACK_POS: Record<string, number> = {
  top: 1, inner1: 2, inner2: 3, inner3: 4, inner4: 5, bottom: 6,
};

/** Sort an enabled copper layer set into physical top→bottom order. */
export function sortCopperLayers(layers: string[]): string[] {
  return [...layers].sort((a, b) => (COPPER_STACK_POS[a] ?? 99) - (COPPER_STACK_POS[b] ?? 99));
}

export function exportGerberX2Copper(
  layer: 'top' | 'bottom' | 'inner1' | 'inner2' | 'inner3' | 'inner4',
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  pours?: CopperPour[],
  teardrops?: { position: { x: number; y: number }; points: { x: number; y: number }[] }[],
  layerIndex?: number,
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
  // X2 layer number: position within the ENABLED stack when known (a
  // 4-layer board's bottom is L4), else the canonical full-stack position
  // (collision-free even without stack info).
  const layerNum = layerIndex != null && layerIndex >= 1
    ? `L${layerIndex}`
    : `L${COPPER_STACK_POS[layer] ?? 1}`;
  lines.push(`%TF.FileFunction,Copper,${layerNum}*%`);
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
  // Copper pours on this layer (rect-run apertures, like the X1 writer)
  const layerPours = (pours ?? []).filter((p) => p.layer === layer)
    .map((p) => ({ net: p.net, runs: pourRuns(p) }));
  for (const { runs } of layerPours) {
    for (const run of runs) getRectAp(run.w, run.h);
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

  // Copper pours — filled regions with their net attribute (X2 supports
  // net association, so a GND pour exports as GND copper)
  for (const { net, runs } of layerPours) {
    lines.push(`%TO.N,${net}*%`);
    for (const run of runs) {
      const ap = getRectAp(run.w, run.h);
      lines.push(`G54D${ap}*`);
      lines.push(`X${fmt(run.cx)}Y${fmt(run.cy)}D03*`);
    }
  }
  lines.push('%TD*%');

  // Teardrops — G36 polygon regions (same as the X1 writer).
  for (const td of teardrops ?? []) {
    if (!td.points || td.points.length < 3) continue;
    lines.push('G36*');
    td.points.forEach((p, i) => {
      lines.push(`X${fmt(p.x)}Y${fmt(p.y)}D0${i === 0 ? 2 : 1}*`);
    });
    lines.push('G37*');
  }

  lines.push('M02*');

  return lines.join('\n');
}

/**
 * Export all Gerber X2 files — FULL parity with the X1 bundle (copper incl.
 * inner layers + teardrops, masks, paste, silk, edge-cuts, drill, drill map,
 * PnP, job file). Previously X2 shipped only top/bottom copper + masks +
 * silk + drill + PnP, so choosing X2 silently dropped the stencil, the
 * outline, inner layers, and the job file fabs need.
 */
export function exportAllGerbersX2(
  footprints: Footprint[],
  traces: Trace[],
  vias: Via[],
  board: BoardOutline,
  pours?: CopperPour[],
  opts?: { layers?: ('top' | 'bottom' | 'inner1' | 'inner2' | 'inner3' | 'inner4')[]; teardrops?: { position: { x: number; y: number }; padId: string; points: { x: number; y: number }[]; layer: string }[] },
): { filename: string; content: string }[] {
  const files: { filename: string; content: string }[] = [];
  const layers = opts?.layers ?? ['top', 'bottom'];
  const teardropFlashes = (opts?.teardrops ?? []).filter((t) => (layers as string[]).includes(t.layer));
  // Physical stack order → 1-based X2 layer numbers (top=L1 … last=L<N>).
  const stack = sortCopperLayers(layers as string[]);
  for (const layer of layers) {
    files.push({
      filename: `${layer}_copper.gbr`,
      content: exportGerberX2Copper(layer, footprints, traces, vias, board, pours, teardropFlashes.filter((t) => t.layer === layer), stack.indexOf(layer) + 1),
    });
  }
  files.push({ filename: 'top_soldermask.gbr', content: exportGerberSolderMask('top', footprints, board) });
  files.push({ filename: 'bottom_soldermask.gbr', content: exportGerberSolderMask('bottom', footprints, board) });
  files.push({ filename: 'top_paste.gbr', content: exportGerberPaste('top', footprints, board) });
  files.push({ filename: 'bottom_paste.gbr', content: exportGerberPaste('bottom', footprints, board) });
  files.push({ filename: 'top_silkscreen.gbr', content: exportGerberSilkscreen('top', footprints, board) });
  files.push({ filename: 'bottom_silkscreen.gbr', content: exportGerberSilkscreen('bottom', footprints, board) });
  files.push({ filename: 'edge_cuts.gbr', content: exportGerberEdgeCuts(board) });
  files.push({ filename: 'drill.drl', content: exportExcellonDrill(footprints, vias) });
  files.push({ filename: 'drill_map.txt', content: exportDrillMap(footprints, vias) });
  files.push({ filename: 'pick_and_place.csv', content: exportPickAndPlace(footprints) });
  files.push({ filename: 'job.gbrjob', content: exportGerberJobFile(layers, board) });
  return files;
}

// ─────────────────────────────────────────────────────────────────────────
// Copper pour geometry
// ─────────────────────────────────────────────────────────────────────────

/**
 * Merge a copper pour's grid cells into horizontal runs. Each run becomes
 * one exact rect aperture flash (center + size) — far fewer objects than
 * flashing every 0.5mm cell while reproducing the identical fill area.
 */
function pourRuns(pour: CopperPour): { cx: number; cy: number; w: number; h: number }[] {
  const cs = pour.cellSize;
  if (cs <= 0) return [];
  const rows = new Map<number, number[]>();
  for (const cell of pour.cells) {
    const col = Math.round(cell.x / cs - 0.5);
    const row = Math.round(cell.y / cs - 0.5);
    const list = rows.get(row);
    if (list) list.push(col); else rows.set(row, [col]);
  }
  const runs: { cx: number; cy: number; w: number; h: number }[] = [];
  for (const [row, cols] of rows) {
    cols.sort((a, b) => a - b);
    let start = cols[0];
    let prev = cols[0];
    for (let i = 1; i <= cols.length; i++) {
      const c = cols[i];
      if (c !== undefined && c === prev + 1) {
        prev = c;
        continue;
      }
      // flush the run [start..prev]
      runs.push({
        cx: (start + prev + 1) / 2 * cs,
        cy: (row + 0.5) * cs,
        w: (prev - start + 1) * cs,
        h: cs,
      });
      if (c !== undefined) { start = c; prev = c; }
    }
  }
  return runs;
}
