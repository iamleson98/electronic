import { describe, it, expect } from 'vitest';
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
