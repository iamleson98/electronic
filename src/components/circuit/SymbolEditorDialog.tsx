'use client';

// WYSIWYG Symbol Editor dialog.
//
// A full-screen canvas-based editor for designing new component symbols.
// The user draws rectangles (body), lines, pins (with name/number/electrical
// type/shape/length/direction), and text labels. Snap-to-grid, pan (middle /
// right mouse), and zoom (wheel) are supported. On Save, the design is
// converted to a ComponentPlugin via symbolDesignToPlugin() and registered
// with the runtime — the new part then appears in the component palette.
//
// The dialog uses the existing shadcn/ui Dialog primitive so it composes
// cleanly with the rest of the schematic UI (esc-to-close, overlay, etc.).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  MousePointer2, Pin, Square, Minus, Type, Trash2, Save, Plus,
  Grid3x3, ZoomIn, ZoomOut, FilePlus, X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ComponentPlugin, PinElecType, PinShape, Vec2 } from '@/lib/circuit/types';
import { registerPlugin } from '@/lib/circuit/registry';
import {
  type SymbolDesign, type SymbolPin, type SymbolRect, type SymbolLine,
  type SymbolText, type PinDirection,
  drawSymbolDesign, computeDesignBoundingBox, symbolDesignToPlugin,
  sampleOpAmpDesign, blankDesign,
  PIN_ELEC_TYPE_LABELS, PIN_SHAPE_LABELS, PIN_ELEC_TYPE_COLOR,
} from '@/lib/circuit/symbol-editor-types';

const CELL_SIZE = 24; // pixels per grid unit (matches main CircuitCanvas)

type Tool = 'select' | 'pin' | 'rectangle' | 'line' | 'text' | 'delete';

interface Camera { x: number; y: number; zoom: number; }

interface DragState {
  kind: 'pin' | 'rect' | 'line' | 'text';
  id: string;
  /** grid-space offset from cursor to the element's anchor */
  offset: Vec2;
  /** for line drags: which endpoint is being moved */
  lineEndpoint?: 'from' | 'to';
}

interface DrawDraft {
  kind: 'rect' | 'line';
  startGrid: Vec2;
  currentGrid: Vec2;
}

interface PanState {
  startScreen: Vec2;
  startPan: Camera;
}

let idCounter = 0;
function makeId(prefix: string) {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after the plugin is registered. Parent can use this to refresh UI. */
  onSaved?: (plugin: ComponentPlugin) => void;
  /** Optional initial design — for "edit existing symbol" workflows. */
  initialDesign?: SymbolDesign;
}

