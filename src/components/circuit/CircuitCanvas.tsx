'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin, getAllPlugins } from '@/lib/circuit/registry';
import type { CircuitComponent, ComponentPlugin, TerminalDef, Vec2 } from '@/lib/circuit/types';
import { rotateTerminal } from '@/lib/circuit/components/draw';

const CELL_SIZE = 24;

interface DragState {
  componentId: string;
  offset: Vec2; // offset from component origin to cursor in grid units
}

interface HoverState {
  componentId: string | null;
  terminal: { componentId: string; terminalId: string; pos: Vec2 } | null;
}

export function CircuitCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [cursor, setCursor] = useState<Vec2>({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<{ start: Vec2; origin: Vec2 } | null>(null);
  const [hover, setHover] = useState<HoverState>({ componentId: null, terminal: null });
  const plugins = getAllPlugins();

  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const selection = useEditor((s) => s.selection);
  const simContext = useEditor((s) => s.simContext);
  const running = useEditor((s) => s.running);
  const showGrid = useEditor((s) => s.showGrid);
  const snapToGrid = useEditor((s) => s.snapToGrid);
  const wireDraft = useEditor((s) => s.wireDraft);

  const addComponent = useEditor((s) => s.addComponent);
  const moveComponent = useEditor((s) => s.moveComponent);
  const rotateComponent = useEditor((s) => s.rotateComponent);
  const deleteComponent = useEditor((s) => s.deleteComponent);
  const setSelection = useEditor((s) => s.setSelection);
  const startWire = useEditor((s) => s.startWire);
  const updateWireCursor = useEditor((s) => s.updateWireCursor);
  const completeWire = useEditor((s) => s.completeWire);
  const cancelWire = useEditor((s) => s.cancelWire);
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

  // simulation loop
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = t - last;
      if (dt > 16) {
        step();
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, step]);

  // helpers
  const screenToGrid = useCallback((sx: number, sy: number): Vec2 => {
    const x = (sx - pan.x) / (CELL_SIZE * zoom);
    const y = (sy - pan.y) / (CELL_SIZE * zoom);
    return snapToGrid ? { x: Math.round(x), y: Math.round(y) } : { x, y };
  }, [pan, zoom, snapToGrid]);

  const gridToScreen = useCallback((gx: number, gy: number): Vec2 => {
    return { x: gx * CELL_SIZE * zoom + pan.x, y: gy * CELL_SIZE * zoom + pan.y };
  }, [pan, zoom]);

  // get absolute position of a terminal (in grid coords)
  const getTerminalPos = useCallback((comp: CircuitComponent, terminal: TerminalDef): Vec2 => {
    const plugin = getPlugin(comp.type);
    if (!plugin) return { x: 0, y: 0 };
    const rotated = rotateTerminal(terminal, comp.rotation, plugin.boundingBox);
    return {
      x: comp.position.x + rotated.position.x,
      y: comp.position.y + rotated.position.y,
    };
  }, []);

  // find terminal under cursor (in grid coords)
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

  // find component under cursor (in grid coords)
  const findComponentAt = useCallback((gx: number, gy: number): CircuitComponent | null => {
    // iterate in reverse so top-drawn components are picked first
    for (let i = components.length - 1; i >= 0; i--) {
      const comp = components[i];
      const plugin = getPlugin(comp.type);
      if (!plugin) continue;
      // compute rotated bounding box
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
      // origin mark
      ctx.fillStyle = '#475569';
      ctx.fillRect(pan.x - 1, pan.y - 1, 3, 3);
    }

    // draw wires
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
      const fromPos = gridToScreen(...Object.values(getTerminalPos(fromComp, fromT)) as [number, number]);
      const toPos = gridToScreen(...Object.values(getTerminalPos(toComp, toT)) as [number, number]);
      const isSelected = selection.type === 'wire' && selection.id === wire.id;
      ctx.strokeStyle = isSelected ? '#fbbf24' : '#94a3b8';
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.beginPath();
      // orthogonal routing
      const midX = (fromPos.x + toPos.x) / 2;
      ctx.moveTo(fromPos.x, fromPos.y);
      ctx.lineTo(midX, fromPos.y);
      ctx.lineTo(midX, toPos.y);
      ctx.lineTo(toPos.x, toPos.y);
      ctx.stroke();
      // junction dots at endpoints
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath();
      ctx.arc(fromPos.x, fromPos.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(toPos.x, toPos.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // draw wire draft
    if (wireDraft) {
      const fromComp = components.find((c) => c.id === wireDraft.from.componentId);
      if (fromComp) {
        const plugin = getPlugin(fromComp.type);
        if (plugin) {
          const t = plugin.terminals.find((tt) => tt.id === wireDraft.from.terminalId);
          if (t) {
            const fromPos = gridToScreen(...Object.values(getTerminalPos(fromComp, t)) as [number, number]);
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

    // draw components
    for (const comp of components) {
      const plugin = getPlugin(comp.type);
      if (!plugin) continue;
      const isSelected = selection.type === 'component' && selection.id === comp.id;
      const isHover = hover.componentId === comp.id;
      const origin = gridToScreen(comp.position.x, comp.position.y);
      ctx.save();
      ctx.translate(origin.x, origin.y);
      ctx.scale(zoom, zoom);
      ctx.rotate((comp.rotation * Math.PI) / 2);
      // selection halo
      if (isSelected || isHover) {
        ctx.save();
        ctx.fillStyle = isSelected ? 'rgba(251, 191, 36, 0.18)' : 'rgba(148, 163, 184, 0.12)';
        ctx.strokeStyle = isSelected ? '#fbbf24' : '#64748b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(-2, -2, plugin.boundingBox.width * CELL_SIZE + 4, plugin.boundingBox.height * CELL_SIZE + 4);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      // default stroke
      ctx.strokeStyle = '#e2e8f0';
      ctx.fillStyle = '#e2e8f0';
      ctx.lineWidth = 1.5;
      try {
        plugin.render(ctx, comp.parameters, CELL_SIZE, simContext ?? undefined, comp);
      } catch (e) {
        console.error(`render error in ${comp.type}:`, e);
      }
      ctx.restore();
      // draw terminals (in screen coords)
      for (const t of plugin.terminals) {
        const tpos = getTerminalPos(comp, t);
        const sp = gridToScreen(tpos.x, tpos.y);
        const isHot = hover.terminal?.componentId === comp.id && hover.terminal?.terminalId === t.id;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, isHot ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = isHot ? '#fbbf24' : '#64748b';
        ctx.fill();
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // draw cursor crosshair (when no drag)
    if (!dragRef.current && !panRef.current) {
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

    ctx.restore();
  }, [size, pan, zoom, components, wires, selection, hover, cursor, simContext, showGrid, wireDraft, gridToScreen, getTerminalPos]);

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
      setSelection({ type: 'component', id: comp.id });
      dragRef.current = {
        componentId: comp.id,
        offset: { x: g.x - comp.position.x, y: g.y - comp.position.y },
      };
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

    if (panRef.current) {
      setPan({
        x: panRef.current.origin.x + (sx - panRef.current.start.x),
        y: panRef.current.origin.y + (sy - panRef.current.start.y),
      });
      return;
    }

    if (dragRef.current) {
      const newPos = { x: g.x - dragRef.current.offset.x, y: g.y - dragRef.current.offset.y };
      moveComponent(dragRef.current.componentId, newPos);
      return;
    }

    if (wireDraft) {
      updateWireCursor(g);
    }

    // hover detection
    const term = findTerminalAt(g.x, g.y);
    if (term) {
      setHover({ componentId: term.componentId, terminal: term });
    } else {
      const comp = findComponentAt(g.x, g.y);
      setHover({ componentId: comp?.id ?? null, terminal: null });
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      panRef.current = null;
      return;
    }
    if (dragRef.current) {
      // commit move to history
      useEditor.getState().pushHistory();
      dragRef.current = null;
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(0.4, Math.min(4, zoom * factor));
    setZoom(newZoom);
  };

  const onDrop = (e: React.DragEvent) => {
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
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const g = screenToGrid(sx, sy);
    const comp = findComponentAt(g.x, g.y);
    if (comp) rotateComponent(comp.id);
  };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const s = useEditor.getState().selection;
        if (s.type === 'component') deleteComponent(s.id!);
        else if (s.type === 'wire') useEditor.getState().deleteWire(s.id!);
      } else if (e.key === 'r' || e.key === 'R') {
        const s = useEditor.getState().selection;
        if (s.type === 'component') rotateComponent(s.id!);
      } else if (e.key === 'Escape') {
        cancelWire();
        setSelection({ type: null, id: null });
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useEditor.getState().undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        useEditor.getState().redo();
      } else if (e.key === ' ') {
        e.preventDefault();
        const s = useEditor.getState();
        s.setRunning(!s.running);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteComponent, rotateComponent, cancelWire, setSelection]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-slate-950"
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { dragRef.current = null; panRef.current = null; }}
        onWheel={onWheel}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDoubleClick={onDoubleClick}
      />
      {/* status overlay */}
      <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-slate-900/80 px-2 py-1 text-xs font-mono text-slate-400">
        ({cursor.x.toFixed(1)}, {cursor.y.toFixed(1)})  zoom: {zoom.toFixed(2)}x  {running ? '▶ running' : '⏸ paused'}
      </div>
      <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-slate-900/80 px-2 py-1 text-xs font-mono text-slate-400">
        Drag from left • Double-click to rotate • R rotate • Del delete • Space play/pause
      </div>
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
