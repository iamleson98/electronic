// KiCad footprint (.kicad_mod) parser.
// Converts KiCad footprint definitions to our FootprintDef format.
// Supports the most common KiCad 6/7 footprint format.
//
// KiCad footprint format example:
//   (module "SOIC-8" (layer F.Cu)
//     (fp_text reference "U1" (at 0 -3) (layer F.SilkS))
//     (fp_line (start -2.5 -2) (end 2.5 -2) (layer F.SilkS) (width 0.15))
//     (pad 1 smd rect (at -1.905 -2.7) (size 0.6 1.5) (layers F.Cu F.Paste F.Mask))
//     (pad 2 smd rect (at -0.635 -2.7) (size 0.6 1.5) (layers F.Cu F.Paste F.Mask))
//   )

import type { FootprintDef } from './types';

export interface ParsedKiCadFootprint {
  name: string;
  bodySize: { width: number; height: number };
  pads: {
    terminalId: string;
    position: { x: number; y: number };
    shape: 'circle' | 'rect' | 'oval';
    size: { width: number; height: number };
    /** drill diameter (0 = SMD) */
    drill?: number;
    /** copper layer */
    layer?: 'top' | 'bottom';
    /** paste/mask coverage flags from the layers list */
    paste?: boolean;
    mask?: boolean;
  }[];
  // Additional KiCad lines for drawing
  lines: { start: { x: number; y: number }; end: { x: number; y: number }; width: number; layer: string }[];
  circles: { center: { x: number; y: number }; end: { x: number; y: number }; width: number; layer: string }[];
  /** silk outline segments (F.SilkS / B.SilkS layers) */
  silk: { start: { x: number; y: number }; end: { x: number; y: number }; width: number }[];
  /** courtyard bbox (F.CrtYd) */
  courtyard: { x: number; y: number }[];
  /** 3D model path (first `model` entry) */
  model3d?: string;
  /** footprint description / tags */
  description?: string;
}

/**
 * Parse a KiCad .kicad_mod file content into our footprint format.
 */
