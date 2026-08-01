// Netlist sync: converts the schematic's wire graph into a PCB netlist.
// Maps each electrical node to a net name, and assigns nets to pads.

import type { CircuitComponent, Wire } from '../circuit/types';
import { getPlugin } from '../circuit/registry';
import { buildNodeMap } from '../circuit/engine';
import type { Footprint, Pad, Ratsnest } from './types';
import { getFootprintDef } from './footprints';

/**
 * Generate footprints from schematic components.
 * Places them in a grid layout on the PCB.
 */
export function generateFootprints(
  components: CircuitComponent[],
  boardWidth: number,
  boardHeight: number,
): Footprint[] {
  const footprints: Footprint[] = [];
  const cols = Math.ceil(Math.sqrt(components.length));
  const cellW = boardWidth / (cols + 1);
  const cellH = boardHeight / (cols + 1);

  components.forEach((comp, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const fpDef = getFootprintDef(comp.type);
    const x = cellW * (col + 1);
    const y = cellH * (row + 1);

    // Generate refdes from component type and id
    const refdes = generateRefdes(comp.type, comp.id);

    // Create pads from footprint definition
    const pads: Pad[] = fpDef.pads.map((padDef) => {
      // Apply rotation to pad position
      const rad = 0; // initial rotation = 0
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const px = padDef.position.x * cos - padDef.position.y * sin;
      const py = padDef.position.x * sin + padDef.position.y * cos;

      return {
        id: `${comp.id}:${padDef.terminalId}`,
        componentId: comp.id,
        terminalId: padDef.terminalId,
        position: { x: x + px, y: y + py },
        shape: padDef.shape,
        size: { ...padDef.size },
        layer: padDef.layer ?? 'top' as const,
      };
    });

    footprints.push({
      id: comp.id,
      componentId: comp.id,
      componentType: comp.type,
      refdes,
      position: { x, y },
      rotation: 0,
      bodySize: { ...fpDef.bodySize },
      pads,
      side: 'top',
    });
  });

  return footprints;
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
  // Extract trailing number from id
  const numMatch = id.match(/\d+$/);
  const num = numMatch ? numMatch[0] : '';
  return `${prefix}${num}`;
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
    // Simple MST using nearest-neighbor (not optimal but fast)
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

/**
 * Create a complete PCB document from the schematic.
 */
export function createPCBFromSchematic(
  components: CircuitComponent[],
  wires: Wire[],
): { footprints: Footprint[]; ratsnest: Ratsnest[]; padNets: Map<string, string> } {
  // Board size: give each component at least 400mm² of space
  const area = components.length * 400;
  const boardWidth = Math.max(80, Math.ceil(Math.sqrt(area) * 1.8));
  const boardHeight = Math.max(60, Math.ceil(Math.sqrt(area) * 1.2));

  const footprints = generateFootprints(components, boardWidth, boardHeight);
  const { ratsnest, padNets } = computeRatsnest(components, wires, footprints);

  // Propagate net assignments to pads so DRC, copper pour, auto-router, etc. work
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      const net = padNets.get(`${pad.componentId}:${pad.terminalId}`);
      if (net) pad.net = net;
    }
  }

  return { footprints, ratsnest, padNets };
}
