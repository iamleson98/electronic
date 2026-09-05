// Realistic 3D component models — SMD mini sizes, solder grip, markings.
//
// Guards the "real-world look" requirements:
//  • SMD footprints (no drill) get mini chip models, not oversized THT bodies
//  • THT solder fillets are volcano cones (LatheGeometry) that wick up the lead
//  • SMD bodies stay within modern mini sizes (0603/0805/SOT-23/SOD-123)

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildComponentModel } from '../src/lib/pcb/component-models-3d';
import { solderFilletGeometry } from '../src/lib/pcb/board-geometry-3d';
import type { Footprint, Pad } from '../src/lib/pcb/types';

function smdPad(id: string, x: number, terminalId = 'a'): Pad {
  return {
    id, componentId: 'c1', terminalId,
    position: { x, y: 0 },
    shape: 'rect', size: { width: 1.5, height: 0.8 },
    layer: 'top', drill: 0,
  };
}

function thtPad(id: string, x: number, terminalId = 'a'): Pad {
  return {
    id, componentId: 'c1', terminalId,
    position: { x, y: 0 },
    shape: 'circle', size: { width: 1.8, height: 1.8 },
    layer: 'top', drill: 1.0,
  };
}

function fp(type: string, pads: Pad[]): Footprint {
  return {
    id: 'fp1', componentId: 'c1', componentType: type, refdes: 'R1',
    position: { x: 0, y: 0 }, rotation: 0,
    bodySize: { width: 3.2, height: 1.6 }, pads, side: 'top',
  };
}

function groupSize(g: THREE.Group | null): { x: number; y: number; z: number } {
  expect(g).not.toBeNull();
  const box = new THREE.Box3().setFromObject(g!);
  const s = new THREE.Vector3();
  box.getSize(s);
  return { x: s.x, y: s.y, z: s.z };
}

describe('realistic 3D models — modern mini sizes', () => {
  it('SMD resistor is a mini chip (not an oversized axial body)', () => {
    const g = buildComponentModel({
      footprint: fp('resistor', [smdPad('p1', -2.1, 'a'), smdPad('p2', 2.1, 'b')]),
      params: { resistance: 10000 },
    });
    const s = groupSize(g);
    // 0805-ish chip: body ~2mm long, <1mm tall — old axial was 9mm × 2.5mm
    expect(s.x).toBeLessThan(5);
    expect(s.y).toBeLessThan(2);
  });

  it('THT resistor keeps axial body with color bands', () => {
    const g = buildComponentModel({
      footprint: fp('resistor', [thtPad('p1', -5, 'a'), thtPad('p2', 5, 'b')]),
      params: { resistance: 1000 },
    });
    const s = groupSize(g);
    expect(s.x).toBeGreaterThan(6); // axial body + leads span the pads
  });

  it('SMD capacitor is a mini MLCC (not a ceramic disc)', () => {
    const g = buildComponentModel({
      footprint: fp('capacitor', [smdPad('p1', -2.1, 'a'), smdPad('p2', 2.1, 'b')]),
      params: { capacitance: 1e-7 },
    });
    const s = groupSize(g);
    expect(s.x).toBeLessThan(5);
    expect(s.y).toBeLessThan(2);
  });

  it('SMD diode is a mini SOD (not a DO-41 glass tube)', () => {
    const g = buildComponentModel({
      footprint: fp('diode', [smdPad('p1', -2.1, 'a'), smdPad('p2', 2.1, 'k')]),
      params: {},
    });
    const s = groupSize(g);
    expect(s.x).toBeLessThan(5);
  });

  it('SMD transistor is a mini SOT-23 (not a TO-92 can)', () => {
    const g = buildComponentModel({
      footprint: {
        id: 'fp1', componentId: 'c1', componentType: 'npn', refdes: 'Q1',
        position: { x: 0, y: 0 }, rotation: 0,
        bodySize: { width: 2.9, height: 2.8 },
        pads: [
          { ...smdPad('p1', 1.0), position: { x: 1.0, y: -1.0 }, terminalId: 'c' },
          { ...smdPad('p2', -1.0), position: { x: -1.0, y: 0 }, terminalId: 'b' },
          { ...smdPad('p3', 1.0), position: { x: 1.0, y: 1.0 }, terminalId: 'e' },
        ],
        side: 'top',
      },
      params: {},
    });
    const s = groupSize(g);
    expect(s.y).toBeLessThan(3); // SOT-23 is 1.1mm tall; TO-92 was 6mm+
  });

  it('SMD IC gets gull-wing SOIC (not a DIP block)', () => {
    const g = buildComponentModel({
      footprint: {
        id: 'fp1', componentId: 'c1', componentType: 'opamp', refdes: 'U1',
        position: { x: 0, y: 0 }, rotation: 0,
        bodySize: { width: 6.0, height: 5.0 },
        pads: [
          { ...smdPad('p1', -3), position: { x: -3, y: -1 }, terminalId: 'in+' },
          { ...smdPad('p2', -3), position: { x: -3, y: 1 }, terminalId: 'in-' },
          { ...smdPad('p3', 3), position: { x: 3, y: 0 }, terminalId: 'out' },
        ],
        side: 'top',
      },
      params: {},
    });
    const s = groupSize(g);
    expect(s.y).toBeLessThan(4); // SOIC is 1.75mm tall; DIP was 3.6mm+
  });
});

describe('solder fillets grip the leads', () => {
  it('THT fillet is a volcano cone (lathe), not a squashed dome', () => {
    const geo = solderFilletGeometry(thtPad('p1', 0), 0, 0, 0.16);
    expect(geo).not.toBeNull();
    // LatheGeometry has no 'sphere' signature: check it rises along the lead
    const pos = geo!.getAttribute('position');
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    // volcano wicks ~0.55mm up the lead above the pad surface
    expect(maxY).toBeGreaterThan(0.4);
  });

  it('SMD fillet stays low (reflow wedge, not a dome)', () => {
    const geo = solderFilletGeometry(smdPad('p1', 0), 0, 0, 0.16);
    expect(geo).not.toBeNull();
    const pos = geo!.getAttribute('position');
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    expect(maxY).toBeLessThan(0.6);
  });
});
