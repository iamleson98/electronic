// Netlist sync: converts the schematic's wire graph into a PCB netlist.
// Maps each electrical node to a net name, and assigns nets to pads.
//
// Placement strategy (v3 — congestion-aware + module-clustered):
//   1. Components start at their SCHEMATIC positions (scaled to the board) —
//      schematics are drawn logically, so this is an excellent initial guess.
//   2. Functional-module clustering pre-pass: components sharing ≥ 2 small
//      nets (or one small net where a side has ≥ 2 pins) are unioned into
//      clusters; connectors/oscillators/regulators become anchors drawn
//      toward the cluster they serve. Intra-cluster attraction is boosted
//      and a soft centroid spring makes each module move as a rigid-ish unit
//      (arXiv:2502.14012 module-based placement; Flux "group regulators /
//      oscillators near targets" guidance).
//   3. Force relaxation pulls electrically-connected components together
//      (attraction along nets, weighted by net size) while courtyard overlap
//      pushes unrelated components apart.
//   4. RUDY-lite congestion feedback: after relaxation a coarse g-cell grid
//      compares routing DEMAND (each net's estimated routes spread
//      uniformly over its bounding box — rectangular uniform wire density —
//      plus pad escape demand) against track SUPPLY. Components with pins
//      near overflow cells get a locally inflated pairGap / repulsion, then
//      ≤ 2 extra iterations of the SAME relaxation loop spread them out
//      (Freerouting escape-congestion research: handle congestion at
//      placement time, not after jamming).
//   5. Two-pad components are rotated to face their strongest connection.
//   6. Final overlap resolution guarantees courtyard clearance with routing
//      channels (≥ 1.6 mm, inflated in congested zones) between components.
// With no wires — and whenever clustering finds no groups and no g-cell
// overflows — the output is bit-identical to the v2 behavior, so trivial
// boards keep their exact historical placement.
// Result: short ratsnest, compact board, coherent modules, and breathing
// room exactly where the router needs it.

import type { CircuitComponent, Wire, Vec2 } from '../circuit/types';
import { getPlugin } from '../circuit/registry';
import { buildNodeMap } from '../circuit/engine';
import type { Footprint, Pad, Ratsnest, BoardOutline } from './types';
import { getFootprintDef } from './footprints';
import { DEFAULT_DRC_CONFIG } from './drc';
import { DEFAULT_AUTOROUTE_OPTIONS } from './auto-router';

/** courtyard clearance kept between placed components (mm) — leaves routing channels */
const PLACE_GAP = 1.8;

/** Per-pair gap scaled by routing DEMAND: two multi-pin ICs facing each other
 *  need a channel wide enough for all the through-traffic their pins generate
 *  (a fixed 1.8mm channel jammed the digital-clock boards — three DIP-12s in
 *  a row left no way through). ~0.3mm per pin of the denser part, capped. */
function pairGap(padsA: number, padsB: number): number {
  const demand = Math.min(padsA, padsB);
  return PLACE_GAP + Math.min(4.0, 0.3 * demand);
}

// ── RUDY-lite congestion model ─────────────────────────────────────────────
/** g-cell size for congestion estimation (mm) — 1–2 mm per the Freerouting
 *  escape-congestion research; 1.5 mm ≈ one DIP pad per cell. */
const RUDY_CELL_SIZE = 1.5;
/** Routing process defaults the app actually uses (auto-router options and
 *  DRC config) — pinned by tests so drift is caught. */
const ROUTE_TRACE_WIDTH = DEFAULT_AUTOROUTE_OPTIONS.traceWidth; // 0.3 mm
const ROUTE_CLEARANCE = DEFAULT_DRC_CONFIG.minClearance;        // 0.2 mm
const ROUTE_PITCH = ROUTE_TRACE_WIDTH + ROUTE_CLEARANCE;        // 0.5 mm
const ROUTE_LAYERS = DEFAULT_AUTOROUTE_OPTIONS.layers.length;   // 2 (top+bottom)
/** Each pad claims half a g-cell track slot (escape stub + annular ring). */
const PAD_ESCAPE_DEMAND = 0.5;
/** Uniform-over-bbox RUDY underestimates peak density (real routes detour,
 *  escape pads and stack in both axes) — calibrated demand factor. */
const CONGESTION_DEMAND_FACTOR = 3.0;
/** Congestion feedback engages only once the board has real routing
 *  pressure — trivial boards stay on the v2 path bit-for-bit. */
const CONGESTION_MIN_NETS = 8;
/** Bounded re-relaxation iterations after congestion inflation. */
const CONGESTION_RE_RELAX = 2;
/** pairGap inflation: additive per congestion-hot component, capped. */
const CONGESTION_INFLATION = 0.8; // × (demand/supply − 1)
const CONGESTION_INFLATION_MAX = 2.2;
const CONGESTION_PAIR_MULT_CAP = 3.2;

// ── functional-module clustering ───────────────────────────────────────────
/** Nets with more members than this are rails (GND / VCC on any real board)
 *  and never define a functional module (matches the edge-damping threshold). */
const CLUSTER_MAX_NET_COMPS = 6;
/** Intra-cluster net attraction boost (module moves as one unit). */
const CLUSTER_ATT_BOOST = 3.0;
/** Soft centroid spring constants (force gain, capped step in mm). */
const CLUSTER_CENTROID_K = 0.06;
const CLUSTER_CENTROID_MAX_STEP = 0.9;
const ANCHOR_CENTROID_K = 0.04;
const ANCHOR_CENTROID_MAX_STEP = 0.7;
/** Connectors, oscillators, regulators, boards and transducers anchor to
 *  the cluster they serve (grouped near their related module). */