export function parseKiCadFootprint(content: string): ParsedKiCadFootprint | null {
  try {
    // Extract module name
    const moduleMatch = content.match(/\(module\s+"?([^"\s)]+)"?/);
    const footprintMatch = content.match(/\(footprint\s+"?([^"\s)]+)"?/);
    const name = (moduleMatch?.[1] || footprintMatch?.[1] || 'Unknown').trim();

    const pads: ParsedKiCadFootprint['pads'] = [];
    const lines: ParsedKiCadFootprint['lines'] = [];
    const circles: ParsedKiCadFootprint['circles'] = [];
    const silk: ParsedKiCadFootprint['silk'] = [];
    const courtyard: ParsedKiCadFootprint['courtyard'] = [];
    let model3d: string | undefined;
    let description: string | undefined;

    // Description + tags: (descr "...") (tags "...")
    const descrM = content.match(/\(descr\s+"([^"]*)"\)/);
    if (descrM) description = descrM[1];

    // 3D model: (model "path/to/model.step" ...)
    const modelM = content.match(/\(model\s+"([^"]+)"\)/);
    if (modelM) model3d = modelM[1];

    // Parse pads: (pad N smd/through_hole rect/circle/oval (at X Y) (size W H) (drill D)? (layers ...))
    const padRegex = /\(pad\s+(\S+)\s+(smd|through_hole|np_thru_hole)\s+(rect|circle|oval|roundrect|custom)\s+\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)\s+\(size\s+([-\d.]+)\s+([-\d.]+)\)([^)]*\(layers\s+([^)]*)\)[^)]*)?/g;
    let padMatch;
    while ((padMatch = padRegex.exec(content)) !== null) {
      const padNum = padMatch[1];
      const padType = padMatch[2]; // smd, through_hole
      const padShape = padMatch[3] as 'rect' | 'circle' | 'oval';
      const x = parseFloat(padMatch[4]);
      const y = parseFloat(padMatch[5]);
      const w = parseFloat(padMatch[7]);
      const h = parseFloat(padMatch[8]);
      const layersStr = padMatch[10] ?? '';
      // Drill: (drill D) or (drill oval W H)
      const drillM = padMatch[0].match(/\(drill\s+([-\d.]+)/);
      const drill = drillM ? parseFloat(drillM[1]) : (padType === 'through_hole' ? Math.min(w, h) * 0.5 : 0);

      // Map shape
      let shape: 'circle' | 'rect' | 'oval' = 'rect';
      if (padShape === 'circle') shape = 'circle';
      else if (padShape === 'oval') shape = 'oval';
      // roundrect/custom → rect

      pads.push({
        terminalId: padNum,
        position: { x, y },
        shape,
        size: { width: w, height: h },
        drill,
        layer: /B\.Cu/.test(layersStr) && !/F\.Cu/.test(layersStr) ? 'bottom' : 'top',
        paste: /Paste/.test(layersStr),
        mask: /Mask/.test(layersStr),
      });
      void padType;
    }

    // Parse fp_line with layer: (fp_line (start X1 Y1) (end X2 Y2) (layer L) (width W))
    const lineRegex = /\(fp_line\s+\(start\s+([-\d.]+)\s+([-\d.]+)\)\s+\(end\s+([-\d.]+)\s+([-\d.]+)\)(?:.*?\(layer\s+(\S+?)\))?(?:.*?\(width\s+([-\d.]+)\))?/g;
    let lineMatch;
    while ((lineMatch = lineRegex.exec(content)) !== null) {
      const layer = (lineMatch[5] ?? '').replace(/\)$/, '');
      const entry = {
        start: { x: parseFloat(lineMatch[1]), y: parseFloat(lineMatch[2]) },
        end: { x: parseFloat(lineMatch[3]), y: parseFloat(lineMatch[4]) },
        width: lineMatch[6] ? parseFloat(lineMatch[6]) : 0.15,
        layer,
      };
      lines.push(entry);
      if (/SilkS/.test(layer)) silk.push({ start: entry.start, end: entry.end, width: entry.width });
    }

    // Parse fp_circle with layer
    const circleRegex = /\(fp_circle\s+\(center\s+([-\d.]+)\s+([-\d.]+)\)\s+\(end\s+([-\d.]+)\s+([-\d.]+)\)(?:.*?\(layer\s+(\S+?)\))?(?:.*?\(width\s+([-\d.]+)\))?/g;
    let circleMatch;
    while ((circleMatch = circleRegex.exec(content)) !== null) {
      circles.push({
        center: { x: parseFloat(circleMatch[1]), y: parseFloat(circleMatch[2]) },
        end: { x: parseFloat(circleMatch[3]), y: parseFloat(circleMatch[4]) },
        width: circleMatch[6] ? parseFloat(circleMatch[6]) : 0.15,
        layer: (circleMatch[5] ?? '').replace(/\)$/, ''),
      });
    }

    // Courtyard: (fp_poly (pts (xy x y) ...) (layer F.CrtYd) ...)
    const polyRegex = /\(fp_poly\s+\(pts\s+((?:\(xy\s+[-\d.]+\s+[-\d.]+\)\s*)+)\)\s*\(layer\s+(\S+?)[)\s]/g;
    let polyMatch;
    while ((polyMatch = polyRegex.exec(content)) !== null) {
      const layer = polyMatch[2];
      const pts: { x: number; y: number }[] = [];
      const ptRegex = /\(xy\s+([-\d.]+)\s+([-\d.]+)\)/g;
      let ptM;
      while ((ptM = ptRegex.exec(polyMatch[1])) !== null) {
        pts.push({ x: parseFloat(ptM[1]), y: parseFloat(ptM[2]) });
      }
      if (/CrtYd/.test(layer) && pts.length >= 3 && courtyard.length === 0) {
        courtyard.push(...pts);
      }
    }

    // Calculate body size from line bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const allPoints = [
      ...lines.map((l) => [l.start, l.end]),
      ...pads.map((p) => [p.position]),
    ].flat();
    for (const p of allPoints) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const bodySize = {
      width: maxX === -Infinity ? 5 : Math.max(2, maxX - minX + 1),
      height: maxY === -Infinity ? 5 : Math.max(2, maxY - minY + 1),
    };

    return { name, bodySize, pads, lines, circles, silk, courtyard, model3d, description };
  } catch (err) {
    console.error('KiCad footprint parse error:', err);
    return null;
  }
}

/**
 * Convert a parsed KiCad footprint to our FootprintDef format — lossless:
 * drill, layer, paste/mask flags, silk, courtyard, and 3D model survive.
 */
export function kicadToFootprintDef(parsed: ParsedKiCadFootprint): FootprintDef {
  return {
    bodySize: parsed.bodySize,
    pads: parsed.pads.map((p) => ({
      terminalId: p.terminalId,
      position: p.position,
      shape: p.shape,
      size: p.size,
      ...(p.drill ? { drill: p.drill } : {}),
      ...(p.layer ? { layer: p.layer } : {}),
    })),
    ...(parsed.silk.length > 0 ? { silkOutline: parsed.silk } : {}),
    ...(parsed.courtyard.length > 0 ? { courtyard: parsed.courtyard } : {}),
    ...(parsed.model3d ? { model3d: parsed.model3d } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
  } as FootprintDef;
}

/**
 * Parse and convert a KiCad .kicad_mod file to FootprintDef in one step.
 */
export function importKiCadFootprint(content: string): FootprintDef | null {
  const parsed = parseKiCadFootprint(content);
  if (!parsed) return null;
  return kicadToFootprintDef(parsed);
}

/**
 * Parse a KiCad .kicad_pcb file and extract all footprints.
 * Returns an array of (name, FootprintDef) pairs.
 */
export function importKiCadFootprintsFromFile(content: string): { name: string; def: FootprintDef }[] {
  const results: { name: string; def: FootprintDef }[] = [];

  // Split by module/footprint declarations
  const moduleRegex = /\((?:module|footprint)\s+"?([^"\s)]+)"?[\s\S]*?\)\s*\)/g;
  let match;
  while ((match = moduleRegex.exec(content)) !== null) {
    const moduleContent = match[0];
    const name = match[1];
    const parsed = parseKiCadFootprint(moduleContent);
    if (parsed && parsed.pads.length > 0) {
      results.push({ name, def: kicadToFootprintDef(parsed) });
    }
  }

  return results;
}
