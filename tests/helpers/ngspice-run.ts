// Run a deck through the real ngspice and return the requested node voltages.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const hasNgspice = (() => {
  try { execFileSync('ngspice', ['-v'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

export interface NgOpts {
  probes: string[];
  /** replacement for the deck's `.tran ...` / `.ac ...` card; omit to keep it, 'op' to run .op */
  analysis?: string | 'op';
  options?: string;
}
export interface NgResult { x: number[]; v: Record<string, number[]>; /** AC: imag parts */ vi?: Record<string, number[]> }

export function runNgspice(deck: string, o: NgOpts): NgResult {
  const dir = mkdtempSync(join(tmpdir(), 'rb-ng-'));
  try {
    let text = deck.replace(/^\.end\s*$/gim, '');
    let cmd = 'run';
    const isAc = /^\.ac/im.test(o.analysis && o.analysis !== 'op' ? o.analysis : text) && o.analysis !== 'op';
    if (o.analysis === 'op') { text = text.replace(/^\.(tran|ac).*$/gim, ''); cmd = 'op'; }
    else if (o.analysis) text = text.replace(/^\.(tran|ac).*$/gim, '') + '\n' + o.analysis + '\n';
    const out = join(dir, 'out.dat');
    text += `\n${o.options ? `.options ${o.options}\n` : ''}.control\nset filetype=ascii\n${cmd}\nwrdata ${out} ${o.probes.map((p) => `v(${p})`).join(' ')}\n.endc\n.end\n`;
    const f = join(dir, 'deck.cir');
    writeFileSync(f, text);
    execFileSync('ngspice', ['-b', f], { stdio: 'pipe', timeout: 300_000, maxBuffer: 1 << 28 });
    const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const res: NgResult = { x: rows.map((r) => r[0]), v: {} };
    if (cmd === 'op') {
      // op: pairs are (scale, value) with the scale repeated
      o.probes.forEach((p, k) => { res.v[p] = [rows[0][2 * k + 1]]; });
      return res;
    }
    if (isAc) {
      res.vi = {};
      o.probes.forEach((p, k) => { res.v[p] = rows.map((r) => r[3 * k + 1]); res.vi![p] = rows.map((r) => r[3 * k + 2]); });
    } else o.probes.forEach((p, k) => { res.v[p] = rows.map((r) => r[2 * k + 1]); });
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
