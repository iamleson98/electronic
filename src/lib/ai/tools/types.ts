// AI Tool types — shared across all tool category files.

import type { CircuitDocument, SimContext } from '@/lib/circuit/types';
import type { BoardOutline, Footprint, Trace, Via } from '@/lib/pcb/types';

export interface ToolContext {
  doc: CircuitDocument;
  pcb?: {
    board: BoardOutline;
    footprints: Footprint[];
    traces: Trace[];
    vias: Via[];
  };
  simContext?: SimContext | null;
  plugins: Map<string, any>;
}

export interface ToolResult {
  ok: boolean;
  result?: any;
  error?: string;
}

export interface Tool {
  name: string;
  category: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
