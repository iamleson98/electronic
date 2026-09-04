// DOCUMENT TOOLS
// Auto-extracted from the original ai/tools/index.ts during refactor.

import type { Tool, ToolContext } from './types';
import { getPlugin } from '@/lib/circuit/registry';
import { exportKiCadNetlist } from '@/lib/circuit/netlist-export';

// ─────────────────────────────────────────────────────────────────────────────

const serializeDocumentTool: Tool = {
  name: 'schematic.serialize',
  category: 'Discovery',
  description: 'Get the full current circuit document as JSON (components, wires, metadata). Useful for understanding the complete state.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    return {
      ok: true,
      result: {
        version: ctx.doc.version,
        componentCount: ctx.doc.components.length,
        wireCount: ctx.doc.wires.length,
        components: ctx.doc.components.map(c => ({ id: c.id, type: c.type, position: c.position, rotation: c.rotation, parameters: c.parameters })),
        wires: ctx.doc.wires.map(w => ({ id: w.id, from: w.from, to: w.to })),
      },
    };
  },
};

const exportKiCadNetlistTool: Tool = {
  name: 'export.kiCadNetlist',
  category: 'Examples & Export',
  description: 'Export the circuit as a KiCad XML netlist (.net format) for importing into KiCad\'s PCB editor.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    try {
      const netlist = exportKiCadNetlist(ctx.doc);
      return { ok: true, result: { netlist } };
    } catch (e) {
      return { ok: false, error: `Export failed: ${(e as Error).message}` };
    }
  },
};

const loadDocumentTool: Tool = {
  name: 'schematic.loadDocument',
  category: 'Circuit Building',
  description: 'Replace the entire circuit with a provided document (components + wires). Use this to load a previously-saved circuit or apply a large batch of changes at once.',
  parameters: {
    type: 'object',
    properties: {
      components: {
        type: 'array',
        description: 'Array of component objects, each with {id, type, position:{x,y}, rotation, parameters}',
        items: { type: 'object' },
      },
      wires: {
        type: 'array',
        description: 'Array of wire objects, each with {id, from:{componentId,terminalId}, to:{componentId,terminalId}}',
        items: { type: 'object' },
      },
    },
    required: ['components', 'wires'],
  },
  execute(args, ctx) {
    // Shape-validate the model-supplied document: a hallucinated non-array
    // (or array of non-components) would corrupt ctx.doc for the rest of the
    // loop — every later tool and the auto-verify pass would throw, failing
    // the whole request AFTER mutations were already applied.
    if (!Array.isArray(args.components) || !Array.isArray(args.wires)) {
      return { ok: false, error: 'components and wires must be arrays. Each component: {id, type, position:{x,y}, rotation, parameters}; each wire: {id, from:{componentId,terminalId}, to:{componentId,terminalId}}.' };
    }
    const badComponent = args.components.find((c: any) =>
      !c || typeof c !== 'object' ||
      typeof c.type !== 'string' ||
      !c.position || typeof c.position !== 'object' ||
      typeof c.position.x !== 'number' || typeof c.position.y !== 'number' ||
      (c.parameters !== undefined && typeof c.parameters !== 'object'));
    if (badComponent !== undefined) {
      return { ok: false, error: `Invalid component entry: ${JSON.stringify(badComponent)?.slice(0, 200)}. Every component needs {type: string, position: {x, y}} (parameters optional — plugin defaults are filled in).` };
    }
    const badWire = args.wires.find((w: any) => !w || typeof w !== 'object' || !w.from || !w.to);
    if (badWire !== undefined) {
      return { ok: false, error: `Invalid wire entry: ${JSON.stringify(badWire)?.slice(0, 200)}. Every wire needs {from: {componentId, terminalId}, to: {componentId, terminalId}}.` };
    }
    // Normalize optional fields the later tools/validators dereference:
    // missing `parameters` → plugin defaults (addComponentTool semantics),
    // missing `rotation` → 0. Keeps diagnose/validatePhysics from throwing
    // on a hand-written document.
    const components = args.components.map((c: any) => {
      if (c.parameters && c.rotation !== undefined) return c;
      const plugin = getPlugin(c.type);
      const defaults: Record<string, any> = {};
      for (const p of plugin?.parameters ?? []) defaults[p.key] = p.default;
      return {
        ...c,
        parameters: c.parameters ?? defaults,
        rotation: c.rotation ?? 0,
      };
    });
    ctx.doc.components = components;
    ctx.doc.wires = args.wires;
    // Whole-document replacement changes topology — node ids are renumbered,
    // so any cached simContext (node voltages from the PREVIOUS circuit)
    // must be discarded or getVoltage/getCurrent would silently read wrong nodes.
    ctx.simContext = null;
    return { ok: true, result: { componentsLoaded: components.length, wiresLoaded: args.wires.length } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Undo / redo — turn-scoped circuit history
// ─────────────────────────────────────────────────────────────────────────────
// The turn runner snapshots ctx.doc before every mutating tool call (see
// turn-manager.ts). These tools move through that history server-side; the
// restored document flows back to the client through the same circuit_update
// channel as every other mutation, so the canvas and the model's context can
// never diverge (a client-side editor.undo() here would fight the next
// circuit_update and silently resurrect whatever was undone).

const undoTool: Tool = {
  name: 'schematic.undo',
  category: 'Circuit Building',
  description:
    'Undo the most recent circuit change from this turn — yours or the user\'s earlier request in the same conversation. Use it to cleanly back out a wrong mutation before redoing it differently.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx: ToolContext) {
    const h = ctx.history;
    if (!h || h.undoStack.length === 0) {
      return { ok: false, error: 'Nothing to undo yet — no circuit changes have been made in this turn.' };
    }
    const snapshot = h.undoStack.pop()!;
    h.redoStack.push(JSON.stringify({ components: ctx.doc.components, wires: ctx.doc.wires }));
    const restored = JSON.parse(snapshot);
    ctx.doc.components = restored.components;
    ctx.doc.wires = restored.wires;
    ctx.simContext = null; // topology changed — stale node voltages would mislead
    return {
      ok: true,
      result: {
        action: 'undo',
        components: ctx.doc.components.length,
        wires: ctx.doc.wires.length,
        message: `Reverted the last circuit change (${ctx.doc.components.length} components, ${ctx.doc.wires.length} wires).`,
      },
    };
  },
};

const redoTool: Tool = {
  name: 'schematic.redo',
  category: 'Circuit Building',
  description: 'Redo a change that was just undone with schematic.undo.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx: ToolContext) {
    const h = ctx.history;
    if (!h || h.redoStack.length === 0) {
      return { ok: false, error: 'Nothing to redo — undo a change first.' };
    }
    const snapshot = h.redoStack.pop()!;
    h.undoStack.push(JSON.stringify({ components: ctx.doc.components, wires: ctx.doc.wires }));
    const restored = JSON.parse(snapshot);
    ctx.doc.components = restored.components;
    ctx.doc.wires = restored.wires;
    ctx.simContext = null;
    return {
      ok: true,
      result: {
        action: 'redo',
        components: ctx.doc.components.length,
        wires: ctx.doc.wires.length,
        message: `Re-applied the undone change (${ctx.doc.components.length} components, ${ctx.doc.wires.length} wires).`,
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { serializeDocumentTool, exportKiCadNetlistTool, loadDocumentTool, undoTool, redoTool };
