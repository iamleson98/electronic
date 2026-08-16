import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, buildNodeMap, computeComponentCurrents, computeWireCurrents } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); await import('../src/lib/circuit/components/advanced'); });
function comp(t:string,id:string,p?:any):CircuitComponent{const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string):Wire{return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins():Map<string,ComponentPlugin>{return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('Voltage divider foundation', () => {
  it('5V → 1k+1k → Vmid=2.5V, I=2.5mA', () => {
    const p=plugins();
    const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('resistor','R2',{resistance:1000}),comp('ground','GND')];
    const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','GND','g'),wire('w4','V1','n','GND','g')];
    const dc=solveDC(c,w,p); expect(dc).not.toBeNull();
    const nm=buildNodeMap(c,w,p); const mid=nm.terminalNode.get('R1:b')!;
    expect(dc!.nodeVoltage[mid]).toBeCloseTo(2.5,4);
    const cc=computeComponentCurrents(c,w,p,dc!);
    expect(cc.get('V1')!).toBeCloseTo(0.0025,6);
  });
  it('Potentiometer: V_wiper=2.0V with load', () => {
    const p=plugins();
    const c=[comp('dcVoltage','V1',{voltage:5}),comp('potentiometer','POT',{resistance:10000,wiper:50}),comp('resistor','R1',{resistance:10000}),comp('ground','GND')];
    const w=[wire('w1','V1','p','POT','a'),wire('w2','V1','n','GND','g'),wire('w3','POT','b','GND','g'),wire('w4','POT','w','R1','a'),wire('w5','R1','b','GND','g')];
    const dc=solveDC(c,w,p); expect(dc).not.toBeNull();
    const nm=buildNodeMap(c,w,p); const wp=nm.terminalNode.get('POT:w')!;
    expect(dc!.nodeVoltage[wp]).toBeCloseTo(2.0,1);
  });
});