const CLUSTER_ANCHOR_TYPES = new Set([
  'switch', 'pushButton', 'relay', 'crystal', 'lm7805',
  'arduino', 'arduinoReal', 'raspberryPi',
  'speaker', 'sevenSegment', 'dcMotor', 'stepperMotor',
]);

/** Optional placement feature switches (both default ON; the store calls
 *  computeSmartPlacement without options, so the defaults apply). */
export interface PlacementOptions {
  /** RUDY-lite congestion feedback (default: enabled). */
  congestionFeedback?: boolean;
  /** functional-module clustering (default: enabled). */
  moduleClustering?: boolean;
}

/** Introspection for tests + tooling: what the placement passes detected. */
export interface PlacementStats {
  gridCellSize: number;
  gridCols: number;
  gridRows: number;
  /** g-cells with demand > supply before (and after) congestion feedback. */
  overflowCellsBefore: number;
  overflowCellsAfter: number;
  /** re-relaxation iterations actually run (≤ CONGESTION_RE_RELAX). */
  congestionReRelaxations: number;
  /** worst demand/supply ratio seen on the first grid. */
  maxDemandRatio: number;
  /** bounding box (mm) of the overflow cells before re-relaxation. */
  overflowRegion: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** multi-component functional clusters found. */
  clusters: number;
  clusteredComponents: number;
  /** anchors (connectors/oscillators/regulators) tied to a cluster. */
  anchoredComponents: number;
}

interface PlacementComp {
  comp: CircuitComponent;
  x: number; y: number;            // center position (mm)
  hw: number; hh: number;          // half extents incl. pads (mm)
  pads: number;                    // pad count (routing-demand proxy)
  refdes: string;
  /** congestion inflation for this component's pair gaps (0 = untouched). */
  congExtra?: number;
}

/** Effective half-extents of a component's footprint (body + pad reach). */
function footprintHalfExtents(type: string): { hw: number; hh: number; padCount: number } {
  const def = getFootprintDef(type);
  let maxX = def.bodySize.width / 2, maxY = def.bodySize.height / 2;
  for (const pad of def.pads) {
    maxX = Math.max(maxX, Math.abs(pad.position.x) + pad.size.width / 2);
    maxY = Math.max(maxY, Math.abs(pad.position.y) + pad.size.height / 2);
  }
  return { hw: maxX, hh: maxY, padCount: def.pads.length };
}

/** Generate a reference designator from component type and id */
function generateRefdes(type: string, id: string): string {
  const prefixMap: Record<string, string> = {
    resistor: 'R', capacitor: 'C', inductor: 'L', potentiometer: 'RV',
    led: 'LED', diode: 'D', switch: 'SW', pushButton: 'SW',
    npn: 'Q', pnp: 'Q', nmos: 'Q', pmos: 'Q',
    dcVoltage: 'BT', acVoltage: 'BT', pulseSource: 'BT', currentSource: 'I',
    ground: 'GND', opamp: 'U', timer555: 'U',
    oscilloscope: 'TP', voltmeter: 'TP', ammeter: 'TP',
    arduino: 'U', arduinoReal: 'U', raspberryPi: 'U',
    sevenSegment: 'DSP', speaker: 'SPK', photoresistor: 'LDR',
    junction: 'J',
  };
  const prefix = prefixMap[type] ?? 'U';
  const numMatch = id.match(/\d+$/);
  const num = numMatch ? numMatch[0] : '';
  return `${prefix}${num}`;
}

/**
 * Connectivity-driven placement (v3: congestion-aware + module-clustered).
 * Returns board-space center positions + rotations (0/90/180/270) per
 * component id, plus a `stats` object for introspection.
 */
