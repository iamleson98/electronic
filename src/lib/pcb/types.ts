// PCB (Printed Circuit Board) type definitions.
// These describe the physical layout of a PCB: footprints, pads, traces,
// vias, board outline, and copper layers.
// Supports 2-layer, 4-layer, and 6-layer boards.

import type { CopperPour } from './copper-pour';

/** Copper layer identifier */
export type CopperLayer = 'top' | 'inner1' | 'inner2' | 'inner3' | 'inner4' | 'bottom';

/** All valid copper layers (for iteration) */
export const ALL_COPPER_LAYERS: CopperLayer[] = ['top', 'inner1', 'inner2', 'inner3', 'inner4', 'bottom'];

/** Layer configuration for multi-layer boards */
export interface LayerStack {
  layers: CopperLayer[];
  /** thickness of each layer in mm (for 3D rendering) */
  thickness: Record<CopperLayer, number>;
  /** dielectric thickness between layers in mm */
  dielectric: number[];
  /** Material name (e.g. "FR4", "Rogers RO4350B") */
  material?: string;
  /** Copper weight in oz (1 oz = 35μm) */
  copperWeight?: number;
}

/** Default 2-layer stack */
export const DEFAULT_LAYER_STACK: LayerStack = {
  layers: ['top', 'bottom'],
  thickness: { top: 0.035, inner1: 0.035, inner2: 0.035, inner3: 0.035, inner4: 0.035, bottom: 0.035 },
  dielectric: [1.5], // 1.5mm FR4 between top and bottom
  material: 'FR4',
  copperWeight: 1,
};

/** 4-layer stack (signal-power-ground-signal) */
export const FOUR_LAYER_STACK: LayerStack = {
  layers: ['top', 'inner1', 'inner2', 'bottom'],
  thickness: { top: 0.035, inner1: 0.035, inner2: 0.035, inner3: 0.035, inner4: 0.035, bottom: 0.035 },
  dielectric: [0.2, 1.0, 0.2], // prepreg, core, prepreg
  material: 'FR4',
  copperWeight: 1,
};

/** 6-layer stack (sig-gnd-sig-sig-pwr-sig) — common impedance-controlled stackup */
export const SIX_LAYER_STACK: LayerStack = {
  layers: ['top', 'inner1', 'inner2', 'inner3', 'inner4', 'bottom'],
  thickness: { top: 0.035, inner1: 0.035, inner2: 0.035, inner3: 0.035, inner4: 0.035, bottom: 0.035 },
  dielectric: [0.1, 0.2, 0.4, 0.2, 0.1],
  material: 'FR4',
  copperWeight: 1,
};

/** Layer display colors (standard PCB convention) */
export const LAYER_COLORS: Record<CopperLayer, string> = {
  top: '#dc2626',     // red
  inner1: '#fbbf24',  // yellow (power)
  inner2: '#22c55e',  // green (ground)
  inner3: '#a855f7',  // purple
  inner4: '#06b6d4',  // cyan
  bottom: '#2563eb',  // blue
};

/** Via types — determines which layers the via connects */
export type ViaType = 'tht' | 'blind' | 'buried' | 'micro';

/** A physical pad on a PCB (where a component pin is soldered) */
export interface Pad {
  id: string;
  /** component instance id from the schematic */
  componentId: string;
  /** terminal id from the schematic (maps to schematic netlist) */
  terminalId: string;
  /** position in mm relative to the board origin (bottom-left) */
  position: { x: number; y: number };
  /** pad shape */
  shape: 'circle' | 'rect' | 'oval' | 'polygon';
  /** pad size in mm */
  size: { width: number; height: number };
  /** net name (assigned from schematic netlist, e.g. "VCC", "GND", "N1") */
  net?: string;
  /** which copper layer this pad is on */
  layer: CopperLayer;
  /** For polygon pads: list of polygon vertices (mm, relative to pad.position) */
  polygon?: { x: number; y: number }[];
  /** Drill diameter in mm. > 0 means THT (plated through-hole). 0 = SMD. */
  drill?: number;
}

/** A component footprint placed on the PCB */
export interface Footprint {
  id: string;
  /** component instance id from the schematic */
  componentId: string;
  /** component type (e.g. 'resistor', 'led') */
  componentType: string;
  /** reference designator (e.g. "R1", "LED1") */
  refdes: string;
  /** position in mm relative to board origin */
  position: { x: number; y: number };
  /** rotation in degrees (0, 90, 180, 270) */
  rotation: number;
  /** physical body size in mm (for outline drawing) */
  bodySize: { width: number; height: number };
  /** pads on this footprint */
  pads: Pad[];
  /** which side of the board */
  side: CopperLayer;
  /**
   * Optional URL to a 3D model file (STL, VRML, or OBJ) for this footprint.
   * When set, the 3D viewer fetches and parses the model asynchronously;
   * on failure it falls back to a default model or parametric box.
   */
  modelUrl?: string;
}

