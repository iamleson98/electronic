// Manufacturer DRC presets — typed, multi-fab, wired into the DRC dialog.
//
// Each preset carries the fab's published minima so one click configures the
// whole rule deck (previously two `any`-typed 2-layer presets nobody called).

import type { DRCConfig } from './drc';

export interface ManufacturerSpec {
  name: string;
  url: string;
  tier: 'economy' | 'standard' | 'advanced';
  moq: number;
  leadTimeDays: number;
  thicknessOptions: number[];
  layersOptions: number[];
  finishes: string[];
  hasAssembly: boolean;
  config: DRCConfig;
}

export const MANUFACTURER_SPECS: ManufacturerSpec[] = [
  {
    name: 'JLCPCB',
    url: 'https://jlcpcb.com',
    tier: 'economy',
    moq: 5,
    leadTimeDays: 2,
    thicknessOptions: [0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
    layersOptions: [2, 4, 6],
    finishes: ['HASL', 'HASL-LF', 'ENIG', 'OSP'],
    hasAssembly: true,
    config: { minClearance: 0.127, minTraceWidth: 0.127, minDrillSize: 0.3, minAnnularRing: 0.1, minCourtyard: 0.5, minSilkClearance: 0.15 },
  },
  {
    name: 'PCBWay',
    url: 'https://pcbway.com',
    tier: 'standard',
    moq: 5,
    leadTimeDays: 3,
    thicknessOptions: [0.6, 0.8, 1.0, 1.2, 1.6, 2.0, 2.4],
    layersOptions: [2, 4, 6, 8],
    finishes: ['HASL', 'HASL-LF', 'ENIG', 'Immersion Silver', 'OSP'],
    hasAssembly: true,
    config: { minClearance: 0.1524, minTraceWidth: 0.1524, minDrillSize: 0.3, minAnnularRing: 0.127, minCourtyard: 0.5, minSilkClearance: 0.15 },
  },
  {
    name: 'OSHPark',
    url: 'https://oshpark.com',
    tier: 'standard',
    moq: 3,
    leadTimeDays: 12,
    thicknessOptions: [1.6],
    layersOptions: [2, 4],
    finishes: ['ENIG'],
    hasAssembly: false,
    config: { minClearance: 0.1524, minTraceWidth: 0.1524, minDrillSize: 0.33, minAnnularRing: 0.1524, minCourtyard: 0.5, minSilkClearance: 0.15 },
  },
  {
    name: 'Aisler',
    url: 'https://aisler.net',
    tier: 'standard',
    moq: 1,
    leadTimeDays: 7,
    thicknessOptions: [1.6],
    layersOptions: [2, 4],
    finishes: ['ENIG', 'HASL-LF'],
    hasAssembly: false,
    config: { minClearance: 0.15, minTraceWidth: 0.15, minDrillSize: 0.3, minAnnularRing: 0.15, minCourtyard: 0.5, minSilkClearance: 0.15 },
  },
  {
    name: 'Seeed Fusion',
    url: 'https://seeedstudio.com/fusion',
    tier: 'economy',
    moq: 5,
    leadTimeDays: 5,
    thicknessOptions: [0.8, 1.0, 1.2, 1.6],
    layersOptions: [2, 4],
    finishes: ['HASL', 'HASL-LF', 'ENIG'],
    hasAssembly: true,
    config: { minClearance: 0.15, minTraceWidth: 0.15, minDrillSize: 0.3, minAnnularRing: 0.15, minCourtyard: 0.5, minSilkClearance: 0.15 },
  },
];

// Back-compat: the old any-typed exports now point at the typed table.
export const JLC_PCB_SPEC = MANUFACTURER_SPECS[0];
export const PCBWAY_SPEC = MANUFACTURER_SPECS[1];

export function mmToMil(mm: number): number { return mm / 0.0254; }
export function milToMm(mil: number): number { return mil * 0.0254; }

export function getManufacturerSpec(name: string): ManufacturerSpec | null {
  const m: Record<string, ManufacturerSpec> = {
    'JLC PCB': MANUFACTURER_SPECS[0],
    JLCPCB: MANUFACTURER_SPECS[0],
    PCBWay: MANUFACTURER_SPECS[1],
    OSHPark: MANUFACTURER_SPECS[2],
    Aisler: MANUFACTURER_SPECS[3],
    'Seeed Fusion': MANUFACTURER_SPECS[4],
  };
  return m[name] ?? null;
}

export function listManufacturerNames(): string[] {
  return MANUFACTURER_SPECS.map((s) => s.name);
}
