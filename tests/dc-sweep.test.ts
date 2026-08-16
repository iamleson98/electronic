import { describe, it, expect, beforeAll } from 'vitest';
import { generateSweepValues, runDCSweep } from '../src/lib/circuit/dc-sweep';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitDocument } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); });
function plugins(){return new Map(getAllPlugins().map(p=>[p.type,p]));}
function comp(t:string,id:string,p?:any){const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string){return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
describe('DC sweep', () => {
  it('generateSweepValues: linear', () => { const v=generateSweepValues(0,10,6,'linear');expect(v.length).toBe(6);expect(v[0]).toBe(0);expect(v[5]).toBe(10);});
  it('generateSweepValues: log', () => { const v=generateSweepValues(1,1000,4,'log');expect(v.length).toBe(4);expect(v[0]).toBeCloseTo(1,5);expect(v[3]).toBeCloseTo(1000,5);});
  it('runDCSweep: voltage divider', () => { const doc:CircuitDocument={version:1,components:[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('resistor','R2',{resistance:1000}),comp('ground','GND')],wires:[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','GND','g'),wire('w4','V1','n','GND','g')]};const r=runDCSweep(doc,{componentId:'V1',parameter:'voltage',start:0,end:10,points:11,scale:'linear',outputNode:'R1:b',measurement:'voltage'},plugins());expect(r.sweepValues.length).toBe(11);expect(r.outputValues[0]).toBeCloseTo(0,2);expect(r.outputValues[10]).toBeCloseTo(5,2);});
});
