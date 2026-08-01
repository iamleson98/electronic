// Core type definitions for the circuit simulator
// All components, wires, nodes, and simulation state are described here.

export type Vec2 = { x: number; y: number };

export type ParameterType = 'number' | 'string' | 'select' | 'boolean' | 'color';

export interface ParameterDef {
  key: string;
  label: string;
  type: ParameterType;
  default: number | string | boolean;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  description?: string;
}

export type ComponentCategory =
  | 'passive'
  | 'source'
  | 'semiconductor'
  | 'ic'
  | 'meter'
  | 'mcu'
  | 'io'
  | 'logic';

// ─────────────────────────────────────────────────────────────────────────────
// Pin electrical & graphical types (KiCad eeschema parity)
// ─────────────────────────────────────────────────────────────────────────────

export type PinElecType =
  | 'input'
  | 'output'
  | 'bidirectional'
  | 'tri_state'
  | 'passive'
  | 'power_in'
  | 'power_out'
  | 'open_collector'
  | 'open_emitter'
  | 'unconnected'
  | 'nc'
  | 'free'
  | 'unspecified';

export type PinShape =
  | 'line'
  | 'inverted'
  | 'clock'
  | 'inverted_clock'
  | 'input_low'
  | 'clock_low'
  | 'falling_edge'
  | 'non_logic';

export interface TerminalDef {
  /** terminal id, unique within a component */
  id: string;
  /** label shown next to the terminal */
  label: string;
  /** position relative to the component origin (in grid units) */
  position: Vec2;
  /** KiCad pin electrical type (input/output/bidir/passive/power/OC/OE/etc.) */
  electricalType?: PinElecType;
  /** pin name (separate from label) — e.g. "IN+" */
  name?: string;
  /** pin number string ("1", "8", "A1") */
  number?: string;
  /** pin length in grid units (KiCad default 0; conventional 1–3) */
  length?: number;
  /** graphical pin shape */
  shape?: PinShape;
  /** hidden pin — auto-connected by net name (used for hidden power pins) */
  hidden?: boolean;
  /** multi-unit component unit index (1=A, 2=B, ...) */
  unit?: number;
  /** De Morgan conversion: 0=both, 1=normal, 2=alternate body */
  convert?: 0 | 1 | 2;
}

export interface ComponentBoundingBox {
  width: number;
  height: number;
}

/**
 * Runtime context handed to a plugin's render & simulate methods.
 * The simulator provides voltages for every node; plugins look up their terminals' node ids.
 */
export interface SimContext {
  /** node id -> voltage (volts). node 0 is always ground = 0V. */
  nodeVoltage: Float64Array;
  /** branch currents (extra vars) */
  branchCurrent: Float64Array;
  /** per-component state object (mutable) - plugins keep memory here */
  state: Record<string, any>;
  /** current simulation time, in seconds */
  time: number;
  /** timestep, in seconds */
  dt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// User-defined fields per component (KiCad "Fields" tab)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComponentField {
  key: string;
  name: string;
  value: string;
  visible: boolean;
  /** position offset from component origin in grid units (auto-placed if undefined) */
  position?: Vec2;
  /** rotation in 90° increments */
  rotation?: 0 | 1 | 2 | 3;
}

export interface CircuitComponent {
  /** unique instance id */
  id: string;
  /** plugin type id, e.g. 'resistor' */
  type: string;
  /** grid position (top-left of bounding box) */
  position: Vec2;
  /** rotation in 90-degree increments: 0,1,2,3 */
  rotation: 0 | 1 | 2 | 3;
  /** per-instance parameter overrides */
  parameters: Record<string, number | string | boolean>;
  /** runtime simulation state (not serialized in some cases) */
  simState?: Record<string, any>;
  /** explicit reference designator (e.g., "R1", "C2"). If absent, derived from id. */
  refdes?: string;
  // ── New KiCad-parity fields ───────────────────────────────────────────────
  /** mirror around X axis (vertical flip) */
  mirrorX?: boolean;
  /** mirror around Y axis (horizontal flip) */
  mirrorY?: boolean;
  /** locked = cannot be moved/deleted without unlock */
  locked?: boolean;
  /** which unit of a multi-unit component this instance represents (1=A, 2=B, ...) */
  unit?: number;
  /** De Morgan conversion: 1=normal, 2=alternate body style */
  convert?: 1 | 2;
  /** Free rotation in degrees (overrides `rotation` when set). Snapped to 15° increments. */
  rotationDeg?: number;
  /** user-defined fields (Footprint, Datasheet, MPN, custom...) */
  fields?: ComponentField[];
  /** net class assigned to this component's primary net (schematic-side) */
  netClassId?: string;
}