export function computeSmartPlacement(
  components: CircuitComponent[],
  wires: Wire[],
  boardW: number,
  boardH: number,
  options: PlacementOptions = {},
): { positions: Map<string, { x: number; y: number }>; rotations: Map<string, number>; stats: PlacementStats } {
  const positions = new Map<string, { x: number; y: number }>();
  const rotations = new Map<string, number>();
  const stats: PlacementStats = {
    gridCellSize: RUDY_CELL_SIZE,
    gridCols: Math.max(1, Math.ceil(boardW / RUDY_CELL_SIZE)),
    gridRows: Math.max(1, Math.ceil(boardH / RUDY_CELL_SIZE)),
    overflowCellsBefore: 0,
    overflowCellsAfter: 0,
    congestionReRelaxations: 0,
    maxDemandRatio: 0,
    overflowRegion: null,
    clusters: 0,
    clusteredComponents: 0,
    anchoredComponents: 0,
  };
  if (components.length === 0) return { positions, rotations, stats };

  // ── connectivity graph ──────────────────────────────────────────────────
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const edges: { a: string; b: string; w: number }[] = [];
  // net (nodeId) → component ids / terminals (terminals feed both the
  // clustering pre-pass and the RUDY congestion grid)
  const netComps = new Map<number, Set<string>>();
  const netTerminals = new Map<number, { compId: string; terminalId: string }[]>();
  if (wires.length > 0) {
    const nodeMap = buildNodeMap(components, wires, plugins);
    for (const [termKey, nodeId] of nodeMap.terminalNode) {
      const ci = termKey.indexOf(':');
      const compId = ci >= 0 ? termKey.slice(0, ci) : termKey;
      const terminalId = ci >= 0 ? termKey.slice(ci + 1) : '';
      if (!netComps.has(nodeId)) {
        netComps.set(nodeId, new Set());
        netTerminals.set(nodeId, []);
      }
      netComps.get(nodeId)!.add(compId);
      netTerminals.get(nodeId)!.push({ compId, terminalId });
    }
    for (const comps of netComps.values()) {
      const list = Array.from(comps);
      if (list.length < 2) continue;
      // pair weight decays with net size: a 2-pin net is a strong constraint,
      // a 20-pin bus/net pulls everything together and must be weak
      let w = 1 / (list.length - 1);
      if (list.length > 6) w *= 0.35; // huge nets (GND/rails) — very weak
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          edges.push({ a: list[i], b: list[j], w });
        }
      }
    }
  }

  // ── initial positions from the schematic (scaled to fit the board) ──────
  const margin = 6;
  const innerW = Math.max(boardW - margin * 2, 10);
  const innerH = Math.max(boardH - margin * 2, 10);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of components) {
    minX = Math.min(minX, c.position.x); maxX = Math.max(maxX, c.position.x);
    minY = Math.min(minY, c.position.y); maxY = Math.max(maxY, c.position.y);
  }
  const schW = Math.max(maxX - minX, 1), schH = Math.max(maxY - minY, 1);
  const scale = Math.min(innerW / schW, innerH / schH);

  const comps: PlacementComp[] = components.map((comp) => {
    const ext = footprintHalfExtents(comp.type);
    return {
      comp,
      x: margin + (comp.position.x - minX) * scale + (innerW - schW * scale) / 2,
      y: margin + (comp.position.y - minY) * scale + (innerH - schH * scale) / 2,
      hw: ext.hw, hh: ext.hh,
      pads: ext.padCount,
      refdes: generateRefdes(comp.type, comp.id),
    };
  });
  const byId = new Map(comps.map((c) => [c.comp.id, c]));

  /** Congestion inflation multiplier for a component pair (1 = v2 gap).
   *  Defined before any finish() call so the no-wires early path is safe. */
  const pairMult = (a: PlacementComp, b: PlacementComp): number =>
    Math.min(1 + (a.congExtra ?? 0) + (b.congExtra ?? 0), CONGESTION_PAIR_MULT_CAP);

  // ── functional-module clustering (pre-pass) ──────────────────────
  // Union components that share ≥ 2 small nets, or one small net on which
  // one side has ≥ 2 pins (e.g. a 555's thr+trig tied to one RC node).
  // Nets with more than CLUSTER_MAX_NET_COMPS members are rails (GND/VCC)
  // and never define a module. Connectors / oscillators / regulators become
  // anchors drawn toward the cluster they serve. No groups found → every
  // effect below is skipped and the placement is bit-identical to v2.
  const clusterOf = new Map<string, number>();
  const clusterMembers: string[][] = [];
  const anchorTarget = new Map<string, number>();
  if (options.moduleClustering !== false && netTerminals.size > 0) {
    const idx = new Map<string, number>(comps.map((c, i) => [c.comp.id, i]));
    const parent = comps.map((_, i) => i);
    const find = (i: number): number => {
      let r = i;
      while (parent[r] !== r) r = parent[r];
      return r;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a), rb = find(b);
      if (ra === rb) return;
      if (ra < rb) parent[rb] = ra; else parent[ra] = rb;
    };
    const pairInfo = new Map<string, { nets: number; multiPin: boolean }>();
    for (const terms of netTerminals.values()) {
      const distinct = new Set<string>();
      for (const t of terms) distinct.add(t.compId);
      if (distinct.size < 2 || distinct.size > CLUSTER_MAX_NET_COMPS) continue;
      const list = Array.from(distinct);
      const pinCount = new Map<string, number>();
      for (const t of terms) pinCount.set(t.compId, (pinCount.get(t.compId) ?? 0) + 1);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = list[i] < list[j] ? `${list[i]}|${list[j]}` : `${list[j]}|${list[i]}`;
          let info = pairInfo.get(key);
          if (!info) { info = { nets: 0, multiPin: false }; pairInfo.set(key, info); }
          info.nets += 1;
          if ((pinCount.get(list[i]) ?? 0) >= 2 || (pinCount.get(list[j]) ?? 0) >= 2) info.multiPin = true;
        }
      }
    }
    for (const [key, info] of pairInfo) {
      if (info.nets < 2 && !info.multiPin) continue;
      const sep = key.indexOf('|');
      const ia = idx.get(key.slice(0, sep));
      const ib = idx.get(key.slice(sep + 1));
      if (ia !== undefined && ib !== undefined) union(ia, ib);
    }
    const rootMembers = new Map<number, string[]>();
    for (const c of comps) {
      const r = find(idx.get(c.comp.id)!);
      const arr = rootMembers.get(r);
      if (arr) arr.push(c.comp.id);
      else rootMembers.set(r, [c.comp.id]);
    }
    for (const members of rootMembers.values()) {
      if (members.length < 2) continue;
      const clusterId = clusterMembers.length;
      clusterMembers.push(members);
      for (const m of members) clusterOf.set(m, clusterId);
    }
    // anchors: attach to the cluster they share the most small nets with
    for (const c of comps) {
      if (clusterOf.has(c.comp.id) || !CLUSTER_ANCHOR_TYPES.has(c.comp.type)) continue;
      const sharedNets = new Map<number, number>();
      for (const terms of netTerminals.values()) {
        const distinct = new Set<string>();
        for (const t of terms) distinct.add(t.compId);
        if (distinct.size < 2 || distinct.size > CLUSTER_MAX_NET_COMPS) continue;
        if (!distinct.has(c.comp.id)) continue;
        for (const t of terms) {
          const cl = clusterOf.get(t.compId);
          if (cl !== undefined) sharedNets.set(cl, (sharedNets.get(cl) ?? 0) + 1);
        }
      }
      let best: number | undefined;
      let bestCount = 0;
      for (const [cl, n] of sharedNets) {
        if (n > bestCount) { bestCount = n; best = cl; }
      }
      if (best !== undefined) anchorTarget.set(c.comp.id, best);
    }
    stats.clusters = clusterMembers.length;
    stats.clusteredComponents = clusterMembers.reduce((s, m) => s + m.length, 0);
    stats.anchoredComponents = anchorTarget.size;
  }
  const hasClusters = clusterMembers.length > 0;

  // weighted component↔component edges (empty when the schematic has no
  // wires); intra-cluster edges get boosted attraction so modules stay
  // together on the final board
  const compEdges = edges
    .map((e) => {
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (!a || !b) return null;
      let w = e.w;
      if (hasClusters && clusterOf.get(e.a) !== undefined && clusterOf.get(e.a) === clusterOf.get(e.b)) {
        w *= CLUSTER_ATT_BOOST;
      }
      return { a, b, w };
    })
    .filter((e): e is { a: PlacementComp; b: PlacementComp; w: number } => e !== null);
  if (edges.length === 0) {
    // no connectivity info — keep the schematic-scaled layout (still better
    // than a naive grid: relative positions are meaningful)
    finish();
    return { positions, rotations, stats };
  }

  // ── force relaxation ────────────────────────────────────────────────────
  const kAtt = 0.045;
  const maxAttStep = 1.2;
  const iterations = 130;

  // One iteration of the relaxation loop. Extracted so the congestion
  // pass can re-run the SAME loop (bounded ≤ 2 extra iterations) after
  // inflating local gaps — not a new algorithm. When no cluster exists
  // and no component carries congExtra, the arithmetic is bit-identical
  // to the v2 loop (×1 multiplications are exact in IEEE-754).
  const runIteration = (it: number) => {
    const damp = 1 - 0.55 * (it / iterations); // 1.0 → 0.45
    const fx = new Map<string, number>();
    const fy = new Map<string, number>();
    const acc = (id: string, dx: number, dy: number) => {
      fx.set(id, (fx.get(id) ?? 0) + dx);
      fy.set(id, (fy.get(id) ?? 0) + dy);
    };

    // attraction along nets (intra-cluster weights are pre-boosted)
    for (const e of compEdges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      // sqrt(x²+y²), NOT Math.hypot: hypot is implementation-defined across
      // JS engines (Bun/JSC vs Node/V8 differ in the last ulp) — over 80
      // chaotic relaxation passes that diverges into different layouts and
      // breaks cross-engine placement parity (server vs client). sqrt of
      // exact products is correctly rounded per spec, and our mm-scale
      // magnitudes are far from hypot's overflow-protection domain.
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-6) continue;
      const f = Math.min(kAtt * e.w * dist, maxAttStep) / dist;
      acc(e.a.comp.id, dx * f, dy * f);
      acc(e.b.comp.id, -dx * f, -dy * f);
    }

    // repulsion / overlap separation (gap locally inflated for hot parts)
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const A = comps[i], B = comps[j];
        const mult = pairMult(A, B);
        const gap = pairGap(A.pads, B.pads) * mult;
        const dx = B.x - A.x, dy = B.y - A.y;
        const ox = A.hw + B.hw + gap - Math.abs(dx);
        const oy = A.hh + B.hh + gap - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          // push along the axis with the smaller violation (repulsion
          // strength scales with the congestion multiplier)
          const push = 0.35;
          if (ox < oy) {
            const s = (dx >= 0 ? 1 : -1) * Math.min(ox * push, 1.5 * mult);
            acc(A.comp.id, -s, 0); acc(B.comp.id, s, 0);
          } else {
            const s = (dy >= 0 ? 1 : -1) * Math.min(oy * push, 1.5 * mult);
            acc(A.comp.id, 0, -s); acc(B.comp.id, 0, s);
          }
        }
      }
    }

    // module centroid springs — clusters move as rigid-ish units and
    // anchors (connectors/oscillators/regulators) track their cluster
    if (hasClusters) {
      for (const members of clusterMembers) {
        let cx = 0, cy = 0;
        for (const m of members) {
          const c = byId.get(m)!;
          cx += c.x; cy += c.y;
        }
        cx /= members.length; cy /= members.length;
        for (const m of members) {
          const c = byId.get(m)!;
          const dx = cx - c.x, dy = cy - c.y;
          const dist = Math.sqrt(dx * dx + dy * dy); // see compEdges note: no Math.hypot
          if (dist < 1e-6) continue;
          const f = Math.min(CLUSTER_CENTROID_K * dist, CLUSTER_CENTROID_MAX_STEP) / dist;
          acc(m, dx * f, dy * f);
        }
      }
      for (const [id, clusterId] of anchorTarget) {
        const c = byId.get(id);
        const members = clusterMembers[clusterId];
        if (!c || !members) continue;
        let cx = 0, cy = 0;
        for (const m of members) {
          const mc = byId.get(m)!;
          cx += mc.x; cy += mc.y;
        }
        cx /= members.length; cy /= members.length;
        const dx = cx - c.x, dy = cy - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy); // see compEdges note: no Math.hypot
        if (dist < 1e-6) continue;
        const f = Math.min(ANCHOR_CENTROID_K * dist, ANCHOR_CENTROID_MAX_STEP) / dist;
        acc(id, dx * f, dy * f);
      }
    }

    for (const c of comps) {
      const dx = (fx.get(c.comp.id) ?? 0) * damp;
      const dy = (fy.get(c.comp.id) ?? 0) * damp;
      c.x = Math.min(boardW - c.hw - 2, Math.max(c.hw + 2, c.x + dx));
      c.y = Math.min(boardH - c.hh - 2, Math.max(c.hh + 2, c.y + dy));
    }
  };

  for (let it = 0; it < iterations; it++) runIteration(it);

  // ── RUDY-lite congestion feedback (after relaxation) ──────
  // Pad offset caches for the congestion estimate (per call, so mutated
  // footprint registries can never go stale between calls).
  const typePadOffsets = new Map<string, { x: number; y: number }[]>();
  const typeTerminalOffsets = new Map<string, Map<string, { x: number; y: number }>>();
  const padOffsetsFor = (type: string): { x: number; y: number }[] => {
    let offs = typePadOffsets.get(type);
    if (!offs) {
      offs = getFootprintDef(type).pads.map((p) => ({ x: p.position.x, y: p.position.y }));
      typePadOffsets.set(type, offs);
    }
    return offs;
  };
  const terminalOffset = (type: string, terminalId: string): { x: number; y: number } | undefined => {
    let m = typeTerminalOffsets.get(type);
    if (!m) {
      m = new Map<string, { x: number; y: number }>();
      for (const p of getFootprintDef(type).pads) {
        m.set(p.terminalId, { x: p.position.x, y: p.position.y });
      }
      typeTerminalOffsets.set(type, m);
    }
    return m.get(terminalId);
  };

  interface CongestionGrid {
    cols: number; rows: number;
    demand: Float64Array;
    dilated: Float64Array;
    overflow: number;
    maxRatio: number;
    region: { minX: number; minY: number; maxX: number; maxY: number } | null;
  }

  /** Coarse g-cell RUDY estimate from the CURRENT positions: demand = each
   *  net's estimated routes (pads−1 MST legs, × demand factor) spread
   *  uniformly over its pad bounding box + pad escape demand; supply =
   *  floor((cell − clearance) / (width + clearance)) × usable layers. */
  const computeCongestionGrid = (): CongestionGrid => {
    const cols = stats.gridCols, rows = stats.gridRows;
    const supply = Math.max(1,
      Math.floor((RUDY_CELL_SIZE - ROUTE_CLEARANCE) / ROUTE_PITCH) * ROUTE_LAYERS);
    const demand = new Float64Array(cols * rows);
    for (const terms of netTerminals.values()) {
      let nMinX = Infinity, nMaxX = -Infinity, nMinY = Infinity, nMaxY = -Infinity, padCount = 0;
      for (const t of terms) {
        const c = byId.get(t.compId);
        const off = c ? terminalOffset(c.comp.type, t.terminalId) : undefined;
        if (!c || !off) continue;
        const px = c.x + off.x, py = c.y + off.y;
        padCount++;
        if (px < nMinX) nMinX = px;
        if (px > nMaxX) nMaxX = px;
        if (py < nMinY) nMinY = py;
        if (py > nMaxY) nMaxY = py;
      }
      if (padCount < 2) continue;
      // tracks have physical width — pad the bbox so collinear pads still
      // form a corridor-shaped demand region instead of a zero-area box
      nMinX -= ROUTE_PITCH / 2; nMaxX += ROUTE_PITCH / 2;
      nMinY -= ROUTE_PITCH / 2; nMaxY += ROUTE_PITCH / 2;
      const area = (nMaxX - nMinX) * (nMaxY - nMinY);
      const trackDemand = (padCount - 1) * CONGESTION_DEMAND_FACTOR;
      const i0 = Math.max(0, Math.floor(nMinX / RUDY_CELL_SIZE));
      const i1 = Math.min(cols - 1, Math.floor(nMaxX / RUDY_CELL_SIZE));
      const j0 = Math.max(0, Math.floor(nMinY / RUDY_CELL_SIZE));
      const j1 = Math.min(rows - 1, Math.floor(nMaxY / RUDY_CELL_SIZE));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const ox = Math.min(nMaxX, (i + 1) * RUDY_CELL_SIZE) - Math.max(nMinX, i * RUDY_CELL_SIZE);
          const oy = Math.min(nMaxY, (j + 1) * RUDY_CELL_SIZE) - Math.max(nMinY, j * RUDY_CELL_SIZE);
          if (ox > 0 && oy > 0) demand[j * cols + i] += (trackDemand * ox * oy) / area;
        }
      }
    }
    // pad escape demand — every pad needs a local track slot
    for (const c of comps) {
      for (const off of padOffsetsFor(c.comp.type)) {
        const px = c.x + off.x, py = c.y + off.y;
        if (px < 0 || py < 0 || px >= boardW || py >= boardH) continue;
        const i = Math.min(cols - 1, Math.floor(px / RUDY_CELL_SIZE));
        const j = Math.min(rows - 1, Math.floor(py / RUDY_CELL_SIZE));
        demand[j * cols + i] += PAD_ESCAPE_DEMAND;
      }
    }
    const ratio = new Float64Array(cols * rows);
    let overflow = 0, maxRatio = 0;
    let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const r = demand[j * cols + i] / supply;
        ratio[j * cols + i] = r;
        if (r > maxRatio) maxRatio = r;
        if (r > 1) {
          overflow++;
          if (i * RUDY_CELL_SIZE < rMinX) rMinX = i * RUDY_CELL_SIZE;
          if ((i + 1) * RUDY_CELL_SIZE > rMaxX) rMaxX = (i + 1) * RUDY_CELL_SIZE;
          if (j * RUDY_CELL_SIZE < rMinY) rMinY = j * RUDY_CELL_SIZE;
          if ((j + 1) * RUDY_CELL_SIZE > rMaxY) rMaxY = (j + 1) * RUDY_CELL_SIZE;
        }
      }
    }
    // dilate by one cell — components adjacent to a hot corridor must
    // inflate too (overflow cells sit BETWEEN parts, not under their pins)
    const dilated = new Float64Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        let mx = ratio[j * cols + i];
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
            const v = ratio[jj * cols + ii];
            if (v > mx) mx = v;
          }
        }
        dilated[j * cols + i] = mx;
      }
    }
    return {
      cols, rows, demand, dilated, overflow, maxRatio,
      region: overflow > 0
        ? { minX: rMinX, minY: rMinY, maxX: rMaxX, maxY: rMaxY }
        : null,
    };
  };

  if (options.congestionFeedback !== false) {
    let wiredNets = 0;
    for (const s of netComps.values()) if (s.size >= 2) wiredNets++;
    let grid = computeCongestionGrid();
    stats.overflowCellsBefore = grid.overflow;
    stats.maxDemandRatio = grid.maxRatio;
    stats.overflowRegion = grid.region;
    if (grid.overflow > 0 && wiredNets >= CONGESTION_MIN_NETS) {
      // local inflation: components with pins near overflow cells get a
      // bigger effective pairGap / repulsion strength
      for (const c of comps) {
        let worst = 0;
        for (const off of padOffsetsFor(c.comp.type)) {
          const px = c.x + off.x, py = c.y + off.y;
          if (px < 0 || py < 0 || px >= boardW || py >= boardH) continue;
          const i = Math.min(grid.cols - 1, Math.floor(px / RUDY_CELL_SIZE));
          const j = Math.min(grid.rows - 1, Math.floor(py / RUDY_CELL_SIZE));
          const r = grid.dilated[j * grid.cols + i];
          if (r > worst) worst = r;
        }
        if (worst > 1) {
          c.congExtra = Math.min(CONGESTION_INFLATION_MAX, CONGESTION_INFLATION * (worst - 1));
        }
      }
      // bounded re-relaxation: ≤ 2 extra iterations of the SAME loop
      for (let k = 0; k < CONGESTION_RE_RELAX && grid.overflow > 0; k++) {
        runIteration(iterations + k);
        stats.congestionReRelaxations++;
        grid = computeCongestionGrid();
      }
      stats.overflowCellsAfter = grid.overflow;
    }
  }

  finish();
  return { positions, rotations, stats };

  function finish() {
    // rotation FIRST — a rotated 2-pad part swaps its extents, which the
    // overlap resolution below must account for
    for (const c of comps) {
      const def = getFootprintDef(c.comp.type);
      if (def.pads.length !== 2) { rotations.set(c.comp.id, 0); continue; }
      // centroid of connected neighbors (weighted)
      let cx = 0, cy = 0, wsum = 0;
      for (const e of compEdges) {
        const other = e.a === c ? e.b : e.b === c ? e.a : null;
        if (!other) continue;
        cx += other.x * e.w; cy += other.y * e.w; wsum += e.w;
      }
      if (wsum === 0) { rotations.set(c.comp.id, 0); continue; }
      cx /= wsum; cy /= wsum;
      // pad axis at rotation 0 runs along x; find the rotation whose pad axis
      // best aligns with the direction to the connection centroid
      let bestRot = 0, bestDot = -Infinity;
      for (let rot = 0; rot < 4; rot++) {
        const rad = (rot * 90 * Math.PI) / 180;
        const ax = Math.abs(Math.cos(rad)), ay = Math.abs(Math.sin(rad)); // pad axis unit
        const dx = cx - c.x, dy = cy - c.y;
        const len = Math.sqrt(dx * dx + dy * dy); // see compEdges note: no Math.hypot
        if (len < 1e-6) continue;
        const dot = (Math.abs(dx) * ax + Math.abs(dy) * ay) / len;
        if (dot > bestDot) { bestDot = dot; bestRot = rot; }
      }
      rotations.set(c.comp.id, bestRot * 90);
    }

    // effective extents WITH rotation applied (pads rotate with the part)
    const eff = new Map<string, { hw: number; hh: number }>();
    for (const c of comps) {
      const rot = rotations.get(c.comp.id) ?? 0;
      const def = getFootprintDef(c.comp.type);
      let maxX = def.bodySize.width / 2, maxY = def.bodySize.height / 2;
      for (const pad of def.pads) {
        const off = rotatePadOffset(pad.position.x, pad.position.y, rot);
        maxX = Math.max(maxX, Math.abs(off.x) + pad.size.width / 2);
        maxY = Math.max(maxY, Math.abs(off.y) + pad.size.height / 2);
      }
      eff.set(c.comp.id, { hw: maxX, hh: maxY });
    }

    // snap to 0.5mm grid
    for (const c of comps) {
      positions.set(c.comp.id, { x: Math.round(c.x * 2) / 2, y: Math.round(c.y * 2) / 2 });
    }
    // hard overlap resolution (bounded passes) with ROTATED extents
    const padCounts = new Map<string, number>();
    for (const c of comps) padCounts.set(c.comp.id, c.pads);
    for (let pass = 0; pass < 80; pass++) {
      let moved = false;
      for (let i = 0; i < comps.length; i++) {
        for (let j = i + 1; j < comps.length; j++) {
          const A = comps[i], B = comps[j];
          const ea = eff.get(A.comp.id)!, eb = eff.get(B.comp.id)!;
          const pa = positions.get(A.comp.id)!, pb = positions.get(B.comp.id)!;
          // congestion-inflated channel (mult = 1 when congestion never fired)
          const gap = pairGap(padCounts.get(A.comp.id) ?? 0, padCounts.get(B.comp.id) ?? 0) * pairMult(A, B);
          const dx = pb.x - pa.x, dy = pb.y - pa.y;
          const ox = ea.hw + eb.hw + gap - Math.abs(dx);
          const oy = ea.hh + eb.hh + gap - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (ox < oy) {
            const s = dx >= 0 ? 1 : -1;
            const half = ox / 2 + 0.1;
            positions.set(A.comp.id, { x: pa.x - s * half, y: pa.y });
            positions.set(B.comp.id, { x: pb.x + s * half, y: pb.y });
          } else {
            const s = dy >= 0 ? 1 : -1;
            const half = oy / 2 + 0.1;
            positions.set(A.comp.id, { x: pa.x, y: pa.y - s * half });
            positions.set(B.comp.id, { x: pb.x, y: pb.y + s * half });
          }
        }
      }
      if (!moved) break;
    }
    // NOTE: no board clamp after separation — squeezing parts back inside a
    // too-small estimate board reintroduced pad-pad overlaps. The final board
    // outline is derived from the placed layout's bounding box in
    // createPCBFromSchematic, so the board simply grows when the layout
    // needs more room.
  }
}

