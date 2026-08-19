// Type definitions and shared constants for CircuitCanvas.
import type { Vec2 } from '@/lib/circuit/types';

export const CELL_SIZE = 18;

export interface DragState {
  componentId: string;
  offset: Vec2;
  isGroupDrag?: boolean;
  lastGrid?: Vec2;
}

export interface WireDragState {
  wireId: string;
  segIndex: number;
  startGrid: Vec2;
  originalWaypoints: Vec2[];
}

export interface RotateDragState {
  componentId: string;
  center: Vec2;
  startAngle: number;
  startRotation: 0 | 1 | 2 | 3;
}

export interface HoverState {
  componentId: string | null;
  terminal: { componentId: string; terminalId: string; pos: Vec2 } | null;
  wireId: string | null;
  wireHandle: { wireId: string; segIndex: number; pos: Vec2 } | null;
  rotateHandle: string | null;
}

/** Types of components that can be toggled by clicking during simulation. */
export const TOGGLEABLE_TYPES = new Set(['switch', 'pushButton']);
