import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); await import('../src/lib/circuit/components/advanced'); });
function comp(t:string,id:string,p?:any):CircuitComponent{const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string):Wire{return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins():Map<string,ComponentPlugin>{return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('Floating input bug', () => {
  it('AND gate: one button open → Y = LOW', () => {
    const p = plugins();
    const c = [comp('dcVoltage','vA',{voltage:5}),comp('dcVoltage','vB',{voltage:5}),comp('pushButton','btnA',{pressed:true}),comp('pushButton','btnB',{pressed:false}),comp('and','g1',{vcc:5,threshold:2.5}),comp('resistor','r1',{resistance:330}),comp('led','led1',{color:'green',forwardV:2,seriesR:1}),comp('ground','gnd1')];
    const w = [wire('w1','vA','p','btnA','a'),wire('w2','btnA','b','g1','a'),wire('w3','vB','p','btnB','a'),wire('w4','btnB','b','g1','b'),wire('w5','g1','y','r1','a'),wire('w6','r1','b','led1','a'),wire('w7','led1','k','gnd1','g'),wire('w8','vA','n','gnd1','g'),wire('w9','vB','n','gnd1','g'),wire('w10','g1','gnd','gnd1','g')];
    const dc = solveDC(c, w, p);
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, p);
    const y = nm.terminalNode.get('g1:y')!;
    expect(dc!.nodeVoltage[y]).toBeCloseTo(0, 2);
  });
  it('AND gate: both buttons pressed → Y = HIGH', () => {
    const p = plugins();
    const c = [comp('dcVoltage','vA',{voltage:5}),comp('dcVoltage','vB',{voltage:5}),comp('pushButton','btnA',{pressed:true}),comp('pushButton','btnB',{pressed:true}),comp('and','g1',{vcc:5,threshold:2.5}),comp('resistor','r1',{resistance:330}),comp('led','led1',{color:'green',forwardV:2,seriesR:1}),comp('ground','gnd1')];
    const w = [wire('w1','vA','p','btnA','a'),wire('w2','btnA','b','g1','a'),wire('w3','vB','p','btnB','a'),wire('w4','btnB','b','g1','b'),wire('w5','g1','y','r1','a'),wire('w6','r1','b','led1','a'),wire('w7','led1','k','gnd1','g'),wire('w8','vA','n','gnd1','g'),wire('w9','vB','n','gnd1','g'),wire('w10','g1','gnd','gnd1','g')];
    const dc = solveDC(c, w, p);
    expect(dc).not.toBeNull();
    const nm = buildNodeMap(c, w, p);
    const y = nm.terminalNode.get('g1:y')!;
    expect(dc!.nodeVoltage[y]).toBeCloseTo(5, 2);
  });
  it('NMOS with unconnected gate: solves', () => {
    const p = plugins();
    const c = [comp('dcVoltage','v1',{voltage:5}),comp('nmos','q1',{vth:2}),comp('resistor','r1',{resistance:1000}),comp('ground','gnd1')];
    const w = [wire('w1','v1','p','r1','a'),wire('w2','r1','b','q1','d'),wire('w3','q1','s','gnd1','g'),wire('w4','v1','n','gnd1','g')];
    const dc = solveDC(c, w, p);
    expect(dc).not.toBeNull();
  });
  it('Op-amp with unconnected inputs: solves', () => {
    const p = plugins();
    const c = [comp('opamp','op1',{gain:1e5}),comp('resistor','r1',{resistance:1000}),comp('ground','gnd1')];
    const w = [wire('w1','op1','out','r1','a'),wire('w2','r1','b','gnd1','g')];
    const dc = solveDC(c, w, p);
    expect(dc).not.toBeNull();
  });
});
