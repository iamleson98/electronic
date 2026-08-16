import { describe, it, expect } from 'vitest';
import { JLC_PCB_SPEC, PCBWAY_SPEC, mmToMil, milToMm, getManufacturerSpec } from '../src/lib/pcb/manufacturer-presets';
describe('Manufacturer presets', () => {
  it('JLC PCB: 5 mil trace', () => { expect(mmToMil(JLC_PCB_SPEC.config.minTraceWidth)).toBeCloseTo(5,1);});
  it('PCBWay: 6 mil trace', () => { expect(mmToMil(PCBWAY_SPEC.config.minTraceWidth)).toBeCloseTo(6,1);});
  it('mmToMil/milToMm inverse', () => { expect(milToMm(mmToMil(5))).toBeCloseTo(5,5);});
  it('getManufacturerSpec: known', () => { expect(getManufacturerSpec('JLC PCB')).not.toBeNull();});
  it('getManufacturerSpec: unknown', () => { expect(getManufacturerSpec('Unknown')).toBeNull();});
});
