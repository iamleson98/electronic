// Parametric footprint generator — creates standard SMD/THT footprint
// DEFINITIONS from package parameters (pin count, pitch, body size).
//
// Returns FootprintDef objects (templates) that can be instantiated as
// Footprint instances by the PCB store when a component is placed.
//
// Supported families:
//   - SOIC (8-28 pins, 1.27mm pitch)
//   - TSSOP (8-64 pins, 0.65mm pitch)
//   - QFP (32-240 pins, 0.4-0.8mm pitch)
//   - QFN (8-68 pins, 0.4-0.65mm pitch, no leads)
//   - DIP (4-64 pins, 2.54mm pitch, THT)
//   - SOT-23 (3-6 pins, 0.95mm pitch)
//   - 0402/0603/0805/1206 chip components (2 pads)

import type { FootprintDef, FootprintPadDef } from './types';

export interface FootprintParams {
  pinCount: number;
  pitch: number;
  bodyWidth: number;
  bodyLength: number;
  padWidth: number;
  padHeight: number;
  type: 'soic' | 'tssop' | 'qfp' | 'qfn' | 'dip' | 'sot23' | 'chip';
  pinsPerSide?: number;
  padSpacing?: number;
}

export function generateFootprintDef(name: string, params: FootprintParams): FootprintDef {
  const pads: FootprintPadDef[] = [];
  const { pinCount, pitch, bodyWidth, bodyLength, padWidth, padHeight, type } = params;

  if (type === 'soic' || type === 'tssop' || type === 'dip' || type === 'sot23') {
    const pinsPerSide = Math.ceil(pinCount / 2);
    const rowSpacing = bodyWidth;
    const pinRowOffset = rowSpacing / 2 + (type === 'dip' ? 0 : 0.5);
    const isTHT = type === 'dip';

    for (let i = 0; i < pinsPerSide; i++) {
      const y = (i - (pinsPerSide - 1) / 2) * pitch;
      pads.push({
        terminalId: `${i + 1}`,
        position: { x: -pinRowOffset, y },
        shape: isTHT ? 'circle' : 'rect',
        size: { width: padWidth, height: padHeight },
        layer: 'top',
        drill: isTHT ? 0.8 : undefined,
      });
      if (i + pinsPerSide + 1 <= pinCount) {
        pads.push({
          terminalId: `${i + pinsPerSide + 1}`,
          position: { x: pinRowOffset, y: -y },
          shape: isTHT ? 'circle' : 'rect',
          size: { width: padWidth, height: padHeight },
          layer: 'top',
          drill: isTHT ? 0.8 : undefined,
        });
      }
    }
  } else if (type === 'qfp' || type === 'qfn') {
    const pinsPerSide = params.pinsPerSide ?? Math.ceil(pinCount / 4);
    const sideOffset = bodyWidth / 2 + (type === 'qfp' ? 0.5 : 0);
    let pinNum = 1;
    for (let i = 0; i < pinsPerSide && pinNum <= pinCount; i++) {
      const y = (i - (pinsPerSide - 1) / 2) * pitch;
      pads.push({
        terminalId: `${pinNum}`,
        position: { x: -sideOffset, y },
        shape: 'rect',
        size: { width: padWidth, height: padHeight },
        layer: 'top',
      });
      pinNum++;
    }
    for (let i = 0; i < pinsPerSide && pinNum <= pinCount; i++) {
      const x = (i - (pinsPerSide - 1) / 2) * pitch;
      pads.push({
        terminalId: `${pinNum}`,
        position: { x, y: sideOffset },
        shape: 'rect',
        size: { width: padHeight, height: padWidth },
        layer: 'top',
      });
      pinNum++;
    }
    for (let i = 0; i < pinsPerSide && pinNum <= pinCount; i++) {
      const y = -(i - (pinsPerSide - 1) / 2) * pitch;
      pads.push({
        terminalId: `${pinNum}`,
        position: { x: sideOffset, y },
        shape: 'rect',
        size: { width: padWidth, height: padHeight },
        layer: 'top',
      });
      pinNum++;
    }
    for (let i = 0; i < pinsPerSide && pinNum <= pinCount; i++) {
      const x = -(i - (pinsPerSide - 1) / 2) * pitch;
      pads.push({
        terminalId: `${pinNum}`,
        position: { x, y: -sideOffset },
        shape: 'rect',
        size: { width: padHeight, height: padWidth },
        layer: 'top',
      });
      pinNum++;
    }
    if (type === 'qfn') {
      pads.push({
        terminalId: 'ep',
        position: { x: 0, y: 0 },
        shape: 'rect',
        size: { width: bodyWidth * 0.6, height: bodyLength * 0.6 },
        layer: 'top',
      });
    }
  } else if (type === 'chip') {
    const spacing = params.padSpacing ?? bodyWidth / 2;
    pads.push({
      terminalId: '1',
      position: { x: -spacing, y: 0 },
      shape: 'rect',
      size: { width: padWidth, height: padHeight },
      layer: 'top',
    });
    pads.push({
      terminalId: '2',
      position: { x: spacing, y: 0 },
      shape: 'rect',
      size: { width: padWidth, height: padHeight },
      layer: 'top',
    });
  }

  return {
    name,
    bodySize: { width: bodyWidth, height: bodyLength },
    pads,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Preset generators
// ─────────────────────────────────────────────────────────────────────────────

export function generateSOIC(pinCount: number): FootprintDef {
  const pitch = 1.27;
  const bodyWidth = 4.0;
  const bodyLength = (pinCount / 2 - 1) * pitch + 2.0;
  return generateFootprintDef(`SOIC-${pinCount}`, {
    type: 'soic', pinCount, pitch, bodyWidth, bodyLength,
    padWidth: 0.6, padHeight: 1.55,
  });
}

export function generateTSSOP(pinCount: number): FootprintDef {
  const pitch = 0.65;
  const bodyWidth = 4.5;
  const bodyLength = (pinCount / 2 - 1) * pitch + 1.5;
  return generateFootprintDef(`TSSOP-${pinCount}`, {
    type: 'tssop', pinCount, pitch, bodyWidth, bodyLength,
    padWidth: 0.4, padHeight: 1.2,
  });
}

export function generateQFP(pinCount: number, pitch = 0.5): FootprintDef {
  const pinsPerSide = pinCount / 4;
  const bodyWidth = (pinsPerSide - 1) * pitch + 2.0;
  return generateFootprintDef(`QFP-${pinCount}`, {
    type: 'qfp', pinCount, pitch, bodyWidth, bodyLength: bodyWidth,
    padWidth: 0.3, padHeight: 1.5, pinsPerSide,
  });
}

export function generateQFN(pinCount: number, pitch = 0.5): FootprintDef {
  const pinsPerSide = pinCount / 4;
  const bodyWidth = (pinsPerSide - 1) * pitch + 1.5;
  return generateFootprintDef(`QFN-${pinCount}`, {
    type: 'qfn', pinCount, pitch, bodyWidth, bodyLength: bodyWidth,
    padWidth: 0.25, padHeight: 0.5, pinsPerSide,
  });
}

export function generateDIP(pinCount: number): FootprintDef {
  const pitch = 2.54;
  const bodyWidth = 7.62;
  const bodyLength = (pinCount / 2 - 1) * pitch + 2.0;
  return generateFootprintDef(`DIP-${pinCount}`, {
    type: 'dip', pinCount, pitch, bodyWidth, bodyLength,
    padWidth: 1.6, padHeight: 1.6,
  });
}

export function generateSOT23(): FootprintDef {
  return generateFootprintDef('SOT-23', {
    type: 'sot23', pinCount: 3, pitch: 0.95, bodyWidth: 1.3, bodyLength: 2.9,
    padWidth: 0.55, padHeight: 0.85,
  });
}

export function generateChip(size: '0402' | '0603' | '0805' | '1206'): FootprintDef {
  const sizes = {
    '0402': { bodyW: 0.5, bodyL: 1.0, padW: 0.5, padH: 0.6, spacing: 0.45 },
    '0603': { bodyW: 0.8, bodyL: 1.6, padW: 0.7, padH: 0.9, spacing: 0.7 },
    '0805': { bodyW: 1.25, bodyL: 2.0, padW: 0.9, padH: 1.2, spacing: 0.95 },
    '1206': { bodyW: 1.6, bodyL: 3.2, padW: 1.2, padH: 1.6, spacing: 1.6 },
  };
  const s = sizes[size];
  return generateFootprintDef(size, {
    type: 'chip', pinCount: 2, pitch: 0, bodyWidth: s.bodyW, bodyLength: s.bodyL,
    padWidth: s.padW, padHeight: s.padH, padSpacing: s.spacing,
  });
}

export function getParametricFootprint(name: string): FootprintDef | null {
  const lower = name.toLowerCase();
  const soicMatch = lower.match(/^soic-(\d+)$/);
  if (soicMatch) return generateSOIC(parseInt(soicMatch[1]));
  const tssopMatch = lower.match(/^tssop-(\d+)$/);
  if (tssopMatch) return generateTSSOP(parseInt(tssopMatch[1]));
  const qfpMatch = lower.match(/^qfp-(\d+)$/);
  if (qfpMatch) return generateQFP(parseInt(qfpMatch[1]));
  const qfnMatch = lower.match(/^qfn-(\d+)$/);
  if (qfnMatch) return generateQFN(parseInt(qfnMatch[1]));
  const dipMatch = lower.match(/^dip-(\d+)$/);
  if (dipMatch) return generateDIP(parseInt(dipMatch[1]));
  if (lower === 'sot-23' || lower === 'sot23') return generateSOT23();
  if (['0402', '0603', '0805', '1206'].includes(lower)) return generateChip(lower as any);
  return null;
}
