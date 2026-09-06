// EXPORT TOOLS
// Auto-extracted from the original ai/tools/index.ts during refactor.

import type { Tool } from './types';
import { exportSPICENetlist, exportBOMCSV, buildBOMRows } from '@/lib/circuit/netlist-export';
import { buildNodeMap, getTerminalsForComponent } from '@/lib/circuit/engine';

// ─────────────────────────────────────────────────────────────────────────────

const exportSPICENetlistTool: Tool = {
  name: 'export.spiceNetlist',
  category: 'Examples & Export',
  description: 'Export the current circuit as a SPICE3 netlist (.cir format). Returns the netlist as a string.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional title for the netlist.' },
    },
  },
  execute(args, ctx) {
    try {
      const netlist = exportSPICENetlist(ctx.doc, args.title);
      return { ok: true, result: { netlist } };
    } catch (e) {
      return { ok: false, error: `Export failed: ${(e as Error).message}` };
    }
  },
};

const exportBOMTool: Tool = {
  name: 'export.bomCSV',
  category: 'Examples & Export',
  description: 'Export the Bill of Materials as CSV. Lists all components with their values, footprints, and quantities.',
  parameters: { type: 'object', properties: {} },
  execute(_args, ctx) {
    try {
      const csv = exportBOMCSV(ctx.doc);
      return { ok: true, result: { csv } };
    } catch (e) {
      return { ok: false, error: `Export failed: ${(e as Error).message}` };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────

const designReportTool: Tool = {
  name: 'export.designReport',
  category: 'Examples & Export',
  description: 'Generate a Markdown design report: title, BOM table, net list, DC operating point, derating summary, and review checklist results. The user can save/share it as design documentation. Non-mutating.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Report title (default: circuit title).' },
    },
  },
  execute(args, ctx) {
    try {
      const title = (args.title as string) || 'Circuit Design Report';
      const { doc, plugins, simContext } = ctx;
      const lines: string[] = [`# ${title}`, '', `_Generated ${new Date().toISOString().slice(0, 10)} — ${doc.components.length} components, ${doc.wires.length} wires._`, ''];
      // BOM
      lines.push('## Bill of Materials', '');
      const rows = buildBOMRows({ version: 1, components: doc.components, wires: doc.wires });
      lines.push('| Designators | Qty | Value | Footprint | MPN | DNP |');
      lines.push('|---|---|---|---|---|---|');
      for (const r of rows) {
        lines.push(`| ${r.designators.join(', ')} | ${r.quantity} | ${r.value} | ${r.footprint} | ${r.mpn ?? ''} | ${r.dnp ? 'DNP' : ''} |`);
      }
      lines.push('');
      // Nets
      lines.push('## Nets', '');
      try {
        const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
        const nets = new Map<number, string[]>();
        for (const comp of doc.components) {
          const plugin = plugins.get(comp.type);
          if (!plugin) continue;
          for (const t of getTerminalsForComponent(comp, plugin, nodeMap)) {
            const ref = comp.refdes ?? comp.id;
            const arr = nets.get(t.nodeId) ?? [];
            arr.push(`${ref}.${t.terminalId}`);
            nets.set(t.nodeId, arr);
          }
        }
        for (const [id, pins] of [...nets.entries()].sort((a, b) => a[0] - b[0])) {
          lines.push(`- **${id === 0 ? 'GND' : `N${id}`}**: ${pins.join(' · ')}`);
        }
      } catch {
        lines.push('_Net list unavailable._');
      }
      lines.push('');
      // Operating point
      lines.push('## DC Operating Point', '');
      if (simContext) {
        lines.push('| Node | Voltage |');
        lines.push('|---|---|');
        for (let i = 1; i < Math.min(simContext.nodeVoltage.length, 33); i++) {
          lines.push(`| N${i} | ${(simContext.nodeVoltage[i] ?? 0).toFixed(4)} V |`);
        }
      } else {
        lines.push('_No simulation has run yet — run simulate.run first._');
      }
      lines.push('');
      lines.push('## Review', '');
      lines.push('Run review.derating + review.checklist for the full production sign-off tables.');
      return { ok: true, result: { markdown: lines.join('\n') } };
    } catch (e) {
      return { ok: false, error: `Report failed: ${(e as Error).message}` };
    }
  },
};

export { exportSPICENetlistTool, exportBOMTool, designReportTool };
