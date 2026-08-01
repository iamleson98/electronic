// Hierarchy flattening — recursively inlines all sub-sheets into a single
// flat circuit for simulation / ERC / netlist export.
//
// Why this is needed:
//   The simulation engine (engine.ts) takes a flat `components[]` + `wires[]`
//   array. When a schematic has hierarchical sheets, the store has multiple
//   documents (one per sheet), and the engine doesn't know how to wire them
//   together. This module bridges that gap by:
//
//   1. Recursively walking the sheet hierarchy starting from root.
//   2. For each sub-sheet, cloning its components + wires with prefixed IDs
//      (so R1 in sheet "amp" becomes "amp.R1" — collisions avoided).
//   3. Connecting sheet pins on the parent to hierLabels in the sub-sheet
//      by name. A sheet pin named "IN" on the parent's sheet box becomes
//      a wire endpoint that matches any hierLabel with text "IN" inside
//      the sub-sheet.
//
// The output is a flat (components, wires) pair that the existing engine
// can process without changes.

import type {
  CircuitComponent,
  CircuitDocument,
  HierarchicalSheet,
  Wire,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface FlattenedCircuit {
  components: CircuitComponent[];
  wires: Wire[];
  /** the prefix used for IDs in this flattening (useful for debugging) */
  prefix: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flatten: walk the hierarchy and produce a flat circuit.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten the entire sheet hierarchy starting from the root document.
 *
 * @param rootDoc Root document (components + wires + sheets)
 * @param childSheets Map of fileName → sub-sheet document
 * @returns A flat circuit with all sub-sheets inlined
 */
export function flattenHierarchy(
  rootDoc: CircuitDocument & { sheets?: HierarchicalSheet[] },
  childSheets: Record<string, CircuitDocument>,
): FlattenedCircuit {
  const flatComponents: CircuitComponent[] = [];
  const flatWires: Wire[] = [];

  // Step 1: copy root components + wires (no ID prefixing at root)
  for (const comp of rootDoc.components) {
    flatComponents.push({ ...comp });
  }
  for (const wire of rootDoc.wires) {
    flatWires.push({ ...wire });
  }

  // Step 2: recursively inline each sub-sheet
  function inlineSheet(
    sheet: HierarchicalSheet,
    parentPrefix: string,
    parentSheetBoxId: string,
  ) {
    const childDoc = childSheets[sheet.fileName];
    if (!childDoc) return;

    // Prefix for IDs in this sub-sheet (e.g. "amp." → "amp.R1")
    const prefix = parentPrefix + sheet.sheetName + '.';

    // Map sub-sheet component IDs to prefixed IDs
    const idMap = new Map<string, string>();
    for (const comp of childDoc.components ?? []) {
      const newId = prefix + comp.id;
      idMap.set(comp.id, newId);
      flatComponents.push({
        ...comp,
        id: newId,
        // shift position by sheet box position so the sub-sheet's components
        // appear at the right location when visualizing the flat circuit
        // (only used for debugging — the engine doesn't care about position)
        position: {
          x: comp.position.x + sheet.position.x,
          y: comp.position.y + sheet.position.y + sheet.size.height + 2,
        },
      });
    }

    // Copy wires (with remapped component IDs in from/to)
    for (const wire of childDoc.wires ?? []) {
      const fromComp = idMap.get(wire.from.componentId) ?? wire.from.componentId;
      const toComp = idMap.get(wire.to.componentId) ?? wire.to.componentId;
      flatWires.push({
        ...wire,
        id: prefix + wire.id,
        from: { componentId: fromComp, terminalId: wire.from.terminalId },
        to: { componentId: toComp, terminalId: wire.to.terminalId },
      });
    }

    // Step 3: connect sheet pins to matching hierLabels in the sub-sheet.
    // For each pin on the sheet box, find any hierLabel components inside
    // the sub-sheet whose `text` parameter matches the pin name.
    // Add a wire from the sheet pin (on parent) to the hierLabel's terminal
    // (in the child).
    //
    // Sheet pins are addressed as `__sheet:${sheet.id}` : `pin:${pin.id}`
    // (matching the convention in sheet-render.ts).
    for (const pin of sheet.pins) {
      for (const comp of childDoc.components ?? []) {
        // hierLabel and netLabel both expose their name via the `net` parameter
        // (we use `net` for both to keep the engine code simple).
        const labelText =
          (comp.parameters?.net as string) ||
          (comp.parameters?.text as string);
        if (!labelText) continue;
        if (comp.type !== 'hierLabel' && comp.type !== 'netLabel') continue;
        if (labelText !== pin.name) continue;
        // Connect: sheet pin (parent) → label component (child, prefixed)
        const childCompId = idMap.get(comp.id) ?? comp.id;
        flatWires.push({
          id: `${prefix}__pinlink_${pin.id}_${comp.id}`,
          from: {
            componentId: `__sheet:${parentSheetBoxId}`,
            terminalId: `pin:${pin.id}`,
          },
          to: {
            componentId: childCompId,
            terminalId: 'p', // labels have a single terminal 'p'
          },
        });
      }
    }

    // Recurse into the sub-sheet's own sub-sheets (nested hierarchy)
    const childSheetsOfChild = (childDoc as any).sheets as HierarchicalSheet[] | undefined;
    if (childSheetsOfChild) {
      for (const grandchild of childSheetsOfChild) {
        inlineSheet(grandchild, prefix, sheet.id);
      }
    }
  }

  // Inline each top-level sheet on the root document
  for (const sheet of rootDoc.sheets ?? []) {
    inlineSheet(sheet, '', sheet.id);
  }

  return { components: flatComponents, wires: flatWires, prefix: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet-switch helpers — used by the store to swap components/wires when
// the user navigates between sheets.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot the current root-sheet state into a CircuitDocument, suitable for
 * storing in `childSheets[fileName]` or as the root document.
 *
 * This is a pure data copy — no ID remapping.
 */
export function snapshotSheet(
  components: CircuitComponent[],
  wires: Wire[],
  sheets: HierarchicalSheet[],
  extras?: Partial<CircuitDocument>,
): CircuitDocument {
  return {
    version: 1,
    components: components.map((c) => ({ ...c })),
    wires: wires.map((w) => ({ ...w })),
    sheets: sheets.map((s) => ({ ...s, pins: s.pins.map((p) => ({ ...p })) })),
    ...extras,
  };
}

/**
 * Compute the parent sheet's fileName given the current `activeSheet` and
 * a registry of all sheets. Returns '' if the active sheet is the root or
 * if the parent can't be determined (e.g. the active sheet is a top-level
 * sub-sheet of root).
 *
 * For depth=1 hierarchies (the common case), parent is always root ('').
 */
export function getParentSheet(
  activeSheet: string,
  sheetRegistry: Map<string, HierarchicalSheet>,
  childSheets: Record<string, CircuitDocument>,
): string {
  if (!activeSheet) return ''; // already at root
  // Walk each sheet document and check if it contains the active sheet's fileName
  for (const [parentFileName, parentDoc] of Object.entries(childSheets)) {
    const subSheets = (parentDoc as any).sheets as HierarchicalSheet[] | undefined;
    if (!subSheets) continue;
    if (subSheets.some((s) => s.fileName === activeSheet)) {
      return parentFileName;
    }
  }
  // If not found as a sub-sheet of any tracked child, it must be a sub-sheet of root
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-sheet net name resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all (sheetPin name, hierLabel name) pairs that should be electrically
 * connected across the hierarchy. Returns a list of {parentSheetId, pinName,
 * childSheetFileName, labelCompId} tuples.
 *
 * Used by ERC to verify that every sheet pin has a matching hierLabel and
 * vice versa.
 */
export interface CrossSheetConnection {
  parentSheetBoxId: string;
  pinName: string;
  childSheetFileName: string;
  labelComponentId: string;
}

export function collectCrossSheetConnections(
  rootDoc: CircuitDocument & { sheets?: HierarchicalSheet[] },
  childSheets: Record<string, CircuitDocument>,
): CrossSheetConnection[] {
  const result: CrossSheetConnection[] = [];
  function walk(sheets: HierarchicalSheet[]) {
    for (const sheet of sheets) {
      const childDoc = childSheets[sheet.fileName];
      if (!childDoc) continue;
      for (const pin of sheet.pins) {
        for (const comp of childDoc.components ?? []) {
          const labelText =
            (comp.parameters?.net as string) ||
            (comp.parameters?.text as string);
          if (!labelText) continue;
          if (comp.type !== 'hierLabel' && comp.type !== 'netLabel') continue;
          if (labelText !== pin.name) continue;
          result.push({
            parentSheetBoxId: sheet.id,
            pinName: pin.name,
            childSheetFileName: sheet.fileName,
            labelComponentId: comp.id,
          });
        }
      }
      // Recurse
      const childSubSheets = (childDoc as any).sheets as HierarchicalSheet[] | undefined;
      if (childSubSheets) walk(childSubSheets);
    }
  }
  walk(rootDoc.sheets ?? []);
  return result;
}
