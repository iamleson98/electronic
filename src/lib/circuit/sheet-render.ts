// Schematic canvas overlay for hierarchical sheet boxes.
//
// KiCad draws hierarchical sheets as a green-bordered rectangle on the parent
// sheet. The sheet's name and file name are shown inside the box, and
// "sheet pins" (labels on the box edges) represent connections to the
// sub-sheet. Double-clicking the sheet navigates into it.
//
// This module provides pure drawing + hit-testing functions. The canvas
// component calls them from its render loop and mouse handlers.

import type { HierarchicalSheet, HierarchicalPin, Vec2 } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Drawing
// ─────────────────────────────────────────────────────────────────────────────

const CELL_SIZE = 24;

/**
 * Draw a hierarchical sheet box on the canvas.
 *
 * The sheet is drawn as a green-bordered rectangle with:
 *   - The sheet name (bold, top-left)
 *   - The file name (smaller, dimmed, bottom-right)
 *   - A small "↳ enter" hint at the bottom-left
 *   - Sheet pins arrayed along the box edges (left = inputs, right = outputs)
 *   - A subtle hover halo when `isHover` is true
 *
 * @returns the screen-space bounding rectangle, so the caller can hit-test
 *          double-clicks anywhere inside the box.
 */
export function drawSheetBox(
  ctx: CanvasRenderingContext2D,
  sheet: HierarchicalSheet,
  gridToScreen: (gx: number, gy: number) => Vec2,
  options: {
    isSelected: boolean;
    isHover: boolean;
    zoom: number;
  },
): { x: number; y: number; w: number; h: number } {
  const tl = gridToScreen(sheet.position.x, sheet.position.y);
  const br = gridToScreen(
    sheet.position.x + sheet.size.width,
    sheet.position.y + sheet.size.height,
  );
  const x = tl.x, y = tl.y;
  const w = br.x - tl.x, h = br.y - tl.y;

  // Hover halo (subtle green glow)
  if (options.isHover && !options.isSelected) {
    ctx.save();
    ctx.shadowColor = '#22c55e';
    ctx.shadowBlur = 8;
    ctx.fillStyle = 'rgba(34, 197, 94, 0.06)';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.restore();
  }

  // Sheet body fill
  ctx.fillStyle = options.isSelected
    ? 'rgba(34, 197, 94, 0.18)'
    : 'rgba(34, 197, 94, 0.08)';
  ctx.fillRect(x, y, w, h);

  // Border (KiCad uses a thick green outline)
  ctx.strokeStyle = options.isSelected ? '#22c55e' : '#16a34a';
  ctx.lineWidth = options.isSelected ? 2.5 : 1.5;
  ctx.strokeRect(x, y, w, h);

  // Sheet name (top-left, bold)
  ctx.save();
  ctx.fillStyle = options.isSelected ? '#86efac' : '#4ade80';
  ctx.font = `bold ${Math.max(11, Math.floor(13 * options.zoom))}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(sheet.sheetName, x + 6, y + 6);
  ctx.restore();

  // File name (bottom-right, small + dimmed)
  ctx.save();
  ctx.fillStyle = '#64748b';
  ctx.font = `${Math.max(9, Math.floor(10 * options.zoom))}px ui-monospace, monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(sheet.fileName, x + w - 6, y + h - 6);
  ctx.restore();

  // "↳ double-click to enter" hint (bottom-left)
  if (options.isHover) {
    ctx.save();
    ctx.fillStyle = '#22c55e';
    ctx.font = `${Math.max(9, Math.floor(9 * options.zoom))}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('↳ double-click to enter', x + 6, y + h - 6);
    ctx.restore();
  }

  // Sheet pins along the edges
  for (const pin of sheet.pins) {
    drawSheetPin(ctx, sheet, pin, gridToScreen, options.zoom);
  }

  return { x, y, w, h };
}

/**
 * Draw a single sheet pin on the sheet box edge.
 * Pins are drawn as a small filled square with the pin name extending
 * outward from the box. Side determines which edge + text alignment.
 */
function drawSheetPin(
  ctx: CanvasRenderingContext2D,
  sheet: HierarchicalSheet,
  pin: HierarchicalPin,
  gridToScreen: (gx: number, gy: number) => Vec2,
  zoom: number,
) {
  // pin.position is relative to the sheet's top-left corner (grid units)
  const pinScreen = gridToScreen(
    sheet.position.x + pin.position.x,
    sheet.position.y + pin.position.y,
  );

  // Pin marker (filled square, green)
  ctx.save();
  ctx.fillStyle = '#22c55e';
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 0.5;
  const s = 4;
  ctx.fillRect(pinScreen.x - s, pinScreen.y - s, s * 2, s * 2);
  ctx.strokeRect(pinScreen.x - s, pinScreen.y - s, s * 2, s * 2);

  // Pin name extending outward
  ctx.fillStyle = '#cbd5e1';
  ctx.font = `${Math.max(9, Math.floor(10 * zoom))}px ui-monospace, monospace`;
  const labelOffset = 10;
  switch (pin.side) {
    case 'left':
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(pin.name, pinScreen.x - labelOffset, pinScreen.y);
      break;
    case 'right':
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(pin.name, pinScreen.x + labelOffset, pinScreen.y);
      break;
    case 'top':
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(pin.name, pinScreen.x, pinScreen.y - labelOffset);
      break;
    case 'bottom':
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(pin.name, pinScreen.x, pinScreen.y + labelOffset);
      break;
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Hit testing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hit-test: is screen point (sx, sy) inside the sheet box?
 * Returns the sheet or null.
 */
export function findSheetAt(
  sheets: HierarchicalSheet[],
  sx: number,
  sy: number,
  gridToScreen: (gx: number, gy: number) => Vec2,
): HierarchicalSheet | null {
  for (let i = sheets.length - 1; i >= 0; i--) {
    const sheet = sheets[i];
    const tl = gridToScreen(sheet.position.x, sheet.position.y);
    const br = gridToScreen(
      sheet.position.x + sheet.size.width,
      sheet.position.y + sheet.size.height,
    );
    if (sx >= tl.x && sx <= br.x && sy >= tl.y && sy <= br.y) {
      return sheet;
    }
  }
  return null;
}

/**
 * Hit-test: is screen point (sx, sy) on a sheet pin?
 * Returns the sheet + pin, or null. Used to start a wire from a sheet pin.
 */
export function findSheetPinAt(
  sheets: HierarchicalSheet[],
  sx: number,
  sy: number,
  gridToScreen: (gx: number, gy: number) => Vec2,
): { sheet: HierarchicalSheet; pin: HierarchicalPin; screenPos: Vec2 } | null {
  const HIT_RADIUS = 8;
  for (const sheet of sheets) {
    for (const pin of sheet.pins) {
      const pinScreen = gridToScreen(
        sheet.position.x + pin.position.x,
        sheet.position.y + pin.position.y,
      );
      const dx = sx - pinScreen.x;
      const dy = sy - pinScreen.y;
      if (dx * dx + dy * dy < HIT_RADIUS * HIT_RADIUS) {
        return { sheet, pin, screenPos: pinScreen };
      }
    }
  }
  return null;
}

/**
 * Convert a sheet pin into a wire endpoint (componentId:terminalId-style key).
 * Used by the wire-start logic so sheet pins behave like component terminals.
 *
 * Returns an object compatible with `Wire.from` / `Wire.to`.
 */
export function sheetPinToWireEndpoint(sheet: HierarchicalSheet, pin: HierarchicalPin) {
  return {
    componentId: `__sheet:${sheet.id}`,
    terminalId: `pin:${pin.id}`,
  };
}

/**
 * Compute the absolute (grid) position of a sheet pin.
 * Used by the wire routing to connect wires to sheet pins.
 */
export function getSheetPinAbsPos(sheet: HierarchicalSheet, pin: HierarchicalPin): Vec2 {
  return {
    x: sheet.position.x + pin.position.x,
    y: sheet.position.y + pin.position.y,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pin layout helpers — auto-place a new pin on the side with the most space.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the position for a new sheet pin on the least-crowded side.
 * Default side is 'right' (output pins), but if right is full, fall back to left.
 */
export function autoPlacePinPosition(
  sheet: HierarchicalSheet,
  side: 'top' | 'bottom' | 'left' | 'right' = 'right',
): Vec2 {
  const pinsOnSide = sheet.pins.filter((p) => p.side === side);
  // place each pin 1 grid unit apart, starting 1 unit from the corner
  const idx = pinsOnSide.length + 1;
  switch (side) {
    case 'left':  return { x: 0, y: idx };
    case 'right': return { x: sheet.size.width, y: idx };
    case 'top':   return { x: idx, y: 0 };
    case 'bottom':return { x: idx, y: sheet.size.height };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Breadcrumb path — returns the chain of sheets from root to the active sheet.
// Used by the Toolbar to render "Root > Sheet A > Sheet B > ..." navigation.
// ─────────────────────────────────────────────────────────────────────────────

export interface BreadcrumbEntry {
  fileName: string;
  sheetName: string;
  isRoot: boolean;
  isCurrent: boolean;
}

/**
 * Compute the breadcrumb path from root to `activeSheet`.
 *
 * @param sheets The root sheet's HierarchicalSheet[] (sub-sheets declared on root)
 * @param childSheets The full childSheets record (mapping fileName → CircuitDocument)
 * @param activeSheet The currently-active sheet's fileName ('' = root)
 * @param sheetRegistry A map from fileName → HierarchicalSheet (the metadata; built
 *                      recursively from the root + each child sheet's `sheets` array)
 * @returns Array of {fileName, sheetName} from root to current.
 */
export function buildBreadcrumb(
  activeSheet: string,
  sheetRegistry: Map<string, HierarchicalSheet>,
): BreadcrumbEntry[] {
  const crumbs: BreadcrumbEntry[] = [{
    fileName: '',
    sheetName: 'Root',
    isRoot: true,
    isCurrent: activeSheet === '',
  }];

  // Walk the registry: each non-root sheet's fileName has a parent that contains
  // a HierarchicalSheet with that fileName. We don't store parent pointers, so
  // we walk by repeatedly finding the sheet whose `sheets` array contains the
  // current fileName. (For depth=1 hierarchies — the common case — this is
  // trivial.)
  if (activeSheet) {
    // Find the sheet metadata for the active sheet
    const meta = sheetRegistry.get(activeSheet);
    if (meta) {
      crumbs.push({
        fileName: activeSheet,
        sheetName: meta.sheetName,
        isRoot: false,
        isCurrent: true,
      });
    }
  }

  return crumbs;
}

/**
 * Recursively walk the sheet hierarchy and return a flat map of all known
 * sheets (fileName → HierarchicalSheet metadata).
 *
 * @param rootSheets The root sheet's `sheets` array
 * @param childSheets The childSheets record (each value may itself contain sheets)
 */
export function buildSheetRegistry(
  rootSheets: HierarchicalSheet[],
  childSheets: Record<string, import('./types').CircuitDocument>,
): Map<string, HierarchicalSheet> {
  const registry = new Map<string, HierarchicalSheet>();
  function walk(sheets: HierarchicalSheet[], doc: import('./types').CircuitDocument | null) {
    for (const sheet of sheets) {
      registry.set(sheet.fileName, sheet);
      // Recurse into the sheet's own sub-sheets (if it has any)
      const childDoc = childSheets[sheet.fileName];
      if (childDoc && (childDoc as any).sheets) {
        walk((childDoc as any).sheets, childDoc);
      }
    }
  }
  walk(rootSheets, null);
  return registry;
}
