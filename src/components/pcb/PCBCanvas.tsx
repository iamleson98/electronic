'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import type { Pad } from '@/lib/pcb/types';

const GRID_SIZE_MM = 2.5; // mm per grid cell
const PX_PER_MM = 8; // pixels per mm at zoom=1

export function PCBCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(2.5);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ footprintId: string; offset: { x: number; y: number } } | null>(null);
  const panRef = useRef<{ start: { x: number; y: number }; origin: { x: number; y: number } } | null>(null);

  // PCB store
  const board = usePCB((s) => s.board);
  const footprints = usePCB((s) => s.footprints);
  const traces = usePCB((s) => s.traces);
  const vias = usePCB((s) => s.vias);
  const ratsnest = usePCB((s) => s.ratsnest);
  const padNets = usePCB((s) => s.padNets);
  const activeLayer = usePCB((s) => s.activeLayer);
  const tool = usePCB((s) => s.tool);
  const defaultTraceWidth = usePCB((s) => s.defaultTraceWidth);
  const selectedFootprintId = usePCB((s) => s.selectedFootprintId);
  const selectedTraceId = usePCB((s) => s.selectedTraceId);
  const routingFrom = usePCB((s) => s.routingFrom);
  const routingPath = usePCB((s) => s.routingPath);
  const showRatsnest = usePCB((s) => s.showRatsnest);
  const showGrid = usePCB((s) => s.showGrid);
  const showPadNets = usePCB((s) => s.showPadNets);
  const drcErrors = usePCB((s) => s.drcErrors);
  const copperPours = usePCB((s) => s.copperPours);

  const moveFootprint = usePCB((s) => s.moveFootprint);
  const rotateFootprint = usePCB((s) => s.rotateFootprint);
  const selectFootprint = usePCB((s) => s.selectFootprint);
  const selectTrace = usePCB((s) => s.selectTrace);
  const startRouting = usePCB((s) => s.startRouting);
  const addRoutingPoint = usePCB((s) => s.addRoutingPoint);
  const finishRouting = usePCB((s) => s.finishRouting);
  const cancelRouting = usePCB((s) => s.cancelRouting);
  const addVia = usePCB((s) => s.addVia);
  const setTool = usePCB((s) => s.setTool);

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

  const mmToScreen = useCallback((mx: number, my: number) => ({
    x: mx * PX_PER_MM * zoom + pan.x,
    y: my * PX_PER_MM * zoom + pan.y,
  }), [pan, zoom]);

  const screenToMm = useCallback((sx: number, sy: number) => ({
    x: (sx - pan.x) / (PX_PER_MM * zoom),
    y: (sy - pan.y) / (PX_PER_MM * zoom),
  }), [pan, zoom]);

  // find pad at screen position
  const findPadAt = useCallback((sx: number, sy: number): Pad | null => {
    const mm = screenToMm(sx, sy);
    for (const fp of footprints) {
      for (const pad of fp.pads) {
        const dx = mm.x - pad.position.x;
        const dy = mm.y - pad.position.y;
        const r = Math.max(pad.size.width, pad.size.height) / 2 + 0.3;
        if (dx * dx + dy * dy < r * r) return pad;
      }
    }
    return null;
  }, [footprints, screenToMm]);

  // find footprint at screen position
  const findFootprintAt = useCallback((sx: number, sy: number) => {
    const mm = screenToMm(sx, sy);
    for (const fp of footprints) {
      const dx = Math.abs(mm.x - fp.position.x);
      const dy = Math.abs(mm.y - fp.position.y);
      if (dx <= fp.bodySize.width / 2 + 1 && dy <= fp.bodySize.height / 2 + 1) {
        return fp;
      }
    }
    return null;
  }, [footprints, screenToMm]);

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

    // background
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, size.width, size.height);

    // grid
    if (showGrid) {
      ctx.strokeStyle = '#13293d';
      ctx.lineWidth = 0.5;
      const gridPx = PX_PER_MM * zoom;
      for (let x = pan.x % gridPx; x < size.width; x += gridPx) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.height);
        ctx.stroke();
      }
      for (let y = pan.y % gridPx; y < size.height; y += gridPx) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size.width, y);
        ctx.stroke();
      }
    }

    // board outline
    const boardTL = mmToScreen(0, 0);
    const boardBR = mmToScreen(board.width, board.height);
    ctx.fillStyle = '#1a3a1a';
    ctx.fillRect(boardTL.x, boardTL.y, boardBR.x - boardTL.x, boardBR.y - boardTL.y);
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 2;
    ctx.strokeRect(boardTL.x, boardTL.y, boardBR.x - boardTL.x, boardBR.y - boardTL.y);

    // copper pours (ground planes)
    for (const pour of copperPours) {
      const color = pour.layer === 'top' ? 'rgba(220, 38, 38, 0.15)' : 'rgba(37, 99, 235, 0.15)';
      ctx.fillStyle = color;
      const cellPx = pour.cellSize * PX_PER_MM * zoom;
      for (const cell of pour.cells) {
        const sp = mmToScreen(cell.x - pour.cellSize / 2, cell.y - pour.cellSize / 2);
        ctx.fillRect(sp.x, sp.y, cellPx, cellPx);
      }
    }

    // DRC error markers
    for (const err of drcErrors) {
      const sp = mmToScreen(err.position.x, err.position.y);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = err.severity === 'error' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(251, 191, 36, 0.3)';
      ctx.fill();
      ctx.strokeStyle = err.severity === 'error' ? '#ef4444' : '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // X mark
      ctx.beginPath();
      ctx.moveTo(sp.x - 3, sp.y - 3);
      ctx.lineTo(sp.x + 3, sp.y + 3);
      ctx.moveTo(sp.x + 3, sp.y - 3);
      ctx.lineTo(sp.x - 3, sp.y + 3);
      ctx.stroke();
    }

    // ratsnest (airwires)
    if (showRatsnest) {
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const rn of ratsnest) {
        const from = mmToScreen(rn.from.x, rn.from.y);
        const to = mmToScreen(rn.to.x, rn.to.y);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // traces (copper)
    const layerColors = { top: '#dc2626', bottom: '#2563eb' };
    for (const trace of traces) {
      const color = layerColors[trace.layer];
      const isSelected = selectedTraceId === trace.id;
      ctx.strokeStyle = isSelected ? '#fbbf24' : color;
      ctx.lineWidth = Math.max(1.5, trace.width * PX_PER_MM * zoom);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const seg of trace.segments) {
        const s = mmToScreen(seg.start.x, seg.start.y);
        const e = mmToScreen(seg.end.x, seg.end.y);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
      }
    }

    // vias
    for (const via of vias) {
      const v = mmToScreen(via.position.x, via.position.y);
      const r = (via.diameter / 2) * PX_PER_MM * zoom;
      ctx.beginPath();
      ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(v.x, v.y, r * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#0a1628';
      ctx.fill();
    }

    // routing preview
    if (routingFrom && routingPath.length > 0) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = Math.max(1.5, defaultTraceWidth * PX_PER_MM * zoom);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const first = mmToScreen(routingPath[0].x, routingPath[0].y);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < routingPath.length; i++) {
        const p = mmToScreen(routingPath[i].x, routingPath[i].y);
        ctx.lineTo(p.x, p.y);
      }
      // line to cursor
      const cur = mmToScreen(cursor.x, cursor.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.stroke();
    }

    // footprints
    for (const fp of footprints) {
      const center = mmToScreen(fp.position.x, fp.position.y);
      const w = fp.bodySize.width * PX_PER_MM * zoom;
      const h = fp.bodySize.height * PX_PER_MM * zoom;
      const isSelected = selectedFootprintId === fp.id;

      // body outline
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate((fp.rotation * Math.PI) / 180);
      ctx.strokeStyle = isSelected ? '#fbbf24' : '#94a3b8';
      ctx.fillStyle = isSelected ? 'rgba(251, 191, 36, 0.15)' : 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);

      // refdes label
      ctx.fillStyle = isSelected ? '#fbbf24' : '#cbd5e1';
      ctx.font = `${Math.max(8, 8 * zoom)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fp.refdes, 0, 0);
      ctx.restore();

      // pads
      for (const pad of fp.pads) {
        const p = mmToScreen(pad.position.x, pad.position.y);
        const padW = pad.size.width * PX_PER_MM * zoom;
        const padH = pad.size.height * PX_PER_MM * zoom;
        const net = padNets.get(`${pad.componentId}:${pad.terminalId}`);

        // pad color by layer
        const padColor = fp.side === 'top' ? '#dc2626' : '#2563eb';
        ctx.fillStyle = padColor;
        if (pad.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(padW, padH) / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(p.x - padW / 2, p.y - padH / 2, padW, padH);
        }

        // pad border
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 0.5;
        if (pad.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(padW, padH) / 2, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.strokeRect(p.x - padW / 2, p.y - padH / 2, padW, padH);
        }

        // net name on pad
        if (showPadNets && net) {
          ctx.fillStyle = '#fde047';
          ctx.font = `${Math.max(6, 6 * zoom)}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(net, p.x, p.y - 8);
        }
      }
    }

    // status overlay
    ctx.fillStyle = 'rgba(10, 22, 40, 0.8)';
    ctx.fillRect(0, size.height - 24, size.width, 24);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const layerName = activeLayer === 'top' ? 'Top (Red)' : 'Bottom (Blue)';
    ctx.fillText(
      `PCB Layout · ${board.width}×${board.height}mm · Layer: ${layerName} · Tool: ${tool} · ${cursor.x.toFixed(1)},${cursor.y.toFixed(1)}mm · zoom: ${zoom.toFixed(1)}x`,
      8, size.height - 12,
    );

    ctx.restore();
  }, [size, pan, zoom, board, footprints, traces, vias, ratsnest, padNets, activeLayer, tool,
      defaultTraceWidth, selectedFootprintId, selectedTraceId, routingFrom, routingPath,
      showRatsnest, showGrid, showPadNets, cursor, mmToScreen, drcErrors, copperPours]);

  // ----- Mouse handlers -----
  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (e.button === 1 || e.button === 2) {
      panRef.current = { start: { x: sx, y: sy }, origin: { ...pan } };
      return;
    }

    if (tool === 'route') {
      const pad = findPadAt(sx, sy);
      const mm = screenToMm(sx, sy);
      const snapped = { x: Math.round(mm.x * 2) / 2, y: Math.round(mm.y * 2) / 2 };
      if (pad) {
        const net = padNets.get(`${pad.componentId}:${pad.terminalId}`) ?? 'unrouted';
        if (!routingFrom) {
          startRouting({ x: pad.position.x, y: pad.position.y, net });
        } else {
          addRoutingPoint(pad.position);
          finishRouting({ x: pad.position.x, y: pad.position.y, net });
        }
      } else {
        if (routingFrom) {
          addRoutingPoint(snapped);
        }
      }
      return;
    }

    if (tool === 'via') {
      const mm = screenToMm(sx, sy);
      addVia({ x: mm.x, y: mm.y }, routingFrom?.net ?? 'unrouted');
      return;
    }

    // select tool
    const fp = findFootprintAt(sx, sy);
    if (fp) {
      selectFootprint(fp.id);
      const mm = screenToMm(sx, sy);
      dragRef.current = {
        footprintId: fp.id,
        offset: { x: mm.x - fp.position.x, y: mm.y - fp.position.y },
      };
    } else {
      // check trace
      const mm = screenToMm(sx, sy);
      let foundTrace: string | null = null;
      for (const trace of traces) {
        for (const seg of trace.segments) {
          const dist = pointToSegmentDist(mm.x, mm.y, seg.start.x, seg.start.y, seg.end.x, seg.end.y);
          if (dist < 0.5) { foundTrace = trace.id; break; }
        }
        if (foundTrace) break;
      }
      if (foundTrace) {
        selectTrace(foundTrace);
      } else {
        selectFootprint(null);
      }
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const mm = screenToMm(sx, sy);
    setCursor({ x: mm.x, y: mm.y });

    if (panRef.current) {
      setPan({
        x: panRef.current.origin.x + (sx - panRef.current.start.x),
        y: panRef.current.origin.y + (sy - panRef.current.start.y),
      });
      return;
    }

    if (dragRef.current) {
      const mm = screenToMm(sx, sy);
      const newPos = {
        x: mm.x - dragRef.current.offset.x,
        y: mm.y - dragRef.current.offset.y,
      };
      // snap to 0.5mm grid
      moveFootprint(dragRef.current.footprintId, {
        x: Math.round(newPos.x * 2) / 2,
        y: Math.round(newPos.y * 2) / 2,
      });
    }
  };

  const onMouseUp = () => {
    panRef.current = null;
    dragRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(1, Math.min(10, zoom * factor));
    const mmX = (sx - pan.x) / (PX_PER_MM * zoom);
    const mmY = (sy - pan.y) / (PX_PER_MM * zoom);
    setZoom(newZoom);
    setPan({
      x: sx - mmX * PX_PER_MM * newZoom,
      y: sy - mmY * PX_PER_MM * newZoom,
    });
  };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelRouting();
        selectFootprint(null);
      } else if (e.key === 'r' || e.key === 'R') {
        if (selectedFootprintId) rotateFootprint(selectedFootprintId);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedTraceId) usePCB.getState().deleteTrace(selectedTraceId);
      } else if (e.key === '1') setTool('select');
      else if (e.key === '2') setTool('route');
      else if (e.key === '3') setTool('via');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelRouting, selectFootprint, selectedFootprintId, rotateFootprint, selectedTraceId, setTool]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#0a1628]"
      onContextMenu={(e) => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: tool === 'route' ? 'crosshair' : tool === 'via' ? 'pointer' : 'default' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      />
    </div>
  );
}

function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
