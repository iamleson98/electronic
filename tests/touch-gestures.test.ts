import { describe, it, expect } from 'vitest';
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