/** A copper trace segment on the PCB */
export interface TraceSegment {
  /** start point in mm */
  start: { x: number; y: number };
  /** end point in mm */
  end: { x: number; y: number };
  /** trace width in mm */
  width: number;
}

/** A complete trace (one or more connected segments) */
export interface Trace {
  id: string;
  /** net name this trace belongs to */
  net: string;
  /** which copper layer */
  layer: CopperLayer;
  /** trace segments */
  segments: TraceSegment[];
  /** width in mm */
  width: number;
  /** For differential pairs: the ID of the paired trace (same net + "_N" suffix).
   *  Set when the trace is created via the diff-pair router. */
  pairedTraceId?: string;
}

/** A via connecting traces on different layers */
export interface Via {
  id: string;
  position: { x: number; y: number };
  /** outer diameter in mm */
  diameter: number;
  /** inner drill diameter in mm */
  drill: number;
  /** net name */
  net: string;
  /** Via type: THT (through-hole), blind (surface to inner), buried (inner to inner), micro (laser-drilled, very small) */
  type?: ViaType;
  /** For blind/buried vias: the layers this via spans. THT = ['top', 'bottom']. */
  fromLayer?: CopperLayer;
  toLayer?: CopperLayer;
}

/** A ratsnest connection (airwire showing what needs routing) */
export interface Ratsnest {
  /** from pad id */
  fromPadId: string;
  /** to pad id */
  toPadId: string;
  /** net name */
  net: string;
  /** from position in mm */
  from: { x: number; y: number };
  /** to position in mm */
  to: { x: number; y: number };
  /** True when both pads are already connected by same-net copper — the
   *  airwire is satisfied and must NOT be drawn (kept as a flag rather than
   *  deleting the leg so re-runs/unroute can restore it). */
  routed?: boolean;
}

/** PCB board outline */
export interface BoardOutline {
  width: number;  // mm
  height: number; // mm
}

/** A complete PCB document */
export interface PCBDocument {
  version: 1;
  board: BoardOutline;
  footprints: Footprint[];
  traces: Trace[];
  vias: Via[];
  /** active layer being edited */
  activeLayer: CopperLayer;
  /** default trace width in mm */
  defaultTraceWidth: number;
  /** Layer stack configuration (2/4/6 layer) */
  layerStack?: LayerStack;
  /** Copper pours (ground/power planes) — restored by loadDocument */
  copperPours?: CopperPour[];
  /** Serialized form of the padNets Map: [terminalKey, netName] entries */
  padNets?: [string, string][];
  /** Keepout rectangles (copper routing exclusion zones) */
  keepouts?: PCBKeepout[];
  /** Per-net routing rules (width / clearance / via sizes) */
  netClasses?: PCBNetClass[];
  /** Teardrop relief shapes at pad↔trace junctions */
  teardrops?: PCBTeardrop[];
}

/** A routing keepout zone */
export interface PCBKeepout {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  layers: 'all' | string[];
  reason?: string;
}

/** A per-net routing rule */
export interface PCBNetClass {
  name: string;
  traceWidth: number;
  clearance: number;
  viaDiameter: number;
  viaDrill: number;
  nets: string[];
}

/** A teardrop relief shape */
export interface PCBTeardrop {
  id: string;
  position: { x: number; y: number };
  padId: string;
  points: { x: number; y: number }[];
  layer: string;
}

/** Footprint definition for a component type (template) */
export interface FootprintDef {
  /** body size in mm */
  bodySize: { width: number; height: number };
  /** pad definitions (relative to footprint center) */
  pads: FootprintPadDef[];
  /** Optional human-readable name (used by the footprint editor + library manager) */
  name?: string;
  /** Optional reference designator prefix (e.g. "R", "U") */
  refdesPrefix?: string;
}

/** A pad definition in a FootprintDef. Fields beyond the legacy
 *  shape/size/position/terminalId are optional so that the existing
 *  footprint registry (resistor, capacitor, …) and KiCad-imported
 *  footprints keep working unchanged.
 *
 *  When the user designs a footprint in the WYSIWYG editor, the saved
 *  FootprintDef will include `layer` and `drill` so the placed Footprint
 *  can render the drill hole and correct layer colour. */
export interface FootprintPadDef {
  terminalId: string;
  position: { x: number; y: number };
  shape: 'circle' | 'rect' | 'oval' | 'polygon';
  size: { width: number; height: number };
  /** Copper layer this pad is on. Defaults to 'top' when absent. */
  layer?: CopperLayer;
  /** Drill diameter in mm. When > 0, the pad is a THT pad with a drill hole. */
  drill?: number;
  /** For polygon shapes: list of polygon vertices */
  polygon?: { x: number; y: number }[];
}
