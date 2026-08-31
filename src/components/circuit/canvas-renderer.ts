// Pure canvas renderer — extracted from CircuitCanvas's render effect so it can
// be driven by a direct requestAnimationFrame loop reading store state via
// getState(), bypassing React reconciliation for the hot path (60Hz sim
// animation, mousemove hover/cursor, pan/zoom drags).
//
// This module must stay React-free: no hooks, no store imports, no getState().
// Everything it needs arrives via the RenderScene object.

import { getPlugin } from '@/lib/circuit/registry';
import { getAllPlugins } from '@/lib/circuit/registry';
import { computeWireCurrents, computeComponentCurrents, buildNodeMap } from '@/lib/circuit/engine';
import { buildWireColorMap } from '@/lib/circuit/net-colors';
import type {
  Vec2,
  CircuitComponent,
  Wire,
  HierarchicalSheet,
  SimContext,
  DrawingPrimitive,
  NoConnectMarker,
  NetClass,
} from '@/lib/circuit/types';
import type { ERCError } from '@/lib/circuit/erc';
import { rotateTerminal } from '@/lib/circuit/components/draw';
import {
  drawERCMarkers,
  drawAutoJunctions,
  drawWireLengthLabel,
} from '@/lib/circuit/schematic-overlays';
import { drawSheetBox } from '@/lib/circuit/sheet-render';
import { CELL_SIZE, type DragState, type WireDragState, type RotateDragState, type HoverState, TOGGLEABLE_TYPES } from './canvas-types';
import { getWirePath, segmentMidpoint, angleFromCenter } from './canvas-wire-utils';

/** Mutable view state owned by the render loop (updated without React). */
export interface CanvasView {
  width: number;
  height: number;
  pan: Vec2;
  zoom: number;
  /** Cursor position in GRID coordinates (crosshair + status readout). */
  cursor: Vec2;
  hover: HoverState;
  hoveredSheetId: string | null;
  hoveredERC: ERCError | null;
  use45Routing: boolean;
}

/** Everything renderScene needs for one frame. */
export interface RenderScene {
  view: CanvasView;
  dpr: number;
  // store slices (snapshot from getState())
  components: CircuitComponent[];
  wires: Wire[];
  sheets: HierarchicalSheet[];
  selection: { type: string | null; id: string | null };
  multiSelection: { components: Set<string>; wires: Set<string> };
  simContext: SimContext | null;
  running: boolean;
  showGrid: boolean;
  wireDraft: { from: { componentId: string; terminalId: string }; cursor: { x: number; y: number } } | null;
  noConnects: NoConnectMarker[];
  drawings: DrawingPrimitive[];
  units: 'mm' | 'mil' | 'in' | 'grid';
  showPinNumbers: boolean;
  showPinNames: boolean;
  showPinElecTypes: boolean;
  netClasses: NetClass[];
  showNetColors: boolean;
  ercErrors: ERCError[];
  placementDraft: { type: string; position: { x: number; y: number }; rotation: number } | null;
  theme: string;
  // interaction drag states (refs at call time)
  drag: DragState | null;
  wireDrag: WireDragState | null;
  rotateDrag: RotateDragState | null;
  panDrag: boolean;
  /** Flow-dot animation phase (seconds-ish scalar advancing in the sim loop). */
  flowPhase: number;
}

/** Immutable empty hover — shared to avoid per-frame allocation. */
export const EMPTY_HOVER: HoverState = {
  componentId: null,
  terminal: null,
  wireId: null,
  wireHandle: null,
  rotateHandle: null,
};

export function createInitialView(): CanvasView {
  return {
    width: 800,
    height: 600,
    pan: { x: 0, y: 0 },
    zoom: 1,
    cursor: { x: 0, y: 0 },
    hover: EMPTY_HOVER,
    hoveredSheetId: null,
    hoveredERC: null,
    use45Routing: false,
  };
}

