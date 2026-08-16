import { describe, it, expect, beforeAll } from 'vitest';
import { cleanupComponentState, compactTraces, getMemoryStats, MemoryMonitor } from '../src/lib/circuit/memory';
import { simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); });
function comp(t:string,id:string,p?:any){const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string){return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins(){return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('Memory', () => {
  it('cleanupComponentState: removes orphaned cap state', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('capacitor','C1',{capacitance:1e-6}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','C1','a'),wire('w3','C1','b','GND','g'),wire('w4','V1','n','GND','g')];let prev:any;let sim:any=null;for(let i=0;i<5;i++){const r=simulateStep(c,w,p,prev,1e-4);if(!r)break;sim=r.sim;prev={nodeVoltage:r.sim.nodeVoltage,branchCurrent:r.sim.branchCurrent,time:r.sim.time,state:r.sim.state};}expect(sim.state.__global['cap_C1']).toBeDefined();const removed=cleanupComponentState(sim,c.filter(x=>x.id!=='C1'));expect(removed).toBeGreaterThanOrEqual(1);});
  it('compactTraces: removes oldest', () => { const t:any[]=[{componentId:'o',color:'',label:'',samples:Array.from({length:1500},(_,i)=>({time:i,voltage:i}))}];const r=compactTraces(t,1000);expect(r).toBe(500);expect(t[0].samples.length).toBe(1000);});
  it('getMemoryStats: returns stats', () => { const s=getMemoryStats();expect(s).toBeDefined();});
  it('MemoryMonitor: snapshot', () => { const m=new MemoryMonitor();m.snapshot();expect(m.getSnapshots().length).toBe(1);});
  it('MemoryMonitor: reset', () => { const m=new MemoryMonitor();m.snapshot();m.reset();expect(m.getSnapshots().length).toBe(0);});
});
