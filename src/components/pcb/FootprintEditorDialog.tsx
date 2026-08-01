'use client';

// WYSIWYG Footprint Editor dialog.
//
// A full-screen canvas-based editor for designing PCB footprints (pad layouts).
// The user sets the body outline size, places pads (circle / rect / oval) at any
// mm coordinate, configures each pad's layer (top/bottom), drill diameter, and
// terminal ID, then saves the design as a `FootprintDef` that gets registered
// in the runtime footprint registry so it can be used by the netlist-sync
// pipeline (placed components take on this footprint definition).
//
// Canvas conventions match `PCBCanvas.tsx`:
//   - PX_PER_MM = 8 px/mm at zoom = 1
//   - Pan via middle / right mouse, zoom via wheel (cursor-anchored)
//   - Coordinates are in millimetres (mm) relative to footprint center
//   - Snap to 0.1 mm grid (finer than the 0.5 mm routing grid on the main PCB)
//
// The dialog uses the existing shadcn/ui Dialog primitive so it composes
// cleanly with the rest of the PCB UI (esc-to-close, overlay, etc.).

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
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MousePointer2, Circle as CircleIcon, Square, Pill, Frame, Trash2, Save,
  Plus, Grid3x3, ZoomIn, ZoomOut, FilePlus, X, ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import type { CopperLayer, FootprintDef, FootprintPadDef } from '@/lib/pcb/types';
import { footprintDefs } from '@/lib/pcb/footprints';
import { LAYER_COLORS } from '@/lib/pcb/types';

const PX_PER_MM = 8;          // pixels per mm at zoom = 1 (matches PCBCanvas)
const GRID_MM = 0.1;          // snap-to-grid resolution (finer than routing grid)

type Tool = 'select' | 'pad-circle' | 'pad-rect' | 'pad-oval' | 'body' | 'delete';
type PadShape = 'circle' | 'rect' | 'oval';
type PadLayer = 'top' | 'bottom';

/** Editor's working representation of a pad. Adds the editor-only `id` field
 *  so React keys + hit-testing can reference pads without relying on
 *  `terminalId` (which the user might leave blank temporarily). */
interface EditorPad extends FootprintPadDef {
  id: string;
}

/** Editor design — the working state. Carries the same fields as a FootprintDef
 *  plus the editor-only `name` shown in the right panel. */
interface EditorDesign {
  name: string;
  /** footprint type id — used as the registry key when saving (e.g. "soic-8-custom") */
  typeId: string;
  bodySize: { width: number; height: number };
  pads: EditorPad[];
}

interface Camera { x: number; y: number; zoom: number; }

interface DragState {
  kind: 'pad' | 'body';
  id?: string;
  /** mm-space offset from cursor to the element's anchor (center) */
  offset: { x: number; y: number };
}

interface BodyDragState {
  /** mm-space offset from cursor to body center */
  offset: { x: number; y: number };
}

interface DrawDraft {
  kind: 'body';
  startMm: { x: number; y: number };
  currentMm: { x: number; y: number };
}

interface PanState {
  startScreen: { x: number; y: number };
  startCamera: Camera;
}

