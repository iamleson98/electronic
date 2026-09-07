'use client';

// CircuitCanvas — schematic editor canvas.
//
// RENDERING ARCHITECTURE (see use-canvas-renderer.ts):
//   The canvas is drawn by a direct requestAnimationFrame loop that reads
//   store state via useEditor.getState() + a mutable viewRef. React state is
//   NOT used for hot paths (cursor, hover, pan, zoom, per-frame animation):
//   those mutate viewRef and mark the scene dirty. CircuitCanvas re-renders
//   only when JSX-relevant data changes (topology edits, running flag, ERC
//   list, placement draft, ERC tooltip visibility).

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin } from '@/lib/circuit/registry';
import { findERCErrorAt } from '@/lib/circuit/schematic-overlays';
import type { ERCError } from '@/lib/circuit/erc';
import { useAutoERC } from '@/lib/auto-rule-hooks';
import {
  findSheetAt,
  findSheetPinAt,
} from '@/lib/circuit/sheet-render';
import type { Vec2 } from '@/lib/circuit/types';
// Extracted modules
import { CELL_SIZE, DragState, WireDragState, RotateDragState, TOGGLEABLE_TYPES } from './canvas-types';
import type { HoverState } from './canvas-types';
import { EMPTY_HOVER, hoverEquals } from './canvas-renderer';
import { angleFromCenter, rerouteWireForDrag } from './canvas-wire-utils';
import { useCanvasRenderer } from './use-canvas-renderer';
import { useCanvasKeyboard } from './use-canvas-keyboard';
import { useSimulationLoop } from './use-simulation-loop';
import { useCanvasCoordinates } from './use-canvas-coordinates';

