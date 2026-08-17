'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin, getAllPlugins } from '@/lib/circuit/registry';
import { computeWireCurrents, computeComponentCurrents } from '@/lib/circuit/engine';
import { buildNodeMap } from '@/lib/circuit/engine';
import { buildWireColorMap } from '@/lib/circuit/net-colors';
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
import {
  drawSheetBox,
  findSheetAt,
  findSheetPinAt,
  getSheetPinAbsPos,
} from '@/lib/circuit/sheet-render';
import type { HierarchicalSheet } from '@/lib/circuit/types';
// Extracted modules
import {
  CELL_SIZE,
  DragState,
  WireDragState,
  RotateDragState,
  HoverState,
  TOGGLEABLE_TYPES,
} from './canvas-types';
import {
  getWirePath,
  segmentMidpoint,
  angleFromCenter,
  rerouteWireForDrag,
} from './canvas-wire-utils';
import { useCanvasKeyboard } from './use-canvas-keyboard';
import { useSimulationLoop } from './use-simulation-loop';
import { useCanvasCoordinates } from './use-canvas-coordinates';

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
  // animation phase is now provided by useSimulationLoop hook
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
  const netClasses = useEditor((s) => s.netClasses);
  const showNetColors = useEditor((s) => s.showNetColors ?? true);

  // Live ERC — auto-runs on every change, debounced. Disabled while simulating
  // so it doesn't fight the simulation loop for CPU.
  useAutoERC(!running);
  const ercErrors = useEditor((s) => s.ercErrors);
  const [hoveredERC, setHoveredERC] = useState<ERCError | null>(null);
  const [mousePos, setMousePos] = useState<Vec2>({ x: 0, y: 0 });

  // Hierarchical sheet state — sheet box rendering, dragging, double-click-to-enter
  const sheets = useEditor((s) => s.sheets);
  const activeSheet = useEditor((s) => s.activeSheet);
  const moveSheet = useEditor((s) => s.moveSheet);
  const setActiveSheet = useEditor((s) => s.setActiveSheet);
  const [hoveredSheetId, setHoveredSheetId] = useState<string | null>(null);
  const [sheetDrag, setSheetDrag] = useState<{ id: string; offset: Vec2 } | null>(null);
  const sheetDragRef = useRef<{ id: string; offset: Vec2 } | null>(null);
  useEffect(() => { sheetDragRef.current = sheetDrag; }, [sheetDrag]);

  // Cross-probing: push schematic selection to PCB store so the PCB canvas
  // can highlight the matching footprints. Also includes multi-selection.
  useEffect(() => {
    const ids: string[] = [];
    if (selection.type === 'component' && selection.id) ids.push(selection.id);
    for (const id of multiSelection.components) ids.push(id);
    // Lazy import to avoid circular dep at module load time
    import('@/lib/pcb/store').then(({ usePCB }) => {
      usePCB.getState().setCrossProbe(ids);
    });
  }, [selection, multiSelection]);

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

  // Use extracted simulation loop hook
  const { flowPhaseRef } = useSimulationLoop(running, step);

  // Use extracted coordinate/hit-testing hook
  const {
    screenToGrid,
    gridToScreen,
    getTerminalPos,
    resolveEndpointPos,
    findTerminalAt,
    findComponentAt,
    findWireAt,
    findWireHandle,
    getRotateHandlePos,
  } = useCanvasCoordinates({
    pan, zoom, snapToGrid, components, wires, sheets, selection, use45Routing,
  });

  void getTerminalPos; // used in render effect
  void resolveEndpointPos;

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
    // bg — theme-aware (dark default, light when user picks it)
    const isLight = useEditor.getState().theme === 'light';
    ctx.fillStyle = isLight ? '#f8fafc' : '#0f172a';
    ctx.fillRect(0, 0, size.width, size.height);

    // grid
    if (showGrid) {
      ctx.strokeStyle = isLight ? '#cbd5e1' : '#1e293b';
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
    // Per-wire color based on net name (ground=gray, power=red, signal=cyan,
    // overridden by any user-defined NetClass.color)
    const wireColorMap = showNetColors
      ? buildWireColorMap(wires, components, pluginsMapForNodes, nodeMap, netClasses ?? [])
      : new Map<string, string>();
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
      // Resolve both endpoints to grid positions — handles both real components
      // and sheet pins (componentId starts with __sheet:).
      const fromGrid = resolveEndpointPos(wire.from);
      const toGrid = resolveEndpointPos(wire.to);
      if (!fromGrid || !toGrid) continue;
      const fromPos = gridToScreen(fromGrid.x, fromGrid.y);
      const toPos = gridToScreen(toGrid.x, toGrid.y);
      const path = getWirePath(wire, fromPos, toPos, gridToScreen, use45Routing);
      const isSelected = selection.type === 'wire' && selection.id === wire.id;
      const isHover = hover.wireId === wire.id;
      const isOnActiveNode = activeWires.has(wire.id);

      // wire — highlight all wires on the same electrical node.
      // When showNetColors is enabled, the base color is the net's color
      // (ground=gray, power=red, signal=cyan, or a user-defined NetClass color).
      // Selected/hovered wires still use the amber highlight to stand out.
      const netColor = wireColorMap.get(wire.id) ?? '#94a3b8';
      ctx.strokeStyle = isSelected ? '#fbbf24' : (isHover ? '#fde047' : (isOnActiveNode ? '#cbd5e1' : netColor));
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
        if (absCurrent > 1e-12) {  // 1pA threshold — shows flow even in high-impedance circuits
          const dir = current >= 0 ? 1 : -1;
          // Physics-based flow speed:
          // The drift velocity of charge carriers is proportional to current.
          // We normalize to a visual range: 1µA = slowest visible, 1A = fastest.
          // Use a log scale that maps:
          //   1µA (1e-6) → 0.15 (slow crawl)
          //   1mA (1e-3) → 0.4  (moderate)
          //   10mA (1e-2) → 0.6  (normal)
          //   100mA (1e-1) → 0.8  (fast)
          //   1A (1e0) → 1.0     (very fast)
          // Formula: speed = clamp(0.15 + 0.25 * log10(I / 1e-6), 0.1, 1.2)
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
            // Evenly distribute dots around the wire: spacing = totalLen / numDots
            // This ensures the gap between the last dot and the first (wrapping)
            // is the same as all other gaps.
            const evenSpacing = totalLen / numDots;
            const PIXELS_PER_PHASE = 60;
            const rawOffset = flowPhaseRef.current * speed * dir * PIXELS_PER_PHASE;
            const dotOffset = ((rawOffset % totalLen) + totalLen) % totalLen;
            ctx.fillStyle = '#fde047';
            ctx.shadowColor = '#fde047';
            ctx.shadowBlur = 6;
            for (let n = 0; n < numDots; n++) {
              let distAlong = (n * evenSpacing + dotOffset);
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
        if (absCurrent > 1e-12) {  // 1pA threshold — shows flow even in high-impedance circuits
          const dir = current >= 0 ? 1 : -1;
          // Physics-based flow speed (same formula as wire dots):
          //   1µA → 0.15, 1mA → 0.4, 10mA → 0.6, 100mA → 0.8, 1A → 1.0
          const speed = Math.min(1.2, Math.max(0.1, 0.15 + 0.25 * Math.log10(absCurrent / 1e-6 + 1)));
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
      // Resolve both endpoints — handles both real components and sheet pins
      const fromGrid = resolveEndpointPos(wire.from);
      const toGrid = resolveEndpointPos(wire.to);
      if (!fromGrid || !toGrid) continue;
      const fromPos = gridToScreen(fromGrid.x, fromGrid.y);
      const toPos = gridToScreen(toGrid.x, toGrid.y);
      const path = getWirePath(wire, fromPos, toPos, gridToScreen, use45Routing);
      const isSelected = selection.type === 'wire' && selection.id === wire.id;
      const isHover = hover.wireId === wire.id;
      const isOnActiveNode = activeWires.has(wire.id);

      // Capture path for length label (selected/hovered wires only)
      if (isSelected || isHover) {
        wireLengthScreenPath = path;
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

    // ---- Hierarchical sheet boxes (drawn before ERC markers so markers stay on top) ----
    // Only draw sheets when not running a simulation — they're a structural view.
    if (!running) {
      for (const sheet of sheets) {
        const isSelected = selection.type === 'sheet' && selection.id === sheet.id;
        const isHover = hoveredSheetId === sheet.id;
        drawSheetBox(ctx, sheet, gridToScreen, {
          isSelected,
          isHover,
          zoom,
        });
      }
    }

    // ---- ERC error markers (drawn last so they're on top of everything) ----
    // Hidden during simulation to avoid visual clutter while current is flowing.
    if (!running && ercErrors.length > 0) {
      drawERCMarkers(ercErrors, ctx, gridToScreen, hoveredERC);
    }

    ctx.restore();
  }, [size, pan, zoom, components, wires, selection, multiSelection, hover, cursor, simContext, showGrid, wireDraft, use45Routing, running, gridToScreen, getTerminalPos, plugins, getRotateHandlePos, ercErrors, hoveredERC, units, sheets, hoveredSheetId, resolveEndpointPos, netClasses, showNetColors]);

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

    // Hierarchical sheet interaction (only when not running)
    const isRunningNow = useEditor.getState().running;
    if (!isRunningNow && sheets.length > 0) {
      // Check sheet pin first — start a wire from the sheet pin (just like a terminal)
      const pinHit = findSheetPinAt(sheets, sx, sy, gridToScreen);
      if (pinHit) {
        // Treat the sheet pin as a wire endpoint — use the same startWire() API
        // but with a synthetic componentId/terminalId that the engine can resolve.
        const endpoint = {
          componentId: `__sheet:${pinHit.sheet.id}`,
          terminalId: `pin:${pinHit.pin.id}`,
        };
        // If we're already mid-wire-draft, complete the wire to this pin
        const wd = useEditor.getState().wireDraft;
        if (wd) {
          completeWire(endpoint);
        } else {
          startWire(endpoint, g);
        }
        return;
      }
      // Check sheet box body — start a sheet drag
      const sheetHit = findSheetAt(sheets, sx, sy, gridToScreen);
      if (sheetHit) {
        setSelection({ type: 'sheet', id: sheetHit.id });
        const offset = {
          x: g.x - sheetHit.position.x,
          y: g.y - sheetHit.position.y,
        };
        const drag = { id: sheetHit.id, offset };
        sheetDragRef.current = drag;
        setSheetDrag(drag);
        return;
      }
    }

    // If simulation is running, check for toggleable components FIRST
    // Use getState() for the latest running state
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

    // Hierarchical sheet hover detection
    if (!running && sheets.length > 0) {
      const hit = findSheetAt(sheets, sx, sy, gridToScreen);
      setHoveredSheetId((prev) => (prev === hit?.id ? prev : hit?.id ?? null));
    }

    // Sheet drag — if we're dragging a sheet box, move it
    if (sheetDragRef.current) {
      const sd = sheetDragRef.current;
      const newPos = {
        x: Math.round(g.x - sd.offset.x),
        y: Math.round(g.y - sd.offset.y),
      };
      moveSheet(sd.id, newPos);
      return;
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
    // End sheet drag
    if (sheetDragRef.current) {
      sheetDragRef.current = null;
      setSheetDrag(null);
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
    // Sheet double-click → enter the sub-sheet (KiCad parity)
    const sheetHit = findSheetAt(sheets, sx, sy, gridToScreen);
    if (sheetHit) {
      setActiveSheet(sheetHit.fileName);
      return;
    }
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

  // Use extracted keyboard hook
  useCanvasKeyboard({
    running,
    hover,
    cancelWire,
    setSelection,
    deleteComponent,
    rotateComponent,
    setActiveSheet,
    setUse45Routing,
  });

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-slate-950"
      role="application"
      aria-label="Circuit schematic editor — use mouse to place and connect components"
      tabIndex={0}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: getCursorStyle() }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { dragRef.current = null; panRef.current = null; wireDragRef.current = null; rotateDragRef.current = null; setRotateDrag(null); sheetDragRef.current = null; setSheetDrag(null); setHoveredSheetId(null); }}
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
      {/* Empty-state card — shown when canvas has no components */}
      {components.length === 0 && !running && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/90 p-8 text-center">
            <Zap size={32} className="text-cyan-400" />
            <h3 className="text-lg font-semibold text-slate-100">Welcome to CircuitLab</h3>
            <p className="max-w-xs text-sm text-slate-400">
              Drag components from the left palette, or load an example circuit to get started.
            </p>
            <div className="flex gap-2">
              <button
                className="cursor-pointer rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-cyan-400"
                onClick={() => {
                  const { exampleCategories } = require('@/lib/circuit/examples');
                  if (exampleCategories.length > 0 && exampleCategories[0].examples.length > 0) {
                    useEditor.getState().loadDocument(exampleCategories[0].examples[0].doc);
                  }
                }}
              >
                Load Example
              </button>
              <button
                className="cursor-pointer rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
                onClick={() => {
                  useEditor.getState().addComponent('resistor', { x: 15, y: 10 });
                }}
              >
                Add Resistor
              </button>
            </div>
          </div>
        </div>
      )}
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
          className="h-7 w-7 cursor-pointer rounded bg-slate-800 text-slate-200 hover:bg-slate-700"
        >+</button>
        <button
          onClick={() => setZoom((z) => Math.max(0.4, z / 1.2))}
          className="h-7 w-7 cursor-pointer rounded bg-slate-800 text-slate-200 hover:bg-slate-700"
        >−</button>
        <button
          onClick={() => {
            // Zoom to fit: compute bounding box of all components + wires
            const plugins = new Map<string, any>();
            const { getAllPlugins } = require('@/lib/circuit/registry');
            for (const p of getAllPlugins()) plugins.set(p.type, p);
            if (components.length === 0) { setZoom(1); setPan({ x: 0, y: 0 }); return; }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const c of components) {
              const plugin = plugins.get(c.type);
              if (!plugin) continue;
              const bb = plugin.boundingBox;
              minX = Math.min(minX, c.position.x);
              minY = Math.min(minY, c.position.y);
              maxX = Math.max(maxX, c.position.x + bb.width);
              maxY = Math.max(maxY, c.position.y + bb.height);
            }
            if (minX === Infinity) { setZoom(1); setPan({ x: 0, y: 0 }); return; }
            const w = maxX - minX, h = maxY - minY;
            const canvasW = size.width || 800, canvasH = size.height || 600;
            const scaleX = canvasW / (w * 40 + 100); // 40px per grid unit + margin
            const scaleY = canvasH / (h * 40 + 100);
            const newZoom = Math.min(4, Math.max(0.4, Math.min(scaleX, scaleY)));
            setZoom(newZoom);
            setPan({ x: -minX * 40 * newZoom + 50, y: -minY * 40 * newZoom + 50 });
          }}
          className="h-7 w-7 cursor-pointer rounded bg-slate-800 text-slate-200 hover:bg-slate-700 text-xs"
          title="Zoom to fit (Z)"
        >⊞</button>
        <button
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          className="h-7 w-7 cursor-pointer rounded bg-slate-800 text-slate-200 hover:bg-slate-700 text-xs"
        >⌂</button>
      </div>
    </div>
  );
}
