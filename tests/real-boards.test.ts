// Real-board regression suite: decks generated from professionally routed boards
// (arc lighter, FM/AM radio labs, tricolor lamp, uNode32U4) are imported with the app's
// SPICE importer and simulated with the app engine; the physics metrics from the
// original testbenches must match real ngspice.
//
//   npx vitest run tests/real-boards.test.ts                 # fast decks, stored ngspice refs
//   SLOW=1 npx vitest run tests/real-boards.test.ts          # + the long RF transients (20 s - several minutes)
//   LIVE_NGSPICE=1 ...                                       # compare against a fresh ngspice run instead of refs.json
//   UPDATE_REFS=1 npx vitest run tests/real-boards.test.ts   # regenerate tests/fixtures/real-boards/refs.json (needs ngspice)
//
// Reference values live in tests/fixtures/real-boards/refs.json so the suite needs no ngspice.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { FIXTURE_DIR, loadBoard, readDeck } from './helpers/real-boards';
import { hasNgspice } from './helpers/ngspice-run';
import { SPECS, type Metrics, type DeckSpec } from './helpers/real-boards-specs';
import { runOurs, ourDcOp, ngspiceReference } from './helpers/real-boards-run';

const REFS_PATH = join(FIXTURE_DIR, 'refs.json');
type Refs = { ngspice: string; decks: Record<string, { metrics: Metrics; dcOp: Record<string, number> }> };
const stored: Refs = existsSync(REFS_PATH) ? JSON.parse(readFileSync(REFS_PATH, 'utf8')) : { ngspice: '', decks: {} };
const UPDATE = process.env.UPDATE_REFS === '1';
const LIVE = process.env.LIVE_NGSPICE === '1';
const SLOW = process.env.SLOW === '1';

const refFor = (spec: DeckSpec) => (LIVE && hasNgspice ? ngspiceReference(spec) : stored.decks[spec.id]);

function compare(id: string, ours: Metrics, ref: Metrics, tol: DeckSpec['tol']) {
  for (const [k, t] of Object.entries(tol)) {
    const o = ours[k], r = ref[k];
    expect(Number.isFinite(o), `${id} ${k}: app value is ${o}`).toBe(true);
    const allowed = Math.max(t.abs ?? 0, (t.rel ?? 0) * Math.abs(r));
    expect(Math.abs(o - r), `${id} ${k}: app ${o} vs ngspice ${r} (allowed ${allowed.toPrecision(3)})`).toBeLessThanOrEqual(allowed);
  }
}

if (UPDATE) {
  describe.skipIf(!hasNgspice)('regenerate refs.json from ngspice', () => {
    it('writes tests/fixtures/real-boards/refs.json', () => {
      const out: Refs = { ngspice: '', decks: {} };
      for (const spec of SPECS) out.decks[spec.id] = ngspiceReference(spec);
      out.ngspice = 'ngspice-47 (' + new Date().toISOString().slice(0, 10) + ')';
      writeFileSync(REFS_PATH, JSON.stringify(out, null, 2) + '\n');
    }, 1_800_000);
  });
}

describe('real boards: app engine vs ngspice', () => {
  // the 11 harness decks + the radio-lab-rx tank-alignment AC deck
  for (const spec of SPECS) {
    describe(spec.id, () => {
      it('imports without errors, unsupported cards or dangling nets', () => {
        const b = loadBoard(readDeck(spec.id));
        expect(b.errors).toEqual([]);
        expect(b.warnings).toEqual([]);
        for (const p of spec.probes) expect(b.node(p), `net ${p}`).toBeGreaterThan(0);
      });

      it('DC operating point of the probed nets matches ngspice (0.3 % + 3 mV)', () => {
        const ref = refFor(spec);
        expect(ref, 'no reference: run UPDATE_REFS=1').toBeTruthy();
        const ours = ourDcOp(spec);
        for (const p of spec.probes) {
          expect(Math.abs(ours[p] - ref.dcOp[p]), `${spec.id} V(${p}): app ${ours[p]} vs ngspice ${ref.dcOp[p]}`).toBeLessThanOrEqual(3e-3 + 3e-3 * Math.abs(ref.dcOp[p]));
        }
      });

      const run = spec.slow && !SLOW ? it.skip : it;
      run(`${spec.kind} metrics match ngspice${spec.slow ? ' (slow: SLOW=1)' : ''}`, () => {
        const ref = refFor(spec);
        expect(ref, 'no reference: run UPDATE_REFS=1').toBeTruthy();
        const { series } = runOurs(spec);
        compare(spec.id, spec.metrics(series), ref.metrics, spec.tol);
      }, 900_000);
    });
  }
});
