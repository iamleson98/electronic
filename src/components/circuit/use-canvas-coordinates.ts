// Custom hook: extracts coordinate conversion and hit-testing utilities.
// Provides screenToGrid, gridToScreen, getTerminalPos, resolveEndpointPos,
// findTerminalAt, findComponentAt, findWireAt, findWireHandle, getRotateHandlePos.

import { useCallback } from 'react';
import { getPlugin } from '@/lib/circuit/registry';
import { rotateTerminal } from '@/lib/circuit/components/draw';
import type { CircuitComponent, TerminalDef, Vec2, Wire } from '@/lib/circuit/types';
import type { HierarchicalSheet } from '@/lib/circuit/types';
import { CELL_SIZE, type HoverState } from './canvas-types';
import { getWirePath, segmentMidpoint, pointToSegmentDist } from './canvas-wire-utils';

export function useCanvasCoordinates(opts: {
  pan: Vec2;
  zoom: number;
  snapToGrid: boolean;
  components: CircuitComponent[];
  wires: Wire[];
  sheets: HierarchicalSheet[];
  selection: { type: string | null; id: string | null };
  use45Routing: boolean;
}) {
  const { pan, zoom, snapToGrid, components, wires, sheets, use45Routing } = opts;

  const screenToGrid = useCallback((sx: number, sy: number): Vec2 => {
    const x = (sx - pan.x) / (CELL_SIZE * zoom);
    const y = (sy - pan.y) / (CELL_SIZE * zoom);
    return snapToGrid ? { x: Math.round(x), y: Math.round(y) } : { x, y };
  }, [pan, zoom, snapToGrid]);

  const gridToScreen = useCallback((gx: number, gy: number): Vec2 => {
    return { x: gx * CELL_SIZE * zoom + pan.x, y: gy * CELL_SIZE * zoom + pan.y };
  }, [pan, zoom]);

  const getTerminalPos = useCallback((comp: CircuitComponent, terminal: TerminalDef): Vec2 => {
    const plugin = getPlugin(comp.type);
    if (!plugin) return { x: 0, y: 0 };
    const rotated = rotateTerminal(terminal, comp.rotation, plugin.boundingBox);
    return {
      x: comp.position.x + rotated.position.x,
      y: comp.position.y + rotated.position.y,
    };
  }, []);

  const resolveEndpointPos = useCallback((endpoint: { componentId: string; terminalId: string }): Vec2 | null => {
    if (endpoint.componentId.startsWith('__sheet:')) {
      const sheetId = endpoint.componentId.slice('__sheet:'.length);
      const sheet = sheets.find((s) => s.id === sheetId);
      if (!sheet) return null;
      const pinId = endpoint.terminalId.startsWith('pin:') ? endpoint.terminalId.slice('pin:'.length) : endpoint.terminalId;
      const pin = sheet.pins.find((p) => p.id === pinId);
      if (!pin) return null;
      return {
        x: sheet.position.x + pin.position.x,
        y: sheet.position.y + pin.position.y,
      };
    }
    const comp = components.find((c) => c.id === endpoint.componentId);
    if (!comp) return null;
    const plugin = getPlugin(comp.type);
    if (!plugin) return null;
    const t = plugin.terminals.find((tt) => tt.id === endpoint.terminalId);
    if (!t) return null;
    return getTerminalPos(comp, t);
  }, [components, sheets, getTerminalPos]);

  const findTerminalAt = useCallback((gx: number, gy: number) => {
    for (const comp of components) {
      const plugin = getPlugin(comp.type);
      if (!plugin) continue;
      for (const t of plugin.terminals) {
        const pos = getTerminalPos(comp, t);
        const dx = pos.x - gx;
        const dy = pos.y - gy;
        if (dx * dx + dy * dy < 0.5 * 0.5) {
          return { componentId: comp.id, terminalId: t.id, pos };
        }
      }
    }
    for (const sheet of sheets) {
      for (const pin of sheet.pins) {
        const pos = {
          x: sheet.position.x + pin.position.x,
          y: sheet.position.y + pin.position.y,
        };
        const dx = pos.x - gx;
        const dy = pos.y - gy;
        if (dx * dx + dy * dy < 0.5 * 0.5) {
          return {
            componentId: `__sheet:${sheet.id}`,
            terminalId: `pin:${pin.id}`,
            pos,
          };
        }
      }
    }
    return null;
  }, [components, getTerminalPos, sheets]);

  const findComponentAt = useCallback((gx: number, gy: number): CircuitComponent | null => {
    for (let i = components.length - 1; i >= 0; i--) {
      const comp = components[i];
      const plugin = getPlugin(comp.type);
      if (!plugin) continue;
      const bb = plugin.boundingBox;
      const cx = bb.width / 2;
      const cy = bb.height / 2;
      const dx = gx - (comp.position.x + cx);
      const dy = gy - (comp.position.y + cy);
      let rx: number, ry: number;
      switch (comp.rotation) {
        case 0: rx = dx; ry = dy; break;
        case 1: rx = -dy; ry = dx; break;
        case 2: rx = -dx; ry = -dy; break;
        case 3: rx = dy; ry = -dx; break;
      }
      if (Math.abs(rx) <= bb.width / 2 && Math.abs(ry) <= bb.height / 2) {
        return comp;
      }
    }
    return null;
  }, [components]);

  const findWireAt = useCallback((sx: number, sy: number): string | null => {
    for (const wire of wires) {
      const fromComp = components.find((c) => c.id === wire.from.componentId);
      const toComp = components.find((c) => c.id === wire.to.componentId);
      if (!fromComp || !toComp) continue;
      const fromPlugin = getPlugin(fromComp.type);
      const toPlugin = getPlugin(toComp.type);
      if (!fromPlugin || !toPlugin) continue;
      const fromT = fromPlugin.terminals.find((t) => t.id === wire.from.terminalId);
      const toT = toPlugin.terminals.find((t) => t.id === wire.to.terminalId);
      if (!fromT || !toT) continue;
      const fromPos = gridToScreen(getTerminalPos(fromComp, fromT).x, getTerminalPos(fromComp, fromT).y);
      const toPos = gridToScreen(getTerminalPos(toComp, toT).x, getTerminalPos(toComp, toT).y);
      const path = getWirePath(wire, fromPos, toPos, gridToScreen, use45Routing);
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        const dist = pointToSegmentDist(sx, sy, a.x, a.y, b.x, b.y);
        if (dist < 5) return wire.id;
      }
    }
    return null;
  }, [wires, components, gridToScreen, getTerminalPos, use45Routing]);

  const findWireHandle = useCallback((sx: number, sy: number): HoverState['wireHandle'] => {
    for (const wire of wires) {
      const fromComp = components.find((c) => c.id === wire.from.componentId);
      const toComp = components.find((c) => c.id === wire.to.componentId);
      if (!fromComp || !toComp) continue;
      const fromPlugin = getPlugin(fromComp.type);
      const toPlugin = getPlugin(toComp.type);
      if (!fromPlugin || !toPlugin) continue;
      const fromT = fromPlugin.terminals.find((t) => t.id === wire.from.terminalId);
      const toT = toPlugin.terminals.find((t) => t.id === wire.to.terminalId);
      if (!fromT || !toT) continue;
      const fromPos = gridToScreen(getTerminalPos(fromComp, fromT).x, getTerminalPos(fromComp, fromT).y);
      const toPos = gridToScreen(getTerminalPos(toComp, toT).x, getTerminalPos(toComp, toT).y);
      const path = getWirePath(wire, fromPos, toPos, gridToScreen, use45Routing);
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        const mid = segmentMidpoint(a, b);
        const dx = sx - mid.x;
        const dy = sy - mid.y;
        if (dx * dx + dy * dy < 36) {
          return { wireId: wire.id, segIndex: i, pos: mid };
        }
      }
    }
    return null;
  }, [wires, components, gridToScreen, getTerminalPos, use45Routing]);

  const getRotateHandlePos = useCallback((comp: CircuitComponent): Vec2 | null => {
    const plugin = getPlugin(comp.type);
    if (!plugin) return null;
    const bb = plugin.boundingBox;
    const centerGrid = { x: comp.position.x + bb.width / 2, y: comp.position.y + bb.height / 2 };
    const centerScreen = gridToScreen(centerGrid.x, centerGrid.y);
    return {
      x: centerScreen.x,
      y: centerScreen.y - (bb.height / 2 * CELL_SIZE * zoom) - 18,
    };
  }, [gridToScreen, zoom]);

  return {
    screenToGrid,
    gridToScreen,
    getTerminalPos,
    resolveEndpointPos,
    findTerminalAt,
    findComponentAt,
    findWireAt,
    findWireHandle,
    getRotateHandlePos,
  };
}
