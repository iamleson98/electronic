import { readFileSync } from 'fs';
/** parse an ngspice `wrdata` ascii file: columns are (x, y) pairs per vector */
export function readWrdata(path: string, names: string[]) {
  const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const x = rows.map((r) => r[0]);
  const v: Record<string, number[]> = {};
  names.forEach((n, k) => { v[n] = rows.map((r) => r[2 * k + 1]); });
  return { x, v };
}
