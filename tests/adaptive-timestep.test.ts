import { describe, it, expect } from 'vitest';
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
