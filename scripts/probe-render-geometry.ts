// Probe: reproduce the EXACT renderer geometry for every example wire and
// flag any diagonal segment (matching what the canvas actually draws).
import { exampleCategories } from '../src/lib/circuit/examples';
import { resolveEndpointGridPos } from '../src/lib/circuit/endpoint-position';
import { getWirePath } from '../src/components/circuit/canvas-wire-utils';
import type { Vec2 } from '../src/lib/circuit/types';

// Identity view transform: grid -> screen with CELL_SIZE=1, zoom=1, pan=0.
// Axis alignment is preserved under any affine transform, so this is exact.
const g2s = (gx: number, gy: number): Vec2 => ({ x: gx, y: gy });

let totalWires = 0;
let diagonalWires = 0;
const defects: string[] = [];

for (const cat of exampleCategories) {
  for (const ex of cat.examples) {
    const doc = ex.doc;
    for (const w of doc.wires ?? []) {
      totalWires++;
      const from = resolveEndpointGridPos(w.from, doc.components, doc.sheets ?? []);
      const to = resolveEndpointGridPos(w.to, doc.components, doc.sheets ?? []);
      if (!from || !to) {
        defects.push(`${cat.name}/${ex.name} ${w.id}: UNRESOLVED endpoint`);
        diagonalWires++;
        continue;
      }
      const path = getWirePath(w, g2s(from.x, from.y), g2s(to.x, to.y), g2s, false);
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        if (dx > 0.01 && dy > 0.01) {
          defects.push(
            `${cat.name}/${ex.name} wire ${w.id} (${w.from.componentId}.${w.from.terminalId} -> ${w.to.componentId}.${w.to.terminalId}): segment ${i} DIAGONAL from (${a.x.toFixed(2)},${a.y.toFixed(2)}) to (${b.x.toFixed(2)},${b.y.toFixed(2)}) dx=${dx.toFixed(2)} dy=${dy.toFixed(2)}`
          );
          diagonalWires++;
          break;
        }
      }
    }
  }
}

console.log(`Total wires: ${totalWires}`);
console.log(`Wires with diagonal segments (or unresolved): ${diagonalWires}`);
console.log('--- defects ---');
for (const d of defects.slice(0, 60)) console.log(d);
if (defects.length === 0) console.log('(none — render geometry is orthogonal)');