/** True when two hover states are equivalent (field-by-field). */
export function hoverEquals(a: HoverState, b: HoverState): boolean {
  return (
    a.componentId === b.componentId &&
    a.wireId === b.wireId &&
    a.rotateHandle === b.rotateHandle &&
    a.terminal?.componentId === b.terminal?.componentId &&
    a.terminal?.terminalId === b.terminal?.terminalId &&
    a.wireHandle?.wireId === b.wireHandle?.wireId &&
    a.wireHandle?.segIndex === b.wireHandle?.segIndex
  );
}

/** Compute the CSS cursor for the current hover state (imperative, no React). */
export function computeCursorStyle(
  hover: HoverState,
  running: boolean,
  components: CircuitComponent[],
  rotateDragActive: boolean,
): string {
  if (rotateDragActive) return 'grabbing';
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
}

/** Format the bottom-left status overlay text (imperative DOM update target). */
export function formatStatusText(
  cursor: Vec2,
  zoom: number,
  running: boolean,
): string {
  return `(${cursor.x.toFixed(1)}, ${cursor.y.toFixed(1)})  zoom: ${zoom.toFixed(2)}x  ${running ? '▶ running' : '⏸ paused'}`;
}

/** Pure transform helpers bound to the current view. */
interface ViewTransforms {
  gridToScreen: (gx: number, gy: number) => Vec2;
  getTerminalPos: (comp: CircuitComponent, terminal: { id: string; position: Vec2 }) => Vec2;
  resolveEndpointPos: (endpoint: { componentId: string; terminalId: string }) => Vec2 | null;
  getRotateHandlePos: (comp: CircuitComponent) => Vec2 | null;
}

function makeTransforms(view: CanvasView, components: CircuitComponent[], sheets: HierarchicalSheet[]): ViewTransforms {
  const { pan, zoom } = view;
  const gridToScreen = (gx: number, gy: number): Vec2 => ({
    x: gx * CELL_SIZE * zoom + pan.x,
    y: gy * CELL_SIZE * zoom + pan.y,
  });
  const getTerminalPos = (comp: CircuitComponent, terminal: { id: string; position: Vec2 }): Vec2 => {
    const plugin = getPlugin(comp.type);
    if (!plugin) return { x: 0, y: 0 };
    const rotated = rotateTerminal(terminal as never, comp.rotation, plugin.boundingBox);
    return {
      x: comp.position.x + rotated.position.x,
      y: comp.position.y + rotated.position.y,
    };
  };
  const resolveEndpointPos = (endpoint: { componentId: string; terminalId: string }): Vec2 | null => {
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
  };
  const getRotateHandlePos = (comp: CircuitComponent): Vec2 | null => {
    const plugin = getPlugin(comp.type);
    if (!plugin) return null;
    const bb = plugin.boundingBox;
    const centerGrid = { x: comp.position.x + bb.width / 2, y: comp.position.y + bb.height / 2 };
    const centerScreen = gridToScreen(centerGrid.x, centerGrid.y);
    return {
      x: centerScreen.x,
      y: centerScreen.y - (bb.height / 2 * CELL_SIZE * zoom) - 18,
    };
  };
  return { gridToScreen, getTerminalPos, resolveEndpointPos, getRotateHandlePos };
}

/**
 * Draw one complete frame of the schematic canvas.
 * ctx must be a fresh 2D context (no lingering transform): the function
 * applies the devicePixelRatio scale itself and resets it on exit.
 */
