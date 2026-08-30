'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import type { Pad, CopperLayer } from '@/lib/pcb/types';
import {
  drawDRCErrors,
  drawCourtyards,
  drawLockIndicators,
  drawRoutingCompletion,
  findDRCErrorAt,
} from '@/lib/pcb/pcb-overlays';
import type { DRCError } from '@/lib/pcb/drc';
import { useAutoDRC } from '@/lib/auto-rule-hooks';
import { LAYER_COLORS } from '@/lib/pcb/types';

const PX_PER_MM = 8;

// Layer-aware colors — realistic PCB look
const LAYER_PALETTE: Record<CopperLayer, { copper: string; copperDim: string; silk: string; mask: string }> = {
  top:    { copper: '#cd7f32', copperDim: '#8b5a2b', silk: '#e8e8e8', mask: 'rgba(180, 40, 40, 0.35)' },
  inner1: { copper: '#daa520', copperDim: '#9a7810', silk: '#e8e8e8', mask: 'rgba(200, 160, 40, 0.2)' },
  inner2: { copper: '#2ea043', copperDim: '#1a6b2e', silk: '#e8e8e8', mask: 'rgba(60, 160, 80, 0.2)' },
  inner3: { copper: '#a855f7', copperDim: '#7c3aed', silk: '#e8e8e8', mask: 'rgba(140, 70, 200, 0.2)' },
  inner4: { copper: '#06b6d4', copperDim: '#0e7490', silk: '#e8e8e8', mask: 'rgba(40, 180, 200, 0.2)' },
  bottom: { copper: '#4682b4', copperDim: '#2e5c80', silk: '#e8e8e8', mask: 'rgba(50, 80, 150, 0.35)' },
};

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
  const keepouts = usePCB((s) => s.keepouts);
  const teardrops = usePCB((s) => s.teardrops);
  const crossProbeComponentIds = usePCB((s) => s.crossProbeComponentIds);
  const showKeepouts = usePCB((s) => s.showKeepouts);
  const addKeepout = usePCB((s) => s.addKeepout);
  const layerStack = usePCB((s) => s.layerStack);

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

  useAutoDRC(true);
  const [hoveredDRC, setHoveredDRC] = useState<DRCError | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setSize({ width: e.contentRect.width, height: e.contentRect.height });
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

  const findFootprintAt = useCallback((sx: number, sy: number) => {
    const mm = screenToMm(sx, sy);
    for (const fp of footprints) {
      const dx = Math.abs(mm.x - fp.position.x);
      const dy = Math.abs(mm.y - fp.position.y);
      if (dx <= fp.bodySize.width / 2 + 1 && dy <= fp.bodySize.height / 2 + 1) return fp;
    }
    return null;
  }, [footprints, screenToMm]);

  useEffect(() => {
    if (footprints.length === 0 || size.width < 10) return;
    const margin = 60;
    const zoomX = (size.width - margin * 2) / (board.width * PX_PER_MM);
    const zoomY = (size.height - margin * 2) / (board.height * PX_PER_MM);
    const fitZoom = Math.min(zoomX, zoomY, 8);
    const boardScreenW = board.width * PX_PER_MM * fitZoom;
    const boardScreenH = board.height * PX_PER_MM * fitZoom;
    requestAnimationFrame(() => {
      setZoom(fitZoom);
      setPan({ x: (size.width - boardScreenW) / 2, y: (size.height - boardScreenH) / 2 });
    });
  }, [footprints.length, board.width, board.height, size.width, size.height]);

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

    // ── Background: deep space blue with subtle radial gradient ──────────
    const bgGrad = ctx.createRadialGradient(
      size.width / 2, size.height / 2, 0,
      size.width / 2, size.height / 2, Math.max(size.width, size.height) * 0.7
    );
    bgGrad.addColorStop(0, '#0f1e2e');
    bgGrad.addColorStop(1, '#070d15');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, size.width, size.height);

    // ── Grid: dot grid (not line grid) — much cleaner ────────────────────
    if (showGrid) {
      const gridPx = PX_PER_MM * zoom;
      const dotSize = zoom > 3 ? 1.5 : 1;
      ctx.fillStyle = 'rgba(100, 140, 180, 0.15)';
      const startX = pan.x % gridPx;
      const startY = pan.y % gridPx;
      for (let x = startX; x < size.width; x += gridPx) {
        for (let y = startY; y < size.height; y += gridPx) {
          ctx.fillRect(x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
        }
      }
      // Major grid every 5mm
      ctx.fillStyle = 'rgba(100, 140, 180, 0.3)';
      const majorPx = gridPx * 5;
      const majStartX = pan.x % majorPx;
      const majStartY = pan.y % majorPx;
      for (let x = majStartX; x < size.width; x += majorPx) {
        for (let y = majStartY; y < size.height; y += majorPx) {
          ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
      }
    }

    // ── Board substrate: realistic FR4 green with rounded corners ────────
    const boardTL = mmToScreen(0, 0);
    const boardBR = mmToScreen(board.width, board.height);
    const bw = boardBR.x - boardTL.x;
    const bh = boardBR.y - boardTL.y;
    const cornerR = Math.min(bw, bh) * 0.02;

    // Solder mask (green/dark)
    const maskGrad = ctx.createLinearGradient(boardTL.x, boardTL.y, boardBR.x, boardBR.y);
    maskGrad.addColorStop(0, '#1a4a1a');
    maskGrad.addColorStop(0.5, '#226622');
    maskGrad.addColorStop(1, '#1a4a1a');
    ctx.fillStyle = maskGrad;
    roundedRect(ctx, boardTL.x, boardTL.y, bw, bh, cornerR);
    ctx.fill();

    // Board edge bevel (lighter green border)
    ctx.strokeStyle = '#3a8a3a';
    ctx.lineWidth = 2;
    roundedRect(ctx, boardTL.x, boardTL.y, bw, bh, cornerR);
    ctx.stroke();

    // Inner border (silkscreen border line)
    ctx.strokeStyle = 'rgba(232, 232, 232, 0.15)';
    ctx.lineWidth = 1;
    const inset = 1.5 * PX_PER_MM * zoom;
    roundedRect(ctx, boardTL.x + inset, boardTL.y + inset, bw - inset * 2, bh - inset * 2, cornerR * 0.5);
    ctx.stroke();

    // ── Copper pours ──────────────────────────────────────────────────────
    for (const pour of copperPours) {
      const pal = LAYER_PALETTE[pour.layer as CopperLayer] ?? LAYER_PALETTE.top;
      ctx.fillStyle = pal.copper + '30'; // semi-transparent
      const cellPx = pour.cellSize * PX_PER_MM * zoom;
      for (const cell of pour.cells) {
        const sp = mmToScreen(cell.x - pour.cellSize / 2, cell.y - pour.cellSize / 2);
        ctx.fillRect(sp.x, sp.y, cellPx, cellPx);
      }
      // Thermal relief pads — 4 spokes (N, S, E, W)
      if (pour.thermalPads) {
        for (const tp of pour.thermalPads) {
          const sp = mmToScreen(tp.pos.x, tp.pos.y);
          const spokePx = tp.spokeWidth * PX_PER_MM * zoom;
          const spokeLen = (tp.padRadius + 0.3) * PX_PER_MM * zoom;
          ctx.fillStyle = pal.copper;
          // North spoke (up)
          ctx.fillRect(sp.x - spokePx / 2, sp.y - spokeLen, spokePx, spokeLen);
          // South spoke (down)
          ctx.fillRect(sp.x - spokePx / 2, sp.y, spokePx, spokeLen);
          // East spoke (right)
          ctx.fillRect(sp.x, sp.y - spokePx / 2, spokeLen, spokePx);
          // West spoke (left)
          ctx.fillRect(sp.x - spokeLen, sp.y - spokePx / 2, spokeLen, spokePx);
        }
      }
    }

    // ── DRC halos (behind everything) ───────────────────────────────────
    if (drcErrors.length > 0) {
      for (const err of drcErrors) {
        const sp = mmToScreen(err.position.x, err.position.y);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = err.severity === 'error' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(251, 191, 36, 0.1)';
        ctx.fill();
      }
    }

    // ── Keepout areas ───────────────────────────────────────────────────
    if (showKeepouts) {
      for (const kp of keepouts) {
        const tl = mmToScreen(kp.rect.x, kp.rect.y);
        const br = mmToScreen(kp.rect.x + kp.rect.width, kp.rect.y + kp.rect.height);
        const w = br.x - tl.x, h = br.y - tl.y;
        ctx.save();
        ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
        ctx.fillRect(tl.x, tl.y, w, h);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(tl.x, tl.y, w, h);
        ctx.setLineDash([]);
        if (kp.reason) {
          ctx.fillStyle = '#ef4444';
          ctx.font = '10px ui-monospace, monospace';
          ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          ctx.fillText(kp.reason, tl.x + 4, tl.y + 4);
        }
        ctx.restore();
      }
    }

    // ── Teardrops ───────────────────────────────────────────────────────
    for (const td of teardrops) {
      if (td.points.length < 3) continue;
      const pal = LAYER_PALETTE[td.layer as CopperLayer] ?? LAYER_PALETTE.top;
      ctx.fillStyle = pal.copper + 'AA';
      ctx.beginPath();
      const p0 = mmToScreen(td.points[0].x, td.points[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < td.points.length; i++) {
        const p = mmToScreen(td.points[i].x, td.points[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fill();
    }

    // ── Ratsnest (airwires) — thin glowing lines ────────────────────────
    if (showRatsnest) {
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.shadowColor = 'rgba(250, 204, 21, 0.3)';
      ctx.shadowBlur = 3;
      for (const rn of ratsnest) {
        const from = mmToScreen(rn.from.x, rn.from.y);
        const to = mmToScreen(rn.to.x, rn.to.y);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }

    // ── Traces (copper) — rendered with glow + anti-aliased edges ───────
    for (const trace of traces) {
      const pal = LAYER_PALETTE[trace.layer] ?? LAYER_PALETTE.top;
      const isSelected = selectedTraceId === trace.id;
      const traceW = Math.max(1.5, trace.width * PX_PER_MM * zoom);

      // Outer glow (subtle copper halo)
      if (zoom > 2) {
        ctx.strokeStyle = pal.copper + '30';
        ctx.lineWidth = traceW + 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let i = 0; i < trace.segments.length; i++) {
          const s = mmToScreen(trace.segments[i].start.x, trace.segments[i].start.y);
          const e = mmToScreen(trace.segments[i].end.x, trace.segments[i].end.y);
          if (i === 0) ctx.moveTo(s.x, s.y);
          ctx.lineTo(e.x, e.y);
        }
        ctx.stroke();
      }

      // Main trace body
      ctx.strokeStyle = isSelected ? '#fbbf24' : pal.copper;
      ctx.lineWidth = traceW;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < trace.segments.length; i++) {
        const s = mmToScreen(trace.segments[i].start.x, trace.segments[i].start.y);
        const e = mmToScreen(trace.segments[i].end.x, trace.segments[i].end.y);
        if (i === 0) ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
      }
      ctx.stroke();

      // Highlight line (thin bright center for selected traces)
      if (isSelected) {
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = Math.max(1, traceW * 0.3);
        ctx.beginPath();
        for (let i = 0; i < trace.segments.length; i++) {
          const s = mmToScreen(trace.segments[i].start.x, trace.segments[i].start.y);
          const e = mmToScreen(trace.segments[i].end.x, trace.segments[i].end.y);
          if (i === 0) ctx.moveTo(s.x, s.y);
          ctx.lineTo(e.x, e.y);
        }
        ctx.stroke();
      }
    }

    // ── Vias — rendered with realistic annular ring + drill hole ────────
    for (const via of vias) {
      const v = mmToScreen(via.position.x, via.position.y);
      const r = (via.diameter / 2) * PX_PER_MM * zoom;
      const drillR = (via.drill / 2) * PX_PER_MM * zoom;

      // Outer ring (copper)
      const viaGrad = ctx.createRadialGradient(v.x, v.y, 0, v.x, v.y, r);
      viaGrad.addColorStop(0, '#d4a020');
      viaGrad.addColorStop(0.7, '#b8860b');
      viaGrad.addColorStop(1, '#8b6914');
      ctx.fillStyle = viaGrad;
      ctx.beginPath();
      ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Drill hole (dark center)
      ctx.fillStyle = '#0a0a0a';
      ctx.beginPath();
      ctx.arc(v.x, v.y, drillR, 0, Math.PI * 2);
      ctx.fill();

      // Subtle ring highlight
      ctx.strokeStyle = 'rgba(255, 220, 100, 0.4)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── Routing preview — smooth with 45° angle snapping visualization ──
    if (routingFrom && routingPath.length > 0) {
      const traceW = Math.max(1.5, defaultTraceWidth * PX_PER_MM * zoom);

      // Glow
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.3)';
      ctx.lineWidth = traceW + 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const first = mmToScreen(routingPath[0].x, routingPath[0].y);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < routingPath.length; i++) {
        const p = mmToScreen(routingPath[i].x, routingPath[i].y);
        ctx.lineTo(p.x, p.y);
      }
      // Line to cursor with 45° snap
      const lastPt = routingPath[routingPath.length - 1];
      const last = mmToScreen(lastPt.x, lastPt.y);
      const cur = mmToScreen(cursor.x, cursor.y);
      // 45° snap for preview
      const dx = cursor.x - lastPt.x;
      const dy = cursor.y - lastPt.y;
      const angle = Math.atan2(dy, dx);
      const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      const snappedEnd = {
        x: lastPt.x + Math.cos(snappedAngle) * len,
        y: lastPt.y + Math.sin(snappedAngle) * len,
      };
      const snappedScreen = mmToScreen(snappedEnd.x, snappedEnd.y);
      ctx.lineTo(snappedScreen.x, snappedScreen.y);
      ctx.stroke();

      // Main preview line
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = traceW;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < routingPath.length; i++) {
        const p = mmToScreen(routingPath[i].x, routingPath[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.lineTo(snappedScreen.x, snappedScreen.y);
      ctx.stroke();

      // Vertex points (small dots at each routing waypoint)
      ctx.fillStyle = '#fbbf24';
      for (const pt of routingPath) {
        const sp = mmToScreen(pt.x, pt.y);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Angle indicator at cursor
      const angleDeg = Math.round(snappedAngle * 180 / Math.PI);
      if (angleDeg < 0) { /* keep negative for display */ }
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${angleDeg}°`, snappedScreen.x, snappedScreen.y + 8);

      // Net name label
      if (routingFrom.net) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        const label = routingFrom.net;
        const tw = ctx.measureText(label).width + 8;
        ctx.fillRect(first.x - tw/2, first.y - 22, tw, 16);
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(label, first.x, first.y - 14);
      }
    }

    // ── Footprints — rendered with silk layer + realistic pads ─────────
    for (const fp of footprints) {
      const center = mmToScreen(fp.position.x, fp.position.y);
      const w = fp.bodySize.width * PX_PER_MM * zoom;
      const h = fp.bodySize.height * PX_PER_MM * zoom;
      const isSelected = selectedFootprintId === fp.id;
      const isCrossProbe = crossProbeComponentIds.has(fp.componentId);
      const pal = LAYER_PALETTE[fp.side] ?? LAYER_PALETTE.top;

      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate((fp.rotation * Math.PI) / 180);

      // Silkscreen body (white outline — like real PCB silk)
      if (isCrossProbe) {
        ctx.shadowColor = '#22d3ee';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = '#22d3ee';
        ctx.fillStyle = 'rgba(34, 211, 238, 0.15)';
        ctx.lineWidth = 2;
        roundedRect(ctx, -w / 2 - 1, -h / 2 - 1, w + 2, h + 2, 2);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        // Silk outline (slightly inset, white-ish)
        ctx.strokeStyle = isSelected ? '#fbbf24' : 'rgba(232, 232, 232, 0.7)';
        ctx.fillStyle = isSelected ? 'rgba(251, 191, 36, 0.1)' : 'rgba(232, 232, 232, 0.05)';
        ctx.lineWidth = isSelected ? 1.5 : 1;
        roundedRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.1);
        ctx.fill();
        ctx.stroke();
      }

      // Pin-1 indicator (small dot in corner)
      if (zoom > 1.5) {
        ctx.fillStyle = isSelected ? '#fbbf24' : 'rgba(232, 232, 232, 0.5)';
        ctx.beginPath();
        ctx.arc(-w / 2 + 3, -h / 2 + 3, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // RefDes label
      ctx.fillStyle = isSelected ? '#fbbf24' : isCrossProbe ? '#22d3ee' : 'rgba(232, 232, 232, 0.8)';
      ctx.font = `${Math.max(8, Math.min(12, 8 * zoom))}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fp.refdes, 0, 0);
      ctx.restore();

      // Pads — rendered with metallic gradient + drill hole
      for (const pad of fp.pads) {
        const p = mmToScreen(pad.position.x, pad.position.y);
        const padW = pad.size.width * PX_PER_MM * zoom;
        const padH = pad.size.height * PX_PER_MM * zoom;
        const net = padNets.get(`${pad.componentId}:${pad.terminalId}`);
        const padPal = LAYER_PALETTE[pad.layer] ?? LAYER_PALETTE.top;

        ctx.save();

        // Pad with metallic gradient
        if (pad.shape === 'circle') {
          const r = Math.max(padW, padH) / 2;
          const grad = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, 0, p.x, p.y, r);
          grad.addColorStop(0, '#e8c878');
          grad.addColorStop(0.6, padPal.copper);
          grad.addColorStop(1, padPal.copperDim);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();

          // Drill hole for THT pads
          if (pad.drill && pad.drill > 0) {
            ctx.fillStyle = '#0a0a0a';
            ctx.beginPath();
            ctx.arc(p.x, p.y, (pad.drill / 2) * PX_PER_MM * zoom, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          const grad = ctx.createLinearGradient(p.x - padW/2, p.y - padH/2, p.x + padW/2, p.y + padH/2);
          grad.addColorStop(0, '#e8c878');
          grad.addColorStop(0.5, padPal.copper);
          grad.addColorStop(1, padPal.copperDim);
          ctx.fillStyle = grad;

          // Rounded rect for SMD pads
          const r = Math.min(padW, padH) * 0.2;
          roundedRect(ctx, p.x - padW / 2, p.y - padH / 2, padW, padH, r);
          ctx.fill();

          if (pad.drill && pad.drill > 0) {
            ctx.fillStyle = '#0a0a0a';
            ctx.beginPath();
            ctx.arc(p.x, p.y, (pad.drill / 2) * PX_PER_MM * zoom, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Pad border (subtle dark outline)
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.4)';
        ctx.lineWidth = 0.5;
        if (pad.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(padW, padH) / 2, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          const r = Math.min(padW, padH) * 0.2;
          roundedRect(ctx, p.x - padW / 2, p.y - padH / 2, padW, padH, r);
          ctx.stroke();
        }

        ctx.restore();

        // Net name label
        if (showPadNets && net && zoom > 2) {
          ctx.fillStyle = '#fde047';
          ctx.font = `${Math.max(6, 6 * zoom)}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(net, p.x, p.y - padH / 2 - 6);
        }
      }
    }

    // ── Courtyard outlines ──────────────────────────────────────────────
    drawCourtyards(ctx, footprints, mmToScreen, zoom, selectedFootprintId);

    // ── Lock indicators ─────────────────────────────────────────────────
    drawLockIndicators(ctx, footprints, mmToScreen, zoom);

    // ── DRC markers (final overlay) ────────────────────────────────────
    if (drcErrors.length > 0) {
      drawDRCErrors(drcErrors, ctx, mmToScreen, hoveredDRC, zoom);
    }

    // ── Routing completion ──────────────────────────────────────────────
    const totalNets = ratsnest.length;
    const routedNets = new Set(traces.map((t) => t.net)).size;
    if (totalNets > 0) {
      drawRoutingCompletion(ctx, size.width, size.height, routedNets, totalNets);
    }

    // ── Status bar — modern dark glass ─────────────────────────────────
    const statusGrad = ctx.createLinearGradient(0, size.height - 28, 0, size.height);
    statusGrad.addColorStop(0, 'rgba(10, 20, 35, 0.9)');
    statusGrad.addColorStop(1, 'rgba(5, 10, 18, 0.95)');
    ctx.fillStyle = statusGrad;
    ctx.fillRect(0, size.height - 28, size.width, 28);
    ctx.strokeStyle = 'rgba(100, 140, 180, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, size.height - 28);
    ctx.lineTo(size.width, size.height - 28);
    ctx.stroke();

    const pal = LAYER_PALETTE[activeLayer as CopperLayer] ?? LAYER_PALETTE.top;
    ctx.fillStyle = pal.copper;
    ctx.beginPath();
    ctx.arc(12, size.height - 14, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const layerName = activeLayer === 'top' ? 'Top' : activeLayer === 'bottom' ? 'Bottom' : activeLayer;
    const drcStr = drcErrors.length > 0
      ? ` · DRC: ${drcErrors.filter(e => e.severity === 'error').length}E / ${drcErrors.filter(e => e.severity === 'warning').length}W`
      : ' · DRC: ✓ clean';
    const toolStr = tool === 'select' ? 'Select' : tool === 'route' ? 'Route' : tool === 'route45' ? 'Route 45°' : tool === 'via' ? 'Via' : tool;
    ctx.fillText(
      `${layerName} · ${toolStr} · ${cursor.x.toFixed(1)},${cursor.y.toFixed(1)}mm · ${zoom.toFixed(1)}x${drcStr}`,
      24, size.height - 14,
    );

    // Layer tabs (right side of status bar)
    if (layerStack) {
      ctx.textAlign = 'right';
      const layers = layerStack.layers;
      let xPos = size.width - 12;
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        const lp = LAYER_PALETTE[layer];
        const isActive = layer === activeLayer;
        ctx.fillStyle = isActive ? lp.copper : lp.copperDim + '60';
        ctx.beginPath();
        ctx.arc(xPos, size.height - 14, 4, 0, Math.PI * 2);
        ctx.fill();
        xPos -= 12;
      }
    }

    ctx.restore();
  }, [size, pan, zoom, board, footprints, traces, vias, ratsnest, padNets, activeLayer, tool,
      defaultTraceWidth, selectedFootprintId, selectedTraceId, routingFrom, routingPath,
      showRatsnest, showGrid, showPadNets, cursor, mmToScreen, drcErrors, copperPours, keepouts, teardrops, showKeepouts, hoveredDRC, crossProbeComponentIds, layerStack]);

  // ----- Mouse handlers (unchanged) -----
  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (e.button === 1 || e.button === 2) {
      panRef.current = { start: { x: sx, y: sy }, origin: { ...pan } };
      return;
    }
    if (tool === 'route' || tool === 'route45') {
      const is45 = tool === 'route45';
      const pad = findPadAt(sx, sy);
      const mm = screenToMm(sx, sy);
      let snapped = { x: Math.round(mm.x * 2) / 2, y: Math.round(mm.y * 2) / 2 };
      if (is45 && routingFrom) {
        const last = routingPath[routingPath.length - 1] ?? routingFrom;
        const dx = snapped.x - last.x;
        const dy = snapped.y - last.y;
        const len = Math.hypot(dx, dy);
        if (len > 0.01) {
          const angle = Math.atan2(dy, dx);
          const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
          const isDiagonal = Math.abs(Math.sin(snappedAngle)) > 0.1 && Math.abs(Math.cos(snappedAngle)) > 0.1;
          if (isDiagonal) {
            const halfLen = (Math.abs(dx) + Math.abs(dy)) / 2;
            snapped = { x: last.x + Math.sign(Math.cos(snappedAngle)) * halfLen, y: last.y + Math.sign(Math.sin(snappedAngle)) * halfLen };
          } else {
            if (Math.abs(dx) > Math.abs(dy)) snapped = { x: snapped.x, y: last.y };
            else snapped = { x: last.x, y: snapped.y };
          }
        }
      }
      if (pad) {
        const net = padNets.get(`${pad.componentId}:${pad.terminalId}`) ?? 'unrouted';
        if (!routingFrom) { startRouting({ x: pad.position.x, y: pad.position.y, net }); }
        else { addRoutingPoint(pad.position); finishRouting({ x: pad.position.x, y: pad.position.y, net }); }
      } else {
        if (routingFrom) addRoutingPoint(snapped);
      }
      return;
    }
    if (tool === 'via') { const mm = screenToMm(sx, sy); addVia({ x: mm.x, y: mm.y }, routingFrom?.net ?? 'unrouted'); return; }
    if (tool === 'keepout') { const mm = screenToMm(sx, sy); addKeepout({ x: mm.x - 2.5, y: mm.y - 2.5, width: 5, height: 5 }, 'all', 'Keepout'); return; }
    const fp = findFootprintAt(sx, sy);
    if (fp) {
      selectFootprint(fp.id);
      const mm = screenToMm(sx, sy);
      dragRef.current = { footprintId: fp.id, offset: { x: mm.x - fp.position.x, y: mm.y - fp.position.y } };
    } else {
      const mm = screenToMm(sx, sy);
      let foundTrace: string | null = null;
      for (const trace of traces) {
        for (const seg of trace.segments) {
          const dist = pointToSegmentDist(mm.x, mm.y, seg.start.x, seg.start.y, seg.end.x, seg.end.y);
          if (dist < 0.5) { foundTrace = trace.id; break; }
        }
        if (foundTrace) break;
      }
      if (foundTrace) { selectTrace(foundTrace); } else { selectFootprint(null); }
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const mm = screenToMm(sx, sy);
    setCursor({ x: mm.x, y: mm.y });
    setMousePos({ x: sx, y: sy });
    if (drcErrors.length > 0) {
      const hit = findDRCErrorAt(drcErrors, sx, sy, mmToScreen);
      setHoveredDRC((prev) => (prev === hit ? prev : hit));
    } else if (hoveredDRC !== null) { setHoveredDRC(null); }
    if (panRef.current) {
      setPan({ x: panRef.current.origin.x + (sx - panRef.current.start.x), y: panRef.current.origin.y + (sy - panRef.current.start.y) });
      return;
    }
    if (dragRef.current) {
      const mm = screenToMm(sx, sy);
      const newPos = { x: mm.x - dragRef.current.offset.x, y: mm.y - dragRef.current.offset.y };
      moveFootprint(dragRef.current.footprintId, { x: Math.round(newPos.x * 2) / 2, y: Math.round(newPos.y * 2) / 2 });
    }
  };

  const onMouseUp = () => { panRef.current = null; dragRef.current = null; };

  const handleWheel = (clientX: number, clientY: number, deltaY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(1, Math.min(10, zoom * factor));
    const mmX = (sx - pan.x) / (PX_PER_MM * zoom);
    const mmY = (sy - pan.y) / (PX_PER_MM * zoom);
    setZoom(newZoom);
    setPan({ x: sx - mmX * PX_PER_MM * newZoom, y: sy - mmY * PX_PER_MM * newZoom });
  };

  // Native non-passive wheel listener — React registers onWheel as PASSIVE
  // at the root, so a JSX handler could not preventDefault (page scrolled
  // while zooming + a console warning per wheel tick).
  const wheelCbRef = useRef(handleWheel);
  useEffect(() => { wheelCbRef.current = handleWheel; }, [handleWheel]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const listener = (e: WheelEvent) => {
      e.preventDefault();
      wheelCbRef.current(e.clientX, e.clientY, e.deltaY);
    };
    canvas.addEventListener('wheel', listener, { passive: false });
    return () => canvas.removeEventListener('wheel', listener);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never hijack keys while the user is typing in an input/dialog —
      // typing "r" in a text field used to rotate the selected footprint and
      // Backspace deleted the selected trace mid-edit.
      const target = e.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' || target.isContentEditable
      )) return;
      if (e.key === 'Escape') { cancelRouting(); selectFootprint(null); }
      else if (e.key === 'r' || e.key === 'R') { if (selectedFootprintId) rotateFootprint(selectedFootprintId); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedTraceId) usePCB.getState().deleteTrace(selectedTraceId); }
      else if (e.key === '1') setTool('select');
      else if (e.key === '2') setTool('route');
      else if (e.key === '3') setTool('via');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelRouting, selectFootprint, selectedFootprintId, rotateFootprint, selectedTraceId, setTool]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#070d15]"
      onContextMenu={(e) => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: tool === 'route' || tool === 'route45' ? 'crosshair' : tool === 'via' ? 'pointer' : 'default' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      />
      {hoveredDRC && (
        <div
          className="pointer-events-none absolute z-20 max-w-xs rounded-md border bg-slate-900/95 p-2 text-xs font-mono shadow-xl"
          style={{
            left: Math.min(mousePos.x + 14, size.width - 280),
            top: Math.min(mousePos.y + 14, size.height - 80),
            borderColor: hoveredDRC.severity === 'error' ? '#dc2626' : '#f59e0b',
          }}
        >
          <div className="flex items-center gap-1 mb-1">
            <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${hoveredDRC.severity === 'error' ? 'bg-red-600 text-white' : 'bg-amber-500 text-black'}`}>
              {hoveredDRC.severity}
            </span>
            <span className="text-slate-400">{hoveredDRC.type.replace(/_/g, ' ')}</span>
            <span className="ml-1 text-slate-500">[{hoveredDRC.layer}]</span>
          </div>
          <div className="text-slate-100 leading-snug">{hoveredDRC.message}</div>
          <div className="mt-1 text-[10px] text-slate-400">@ ({hoveredDRC.position.x.toFixed(2)}, {hoveredDRC.position.y.toFixed(2)})mm</div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Draw a rounded rectangle path (without filling or stroking) */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
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
