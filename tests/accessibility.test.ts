import { describe, it, expect } from 'vitest';
import { hexToRgb, contrastRatio, checkContrast } from '../src/lib/circuit/accessibility';
describe('Accessibility', () => {
  it('hexToRgb: 6-digit', () => { expect(hexToRgb('#ffffff')).toEqual({r:255,g:255,b:255});expect(hexToRgb('#000000')).toEqual({r:0,g:0,b:0});});
  it('hexToRgb: 3-digit', () => { expect(hexToRgb('#fff')).toEqual({r:255,g:255,b:255});});
  it('contrastRatio: black vs white = 21', () => { expect(contrastRatio({r:0,g:0,b:0},{r:255,g:255,b:255})).toBeCloseTo(21,0);});
  it('contrastRatio: identical = 1', () => { expect(contrastRatio({r:128,g:128,b:128},{r:128,g:128,b:128})).toBeCloseTo(1,5);});
  it('checkContrast: black on white passes AA', () => { const r=checkContrast('#000000','#ffffff');expect(r.passes.aaNormal).toBe(true);});
  it('checkContrast: light gray on white fails AA', () => { const r=checkContrast('#cccccc','#ffffff');expect(r.passes.aaNormal).toBe(false);});
});