let idCounter = 0;
function makeId(prefix: string) {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function snapMm(v: number): number {
  return Math.round(v / GRID_MM) * GRID_MM;
}

function snapPoint(p: { x: number; y: number }) {
  return { x: snapMm(p.x), y: snapMm(p.y) };
}

// ── Sample footprints ──────────────────────────────────────────────────────
// Standard pad sizes used by the samples
const SMD_PAD_0603 = { width: 1.0, height: 1.0 };  // 0805 pad
const SMD_PAD_SOIC = { width: 0.6, height: 1.55 }; // SOIC pad
const SMD_PAD_TSSOP = { width: 0.4, height: 1.6 }; // TSSOP pad
const THT_PAD_DIP = { width: 1.6, height: 1.6 };   // DIP pad (0.8mm drill)
const THT_DRILL_DIP = 0.8;

function soic8Design(): EditorDesign {
  const pads: EditorPad[] = [];
  const pitch = 1.27;
  const half = pitch * 1.5; // 4 pads per side at 1.27mm pitch → ±1.905mm
  for (let i = 0; i < 4; i++) {
    const y = -half + i * pitch;
    pads.push({
      id: makeId('pad'),
      terminalId: String(i + 1),
      position: { x: -2.5, y },
      shape: 'rect', size: { ...SMD_PAD_SOIC },
      layer: 'top', drill: 0,
    });
    pads.push({
      id: makeId('pad'),
      terminalId: String(8 - i),
      position: { x: 2.5, y },
      shape: 'rect', size: { ...SMD_PAD_SOIC },
      layer: 'top', drill: 0,
    });
  }
  return {
    name: 'SOIC-8',
    typeId: 'soic8',
    bodySize: { width: 5.0, height: 6.2 },
    pads,
  };
}

function r0805Design(): EditorDesign {
  return {
    name: 'R_0805',
    typeId: 'r0805',
    bodySize: { width: 2.0, height: 1.25 },
    pads: [
      {
        id: makeId('pad'),
        terminalId: 'a',
        position: { x: -1.0, y: 0 },
        shape: 'rect', size: { ...SMD_PAD_0603 },
        layer: 'top', drill: 0,
      },
      {
        id: makeId('pad'),
        terminalId: 'b',
        position: { x: 1.0, y: 0 },
        shape: 'rect', size: { ...SMD_PAD_0603 },
        layer: 'top', drill: 0,
      },
    ],
  };
}

function tssop20Design(): EditorDesign {
  const pads: EditorPad[] = [];
  const pitch = 0.65;
  const half = pitch * 4.5; // 5 pads per side at 0.65mm pitch → ±2.925mm
  for (let i = 0; i < 5; i++) {
    const y = -half + i * pitch;
    pads.push({
      id: makeId('pad'),
      terminalId: String(i + 1),
      position: { x: -3.25, y },
      shape: 'rect', size: { ...SMD_PAD_TSSOP },
      layer: 'top', drill: 0,
    });
    pads.push({
      id: makeId('pad'),
      terminalId: String(20 - i),
      position: { x: 3.25, y },
      shape: 'rect', size: { ...SMD_PAD_TSSOP },
      layer: 'top', drill: 0,
    });
  }
  return {
    name: 'TSSOP-20',
    typeId: 'tssop20',
    bodySize: { width: 6.5, height: 6.5 },
    pads,
  };
}

function dip8Design(): EditorDesign {
  const pads: EditorPad[] = [];
  const pitch = 2.54;
  const half = pitch * 1.5; // 4 pads per side at 2.54mm pitch → ±3.81mm
  for (let i = 0; i < 4; i++) {
    const y = -half + i * pitch;
    pads.push({
      id: makeId('pad'),
      terminalId: String(i + 1),
      position: { x: -4.8, y },
      shape: 'circle', size: { ...THT_PAD_DIP },
      layer: 'top', drill: THT_DRILL_DIP,
    });
    pads.push({
      id: makeId('pad'),
      terminalId: String(8 - i),
      position: { x: 4.8, y },
      shape: 'circle', size: { ...THT_PAD_DIP },
      layer: 'top', drill: THT_DRILL_DIP,
    });
  }
  return {
    name: 'DIP-8',
    typeId: 'dip8',
    bodySize: { width: 9.6, height: 6.5 },
    pads,
  };
}

function blankDesign(): EditorDesign {
  return {
    name: 'My Footprint',
    typeId: 'myFootprint',
    bodySize: { width: 4.0, height: 4.0 },
    pads: [],
  };
}

interface SampleDef {
  key: string;
  label: string;
  build: () => EditorDesign;
}
const SAMPLES: SampleDef[] = [
  { key: 'soic8', label: 'SOIC-8 (1.27mm pitch)', build: soic8Design },
  { key: 'r0805', label: '0805 Resistor', build: r0805Design },
  { key: 'tssop20', label: 'TSSOP-20 (0.65mm pitch)', build: tssop20Design },
  { key: 'dip8', label: 'DIP-8 (2.54mm pitch, THT)', build: dip8Design },
];

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after the FootprintDef is registered. Parent can use this to
   *  refresh any UI that memoises the footprint list. */
  onSave?: (def: FootprintDef) => void;
  /** Optional initial design — for "edit existing footprint" workflows. */
  initialDesign?: EditorDesign;
}

