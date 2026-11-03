// Fabrication pre-flight: what is wrong with this board before it is sent to
// a fab house. Export never used to look — "Gerbers exported" was reported
// for boards with open nets or DRC errors.

import { runDRC, type DRCConfig, type DRCError, type DRCWaiver } from './drc';
import type { BoardOutline, Footprint, Ratsnest, Trace, Via } from './types';

export interface FabPreflight {
  ok: boolean;
  /** nets whose pads are not all joined by copper */
  unroutedNets: number;
  /** DRC errors other than unrouted nets (clearance, shorts, width, …) */
  ruleErrors: number;
  /** one-line summary for a toast; '' when ok */
  summary: string;
  errors: DRCError[];
}

export function fabPreflight(
  footprints: Footprint[], traces: Trace[], vias: Via[], ratsnest: Ratsnest[], board: BoardOutline,
  config: DRCConfig, netClasses?: Parameters<typeof runDRC>[6], waivers?: DRCWaiver[],
): FabPreflight {
  const errors = runDRC(footprints, traces, vias, ratsnest, board, config, netClasses, waivers)
    .filter((e) => e.severity === 'error');
  const unroutedNets = errors.filter((e) => e.type === 'unrouted').length;
  const ruleErrors = errors.length - unroutedNets;
  const parts: string[] = [];
  if (unroutedNets) parts.push(`${unroutedNets} net${unroutedNets > 1 ? 's' : ''} not fully routed`);
  if (ruleErrors) parts.push(`${ruleErrors} DRC error${ruleErrors > 1 ? 's' : ''}`);
  return {
    ok: errors.length === 0,
    unroutedNets,
    ruleErrors,
    summary: parts.length ? `${parts.join(' and ')} — a board made from these files will not work as designed. Run DRC to see where.` : '',
    errors,
  };
}
