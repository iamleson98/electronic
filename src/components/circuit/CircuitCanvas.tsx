'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin, getAllPlugins } from '@/lib/circuit/registry';
import { computeWireCurrents, computeComponentCurrents } from '@/lib/circuit/engine';
import { buildNodeMap } from '@/lib/circuit/engine';
import type { CircuitComponent, ComponentPlugin, TerminalDef, Vec2, Wire } from '@/lib/circuit/types';
import { rotateTerminal } from '@/lib/circuit/components/draw';
import {
  drawERCMarkers,
  drawAutoJunctions,
  drawWireLengthLabel,
  findERCErrorAt,
} from '@/lib/circuit/schematic-overlays';
import type { ERCError } from '@/lib/circuit/erc';
import { useAutoERC } from '@/lib/auto-rule-hooks';

const CELL_SIZE = 24;

interface DragState {
  componentId: string;
  offset: Vec2;
  isGroupDrag?: boolean;
  lastGrid?: Vec2;
}

interface WireDragState {
  wireId: string;
  /** the segment being dragged (index into path) */
  segIndex: number;
  /** starting cursor position (grid) for delta calc */
  startGrid: Vec2;
  /** original waypoints snapshot */
  originalWaypoints: Vec2[];
}

interface RotateDragState {
  componentId: string;
  /** center of the component in screen coords */
  center: Vec2;
  /** initial angle from center to cursor at drag start (radians) */
  startAngle: number;
  /** initial rotation (0-3) */
  startRotation: 0 | 1 | 2 | 3;
}

interface HoverState {
  componentId: string | null;
  terminal: { componentId: string; terminalId: string; pos: Vec2 } | null;
  wireId: string | null;
  /** midpoint handle on a wire segment that can be dragged */
  wireHandle: { wireId: string; segIndex: number; pos: Vec2 } | null;
  rotateHandle: string | null; // componentId
}

/** types of components that can be toggled by clicking during simulation */
const TOGGLEABLE_TYPES = new Set(['switch', 'pushButton']);

/** Get the orthogonal path points for a wire.
 *  fromPos and toPos are in SCREEN coords. Waypoints are in GRID coords and
 *  are converted to screen coords using the provided converter. */
function getWirePath(
  wire: Wire,
  fromPos: Vec2,
  toPos: Vec2,
  gridToScreenFn: (gx: number, gy: number) => Vec2,
  use45: boolean = false,
): Vec2[] {
  const points: Vec2[] = [fromPos];
  if (wire.waypoints && wire.waypoints.length > 0) {
    for (const wp of wire.waypoints) {
      points.push(gridToScreenFn(wp.x, wp.y));
    }
  } else if (use45) {
    // 45-degree routing: L-shape with 45° diagonal in the middle
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx < 1 || absDy < 1) {
      // Nearly straight — just go direct
      points.push({ x: toPos.x, y: fromPos.y });
    } else if (absDx > absDy) {
      // More horizontal: go horizontal, then 45° diagonal, then horizontal
      const diagLen = absDy;
      const sign = Math.sign(dy);
      const horizSign = Math.sign(dx);
      const midX1 = fromPos.x + horizSign * (absDx - diagLen) / 2;
      const midX2 = midX1 + horizSign * diagLen;
      points.push({ x: midX1, y: fromPos.y });
      points.push({ x: midX2, y: fromPos.y + sign * diagLen });
      points.push({ x: midX2, y: toPos.y });
    } else {
      // More vertical: go vertical, then 45° diagonal, then vertical
      const diagLen = absDx;
      const sign = Math.sign(dx);
      const vertSign = Math.sign(dy);
      const midY1 = fromPos.y + vertSign * (absDy - diagLen) / 2;
      const midY2 = midY1 + vertSign * diagLen;
      points.push({ x: fromPos.x, y: midY1 });
      points.push({ x: fromPos.x + sign * diagLen, y: midY2 });
      points.push({ x: toPos.x, y: midY2 });
    }
  } else {
    // default orthogonal routing: go to midpoint X, then to target
    const midX = (fromPos.x + toPos.x) / 2;
    points.push({ x: midX, y: fromPos.y });
    points.push({ x: midX, y: toPos.y });
  }
  points.push(toPos);
  return points;
}

/** Compute the midpoint of a segment for drag handle detection */
function segmentMidpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Angle (in degrees, 0-360) from a center point to a target point */
function angleFromCenter(cx: number, cy: number, x: number, y: number): number {
  const angle = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
  return (angle + 360) % 360;
}

/**
 * Re-route a wire so a dragged segment follows the cursor freely in 2D.
 *
 * The wire is ALWAYS kept orthogonal (only horizontal/vertical segments).
 * Terminal positions (fromPos, toPos) are NEVER moved — they're fixed to
 * component terminals. Only waypoints change.
 *
 * Path layout: [fromPos, wp1, wp2, ..., toPos]
 *   segIndex 0 = fromPos→wp1, segIndex 1 = wp1→wp2, ..., last = wpN→toPos
 *
 * When the user drags a segment handle, we move that segment to the cursor
 * position. The dragged segment stays horizontal or vertical (whichever it
 * was), and its perpendicular axis snaps to the cursor. The parallel axis
 * also follows the cursor when possible (for interior segments with waypoints
 * on both ends). Adjacent segments naturally stretch/shrink to stay connected.
 */
function rerouteWireForDrag(
  fromPos: Vec2,
  toPos: Vec2,
  segIndex: number,
  cursorGrid: Vec2,
  existingWaypoints: Vec2[],
): Vec2[] {
  // Build waypoint copy (never touch fromPos/toPos)
  const wps: Vec2[] = existingWaypoints.length > 0
    ? existingWaypoints.map((w) => ({ ...w }))
    : [
        { x: (fromPos.x + toPos.x) / 2, y: fromPos.y },
        { x: (fromPos.x + toPos.x) / 2, y: toPos.y },
      ];

  // Helper: get path point by index (0=fromPos, 1..n=waypoints, n+1=toPos)
  const getPt = (i: number): Vec2 => {
    if (i === 0) return fromPos;
    if (i === wps.length + 1) return toPos;
    return wps[i - 1];
  };
  // Helper: set a waypoint by path index (only waypoints are settable)
  const setPt = (i: number, val: Vec2) => {
    if (i > 0 && i <= wps.length) wps[i - 1] = val;
  };

  const a = getPt(segIndex);
  const b = getPt(segIndex + 1);
  const isHorizontal = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);

  if (isHorizontal) {
    // Horizontal segment: perpendicular axis = Y. Cursor Y becomes the new Y.
    // Parallel axis = X: shift segment along X toward cursor (only waypoints move).
    const newY = cursorGrid.y;
    const midX = (a.x + b.x) / 2;
    const deltaX = cursorGrid.x - midX;
    const aIdx = segIndex;
    const bIdx = segIndex + 1;
    const aIsFixed = (aIdx === 0);           // fromPos can't move
    const bIsFixed = (bIdx === wps.length + 1); // toPos can't move
    // Set Y on both endpoints (waypoints only; fixed terminals keep their Y)
    const newA = { ...getPt(aIdx) };
    const newB = { ...getPt(bIdx) };
    if (!aIsFixed) newA.y = newY;
    if (!bIsFixed) newB.y = newY;
    // Shift X: both endpoints if both are waypoints; only one if the other is fixed
    if (!aIsFixed && !bIsFixed) {
      newA.x += deltaX;
      newB.x += deltaX;
    } else if (aIsFixed && !bIsFixed) {
      newB.x += deltaX;
    } else if (!aIsFixed && bIsFixed) {
      newA.x += deltaX;
    }
    setPt(aIdx, newA);
    setPt(bIdx, newB);
  } else {
    // Vertical segment: perpendicular axis = X. Cursor X becomes the new X.
    // Parallel axis = Y: shift segment along Y toward cursor.
    const newX = cursorGrid.x;
    const midY = (a.y + b.y) / 2;
    const deltaY = cursorGrid.y - midY;
    const aIdx = segIndex;
    const bIdx = segIndex + 1;
    const aIsFixed = (aIdx === 0);
    const bIsFixed = (bIdx === wps.length + 1);
    const newA = { ...getPt(aIdx) };
    const newB = { ...getPt(bIdx) };
    if (!aIsFixed) newA.x = newX;
    if (!bIsFixed) newB.x = newX;
    if (!aIsFixed && !bIsFixed) {
      newA.y += deltaY;
      newB.y += deltaY;
    } else if (aIsFixed && !bIsFixed) {
      newB.y += deltaY;
    } else if (!aIsFixed && bIsFixed) {
      newA.y += deltaY;
    }
    setPt(aIdx, newA);
    setPt(bIdx, newB);
  }

  // After moving waypoints, the path may have diagonal segments adjacent to
  // fixed terminals. Re-orthogonalize by inserting elbow waypoints.
  return orthogonalizePath(fromPos, toPos, wps);
}