export function FootprintEditorDialog({ open, onClose, onSave, initialDesign }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  // Design state — the footprint being edited
  const [design, setDesign] = useState<EditorDesign>(() => initialDesign ?? soic8Design());

  // Tool + selection + view
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 400, y: 300, zoom: 4 });
  const [showGrid, setShowGrid] = useState(true);

  // Interaction state
  const [drag, setDrag] = useState<DragState | null>(null);
  const [bodyDrag, setBodyDrag] = useState<BodyDragState | null>(null);
  const [draft, setDraft] = useState<DrawDraft | null>(null);
  const [pan, setPan] = useState<PanState | null>(null);
  const [hoverMm, setHoverMm] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Keep refs in sync for use inside event handlers without re-binding them
  const dragRef = useRef<DragState | null>(null);
  const bodyDragRef = useRef<BodyDragState | null>(null);
  const draftRef = useRef<DrawDraft | null>(null);
  const panRef = useRef<PanState | null>(null);
  const toolRef = useRef<Tool>(tool);
  const cameraRef = useRef<Camera>(camera);
  const designRef = useRef<EditorDesign>(design);
  const selectedIdRef = useRef<string | null>(selectedId);
  useEffect(() => { dragRef.current = drag; }, [drag]);
  useEffect(() => { bodyDragRef.current = bodyDrag; }, [bodyDrag]);
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

  // Auto-fit view when design body changes drastically (load sample / new)
  useEffect(() => {
    if (!open) return;
    // Center on origin, zoom to fit body + 2mm margin
    const d = designRef.current;
    const maxDim = Math.max(d.bodySize.width, d.bodySize.height, 4);
    const targetZoom = clamp(size.width / ((maxDim + 4) * PX_PER_MM), 1, 12);
    setCamera({
      x: size.width / 2,
      y: size.height / 2,
      zoom: targetZoom,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, size.width, size.height]);

  // ── Coordinate helpers ──────────────────────────────────────────────
  const screenToMm = useCallback((sx: number, sy: number) => {
    const cam = cameraRef.current;
    return {
      x: (sx - cam.x) / (PX_PER_MM * cam.zoom),
      y: (sy - cam.y) / (PX_PER_MM * cam.zoom),
    };
  }, []);

  const mmToScreen = useCallback((mx: number, my: number) => {
    const cam = cameraRef.current;
    return {
      x: mx * PX_PER_MM * cam.zoom + cam.x,
      y: my * PX_PER_MM * cam.zoom + cam.y,
    };
  }, []);

  // ── Element hit-testing ──────────────────────────────────────────────
  /** Returns the pad id under the given mm coordinate, or null if none. */
  const hitTestPad = useCallback((mm: { x: number; y: number }): string | null => {
    const d = designRef.current;
    // Iterate from last (top-most) to first
    for (let i = d.pads.length - 1; i >= 0; i--) {
      const pad = d.pads[i];
      const dx = mm.x - pad.position.x;
      const dy = mm.y - pad.position.y;
      // Hit test as a circle around the pad center — use the larger of the
      // two dimensions as the hit radius (so 0.6×1.55 SOIC pads are easily
      // clickable), with a minimum 0.3 mm tolerance.
      const r = Math.max(pad.size.width, pad.size.height) / 2 + 0.2;
      if (dx * dx + dy * dy <= r * r) return pad.id;
    }
    return null;
  }, []);

  /** True if the mm coordinate is inside the body outline rectangle. */
  const isInsideBody = useCallback((mm: { x: number; y: number }): boolean => {
    const d = designRef.current;
    return (
      Math.abs(mm.x) <= d.bodySize.width / 2 &&
      Math.abs(mm.y) <= d.bodySize.height / 2
    );
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
    // Background — matches PCBCanvas dark navy
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, size.width, size.height);

    // Grid — minor (0.1mm) and major (1mm)
    if (showGrid) {
      const minorStep = GRID_MM * PX_PER_MM * camera.zoom;
      const majorStep = 1 * PX_PER_MM * camera.zoom;
      // Minor grid (faint)
      if (minorStep >= 4) {
        ctx.strokeStyle = '#13293d';
        ctx.lineWidth = 0.5;
        const sx = ((camera.x % minorStep) + minorStep) % minorStep;
        const sy = ((camera.y % minorStep) + minorStep) % minorStep;
        ctx.beginPath();
        for (let x = sx; x < size.width; x += minorStep) {
          ctx.moveTo(x, 0); ctx.lineTo(x, size.height);
        }
        for (let y = sy; y < size.height; y += minorStep) {
          ctx.moveTo(0, y); ctx.lineTo(size.width, y);
        }
        ctx.stroke();
      }
      // Major grid (1mm, slightly brighter)
      if (majorStep >= 8) {
        ctx.strokeStyle = '#1e3a5f';
        ctx.lineWidth = 0.7;
        const sx = ((camera.x % majorStep) + majorStep) % majorStep;
        const sy = ((camera.y % majorStep) + majorStep) % majorStep;
        ctx.beginPath();
        for (let x = sx; x < size.width; x += majorStep) {
          ctx.moveTo(x, 0); ctx.lineTo(x, size.height);
        }
        for (let y = sy; y < size.height; y += majorStep) {
          ctx.moveTo(0, y); ctx.lineTo(size.width, y);
        }
        ctx.stroke();
      }
      // Origin crosshair (red + green axes)
      const origin = mmToScreen(0, 0);
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(origin.x - 6, origin.y); ctx.lineTo(origin.x + 6, origin.y);
      ctx.moveTo(origin.x, origin.y - 6); ctx.lineTo(origin.x, origin.y + 6);
      ctx.stroke();
    }

    // Body outline rectangle (centered on origin)
    {
      const tl = mmToScreen(-design.bodySize.width / 2, -design.bodySize.height / 2);
      const br = mmToScreen(design.bodySize.width / 2, design.bodySize.height / 2);
      const w = br.x - tl.x;
      const h = br.y - tl.y;
      ctx.save();
      ctx.fillStyle = 'rgba(148, 163, 184, 0.06)';
      ctx.fillRect(tl.x, tl.y, w, h);
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(tl.x, tl.y, w, h);
      ctx.setLineDash([]);
      // Body width / height labels
      ctx.fillStyle = '#64748b';
      ctx.font = `${Math.max(9, 10 * Math.min(camera.zoom, 2))}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${design.bodySize.width.toFixed(2)}mm`, tl.x + w / 2, br.y + 4);
      ctx.save();
      ctx.translate(tl.x - 6, tl.y + h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = 'middle';
      ctx.fillText(`${design.bodySize.height.toFixed(2)}mm`, 0, 0);
      ctx.restore();
      ctx.restore();
    }

    // Pads
    for (const pad of design.pads) {
      drawPad(ctx, pad, camera, mmToScreen, selectedId === pad.id);
    }

    // Body outline drag — show snap preview
    if (draft) {
      const a = mmToScreen(draft.startMm.x, draft.startMm.y);
      const b = mmToScreen(draft.currentMm.x, draft.currentMm.y);
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.fillStyle = 'rgba(251, 191, 36, 0.12)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.fillRect(
        Math.min(a.x, b.x), Math.min(a.y, b.y),
        Math.abs(b.x - a.x), Math.abs(b.y - a.y),
      );
      ctx.strokeRect(
        Math.min(a.x, b.x), Math.min(a.y, b.y),
        Math.abs(b.x - a.x), Math.abs(b.y - a.y),
      );
      ctx.setLineDash([]);
      // Show dimensions in mm
      const wMm = Math.abs(draft.currentMm.x - draft.startMm.x);
      const hMm = Math.abs(draft.currentMm.y - draft.startMm.y);
      ctx.fillStyle = '#fbbf24';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${wMm.toFixed(2)} × ${hMm.toFixed(2)} mm`, b.x + 6, b.y + 6);
      ctx.restore();
    }

    // Hovered pad crosshair (when a pad tool is active)
    if (tool === 'pad-circle' || tool === 'pad-rect' || tool === 'pad-oval' || tool === 'body') {
      const hp = mmToScreen(hoverMm.x, hoverMm.y);
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.fillStyle = '#fbbf24';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2);
      ctx.fill();
      // Crosshair lines
      ctx.beginPath();
      ctx.moveTo(hp.x - 8, hp.y); ctx.lineTo(hp.x + 8, hp.y);
      ctx.moveTo(hp.x, hp.y - 8); ctx.lineTo(hp.x, hp.y + 8);
      ctx.stroke();
      // mm coords
      ctx.fillStyle = '#fbbf24';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`(${hoverMm.x.toFixed(2)}, ${hoverMm.y.toFixed(2)})mm`, hp.x + 10, hp.y + 4);
      ctx.restore();
    }

    // HUD: zoom %, mm coords, tool name
    ctx.save();
    ctx.fillStyle = '#475569';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `zoom ${(camera.zoom * 100).toFixed(0)}%  ·  (${hoverMm.x.toFixed(2)}, ${hoverMm.y.toFixed(2)})mm  ·  tool: ${tool}  ·  ${design.pads.length} pad(s)`,
      8, size.height - 18,
    );
    ctx.restore();

    ctx.restore();
  }, [size, camera, showGrid, design, selectedId, draft, tool, hoverMm, mmToScreen]);

  // ── Element creation helpers ────────────────────────────────────────
  const addPadAt = useCallback((mm: { x: number; y: number }, shape: PadShape) => {
    const pos = snapPoint(mm);
    const pad: EditorPad = {
      id: makeId('pad'),
      terminalId: String(designRef.current.pads.length + 1),
      position: pos,
      shape,
      size: shape === 'circle'
        ? { width: 1.6, height: 1.6 }
        : shape === 'rect'
          ? { width: 1.5, height: 0.8 }
          : { width: 2.0, height: 1.0 },
      layer: 'top',
      drill: 0,
    };
    setDesign((d) => ({ ...d, pads: [...d.pads, pad] }));
    setSelectedId(pad.id);
    setTool('select');
  }, []);

  const finalizeBodyDraft = useCallback(() => {
    const dr = draftRef.current;
    if (!dr) return;
    const w = Math.abs(dr.currentMm.x - dr.startMm.x);
    const h = Math.abs(dr.currentMm.y - dr.startMm.y);
    if (w < 0.5 || h < 0.5) {
      setDraft(null);
      return;
    }
    setDesign((d) => ({
      ...d,
      bodySize: { width: snapMm(w), height: snapMm(h) },
    }));
    setDraft(null);
    setTool('select');
  }, []);

  // ── Mouse handlers ──────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || e.button === 2) {
      // Middle / right button — start panning
      e.preventDefault();
      setPan({ startScreen: { x: e.clientX, y: e.clientY }, startCamera: { ...cameraRef.current } });
      return;
    }
    if (e.button !== 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const mm = screenToMm(sx, sy);
    const t = toolRef.current;

    if (t === 'select' || t === 'delete') {
      const hit = hitTestPad(mm);
      if (hit) {
        if (t === 'delete') {
          setDesign((d) => ({ ...d, pads: d.pads.filter((p) => p.id !== hit) }));
          setSelectedId(null);
          return;
        }
        // Select + start drag
        setSelectedId(hit);
        const pad = designRef.current.pads.find((p) => p.id === hit);
        if (pad) {
          setDrag({
            kind: 'pad',
            id: hit,
            offset: { x: pad.position.x - mm.x, y: pad.position.y - mm.y },
          });
        }
        return;
      }
      // Click on body outline (but not on a pad) → drag the whole body
      if (isInsideBody(mm)) {
        if (t === 'delete') {
          // No-op: can't delete body; just deselect
          setSelectedId(null);
          return;
        }
        setSelectedId(null);
        setBodyDrag({ offset: { x: 0 - mm.x, y: 0 - mm.y } });
        return;
      }
      setSelectedId(null);
      return;
    }

    if (t === 'pad-circle' || t === 'pad-rect' || t === 'pad-oval') {
      addPadAt(mm, t === 'pad-circle' ? 'circle' : t === 'pad-rect' ? 'rect' : 'oval');
      return;
    }
    if (t === 'body') {
      setDraft({ kind: 'body', startMm: snapPoint(mm), currentMm: snapPoint(mm) });
      return;
    }
  }, [screenToMm, hitTestPad, isInsideBody, addPadAt]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const mm = screenToMm(sx, sy);
    setHoverMm(mm);

    const p = panRef.current;
    if (p) {
      const dx = e.clientX - p.startScreen.x;
      const dy = e.clientY - p.startScreen.y;
      setCamera({ ...p.startCamera, x: p.startCamera.x + dx, y: p.startCamera.y + dy });
      return;
    }
    const dr = dragRef.current;
    if (dr && dr.kind === 'pad' && dr.id) {
      const newPos = snapPoint({ x: mm.x + dr.offset.x, y: mm.y + dr.offset.y });
      setDesign((d) => ({
        ...d,
        pads: d.pads.map((p2) => p2.id === dr.id ? { ...p2, position: newPos } : p2),
      }));
      return;
    }
    const bd = bodyDragRef.current;
    if (bd) {
      // Dragging the body — translate every pad so the body's logical center
      // follows the cursor. The body rectangle itself is always centered at (0,0)
      // (footprint convention), so we shift pads by the snap delta of the cursor.
      const targetCenter = snapPoint({ x: mm.x + bd.offset.x, y: mm.y + bd.offset.y });
      const delta = { x: targetCenter.x, y: targetCenter.y };
      if (Math.abs(delta.x) < 1e-9 && Math.abs(delta.y) < 1e-9) return;
      setDesign((d) => ({
        ...d,
        pads: d.pads.map((p2) => ({
          ...p2,
          position: { x: p2.position.x - delta.x, y: p2.position.y - delta.y },
        })),
      }));
      // Reset offset so we don't accumulate; the pad positions have absorbed it
      bodyDragRef.current = { offset: { x: -mm.x, y: -mm.y } };
      return;
    }
    const df = draftRef.current;
    if (df) {
      setDraft({ ...df, currentMm: snapPoint(mm) });
      return;
    }
  }, [screenToMm]);

  const onMouseUp = useCallback(() => {
    if (panRef.current) { setPan(null); return; }
    if (dragRef.current) { setDrag(null); return; }
    if (bodyDragRef.current) { setBodyDrag(null); return; }
    if (draftRef.current) { finalizeBodyDraft(); return; }
  }, [finalizeBodyDraft]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const cam = cameraRef.current;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = clamp(cam.zoom * factor, 1, 30);
    // Zoom around cursor — keep mm point under cursor fixed
    const mx = (sx - cam.x) / (PX_PER_MM * cam.zoom);
    const my = (sy - cam.y) / (PX_PER_MM * cam.zoom);
    setCamera({
      x: sx - mx * PX_PER_MM * newZoom,
      y: sy - my * PX_PER_MM * newZoom,
      zoom: newZoom,
    });
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const mm = screenToMm(sx, sy);
    const hit = hitTestPad(mm);
    if (hit) {
      setSelectedId(hit);
      // Focus the first input in the right panel by dispatching a custom event
      // the property panel listens for.
      window.dispatchEvent(new CustomEvent('pcb-footprint-editor:focus-pad'));
    }
  }, [screenToMm, hitTestPad]);

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
  }, []);

  // ── Pad update helpers (right panel) ─────────────────────────────────
  const updatePad = useCallback((id: string, patch: Partial<EditorPad>) => {
    setDesign((d) => ({
      ...d,
      pads: d.pads.map((p) => p.id === id ? { ...p, ...patch } : p),
    }));
  }, []);
  const updateDesign = useCallback((patch: Partial<EditorDesign>) => {
    setDesign((d) => ({ ...d, ...patch }));
  }, []);

  const deletePad = useCallback((id: string) => {
    setDesign((d) => ({ ...d, pads: d.pads.filter((p) => p.id !== id) }));
    setSelectedId(null);
  }, []);

  // ── Save ────────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    const d = designRef.current;
    if (!d.name.trim()) {
      toast.error('Please enter a footprint name');
      return;
    }
    if (!d.typeId.trim()) {
      toast.error('Please enter a Type ID');
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/i.test(d.typeId)) {
      toast.error('Type ID must start with a letter and contain only letters/digits/underscores');
      return;
    }
    if (d.pads.length === 0) {
      toast.error('Footprint must have at least one pad');
      return;
    }
    if (d.bodySize.width <= 0.1 || d.bodySize.height <= 0.1) {
      toast.error('Footprint body size must be non-zero');
      return;
    }
    // Build the FootprintDef — strips the editor-only `id` field from each pad
    const def: FootprintDef = {
      name: d.name,
      bodySize: { ...d.bodySize },
      pads: d.pads.map((p) => ({
        terminalId: p.terminalId,
        position: { x: p.position.x, y: p.position.y },
        shape: p.shape,
        size: { width: p.size.width, height: p.size.height },
        layer: p.layer,
        drill: (p.drill ?? 0) > 0 ? p.drill : undefined,
      })),
    };
    // Register it in the runtime registry — overwrites if the same type id
    // already exists (matching the Symbol Editor's behavior).
    const key = d.typeId.toLowerCase();
    footprintDefs[key] = def;
    // Notify any listening UI that the footprint registry changed.
    window.dispatchEvent(new CustomEvent('circuitlab:footprint-registered', { detail: { typeId: key } }));
    toast.success(`Footprint "${d.name}" registered (${d.pads.length} pads)`, {
      description: `Find it under type "${key}" in the footprint registry`,
    });
    onSave?.(def);
    onClose();
  }, [onClose, onSave]);

  const handleNew = useCallback(() => {
    if (!confirm('Discard current footprint and start fresh?')) return;
    setDesign(blankDesign());
    setSelectedId(null);
    setCamera({ x: 400, y: 300, zoom: 4 });
  }, []);

  const handleLoadSample = useCallback((key: string) => {
    const sample = SAMPLES.find((s) => s.key === key);
    if (!sample) return;
    setDesign(sample.build());
    setSelectedId(null);
    // Re-fit the view
    const d = sample.build();
    const maxDim = Math.max(d.bodySize.width, d.bodySize.height, 4);
    const targetZoom = clamp(size.width / ((maxDim + 4) * PX_PER_MM), 1, 12);
    setCamera({
      x: size.width / 2,
      y: size.height / 2,
      zoom: targetZoom,
    });
  }, [size.width, size.height]);

  const zoomBy = useCallback((factor: number) => {
    setCamera((c) => {
      const newZoom = clamp(c.zoom * factor, 1, 30);
      // Zoom around canvas centre
      const cx = size.width / 2;
      const cy = size.height / 2;
      const mx = (cx - c.x) / (PX_PER_MM * c.zoom);
      const my = (cy - c.y) / (PX_PER_MM * c.zoom);
      return { x: cx - mx * PX_PER_MM * newZoom, y: cy - my * PX_PER_MM * newZoom, zoom: newZoom };
    });
  }, [size]);

  const resetView = useCallback(() => {
    const d = designRef.current;
    const maxDim = Math.max(d.bodySize.width, d.bodySize.height, 4);
    const targetZoom = clamp(size.width / ((maxDim + 4) * PX_PER_MM), 1, 12);
    setCamera({
      x: size.width / 2,
      y: size.height / 2,
      zoom: targetZoom,
    });
  }, [size.width, size.height]);

  // Find the selected pad for the right panel
  const selectedPad = useMemo<EditorPad | null>(() => {
    if (!selectedId) return null;
    return design.pads.find((p) => p.id === selectedId) ?? null;
  }, [selectedId, design.pads]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-none w-screen h-screen sm:max-w-none p-0 gap-0 rounded-none border-slate-700 bg-slate-950 text-slate-100"
      >
        <DialogTitle className="sr-only">Footprint Editor</DialogTitle>
        <DialogDescription className="sr-only">
          Design a PCB footprint by placing pads (circle / rect / oval) on a body outline,
          configuring each pad's layer, drill diameter, and terminal ID.
        </DialogDescription>

        <div className="flex h-screen w-screen flex-col">
          {/* Top toolbar */}
          <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-900 px-3 py-2">
            <div className="mr-2 flex items-center gap-2 pr-3">
              <div className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-emerald-500 to-cyan-600 text-slate-900">
                <Frame size={16} strokeWidth={2.5} />
              </div>
              <span className="hidden text-sm font-semibold text-slate-100 sm:inline">Footprint Editor</span>
            </div>

            <Button size="sm" variant="ghost" onClick={handleNew} title="New (clear)">
              <FilePlus size={14} />
              <span className="ml-1 hidden md:inline">New</span>
            </Button>

            {/* Sample dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" title="Load a sample footprint">
                  <Plus size={14} />
                  <span className="ml-1 hidden md:inline">Sample</span>
                  <ChevronDown size={12} className="ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 bg-slate-900 border-slate-700">
                <DropdownMenuLabel className="text-slate-300">Standard Footprints</DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-slate-700" />
                {SAMPLES.map((s) => (
                  <DropdownMenuItem
                    key={s.key}
                    className="text-xs text-slate-200"
                    onClick={() => handleLoadSample(s.key)}
                  >
                    {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

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
              <Switch checked={showGrid} onCheckedChange={setShowGrid} title="Toggle grid" />
              <span className="hidden text-xs text-slate-400 sm:inline">Grid 0.1mm</span>
            </div>

            <div className="mx-2 h-5 w-px bg-slate-700" />

            <Button size="sm" variant="ghost" onClick={() => zoomBy(1.2)} title="Zoom in">
              <ZoomIn size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
              <ZoomOut size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={resetView} title="Reset view">
              <span className="text-xs">{(camera.zoom * 100).toFixed(0)}%</span>
            </Button>
          </div>

          {/* Body: left toolbar | canvas | right panel */}
          <div className="flex min-h-0 flex-1">
            {/* Left toolbar */}
            <div className="flex w-12 flex-col items-center gap-1 border-r border-slate-800 bg-slate-900 py-2">
              <ToolButton active={tool === 'select'} onClick={() => setTool('select')} icon={<MousePointer2 size={16} />} label="Select / Move" />
              <ToolButton active={tool === 'pad-circle'} onClick={() => setTool('pad-circle')} icon={<CircleIcon size={16} />} label="Add Circle Pad" />
              <ToolButton active={tool === 'pad-rect'} onClick={() => setTool('pad-rect')} icon={<Square size={16} />} label="Add Rect Pad" />
              <ToolButton active={tool === 'pad-oval'} onClick={() => setTool('pad-oval')} icon={<Pill size={16} />} label="Add Oval Pad" />
              <div className="my-1 h-px w-8 bg-slate-700" />
              <ToolButton active={tool === 'body'} onClick={() => setTool('body')} icon={<Frame size={16} />} label="Draw Body Outline (drag)" />
              <div className="my-1 h-px w-8 bg-slate-700" />
              <ToolButton
                active={tool === 'delete'}
                onClick={() => setTool('delete')}
                icon={<Trash2 size={16} />}
                label="Delete (click pad)"
                danger
              />
            </div>

            {/* Canvas */}
            <div ref={containerRef} className="relative min-h-0 flex-1 bg-slate-950"
              onContextMenu={(e) => e.preventDefault()}>
              <canvas
                ref={canvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onWheel={onWheel}
                onDoubleClick={onDoubleClick}
                onContextMenu={onContextMenu}
                className="block h-full w-full"
                style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
              />
              {/* Floating hint */}
              <div className="pointer-events-none absolute bottom-2 left-2 text-[10px] text-slate-500">
                <div>left-click: place / select  ·  drag: move  ·  dbl-click: edit pad  ·  wheel: zoom  ·  middle/right: pan</div>
              </div>
            </div>

            {/* Right properties panel */}
            <div className="w-80 shrink-0 border-l border-slate-800 bg-slate-900">
              <ScrollArea className="h-full">
                <div className="p-3">
                  {selectedPad ? (
                    <PadEditor
                      pad={selectedPad}
                      onUpdate={(patch) => updatePad(selectedPad.id, patch)}
                      onDelete={() => deletePad(selectedPad.id)}
                    />
                  ) : (
                    <DesignMetaEditor design={design} onUpdate={updateDesign} />
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
// Pad renderer — matches PCBCanvas conventions (red=top, blue=bottom) and
// draws a drill hole (unplated centre) for THT pads.
// ─────────────────────────────────────────────────────────────────────────────

function drawPad(
  ctx: CanvasRenderingContext2D,
  pad: EditorPad,
  cam: Camera,
  mmToScreen: (mx: number, my: number) => { x: number; y: number },
  isSelected: boolean,
) {
  const p = mmToScreen(pad.position.x, pad.position.y);
  const padW = Math.max(0.1, pad.size.width) * PX_PER_MM * cam.zoom;
  const padH = Math.max(0.1, pad.size.height) * PX_PER_MM * cam.zoom;
  const layer: PadLayer = (pad.layer as PadLayer) ?? 'top';
  const padColor = layer === 'bottom' ? '#2563eb' : '#dc2626';

  ctx.save();
  // Selection halo
  if (isSelected) {
    ctx.shadowColor = '#fbbf24';
    ctx.shadowBlur = 10;
  }

  ctx.fillStyle = padColor;
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 0.5;

  if (pad.shape === 'circle') {
    const r = Math.max(padW, padH) / 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    // rect / oval — render as rounded rectangle for oval, plain rect for rect
    if (pad.shape === 'oval') {
      const rx = padW / 2;
      const ry = padH / 2;
      // If square-ish, just draw a circle
      if (Math.abs(rx - ry) < 0.5) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(rx, ry), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        // Stadium / capsule shape: two semicircles + a rectangle
        ctx.beginPath();
        if (rx > ry) {
          // Horizontal capsule
          ctx.arc(p.x - rx + ry, p.y, ry, Math.PI / 2, -Math.PI / 2);
          ctx.arc(p.x + rx - ry, p.y, ry, -Math.PI / 2, Math.PI / 2);
          ctx.closePath();
        } else {
          // Vertical capsule
          ctx.arc(p.x, p.y - ry + rx, rx, 0, Math.PI);
          ctx.arc(p.x, p.y + ry - rx, rx, Math.PI, 0);
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
      }
    } else {
      // Plain rect
      ctx.fillRect(p.x - padW / 2, p.y - padH / 2, padW, padH);
      ctx.strokeRect(p.x - padW / 2, p.y - padH / 2, padW, padH);
    }
  }

  // Drill hole (THT)
  const drill = pad.drill ?? 0;
  if (drill > 0) {
    const drillR = (drill / 2) * PX_PER_MM * cam.zoom;
    ctx.fillStyle = '#0a1628';
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1, drillR), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // Selection border (drawn after the pad so it sits on top)
  if (isSelected) {
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    if (pad.shape === 'circle') {
      const r = Math.max(padW, padH) / 2 + 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(p.x - padW / 2 - 2, p.y - padH / 2 - 2, padW + 4, padH + 4);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Terminal ID label (next to the pad)
  ctx.save();
  ctx.fillStyle = '#fde047';
  ctx.font = `${Math.max(8, 8 * Math.min(cam.zoom, 2.5))}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const labelOffsetX = (pad.shape === 'circle' ? Math.max(padW, padH) / 2 : padW / 2) + 3;
  ctx.fillText(pad.terminalId, p.x + labelOffsetX, p.y);
  ctx.restore();

  // Layer indicator (small dot in the corner)
  ctx.save();
  ctx.fillStyle = layer === 'bottom' ? '#2563eb' : '#dc2626';
  ctx.fillRect(p.x - padW / 2 - 3, p.y - padH / 2 - 3, 3, 3);
  ctx.restore();
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
  design: EditorDesign;
  onUpdate: (patch: Partial<EditorDesign>) => void;
}) {
  // Compute the bounding box of all pads (for diagnostic display)
  const bbox = useMemo(() => {
    if (design.pads.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of design.pads) {
      minX = Math.min(minX, p.position.x - p.size.width / 2);
      maxX = Math.max(maxX, p.position.x + p.size.width / 2);
      minY = Math.min(minY, p.position.y - p.size.height / 2);
      maxY = Math.max(maxY, p.position.y + p.size.height / 2);
    }
    return { width: maxX - minX, height: maxY - minY };
  }, [design.pads]);

  const topPadCount = design.pads.filter((p) => (p.layer ?? 'top') === 'top').length;
  const bottomPadCount = design.pads.length - topPadCount;
  const thtPadCount = design.pads.filter((p) => (p.drill ?? 0) > 0).length;

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        Footprint Properties
      </div>
      <div>
        <Label className="text-xs text-slate-400">Footprint Name</Label>
        <Input
          value={design.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="SOIC-8"
          className="mt-1 bg-slate-800 border-slate-700 text-sm"
        />
      </div>
      <div>
        <Label className="text-xs text-slate-400">Type ID (unique registry key)</Label>
        <Input
          value={design.typeId}
          onChange={(e) => onUpdate({ typeId: e.target.value })}
          placeholder="soic8"
          className="mt-1 bg-slate-800 border-slate-700 text-sm font-mono"
        />
        <p className="mt-1 text-[10px] text-slate-500">
          Must start with a letter; letters/digits/underscores only. Saved footprints
          overwrite existing entries with the same type id.
        </p>
      </div>

      <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
          Body Outline (mm)
        </div>
        <div className="grid grid-cols-2 gap-2">
          <FieldRow label="Width">
            <NumInput
              value={design.bodySize.width}
              onChange={(v) => onUpdate({ bodySize: { ...design.bodySize, width: Math.max(0.1, snapMm(v)) } })}
              step={0.1}
            />
          </FieldRow>
          <FieldRow label="Height">
            <NumInput
              value={design.bodySize.height}
              onChange={(v) => onUpdate({ bodySize: { ...design.bodySize, height: Math.max(0.1, snapMm(v)) } })}
              step={0.1}
            />
          </FieldRow>
        </div>
        <p className="mt-2 text-[10px] text-slate-500">
          Or use the Body tool on the left toolbar to drag a new outline.
        </p>
      </div>

      <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2 text-[10px] text-slate-400">
        <div className="font-semibold uppercase tracking-wider text-slate-500 mb-1">Stats</div>
        <div>Total pads: {design.pads.length}</div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-red-600" /> Top layer: {topPadCount}
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-blue-600" /> Bottom layer: {bottomPadCount}
        </div>
        <div>THT (drilled): {thtPadCount}</div>
        {bbox && (
          <div className="mt-1 border-t border-slate-800 pt-1">
            Pads bbox: {bbox.width.toFixed(2)} × {bbox.height.toFixed(2)} mm
          </div>
        )}
      </div>

      <div className="rounded-md border border-cyan-900/40 bg-cyan-950/20 p-2 text-[10px] text-cyan-300">
        Click a pad tool on the left, then click on the canvas to place a pad.
        Drag pads to move them. Use the Body tool to redraw the outline.
        Double-click a pad to focus its properties here.
      </div>
    </div>
  );
}

function PadEditor({
  pad, onUpdate, onDelete,
}: {
  pad: EditorPad;
  onUpdate: (patch: Partial<EditorPad>) => void;
  onDelete: () => void;
}) {
  const layer = (pad.layer as PadLayer) ?? 'top';
  const layerColor = layer === 'bottom' ? '#2563eb' : '#dc2626';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Pad
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-rose-400 hover:bg-rose-950/40 hover:text-rose-300"
          onClick={onDelete}
          title="Delete this pad"
        >
          <Trash2 size={12} className="mr-1" />
          Delete
        </Button>
      </div>

      {/* Pad preview */}
      <div className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/50 p-2">
        <div
          className="h-4 w-4 rounded-sm"
          style={{
            backgroundColor: layerColor,
            borderRadius: pad.shape === 'circle' ? '50%' : pad.shape === 'oval' ? '9999px' : '2px',
          }}
        />
        <div className="font-mono text-xs text-slate-300">
          {pad.terminalId} · {pad.shape} · {pad.size.width.toFixed(2)}×{pad.size.height.toFixed(2)}mm
        </div>
      </div>

      <FieldRow label="Terminal ID">
        <Input
          value={pad.terminalId}
          onChange={(e) => onUpdate({ terminalId: e.target.value })}
          className="h-8 bg-slate-800 border-slate-700 text-xs font-mono"
        />
      </FieldRow>

      <FieldRow label="Shape">
        <Select
          value={pad.shape}
          onValueChange={(v) => onUpdate({ shape: v as PadShape })}
        >
          <SelectTrigger className="h-8 bg-slate-800 border-slate-700 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-700">
            <SelectItem value="circle" className="text-xs text-slate-200">Circle</SelectItem>
            <SelectItem value="rect" className="text-xs text-slate-200">Rectangle</SelectItem>
            <SelectItem value="oval" className="text-xs text-slate-200">Oval (capsule)</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Pos X (mm)">
          <NumInput
            value={pad.position.x}
            onChange={(v) => onUpdate({ position: { ...pad.position, x: snapMm(v) } })}
            step={0.1}
          />
        </FieldRow>
        <FieldRow label="Pos Y (mm)">
          <NumInput
            value={pad.position.y}
            onChange={(v) => onUpdate({ position: { ...pad.position, y: snapMm(v) } })}
            step={0.1}
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Width (mm)">
          <NumInput
            value={pad.size.width}
            onChange={(v) => onUpdate({ size: { ...pad.size, width: Math.max(0.1, snapMm(v)) } })}
            step={0.1}
          />
        </FieldRow>
        <FieldRow label="Height (mm)">
          <NumInput
            value={pad.size.height}
            onChange={(v) => onUpdate({ size: { ...pad.size, height: Math.max(0.1, snapMm(v)) } })}
            step={0.1}
          />
        </FieldRow>
      </div>

      <FieldRow label="Layer">
        <Select
          value={layer}
          onValueChange={(v) => onUpdate({ layer: v as CopperLayer })}
        >
          <SelectTrigger className="h-8 bg-slate-800 border-slate-700 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-700">
            <SelectItem value="top" className="text-xs text-slate-200">
              <span className="mr-2 inline-block h-2 w-2 rounded-sm bg-red-600" /> Top (red)
            </SelectItem>
            <SelectItem value="bottom" className="text-xs text-slate-200">
              <span className="mr-2 inline-block h-2 w-2 rounded-sm bg-blue-600" /> Bottom (blue)
            </SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>

      <FieldRow label="Drill Diameter (mm) — 0 for SMD">
        <NumInput
          value={pad.drill ?? 0}
          onChange={(v) => onUpdate({ drill: Math.max(0, snapMm(v)) })}
          step={0.1}
        />
      </FieldRow>
      {(pad.drill ?? 0) > 0 && (
        <div className="rounded-md border border-amber-900/40 bg-amber-950/20 p-2 text-[10px] text-amber-300">
          THT pad — drill hole will be rendered as an unplated centre.
        </div>
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
      value={Number.isFinite(value) ? value : 0}
      step={step}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
      className="h-8 bg-slate-800 border-slate-700 text-xs font-mono"
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public exports for re-use
// ─────────────────────────────────────────────────────────────────────────────

export type { EditorDesign, EditorPad, PadShape, PadLayer };
export { soic8Design, r0805Design, tssop20Design, dip8Design, blankDesign };
export { SAMPLES as FOOTPRINT_EDITOR_SAMPLES };