export function renderScene(ctx: CanvasRenderingContext2D, scene: RenderScene): void {
  const { view, dpr } = scene;
  const { width, height, pan, zoom, cursor, hover } = view;
  const {
    components, wires, sheets, selection, multiSelection, simContext, running,
    showGrid, wireDraft, noConnects, drawings, units, showPinNumbers, showPinNames,
    showPinElecTypes, netClasses, showNetColors, ercErrors, placementDraft, theme,
    drag, wireDrag, rotateDrag, panDrag, flowPhase,
  } = scene;

  const plugins = getAllPlugins();
  const { gridToScreen, getTerminalPos, resolveEndpointPos, getRotateHandlePos } =
    makeTransforms(view, components, sheets);
  const use45Routing = view.use45Routing;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // bg — theme-aware (dark default, light when user picks it)
  const isLight = theme === 'light';
  ctx.fillStyle = isLight ? '#f8fafc' : '#0f172a';
  ctx.fillRect(0, 0, width, height);

  // grid
  if (showGrid) {
    ctx.strokeStyle = isLight ? '#cbd5e1' : '#1e293b';
    ctx.lineWidth = 1;
    const stepPx = CELL_SIZE * zoom;
    const startX = pan.x % stepPx;
    const startY = pan.y % stepPx;
    ctx.beginPath();
    for (let x = startX; x < width; x += stepPx) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = startY; y < height; y += stepPx) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
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
  const nodeMap = buildNodeMap(components, wires, pluginsMap);
  // Per-wire color based on net name
  const wireColorMap = showNetColors
    ? buildWireColorMap(wires, components, pluginsMap, nodeMap, netClasses ?? [])
    : new Map<string, string>();
  const nodeToTerminals = new Map<number, Set<string>>();
  const nodeToWires = new Map<number, Set<string>>();
  for (const [termKey, nodeId] of nodeMap.terminalNode) {
    if (!nodeToTerminals.has(nodeId)) nodeToTerminals.set(nodeId, new Set());
    nodeToTerminals.get(nodeId)!.add(termKey);
  }
  for (const wire of wires) {
    const fromKey = `${wire.from.componentId}:${wire.from.terminalId}`;
    const fromNode = nodeMap.terminalNode.get(fromKey) ?? -1;
    const nodeId = fromNode;
    if (!nodeToWires.has(nodeId)) nodeToWires.set(nodeId, new Set());
    nodeToWires.get(nodeId)!.add(wire.id);
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
    const fromGrid = resolveEndpointPos(wire.from);
    const toGrid = resolveEndpointPos(wire.to);
    if (!fromGrid || !toGrid) continue;
    const fromPos = gridToScreen(fromGrid.x, fromGrid.y);
    const toPos = gridToScreen(toGrid.x, toGrid.y);
    const path = getWirePath(wire, fromPos, toPos, gridToScreen, use45Routing);
    const isSelected = selection.type === 'wire' && selection.id === wire.id;
    const isHover = hover.wireId === wire.id;
    const isOnActiveNode = activeWires.has(wire.id);

    const netColor = wireColorMap.get(wire.id) ?? '#94a3b8';
    ctx.strokeStyle = isSelected ? '#fbbf24' : (isHover ? '#fde047' : (isOnActiveNode ? '#cbd5e1' : netColor));
    ctx.lineWidth = isSelected ? 3.5 : (isHover ? 3 : (isOnActiveNode ? 2.5 : 2));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();

    // Virtual-keyboard focus ring for wires (a11y)
    if (isSelected) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      const xs = path.map((p: { x: number; y: number }) => p.x);
      const ys = path.map((p: { x: number; y: number }) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      ctx.strokeRect(minX - 6, minY - 6, (maxX - minX) + 12, (maxY - minY) + 12);
      ctx.restore();
    }

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
    if (isAnimating) {
      const current = wireCurrents.get(wire.id) ?? 0;
      const absCurrent = Math.abs(current);
      if (absCurrent > 1e-12) {
        const dir = current >= 0 ? 1 : -1;
        // Physics-based flow speed (log scale):
        //   1µA → 0.15, 1mA → 0.4, 10mA → 0.6, 100mA → 0.8, 1A → 1.0
        const speed = Math.min(1.2, Math.max(0.1, 0.15 + 0.25 * Math.log10(absCurrent / 1e-6 + 1)));
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
          const evenSpacing = totalLen / numDots;
          const PIXELS_PER_PHASE = 60;
          const rawOffset = flowPhase * speed * dir * PIXELS_PER_PHASE;
          const dotOffset = ((rawOffset % totalLen) + totalLen) % totalLen;
          ctx.fillStyle = '#fde047';
          ctx.shadowColor = '#fde047';
          ctx.shadowBlur = 6;
          for (let n = 0; n < numDots; n++) {
            let distAlong = (n * evenSpacing + dotOffset);
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
    const bbCx = plugin.boundingBox.width / 2;
    const bbCy = plugin.boundingBox.height / 2;
    ctx.translate(bbCx * CELL_SIZE, bbCy * CELL_SIZE);
    // Free rotation (rotationDeg) takes precedence over the 90°-step rotation field
    const rotationRad = comp.rotationDeg != null
      ? (comp.rotationDeg * Math.PI) / 180
      : (comp.rotation * Math.PI) / 2;
    ctx.rotate(rotationRad);
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
    // Virtual-keyboard focus ring (a11y)
    if (isSelected) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(-6, -6, plugin.boundingBox.width * CELL_SIZE + 12, plugin.boundingBox.height * CELL_SIZE + 12);
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
      else if (isOnActiveNode) { color = '#fde047'; radius = 5; glow = 6; }
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

    // draw animated current flow dots THROUGH the component body.
    // getFlowPaths (plural) renders multiple independent sub-paths — used by
    // components where current does not flow straight through (a capacitor:
    // dots INTO the + plate / OUT of the − plate, never across the dielectric).
    if (isAnimating && (plugin.getFlowPaths || plugin.getFlowPath)) {
      const current = componentCurrents.get(comp.id) ?? 0;
      const absCurrent = Math.abs(current);
      if (absCurrent > 1e-12) {
        const dir = current >= 0 ? 1 : -1;
        const speed = Math.min(1.2, Math.max(0.1, 0.15 + 0.25 * Math.log10(absCurrent / 1e-6 + 1)));
        const flowGridPaths: Vec2[][] = plugin.getFlowPaths
          ? plugin.getFlowPaths(comp.parameters, simContext ?? undefined, comp)
          : [plugin.getFlowPath!(comp.parameters, simContext ?? undefined, comp)];
        for (const flowGridPath of flowGridPaths) {
          if (!flowGridPath || flowGridPath.length < 2) continue;
          const flowScreenPath: Vec2[] = flowGridPath.map((gp) => {
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
            const phase = flowPhase * speed * dir;
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
        const isHandleHot = hover.rotateHandle === comp.id || rotateDrag?.componentId === comp.id;
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(centerScreen.x, centerScreen.y - (bb.height / 2 * CELL_SIZE * zoom) - 2);
        ctx.lineTo(handlePos.x, handlePos.y + 9);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(handlePos.x, handlePos.y, isHandleHot ? 10 : 9, 0, Math.PI * 2);
        ctx.fillStyle = isHandleHot ? '#fbbf24' : '#1e293b';
        ctx.fill();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.strokeStyle = isHandleHot ? '#0f172a' : '#fbbf24';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(handlePos.x, handlePos.y, 4, -Math.PI * 0.2, Math.PI * 1.1);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(handlePos.x + 4.5, handlePos.y - 1);
        ctx.lineTo(handlePos.x + 2.8, handlePos.y - 4.5);
        ctx.lineTo(handlePos.x + 5.5, handlePos.y - 4.5);
        ctx.closePath();
        ctx.fillStyle = isHandleHot ? '#0f172a' : '#fbbf24';
        ctx.fill();

        // While dragging rotation, show a visual indicator of the target snap angle
        if (rotateDrag?.componentId === comp.id) {
          const cursorScreen = gridToScreen(cursor.x, cursor.y);
          const curAngle = angleFromCenter(centerScreen.x, centerScreen.y, cursorScreen.x, cursorScreen.y);
          let snapRot: 0 | 1 | 2 | 3 = 0;
          const normalized = (curAngle + 45) % 360;
          if (normalized < 90) snapRot = 0;
          else if (normalized < 180) snapRot = 1;
          else if (normalized < 270) snapRot = 2;
          else snapRot = 3;
          void snapRot;
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.5)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(centerScreen.x, centerScreen.y);
          ctx.lineTo(cursorScreen.x, cursorScreen.y);
          ctx.stroke();
          ctx.setLineDash([]);
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

  // ---- Keyboard-placement ghost (a11y) ----
  if (placementDraft) {
    const ghostPlugin = getPlugin(placementDraft.type);
    if (ghostPlugin) {
      const gOrigin = gridToScreen(placementDraft.position.x, placementDraft.position.y);
      ctx.save();
      ctx.translate(gOrigin.x, gOrigin.y);
      ctx.scale(zoom, zoom);
      const gCx = ghostPlugin.boundingBox.width / 2;
      const gCy = ghostPlugin.boundingBox.height / 2;
      ctx.translate(gCx * CELL_SIZE, gCy * CELL_SIZE);
      ctx.rotate((placementDraft.rotation * Math.PI) / 2);
      ctx.translate(-gCx * CELL_SIZE, -gCy * CELL_SIZE);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-2, -2, ghostPlugin.boundingBox.width * CELL_SIZE + 4, ghostPlugin.boundingBox.height * CELL_SIZE + 4);
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.5;
      const ghostParams: Record<string, unknown> = {};
      for (const p of ghostPlugin.parameters) ghostParams[p.key] = p.default;
      try {
        ghostPlugin.render(ctx, ghostParams as Record<string, never>, CELL_SIZE, undefined, undefined);
      } catch { /* ghost render is best-effort */ }
      ctx.globalAlpha = 1;
      ctx.restore();
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
          const img = (globalThis as Record<string, unknown>).__circuitlab_images?.[d.id];
          if (img) {
            ctx.drawImage(img as CanvasImageSource, p.x, p.y, d.size.width * CELL_SIZE * zoom, d.size.height * CELL_SIZE * zoom);
          } else {
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
  if (!drag && !panDrag && !wireDrag && !rotateDrag) {
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
  let wireLengthScreenPath: Vec2[] | null = null;
  let wireLengthGridPath: Vec2[] | null = null;
  for (const wire of wires) {
    const fromGrid = resolveEndpointPos(wire.from);
    const toGrid = resolveEndpointPos(wire.to);
    if (!fromGrid || !toGrid) continue;
    const fromPos = gridToScreen(fromGrid.x, fromGrid.y);
    const toPos = gridToScreen(toGrid.x, toGrid.y);
    const path = getWirePath(wire, fromPos, toPos, gridToScreen, use45Routing);
    const isSelected = selection.type === 'wire' && selection.id === wire.id;
    const isHover = hover.wireId === wire.id;
    const isOnActiveNode = activeWires.has(wire.id);

    if (isSelected || isHover) {
      wireLengthScreenPath = path;
      wireLengthGridPath = [fromGrid, ...(wire.waypoints ?? []), toGrid];
    }

    if (isSelected || isHover || isOnActiveNode) {
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
  drawAutoJunctions(ctx, components, wires, gridToScreen, hover.terminal);

  // ---- Wire length label for selected or hovered wire ----
  if (wireLengthScreenPath && wireLengthGridPath) {
    drawWireLengthLabel(ctx, wireLengthScreenPath, wireLengthGridPath, units);
  }

  // ---- Hierarchical sheet boxes ----
  if (!running) {
    for (const sheet of sheets) {
      const isSelected = selection.type === 'sheet' && selection.id === sheet.id;
      const isHover = view.hoveredSheetId === sheet.id;
      drawSheetBox(ctx, sheet, gridToScreen, {
        isSelected,
        isHover,
        zoom,
      });
    }
  }

  // ---- ERC error markers (drawn last so they're on top of everything) ----
  if (!running && ercErrors.length > 0) {
    drawERCMarkers(ercErrors, ctx, gridToScreen, view.hoveredERC);
  }

  // Reset transform so external code sees a pristine context.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
