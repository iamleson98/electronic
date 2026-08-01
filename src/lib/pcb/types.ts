// PCB (Printed Circuit Board) type definitions.
// These describe the physical layout of a PCB: footprints, pads, traces,
// vias, board outline, and copper layers.
// Supports 2-layer (top/bottom) and 4-layer (top/inner1/inner2/bottom) boards.

/** Copper layer identifier */
export type CopperLayer = 'top' | 'inner1' | 'inner2' | 'bottom';

/** Layer configuration for multi-layer boards */
export interface LayerStack {
  layers: CopperLayer[];
  /** thickness of each layer in mm (for 3D rendering) */
  thickness: Record<CopperLayer, number>;
  /** dielectric thickness between layers in mm */
  dielectric: number[];
}

/** Default 2-layer stack */
export const DEFAULT_LAYER_STACK: LayerStack = {
  layers: ['top', 'bottom'],
  thickness: { top: 0.035, inner1: 0.035, inner2: 0.035, bottom: 0.035 },
  dielectric: [1.5], // 1.5mm FR4 between top and bottom
};

/** 4-layer stack (signal-power-ground-signal) */
export const FOUR_LAYER_STACK: LayerStack = {
  layers: ['top', 'inner1', 'inner2', 'bottom'],
  thickness: { top: 0.035, inner1: 0.035, inner2: 0.035, bottom: 0.035 },
  dielectric: [0.2, 1.0, 0.2], // prepreg, core, prepreg
};

/** Layer display colors (standard PCB convention) */
export const LAYER_COLORS: Record<CopperLayer, string> = {
  top: '#dc2626',     // red
  inner1: '#fbbf24',  // yellow (power)
  inner2: '#22c55e',  // green (ground)
  bottom: '#2563eb',  // blue
};

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
  shape: 'circle' | 'rect' | 'oval';
  /** pad size in mm */
  size: { width: number; height: number };
  /** net name (assigned from schematic netlist, e.g. "VCC", "GND", "N1") */
  net?: string;
  /** which copper layer this pad is on */
  layer: CopperLayer;
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
}

/** A ratsnest connection (airwire showing what needs to be routed) */
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
}

/** Footprint definition for a component type (template) */
export interface FootprintDef {
  /** body size in mm */
  bodySize: { width: number; height: number };
  /** pad definitions (relative to footprint center) */
  pads: {
    terminalId: string;
    position: { x: number; y: number };
    shape: 'circle' | 'rect' | 'oval';
    size: { width: number; height: number };
  }[];
}
