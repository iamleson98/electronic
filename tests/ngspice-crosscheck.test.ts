// Independent oracle: every example whose parts all have SPICE primitives is
// exported, run through a real ngspice, and its DC operating point compared
// node by node with the app's own solver. This pins two things at once —
// the export is a netlist ngspice accepts (op-amp macromodels, B-source
// syntax, per-part diode / BJT / MOSFET models) and the app's device models
// agree with the SPICE equations they claim to implement.
//
// Skipped when ngspice is not installed (brew install ngspice).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import '../src/lib/circuit/components';
import { exportSPICENetlist, spiceNodeNamer } from '../src/lib/circuit/netlist-export';
import { solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { getAllPlugins } from '../src/lib/circuit/registry';
import { exampleCategories } from '../src/lib/circuit/examples';

const hasNgspice = (() => {
  try { execFileSync('ngspice', ['-v'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

// DC-ill-posed: the integrator has no DC feedback path and the Schmitt
// trigger is bistable — any rail is a valid operating point.
const ILL_POSED = new Set(['Integrator (Miller)', 'Schmitt Trigger']);

describe.skipIf(!hasNgspice)('ngspice cross-check', () => {
  it('examples built from SPICE primitives have the same DC operating point in ngspice (0.1 % + 2 mV)', () => {
    const P = new Map(getAllPlugins().map((p) => [p.type, p]));
    const dir = mkdtempSync(join(tmpdir(), 'ngspice-xcheck-'));
    let checked = 0;
    try {
      for (const e of exampleCategories.flatMap((c) => c.examples)) {
        if (ILL_POSED.has(e.name)) continue;
        const net = exportSPICENetlist(e.doc, e.name);
        if (/WARNING: \d+ part/.test(net)) continue;
        const file = join(dir, `x${checked}.cir`);
        writeFileSync(file, net.replace(/^\.tran .*$/m, '.control\nop\nprint all\n.endc'));
        const out = execFileSync('ngspice', ['-b', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
        const ng = new Map<string, number>();
        for (const m of out.matchAll(/^([\w#.-]+) = ([-+0-9.eE]+)\s*$/gm)) ng.set(m[1].toLowerCase(), +m[2]);
        expect(ng.size, `${e.name}: ngspice printed no operating point`).toBeGreaterThan(0);
        const comps = e.doc.components.map((c) => ({ ...c, simState: {} }));
        const dc = solveDC(comps, e.doc.wires, P)!;
        const name = spiceNodeNamer(e.doc);
        const nm = buildNodeMap(comps, e.doc.wires, P);
        for (let k = 1; k < nm.numNodes; k++) {
          const v = ng.get(name(k).toLowerCase());
          if (v === undefined) continue;
          // SPICE's own tolerance form: reltol·|V| + an absolute floor
          expect(Math.abs(dc.nodeVoltage[k] - v), `${e.name} ${name(k)}`).toBeLessThan(1e-3 * Math.abs(v) + 2e-3);
        }
        checked++;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  }, 120_000);
});