/** Rotate a pad offset by a multiple of 90° around the footprint center. */
function rotatePadOffset(px: number, py: number, rotDeg: number): { x: number; y: number } {
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: px * cos - py * sin, y: px * sin + py * cos };
}

/**
 * Generate footprints from schematic components.
 * Uses connectivity-driven placement (falls back to the schematic-scaled
 * layout when there are no wires).
 */
export function generateFootprints(
  components: CircuitComponent[],
  boardWidth: number,
  boardHeight: number,
  wires: Wire[] = [],
): Footprint[] {
  const { positions, rotations } = computeSmartPlacement(components, wires, boardWidth, boardHeight);

  return components.map((comp) => {
    const pos = positions.get(comp.id) ?? { x: boardWidth / 2, y: boardHeight / 2 };
    const rot = rotations.get(comp.id) ?? 0;
    const fpDef = getFootprintDef(comp.type);
    const refdes = generateRefdes(comp.type, comp.id);

    const pads: Pad[] = fpDef.pads.map((padDef) => {
      const off = rotatePadOffset(padDef.position.x, padDef.position.y, rot);
      return {
        id: `${comp.id}:${padDef.terminalId}`,
        componentId: comp.id,
        terminalId: padDef.terminalId,
        position: { x: pos.x + off.x, y: pos.y + off.y },
        shape: padDef.shape,
        size: { ...padDef.size },
        layer: padDef.layer ?? 'top' as const,
        // Propagate the drill so THT pad defs (e.g. parametric DIP-14 with
        // 0.8mm drills) keep their through-hole nature on the PCB — the DRC,
        // Gerber/Excellon export and copper pour all read Pad.drill.
        ...(padDef.drill != null ? { drill: padDef.drill } : {}),
      };
    });

    return {
      id: comp.id,
      componentId: comp.id,
      componentType: comp.type,
      refdes,
      position: { ...pos },
      rotation: rot,
      bodySize: { ...fpDef.bodySize },
      pads,
      side: 'top',
    };
  });
}