export function CircuitCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);

  // Interaction drag states — refs only (no React re-render while dragging).
  const dragRef = useRef<DragState | null>(null);
  const wireDragRef = useRef<WireDragState | null>(null);
  const panRef = useRef<{ start: Vec2; origin: Vec2 } | null>(null);
  const rotateDragRef = useRef<RotateDragState | null>(null);
  const sheetDragRef = useRef<{ id: string; offset: Vec2 } | null>(null);
  // Hover state — mirrored ref kept in sync with viewRef.current.hover so
  // the keyboard hook (and any closure) always sees the live object.
  const hoverRef = useRef<HoverState>(EMPTY_HOVER);

  // Rare-path React state: the ERC hover tooltip (visible only while the
  // cursor is over an error marker) + its anchor position.
  const [hoveredERC, setHoveredERC] = useState<ERCError | null>(null);
  const [tooltipMousePos, setTooltipMousePos] = useState<Vec2>({ x: 0, y: 0 });

  // Store slices that JSX or event handlers need *fresh in closures*.
  // NOTE: deliberately minimal — every subscription here is a re-render
  // trigger. Hot data (simContext, showGrid, pin toggles, netClasses, ...)
  // is read via getState() by the render loop instead.
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const sheets = useEditor((s) => s.sheets);
  const selection = useEditor((s) => s.selection);
  const multiSelection = useEditor((s) => s.multiSelection);
  const running = useEditor((s) => s.running);
  const snapToGrid = useEditor((s) => s.snapToGrid);
  const ercErrors = useEditor((s) => s.ercErrors);
  const placementDraftActive = useEditor((s) => s.placementDraft);

  // Live ERC — auto-runs on every change, debounced. Disabled while simulating
  // so it doesn't fight the simulation loop for CPU.
  useAutoERC(!running);

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
  const addWireWaypoint = useEditor((s) => s.addWireWaypoint);
  const completeWire = useEditor((s) => s.completeWire);
  const cancelWire = useEditor((s) => s.cancelWire);
  const setWireWaypoints = useEditor((s) => s.setWireWaypoints);
  const toggleSwitch = useEditor((s) => s.toggleSwitch);
  const step = useEditor((s) => s.step);
  const moveSheet = useEditor((s) => s.moveSheet);
  const setActiveSheet = useEditor((s) => s.setActiveSheet);

  // Simulation loop: advances the engine + flow phase (no React re-renders).
  const { flowPhaseRef } = useSimulationLoop(running, step);

  // The render loop: owns viewRef (pan/zoom/cursor/hover) + RAF drawing.
  const { viewRef, markDirty } = useCanvasRenderer({
    canvasRef,
    containerRef,
    statusRef,
    dragRef,
    wireDragRef,
    rotateDragRef,
    panRef,
    flowPhaseRef,
  });

  // Coordinate/hit-testing helpers (stable; read pan/zoom from viewRef).
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
    viewRef, snapToGrid, components, wires, sheets, selection,
  });

  void resolveEndpointPos; // available for future handlers
  void gridToScreen;

  // Imperative hover setter — updates the view + requests a redraw. No React.
  const setHover = (next: HoverState) => {
    if (hoverEquals(hoverRef.current, next)) return;
    hoverRef.current = next;
    viewRef.current.hover = next;
    markDirty();
  };
  const resetHover = () => {
    if (hoverEquals(hoverRef.current, EMPTY_HOVER)) return;
    hoverRef.current = EMPTY_HOVER;
    viewRef.current.hover = EMPTY_HOVER;
    markDirty();
  };

  // 45° routing toggle — lives in the view (renderer reads it each frame).
  const setUse45Routing = (fn: (v: boolean) => boolean) => {
    const view = viewRef.current;
    view.use45Routing = fn(view.use45Routing);
    markDirty();
  };

  // ----- Mouse handlers -----
  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const g = screenToGrid(sx, sy);

    // middle or right button: pan
    if (e.button === 1 || e.button === 2) {
      panRef.current = { start: { x: sx, y: sy }, origin: { ...viewRef.current.pan } };
      return;
    }

    // ── Embed mode (read-only interactive /embed route) ───────────────────
    // Editing is blocked, but the embed stays INTERACTIVE: switches/buttons
    // toggle while running (viewers can play with the circuit) and left-drag
    // pans the view. Zoom stays on the wheel handler.
    if (useEditor.getState().embedMode) {
      const isRunningNow = useEditor.getState().running;
      if (isRunningNow && e.button === 0) {
        const comp = findComponentAt(g.x, g.y);
        if (comp && TOGGLEABLE_TYPES.has(comp.type)) {
          toggleSwitch(comp.id);
          return;
        }
        if (comp) {
          setSelection({ type: 'component', id: comp.id });
          return;
        }
      }
      panRef.current = { start: { x: sx, y: sy }, origin: { ...viewRef.current.pan } };
      return;
    }

    // Placement mode (keyboard placement / palette click): a canvas click
    // moves the draft to the clicked grid cell and confirms it there.
    const draftNow = useEditor.getState().placementDraft;
    if (draftNow) {
      const snapOn = useEditor.getState().snapToGrid;
      const target = snapOn ? { x: Math.round(g.x), y: Math.round(g.y) } : g;
      useEditor.getState().nudgePlacement(target.x - draftNow.position.x, target.y - draftNow.position.y);
      useEditor.getState().confirmPlacement(false);
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
      // Check sheet box body — start a sheet drag (but while a wire draft is
      // active, a click on the box places a bend like anywhere else)
      const sheetHit = findSheetAt(sheets, sx, sy, gridToScreen);
      if (sheetHit) {
        if (useEditor.getState().wireDraft) {
          addWireWaypoint(g);
          return;
        }
        setSelection({ type: 'sheet', id: sheetHit.id });
        const offset = {
          x: g.x - sheetHit.position.x,
          y: g.y - sheetHit.position.y,
        };
        sheetDragRef.current = { id: sheetHit.id, offset };
        // One history entry per drag (moveSheet itself doesn't push — it
        // fires on every mousemove)
        useEditor.getState().pushHistory();
        return;
      }
    }

    // If simulation is running, check for toggleable components FIRST
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

    // ── Wire draft in progress: click a pin to finish, click anywhere else
    // to place a bend (KiCad-style click-by-click routing). Terminal snapping
    // is excluded from the wire's own source pin so an accidental click near
    // the start doesn't self-complete; Alt bypasses the pin magnet entirely.
    const wd = useEditor.getState().wireDraft;
    if (wd) {
      const term = findTerminalAt(g.x, g.y, { exclude: wd.from, bypass: e.altKey });
      if (term) {
        completeWire({ componentId: term.componentId, terminalId: term.terminalId });
      } else {
        addWireWaypoint(g);
      }
      return;
    }

    // check rotation handle on selected component — start a rotate drag
    // (14px hit zone — the SAME radius the hover pass uses, so what you
    // hover is what you grab)
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
            if (distSq < 196) { // 14px radius — matches hover
              const bb = plugin.boundingBox;
              const centerGrid = { x: comp.position.x + bb.width / 2, y: comp.position.y + bb.height / 2 };
              const centerScreen = gridToScreen(centerGrid.x, centerGrid.y);
              rotateDragRef.current = {
                componentId: comp.id,
                center: centerScreen,
                startAngle: angleFromCenter(centerScreen.x, centerScreen.y, sx, sy),
                startRotation: comp.rotation,
              };
              markDirty();
              return;
            }
          }
        }
      }
    }

    // check wire segment handle (for dragging)
    const hover = viewRef.current.hover;
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
              // One history entry per drag (setWireWaypoints itself doesn't
              // push — it fires on every mousemove)
              useEditor.getState().pushHistory();
              return;
            }
          }
        }
      }
    }

    // check terminal — start a wire (Alt bypasses the pin magnet)
    const term = findTerminalAt(g.x, g.y, { bypass: e.altKey });
    if (term) {
      startWire({ componentId: term.componentId, terminalId: term.terminalId }, g);
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

    // empty space: clear selection (a wire draft, if any, stays alive —
    // empty clicks place bends; Escape cancels)
    setSelection({ type: null, id: null });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const g = screenToGrid(sx, sy);
    const view = viewRef.current;

    // Alt temporarily bypasses the terminal snap magnet (precision routing).
    view.snapBypass = e.altKey;

    // Cursor crosshair + status readout — ref only, no React re-render.
    view.cursor = g;
    markDirty();

    // ERC tooltip anchor (React state, only while a tooltip is visible).
    if (hoveredERC !== null) setTooltipMousePos({ x: sx, y: sy });

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
      const id = hit?.id ?? null;
      if (view.hoveredSheetId !== id) {
        view.hoveredSheetId = id;
        markDirty();
      }
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
      view.pan = {
        x: panRef.current.origin.x + (sx - panRef.current.start.x),
        y: panRef.current.origin.y + (sy - panRef.current.start.y),
      };
      markDirty();
      return;
    }

    // rotation drag — compute snap rotation from cursor angle around component center
    if (rotateDragRef.current) {
      const rd = rotateDragRef.current;
      const curAngle = angleFromCenter(rd.center.x, rd.center.y, sx, sy);
      // Determine target rotation by snapping cursor angle to nearest 90°.
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
        const diff = (targetRotation - comp.rotation + 4) % 4;
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

    if (useEditor.getState().wireDraft) {
      updateWireCursor(g);
    }

    // hover detection — the ladder matches the mousedown ladder exactly
    // (rotate 14px > wire handle 6px > terminal > wire > component) so what
    // you hover is always what a click will grab. While a wire draft is
    // active, only the snap target terminal is highlighted.
    const wd = useEditor.getState().wireDraft;
    if (wd) {
      const term = findTerminalAt(g.x, g.y, { exclude: wd.from, bypass: e.altKey });
      setHover(term
        ? { componentId: term.componentId, terminal: term, wireId: null, wireHandle: null, rotateHandle: null }
        : EMPTY_HOVER);
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
          if (dx * dx + dy * dy < 196) { // 14px radius — matches mousedown
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
    // terminal (pin magnet; Alt bypasses)
    const term = findTerminalAt(g.x, g.y, { bypass: e.altKey });
    if (term) {
      setHover({ componentId: term.componentId, terminal: term, wireId: null, wireHandle: null, rotateHandle: null });
      return;
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
      markDirty();
      return;
    }
    // End sheet drag
    if (sheetDragRef.current) {
      sheetDragRef.current = null;
      return;
    }
    if (rotateDragRef.current) {
      // History was already pushed at drag start
      rotateDragRef.current = null;
      markDirty();
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
    const view = viewRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(0.4, Math.min(4, view.zoom * factor));
    // Keep the grid point under the cursor stationary during zoom.
    const gridX = (sx - view.pan.x) / (CELL_SIZE * view.zoom);
    const gridY = (sy - view.pan.y) / (CELL_SIZE * view.zoom);
    view.pan = {
      x: sx - gridX * CELL_SIZE * newZoom,
      y: sy - gridY * CELL_SIZE * newZoom,
    };
    view.zoom = newZoom;
    markDirty();
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

  // Imperative zoom helpers (no React state).
  const zoomBy = (factor: number) => {
    const view = viewRef.current;
    view.zoom = Math.max(0.4, Math.min(4, view.zoom * factor));
    markDirty();
  };
  const zoomReset = () => {
    const view = viewRef.current;
    view.zoom = 1;
    view.pan = { x: 0, y: 0 };
    markDirty();
  };

  // Saved-view loading: the dialog dispatches `circuitlab:load-view` with the
  // stored camera {x, y, zoom}. Previously nothing listened for this event,
  // so "Load" silently did nothing. Apply the camera directly to the view.
  // Also answer the toolbar's `circuitlab:request-camera` poll so "Save
  // Current" captures the live pan/zoom instead of a stale {0,0,1}.
  useEffect(() => {
    const onLoadView = (e: Event) => {
      const v = (e as CustomEvent<{ x: number; y: number; zoom: number }>).detail;
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.zoom)) return;
      const view = viewRef.current;
      view.pan = { x: v.x, y: v.y };
      view.zoom = Math.max(0.4, Math.min(4, v.zoom));
      markDirty();
    };
    const onRequestCamera = () => {
      const view = viewRef.current;
      window.dispatchEvent(new CustomEvent('circuitlab:camera', {
        detail: { x: view.pan.x, y: view.pan.y, zoom: view.zoom },
      }));
    };
    // Net-inspector zoom: center the view on a component (dispatched by
    // NetInspectorDialog + ProbePanel waveform rows).
    const onZoomToComponent = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      const comp = useEditor.getState().components.find((c) => c.id === id);
      if (!comp) return;
      const plugin = getPlugin(comp.type);
      const bb = plugin?.boundingBox ?? { width: 4, height: 4 };
      const cx = comp.position.x + bb.width / 2;
      const cy = comp.position.y + bb.height / 2;
      const view = viewRef.current;
      const canvasW = view.width || 800;
      const canvasH = view.height || 600;
      view.zoom = Math.max(view.zoom, 1.2);
      view.pan = { x: canvasW / 2 - cx * 40 * view.zoom, y: canvasH / 2 - cy * 40 * view.zoom };
      useEditor.getState().setSelection({ type: 'component', id: comp.id });
      markDirty();
    };
    window.addEventListener('circuitlab:load-view', onLoadView);
    window.addEventListener('circuitlab:request-camera', onRequestCamera);
    window.addEventListener('circuitlab:zoom-to-component', onZoomToComponent);
    return () => {
      window.removeEventListener('circuitlab:load-view', onLoadView);
      window.removeEventListener('circuitlab:request-camera', onRequestCamera);
      window.removeEventListener('circuitlab:zoom-to-component', onZoomToComponent);
    };
  }, [markDirty, viewRef]);
  const zoomToFit = () => {
    const view = viewRef.current;
    const comps = useEditor.getState().components;
    if (comps.length === 0) { view.zoom = 1; view.pan = { x: 0, y: 0 }; markDirty(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of comps) {
      const plugin = getPlugin(c.type);
      if (!plugin) continue;
      const bb = plugin.boundingBox;
      minX = Math.min(minX, c.position.x);
      minY = Math.min(minY, c.position.y);
      maxX = Math.max(maxX, c.position.x + bb.width);
      maxY = Math.max(maxY, c.position.y + bb.height);
    }
    if (minX === Infinity) { view.zoom = 1; view.pan = { x: 0, y: 0 }; markDirty(); return; }
    const w = maxX - minX, h = maxY - minY;
    const canvasW = view.width || 800, canvasH = view.height || 600;
    const scaleX = canvasW / (w * 40 + 100); // 40px per grid unit + margin
    const scaleY = canvasH / (h * 40 + 100);
    const newZoom = Math.min(4, Math.max(0.4, Math.min(scaleX, scaleY)));
    view.zoom = newZoom;
    view.pan = { x: -minX * 40 * newZoom + 50, y: -minY * 40 * newZoom + 50 };
    markDirty();
  };

  // Use extracted keyboard hook
  useCanvasKeyboard({
    running,
    hoverRef,
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
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          dragRef.current = null;
          panRef.current = null;
          wireDragRef.current = null;
          rotateDragRef.current = null;
          sheetDragRef.current = null;
          const view = viewRef.current;
          view.hoveredSheetId = null;
          view.snapBypass = false;
          resetHover();
          setHoveredERC(null);
        }}
        onWheel={onWheel}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDoubleClick={onDoubleClick}
      />
      {/* status overlay — the coordinate/zoom/run line is updated
          imperatively by the render loop (statusRef); the rest are
          store-driven React children */}
      <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-slate-900/80 px-2 py-1 text-xs font-mono text-slate-400">
        <span ref={statusRef}>(0.0, 0.0)  zoom: 1.00x  ⏸ paused</span>
        {placementDraftActive && (
          <span className="ml-2 text-sky-300">· Placing {placementDraftActive.type} — arrows move, Enter place, Shift+Enter repeat, R rotate, Esc cancel</span>
        )}
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
            left: Math.min(tooltipMousePos.x + 14, viewRef.current.width - 280),
            top: Math.min(tooltipMousePos.y + 14, viewRef.current.height - 80),
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
          onClick={() => zoomBy(1.2)}
          className="h-7 w-7 cursor-pointer rounded bg-slate-800 text-slate-200 hover:bg-slate-700"
        >+</button>
        <button
          onClick={() => zoomBy(1 / 1.2)}
          className="h-7 w-7 cursor-pointer rounded bg-slate-800 text-slate-200 hover:bg-slate-700"
        >−</button>
        <button
          onClick={zoomToFit}
          className="h-7 w-7 cursor-pointer rounded bg-slate-800 text-slate-200 hover:bg-slate-700 text-xs"
          title="Zoom to fit (Z)"
        >⊞</button>
        <button
          onClick={zoomReset}
          className="h-7 w-7 cursor-pointer rounded bg-slate-800 text-slate-200 hover:bg-slate-700 text-xs"
        >⌂</button>
      </div>
    </div>
  );
}