export function SymbolEditorDialog({ open, onClose, onSaved, initialDesign }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  // Design state — the symbol being edited
  const [design, setDesign] = useState<SymbolDesign>(() => initialDesign ?? sampleOpAmpDesign());

  // Tool + selection + view
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 80, y: 80, zoom: 1 });
  const [showGrid, setShowGrid] = useState(true);
  const [showPinNumbers, setShowPinNumbers] = useState(true);
  const [showPinNames, setShowPinNames] = useState(true);

  // Interaction state
  const [drag, setDrag] = useState<DragState | null>(null);
  const [draft, setDraft] = useState<DrawDraft | null>(null);
  const [pan, setPan] = useState<PanState | null>(null);
  const [hoverGrid, setHoverGrid] = useState<Vec2>({ x: 0, y: 0 });

  // Keep refs in sync for use inside event handlers without re-binding them
  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<DrawDraft | null>(null);
  const panRef = useRef<PanState | null>(null);
  const toolRef = useRef<Tool>(tool);
  const cameraRef = useRef<Camera>(camera);
  const designRef = useRef<SymbolDesign>(design);
  const selectedIdRef = useRef<string | null>(selectedId);
  useEffect(() => { dragRef.current = drag; }, [drag]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { panRef.current = pan; }, [pan]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { cameraRef.current = camera; }, [camera]);
  useEffect(() => { designRef.current = design; }, [design]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // Resize observer for canvas
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

  // Load initialDesign when it changes
  useEffect(() => {
    if (open && initialDesign) {
      setDesign(initialDesign);
      setSelectedId(null);
    }
  }, [open, initialDesign]);

  // ── Coordinate helpers ──────────────────────────────────────────────
  const screenToGrid = useCallback((sx: number, sy: number): Vec2 => {
    const cam = cameraRef.current;
    const x = (sx - cam.x) / (CELL_SIZE * cam.zoom);
    const y = (sy - cam.y) / (CELL_SIZE * cam.zoom);
    return { x: Math.round(x), y: Math.round(y) };
  }, []);

  const gridToScreen = useCallback((gx: number, gy: number): Vec2 => {
    const cam = cameraRef.current;
    return { x: gx * CELL_SIZE * cam.zoom + cam.x, y: gy * CELL_SIZE * cam.zoom + cam.y };
  }, []);

  // ── Element hit-testing ──────────────────────────────────────────────
  const hitTest = useCallback((grid: Vec2): string | null => {
    const d = designRef.current;
    const tol = 0.4; // grid units
    // Pins first — they're the most-interactive element
    for (const p of d.pins) {
      if (Math.abs(p.position.x - grid.x) <= tol && Math.abs(p.position.y - grid.y) <= tol) {
        return p.id;
      }
    }
    // Texts
    for (const t of [...d.texts].reverse()) {
      // Approximate text bbox: 1 unit tall, len*0.5 wide
      const w = Math.max(1.5, t.text.length * 0.5);
      const h = 1;
      if (grid.x >= t.position.x - tol && grid.x <= t.position.x + w + tol &&
          grid.y >= t.position.y - tol && grid.y <= t.position.y + h + tol) {
        return t.id;
      }
    }
    // Lines (point-to-segment distance)
    for (const l of [...d.lines].reverse()) {
      const dx = l.to.x - l.from.x;
      const dy = l.to.y - l.from.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((grid.x - l.from.x) * dx + (grid.y - l.from.y) * dy) / len2));
      const cx = l.from.x + t * dx;
      const cy = l.from.y + t * dy;
      const dist = Math.hypot(grid.x - cx, grid.y - cy);
      if (dist <= tol) return l.id;
    }
    // Rects (inside-or-edge test)
    for (const r of [...d.rects].reverse()) {
      if (grid.x >= r.position.x - tol && grid.x <= r.position.x + r.size.width + tol &&
          grid.y >= r.position.y - tol && grid.y <= r.position.y + r.size.height + tol) {
        return r.id;
      }
    }
    return null;
  }, []);

  // ── Drawing ─────────────────────────────────────────────────────────
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
    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, size.width, size.height);

    // Grid
    if (showGrid) {
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      const stepPx = CELL_SIZE * camera.zoom;
      const startX = ((camera.x % stepPx) + stepPx) % stepPx;
      const startY = ((camera.y % stepPx) + stepPx) % stepPx;
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
      // Origin marker
      ctx.fillStyle = '#475569';
      ctx.fillRect(camera.x - 1, camera.y - 1, 3, 3);
    }

    // Bounding-box outline (KiCad-style dashed)
    {
      const bb = design.boundingBox;
      const tl = gridToScreen(0, 0);
      const w = bb.width * CELL_SIZE * camera.zoom;
      const h = bb.height * CELL_SIZE * camera.zoom;
      ctx.save();
      ctx.strokeStyle = '#334155';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(tl.x, tl.y, w, h);
      ctx.restore();
    }

    // Symbol body (translated to origin, scaled by zoom * CELL_SIZE)
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);
    drawSymbolDesign(ctx, design, CELL_SIZE, {
      selectedId,
      showPinNumbers,
      showPinNames,
    });
    ctx.restore();

    // Drawing draft (rubber-band for new rect/line)
    if (draft) {
      const a = gridToScreen(draft.startGrid.x, draft.startGrid.y);
      const b = gridToScreen(draft.currentGrid.x, draft.currentGrid.y);
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      if (draft.kind === 'rect') {
        ctx.strokeRect(
          Math.min(a.x, b.x), Math.min(a.y, b.y),
          Math.abs(b.x - a.x), Math.abs(b.y - a.y),
        );
      } else {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Hovered grid crosshair (when a drawing tool is active)
    if (tool === 'rectangle' || tool === 'line' || tool === 'pin' || tool === 'text') {
      const hp = gridToScreen(hoverGrid.x, hoverGrid.y);
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.fillStyle = '#fbbf24';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // HUD: zoom %, grid coords
    ctx.save();
    ctx.fillStyle = '#475569';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`zoom ${(camera.zoom * 100).toFixed(0)}%  ·  grid (${hoverGrid.x.toFixed(1)}, ${hoverGrid.y.toFixed(1)})  ·  tool: ${tool}`, 8, size.height - 18);
    ctx.restore();

    ctx.restore();
  }, [size, camera, showGrid, design, selectedId, draft, tool, hoverGrid, showPinNumbers, showPinNames, gridToScreen]);

  // ── Element creation helpers ────────────────────────────────────────
  const addPinAt = useCallback((grid: Vec2) => {
    const pin: SymbolPin = {
      id: makeId('pin'),
      position: grid,
      label: 'P?',
      name: '',
      number: String(designRef.current.pins.length + 1),
      electricalType: 'passive',
      shape: 'line',
      length: 1,
      direction: 'left',
    };
    setDesign((d) => {
      const next = { ...d, pins: [...d.pins, pin] };
      next.boundingBox = computeDesignBoundingBox(next);
      return next;
    });
    setSelectedId(pin.id);
    setTool('select');
  }, []);

  const addTextAt = useCallback((grid: Vec2) => {
    const txt: SymbolText = {
      id: makeId('txt'),
      position: grid,
      text: 'label',
      color: '#e2e8f0',
      fontSize: 12,
    };
    setDesign((d) => {
      const next = { ...d, texts: [...d.texts, txt] };
      next.boundingBox = computeDesignBoundingBox(next);
      return next;
    });
    setSelectedId(txt.id);
    setTool('select');
  }, []);

  const finalizeDraft = useCallback(() => {
    const dr = draftRef.current;
    if (!dr) return;
    if (dr.kind === 'rect') {
      // Reject zero-size rects
      if (Math.abs(dr.currentGrid.x - dr.startGrid.x) < 0.5 ||
          Math.abs(dr.currentGrid.y - dr.startGrid.y) < 0.5) {
        setDraft(null);
        return;
      }
      const x = Math.min(dr.startGrid.x, dr.currentGrid.x);
      const y = Math.min(dr.startGrid.y, dr.currentGrid.y);
      const w = Math.abs(dr.currentGrid.x - dr.startGrid.x);
      const h = Math.abs(dr.currentGrid.y - dr.startGrid.y);
      const rect: SymbolRect = {
        id: makeId('rect'),
        position: { x, y },
        size: { width: w, height: h },
        strokeColor: '#22c55e',
        fillColor: 'transparent',
      };
      setDesign((d) => {
        const next = { ...d, rects: [...d.rects, rect] };
        next.boundingBox = computeDesignBoundingBox(next);
        return next;
      });
      setSelectedId(rect.id);
    } else {
      // Line — allow even if very short (sometimes the user wants a tiny line)
      const line: SymbolLine = {
        id: makeId('line'),
        from: { ...dr.startGrid },
        to: { ...dr.currentGrid },
        color: '#22d3ee',
        width: 1.5,
      };
      setDesign((d) => {
        const next = { ...d, lines: [...d.lines, line] };
        next.boundingBox = computeDesignBoundingBox(next);
        return next;
      });
      setSelectedId(line.id);
    }
    setDraft(null);
    setTool('select');
  }, []);

  // ── Mouse handlers ──────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || e.button === 2) {
      // Middle / right button — start panning
      e.preventDefault();
      setPan({ startScreen: { x: e.clientX, y: e.clientY }, startPan: { ...cameraRef.current } });
      return;
    }
    if (e.button !== 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const grid = screenToGrid(sx, sy);
    const t = toolRef.current;

    if (t === 'select' || t === 'delete') {
      const hit = hitTest(grid);
      if (hit) {
        if (t === 'delete') {
          setDesign((d) => {
            const next: SymbolDesign = {
              ...d,
              pins: d.pins.filter((p) => p.id !== hit),
              rects: d.rects.filter((r) => r.id !== hit),
              lines: d.lines.filter((l) => l.id !== hit),
              texts: d.texts.filter((t2) => t2.id !== hit),
            };
            next.boundingBox = computeDesignBoundingBox(next);
            return next;
          });
          setSelectedId(null);
          return;
        }
        // Select + start drag
        setSelectedId(hit);
        // Compute offset based on element type
        const d = designRef.current;
        const pin = d.pins.find((p) => p.id === hit);
        const rct = d.rects.find((r) => r.id === hit);
        const lin = d.lines.find((l) => l.id === hit);
        const txt = d.texts.find((t2) => t2.id === hit);
        if (pin) {
          setDrag({ kind: 'pin', id: hit, offset: { x: pin.position.x - grid.x, y: pin.position.y - grid.y } });
        } else if (rct) {
          setDrag({ kind: 'rect', id: hit, offset: { x: rct.position.x - grid.x, y: rct.position.y - grid.y } });
        } else if (txt) {
          setDrag({ kind: 'text', id: hit, offset: { x: txt.position.x - grid.x, y: txt.position.y - grid.y } });
        } else if (lin) {
          // Drag the closer endpoint of the line
          const dFrom = Math.hypot(lin.from.x - grid.x, lin.from.y - grid.y);
          const dTo = Math.hypot(lin.to.x - grid.x, lin.to.y - grid.y);
          const endpoint = dFrom <= dTo ? 'from' : 'to';
          const anchor = endpoint === 'from' ? lin.from : lin.to;
          setDrag({
            kind: 'line',
            id: hit,
            offset: { x: anchor.x - grid.x, y: anchor.y - grid.y },
            lineEndpoint: endpoint,
          });
        }
      } else {
        setSelectedId(null);
      }
      return;
    }

    if (t === 'pin') {
      addPinAt(grid);
      return;
    }
    if (t === 'text') {
      addTextAt(grid);
      return;
    }
    if (t === 'rectangle' || t === 'line') {
      setDraft({ kind: t === 'rectangle' ? 'rect' : 'line', startGrid: grid, currentGrid: grid });
      return;
    }
  }, [screenToGrid, hitTest, addPinAt, addTextAt]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const grid = screenToGrid(sx, sy);
    setHoverGrid(grid);

    const p = panRef.current;
    if (p) {
      const dx = e.clientX - p.startScreen.x;
      const dy = e.clientY - p.startScreen.y;
      setCamera({ ...p.startPan, x: p.startPan.x + dx, y: p.startPan.y + dy });
      return;
    }
    const dr = dragRef.current;
    if (dr) {
      const newGrid = { x: grid.x + dr.offset.x, y: grid.y + dr.offset.y };
      setDesign((d) => {
        if (dr.kind === 'pin') {
          return { ...d, pins: d.pins.map((p) => p.id === dr.id ? { ...p, position: newGrid } : p) };
        }
        if (dr.kind === 'rect') {
          return { ...d, rects: d.rects.map((r) => r.id === dr.id ? { ...r, position: newGrid } : r) };
        }
        if (dr.kind === 'text') {
          return { ...d, texts: d.texts.map((t) => t.id === dr.id ? { ...t, position: newGrid } : t) };
        }
        // Line — move the captured endpoint only (no flip mid-drag)
        const ep = dr.lineEndpoint ?? 'from';
        return {
          ...d,
          lines: d.lines.map((l) => l.id !== dr.id ? l : { ...l, [ep]: newGrid }),
        };
      });
      return;
    }
    const df = draftRef.current;
    if (df) {
      setDraft({ ...df, currentGrid: grid });
      return;
    }
  }, [screenToGrid]);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (panRef.current) {
      setPan(null);
      return;
    }
    if (dragRef.current) {
      // Re-fit bounding box after a move
      setDesign((d) => ({ ...d, boundingBox: computeDesignBoundingBox(d) }));
      setDrag(null);
      return;
    }
    if (draftRef.current) {
      finalizeDraft();
      return;
    }
    void e;
  }, [finalizeDraft]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const cam = cameraRef.current;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = clamp(cam.zoom * factor, 0.2, 6);
    // Zoom around cursor — keep grid point under cursor fixed
    const gx = (sx - cam.x) / (CELL_SIZE * cam.zoom);
    const gy = (sy - cam.y) / (CELL_SIZE * cam.zoom);
    const newX = sx - gx * CELL_SIZE * newZoom;
    const newY = sy - gy * CELL_SIZE * newZoom;
    setCamera({ x: newX, y: newY, zoom: newZoom });
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const grid = screenToGrid(sx, sy);
    const hit = hitTest(grid);
    if (hit) {
      setSelectedId(hit);
      // Focus the first input in the right panel by dispatching a custom event
      // the property panel listens for.
      window.dispatchEvent(new CustomEvent('symbol-editor:focus-pin'));
    }
  }, [screenToGrid, hitTest]);

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
  }, []);

  // ── Element update helpers (right panel) ────────────────────────────
  const updatePin = useCallback((id: string, patch: Partial<SymbolPin>) => {
    setDesign((d) => ({
      ...d,
      pins: d.pins.map((p) => p.id === id ? { ...p, ...patch } : p),
    }));
  }, []);
  const updateRect = useCallback((id: string, patch: Partial<SymbolRect>) => {
    setDesign((d) => {
      const next = { ...d, rects: d.rects.map((r) => r.id === id ? { ...r, ...patch } : r) };
      next.boundingBox = computeDesignBoundingBox(next);
      return next;
    });
  }, []);
  const updateLine = useCallback((id: string, patch: Partial<SymbolLine>) => {
    setDesign((d) => {
      const next = { ...d, lines: d.lines.map((l) => l.id === id ? { ...l, ...patch } : l) };
      next.boundingBox = computeDesignBoundingBox(next);
      return next;
    });
  }, []);
  const updateText = useCallback((id: string, patch: Partial<SymbolText>) => {
    setDesign((d) => ({ ...d, texts: d.texts.map((t) => t.id === id ? { ...t, ...patch } : t) }));
  }, []);
  const updateDesignMeta = useCallback((patch: Partial<SymbolDesign>) => {
    setDesign((d) => ({ ...d, ...patch }));
  }, []);

  const deleteElement = useCallback((id: string) => {
    setDesign((d) => {
      const next: SymbolDesign = {
        ...d,
        pins: d.pins.filter((p) => p.id !== id),
        rects: d.rects.filter((r) => r.id !== id),
        lines: d.lines.filter((l) => l.id !== id),
        texts: d.texts.filter((t) => t.id !== id),
      };
      next.boundingBox = computeDesignBoundingBox(next);
      return next;
    });
    setSelectedId(null);
  }, []);

  // ── Save ────────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    const d = designRef.current;
    if (!d.name.trim()) {
      toast.error('Please enter a component name');
      return;
    }
    if (!d.type.trim()) {
      toast.error('Please enter a Type ID');
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/i.test(d.type)) {
      toast.error('Type ID must start with a letter and contain only letters/digits/underscores');
      return;
    }
    if (d.pins.length === 0) {
      toast.error('Symbol must have at least one pin');
      return;
    }
    try {
      const plugin = symbolDesignToPlugin({
        ...d,
        type: d.type.toLowerCase(),
      });
      registerPlugin(plugin);
      // Notify any listening UI (e.g. ComponentPalette) that a new plugin
      // is available so they re-fetch the registry.
      window.dispatchEvent(new CustomEvent('circuitlab:plugin-registered'));
      toast.success(`Symbol "${plugin.name}" registered (${plugin.terminals.length} pins)`, {
        description: `Find "${plugin.name}" in the component palette under "IC" category`,
      });
      onSaved?.(plugin);
      onClose();
    } catch (err) {
      toast.error('Failed to register symbol: ' + (err as Error).message);
    }
  }, [onClose, onSaved]);

  const handleNew = useCallback(() => {
    if (!confirm('Discard current symbol and start fresh?')) return;
    setDesign(blankDesign());
    setSelectedId(null);
    setCamera({ x: 80, y: 80, zoom: 1 });
  }, []);

  const handleLoadSample = useCallback(() => {
    setDesign(sampleOpAmpDesign());
    setSelectedId(null);
    setCamera({ x: 80, y: 80, zoom: 1 });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setCamera((c) => {
      const newZoom = clamp(c.zoom * factor, 0.2, 6);
      // Zoom around canvas centre
      const cx = size.width / 2;
      const cy = size.height / 2;
      const gx = (cx - c.x) / (CELL_SIZE * c.zoom);
      const gy = (cy - c.y) / (CELL_SIZE * c.zoom);
      return { x: cx - gx * CELL_SIZE * newZoom, y: cy - gy * CELL_SIZE * newZoom, zoom: newZoom };
    });
  }, [size]);

  // Find the selected element for the right panel
  const selectedElement = useMemo(() => {
    if (!selectedId) return null;
    const d = design;
    const pin = d.pins.find((p) => p.id === selectedId);
    if (pin) return { kind: 'pin' as const, el: pin };
    const rct = d.rects.find((r) => r.id === selectedId);
    if (rct) return { kind: 'rect' as const, el: rct };
    const lin = d.lines.find((l) => l.id === selectedId);
    if (lin) return { kind: 'line' as const, el: lin };
    const txt = d.texts.find((t) => t.id === selectedId);
    if (txt) return { kind: 'text' as const, el: txt };
    return null;
  }, [selectedId, design]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-none w-screen h-screen sm:max-w-none p-0 gap-0 rounded-none border-slate-700 bg-slate-950 text-slate-100"
      >
        <DialogTitle className="sr-only">Symbol Editor</DialogTitle>
        <DialogDescription className="sr-only">
          Design a new component symbol by drawing rectangles, lines, pins, and text labels.
        </DialogDescription>

        <div className="flex h-screen w-screen flex-col">
          {/* Top toolbar */}
          <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-900 px-3 py-2">
            <div className="mr-2 flex items-center gap-2 pr-3">
              <div className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-cyan-400 to-emerald-500 text-slate-900">
                <Pin size={16} strokeWidth={2.5} />
              </div>
              <span className="hidden text-sm font-semibold text-slate-100 sm:inline">Symbol Editor</span>
            </div>

            <Button size="sm" variant="ghost" onClick={handleNew} title="New (clear)">
              <FilePlus size={14} />
              <span className="ml-1 hidden md:inline">New</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={handleLoadSample} title="Load sample op-amp">
              <Plus size={14} />
              <span className="ml-1 hidden md:inline">Sample</span>
            </Button>
            <Button
              size="sm"
              className="bg-emerald-500 text-slate-900 hover:bg-emerald-400"
              onClick={handleSave}
            >
              <Save size={14} />
              <span className="ml-1">Save</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              <X size={14} />
              <span className="ml-1 hidden md:inline">Cancel</span>
            </Button>

            <div className="mx-2 h-5 w-px bg-slate-700" />

            {/* Grid toggle */}
            <div className="flex items-center gap-2 px-1">
              <Grid3x3 size={14} className="text-slate-400" />
              <Switch checked={showGrid} onCheckedChange={setShowGrid} />
            </div>
            <div className="flex items-center gap-2 px-1">
              <span className="hidden text-xs text-slate-400 sm:inline">#</span>
              <Switch checked={showPinNumbers} onCheckedChange={setShowPinNumbers} title="Show pin numbers" />
            </div>
            <div className="flex items-center gap-2 px-1">
              <span className="hidden text-xs text-slate-400 sm:inline">name</span>
              <Switch checked={showPinNames} onCheckedChange={setShowPinNames} title="Show pin names" />
            </div>

            <div className="mx-2 h-5 w-px bg-slate-700" />

            <Button size="sm" variant="ghost" onClick={() => zoomBy(1.2)} title="Zoom in">
              <ZoomIn size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
              <ZoomOut size={14} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCamera({ x: 80, y: 80, zoom: 1 })}
              title="Reset view"
            >
              <span className="text-xs">{(camera.zoom * 100).toFixed(0)}%</span>
            </Button>
          </div>

          {/* Body: left toolbar | canvas | right panel */}
          <div className="flex min-h-0 flex-1">
            {/* Left toolbar */}
            <div className="flex w-12 flex-col items-center gap-1 border-r border-slate-800 bg-slate-900 py-2">
              <ToolButton active={tool === 'select'} onClick={() => setTool('select')} icon={<MousePointer2 size={16} />} label="Select / Move" />
              <ToolButton active={tool === 'pin'} onClick={() => setTool('pin')} icon={<Pin size={16} />} label="Add Pin" />
              <ToolButton active={tool === 'rectangle'} onClick={() => setTool('rectangle')} icon={<Square size={16} />} label="Add Rectangle" />
              <ToolButton active={tool === 'line'} onClick={() => setTool('line')} icon={<Minus size={16} />} label="Add Line" />
              <ToolButton active={tool === 'text'} onClick={() => setTool('text')} icon={<Type size={16} />} label="Add Text" />
              <div className="my-1 h-px w-8 bg-slate-700" />
              <ToolButton
                active={tool === 'delete'}
                onClick={() => setTool('delete')}
                icon={<Trash2 size={16} />}
                label="Delete (click element)"
                danger
              />
            </div>

            {/* Canvas */}
            <div ref={containerRef} className="relative min-h-0 flex-1 bg-slate-950">
              <canvas
                ref={canvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onWheel={onWheel}
                onDoubleClick={onDoubleClick}
                onContextMenu={onContextMenu}
                className="block h-full w-full cursor-crosshair"
                style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
              />
              {/* Floating hint */}
              <div className="pointer-events-none absolute bottom-2 left-2 text-[10px] text-slate-500">
                <div>left-click: place / select  ·  drag: move  ·  dbl-click: edit pin  ·  wheel: zoom  ·  middle/right: pan</div>
              </div>
            </div>

            {/* Right properties panel */}
            <div className="w-80 shrink-0 border-l border-slate-800 bg-slate-900">
              <ScrollArea className="h-full">
                <div className="p-3">
                  {selectedElement ? (
                    <SelectedElementEditor
                      selected={selectedElement}
                      onUpdatePin={updatePin}
                      onUpdateRect={updateRect}
                      onUpdateLine={updateLine}
                      onUpdateText={updateText}
                      onDelete={deleteElement}
                    />
                  ) : (
                    <DesignMetaEditor design={design} onUpdate={updateDesignMeta} />
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ToolButton({
  active, onClick, icon, label, danger,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
        active
          ? danger
            ? 'bg-rose-600 text-white'
            : 'bg-emerald-500 text-slate-900'
          : danger
            ? 'text-rose-400 hover:bg-slate-800 hover:text-rose-300'
            : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
      }`}
    >
      {icon}
    </button>
  );
}

function DesignMetaEditor({
  design, onUpdate,
}: {
  design: SymbolDesign;
  onUpdate: (patch: Partial<SymbolDesign>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        Symbol Properties
      </div>
      <div>
        <Label className="text-xs text-slate-400">Component Name</Label>
        <Input
          value={design.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="My Op-Amp"
          className="mt-1 bg-slate-800 border-slate-700 text-sm"
        />
      </div>
      <div>
        <Label className="text-xs text-slate-400">Type ID (unique)</Label>
        <Input
          value={design.type}
          onChange={(e) => onUpdate({ type: e.target.value })}
          placeholder="myOpamp"
          className="mt-1 bg-slate-800 border-slate-700 text-sm font-mono"
        />
        <p className="mt-1 text-[10px] text-slate-500">
          Must start with a letter; letters/digits/underscores only.
        </p>
      </div>
      <div>
        <Label className="text-xs text-slate-400">Description</Label>
        <Input
          value={design.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="Custom op-amp symbol"
          className="mt-1 bg-slate-800 border-slate-700 text-sm"
        />
      </div>
      <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Bounding Box (auto-fit)
        </div>
        <div className="mt-1 font-mono text-xs text-slate-300">
          {design.boundingBox.width.toFixed(1)} × {design.boundingBox.height.toFixed(1)} grid units
        </div>
      </div>
      <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2 text-[10px] text-slate-400">
        <div className="font-semibold uppercase tracking-wider text-slate-500 mb-1">Stats</div>
        <div>Pins: {design.pins.length}</div>
        <div>Rects: {design.rects.length}</div>
        <div>Lines: {design.lines.length}</div>
        <div>Texts: {design.texts.length}</div>
      </div>
      <div className="rounded-md border border-cyan-900/40 bg-cyan-950/20 p-2 text-[10px] text-cyan-300">
        Click a tool on the left, then click on the canvas to add an element.
        Use the Select tool to drag elements around.
      </div>
    </div>
  );
}

function SelectedElementEditor({
  selected, onUpdatePin, onUpdateRect, onUpdateLine, onUpdateText, onDelete,
}: {
  selected:
    | { kind: 'pin'; el: SymbolPin }
    | { kind: 'rect'; el: SymbolRect }
    | { kind: 'line'; el: SymbolLine }
    | { kind: 'text'; el: SymbolText };
  onUpdatePin: (id: string, patch: Partial<SymbolPin>) => void;
  onUpdateRect: (id: string, patch: Partial<SymbolRect>) => void;
  onUpdateLine: (id: string, patch: Partial<SymbolLine>) => void;
  onUpdateText: (id: string, patch: Partial<SymbolText>) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          {selected.kind === 'pin' ? 'Pin' :
            selected.kind === 'rect' ? 'Rectangle' :
            selected.kind === 'line' ? 'Line' : 'Text'}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-rose-400 hover:bg-rose-950/40 hover:text-rose-300"
          onClick={() => onDelete(selected.el.id)}
          title="Delete this element"
        >
          <Trash2 size={12} className="mr-1" />
          Delete
        </Button>
      </div>

      {selected.kind === 'pin' && (
        <PinEditor pin={selected.el} onUpdate={(patch) => onUpdatePin(selected.el.id, patch)} />
      )}
      {selected.kind === 'rect' && (
        <RectEditor rect={selected.el} onUpdate={(patch) => onUpdateRect(selected.el.id, patch)} />
      )}
      {selected.kind === 'line' && (
        <LineEditor line={selected.el} onUpdate={(patch) => onUpdateLine(selected.el.id, patch)} />
      )}
      {selected.kind === 'text' && (
        <TextEditor txt={selected.el} onUpdate={(patch) => onUpdateText(selected.el.id, patch)} />
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs text-slate-400">{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function NumInput({
  value, onChange, step = 0.5,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <Input
      type="number"
      value={value}
      step={step}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
      className="h-8 bg-slate-800 border-slate-700 text-xs font-mono"
    />
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value.startsWith('#') ? value : '#22c55e'}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-10 rounded border border-slate-700 bg-slate-800"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 flex-1 bg-slate-800 border-slate-700 text-xs font-mono"
      />
    </div>
  );
}

function PinEditor({
  pin, onUpdate,
}: {
  pin: SymbolPin;
  onUpdate: (patch: Partial<SymbolPin>) => void;
}) {
  const elecColor = PIN_ELEC_TYPE_COLOR[pin.electricalType] ?? '#94a3b8';
  return (
    <div className="space-y-3">
      {/* Pin preview */}
      <div className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/50 p-2">
        <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: elecColor }} />
        <div className="font-mono text-xs text-slate-300">
          {pin.label || '(no label)'} · #{pin.number || '?'}
        </div>
      </div>

      <FieldRow label="Label (next to pin)">
        <Input
          value={pin.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          className="h-8 bg-slate-800 border-slate-700 text-xs"
        />
      </FieldRow>
      <FieldRow label="Name (inside body)">
        <Input
          value={pin.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="h-8 bg-slate-800 border-slate-700 text-xs"
        />
      </FieldRow>
      <FieldRow label="Pin Number">
        <Input
          value={pin.number}
          onChange={(e) => onUpdate({ number: e.target.value })}
          className="h-8 bg-slate-800 border-slate-700 text-xs font-mono"
        />
      </FieldRow>

      <FieldRow label="Electrical Type">
        <Select
          value={pin.electricalType}
          onValueChange={(v) => onUpdate({ electricalType: v as PinElecType })}
        >
          <SelectTrigger className="h-8 bg-slate-800 border-slate-700 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-700">
            {PIN_ELEC_TYPE_LABELS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs text-slate-200">
                <span className="mr-2 inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: PIN_ELEC_TYPE_COLOR[o.value] }} />
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow label="Graphical Shape">
        <Select
          value={pin.shape}
          onValueChange={(v) => onUpdate({ shape: v as PinShape })}
        >
          <SelectTrigger className="h-8 bg-slate-800 border-slate-700 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-700">
            {PIN_SHAPE_LABELS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs text-slate-200">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow label="Direction">
        <Select
          value={pin.direction ?? 'left'}
          onValueChange={(v) => onUpdate({ direction: v as PinDirection })}
        >
          <SelectTrigger className="h-8 bg-slate-800 border-slate-700 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-700">
            <SelectItem value="left" className="text-xs text-slate-200">Left ←</SelectItem>
            <SelectItem value="right" className="text-xs text-slate-200">Right →</SelectItem>
            <SelectItem value="up" className="text-xs text-slate-200">Up ↑</SelectItem>
            <SelectItem value="down" className="text-xs text-slate-200">Down ↓</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow label="Length (grid units)">
        <NumInput value={pin.length} onChange={(v) => onUpdate({ length: Math.max(0, v) })} step={0.5} />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Pos X">
          <NumInput value={pin.position.x} onChange={(v) => onUpdate({ position: { ...pin.position, x: v } })} step={0.5} />
        </FieldRow>
        <FieldRow label="Pos Y">
          <NumInput value={pin.position.y} onChange={(v) => onUpdate({ position: { ...pin.position, y: v } })} step={0.5} />
        </FieldRow>
      </div>
    </div>
  );
}

function RectEditor({
  rect, onUpdate,
}: {
  rect: SymbolRect;
  onUpdate: (patch: Partial<SymbolRect>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Pos X">
          <NumInput value={rect.position.x} onChange={(v) => onUpdate({ position: { ...rect.position, x: v } })} />
        </FieldRow>
        <FieldRow label="Pos Y">
          <NumInput value={rect.position.y} onChange={(v) => onUpdate({ position: { ...rect.position, y: v } })} />
        </FieldRow>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Width">
          <NumInput value={rect.size.width} onChange={(v) => onUpdate({ size: { ...rect.size, width: Math.max(0.5, v) } })} />
        </FieldRow>
        <FieldRow label="Height">
          <NumInput value={rect.size.height} onChange={(v) => onUpdate({ size: { ...rect.size, height: Math.max(0.5, v) } })} />
        </FieldRow>
      </div>
      <FieldRow label="Stroke Color">
        <ColorInput value={rect.strokeColor} onChange={(v) => onUpdate({ strokeColor: v })} />
      </FieldRow>
      <FieldRow label="Fill Color (or 'transparent')">
        <ColorInput value={rect.fillColor} onChange={(v) => onUpdate({ fillColor: v })} />
      </FieldRow>
    </div>
  );
}

function LineEditor({
  line, onUpdate,
}: {
  line: SymbolLine;
  onUpdate: (patch: Partial<SymbolLine>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="From X">
          <NumInput value={line.from.x} onChange={(v) => onUpdate({ from: { ...line.from, x: v } })} />
        </FieldRow>
        <FieldRow label="From Y">
          <NumInput value={line.from.y} onChange={(v) => onUpdate({ from: { ...line.from, y: v } })} />
        </FieldRow>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="To X">
          <NumInput value={line.to.x} onChange={(v) => onUpdate({ to: { ...line.to, x: v } })} />
        </FieldRow>
        <FieldRow label="To Y">
          <NumInput value={line.to.y} onChange={(v) => onUpdate({ to: { ...line.to, y: v } })} />
        </FieldRow>
      </div>
      <FieldRow label="Color">
        <ColorInput value={line.color} onChange={(v) => onUpdate({ color: v })} />
      </FieldRow>
      <FieldRow label="Width">
        <NumInput value={line.width} onChange={(v) => onUpdate({ width: Math.max(0.5, v) })} step={0.5} />
      </FieldRow>
    </div>
  );
}

function TextEditor({
  txt, onUpdate,
}: {
  txt: SymbolText;
  onUpdate: (patch: Partial<SymbolText>) => void;
}) {
  return (
    <div className="space-y-3">
      <FieldRow label="Text">
        <Input
          value={txt.text}
          onChange={(e) => onUpdate({ text: e.target.value })}
          className="h-8 bg-slate-800 border-slate-700 text-xs"
        />
      </FieldRow>
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Pos X">
          <NumInput value={txt.position.x} onChange={(v) => onUpdate({ position: { ...txt.position, x: v } })} />
        </FieldRow>
        <FieldRow label="Pos Y">
          <NumInput value={txt.position.y} onChange={(v) => onUpdate({ position: { ...txt.position, y: v } })} />
        </FieldRow>
      </div>
      <FieldRow label="Font Size (px at 100% zoom)">
        <NumInput value={txt.fontSize} onChange={(v) => onUpdate({ fontSize: Math.max(6, v) })} step={1} />
      </FieldRow>
      <FieldRow label="Color">
        <ColorInput value={txt.color} onChange={(v) => onUpdate({ color: v })} />
      </FieldRow>
    </div>
  );
}
