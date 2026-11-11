// Fabrication pre-flight: what is wrong with this board before it is sent to
// a fab house. Export never used to look — "Gerbers exported" was reported
// for boards with open nets or DRC errors.

import { runDRC, type DRCConfig, type DRCError, type DRCWaiver } from './drc';
import type { BoardOutline, Footprint, Ratsnest, Trace, Via } from './types';

export interface FabBlocker {
  type: DRCError['type'];
  /** why this blocks fabrication */
  reason: string;
  message: string;
  position: { x: number; y: number };
}

export interface FabPreflight {
  ok: boolean;
  /** nets whose pads are not all joined by copper */
  unroutedNets: number;
  /** DRC errors other than unrouted nets (clearance, shorts, width, …) */
  ruleErrors: number;
  /** footprints using a generic (unverified) pinout */
  unverifiedFootprints: number;
  /** required real-part pins left unwired */
  unwiredRequiredPins: number;
  /** non-blocking warnings (silkscreen, courtyard, advisory width, …) */
  warnings: number;
  /** one-line summary for a toast; '' when ok */
  summary: string;
  /** every error-severity DRC violation */
  errors: DRCError[];
  /** everything that blocks fab, including non-geometric warnings (unverified footprints, unwired pins) */
  blockers: FabBlocker[];
}

const NON_GEOMETRIC_BLOCKERS: Partial<Record<DRCError['type'], string>> = {
  unverified_footprint: 'footprint pinout is not checked against a real part — the fabricated/assembled board may be miswired',
  unwired_required_pin: 'a required real-part pin has no connection — the part will not work as designed',
};

export function fabPreflight(
  footprints: Footprint[], traces: Trace[], vias: Via[], ratsnest: Ratsnest[], board: BoardOutline,
  config: DRCConfig, netClasses?: Parameters<typeof runDRC>[6], waivers?: DRCWaiver[],
): FabPreflight {
  const all = runDRC(footprints, traces, vias, ratsnest, board, config, netClasses, waivers);
  const errors = all.filter((e) => e.severity === 'error');
  const nonGeo = all.filter((e) => e.severity !== 'error' && NON_GEOMETRIC_BLOCKERS[e.type]);
  const unroutedNets = errors.filter((e) => e.type === 'unrouted').length;
  const ruleErrors = errors.length - unroutedNets;
  const unverifiedFootprints = nonGeo.filter((e) => e.type === 'unverified_footprint').length;
  const unwiredRequiredPins = nonGeo.filter((e) => e.type === 'unwired_required_pin').length;
  const blockers: FabBlocker[] = [
    ...errors.map((e) => ({
      type: e.type, message: e.message, position: e.position,
      reason: e.type === 'unrouted' ? 'net is not fully connected' : 'violates a fabrication rule',
    })),
    ...nonGeo.map((e) => ({ type: e.type, message: e.message, position: e.position, reason: NON_GEOMETRIC_BLOCKERS[e.type]! })),
  ];
  const parts: string[] = [];
  if (unroutedNets) parts.push(`${unroutedNets} net${unroutedNets > 1 ? 's' : ''} not fully routed`);
  if (ruleErrors) parts.push(`${ruleErrors} DRC error${ruleErrors > 1 ? 's' : ''}`);
  if (unverifiedFootprints) parts.push(`${unverifiedFootprints} unverified footprint${unverifiedFootprints > 1 ? 's' : ''}`);
  if (unwiredRequiredPins) parts.push(`${unwiredRequiredPins} unwired required pin${unwiredRequiredPins > 1 ? 's' : ''}`);
  return {
    ok: blockers.length === 0,
    unroutedNets,
    ruleErrors,
    unverifiedFootprints,
    unwiredRequiredPins,
    warnings: all.length - errors.length - nonGeo.length,
    summary: parts.length ? `${parts.join(', ')} — a board made from these files will not work as designed. Run DRC to see where.` : '',
    errors,
    blockers,
  };
}
