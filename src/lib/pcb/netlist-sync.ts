// Netlist sync: converts the schematic's wire graph into a PCB netlist.
// Maps each electrical node to a net name, and assigns nets to pads.
//
// Placement strategy (v2): the previous version dropped components onto a
// naive row-major grid that ignored connectivity — the ratsnest came out as
// a huge tangled hairball and the router had to detour everywhere. The new
// placement is connectivity-driven:
//   1. Components start at their SCHEMATIC positions (scaled to the board) —
//      schematics are drawn logically, so this is an excellent initial guess.
//   2. Force relaxation pulls electrically-connected components together
//      (attraction along nets, weighted by net size) while courtyard overlap
//      pushes unrelated components apart.
//   3. Two-pad components are rotated to face their strongest connection.
//   4. Final overlap resolution guarantees courtyard clearance with routing
//      channels (≥ 1.6 mm) between components.
// Result: short ratsnest, compact board, far fewer routing conflicts.

import type { CircuitComponent, Wire, Vec2 } from '../circuit/types';
import { getPlugin } from '../circuit/registry';
import { buildNodeMap } from '../circuit/engine';
import type { Footprint, Pad, Ratsnest, BoardOutline } from './types';
import { getFootprintDef } from './footprints';

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

interface PlacementComp {
  comp: CircuitComponent;
  x: number; y: number;            // center position (mm)
  hw: number; hh: number;          // half extents incl. pads (mm)
  pads: number;                    // pad count (routing-demand proxy)
  refdes: string;
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
 * Connectivity-driven placement.
 * Returns board-space center positions + rotations (0/90/180/270) per component id.
 */
export function computeSmartPlacement(
  components: CircuitComponent[],
  wires: Wire[],
  boardW: number,
  boardH: number,
): { positions: Map<string, { x: number; y: number }>; rotations: Map<string, number> } {
  const positions = new Map<string, { x: number; y: number }>();
  const rotations = new Map<string, number>();
  if (components.length === 0) return { positions, rotations };

  // ── connectivity graph ──────────────────────────────────────────────────
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  const edges: { a: string; b: string; w: number }[] = [];
  if (wires.length > 0) {
    const nodeMap = buildNodeMap(components, wires, plugins);
    // net (nodeId) → component ids
    const netComps = new Map<number, Set<string>>();
    for (const [termKey, nodeId] of nodeMap.terminalNode) {
      const compId = termKey.split(':')[0];
      if (!netComps.has(nodeId)) netComps.set(nodeId, new Set());
      netComps.get(nodeId)!.add(compId);
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
  // weighted component↔component edges (empty when the schematic has no wires)
  const compEdges = edges
    .map((e) => ({ a: byId.get(e.a), b: byId.get(e.b), w: e.w }))
    .filter((e): e is { a: PlacementComp; b: PlacementComp; w: number } => e.a !== undefined && e.b !== undefined);
  if (edges.length === 0) {
    // no connectivity info — keep the schematic-scaled layout (still better
    // than a naive grid: relative positions are meaningful)
    finish();
    return { positions, rotations };
  }

  // ── force relaxation ────────────────────────────────────────────────────
  const kAtt = 0.045;
  const maxAttStep = 1.2;
  const iterations = 130;

  for (let it = 0; it < iterations; it++) {
    const damp = 1 - 0.55 * (it / iterations); // 1.0 → 0.45
    const fx = new Map<string, number>();
    const fy = new Map<string, number>();
    const acc = (id: string, dx: number, dy: number) => {
      fx.set(id, (fx.get(id) ?? 0) + dx);
      fy.set(id, (fy.get(id) ?? 0) + dy);
    };

    // attraction along nets
    for (const e of compEdges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) continue;
      const f = Math.min(kAtt * e.w * dist, maxAttStep) / dist;
      acc(e.a.comp.id, dx * f, dy * f);
      acc(e.b.comp.id, -dx * f, -dy * f);
    }

    // repulsion / overlap separation
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const A = comps[i], B = comps[j];
        const gap = pairGap(A.pads, B.pads);
        const dx = B.x - A.x, dy = B.y - A.y;
        const ox = A.hw + B.hw + gap - Math.abs(dx);
        const oy = A.hh + B.hh + gap - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          // push along the axis with the smaller violation
          const push = 0.35;
          if (ox < oy) {
            const s = (dx >= 0 ? 1 : -1) * Math.min(ox * push, 1.5);
            acc(A.comp.id, -s, 0); acc(B.comp.id, s, 0);
          } else {
            const s = (dy >= 0 ? 1 : -1) * Math.min(oy * push, 1.5);
            acc(A.comp.id, 0, -s); acc(B.comp.id, 0, s);
          }
        }
      }
    }

    for (const c of comps) {
      const dx = (fx.get(c.comp.id) ?? 0) * damp;
      const dy = (fy.get(c.comp.id) ?? 0) * damp;
      c.x = Math.min(boardW - c.hw - 2, Math.max(c.hw + 2, c.x + dx));
      c.y = Math.min(boardH - c.hh - 2, Math.max(c.hh + 2, c.y + dy));
    }
  }

  finish();
  return { positions, rotations };

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
        const len = Math.hypot(dx, dy);
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
          const gap = pairGap(padCounts.get(A.comp.id) ?? 0, padCounts.get(B.comp.id) ?? 0);
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
