// Custom hook: extracts all keyboard shortcuts from CircuitCanvas.
// Handles: Delete, R (rotate), X/Y (mirror), L (lock), M (De Morgan),
// Shift+R (free rotate), Ctrl+Z/Y (undo/redo), Ctrl+C/V/D (copy/paste/duplicate),
// Ctrl+A (select all), Ctrl+F (find), N (no-connect), Space (play/pause),
// \ (45° routing toggle), Escape (cancel/clear).
// A11y: while a placement draft is active, arrow keys nudge it, Enter places,
// Shift+Enter places-and-repeats, R rotates the draft, Esc cancels. Tab /
// Shift+Tab cycles virtual focus through components and wires (the focused
// item is the selection, so Delete/R/X/PropertyPanel all work on it).

import { useEffect } from 'react';
import { useEditor } from '@/lib/circuit/store';
import type { HoverState } from './canvas-types';

export function useCanvasKeyboard(opts: {
  running: boolean;
  hover: HoverState;
  cancelWire: () => void;
  setSelection: (sel: any) => void;
  deleteComponent: (id: string) => void;
  rotateComponent: (id: string) => void;
  setActiveSheet: (s: string) => void;
  setUse45Routing: (fn: (v: boolean) => boolean) => void;
}) {
  const { running, hover, cancelWire, setSelection, deleteComponent, rotateComponent, setActiveSheet, setUse45Routing } = opts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

      // ── Keyboard placement mode (a11y) — takes priority over everything ────
      const st = useEditor.getState();
      if (st.placementDraft) {
        const step = e.shiftKey ? 5 : 1; // Shift = fast nudge
        switch (e.key) {
          case 'ArrowUp':
          case 'ArrowDown':
          case 'ArrowLeft':
          case 'ArrowRight': {
            e.preventDefault();
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            useEditor.getState().nudgePlacement(dx, dy);
            return;
          }
          case 'Enter':
            e.preventDefault();
            useEditor.getState().confirmPlacement(e.shiftKey);
            return;
          case 'r':
          case 'R':
            e.preventDefault();
            useEditor.getState().rotatePlacement();
            return;
          case 'Escape':
            e.preventDefault();
            useEditor.getState().cancelPlacement();
            return;
        }
      }

      // ── Virtual focus cycling (a11y): Tab / Shift+Tab ──────────────────────
      if (e.key === 'Tab') {
        // Only intercept when the canvas itself (not a dialog/input) has DOM
        // focus — otherwise we'd trap Tab inside the app.
        const canvasEl = (target as HTMLElement).closest?.('[role="application"]') as HTMLElement | null;
        if (canvasEl) {
          e.preventDefault();
          useEditor.getState().focusCycle(e.shiftKey ? -1 : 1);
          return;
        }
      }

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
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        if (s.selection.type === 'component' && s.selection.id) s.mirrorComponent(s.selection.id, 'x');
        else if (s.multiSelection.components.size > 0) s.mirrorSelected('x');
      } else if (e.key === 'y' || e.key === 'Y') {
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        if (s.selection.type === 'component' && s.selection.id) s.mirrorComponent(s.selection.id, 'y');
        else if (s.multiSelection.components.size > 0) s.mirrorSelected('y');
      } else if (e.key === 'l' || e.key === 'L') {
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        if (s.selection.type === 'component' && s.selection.id) s.toggleLock(s.selection.id);
      } else if (e.key === 'm' || e.key === 'M') {
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        if (s.selection.type === 'component' && s.selection.id) s.toggleDeMorgan(s.selection.id);
      } else if (e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        if (running) return;
        e.preventDefault();
        const s = useEditor.getState();
        if (s.selection.type === 'component' && s.selection.id) {
          const comp = s.components.find((c) => c.id === s.selection.id);
          if (comp) {
            const cur = comp.rotationDeg ?? (comp.rotation * 90);
            s.rotateComponentFree(s.selection.id, (cur + 15) % 360);
          }
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (running) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('circuitlab:open-find-replace'));
      } else if (e.key === 'n' || e.key === 'N') {
        if (running) return;
        e.preventDefault();
        if (hover.terminal) {
          const s = useEditor.getState();
          const exists = s.noConnects.find((nc) => nc.componentId === hover.terminal!.componentId && nc.terminalId === hover.terminal!.terminalId);
          if (exists) s.removeNoConnect(hover.terminal!.componentId, hover.terminal!.terminalId);
          else s.addNoConnect(hover.terminal!.componentId, hover.terminal!.terminalId);
        }
      } else if (e.key === 'Escape') {
        if (useEditor.getState().activeSheet) {
          setActiveSheet('');
        } else {
          cancelWire();
          setSelection({ type: null, id: null });
          useEditor.getState().clearMultiSelection();
        }
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
  }, [deleteComponent, rotateComponent, cancelWire, setSelection, running, hover, setActiveSheet, setUse45Routing]);
}