export interface Wire {
  id: string;
  /** source component id + terminal id */
  from: { componentId: string; terminalId: string };
  /** target component id + terminal id */
  to: { componentId: string; terminalId: string };
  /** user-defined waypoints (in grid coords) for custom routing */
  waypoints?: Vec2[];
  /** explicit net name override (otherwise derived from connected labels) */
  netName?: string;
  /** whether this wire represents a multi-bit bus connection */
  isBus?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Net classes (schematic-side rules that propagate to PCB)
// ─────────────────────────────────────────────────────────────────────────────

export interface NetClass {
  id: string;
  name: string;
  description?: string;
  /** net names assigned to this class */
  nets: string[];
  /** propagation to PCB layout rules */
  traceWidth?: number;     // mm
  viaDrill?: number;        // mm
  viaDiameter?: number;     // mm
  clearance?: number;       // mm
  /** color used to highlight class members on canvas */
  color?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// No-Connect marker — KiCad's red X on intentionally unused pins
// ─────────────────────────────────────────────────────────────────────────────

export interface NoConnectMarker {
  id: string;
  componentId: string;
  terminalId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchical sheets — multi-sheet design (KiCad hierarchical sheets)
// ─────────────────────────────────────────────────────────────────────────────

export type SheetPinSide = 'top' | 'bottom' | 'left' | 'right';

export interface HierarchicalPin {
  id: string;
  name: string;
  electricalType: PinElecType;
  /** position relative to the sheet box (grid units) */
  position: Vec2;
  side: SheetPinSide;
}

export interface HierarchicalSheet {
  id: string;
  /** instance name shown inside the sheet box (e.g. "Amplifier") */
  sheetName: string;
  /** unique fileName of the subsheet (e.g. "amplifier.kicad_sch") */
  fileName: string;
  /** position of top-left corner (grid units) */
  position: Vec2;
  /** sheet box size (grid units) */
  size: { width: number; height: number };
  /** sheet pins — visible connection points on the sheet box */
  pins: HierarchicalPin[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawing primitives — graphics not tied to a component (KiCad "graphic" items)
// ─────────────────────────────────────────────────────────────────────────────

export type DrawingPrimitive =
  | { type: 'line'; id: string; points: [Vec2, Vec2]; strokeWidth: number; color: string }
  | {
      type: 'polyline';
      id: string;
      points: Vec2[];
      strokeWidth: number;
      color: string;
      closed?: boolean;
      fill?: string;
    }
  | {
      type: 'polygon';
      id: string;
      points: Vec2[];
      fill: string;
      stroke?: string;
      strokeWidth?: number;
    }
  | {
      type: 'arc';
      id: string;
      center: Vec2;
      radius: number;
      startAngle: number; // radians
      endAngle: number; // radians
      strokeWidth: number;
      color: string;
    }
  | {
      type: 'circle';
      id: string;
      center: Vec2;
      radius: number;
      strokeWidth: number;
      color: string;
      fill?: string;
    }
  | {
      type: 'text';
      id: string;
      position: Vec2;
      text: string;
      fontSize: number;
      color: string;
      rotation?: 0 | 90 | 180 | 270;
    }
  | {
      type: 'image';
      id: string;
      position: Vec2;
      size: { width: number; height: number };
      dataUrl: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Group — persistent grouping of components/wires/drawings
// ─────────────────────────────────────────────────────────────────────────────

export interface Group {
  id: string;
  name: string;
  componentIds: string[];
  wireIds: string[];
  drawingIds: string[];
  locked?: boolean;
  color?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page setup & title block
// ─────────────────────────────────────────────────────────────────────────────

export type PageSize =
  | 'A4'
  | 'A3'
  | 'A2'
  | 'A1'
  | 'A0'
  | 'Letter'
  | 'Legal'
  | 'Tabloid'
  | 'Custom';

export interface PageSetup {
  size: PageSize;
  width: number; // mm
  height: number; // mm
  orientation: 'portrait' | 'landscape';
  showBorder: boolean;
  showTitleBlock: boolean;
}

export interface TitleBlock {
  title: string;
  company: string;
  revision: string;
  date: string;
  sheetNumber: number;
  totalSheets: number;
  author: string;
  comments?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved view
// ─────────────────────────────────────────────────────────────────────────────

export interface SavedView {
  id: string;
  name: string;
  /** camera in canvas (grid coords) */
  camera: { x: number; y: number; zoom: number };
  layerVisibility?: Record<string, boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Net label scope (KiCad: local / global / hierarchical)
// ─────────────────────────────────────────────────────────────────────────────

export type LabelScope = 'local' | 'global' | 'hierarchical';

// ─────────────────────────────────────────────────────────────────────────────
// Bus vector definition (e.g. D[0..7])
// ─────────────────────────────────────────────────────────────────────────────

export interface BusVectorDef {
  baseName: string;
  startBit: number;
  endBit: number;
}

export interface CircuitDocument {
  version: 1;
  components: CircuitComponent[];
  wires: Wire[];
  // ── New KiCad-parity fields (all optional for backward compatibility) ──────
  sheets?: HierarchicalSheet[];
  netClasses?: NetClass[];
  drawings?: DrawingPrimitive[];
  noConnects?: NoConnectMarker[];
  groups?: Group[];
  pageSetup?: PageSetup;
  titleBlock?: TitleBlock;
  savedViews?: SavedView[];
  /** child sheets keyed by fileName */
  childSheets?: Record<string, CircuitDocument>;
  /** currently active sheet fileName ('' = root) */
  activeSheet?: string;
  metadata?: {
    title?: string;
    company?: string;
    revision?: string;
    date?: string;
    author?: string;
  };
  /** bus vector definitions (KiCad bus alias) */
  busVectors?: BusVectorDef[];
}

// ----- Plugin interface -----

/**
 * A ComponentPlugin describes how a part looks, what parameters it has,
 * and how it contributes to the linear system (MNA) during simulation.
 *
 * Plugins are registered in `registry.ts`. New components can be added
 * at runtime by calling `registerPlugin(...)`.
 */
export interface ComponentPlugin {
  type: string;
  name: string;
  category: ComponentCategory;
  description: string;
  /** small symbol shown in palette (emoji or short text) */
  symbol: string;
  /** lucide icon name for palette / cursor */
  icon?: string;
  boundingBox: ComponentBoundingBox;
  terminals: TerminalDef[];
  parameters: ParameterDef[];
  /** default parameters (also derivable from `parameters`) */
  defaults?: Record<string, number | string | boolean>;
  /** for multi-unit components: list of unit labels (['A','B','C','D'] for 7400) */
  units?: string[];
  /** pin swap groups — pins inside same group can be swapped (e.g. opamp inputs) */
  pinSwapGroups?: string[][];
  /** gate swap groups — units that can be swapped (e.g. 7400 gates A↔B) */
  gateSwapGroups?: string[][];
  /** has alternate body (De Morgan) */
  hasAlternateBody?: boolean;
  /** keywords for search/filter */
  keywords?: string[];
  /** default footprint reference */
  defaultFootprint?: string;
  /** datasheet URL */
  datasheet?: string;

  /**
   * Draw the component on a 2D canvas context.
   * The context is already translated to the component origin and rotated.
   * `boundingBox.width` and `boundingBox.height` are in grid units (1 unit = 1 cell).
   */
  render: (
    ctx: CanvasRenderingContext2D,
    params: Record<string, any>,
    cellSize: number,
    sim?: SimContext,
    instance?: CircuitComponent,
  ) => void;

  /**
   * Stamp the component's contribution into the MNA system.
   * Plugins mutate `system` (G, I, etc.) to add their conductances and sources.
   *
   * `terminals` is the resolved list of {terminalId, nodeId} for this instance.
   */
  stamp?: (
    params: Record<string, any>,
    terminals: { terminalId: string; nodeId: number }[],
    system: MnaSystem,
    sim: SimContext,
  ) => void;

  /**
   * Optional per-step update for non-linear or stateful components (555, MCU, etc).
   * Called after the linear solve so the component can react to new node voltages.
   */
  step?: (
    params: Record<string, any>,
    terminals: { terminalId: string; nodeId: number }[],
    sim: SimContext,
    instance: CircuitComponent,
  ) => void;

  /**
   * Optional: return a measured value to display in the probe panel.
   * Called after each solve.
   */
  measure?: (
    params: Record<string, any>,
    terminals: { terminalId: string; nodeId: number }[],
    sim: SimContext,
  ) => { label: string; value: string; unit?: string }[];

  /**
   * Optional: return the internal flow path for current animation dots.
   * Points are in grid coordinates, RELATIVE to the component origin (top-left
   * of bounding box), BEFORE rotation. The renderer will translate, rotate, and
   * scale them to screen coordinates.
   *
   * The path should go from one terminal to the other through the component body.
   * For a resistor with terminals at (0,1) and (4,1), the flow path might be
   * [(0,1), (2,1), (4,1)] — straight through the middle.
   *
   * If not provided, the renderer will draw a straight line between the two
   * terminals (for 2-terminal components only).
   *
   * `sim` is provided so components can adjust the path based on state (e.g.,
   * an open switch returns an empty path so no dots flow).
   */
  getFlowPath?: (
    params: Record<string, any>,
    sim?: SimContext,
    instance?: CircuitComponent,
  ) => Vec2[];
}

// ----- MNA system interface -----

/**
 * Modified Nodal Analysis system.
 * - G: n x n conductance matrix (n = number of non-ground nodes)
 * - z: n RHS vector
 * - For voltage sources / elements needing extra unknowns, we use the
 *   "extra row/col" extension. We track `extraVars` for branch currents.
 */
export interface MnaSystem {
  /** number of non-ground nodes */
  numNodes: number;
  /** number of extra (branch current) unknowns */
  numExtra: number;
  /** total system size = numNodes + numExtra */
  size: number;
  /** A matrix (size x size), row-major */
  A: Float64Array;
  /** z vector (size) */
  z: Float64Array;
  /** next available extra var index */
  nextExtra: number;

  /** helper to allocate a new extra variable (branch current) */
  addExtra: () => number;
  /** stamp conductance between two nodes */
  stampConductance: (n1: number, n2: number, g: number) => void;
  /** stamp a current source flowing from n1 to n2 (out of n1, into n2) */
  stampCurrentSource: (n1: number, n2: number, current: number) => void;
  /** stamp a voltage source between n1 and n2 with value V (Vn1 - Vn2 = V); returns branch current index */
  stampVoltageSource: (n1: number, n2: number, voltage: number) => number;
  /** stamp a VCVS: V(a)-V(b) = mu*(V(c)-V(d)) ; returns branch current index */
  stampVCVS: (a: number, b: number, c: number, d: number, mu: number) => number;
  /** stamp a VCCS: current from n1 to n2 = g*(V(c)-V(d)) */
  stampVCCS: (n1: number, n2: number, c: number, d: number, g: number) => void;
  /** stamp a CCCS: current from n1 to n2 = beta * I_branch(extraIndex) */
  stampCCCS: (n1: number, n2: number, extraIndex: number, beta: number) => void;
  /** stamp a CCVS: V(a)-V(b) = r * I_branch(extraIndex); returns new branch index */
  stampCCVS: (a: number, b: number, extraIndex: number, r: number) => number;
}

export interface SimulationResult {
  nodeVoltage: Float64Array;
  branchCurrent: Float64Array;
  time: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default page setups
// ─────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZES_MM: Record<string, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
  A1: { w: 841, h: 594 },
  A0: { w: 1189, h: 841 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
  Tabloid: { w: 279.4, h: 431.8 },
  Custom: { w: 297, h: 210 },
};

export const DEFAULT_PAGE_SETUP: PageSetup = {
  size: 'A4',
  width: 297,
  height: 210,
  orientation: 'landscape',
  showBorder: true,
  showTitleBlock: true,
};

export const DEFAULT_TITLE_BLOCK: TitleBlock = {
  title: 'Untitled',
  company: '',
  revision: 'Rev 1',
  date: new Date().toISOString().slice(0, 10),
  sheetNumber: 1,
  totalSheets: 1,
  author: '',
};
