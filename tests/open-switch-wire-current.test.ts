import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, simulateStep, computeWireCurrents } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); });
function comp(t:string,id:string,p?:any):CircuitComponent{const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string):Wire{return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins():Map<string,ComponentPlugin>{return new Map(getAllPlugins().map(p=>[p.type,p]));}
const V=1e-12;
describe('Open switch wire current', () => {
  it('AND gate: btnA pressed, btnB open → btnB wires show zero', () => {
    const p=plugins();
    const c=[comp('dcVoltage','vA',{voltage:5}),comp('dcVoltage','vB',{voltage:5}),comp('pushButton','btnA',{pressed:true}),comp('pushButton','btnB',{pressed:false}),comp('and','g1',{vcc:5,threshold:2.5}),comp('resistor','r1',{resistance:330}),comp('led','led1',{color:'green',forwardV:2,seriesR:1}),comp('ground','gnd1')];
    const w=[wire('w1','vA','p','btnA','a'),wire('w2','btnA','b','g1','a'),wire('w3','vB','p','btnB','a'),wire('w4','btnB','b','g1','b'),wire('w5','g1','y','r1','a'),wire('w6','r1','b','led1','a'),wire('w7','led1','k','gnd1','g'),wire('w8','vA','n','gnd1','g'),wire('w9','vB','n','gnd1','g'),wire('w10','g1','gnd','gnd1','g')];
    const dc=solveDC(c,w,p); expect(dc).not.toBeNull();
    const r=simulateStep(c,w,p,{nodeVoltage:dc!.nodeVoltage,branchCurrent:dc!.branchCurrent,time:0,state:dc!.state},1e-4); expect(r).not.toBeNull();
    const wc=computeWireCurrents(c,w,p,r!.sim);
    expect(Math.abs(wc.get('w3')!)).toBeLessThan(V);
    expect(Math.abs(wc.get('w4')!)).toBeLessThan(V);
  });
  it('SPST switch open: wires show zero', () => {
    const p=plugins();
    const c=[comp('dcVoltage','v1',{voltage:5}),comp('switch','sw1',{closed:false}),comp('resistor','r1',{resistance:1000}),comp('ground','gnd1')];
    const w=[wire('w1','v1','p','sw1','a'),wire('w2','sw1','b','r1','a'),wire('w3','r1','b','gnd1','g'),wire('w4','v1','n','gnd1','g')];
    const dc=solveDC(c,w,p); if(!dc)return;
    const r=simulateStep(c,w,p,{nodeVoltage:dc.nodeVoltage,branchCurrent:dc.branchCurrent,time:0,state:dc.state},1e-4); if(!r)return;
    const wc=computeWireCurrents(c,w,p,r.sim);
    for(const wi of w){expect(Math.abs(wc.get(wi.id)??0)).toBeLessThan(V);}
  });
});
