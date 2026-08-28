// Custom hook: owns the canvas render loop, fully outside React's render cycle.
//
// Why: previously every mousemove (cursor/hover), every pan/zoom drag tick, and
// every simulation frame called setState → React re-rendered the entire
// CircuitCanvas tree (1600-line component) + re-ran a draw effect. Now:
//   - View state (pan/zoom/cursor/hover) lives in a mutable ref (viewRef).
//   - A direct requestAnimationFrame loop draws frames via renderScene().
//   - A zustand subscription marks the scene dirty whenever ANY store slice
//     changes (topology edits, selection, simContext updates...).
//   - While a simulation is running (running && simContext) the loop renders
//     every frame so flow dots animate smoothly, exactly like before.
//   - While idle and clean, each frame costs one boolean check — effectively zero.
//
// React re-renders of CircuitCanvas are now reserved for rare, JSX-relevant
// changes (empty-state card, ERC tooltip, placement hint).

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useEditor } from '@/lib/circuit/store';
import type { Vec2 } from '@/lib/circuit/types';
import type { DragState, WireDragState, RotateDragState } from './canvas-types';
import {
  renderScene,
  createInitialView,
  computeCursorStyle,
  formatStatusText,
  type CanvasView,
} from './canvas-renderer';

export function useCanvasRenderer(opts: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  statusRef: RefObject<HTMLSpanElement | null>;
  dragRef: RefObject<DragState | null>;
  wireDragRef: RefObject<WireDragState | null>;
  rotateDragRef: RefObject<RotateDragState | null>;
  panRef: RefObject<{ start: Vec2; origin: Vec2 } | null>;
  flowPhaseRef: RefObject<number>;
}) {
  const {
    canvasRef, containerRef, statusRef,
    dragRef, wireDragRef, rotateDragRef, panRef, flowPhaseRef,
  } = opts;

  const viewRef = useRef<CanvasView>(createInitialView());
  const dirtyRef = useRef(true);

  /** Request a redraw on the next frame (call after mutating viewRef). */
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  // ---- ResizeObserver: canvas element size → view (no React state) ----
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.max(1, Math.floor(e.contentRect.width));
        const h = Math.max(1, Math.floor(e.contentRect.height));
        if (viewRef.current.width !== w || viewRef.current.height !== h) {
          viewRef.current.width = w;
          viewRef.current.height = h;
          dirtyRef.current = true;
        }
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [containerRef]);

  // ---- Store subscription: any setState marks the scene dirty ----
  useEffect(() => {
    const unsub = useEditor.subscribe(() => {
      dirtyRef.current = true;
    });
    return unsub;
  }, []);

  // ---- The render loop ----
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const st = useEditor.getState();
        const dpr = window.devicePixelRatio || 1;
        const view = viewRef.current;

        // Resize the backing store only when the CSS size actually changed
        // (setting canvas.width clears the surface — never do it per frame).
        const bw = Math.round(view.width * dpr);
        const bh = Math.round(view.height * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
          canvas.width = bw;
          canvas.height = bh;
          canvas.style.width = `${view.width}px`;
          canvas.style.height = `${view.height}px`;
          dirtyRef.current = true;
        }

        const animating = st.running && st.simContext != null;
        if (dirtyRef.current || animating) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            dirtyRef.current = false;
            renderScene(ctx, {
              view,
              dpr,
              components: st.components,
              wires: st.wires,
              sheets: st.sheets,
              selection: st.selection,
              multiSelection: st.multiSelection,
              simContext: st.simContext,
              running: st.running,
              showGrid: st.showGrid,
              wireDraft: st.wireDraft,
              noConnects: st.noConnects,
              drawings: st.drawings,
              units: st.units,
              showPinNumbers: st.showPinNumbers,
              showPinNames: st.showPinNames,
              showPinElecTypes: st.showPinElecTypes,
              netClasses: st.netClasses,
              showNetColors: st.showNetColors ?? true,
              ercErrors: st.ercErrors,
              placementDraft: st.placementDraft,
              theme: st.theme,
              drag: dragRef.current,
              wireDrag: wireDragRef.current,
              rotateDrag: rotateDragRef.current,
              panDrag: panRef.current != null,
              flowPhase: flowPhaseRef.current,
            });

            // Imperative cursor style — replaces React re-render per hover change.
            const cursorStyle = computeCursorStyle(
              view.hover, st.running, st.components, rotateDragRef.current != null,
            );
            if (canvas.style.cursor !== cursorStyle) {
              canvas.style.cursor = cursorStyle;
            }

            // Imperative status overlay — replaces React re-render per mousemove.
            const statusEl = statusRef.current;
            if (statusEl) {
              const text = formatStatusText(view.cursor, view.zoom, st.running);
              if (statusEl.textContent !== text) {
                statusEl.textContent = text;
              }
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [canvasRef, statusRef, dragRef, wireDragRef, rotateDragRef, panRef, flowPhaseRef]);

  return { viewRef, markDirty };
}
