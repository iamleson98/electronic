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

export interface TerminalDef {
  /** terminal id, unique within a component */
  id: string;
  /** label shown next to the terminal */
  label: string;
  /** position relative to the component origin (in grid units) */
  position: Vec2;
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
}

export interface Wire {
  id: string;
  /** source component id + terminal id */
  from: { componentId: string; terminalId: string };
  /** target component id + terminal id */
  to: { componentId: string; terminalId: string };
}

export interface CircuitDocument {
  version: 1;
  components: CircuitComponent[];
  wires: Wire[];
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
