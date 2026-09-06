// AI Tool types — shared across all tool category files.

import type { CircuitDocument, SimContext } from '@/lib/circuit/types';
import type { BoardOutline, Footprint, Trace, Via, Ratsnest } from '@/lib/pcb/types';
import type { CopperPour } from '@/lib/pcb/copper-pour';

export interface ToolContext {
  doc: CircuitDocument;
  /**
   * Server-side PCB state — populated by pcb.importFromSchematic and then
   * mutated by pcb.autoRoute / pcb.topoRoute / via tools. The turn runner
   * snapshots it into `pcb_update` events so the client's PCB view follows
   * along live.
   */
  pcb?: {
    board: BoardOutline;
    footprints: Footprint[];
    traces: Trace[];
    vias: Via[];
    ratsnest: Ratsnest[];
    /** pad key `${componentId}:${terminalId}` → net name */
    padNets: Map<string, string>;
    /** default trace width in mm (pcb.setDefaultTraceWidth) */
    defaultTraceWidth?: number;
    /** generated copper pours (pcb.addCopperPour) */
    copperPours?: CopperPour[];
  };
  simContext?: SimContext | null;
  plugins: Map<string, any>;
  /**
   * Turn-scoped circuit mutation history backing schematic.undo / schematic.redo.
   * Managed by the turn runner: a snapshot of the doc is pushed BEFORE every
   * mutating tool executes (undo/redo themselves manage the stacks).
   */
  history?: {
    undoStack: string[];
    redoStack: string[];
  };
  /**
   * Component types the AI asked for but that don't exist in the library.
   * Recorded by schematic.addComponent; surfaced to the user at the end of
   * the turn ("Missing components" card) so they know what to add to the
   * library to unblock the AI.
   */
  missingComponents?: Set<string>;
  /**
   * Conversation snapshot for transcript.export: the client's prior
   * user/assistant turns (role + content) plus, as the turn progresses,
   * tool-call summaries appended by the turn runner. Populated by the turn
   * runner from the request body — the tool itself must NOT reach into a
   * client-side store (the server has its own empty module instance, so
   * that path always read an empty conversation).
   */
  messages?: { role: 'user' | 'assistant'; content: string; toolCalls?: { name: string; ok: boolean }[] }[];
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
