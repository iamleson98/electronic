import { describe, it, expect, beforeAll } from 'vitest';
import { generateBOM, exportBOMAsCSV } from '../src/lib/circuit/bom-export';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitDocument } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/extra'); });
function comp(t:string,id:string,p?:any){const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
describe('BOM export', () => {
  it('groups components by type+value', () => { const doc:CircuitDocument={version:1,components:[comp('resistor','R1',{resistance:1000}),comp('resistor','R2',{resistance:1000}),comp('resistor','R3',{resistance:2200})],wires:[]};const bom=generateBOM(doc);expect(bom.lines.length).toBe(2);expect(bom.lines[0].quantity).toBe(2);});
  it('looks up MPN for 555 timer', () => { const doc:CircuitDocument={version:1,components:[comp('timer555','U1',{astable:true})],wires:[]};const bom=generateBOM(doc);expect(bom.lines[0].mpn).toBe('NE555P');});
  it('CSV has headers', () => { const doc:CircuitDocument={version:1,components:[comp('resistor','R1',{resistance:1000})],wires:[]};const bom=generateBOM(doc);const csv=exportBOMAsCSV(bom);expect(csv).toContain('Designator');});
});
