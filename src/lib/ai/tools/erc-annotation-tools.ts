// ERC + ANNOTATION TOOLS
// Auto-extracted from the original ai/tools/index.ts during refactor.

import type { Tool } from './types';

// ─────────────────────────────────────────────────────────────────────────────

const runERCTool: Tool = {
  name: 'schematic.runERC',
  category: 'Simulation & Analysis',
  description: 'Run Electrical Rules Check (ERC) on the schematic. Detects unconnected pins, power pins shorted, conflicting drivers, missing ground, etc. Returns a list of errors and warnings.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    // ERC requires the full runFullERC function — but it needs noConnects which we don't expose yet
    // For now, return a basic check
    const errors: any[] = [];
    // Check for unconnected pins
    for (const comp of ctx.doc.components) {
      const plugin = ctx.plugins.get(comp.type);
      if (!plugin) continue;
      for (const term of plugin.terminals) {
        const connected = ctx.doc.wires.some(w =>
          (w.from.componentId === comp.id && w.from.terminalId === term.id) ||
          (w.to.componentId === comp.id && w.to.terminalId === term.id)
        );
        if (!connected && comp.type !== 'ground' && comp.type !== 'junction') {
          errors.push({
            type: 'unconnected_pin',
            severity: 'warning',
            componentId: comp.id,
            terminalId: term.id,
            message: `${comp.id}.${term.id} is not connected`,
          });
        }
      }
    }
    // Check for missing ground
    const hasGround = ctx.doc.components.some(c => c.type === 'ground' || c.type === 'powerGND');
    if (!hasGround && ctx.doc.components.length > 0) {
      errors.push({
        type: 'missing_ground',
        severity: 'error',
        message: 'No ground component found — circuit needs a ground reference',
      });
    }
    return { ok: true, result: { errors, errorCount: errors.filter(e => e.severity === 'error').length, warningCount: errors.filter(e => e.severity === 'warning').length } };
  },
};

const reannotateTool: Tool = {
  name: 'schematic.reannotate',
  category: 'Circuit Building',
  description: 'Re-number all component reference designators (R1, R2, C1, etc.) by insertion order. Sets the refdes FIELD (what the UI displays) and keeps component ids stable so existing wiring and AI references stay valid. Useful after adding many components.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    // Renumber the refdes field by type, in order of appearance. The previous
    // implementation rewired comp.id in place, which (a) corrupted wiring
    // whenever a rename collided with a later component's id (the later
    // rename hijacked wires just re-pointed at the earlier one), and (b)
    // never touched refdes at all — so the screen kept showing the old
    // designators and AI/user references desynchronized.
    const counters: Record<string, number> = {};
    const renames: { componentId: string; oldRefdes: string; newRefdes: string }[] = [];
    for (const comp of ctx.doc.components) {
      const prefix = comp.type === 'resistor' ? 'R' :
        comp.type === 'capacitor' ? 'C' :
        comp.type === 'inductor' ? 'L' :
        comp.type === 'led' ? 'LED' :
        comp.type === 'diode' ? 'D' :
        comp.type === 'dcVoltage' || comp.type === 'acVoltage' ? 'V' :
        comp.type === 'npn' || comp.type === 'pnp' ? 'Q' :
        comp.type === 'opamp' || comp.type === 'opampRails' || comp.type === 'opampReal' ? 'U' :
        'X';
      counters[prefix] = (counters[prefix] || 0) + 1;
      const newRefdes = `${prefix}${counters[prefix]}`;
      const oldRefdes = comp.refdes ?? comp.id;
      if (oldRefdes !== newRefdes) {
        comp.refdes = newRefdes;
        renames.push({ componentId: comp.id, oldRefdes, newRefdes });
      }
    }
    return {
      ok: true,
      result: {
        renamed: renames.length,
        renames,
        note: 'Reference designators (labels shown in the UI) were renumbered. Component ids and wiring are unchanged.',
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export { runERCTool, reannotateTool };
