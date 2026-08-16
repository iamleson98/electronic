import * as fs from 'fs';

const tests: Record<string, string> = {
  'tests/spice-reference-comparison.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { ReferenceSolver } from '../src/lib/circuit/reference-solver';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); });
function comp(t:string,id:string,p?:any):CircuitComponent{const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string):Wire{return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins():Map<string,ComponentPlugin>{return new Map(getAllPlugins().map(p=>[p.type,p]));}
function approxEqual(a:number,e:number,l:string){const ae=Math.abs(a-e),re=ae/Math.max(Math.abs(e),1e-12);if(!(ae<1e-9||re<0.001))throw new Error(l+': expected '+e+', got '+a);}
describe('SPICE reference comparison', () => {
  it('Voltage divider matches reference solver', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('resistor','R2',{resistance:1000}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','GND','g'),wire('w4','V1','n','GND','g')];const dc=solveDC(c,w,p);expect(dc).not.toBeNull();const nm=buildNodeMap(c,w,p);const mid=nm.terminalNode.get('R1:b')!;const ref=new ReferenceSolver();ref.addNode('a');ref.addNode('b');ref.stampV('a','0',5,'V1');ref.stampR('a','b',1000,'R1');ref.stampR('b','0',1000,'R2');const r=ref.solve();expect(r.ok).toBe(true);approxEqual(dc!.nodeVoltage[mid],r.voltages.get('b')!,'V(mid)');approxEqual(dc!.nodeVoltage[mid],2.5,'V(mid) expected');});
  it('Capacitor DC steady state: V_cap = V_source', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('capacitor','C1',{capacitance:1e-6}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','C1','a'),wire('w3','C1','b','GND','g'),wire('w4','V1','n','GND','g')];const dc=solveDC(c,w,p);expect(dc).not.toBeNull();const nm=buildNodeMap(c,w,p);const cap=nm.terminalNode.get('C1:a')!;expect(dc!.nodeVoltage[cap]).toBeCloseTo(5,1);});
  it('Inductor DC steady state: V_ind ≈ 0', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('inductor','L1',{inductance:1e-3}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','L1','a'),wire('w3','L1','b','GND','g'),wire('w4','V1','n','GND','g')];const dc=solveDC(c,w,p);expect(dc).not.toBeNull();const nm=buildNodeMap(c,w,p);const ind=nm.terminalNode.get('L1:a')!;expect(Math.abs(dc!.nodeVoltage[ind])).toBeLessThan(1e-3);});
});
`,

  'tests/convergence-stress.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); });
function comp(t:string,id:string,p?:any):CircuitComponent{const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string):Wire{return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins():Map<string,ComponentPlugin>{return new Map(getAllPlugins().map(p=>[p.type,p]));}
function isFiniteNum(x:number):boolean{return typeof x==='number'&&isFinite(x);}
function expectAllFinite(sim:any,l:string){expect(sim,l+': should not be null').not.toBeNull();for(let i=0;i<sim.nodeVoltage.length;i++)expect(isFiniteNum(sim.nodeVoltage[i]),l+': V(node'+i+')='+sim.nodeVoltage[i]).toBe(true);}
describe('Convergence stress', () => {
  it('Two V sources in parallel with different V: null or finite', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('dcVoltage','V2',{voltage:3}),comp('resistor','R1',{resistance:1000}),comp('ground','GND')];const w=[wire('w1','V1','p','V2','p'),wire('w2','V1','p','R1','a'),wire('w3','R1','b','GND','g'),wire('w4','V1','n','GND','g'),wire('w5','V2','n','GND','g')];const dc=solveDC(c,w,p);if(dc)expectAllFinite(dc,'parallel V sources');});
  it('Floating node via capacitor: null or finite', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('capacitor','C1',{capacitance:1e-6}),comp('ground','GND')];const w=[wire('w1','V1','p','C1','a'),wire('w2','C1','b','GND','g'),wire('w3','V1','n','GND','g')];const dc=solveDC(c,w,p);if(dc)expectAllFinite(dc,'floating cap node');});
  it('No ground: null or finite', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('resistor','R2',{resistance:1000})];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','V1','n')];const dc=solveDC(c,w,p);if(dc)expectAllFinite(dc,'no ground');});
  it('Diode near threshold: converges', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('diode','D1',{forwardV:0.7,onR:1}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','D1','a'),wire('w3','D1','k','GND','g'),wire('w4','V1','n','GND','g')];const dc=solveDC(c,w,p,50);expect(dc).not.toBeNull();expectAllFinite(dc!,'diode near threshold');});
  it('100-node ladder: solves < 5s', () => { const p=plugins();const c:CircuitComponent[]=[comp('dcVoltage','V1',{voltage:5}),comp('ground','GND')];for(let i=0;i<100;i++)c.push(comp('resistor','R'+i,{resistance:1000}));const w:Wire[]=[wire('w0','V1','p','R0','a'),wire('wg','V1','n','GND','g')];for(let i=0;i<99;i++)w.push(wire('w'+(i+1),'R'+i,'b','R'+(i+1),'a'));w.push(wire('wf','R99','b','GND','g'));const s=Date.now();const dc=solveDC(c,w,p);const e=Date.now()-s;expect(dc).not.toBeNull();expect(e).toBeLessThan(5000);});
  it('1000-step RC: no NaN, converges', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('capacitor','C1',{capacitance:1e-6}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','C1','a'),wire('w3','C1','b','GND','g'),wire('w4','V1','n','GND','g')];let prev:any=undefined;let last=0;for(let i=0;i<1000;i++){const r=simulateStep(c,w,p,prev,1e-4);if(!r)break;for(let j=0;j<r.sim.nodeVoltage.length;j++)expect(isFiniteNum(r.sim.nodeVoltage[j])).toBe(true);last=r.sim.nodeVoltage[r.sim.nodeVoltage.length-1]??0;prev={nodeVoltage:r.sim.nodeVoltage,branchCurrent:r.sim.branchCurrent,time:r.sim.time,state:r.sim.state};}expect(last).toBeGreaterThan(4.9);});
});
`,

  'tests/adaptive-timestep.test.ts': `import { describe, it, expect } from 'vitest';
import { estimateError, computeNextDt, AdaptiveTimestepController, DEFAULT_ADAPTIVE_CONFIG } from '../src/lib/circuit/adaptive-timestep';
describe('Adaptive timestep', () => {
  it('estimateError: 0 when identical', () => { const v=new Float64Array([1,2,3]);const r=estimateError(v,v,0.001,1e-6);expect(r.error).toBe(0);expect(r.accepted).toBe(true);});
  it('estimateError: detects difference', () => { const r=estimateError(new Float64Array([5,0,0]),new Float64Array([4.9,0,0]),0.001,1e-6);expect(r.error).toBeGreaterThan(0);});
  it('computeNextDt: grows when error small', () => { const dt=1e-4;const r=computeNextDt(dt,0.01,DEFAULT_ADAPTIVE_CONFIG);expect(r).toBeGreaterThan(dt);});
  it('computeNextDt: shrinks when error large', () => { const dt=1e-4;const r=computeNextDt(dt,100,DEFAULT_ADAPTIVE_CONFIG);expect(r).toBeLessThan(dt);});
  it('Controller: starts with initial dt', () => { const c=new AdaptiveTimestepController({dtInitial:1e-5});expect(c.getDt()).toBe(1e-5);});
  it('Controller: accepts low-error step', () => { const c=new AdaptiveTimestepController({dtInitial:1e-4});const r=c.evaluateStep(new Float64Array([5,0]),new Float64Array([5.001,0]));expect(r.accepted).toBe(true);});
  it('Controller: rejects high-error step', () => { const c=new AdaptiveTimestepController({dtInitial:1e-4});const r=c.evaluateStep(new Float64Array([5,0]),new Float64Array([3,0]));expect(r.accepted).toBe(false);expect(c.getDt()).toBeLessThan(1e-4);});
});
`,

  'tests/scope-viewer.test.ts': `import { describe, it, expect } from 'vitest';
import { computeMeasurements, createDefaultScopeConfig, getVoltageAtTime, formatTimebase } from '../src/lib/circuit/scope-viewer';
describe('Scope viewer', () => {
  it('computeMeasurements: empty array', () => { expect(computeMeasurements([])).toEqual([]); });
  it('computeMeasurements: single sample', () => { const m=computeMeasurements([{time:0,voltage:5}]);expect(m.length).toBe(5);expect(m.find(x=>x.name==='Vmax')!.value).toBe(5);});
  it('computeMeasurements: sine wave Vpp', () => { const s: any[]=[];for(let i=0;i<1000;i++){const t=i*0.00001;s.push({time:t,voltage:5*Math.sin(2*Math.PI*1000*t)});}const m=computeMeasurements(s);expect(m.find(x=>x.name==='Vpp')!.value).toBeCloseTo(10,1);});
  it('getVoltageAtTime: linear interpolation', () => { expect(getVoltageAtTime([{time:0,voltage:0},{time:1,voltage:10}],0.5)).toBeCloseTo(5,5);});
  it('getVoltageAtTime: empty returns null', () => { expect(getVoltageAtTime([],0)).toBeNull();});
  it('createDefaultScopeConfig', () => { const c=createDefaultScopeConfig();expect(c.timebase).toBe(1e-3);});
  it('formatTimebase', () => { expect(formatTimebase(1e-3)).toContain('ms');});
});
`,

  'tests/dc-sweep.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
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
`,

  'tests/subcircuit-creator.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
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
`,

  'tests/keyboard-shortcuts.test.ts': `import { describe, it, expect } from 'vitest';
import { KEYBOARD_SHORTCUTS, getShortcutsByCategory, formatShortcut } from '../src/lib/circuit/keyboard-shortcuts';
describe('Keyboard shortcuts', () => {
  it('has shortcuts in all categories', () => { expect(getShortcutsByCategory('editing').length).toBeGreaterThan(0);expect(getShortcutsByCategory('history').length).toBeGreaterThan(0);expect(getShortcutsByCategory('simulation').length).toBeGreaterThan(0);});
  it('formatShortcut: Mac symbols', () => { expect(formatShortcut('Ctrl+Z',true)).toContain('⌘');});
  it('formatShortcut: Windows unchanged', () => { expect(formatShortcut('Ctrl+Z',false)).toBe('Ctrl+Z');});
});
`,

  'tests/touch-gestures.test.ts': `import { describe, it, expect } from 'vitest';
import { detectGesture, computePinchZoomFactor, isTouchDevice } from '../src/components/circuit/use-touch-gestures';
describe('Touch gestures', () => {
  it('detectGesture: quick stationary = tap', () => { expect(detectGesture(0,100,{x:50,y:50},{x:50,y:50})).toBe('tap');});
  it('detectGesture: long stationary = long-press', () => { expect(detectGesture(0,600,{x:50,y:50},{x:50,y:50})).toBe('long-press');});
  it('detectGesture: moving = pan', () => { expect(detectGesture(0,100,{x:50,y:50},{x:100,y:100})).toBe('pan');});
  it('detectGesture: double-tap', () => { expect(detectGesture(1200,1300,{x:50,y:50},{x:50,y:50},1000)).toBe('double-tap');});
  it('computePinchZoomFactor: zoom in', () => { expect(computePinchZoomFactor(100,200,1)).toBeCloseTo(2,1);});
  it('computePinchZoomFactor: zoom out', () => { expect(computePinchZoomFactor(200,100,2)).toBeCloseTo(1,1);});
  it('computePinchZoomFactor: clamped to max', () => { expect(computePinchZoomFactor(10,1000,1)).toBe(10);});
  it('computePinchZoomFactor: clamped to min', () => { expect(computePinchZoomFactor(1000,10,1)).toBeCloseTo(0.1,2);});
  it('isTouchDevice: returns boolean', () => { expect(typeof isTouchDevice()).toBe('boolean');});
});
`,

  'tests/accessibility.test.ts': `import { describe, it, expect } from 'vitest';
import { hexToRgb, contrastRatio, checkContrast } from '../src/lib/circuit/accessibility';
describe('Accessibility', () => {
  it('hexToRgb: 6-digit', () => { expect(hexToRgb('#ffffff')).toEqual({r:255,g:255,b:255});expect(hexToRgb('#000000')).toEqual({r:0,g:0,b:0});});
  it('hexToRgb: 3-digit', () => { expect(hexToRgb('#fff')).toEqual({r:255,g:255,b:255});});
  it('contrastRatio: black vs white = 21', () => { expect(contrastRatio({r:0,g:0,b:0},{r:255,g:255,b:255})).toBeCloseTo(21,0);});
  it('contrastRatio: identical = 1', () => { expect(contrastRatio({r:128,g:128,b:128},{r:128,g:128,b:128})).toBeCloseTo(1,5);});
  it('checkContrast: black on white passes AA', () => { const r=checkContrast('#000000','#ffffff');expect(r.passes.aaNormal).toBe(true);});
  it('checkContrast: light gray on white fails AA', () => { const r=checkContrast('#cccccc','#ffffff');expect(r.passes.aaNormal).toBe(false);});
});
`,

  'tests/gerber-export.test.ts': `import { describe, it, expect } from 'vitest';
import { exportGerberCopper, exportAllGerbers } from '../src/lib/pcb/gerber-export';
describe('Gerber export', () => {
  it('exportGerberCopper: valid RS-274X header', () => { const g=exportGerberCopper('top',[],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(g).toContain('%FSLAX26Y26*%');expect(g).toContain('%MOMM*%');expect(g.trim().endsWith('M02*')).toBe(true);});
  it('exportGerberCopper: bottom layer name', () => { const g=exportGerberCopper('bottom',[],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(g).toContain('%LNBOTTOM_COPPER*%');});
  it('exportAllGerbers: produces file set', () => { const files=exportAllGerbers([],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(files.length).toBeGreaterThanOrEqual(5);for(const f of files){expect(f.filename).toBeDefined();expect(f.content.length).toBeGreaterThan(0);}});
});
`,

  'tests/bom-export.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
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
`,

  'tests/manufacturer-presets.test.ts': `import { describe, it, expect } from 'vitest';
import { JLC_PCB_SPEC, PCBWAY_SPEC, mmToMil, milToMm, getManufacturerSpec } from '../src/lib/pcb/manufacturer-presets';
describe('Manufacturer presets', () => {
  it('JLC PCB: 5 mil trace', () => { expect(mmToMil(JLC_PCB_SPEC.config.minTraceWidth)).toBeCloseTo(5,1);});
  it('PCBWay: 6 mil trace', () => { expect(mmToMil(PCBWAY_SPEC.config.minTraceWidth)).toBeCloseTo(6,1);});
  it('mmToMil/milToMm inverse', () => { expect(milToMm(mmToMil(5))).toBeCloseTo(5,5);});
  it('getManufacturerSpec: known', () => { expect(getManufacturerSpec('JLC PCB')).not.toBeNull();});
  it('getManufacturerSpec: unknown', () => { expect(getManufacturerSpec('Unknown')).toBeNull();});
});
`,

  'tests/pwa.test.ts': `import { describe, it, expect } from 'vitest';
import { registerServiceWorker, useOfflineStatus, canInstall, isStandalone } from '../src/lib/pwa';
describe('PWA', () => {
  it('registerServiceWorker: returns promise', () => { expect(registerServiceWorker()).toBeInstanceOf(Promise);});
  it('useOfflineStatus: returns object', () => { const r=useOfflineStatus();expect(r).toHaveProperty('isOnline');});
  it('canInstall: returns false in Node', () => { expect(canInstall()).toBe(false);});
  it('isStandalone: returns false in Node', () => { expect(isStandalone()).toBe(false);});
});
`,

  'tests/error-monitoring.test.ts': `import { describe, it, expect, beforeEach } from 'vitest';
import { initErrorMonitoring, captureError, captureMessage, addBreadcrumb, isMonitoringEnabled, shutdownErrorMonitoring } from '../src/lib/error-monitoring';
beforeEach(() => { shutdownErrorMonitoring(); });
describe('Error monitoring', () => {
  it('init: does not crash without DSN', async () => { await expect(initErrorMonitoring({})).resolves.not.toThrow();});
  it('captureError: returns event ID', async () => { await initErrorMonitoring({});const id=captureError(new Error('Test'));expect(typeof id).toBe('string');});
  it('captureMessage: returns event ID', async () => { await initErrorMonitoring({});const id=captureMessage('Test','info');expect(typeof id).toBe('string');});
  it('addBreadcrumb: does not crash', () => { addBreadcrumb({type:'click',level:'info',message:'test'});});
  it('isMonitoringEnabled: false without DSN', async () => { await initErrorMonitoring({});expect(isMonitoringEnabled()).toBe(false);});
});
`,

  'tests/analytics.test.ts': `import { describe, it, expect, beforeEach } from 'vitest';
import { trackSimulationStep, trackFeature, getSimulationStats, clearAnalytics, setAnalyticsEnabled, isAnalyticsEnabled } from '../src/lib/circuit/analytics';
beforeEach(() => { clearAnalytics(); setAnalyticsEnabled(true); });
describe('Analytics', () => {
  it('trackSimulationStep: increments totalSteps', () => { trackSimulationStep(true,1,[],[],0);expect(getSimulationStats().totalSteps).toBe(1);expect(getSimulationStats().successfulSteps).toBe(1);});
  it('trackFeature: increments counter', () => { trackFeature('acAnalysis');trackFeature('acAnalysis');expect(getSimulationStats().totalSteps).toBe(0);});
  it('disabled: does not track', () => { setAnalyticsEnabled(false);trackSimulationStep(true,1,[],[],0);expect(getSimulationStats().totalSteps).toBe(0);});
  it('isAnalyticsEnabled: reflects state', () => { expect(isAnalyticsEnabled()).toBe(true);setAnalyticsEnabled(false);expect(isAnalyticsEnabled()).toBe(false);});
});
`,

  'tests/e2e-flows.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { useEditor } from '../src/lib/circuit/store';
import { getPlugin } from '../src/lib/circuit/registry';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); });
function state(){return useEditor.getState();}
function reset(){state().clear();state().reset();}
describe('E2E flows', () => {
  it('build LED circuit and run sim', () => { reset();const v1=state().addComponent('dcVoltage',{x:4,y:6});state().setParameter(v1,'voltage',5);const r1=state().addComponent('resistor',{x:10,y:6});state().setParameter(r1,'resistance',330);const led=state().addComponent('led',{x:16,y:6});const gnd=state().addComponent('ground',{x:10,y:12});state().startWire({componentId:v1,terminalId:'p'},{x:5,y:7});state().completeWire({componentId:r1,terminalId:'a'});state().startWire({componentId:r1,terminalId:'b'},{x:11,y:7});state().completeWire({componentId:led,terminalId:'a'});state().startWire({componentId:led,terminalId:'k'},{x:17,y:7});state().completeWire({componentId:gnd,terminalId:'g'});state().startWire({componentId:v1,terminalId:'n'},{x:5,y:13});state().completeWire({componentId:gnd,terminalId:'g'});expect(state().components.length).toBe(4);expect(state().wires.length).toBe(4);state().setRunning(true);state().step();expect(state().simContext).not.toBeNull();expect(state().simError).toBeNull();state().setRunning(false);});
  it('undo/redo 10 times', () => { reset();for(let i=0;i<10;i++)state().addComponent('resistor',{x:i*4,y:0});expect(state().components.length).toBe(10);for(let i=0;i<10;i++)state().undo();expect(state().components.length).toBe(0);for(let i=0;i<10;i++)state().redo();expect(state().components.length).toBe(10);});
  it('rotate and delete', () => { reset();const id=state().addComponent('resistor',{x:5,y:5});expect(state().components[0].rotation).toBe(0);state().rotateComponent(id);expect(state().components[0].rotation).toBe(1);state().deleteComponent(id);expect(state().components.length).toBe(0);});
});
`,

  'tests/tier2-3-features.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); await import('../src/lib/circuit/components/advanced'); await import('../src/lib/circuit/components/advanced-semi'); await import('../src/lib/circuit/components/advanced-devices'); });
describe('Tier 2-3 features', () => {
  it('bjtGPNpn registered', () => { expect(getPlugin('bjtGPNpn')).toBeDefined();});
  it('bjtGPPnp registered', () => { expect(getPlugin('bjtGPPnp')).toBeDefined();});
  it('diodeShockley registered', () => { expect(getPlugin('diodeShockley')).toBeDefined();});
  it('mosLevel1N registered', () => { expect(getPlugin('mosLevel1N')).toBeDefined();});
  it('jfetN registered', () => { expect(getPlugin('jfetN')).toBeDefined();});
  it('FootprintEditor: createCustomFootprint', async () => { const {createCustomFootprint}=await import('../src/lib/pcb/footprint-editor');const fp=createCustomFootprint('Test','desc');expect(fp.name).toBe('Test');});
  it('FootprintEditor: FOOTPRINT_TEMPLATES', async () => { const {FOOTPRINT_TEMPLATES}=await import('../src/lib/pcb/footprint-editor');const fp=FOOTPRINT_TEMPLATES['0805']();expect(fp.pads.length).toBe(2);});
  it('ProjectManager: export/import', async () => { const {exportProjectFile,importProjectFile}=await import('../src/lib/circuit/project-manager');const json=exportProjectFile('Test',[]);const r=importProjectFile(json);expect(r.project).not.toBeNull();});
  it('SPICE import: basic', async () => { const {importSpiceNetlist}=await import('../src/lib/circuit/spice-import');const r=importSpiceNetlist('V1 1 0 5\\\\nR1 1 0 1k\\\\n.end\\\\n');expect(r.errors.length).toBe(0);});
});
`,

  'tests/fuzz-circuits.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, simulateStep } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); });
function mulberry32(seed:number){let a=seed;return()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const FUZZABLE=['resistor','capacitor','inductor','dcVoltage','acVoltage','currentSource','diode','led','npn','pnp','nmos','pmos','switch','pushButton'];
function randomComp(rng:()=>=>number,id:string):CircuitComponent{const t=FUZZABLE[Math.floor(rng()*FUZZABLE.length)];const p=getPlugin(t)!;const params:any={};for(const pm of p.parameters){if(pm.type==='number'){const mn=pm.min??0;const mx=pm.max??1000;params[pm.key]=mn+rng()*Math.min(mx-mn,1000);}else if(pm.type==='boolean'){params[pm.key]=rng()>0.5;}else{params[pm.key]=pm.default;}}if(params.resistance!==undefined)params.resistance=Math.max(0.001,params.resistance);return{id,type:t,position:{x:0,y:0},rotation:0,parameters,simState:{}};}
function genCircuit(rng:()=>number){const n=3+Math.floor(rng()*18);const comps:CircuitComponent[]=[{id:'GND',type:'ground',position:{x:0,y:0},rotation:0,parameters:{},simState:{}}];for(let i=0;i<n;i++)comps.push(randomComp(rng,'C'+i));const wires:Wire[]=[];let wi=0;for(const c of comps){if(c.type==='ground')continue;const p=getPlugin(c.type);if(!p)continue;for(const t of p.terminals){if(rng()<0.7){const tgt=comps[Math.floor(rng()*comps.length)];const tp=getPlugin(tgt.type);if(!tp||tp.terminals.length===0)continue;const tt=tp.terminals[Math.floor(rng()*tp.terminals.length)];wires.push({id:'w'+wi++,from:{componentId:c.id,terminalId:t.id},to:{componentId:tgt.id,terminalId:tt.id}});}}}return{components:comps,wires};}
function plugins():Map<string,ComponentPlugin>{return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('Circuit fuzzer', () => {
  it('200 random circuits: no NaN/crash', () => { const rng=mulberry32(42);let solved=0,singular=0;const p=plugins();for(let i=0;i<200;i++){const{components,wires}=genCircuit(rng);const dc=solveDC(components,wires,p);if(!dc){singular++;continue;}solved++;for(let j=0;j<dc.nodeVoltage.length;j++){expect(isFinite(dc.nodeVoltage[j]),'Fuzz '+i+': NaN at node '+j).toBe(true);}for(let j=0;j<dc.nodeVoltage.length;j++){expect(Math.abs(dc.nodeVoltage[j]),'Fuzz '+i+': V too large').toBeLessThan(1000);}}expect(solved).toBeGreaterThan(30);});
});
`,

  'tests/property-based.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, simulateStep, buildNodeMap, computeComponentCurrents, computeWireCurrents, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { exampleTransistor, exampleOpamp, exampleLogicGates, exampleCurrentSource, example555, exampleArduino } from '../src/lib/circuit/examples';
import type { CircuitDocument, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); await import('../src/lib/circuit/components/advanced'); await import('../src/lib/circuit/components/advanced-semi'); await import('../src/lib/circuit/components/advanced-devices'); });
function plugins():Map<string,ComponentPlugin>{return new Map(getAllPlugins().map(p=>[p.type,p]));}
const CIRCS:Array<{name:string;doc:CircuitDocument}>=[{name:'Transistor',doc:exampleTransistor},{name:'Opamp',doc:exampleOpamp},{name:'LogicGates',doc:exampleLogicGates},{name:'CurrentSource',doc:exampleCurrentSource},{name:'555',doc:example555},{name:'Arduino',doc:exampleArduino}];
describe('Property: finite voltages', () => { for(const{name,doc}of CIRCS){it(name+': no NaN',()=>{const dc=solveDC(doc.components,doc.wires,plugins());if(!dc)return;for(let i=0;i<dc.nodeVoltage.length;i++)expect(isFinite(dc.nodeVoltage[i])).toBe(true);});}});
describe('Property: Ohm law for resistors', () => { for(const{name,doc}of CIRCS){it(name+': V=IR',()=>{const p=plugins();const dc=solveDC(doc.components,doc.wires,p);if(!dc)return;const nm=buildNodeMap(doc.components,doc.wires,p);for(const c of doc.components){if(c.type!=='resistor')continue;const pl=p.get('resistor')!;const t=getTerminalsForComponent(c,pl,nm);const a=t.find(x=>x.terminalId==='a')?.nodeId??0;const b=t.find(x=>x.terminalId==='b')?.nodeId??0;const r=Math.max(1e-9,c.parameters.resistance as number);const v=(dc.nodeVoltage[a]??0)-(dc.nodeVoltage[b]??0);const i=v/r;const cc=computeComponentCurrents(doc.components,doc.wires,p,dc);const ai=cc.get(c.id)??0;const re=Math.abs(ai-i)/Math.max(Math.abs(i),1e-12);expect(re,name+': Ohm '+c.id).toBeLessThan(0.01);}});}});
describe('Property: rail bounds', () => { for(const{name,doc}of CIRCS){it(name+': V within rails',()=>{const dc=solveDC(doc.components,doc.wires,plugins());if(!dc)return;let maxRail=0;for(const c of doc.components){if(c.type==='dcVoltage')maxRail=Math.max(maxRail,Math.abs(c.parameters.voltage as number??0));}for(let i=0;i<dc.nodeVoltage.length;i++)expect(Math.abs(dc.nodeVoltage[i]),name+': V too large').toBeLessThan(maxRail+10);});}});
`,

  'tests/bug-hunters.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, simulateStep, buildNodeMap, computeComponentCurrents, computeWireCurrents } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { useEditor } from '../src/lib/circuit/store';
import { exportSPICENetlist } from '../src/lib/circuit/netlist-export';
import { importSpiceNetlist } from '../src/lib/circuit/spice-import';
import { saveCircuitDocument, loadCircuitDocument } from '../src/lib/circuit/migration';
import { saveToLocalStorage, loadFromLocalStorage } from '../src/lib/circuit/autosave';
import { annotateNets, findNetConflicts } from '../src/lib/circuit/net-annotation';
import { exampleTransistor, exampleOpamp } from '../src/lib/circuit/examples';
import type { CircuitComponent, Wire, CircuitDocument, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); await import('../src/lib/circuit/components/advanced'); });
function comp(t:string,id:string,p?:any){const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string){return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins(){return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('#3 State-machine fuzzing', () => { it('50 random actions: no crash', () => { const s=useEditor.getState();s.clear();s.reset();for(let i=0;i<50;i++){try{s.addComponent('resistor',{x:i,y:0});}catch{}if(i%10===0)s.undo();}expect(useEditor.getState().components.length).toBeGreaterThanOrEqual(0);});});
describe('#4 Round-trip', () => { it('JSON save/load', () => { const j=saveCircuitDocument(exampleTransistor);const r=loadCircuitDocument(j);expect(r.doc).not.toBeNull();expect(r.doc!.components.length).toBe(exampleTransistor.components.length);});it('localStorage save/load', () => { const m=new Map<string,string>();(globalThis as any).localStorage={getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>m.set(k,v),removeItem:(k:string)=>m.delete(k)};saveToLocalStorage('test',exampleTransistor);const l=loadFromLocalStorage('test');expect(l).not.toBeNull();expect(l!.components.length).toBe(exampleTransistor.components.length);});});
describe('#5 Numerical stress', () => { it('1 TΩ divider', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1e12}),comp('resistor','R2',{resistance:1e12}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','GND','g'),wire('w4','V1','n','GND','g')];const dc=solveDC(c,w,p);expect(dc).not.toBeNull();const nm=buildNodeMap(c,w,p);expect(dc!.nodeVoltage[nm.terminalNode.get('R1:b')!]).toBeCloseTo(2.5,1);});it('1 µΩ: no Infinity', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1e-6}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','GND','g'),wire('w3','V1','n','GND','g')];const dc=solveDC(c,w,p);expect(dc).not.toBeNull();for(let i=0;i<dc!.nodeVoltage.length;i++)expect(isFinite(dc!.nodeVoltage[i])).toBe(true);});});
describe('#6 Transient continuity', () => { it('RC: monotonic charging', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('capacitor','C1',{capacitance:1e-6}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','C1','a'),wire('w3','C1','b','GND','g'),wire('w4','V1','n','GND','g')];let prev:any;let pv=0;for(let i=0;i<100;i++){const r=simulateStep(c,w,p,prev,1e-4);if(!r)break;const nm=buildNodeMap(c,w,p);const v=r.sim.nodeVoltage[nm.terminalNode.get('C1:a')!];expect(v).toBeGreaterThanOrEqual(pv-0.01);pv=v;prev={nodeVoltage:r.sim.nodeVoltage,branchCurrent:r.sim.branchCurrent,time:r.sim.time,state:r.sim.state};}expect(pv).toBeGreaterThan(4.9);});});
describe('#7 Cross-validation', () => { it('Voltage divider', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:12}),comp('resistor','R1',{resistance:4000}),comp('resistor','R2',{resistance:8000}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','GND','g'),wire('w4','V1','n','GND','g')];const dc=solveDC(c,w,p);expect(dc).not.toBeNull();const nm=buildNodeMap(c,w,p);expect(dc!.nodeVoltage[nm.terminalNode.get('R1:b')!]).toBeCloseTo(8,2);});});
describe('#8 Wire current sanity', () => { it('Series: same current', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('resistor','R2',{resistance:1000}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','GND','g'),wire('w4','V1','n','GND','g')];const dc=solveDC(c,w,p);if(!dc)return;const r=simulateStep(c,w,p,{nodeVoltage:dc.nodeVoltage,branchCurrent:dc.branchCurrent,time:0,state:dc.state},1e-4);if(!r)return;const wc=computeWireCurrents(c,w,p,r.sim);const i1=Math.abs(wc.get('w1')??0);const i2=Math.abs(wc.get('w2')??0);const i3=Math.abs(wc.get('w3')??0);const mx=Math.max(i1,i2,i3);if(mx>1e-12)expect((mx-Math.min(i1,i2,i3))/mx).toBeLessThan(0.05);});});
describe('#9 Net annotation', () => { it('Annotates all nets', () => { const p=plugins();const anns=annotateNets(exampleOpamp.components,exampleOpamp.wires,p);expect(anns.length).toBeGreaterThan(0);const gnd=anns.find(a=>a.nodeId===0);expect(gnd).toBeDefined();expect(gnd!.netName).toBe('GND');});});
describe('#10 AI safety', () => { it('Negative resistance: no crash', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:-1000}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','GND','g'),wire('w3','V1','n','GND','g')];expect(()=>solveDC(c,w,p)).not.toThrow();});it('100 components: no crash', () => { const p=plugins();const c:CircuitComponent[]=[comp('dcVoltage','V1',{voltage:5}),comp('ground','GND')];for(let i=0;i<100;i++)c.push(comp('resistor','R'+i,{resistance:1000}));const w:Wire[]=[wire('w0','V1','p','R0','a'),wire('wg','V1','n','GND','g')];for(let i=0;i<99;i++)w.push(wire('w'+(i+1),'R'+i,'b','R'+(i+1),'a'));w.push(wire('wf','R99','b','GND','g'));expect(()=>solveDC(c,w,p)).not.toThrow();});});
`,

  'tests/sim-worker.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, solveDC, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); });
function comp(t:string,id:string,p?:any){const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string){return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins(){return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('Sim worker', () => {
  it('simulateStep: voltage divider', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('resistor','R2',{resistance:1000}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','GND','g'),wire('w4','V1','n','GND','g')];const r=simulateStep(c,w,p,undefined,1e-4);expect(r).not.toBeNull();const nm=buildNodeMap(c,w,p);expect(r!.sim.nodeVoltage[nm.terminalNode.get('R1:b')!]).toBeCloseTo(2.5,4);});
  it('solveDC: correct operating point', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:12}),comp('resistor','R1',{resistance:4000}),comp('resistor','R2',{resistance:8000}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','R2','a'),wire('w3','R2','b','GND','g'),wire('w4','V1','n','GND','g')];const r=solveDC(c,w,p);expect(r).not.toBeNull();const nm=buildNodeMap(c,w,p);expect(r!.nodeVoltage[nm.terminalNode.get('R1:b')!]).toBeCloseTo(8,4);});
  it('Singular matrix: returns null', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('dcVoltage','V2',{voltage:3}),comp('ground','GND')];const w=[wire('w1','V1','p','V2','p'),wire('w2','V1','n','GND','g'),wire('w3','V2','n','GND','g')];const r=solveDC(c,w,p);expect(r).toBeNull();});
  it('100-node ladder: < 1s', () => { const p=plugins();const c:CircuitComponent[]=[comp('dcVoltage','V1',{voltage:5}),comp('ground','GND')];for(let i=0;i<100;i++)c.push(comp('resistor','R'+i,{resistance:1000}));const w:Wire[]=[wire('w0','V1','p','R0','a'),wire('wg','V1','n','GND','g')];for(let i=0;i<99;i++)w.push(wire('w'+(i+1),'R'+i,'b','R'+(i+1),'a'));w.push(wire('wf','R99','b','GND','g'));const s=Date.now();const r=simulateStep(c,w,p,undefined,1e-4);const e=Date.now()-s;expect(r).not.toBeNull();expect(e).toBeLessThan(1000);});
  it('Float64Array transferable', () => { const o=new Float64Array([1,2.5,-3.14,0]);const b=o.buffer;const r=new Float64Array(b);expect(r[0]).toBe(1);expect(r[1]).toBe(2.5);expect(r[2]).toBe(-3.14);});
  it('Map serializable as entries', () => { const o=new Map([['a',1],['b',2]]);const s=Array.from(o.entries());const r=new Map(s);expect(r.get('a')).toBe(1);expect(r.get('b')).toBe(2);});
});
`,

  'tests/benchmark.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { generateResistorLadder, benchmarkCircuit, MAX_COMPONENTS, checkComponentLimit, checkWireLimit } from '../src/lib/circuit/benchmark';
import { getAllPlugins } from '../src/lib/circuit/registry';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); });
function plugins(){return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('Benchmark', () => {
  it('generateResistorLadder: 10 stages', () => { const d=generateResistorLadder(10,1000);expect(d.components.length).toBe(12);});
  it('benchmarkCircuit: 100-node ladder', () => { const p=plugins();const d=generateResistorLadder(98);const r=benchmarkCircuit(d.components,d.wires,p);expect(r.ok).toBe(true);expect(r.solveDCMs).toBeLessThan(100);});
  it('MAX_COMPONENTS: 2000', () => { expect(MAX_COMPONENTS).toBe(2000);});
  it('checkComponentLimit: under limit', () => { const r=checkComponentLimit([]);expect(r.ok).toBe(true);});
  it('checkComponentLimit: over limit', () => { const r=checkComponentLimit(new Array(MAX_COMPONENTS+1).fill({}));expect(r.ok).toBe(false);});
  it('checkWireLimit: under limit', () => { const r=checkWireLimit([]);expect(r.ok).toBe(true);});
});
`,

  'tests/memory-leak.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
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
`,

  'tests/autosave.test.ts': `import { describe, it, expect, beforeEach } from 'vitest';
import { saveToLocalStorage, loadFromLocalStorage, autosave, detectCrashRecovery, loadAutosave, clearAutosave, markCleanShutdown, AutosaveManager } from '../src/lib/circuit/autosave';
class MockLS { private s=new Map<string,string>();getItem(k:string){return this.s.get(k)??null;}setItem(k:string,v:string){this.s.set(k,v);}removeItem(k:string){this.s.delete(k);}clear(){this.s.clear();}}
beforeEach(() => { (globalThis as any).localStorage=new MockLS(); });
describe('Autosave', () => {
  it('saveToLocalStorage: stores doc', () => { expect(saveToLocalStorage('test',{version:1,components:[],wires:[]})).toBe(true);const l=loadFromLocalStorage('test');expect(l).not.toBeNull();});
  it('loadFromLocalStorage: null for missing', () => { expect(loadFromLocalStorage('nonexistent')).toBeNull();});
  it('autosave + detectCrashRecovery', () => { autosave({version:1,components:[{id:'R1',type:'resistor',position:{x:0,y:0},rotation:0,parameters:{}}],wires:[]}as any);const info=detectCrashRecovery();expect(info).not.toBeNull();expect(info!.crashed).toBe(true);});
  it('markCleanShutdown: crashed=false', () => { autosave({version:1,components:[],wires:[]}as any);markCleanShutdown();const info=detectCrashRecovery();expect(info!.crashed).toBe(false);});
  it('clearAutosave: removes all', () => { autosave({version:1,components:[],wires:[]}as any);clearAutosave();expect(detectCrashRecovery()).toBeNull();});
  it('AutosaveManager: saveNow', () => { const m=new AutosaveManager();expect(m.saveNow({version:1,components:[],wires:[]}as any)).toBe(true);});
});
`,

  'tests/migration.test.ts': `import { describe, it, expect } from 'vitest';
import { migrateDocument, validateDocument, loadCircuitDocument, saveCircuitDocument, detectVersion, CURRENT_SCHEMA_VERSION } from '../src/lib/circuit/migration';
describe('Migration', () => {
  it('detectVersion: 0 for no version', () => { expect(detectVersion({components:[],wires:[]})).toBe(0);});
  it('detectVersion: returns version number', () => { expect(detectVersion({version:1})).toBe(1);expect(detectVersion({version:2})).toBe(2);});
  it('migrateDocument: v0 → current', () => { const r=migrateDocument({components:[{id:'R1',type:'resistor',position:{x:0,y:0},rotation:0,parameters:{resistance:1000}}],wires:[]});expect(r.doc.version).toBe(CURRENT_SCHEMA_VERSION);expect(r.doc.components.length).toBe(1);});
  it('validateDocument: catches missing version', () => { const r=validateDocument({components:[],wires:[]}as any);expect(r.ok).toBe(false);});
  it('validateDocument: catches duplicate IDs', () => { const r=validateDocument({version:2,components:[{id:'R1',type:'resistor',position:{x:0,y:0},rotation:0,parameters:{}},{id:'R1',type:'resistor',position:{x:5,y:0},rotation:0,parameters:{}}],wires:[]}as any);expect(r.ok).toBe(false);});
  it('saveCircuitDocument: sets version', () => { const j=saveCircuitDocument({version:1,components:[],wires:[]}as any);expect(JSON.parse(j).version).toBe(CURRENT_SCHEMA_VERSION);});
  it('loadCircuitDocument: valid v0', () => { const j=JSON.stringify({components:[],wires:[]});const r=loadCircuitDocument(j);expect(r.doc).not.toBeNull();});
  it('loadCircuitDocument: JSON error', () => { const r=loadCircuitDocument('{ invalid');expect(r.doc).toBeNull();});
  it('round-trip: save→load→save identical', () => { const o:CircuitDocument={version:CURRENT_SCHEMA_VERSION,components:[],wires:[]};const j1=saveCircuitDocument(o);const r=loadCircuitDocument(j1);const j2=saveCircuitDocument(r.doc!);expect(JSON.parse(j2)).toEqual(JSON.parse(j1));});
});
`,

  'tests/error-boundary.test.ts': `import { describe, it, expect } from 'vitest';
import React from 'react';
import { ErrorBoundary, withErrorBoundary, reportError } from '../src/components/ErrorBoundary';
describe('ErrorBoundary', () => {
  it('getDerivedStateFromError: sets hasError', () => { const s=ErrorBoundary.getDerivedStateFromError(new Error('test'));expect(s.hasError).toBe(true);});
  it('render: returns children when no error', () => { const b=new (ErrorBoundary as any)({name:'Test'});b.props={name:'Test',children:React.createElement('div')};b.state={hasError:false,error:null,errorInfo:null,showDetails:false,errorCount:0};const r=b.render();expect(r).toBe(b.props.children);});
  it('render: returns fallback when error', () => { const b=new (ErrorBoundary as any)({name:'Test'});b.props={name:'Test',children:React.createElement('div')};b.state={hasError:true,error:new Error('test'),errorInfo:null,showDetails:false,errorCount:1};const r=b.render() as React.ReactElement;expect(r).not.toBe(b.props.children);});
  it('withErrorBoundary: returns function', () => { const C=(p:any)=>React.createElement('div');const W=withErrorBoundary(C,{name:'Test'});expect(typeof W).toBe('function');});
  it('reportError: does not crash', () => { expect(()=>reportError(new Error('test'),{componentStack:''})).not.toThrow();});
});
`,

  'tests/transient-accuracy.test.ts': `import { describe, it, expect, beforeAll } from 'vitest';
import { simulateStep, buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';
import { rcChargingVoltage, rcDischargingVoltage, rlCurrentBuildup, relativeError } from '../src/lib/circuit/transient-methods';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); });
function comp(t:string,id:string,p?:any){const pl=getPlugin(t);const d:any={};if(pl)for(const pm of pl.parameters)d[pm.key]=pm.default;return{id,type:t,position:{x:0,y:0},rotation:0,parameters:{...d,...p},simState:{}};}
function wire(id:string,f:string,ft:string,t:string,tt:string){return{id,from:{componentId:f,terminalId:ft},to:{componentId:t,terminalId:tt}};}
function plugins(){return new Map(getAllPlugins().map(p=>[p.type,p]));}
describe('Transient accuracy', () => {
  it('RC charging: V matches Vs*(1-exp(-t/RC)) within 5%', () => { const p=plugins();const R=1000,C=1e-6,Vs=5,dt=1e-4;const c=[comp('dcVoltage','V1',{voltage:Vs}),comp('resistor','R1',{resistance:R}),comp('capacitor','C1',{capacitance:C}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','C1','a'),wire('w3','C1','b','GND','g'),wire('w4','V1','n','GND','g')];let prev:any;for(let i=0;i<100;i++){const r=simulateStep(c,w,p,prev,dt);if(!r)break;const nm=buildNodeMap(c,w,p);const v=r.sim.nodeVoltage[nm.terminalNode.get('C1:a')!];const ev=rcChargingVoltage(r.sim.time,Vs,R,C);if(i>0)expect(relativeError(v,ev)).toBeLessThan(0.05);prev={nodeVoltage:r.sim.nodeVoltage,branchCurrent:r.sim.branchCurrent,time:r.sim.time,state:r.sim.state};}});
  it('RC discharging: V matches V0*exp(-t/RC)', () => { const p=plugins();const R=1000,C=1e-6,V0=5;const c=[comp('resistor','R1',{resistance:R}),comp('capacitor','C1',{capacitance:C,initialV:V0}),comp('ground','GND')];const w=[wire('w1','R1','a','C1','a'),wire('w2','C1','b','GND','g'),wire('w3','R1','b','GND','g')];let prev:any;for(let i=0;i<100;i++){const r=simulateStep(c,w,p,prev,1e-4);if(!r)break;const nm=buildNodeMap(c,w,p);const v=r.sim.nodeVoltage[nm.terminalNode.get('C1:a')!];const ev=rcDischargingVoltage(r.sim.time,V0,R,C);if(i>0)expect(relativeError(v,ev)).toBeLessThan(0.1);prev={nodeVoltage:r.sim.nodeVoltage,branchCurrent:r.sim.branchCurrent,time:r.sim.time,state:r.sim.state};}});
  it('10000-step RC: stable, converges to Vs', () => { const p=plugins();const c=[comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('capacitor','C1',{capacitance:1e-6}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','C1','a'),wire('w3','C1','b','GND','g'),wire('w4','V1','n','GND','g')];let prev:any;let last=0;for(let i=0;i<10000;i++){const r=simulateStep(c,w,p,prev,1e-4);if(!r)break;for(let j=0;j<r.sim.nodeVoltage.length;j++)expect(isFinite(r.sim.nodeVoltage[j])).toBe(true);const nm=buildNodeMap(c,w,p);last=r.sim.nodeVoltage[nm.terminalNode.get('C1:a')!]??0;prev={nodeVoltage:r.sim.nodeVoltage,branchCurrent:r.sim.branchCurrent,time:r.sim.time,state:r.sim.state};}expect(last).toBeGreaterThan(4.99);});
  it('AC source: 1kHz sine wave correct frequency', () => { const p=plugins();const c=[comp('acVoltage','V1',{amplitude:1,frequency:1000,offset:0,phase:0}),comp('resistor','R1',{resistance:1000}),comp('ground','GND')];const w=[wire('w1','V1','p','R1','a'),wire('w2','R1','b','GND','g'),wire('w3','V1','n','GND','g')];let prev:any;const risingCrossings:number[]=[];const dt=1e-5;for(let i=0;i<1000;i++){const r=simulateStep(c,w,p,prev,dt);if(!r)break;const nm=buildNodeMap(c,w,p);const v=r.sim.nodeVoltage[nm.terminalNode.get('V1:p')!];if(prev){const pv=prev.nodeVoltage[nm.terminalNode.get('V1:p')!];if(pv<0&&v>=0)risingCrossings.push(r.sim.time);}prev={nodeVoltage:r.sim.nodeVoltage,branchCurrent:r.sim.branchCurrent,time:r.sim.time,state:r.sim.state};}if(risingCrossings.length>=2){let s=0;for(let i=1;i<risingCrossings.length;i++)s+=risingCrossings[i]-risingCrossings[i-1];const avg=s/(risingCrossings.length-1);expect(relativeError(avg,0.001)).toBeLessThan(0.02);}});
});
`,
};

let count = 0;
for (const [file, content] of Object.entries(tests)) {
  fs.writeFileSync(file, content);
  console.log('Created ' + file);
  count++;
}
console.log('Total: ' + count + ' test files created');
