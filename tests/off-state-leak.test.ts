import { describe, it, expect, beforeAll } from 'vitest';
import { solveDC, simulateStep, buildNodeMap, computeComponentCurrents, computeWireCurrents } from '../src/lib/circuit/engine';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
});

function comp(type: string, id: string, params?: any): CircuitComponent {
  const p = getPlugin(type);
  const d: any = {};
  if (p) for (const pm of p.parameters) d[pm.key] = pm.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...params }, simState: {} };
}
function wire(id: string, f: string, ft: string, t: string, tt: string): Wire {
  return { id, from: { componentId: f, terminalId: ft }, to: { componentId: t, terminalId: tt } };
}
function plugins(): Map<string, ComponentPlugin> { return new Map(getAllPlugins().map(p => [p.type, p])); }

const VISIBLE = 1e-12;

describe('OFF-state leak', () => {
  it('NPN switch button OPEN: zero current', () => {
    const p = plugins();
    const c = [comp('dcVoltage','V1',{voltage:5}),comp('dcVoltage','V2',{voltage:5}),comp('pushButton','BTN',{pressed:false}),comp('resistor','Rb',{resistance:10000}),comp('resistor','Rc',{resistance:1000}),comp('npn','Q1',{hfe:100,vbe:0.7,satV:0.2}),comp('led','LED',{color:'red',forwardV:2,seriesR:1}),comp('ground','GND')];
    const w = [wire('w1','V1','p','Rc','a'),wire('w3','Rc','b','LED','a'),wire('w4','LED','k','Q1','c'),wire('w5','V2','p','BTN','a'),wire('w7','BTN','b','Rb','a'),wire('w8','Rb','b','Q1','b'),wire('w2','V1','n','GND','g'),wire('w6','V2','n','GND','g'),wire('w9','Q1','e','GND','g')];
    const dc = solveDC(c, w, p);
    expect(dc).not.toBeNull();
    const r = simulateStep(c, w, p, {nodeVoltage:dc!.nodeVoltage,branchCurrent:dc!.branchCurrent,time:0,state:dc!.state},1e-4);
    if(!r) return;
    const cc = computeComponentCurrents(c, w, p, r.sim);
    expect(Math.abs(cc.get('V1')!)).toBeLessThan(VISIBLE);
    expect(Math.abs(cc.get('LED')!)).toBeLessThan(VISIBLE);
  });
  it('Diode reverse-biased: only offR leakage flows', () => {
    const p = plugins();
    const c = [comp('dcVoltage','V1',{voltage:5}),comp('resistor','R1',{resistance:1000}),comp('diode','D1',{forwardV:0.7,onR:1,offR:1e7}),comp('ground','GND')];
    const w = [wire('w1','V1','p','R1','a'),wire('w3','R1','b','D1','k'),wire('w4','D1','a','GND','g'),wire('w2','V1','n','GND','g')];
    const dc = solveDC(c, w, p); expect(dc).not.toBeNull();
    const r = simulateStep(c, w, p, {nodeVoltage:dc!.nodeVoltage,branchCurrent:dc!.branchCurrent,time:0,state:dc!.state},1e-4);
    if(!r) return;
    const cc = computeComponentCurrents(c, w, p, r.sim);
    // The diode now honors its offR parameter (default 10MΩ — same as the
    // zener): reverse current is bounded by V/offR = 5V/10MΩ = 0.5µA, not
    // the old hard-coded 1e-13S. That is still an open circuit for every
    // practical purpose (no visible dots, no measurable loading).
    expect(Math.abs(cc.get('V1')!)).toBeLessThan(1e-6);
    expect(Math.abs(cc.get('V1')!)).toBeGreaterThan(1e-9);
  });
  it('Switch OPEN: zero current', () => {
    const p = plugins();
    const c = [comp('dcVoltage','V1',{voltage:5}),comp('switch','SW',{closed:false}),comp('resistor','R1',{resistance:1000}),comp('ground','GND')];
    const w = [wire('w1','V1','p','SW','a'),wire('w2','SW','b','R1','a'),wire('w3','R1','b','GND','g'),wire('w4','V1','n','GND','g')];
    const dc = solveDC(c, w, p); expect(dc).not.toBeNull();
    const r = simulateStep(c, w, p, {nodeVoltage:dc!.nodeVoltage,branchCurrent:dc!.branchCurrent,time:0,state:dc!.state},1e-4);
    if(!r) return;
    const cc = computeComponentCurrents(c, w, p, r.sim);
    expect(Math.abs(cc.get('V1')!)).toBeLessThan(VISIBLE);
  });
});