/**
 * Ensure a wire path is fully orthogonal (no diagonal segments).
 * If moving a waypoint created a diagonal segment adjacent to a fixed terminal,
 * insert an extra elbow waypoint to break it into two orthogonal segments.
 *
 * This is called after rerouteWireForDrag to clean up any diagonals.
 */
function orthogonalizePath(fromPos: Vec2, toPos: Vec2, wps: Vec2[]): Vec2[] {
  const result: Vec2[] = [];
  const full: Vec2[] = [fromPos, ...wps, toPos];
  for (let i = 0; i < full.length - 1; i++) {
    const a = full[i];
    const b = full[i + 1];
    result.push({ ...a });
    // If segment is diagonal, insert an elbow (go horizontal first, then vertical)
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) {
      // Insert elbow at (b.x, a.y) — horizontal first, then vertical
      result.push({ x: b.x, y: a.y });
    }
  }
  result.push({ ...toPos });
  // Convert back to waypoints (exclude fromPos and toPos)
  return result.slice(1, -1);
}

export function CircuitCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [cursor, setCursor] = useState<Vec2>({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);
  const panRef = useRef<{ start: Vec2; origin: Vec2 } | null>(null);
  // rotateDrag needs to trigger re-renders (for the snap-angle indicator), so it's state.
  // We keep a ref in sync for use inside event handlers.
  const [rotateDrag, setRotateDrag] = useState<RotateDragState | null>(null);
  const rotateDragRef = useRef<RotateDragState | null>(null);
  useEffect(() => { rotateDragRef.current = rotateDrag; }, [rotateDrag]);
  const [hover, setHover] = useState<HoverState>({
    componentId: null,
    terminal: null,
    wireId: null,
    wireHandle: null,
    rotateHandle: null,
  });
  // animation phase for current flow dots — continuous counter (never wraps)
  // Using a large float that never resets eliminates the "snap back" visual glitch.
  const flowPhaseRef = useRef(0);
  const [use45Routing, setUse45Routing] = useState(false);
  const plugins = getAllPlugins();

  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const selection = useEditor((s) => s.selection);
  const multiSelection = useEditor((s) => s.multiSelection);
  const simContext = useEditor((s) => s.simContext);
  const running = useEditor((s) => s.running);
  const showGrid = useEditor((s) => s.showGrid);
  const snapToGrid = useEditor((s) => s.snapToGrid);
  const wireDraft = useEditor((s) => s.wireDraft);
  // KiCad-parity new state
  const noConnects = useEditor((s) => s.noConnects);
  const drawings = useEditor((s) => s.drawings);
  const units = useEditor((s) => s.units);
  const showPinNumbers = useEditor((s) => s.showPinNumbers);
  const showPinNames = useEditor((s) => s.showPinNames);
  const showPinElecTypes = useEditor((s) => s.showPinElecTypes);
  const showRefdes = useEditor((s) => s.showRefdes);
  const showValues = useEditor((s) => s.showValues);
  const activeTool = useEditor((s) => s.activeTool);

  // Live ERC — auto-runs on every change, debounced. Disabled while simulating
  // so it doesn't fight the simulation loop for CPU.
  useAutoERC(!running);
  const ercErrors = useEditor((s) => s.ercErrors);
  const [hoveredERC, setHoveredERC] = useState<ERCError | null>(null);
  const [mousePos, setMousePos] = useState<Vec2>({ x: 0, y: 0 });

  const addComponent = useEditor((s) => s.addComponent);
  const moveComponent = useEditor((s) => s.moveComponent);
  const rotateComponent = useEditor((s) => s.rotateComponent);
  const deleteComponent = useEditor((s) => s.deleteComponent);
  const setSelection = useEditor((s) => s.setSelection);
  const startWire = useEditor((s) => s.startWire);
  const updateWireCursor = useEditor((s) => s.updateWireCursor);
  const completeWire = useEditor((s) => s.completeWire);
  const cancelWire = useEditor((s) => s.cancelWire);
  const setWireWaypoints = useEditor((s) => s.setWireWaypoints);
  const toggleSwitch = useEditor((s) => s.toggleSwitch);
  const step = useEditor((s) => s.step);

  // resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // SINGLE unified animation+simulation loop.
  // Both the simulation step and the flow-dot phase advance happen in the same
  // requestAnimationFrame callback, so there's only ONE re-render per frame.
  // This eliminates the blinking/lag caused by two competing RAF loops.
  // The flow dot speed is linked to the simulation speed setting so they match.
  const [animTick, setAnimTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let lastSimTime = performance.now();
    const SIM_INTERVAL = 16; // ms between simulation steps (~60Hz)
    const loop = (now: number) => {
      // Advance flow phase continuously — never wrap with % 1.
      // Each wire uses frac(phase * speed) internally, so dots cycle smoothly
      // per-wire without all dots snapping back at the same time.
      const simSpeed = useEditor.getState().speed;
      flowPhaseRef.current += 0.012 * Math.max(0.5, Math.min(4, simSpeed));
      // Run simulation step at fixed interval
      if (now - lastSimTime >= SIM_INTERVAL) {
        step();
        lastSimTime = now;
      }
      // Single re-render per frame — covers both sim state and animation
      setAnimTick((t) => (t + 1) % 1000000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, step]);
  void animTick; // referenced in render effect deps

  // helpers
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
    return null;
  }, [components, getTerminalPos]);

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

  // find wire under cursor (hit-test against wire path)
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
  }, [wires, components, gridToScreen, getTerminalPos]);

  // find a draggable wire segment midpoint handle
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
  }, [wires, components, gridToScreen, getTerminalPos]);

  // compute rotation handle position for a component (in screen coords)
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

  // ----- Rendering -----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    // bg
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, size.width, size.height);

    // grid
    if (showGrid) {
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      const stepPx = CELL_SIZE * zoom;
      const startX = pan.x % stepPx;
      const startY = pan.y % stepPx;
      ctx.beginPath();
      for (let x = startX; x < size.width; x += stepPx) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.height);
      }
      for (let y = startY; y < size.height; y += stepPx) {
        ctx.moveTo(0, y);
        ctx.lineTo(size.width, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#475569';
      ctx.fillRect(pan.x - 1, pan.y - 1, 3, 3);
    }

    // compute wire + component currents for flow animation — ONLY when running AND simContext exists.
    const isAnimating = running && simContext != null;
    const pluginsMap = new Map(plugins.map((p) => [p.type, p]));
    const wireCurrents = isAnimating ? computeWireCurrents(
      components, wires, pluginsMap, simContext!,
    ) : new Map<string, number>();
    const componentCurrents = isAnimating ? computeComponentCurrents(
      components, wires, pluginsMap, simContext!,
    ) : new Map<string, number>();

    // Build a map of node -> number of attached wires (for junction coloring)
    const nodeWireCount = new Map<string, number>();
    for (const wire of wires) {
      const key1 = `${wire.from.componentId}:${wire.from.terminalId}`;
      const key2 = `${wire.to.componentId}:${wire.to.terminalId}`;
      nodeWireCount.set(key1, (nodeWireCount.get(key1) ?? 0) + 1);
      nodeWireCount.set(key2, (nodeWireCount.get(key2) ?? 0) + 1);
    }

    // Build node network: which terminals share the same electrical node.
    // When a wire is selected or hovered, all terminals and wires on the same
    // node should highlight, making it easy to see what connects to what.
    const pluginsMapForNodes = new Map(plugins.map((p) => [p.type, p]));
    const nodeMap = buildNodeMap(components, wires, pluginsMapForNodes);
    // Map: terminalKey ("compId:termId") -> nodeId
    // Map: nodeId -> Set of terminalKeys
    // Map: nodeId -> Set of wireIds
    const nodeToTerminals = new Map<number, Set<string>>();
    const nodeToWires = new Map<number, Set<string>>();
    for (const [termKey, nodeId] of nodeMap.terminalNode) {
      if (!nodeToTerminals.has(nodeId)) nodeToTerminals.set(nodeId, new Set());
      nodeToTerminals.get(nodeId)!.add(termKey);
    }
    for (const wire of wires) {
      const fromKey = `${wire.from.componentId}:${wire.from.terminalId}`;
      const toKey = `${wire.to.componentId}:${wire.to.terminalId}`;
      const fromNode = nodeMap.terminalNode.get(fromKey) ?? -1;
      const toNode = nodeMap.terminalNode.get(toKey) ?? -2;
      // The wire connects fromNode and toNode (which should be the same after union-find)
      const nodeId = fromNode; // they're the same node
      if (!nodeToWires.has(nodeId)) nodeToWires.set(nodeId, new Set());
      nodeToWires.get(nodeId)!.add(wire.id);
      void toNode;
    }

    // Determine which node is "active" (selected or hovered wire's node)
    let activeNodeId: number | null = null;
    if (selection.type === 'wire' && selection.id) {
      const selWire = wires.find((w) => w.id === selection.id);
      if (selWire) {
        const fromKey = `${selWire.from.componentId}:${selWire.from.terminalId}`;
        activeNodeId = nodeMap.terminalNode.get(fromKey) ?? null;
      }
    } else if (hover.wireId) {
      const hovWire = wires.find((w) => w.id === hover.wireId);
      if (hovWire) {
        const fromKey = `${hovWire.from.componentId}:${hovWire.from.terminalId}`;
        activeNodeId = nodeMap.terminalNode.get(fromKey) ?? null;
      }
    }
    // Set of terminal keys and wire IDs that should highlight
    const activeTerminals = activeNodeId != null ? (nodeToTerminals.get(activeNodeId) ?? new Set<string>()) : new Set<string>();
    const activeWires = activeNodeId != null ? (nodeToWires.get(activeNodeId) ?? new Set<string>()) : new Set<string>();

    // ---- Draw wires FIRST (below components) ----
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
      const isSelected = selection.type === 'wire' && selection.id === wire.id;
      const isHover = hover.wireId === wire.id;
      const isOnActiveNode = activeWires.has(wire.id);

      // wire — highlight all wires on the same electrical node
      ctx.strokeStyle = isSelected ? '#fbbf24' : (isHover ? '#fde047' : (isOnActiveNode ? '#cbd5e1' : '#94a3b8'));
      ctx.lineWidth = isSelected ? 3.5 : (isHover ? 3 : (isOnActiveNode ? 2.5 : 2));
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
      ctx.stroke();

      // draw wire segment midpoint handles (only when not running, for editing)
      if (!running) {
        for (let i = 0; i < path.length - 1; i++) {
          const a = path[i];
          const b = path[i + 1];
          const mid = segmentMidpoint(a, b);
          const isHandleHot = hover.wireHandle?.wireId === wire.id && hover.wireHandle?.segIndex === i;
          ctx.beginPath();
          ctx.arc(mid.x, mid.y, isHandleHot ? 5 : 3, 0, Math.PI * 2);
          ctx.fillStyle = isHandleHot ? '#fbbf24' : '#475569';
          ctx.fill();
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // draw animated current flow dots — ONLY when running AND simContext is active.
      // When paused or editing, absolutely no dots are drawn.
      if (isAnimating) {
        const current = wireCurrents.get(wire.id) ?? 0;
        const absCurrent = Math.abs(current);
        if (absCurrent > 1e-9) {
          const dir = current >= 0 ? 1 : -1;
          const speed = Math.min(1, Math.max(0.1, Math.log10(absCurrent * 1000 + 1) / 3));
          const dotSpacing = 24;
          let totalLen = 0;
          const segLens: number[] = [];
          for (let i = 0; i < path.length - 1; i++) {
            const a = path[i];
            const b = path[i + 1];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            segLens.push(len);
            totalLen += len;
          }
          if (totalLen > 0) {
            const numDots = Math.max(2, Math.floor(totalLen / dotSpacing));
            // Use frac() for smooth per-wire wrapping — no global snap-back
            const phase = flowPhaseRef.current * speed * dir;
            const fracPhase = phase - Math.floor(phase); // 0..1, wraps smoothly per wire
            ctx.fillStyle = '#fde047';
            ctx.shadowColor = '#fde047';
            ctx.shadowBlur = 6;
            for (let n = 0; n < numDots; n++) {
              let distAlong = (n / numDots + fracPhase) * totalLen;
              // Smooth wrap: mod by totalLen (handles negative and > totalLen)
              distAlong = ((distAlong % totalLen) + totalLen) % totalLen;
              let acc = 0;
              for (let i = 0; i < segLens.length; i++) {
                if (acc + segLens[i] >= distAlong) {
                  const t = (distAlong - acc) / segLens[i];
                  const a = path[i];
                  const b = path[i + 1];
                  const x = a.x + (b.x - a.x) * t;
                  const y = a.y + (b.y - a.y) * t;
                  ctx.beginPath();
                  ctx.arc(x, y, 3, 0, Math.PI * 2);
                  ctx.fill();
                  break;
                }
                acc += segLens[i];
              }
            }
            ctx.shadowBlur = 0;
          }
        }
      }
    }

    // draw wire draft
    if (wireDraft) {
      const fromComp = components.find((c) => c.id === wireDraft.from.componentId);
      if (fromComp) {
        const plugin = getPlugin(fromComp.type);
        if (plugin) {
          const t = plugin.terminals.find((tt) => tt.id === wireDraft.from.terminalId);
          if (t) {
            const fromPos = gridToScreen(getTerminalPos(fromComp, t).x, getTerminalPos(fromComp, t).y);
            const toPos = gridToScreen(wireDraft.cursor.x, wireDraft.cursor.y);
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(fromPos.x, fromPos.y);
            ctx.lineTo(toPos.x, toPos.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
    }

    // ---- Draw components ON TOP of wires ----
    for (const comp of components) {
      const plugin = getPlugin(comp.type);
      if (!plugin) continue;
      const isSelected = selection.type === 'component' && selection.id === comp.id;
      const isMultiSelected = multiSelection.components.has(comp.id);
      const isHover = hover.componentId === comp.id;
      const origin = gridToScreen(comp.position.x, comp.position.y);
      ctx.save();
      ctx.translate(origin.x, origin.y);
      ctx.scale(zoom, zoom);
      // Rotate around the component's CENTER (not top-left corner).
      // Translate to center, rotate, translate back.
      const bbCx = plugin.boundingBox.width / 2;
      const bbCy = plugin.boundingBox.height / 2;
      ctx.translate(bbCx * CELL_SIZE, bbCy * CELL_SIZE);
      ctx.rotate((comp.rotation * Math.PI) / 2);
      // Mirror (X = vertical flip, Y = horizontal flip)
      if (comp.mirrorX) ctx.scale(1, -1);
      if (comp.mirrorY) ctx.scale(-1, 1);
      ctx.translate(-bbCx * CELL_SIZE, -bbCy * CELL_SIZE);
      // selection halo
      if (isSelected || isHover || isMultiSelected) {
        ctx.save();
        const haloColor = isSelected ? '#fbbf24' : isMultiSelected ? '#22d3ee' : '#64748b';
        const haloFill = isSelected ? 'rgba(251,191,36,0.18)' : isMultiSelected ? 'rgba(34,211,238,0.15)' : 'rgba(148,163,184,0.12)';
        ctx.fillStyle = haloFill;
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(-2, -2, plugin.boundingBox.width * CELL_SIZE + 4, plugin.boundingBox.height * CELL_SIZE + 4);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      // locked indicator (small lock icon top-right corner)
      if (comp.locked) {
        ctx.save();
        ctx.fillStyle = '#facc15';
        const lx = plugin.boundingBox.width * CELL_SIZE - 14;
        const ly = -10;
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText('🔒', lx, ly);
        ctx.restore();
      }
      ctx.strokeStyle = '#e2e8f0';
      ctx.fillStyle = '#e2e8f0';
      ctx.lineWidth = 1.5;
      // Create a temporary instance with __current attached so render() can
      // use it for brightness/volume effects. We don't mutate the store state.
      const renderInstance = isAnimating
        ? { ...comp, simState: { ...(comp.simState ?? {}), __current: componentCurrents.get(comp.id) ?? 0 } }
        : comp;
      try {
        plugin.render(ctx, comp.parameters, CELL_SIZE, simContext ?? undefined, renderInstance);
      } catch (e) {
        console.error(`render error in ${comp.type}:`, e);
      }
      ctx.restore();

      // Draw reference designator label above the component
      if (comp.refdes) {
        const labelPos = gridToScreen(comp.position.x + plugin.boundingBox.width / 2, comp.position.y - 0.3);
        ctx.save();
        ctx.fillStyle = isSelected ? '#fbbf24' : isMultiSelected ? '#22d3ee' : '#94a3b8';
        ctx.font = `${Math.max(9, Math.floor(10 * zoom))}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(comp.refdes, labelPos.x, labelPos.y);
        ctx.restore();
      }

      // draw terminals (in screen coords) — color by connected state and active node
      for (const t of plugin.terminals) {
        const tpos = getTerminalPos(comp, t);
        const sp = gridToScreen(tpos.x, tpos.y);
        const isHot = hover.terminal?.componentId === comp.id && hover.terminal?.terminalId === t.id;
        const connKey = `${comp.id}:${t.id}`;
        const isConnected = (nodeWireCount.get(connKey) ?? 0) > 0;
        const isOnActiveNode = activeTerminals.has(connKey);
        // Junctions are "live" (green glow) only while running; otherwise show connected state plainly.
        const isLive = isConnected && running && simContext != null;
        let color = '#475569'; // unconnected: dark gray
        let radius = 3;
        let glow = 0;
        if (isHot) { color = '#fbbf24'; radius = 5; }
        else if (isOnActiveNode) { color = '#fde047'; radius = 5; glow = 6; } // active node: bright yellow
        else if (isLive) { color = '#22c55e'; radius = 4; glow = 8; }
        else if (isConnected) { color = '#cbd5e1'; }
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (glow > 0) {
          ctx.shadowColor = color;
          ctx.shadowBlur = glow;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // draw animated current flow dots THROUGH the component body
      if (isAnimating && plugin.getFlowPath) {
        const current = componentCurrents.get(comp.id) ?? 0;
        const absCurrent = Math.abs(current);
        if (absCurrent > 1e-9) {
          const dir = current >= 0 ? 1 : -1;
          // Speed: proportional to current magnitude.
          // Physics: I = V/R (Ohm's law). Higher current = faster flow.
          // For inductor: I(t) = V/R·(1-e^(-Rt/L)) — starts at 0, ramps up.
          // For capacitor: I = C·dV/dt — strong when charging, 0 when fully charged.
          // The actual current value already reflects these physics because we
          // compute it from the solved node voltages and component state.
          // We map current to a visual speed: log-scaled so wide current ranges
          // are visible. 1mA → ~0.33, 10mA → ~0.67, 100mA → ~1.0
          const speed = Math.min(1.5, Math.max(0.05, Math.log10(absCurrent * 1000 + 1) / 3));
          // Get the flow path in grid coords (relative to component origin, pre-rotation)
          const flowGridPath = plugin.getFlowPath(comp.parameters, simContext ?? undefined, comp);
          if (flowGridPath && flowGridPath.length >= 2) {
            // Transform each point: apply rotation, then translate to component position, then to screen
            const flowScreenPath: Vec2[] = flowGridPath.map((gp) => {
              // Apply rotation (0,1,2,3 = 0°,90°,180°,270°) around bounding box center
              const bb = plugin.boundingBox;
              const cx = bb.width / 2;
              const cy = bb.height / 2;
              const dx = gp.x - cx;
              const dy = gp.y - cy;
              let rx: number, ry: number;
              switch (comp.rotation) {
                case 0: rx = dx; ry = dy; break;
                case 1: rx = -dy; ry = dx; break;
                case 2: rx = -dx; ry = -dy; break;
                case 3: rx = dy; ry = -dx; break;
              }
              const gridX = comp.position.x + cx + rx;
              const gridY = comp.position.y + cy + ry;
              return gridToScreen(gridX, gridY);
            });
            // Compute total path length
            let totalLen = 0;
            const segLens: number[] = [];
            for (let i = 0; i < flowScreenPath.length - 1; i++) {
              const a = flowScreenPath[i];
              const b = flowScreenPath[i + 1];
              const len = Math.hypot(b.x - a.x, b.y - a.y);
              segLens.push(len);
              totalLen += len;
            }
            if (totalLen > 0) {
              const dotSpacing = 18;
              const numDots = Math.max(2, Math.floor(totalLen / dotSpacing));
              // Use frac() for smooth per-component wrapping — no global snap-back
              const phase = flowPhaseRef.current * speed * dir;
              const fracPhase = phase - Math.floor(phase);
              ctx.fillStyle = '#fde047';
              ctx.shadowColor = '#fde047';
              ctx.shadowBlur = 6;
              for (let n = 0; n < numDots; n++) {
                let distAlong = (n / numDots + fracPhase) * totalLen;
                distAlong = ((distAlong % totalLen) + totalLen) % totalLen;
                let acc = 0;
                for (let i = 0; i < segLens.length; i++) {
                  if (acc + segLens[i] >= distAlong) {
                    const t = (distAlong - acc) / segLens[i];
                    const a = flowScreenPath[i];
                    const b = flowScreenPath[i + 1];
                    const x = a.x + (b.x - a.x) * t;
                    const y = a.y + (b.y - a.y) * t;
                    ctx.beginPath();
                    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
                    ctx.fill();
                    break;
                  }
                  acc += segLens[i];
                }
              }
              ctx.shadowBlur = 0;
            }
          }
        }
      }

      // draw rotation handle on selected component (only when not running)
      if (isSelected && !running) {
        const bb = plugin.boundingBox;
        const centerGrid = { x: comp.position.x + bb.width / 2, y: comp.position.y + bb.height / 2 };
        const centerScreen = gridToScreen(centerGrid.x, centerGrid.y);
        const handlePos = getRotateHandlePos(comp);
        if (handlePos) {
          const isHandleHot = hover.rotateHandle === comp.id || rotateDragRef.current?.componentId === comp.id;
          // line from box to handle
          ctx.strokeStyle = '#fbbf24';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(centerScreen.x, centerScreen.y - (bb.height / 2 * CELL_SIZE * zoom) - 2);
          ctx.lineTo(handlePos.x, handlePos.y + 9);
          ctx.stroke();
          ctx.setLineDash([]);
          // handle circle with rotate icon
          ctx.beginPath();
          ctx.arc(handlePos.x, handlePos.y, isHandleHot ? 10 : 9, 0, Math.PI * 2);
          ctx.fillStyle = isHandleHot ? '#fbbf24' : '#1e293b';
          ctx.fill();
          ctx.strokeStyle = '#fbbf24';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          // draw a small rotate arrow inside
          ctx.strokeStyle = isHandleHot ? '#0f172a' : '#fbbf24';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(handlePos.x, handlePos.y, 4, -Math.PI * 0.2, Math.PI * 1.1);
          ctx.stroke();
          // arrowhead
          ctx.beginPath();
          ctx.moveTo(handlePos.x + 4.5, handlePos.y - 1);
          ctx.lineTo(handlePos.x + 2.8, handlePos.y - 4.5);
          ctx.lineTo(handlePos.x + 5.5, handlePos.y - 4.5);
          ctx.closePath();
          ctx.fillStyle = isHandleHot ? '#0f172a' : '#fbbf24';
          ctx.fill();

          // While dragging rotation, show a visual indicator of the target snap angle
          if (rotateDragRef.current?.componentId === comp.id) {
            const cursorScreen = gridToScreen(cursor.x, cursor.y);
            const curAngle = angleFromCenter(centerScreen.x, centerScreen.y, cursorScreen.x, cursorScreen.y);
            // Snap to nearest 90°: 0/90/180/270. We map cursor angle to rotation increment.
            // Up = 270°, Right = 0°, Down = 90°, Left = 180° (screen y is down)
            // We snap based on which quadrant the cursor is in relative to center.
            // Show the snap direction as a thick arrow from center.
            let snapRot: 0 | 1 | 2 | 3 = 0;
            // Convert cursor angle to a rotation increment (0=right, 1=down, 2=left, 3=up)
            // We want: cursor up (angle ~270) => rotation 3 (or whichever makes component point up)
            // Use the angle to determine nearest of 4 directions
            const normalized = (curAngle + 45) % 360;
            if (normalized < 90) snapRot = 0;
            else if (normalized < 180) snapRot = 1;
            else if (normalized < 270) snapRot = 2;
            else snapRot = 3;
            void snapRot;
            // Draw a dashed line from center to cursor
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.5)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(centerScreen.x, centerScreen.y);
            ctx.lineTo(cursorScreen.x, cursorScreen.y);
            ctx.stroke();
            ctx.setLineDash([]);
            // Draw the snap angle text
            ctx.fillStyle = '#fbbf24';
            ctx.font = 'bold 11px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const snapDeg = (snapRot * 90) % 360;
            ctx.fillText(`${snapDeg}°`, cursorScreen.x, cursorScreen.y - 14);
          }
        }
      }

      // "click to toggle" hint for switches during simulation
      if (running && TOGGLEABLE_TYPES.has(comp.type) && (isHover || isSelected)) {
        const bb = plugin.boundingBox;
        const centerGrid = { x: comp.position.x + bb.width / 2, y: comp.position.y + bb.height / 2 };
        const centerScreen = gridToScreen(centerGrid.x, centerGrid.y);
        const label = comp.type === 'switch'
          ? (comp.parameters.closed ? 'OPEN' : 'CLOSE')
          : (comp.parameters.pressed ? 'RELEASE' : 'PRESS');
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(centerScreen.x - tw / 2, centerScreen.y + (bb.height / 2 * CELL_SIZE * zoom) + 4, tw, 16);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1;
        ctx.strokeRect(centerScreen.x - tw / 2, centerScreen.y + (bb.height / 2 * CELL_SIZE * zoom) + 4, tw, 16);
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(label, centerScreen.x, centerScreen.y + (bb.height / 2 * CELL_SIZE * zoom) + 12);
      }

      // pin number/name/electrical-type labels (KiCad view toggles)
      if (!running && (showPinNumbers || showPinNames || showPinElecTypes)) {
        for (const t of plugin.terminals) {
          if (t.hidden) continue;
          const tpos = getTerminalPos(comp, t);
          const sp = gridToScreen(tpos.x, tpos.y);
          const labels: string[] = [];
          if (showPinNumbers && t.number) labels.push(`[${t.number}]`);
          if (showPinNames && t.name) labels.push(t.name);
          if (showPinElecTypes && t.electricalType) labels.push(t.electricalType);
          if (labels.length === 0) continue;
          ctx.save();
          ctx.fillStyle = '#22d3ee';
          ctx.font = `${Math.max(8, Math.floor(8 * zoom))}px ui-monospace, monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(labels.join(' '), sp.x + 6, sp.y + 4);
          ctx.restore();
        }
      }
    }

    // ---- No-Connect markers (red X on intentionally unused pins) ----
    for (const nc of noConnects) {
      const comp = components.find((c) => c.id === nc.componentId);
      if (!comp) continue;
      const plugin = getPlugin(comp.type);
      if (!plugin) continue;
      const t = plugin.terminals.find((tt) => tt.id === nc.terminalId);
      if (!t) continue;
      const tpos = getTerminalPos(comp, t);
      const sp = gridToScreen(tpos.x, tpos.y);
      const s = 6;
      ctx.save();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sp.x - s, sp.y - s); ctx.lineTo(sp.x + s, sp.y + s);
      ctx.moveTo(sp.x + s, sp.y - s); ctx.lineTo(sp.x - s, sp.y + s);
      ctx.stroke();
      ctx.restore();
    }

    // ---- Drawing primitives (line, polyline, polygon, arc, circle, text, image) ----
    for (const d of drawings) {
      ctx.save();
      try {
        switch (d.type) {
          case 'line': {
            const a = gridToScreen(d.points[0].x, d.points[0].y);
            const b = gridToScreen(d.points[1].x, d.points[1].y);
            ctx.strokeStyle = d.color;
            ctx.lineWidth = d.strokeWidth;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            break;
          }
          case 'polyline': {
            ctx.strokeStyle = d.color;
            ctx.lineWidth = d.strokeWidth;
            ctx.fillStyle = d.fill ?? 'transparent';
            ctx.beginPath();
            for (let i = 0; i < d.points.length; i++) {
              const p = gridToScreen(d.points[i].x, d.points[i].y);
              if (i === 0) ctx.moveTo(p.x, p.y);
              else ctx.lineTo(p.x, p.y);
            }
            if (d.closed) { ctx.closePath(); ctx.fill(); }
            ctx.stroke();
            break;
          }
          case 'polygon': {
            ctx.fillStyle = d.fill;
            if (d.stroke) { ctx.strokeStyle = d.stroke; ctx.lineWidth = d.strokeWidth ?? 1; }
            ctx.beginPath();
            for (let i = 0; i < d.points.length; i++) {
              const p = gridToScreen(d.points[i].x, d.points[i].y);
              if (i === 0) ctx.moveTo(p.x, p.y);
              else ctx.lineTo(p.x, p.y);
            }
            ctx.closePath();
            ctx.fill();
            if (d.stroke) ctx.stroke();
            break;
          }
          case 'arc': {
            const c = gridToScreen(d.center.x, d.center.y);
            ctx.strokeStyle = d.color;
            ctx.lineWidth = d.strokeWidth;
            ctx.beginPath();
            ctx.arc(c.x, c.y, d.radius * CELL_SIZE * zoom, d.startAngle, d.endAngle);
            ctx.stroke();
            break;
          }
          case 'circle': {
            const c = gridToScreen(d.center.x, d.center.y);
            ctx.strokeStyle = d.color;
            ctx.lineWidth = d.strokeWidth;
            ctx.fillStyle = d.fill ?? 'transparent';
            ctx.beginPath();
            ctx.arc(c.x, c.y, d.radius * CELL_SIZE * zoom, 0, Math.PI * 2);
            if (d.fill) ctx.fill();
            ctx.stroke();
            break;
          }
          case 'text': {
            const p = gridToScreen(d.position.x, d.position.y);
            ctx.fillStyle = d.color;
            ctx.font = `${d.fontSize * zoom}px ui-monospace, monospace`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            if (d.rotation) {
              ctx.save();
              ctx.translate(p.x, p.y);
              ctx.rotate((d.rotation * Math.PI) / 180);
              ctx.fillText(d.text, 0, 0);
              ctx.restore();
            } else {
              ctx.fillText(d.text, p.x, p.y);
            }
            break;
          }
          case 'image': {
            const p = gridToScreen(d.position.x, d.position.y);
            const img = (window as any).__circuitlab_images?.[d.id];
            if (img) {
              ctx.drawImage(img, p.x, p.y, d.size.width * CELL_SIZE * zoom, d.size.height * CELL_SIZE * zoom);
            } else {
              // placeholder box
              ctx.strokeStyle = '#94a3b8';
              ctx.setLineDash([4, 4]);
              ctx.strokeRect(p.x, p.y, d.size.width * CELL_SIZE * zoom, d.size.height * CELL_SIZE * zoom);
              ctx.setLineDash([]);
              ctx.fillStyle = '#64748b';
              ctx.font = '10px ui-monospace';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText('IMG', p.x + d.size.width * CELL_SIZE * zoom / 2, p.y + d.size.height * CELL_SIZE * zoom / 2);
            }
            break;
          }
        }
      } catch (e) {
        console.error('drawing render error:', e);
      }
      ctx.restore();
    }

    // draw cursor crosshair (when no drag)
    if (!dragRef.current && !panRef.current && !wireDragRef.current && !rotateDragRef.current) {
      const sp = gridToScreen(cursor.x, cursor.y);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sp.x - 6, sp.y);
      ctx.lineTo(sp.x + 6, sp.y);
      ctx.moveTo(sp.x, sp.y - 6);
      ctx.lineTo(sp.x, sp.y + 6);
      ctx.stroke();
    }

    // ---- Wire overlay: redraw wires ON TOP of components so they're always visible ----
    // This prevents components from hiding wires. We draw a subtle dark background
    // under each wire for contrast, then the wire color on top.
    let wireLengthScreenPath: Vec2[] | null = null;
    let wireLengthGridPath: Vec2[] | null = null;
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
      const isSelected = selection.type === 'wire' && selection.id === wire.id;
      const isHover = hover.wireId === wire.id;
      const isOnActiveNode = activeWires.has(wire.id);

      // Capture path for length label (selected/hovered wires only)
      if (isSelected || isHover) {
        wireLengthScreenPath = path;
        // reconstruct grid coords for length calculation
        const fromGrid = getTerminalPos(fromComp, fromT);
        const toGrid = getTerminalPos(toComp, toT);
        // grid path: from terminal → waypoints → to terminal
        wireLengthGridPath = [fromGrid, ...(wire.waypoints ?? []), toGrid];
      }

      // Only redraw wires that are selected, hovered, or on the active node
      // (to avoid overdrawing every wire on top of every component)
      if (isSelected || isHover || isOnActiveNode) {
        // Draw with glow for highlighted wires
        ctx.strokeStyle = isSelected ? '#fbbf24' : (isHover ? '#fde047' : '#cbd5e1');
        ctx.lineWidth = isSelected ? 3.5 : (isHover ? 3 : 2.5);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (isOnActiveNode && !isSelected) {
          ctx.shadowColor = '#fde047';
          ctx.shadowBlur = 4;
        }
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    // ---- Auto-junction dots (where ≥3 wires meet) ----
    // Drawn AFTER wires so they sit on top, KiCad-style.
    drawAutoJunctions(ctx, components, wires, gridToScreen, hover.terminal);

    // ---- Wire length label for selected or hovered wire ----
    if (wireLengthScreenPath && wireLengthGridPath) {
      drawWireLengthLabel(ctx, wireLengthScreenPath, wireLengthGridPath, units);
    }

    // ---- ERC error markers (drawn last so they're on top of everything) ----
    // Hidden during simulation to avoid visual clutter while current is flowing.
    if (!running && ercErrors.length > 0) {
      drawERCMarkers(ercErrors, ctx, gridToScreen, hoveredERC);
    }

    ctx.restore();
  }, [size, pan, zoom, components, wires, selection, multiSelection, hover, cursor, simContext, showGrid, wireDraft, use45Routing, running, gridToScreen, getTerminalPos, plugins, animTick, getRotateHandlePos, ercErrors, hoveredERC, units]);

  // ----- Mouse handlers -----
  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const g = screenToGrid(sx, sy);

    // middle or right button: pan
    if (e.button === 1 || e.button === 2) {
      panRef.current = { start: { x: sx, y: sy }, origin: { ...pan } };
      return;
    }

    // If simulation is running, check for toggleable components FIRST
    // Use getState() for the latest running state
    const isRunningNow = useEditor.getState().running;
    if (isRunningNow) {
      const term = findTerminalAt(g.x, g.y);
      if (term) return; // no wire drawing during simulation
      const comp = findComponentAt(g.x, g.y);
      if (comp && TOGGLEABLE_TYPES.has(comp.type)) {
        toggleSwitch(comp.id);
        return;
      }
      if (comp) {
        setSelection({ type: 'component', id: comp.id });
        return;
      }
      setSelection({ type: null, id: null });
      return;
    }

    // check rotation handle on selected component — start a rotate drag
    // Use getState() for the latest selection (the `selection` from the hook may be stale)
    const currentSelection = useEditor.getState().selection;
    if (!isRunningNow && currentSelection.type === 'component') {
      const comp = components.find((c) => c.id === currentSelection.id);
      if (comp) {
        const plugin = getPlugin(comp.type);
        if (plugin) {
          const handlePos = getRotateHandlePos(comp);
          if (handlePos) {
            const dx = sx - handlePos.x;
            const dy = sy - handlePos.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < 400) { // 20px radius hit zone
              const bb = plugin.boundingBox;
              const centerGrid = { x: comp.position.x + bb.width / 2, y: comp.position.y + bb.height / 2 };
              const centerScreen = gridToScreen(centerGrid.x, centerGrid.y);
              const newDrag: RotateDragState = {
                componentId: comp.id,
                center: centerScreen,
                startAngle: angleFromCenter(centerScreen.x, centerScreen.y, sx, sy),
                startRotation: comp.rotation,
              };
              rotateDragRef.current = newDrag;
              setRotateDrag(newDrag);
              return;
            }
          }
        }
      }
    }

    // check wire segment handle (for dragging)
    if (hover.wireHandle) {
      const wire = wires.find((w) => w.id === hover.wireHandle!.wireId);
      if (wire) {
        const fromComp = components.find((c) => c.id === wire.from.componentId);
        const toComp = components.find((c) => c.id === wire.to.componentId);
        if (fromComp && toComp) {
          const fromPlugin = getPlugin(fromComp.type);
          const toPlugin = getPlugin(toComp.type);
          if (fromPlugin && toPlugin) {
            const fromT = fromPlugin.terminals.find((t) => t.id === wire.from.terminalId);
            const toT = toPlugin.terminals.find((t) => t.id === wire.to.terminalId);
            if (fromT && toT) {
              const fromPos = getTerminalPos(fromComp, fromT);
              const toPos = getTerminalPos(toComp, toT);
              const originalWaypoints = wire.waypoints && wire.waypoints.length > 0
                ? wire.waypoints.map((w) => ({ ...w }))
                : [
                    { x: (fromPos.x + toPos.x) / 2, y: fromPos.y },
                    { x: (fromPos.x + toPos.x) / 2, y: toPos.y },
                  ];
              wireDragRef.current = {
                wireId: hover.wireHandle.wireId,
                segIndex: hover.wireHandle.segIndex,
                startGrid: g,
                originalWaypoints,
              };
              return;
            }
          }
        }
      }
    }

    // check terminal first
    const term = findTerminalAt(g.x, g.y);
    if (term) {
      if (wireDraft) {
        completeWire({ componentId: term.componentId, terminalId: term.terminalId });
      } else {
        startWire({ componentId: term.componentId, terminalId: term.terminalId }, g);
      }
      return;
    }

    // check component
    const comp = findComponentAt(g.x, g.y);
    if (comp) {
      if (e.shiftKey) {
        // Shift-click: toggle multi-select
        useEditor.getState().toggleMultiSelect('component', comp.id);
        return;
      }
      // If clicking an already-selected component in multi-selection, start group drag
      const ms = useEditor.getState().multiSelection;
      if (ms.components.has(comp.id) && ms.components.size > 1) {
        useEditor.getState().pushHistory();
        dragRef.current = {
          componentId: comp.id,
          offset: { x: g.x - comp.position.x, y: g.y - comp.position.y },
          isGroupDrag: true,
          lastGrid: { ...g },
        };
        return;
      }
      // Push history BEFORE drag starts (not after) so undo works correctly
      useEditor.getState().pushHistory();
      setSelection({ type: 'component', id: comp.id });
      dragRef.current = {
        componentId: comp.id,
        offset: { x: g.x - comp.position.x, y: g.y - comp.position.y },
      };
      return;
    }

    // check wire (for selection)
    const wireId = findWireAt(sx, sy);
    if (wireId) {
      setSelection({ type: 'wire', id: wireId });
      return;
    }

    // empty space: clear selection, cancel wire
    setSelection({ type: null, id: null });
    if (wireDraft) cancelWire();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const g = screenToGrid(sx, sy);
    setCursor(g);
    setMousePos({ x: sx, y: sy });

    // Live ERC hover — check if cursor is over an ERC marker
    if (!running && ercErrors.length > 0) {
      const hit = findERCErrorAt(ercErrors, sx, sy, gridToScreen);
      setHoveredERC((prev) => (prev === hit ? prev : hit));
    } else if (hoveredERC !== null) {
      setHoveredERC(null);
    }

    if (panRef.current) {
      setPan({
        x: panRef.current.origin.x + (sx - panRef.current.start.x),
        y: panRef.current.origin.y + (sy - panRef.current.start.y),
      });
      return;
    }

    // rotation drag — compute snap rotation from cursor angle around component center
    if (rotateDragRef.current) {
      const rd = rotateDragRef.current;
      const curAngle = angleFromCenter(rd.center.x, rd.center.y, sx, sy);
      // Determine target rotation by snapping cursor angle to nearest 90°.
      // Screen angle: 0=right, 90=down, 180=left, 270=up.
      // We map: cursor right (0°) => rotation 0; down (90°) => rotation 1; left (180°) => rotation 2; up (270°) => rotation 3.
      // But this mapping is relative to the component's "forward" direction. A simpler
      // approach: compute how many 90° steps the cursor has moved from the start angle,
      // and add to startRotation.
      let deltaDeg = curAngle - rd.startAngle;
      // normalize to -180..180
      while (deltaDeg > 180) deltaDeg -= 360;
      while (deltaDeg < -180) deltaDeg += 360;
      // Snap to nearest 90° step
      const steps = Math.round(deltaDeg / 90);
      let targetRotation = (rd.startRotation + steps) % 4;
      if (targetRotation < 0) targetRotation += 4;
      const comp = components.find((c) => c.id === rd.componentId);
      if (comp && comp.rotation !== targetRotation) {
        // Use rotateComponent repeatedly until we reach the target. Since rotateComponent
        // only increments by 1, we call it the right number of times.
        let diff = (targetRotation - comp.rotation + 4) % 4;
        for (let i = 0; i < diff; i++) {
          rotateComponent(comp.id);
        }
      }
      return;
    }

    // wire segment dragging — free 2D drag in any direction
    if (wireDragRef.current) {
      const wd = wireDragRef.current;
      const wire = wires.find((w) => w.id === wd.wireId);
      if (!wire) return;
      const fromComp = components.find((c) => c.id === wire.from.componentId);
      const toComp = components.find((c) => c.id === wire.to.componentId);
      if (!fromComp || !toComp) return;
      const fromPlugin = getPlugin(fromComp.type);
      const toPlugin = getPlugin(toComp.type);
      if (!fromPlugin || !toPlugin) return;
      const fromT = fromPlugin.terminals.find((t) => t.id === wire.from.terminalId);
      const toT = toPlugin.terminals.find((t) => t.id === wire.to.terminalId);
      if (!fromT || !toT) return;
      const fromPos = getTerminalPos(fromComp, fromT);
      const toPos = getTerminalPos(toComp, toT);
      // Always start from the ORIGINAL waypoints captured at drag start.
      // This gives smooth, predictable behavior: the segment follows the cursor
      // absolutely, and the path is rebuilt fresh each frame from the original.
      const newWaypoints = rerouteWireForDrag(
        { ...fromPos },
        { ...toPos },
        wd.segIndex,
        g,
        wd.originalWaypoints,
      );
      setWireWaypoints(wd.wireId, newWaypoints);
      return;
    }

    if (dragRef.current) {
      if (running) return;
      if (dragRef.current.isGroupDrag) {
        const delta = {
          x: g.x - (dragRef.current.lastGrid?.x ?? g.x),
          y: g.y - (dragRef.current.lastGrid?.y ?? g.y),
        };
        if (delta.x !== 0 || delta.y !== 0) {
          useEditor.getState().moveSelectedComponents(delta);
        }
        dragRef.current.lastGrid = { ...g };
        return;
      }
      const newPos = { x: g.x - dragRef.current.offset.x, y: g.y - dragRef.current.offset.y };
      moveComponent(dragRef.current.componentId, newPos);
      return;
    }

    if (wireDraft) {
      updateWireCursor(g);
    }

    // hover detection: priority: terminal > rotate handle > wire handle > wire > component
    const term = findTerminalAt(g.x, g.y);
    if (term) {
      setHover({ componentId: term.componentId, terminal: term, wireId: null, wireHandle: null, rotateHandle: null });
      return;
    }
    // rotate handle
    if (!running && selection.type === 'component') {
      const comp = components.find((c) => c.id === selection.id);
      if (comp) {
        const handlePos = getRotateHandlePos(comp);
        if (handlePos) {
          const dx = sx - handlePos.x;
          const dy = sy - handlePos.y;
          if (dx * dx + dy * dy < 144) { // 12px radius hit zone
            setHover({ componentId: comp.id, terminal: null, wireId: null, wireHandle: null, rotateHandle: comp.id });
            return;
          }
        }
      }
    }
    // wire handle
    if (!running) {
      const wh = findWireHandle(sx, sy);
      if (wh) {
        setHover({ componentId: null, terminal: null, wireId: wh.wireId, wireHandle: wh, rotateHandle: null });
        return;
      }
    }
    // wire
    const wireId = findWireAt(sx, sy);
    if (wireId) {
      setHover({ componentId: null, terminal: null, wireId, wireHandle: null, rotateHandle: null });
      return;
    }
    // component
    const comp = findComponentAt(g.x, g.y);
    setHover({ componentId: comp?.id ?? null, terminal: null, wireId: null, wireHandle: null, rotateHandle: null });
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      panRef.current = null;
      return;
    }
    if (rotateDragRef.current) {
      // History was already pushed at drag start
      rotateDragRef.current = null;
      setRotateDrag(null);
      return;
    }
    if (wireDragRef.current) {
      // History was already pushed at drag start
      wireDragRef.current = null;
      return;
    }
    if (dragRef.current) {
      // History was already pushed at drag start
      dragRef.current = null;
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(0.4, Math.min(4, zoom * factor));
    // Keep the grid point under the cursor stationary during zoom.
    // Grid point under cursor before zoom: (sx - pan.x) / (CELL_SIZE * zoom)
    // After zoom, we want: sx = gridX * CELL_SIZE * newZoom + newPan.x
    // => newPan.x = sx - gridX * CELL_SIZE * newZoom
    const gridX = (sx - pan.x) / (CELL_SIZE * zoom);
    const gridY = (sy - pan.y) / (CELL_SIZE * zoom);
    const newPanX = sx - gridX * CELL_SIZE * newZoom;
    const newPanY = sy - gridY * CELL_SIZE * newZoom;
    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  const onDrop = (e: React.DragEvent) => {
    if (running) return;
    e.preventDefault();
    const type = e.dataTransfer.getData('application/x-circuit-type');
    if (!type) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const g = screenToGrid(sx, sy);
    addComponent(type, g);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (running) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (running) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const g = screenToGrid(sx, sy);
    const comp = findComponentAt(g.x, g.y);
    if (comp) rotateComponent(comp.id);
  };

  // cursor style based on hover state
  const getCursorStyle = (): string => {
    if (rotateDrag) return 'grabbing';
    if (running) {
      if (hover.componentId) {
        const comp = components.find((c) => c.id === hover.componentId);
        if (comp && TOGGLEABLE_TYPES.has(comp.type)) return 'pointer';
      }
      return 'default';
    }
    if (hover.terminal) return 'crosshair';
    if (hover.rotateHandle) return 'grab';
    if (hover.wireHandle) return 'move';
    if (hover.wireId) return 'pointer';
    if (hover.componentId) return 'move';
    return 'crosshair';
  };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (running) return;
        const s = useEditor.getState();
        if (s.multiSelection.components.size > 0 || s.multiSelection.wires.size > 0) {
          s.deleteSelected();
        } else if (s.selection.type === 'component') {
          deleteComponent(s.selection.id!);
        } else if (s.selection.type === 'wire') {
          s.deleteWire(s.selection.id!);
        }
      } else if (e.key === 'r' || e.key === 'R') {
        if (running) return;
        const s = useEditor.getState().selection;
        if (s.type === 'component') rotateComponent(s.id!);
      } else if (e.key === 'x' || e.key === 'X') {
        // Mirror X (vertical flip)
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        if (s.selection.type === 'component' && s.selection.id) s.mirrorComponent(s.selection.id, 'x');
        else if (s.multiSelection.components.size > 0) s.mirrorSelected('x');
      } else if (e.key === 'y' || e.key === 'Y') {
        // Mirror Y (horizontal flip)
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        if (s.selection.type === 'component' && s.selection.id) s.mirrorComponent(s.selection.id, 'y');
        else if (s.multiSelection.components.size > 0) s.mirrorSelected('y');
      } else if (e.key === 'l' || e.key === 'L') {
        // Lock/unlock component
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        if (s.selection.type === 'component' && s.selection.id) s.toggleLock(s.selection.id);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        // Find / Replace — dispatch a custom event the Toolbar listens for
        if (running) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('circuitlab:open-find-replace'));
      } else if (e.key === 'n' || e.key === 'N') {
        // Add no-connect marker to hovered terminal
        if (running) return;
        e.preventDefault();
        if (hover.terminal) {
          const s = useEditor.getState();
          // toggle: remove if exists, add if not
          const exists = s.noConnects.find((nc) => nc.componentId === hover.terminal!.componentId && nc.terminalId === hover.terminal!.terminalId);
          if (exists) s.removeNoConnect(hover.terminal!.componentId, hover.terminal!.terminalId);
          else s.addNoConnect(hover.terminal!.componentId, hover.terminal!.terminalId);
        }
      } else if (e.key === 'Escape') {
        cancelWire();
        setSelection({ type: null, id: null });
        useEditor.getState().clearMultiSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (running) return;
        e.preventDefault();
        useEditor.getState().undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        if (running) return;
        e.preventDefault();
        useEditor.getState().redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (running) return;
        e.preventDefault();
        useEditor.getState().copySelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (running) return;
        e.preventDefault();
        useEditor.getState().paste();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        if (running) return;
        e.preventDefault();
        useEditor.getState().duplicate();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        s.setMultiSelection({
          components: new Set(s.components.map((c) => c.id)),
          wires: new Set(s.wires.map((w) => w.id)),
        });
      } else if (e.key === ' ') {
        e.preventDefault();
        const s = useEditor.getState();
        s.setRunning(!s.running);
      } else if (e.key === '\\' || e.key === '|') {
        e.preventDefault();
        setUse45Routing((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteComponent, rotateComponent, cancelWire, setSelection, running]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-slate-950"
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: getCursorStyle() }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { dragRef.current = null; panRef.current = null; wireDragRef.current = null; rotateDragRef.current = null; setRotateDrag(null); }}
        onWheel={onWheel}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDoubleClick={onDoubleClick}
      />
      {/* status overlay */}
      <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-slate-900/80 px-2 py-1 text-xs font-mono text-slate-400">
        ({cursor.x.toFixed(1)}, {cursor.y.toFixed(1)})  zoom: {zoom.toFixed(2)}x  {running ? '▶ running' : '⏸ paused'}
        {running && <span className="ml-2 text-amber-300">· click switches to toggle</span>}
        {!running && ercErrors.length > 0 && (
          <span className="ml-2">
            · <span className="text-amber-400">ERC: {ercErrors.filter(e => e.severity === 'error').length} err</span>
            {' / '}
            <span className="text-yellow-400">{ercErrors.filter(e => e.severity === 'warning').length} warn</span>
          </span>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-slate-900/80 px-2 py-1 text-xs font-mono text-slate-400">
        {running ? 'Click switches to toggle • Space to pause' : 'Drag from left • Double-click/R to rotate • Del delete • Space play/pause'}
      </div>
      {/* ERC hover tooltip — appears next to the cursor when hovering an error */}
      {!running && hoveredERC && (
        <div
          className="pointer-events-none absolute z-20 max-w-xs rounded-md border bg-slate-900/95 p-2 text-xs font-mono shadow-xl"
          style={{
            left: Math.min(mousePos.x + 14, size.width - 280),
            top: Math.min(mousePos.y + 14, size.height - 80),
            borderColor: hoveredERC.severity === 'error' ? '#dc2626' : '#f59e0b',
          }}
        >
          <div className="flex items-center gap-1 mb-1">
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                hoveredERC.severity === 'error'
                  ? 'bg-red-600 text-white'
                  : 'bg-amber-500 text-black'
              }`}
            >
              {hoveredERC.severity}
            </span>
            <span className="text-slate-400">{hoveredERC.type.replace(/_/g, ' ')}</span>
          </div>
          <div className="text-slate-100 leading-snug">{hoveredERC.message}</div>
          {hoveredERC.componentId && (
            <button
              className="pointer-events-auto mt-1 text-[10px] text-amber-300 hover:text-amber-200 underline"
              onClick={() => {
                setSelection({ type: 'component', id: hoveredERC.componentId });
                setHoveredERC(null);
              }}
            >
              → select component
            </button>
          )}
        </div>
      )}
      {/* zoom controls */}
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <button
          onClick={() => setZoom((z) => Math.min(4, z * 1.2))}
          className="h-7 w-7 rounded bg-slate-800 text-slate-200 hover:bg-slate-700"
        >+</button>
        <button
          onClick={() => setZoom((z) => Math.max(0.4, z / 1.2))}
          className="h-7 w-7 rounded bg-slate-800 text-slate-200 hover:bg-slate-700"
        >−</button>
        <button
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          className="h-7 w-7 rounded bg-slate-800 text-slate-200 hover:bg-slate-700 text-xs"
        >⌂</button>
      </div>
    </div>
  );
}

/** Distance from point (px, py) to segment (ax,ay)-(bx,by) */
function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