/**
 * Compute ratsnest connections from the schematic netlist.
 * Returns airwires showing which pads need to be connected.
 */
export function computeRatsnest(
  components: CircuitComponent[],
  wires: Wire[],
  footprints: Footprint[],
): { ratsnest: Ratsnest[]; padNets: Map<string, string> } {
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const nodeMap = buildNodeMap(components, wires, plugins);

  // Assign net names to pads based on node IDs
  const padNets = new Map<string, string>();
  const nodeToNetName = new Map<number, string>();
  let netCounter = 1;

  for (const [termKey, nodeId] of nodeMap.terminalNode) {
    if (nodeId === 0) {
      padNets.set(termKey, 'GND');
    } else {
      if (!nodeToNetName.has(nodeId)) {
        nodeToNetName.set(nodeId, `N${netCounter++}`);
      }
      padNets.set(termKey, nodeToNetName.get(nodeId)!);
    }
  }

  // Build ratsnest: for each net, connect all pads on that net in a minimum spanning tree
  const netsToPads = new Map<string, { padId: string; pos: { x: number; y: number } }[]>();
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const termKey = `${pad.componentId}:${pad.terminalId}`;
      const net = padNets.get(termKey);
      if (!net) continue;
      if (!netsToPads.has(net)) netsToPads.set(net, []);
      netsToPads.get(net)!.push({ padId: pad.id, pos: pad.position });
    }
  }

  const ratsnest: Ratsnest[] = [];
  for (const [net, pads] of netsToPads) {
    if (pads.length < 2) continue;
    // MST via Prim's algorithm
    const connected = new Set<string>([pads[0].padId]);
    const remaining = pads.slice(1);

    while (remaining.length > 0) {
      let bestDist = Infinity;
      let bestIdx = 0;
      let bestFrom: { padId: string; pos: { x: number; y: number } } | null = null;

      for (let i = 0; i < remaining.length; i++) {
        for (const fromPad of pads) {
          if (!connected.has(fromPad.padId)) continue;
          const dx = remaining[i].pos.x - fromPad.pos.x;
          const dy = remaining[i].pos.y - fromPad.pos.y;
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
            bestFrom = fromPad;
          }
        }
      }

      if (bestFrom) {
        ratsnest.push({
          fromPadId: bestFrom.padId,
          toPadId: remaining[bestIdx].padId,
          net,
          from: bestFrom.pos,
          to: remaining[bestIdx].pos,
        });
        connected.add(remaining[bestIdx].padId);
        remaining.splice(bestIdx, 1);
      } else {
        break;
      }
    }
  }

  return { ratsnest, padNets };
}

