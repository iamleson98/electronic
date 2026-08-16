import { describe, it, expect, beforeAll } from 'vitest';
import { findExternalConnections, createSubcircuitFromSelection, canIncludeInSubcircuit } from '../src/lib/circuit/subcircuit-creator';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/passive'); });
function comp(t:string,id:string,p?:any){const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
describe('Subcircuit creator', () => {
  it('findExternalConnections: finds boundary crossings', () => { const c=[comp('resistor','R1'),comp('resistor','R2'),comp('resistor','R3'),comp('ground','GND')];const w=[{id:'w1',from:{componentId:'R1',terminalId:'b'},to:{componentId:'R2',terminalId:'a'}},{id:'w2',from:{componentId:'R2',terminalId:'b'},to:{componentId:'R3',terminalId:'a'}}];const ext=findExternalConnections(new Set(['R1','R2']),c,w);expect(ext.size).toBe(1);});
  it('canIncludeInSubcircuit: rejects ground', () => { expect(canIncludeInSubcircuit(comp('resistor','R1'))).toBe(true);expect(canIncludeInSubcircuit(comp('ground','GND'))).toBe(false);});
  it('createSubcircuitFromSelection: creates child doc', () => { const doc={version:1,components:[comp('resistor','R1'),comp('resistor','R2'),comp('ground','GND')],wires:[]};const r=createSubcircuitFromSelection(doc,new Set(['R1','R2']),'Test');expect(r.sheet.sheetName).toBe('Test');});
});