/** Estimate a sensible board size for the given components. */
export function estimateBoardSize(components: CircuitComponent[]): BoardOutline {
  if (components.length === 0) return { width: 80, height: 60 };
  let totalArea = 0;
  for (const comp of components) {
    const ext = footprintHalfExtents(comp.type);
    totalArea += (2 * ext.hw + PLACE_GAP) * (2 * ext.hh + PLACE_GAP);
  }
  // routing space multiplier: components occupy ~30% of the board
  const boardArea = totalArea * 3.4;
  const width = Math.max(40, Math.round(Math.sqrt(boardArea * 1.45)));
  const height = Math.max(30, Math.round(Math.sqrt(boardArea / 1.45)));
  return { width, height };
}

/**
 * Create a complete PCB document from the schematic:
 * connectivity-driven placement, net assignment, ratsnest, and a board
 * outline sized to the placed layout.
 */
export function createPCBFromSchematic(
  components: CircuitComponent[],
  wires: Wire[],
): { footprints: Footprint[]; ratsnest: Ratsnest[]; padNets: Map<string, string>; board: BoardOutline } {
  const estimate = estimateBoardSize(components);
  const footprints = generateFootprints(components, estimate.width, estimate.height, wires);

  // Propagate net assignments to pads FIRST (computeRatsnest and the router
  // both read pad.net)
  const { padNets } = computePadNets(components, wires);
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const net = padNets.get(`${pad.componentId}:${pad.terminalId}`);
      if (net) pad.net = net;
    }
  }

  // Normalize placement onto the board origin: the separation pass can push
  // components to negative coordinates or right against the estimate-board
  // edge. Shift everything so the layout sits at a 4mm margin from (0,0) —
  // pads must stay well clear of the board edge for routing to work.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      minX = Math.min(minX, pad.position.x - pad.size.width / 2);
      minY = Math.min(minY, pad.position.y - pad.size.height / 2);
      maxX = Math.max(maxX, pad.position.x + pad.size.width / 2);
      maxY = Math.max(maxY, pad.position.y + pad.size.height / 2);
    }
    minX = Math.min(minX, fp.position.x - fp.bodySize.width / 2);
    minY = Math.min(minY, fp.position.y - fp.bodySize.height / 2);
    maxX = Math.max(maxX, fp.position.x + fp.bodySize.width / 2);
    maxY = Math.max(maxY, fp.position.y + fp.bodySize.height / 2);
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 40; }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 30; }
  const MARGIN = 4;
  const shiftX = MARGIN - minX;
  const shiftY = MARGIN - minY;
  if (shiftX !== 0 || shiftY !== 0) {
    for (const fp of footprints) {
      fp.position = { x: fp.position.x + shiftX, y: fp.position.y + shiftY };
      for (const pad of fp.pads) {
        pad.position = { x: pad.position.x + shiftX, y: pad.position.y + shiftY };
      }
    }
    maxX += shiftX; maxY += shiftY;
  }

  // Ratsnest AFTER normalization (it references final pad positions)
  const { ratsnest } = computeRatsnest(components, wires, footprints);

  // Final board size: layout extent + margins, keeping routing headroom from
  // the estimate, with the aspect ratio capped at 1.8:1 (ultra-thin boards
  // have no routing room).
  let width = Math.max(40, Math.ceil(maxX + MARGIN));
  let height = Math.max(30, Math.ceil(maxY + MARGIN));
  width = Math.max(width, Math.round(estimate.width * 0.8));
  height = Math.max(height, Math.round(estimate.height * 0.8));
  if (width > height * 1.8) height = Math.round(width / 1.8);
  else if (height > width * 1.8) width = Math.round(height / 1.8);
  const board: BoardOutline = { width, height };

  return { footprints, ratsnest, padNets, board };
}

/** Compute the terminal→net map (node analysis shared by ratsnest + pad assignment). */
function computePadNets(
  components: CircuitComponent[],
  wires: Wire[],
): { padNets: Map<string, string> } {
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const nodeMap = buildNodeMap(components, wires, plugins);
  const padNets = new Map<string, string>();
  const nodeToNetName = new Map<number, string>();
  let netCounter = 1;
  for (const [termKey, nodeId] of nodeMap.terminalNode) {
    if (nodeId === 0) {
      padNets.set(termKey, 'GND');
    } else {
      if (!nodeToNetName.has(nodeId)) nodeToNetName.set(nodeId, `N${netCounter++}`);
      padNets.set(termKey, nodeToNetName.get(nodeId)!);
    }
  }
  return { padNets };
}
