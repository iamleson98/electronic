// Symbol editor types + conversion helpers.
//
// A SymbolDesign is a WYSIWYG description of a schematic symbol drawn by the
// user in the SymbolEditorDialog. It contains rectangles (body), lines,
// pins (terminals), and text labels. symbolDesignToPlugin() converts a design
// into a runtime ComponentPlugin that can be dropped onto the schematic canvas
// and wired up like any other part.
//
// The resulting plugin has no `stamp()` (electrical behaviour is a structural
// placeholder — the user can later assign a sub-circuit definition to give it
// real behaviour). The plugin's `render()` reproduces the editor canvas's
// drawing one-to-one so what you see in the editor is what you get on the
// schematic.

import type {
  ComponentPlugin,
  ParameterDef,
  PinElecType,
  PinShape,
  TerminalDef,
  Vec2,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Symbol element types
// ─────────────────────────────────────────────────────────────────────────────

export type PinDirection = 'left' | 'right' | 'up' | 'down';

export interface SymbolPin {
  id: string;
  /** position relative to symbol origin (grid units) — the OUTER end of the pin
   *  (the connection point). The pin stub extends from the body inward to here. */
  position: Vec2;
  /** pin label (visible next to pin) — e.g. "1", "IN+" */
  label: string;
  /** pin name (shown inside body) — e.g. "IN+" */
  name: string;
  /** pin number string — e.g. "1", "8", "A1" */
  number: string;
  /** KiCad electrical type */
  electricalType: PinElecType;
  /** graphical pin shape */
  shape: PinShape;
  /** length in grid units */
  length: number;
  /** direction the pin stub extends (from the body outward to position).
   *  If omitted, derived from position vs boundingBox centre. */
  direction?: PinDirection;
}

export interface SymbolRect {
  id: string;
  position: Vec2;
  size: { width: number; height: number };
  strokeColor: string;
  fillColor: string;
}

export interface SymbolLine {
  id: string;
  from: Vec2;
  to: Vec2;
  color: string;
  width: number;
}

export interface SymbolText {
  id: string;
  position: Vec2;
  text: string;
  color: string;
  fontSize: number;
}

export interface SymbolDesign {
  name: string;
  /** unique plugin type id (e.g. 'myOpamp') */
  type: string;
  description: string;
  /** bounding box in grid units — terminals are positioned relative to this */
  boundingBox: { width: number; height: number };
  pins: SymbolPin[];
  rects: SymbolRect[];
  lines: SymbolLine[];
  texts: SymbolText[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pin-shape rendering helpers (KiCad eeschema parity)
// ─────────────────────────────────────────────────────────────────────────────

/** Standard KiCad-ish colours for pin stubs by electrical type. */
export const PIN_ELEC_TYPE_COLOR: Record<PinElecType, string> = {
  input: '#3b82f6',          // blue
  output: '#22c55e',         // green
  bidirectional: '#a855f7', // purple
  tri_state: '#ec4899',     // pink
  passive: '#22d3ee',        // cyan
  power_in: '#ef4444',      // red
  power_out: '#f97316',      // orange
  open_collector: '#f59e0b', // amber
  open_emitter: '#eab308',   // yellow
  unconnected: '#64748b',   // slate
  nc: '#64748b',
  free: '#94a3b8',
  unspecified: '#94a3b8',
};

export const PIN_ELEC_TYPE_LABELS: { value: PinElecType; label: string }[] = [
  { value: 'input', label: 'Input' },
  { value: 'output', label: 'Output' },
  { value: 'bidirectional', label: 'Bidirectional' },
  { value: 'passive', label: 'Passive' },
  { value: 'power_in', label: 'Power In' },
  { value: 'power_out', label: 'Power Out' },
  { value: 'open_collector', label: 'Open Collector' },
  { value: 'open_emitter', label: 'Open Emitter' },
  { value: 'tri_state', label: 'Tri-state' },
  { value: 'unconnected', label: 'Unconnected' },
  { value: 'nc', label: 'No Connect' },
  { value: 'free', label: 'Free' },
  { value: 'unspecified', label: 'Unspecified' },
];

export const PIN_SHAPE_LABELS: { value: PinShape; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'inverted', label: 'Inverted (bubble)' },
  { value: 'clock', label: 'Clock (chevron)' },
  { value: 'inverted_clock', label: 'Inverted Clock' },
  { value: 'input_low', label: 'Input Low' },
  { value: 'clock_low', label: 'Clock Low' },
  { value: 'falling_edge', label: 'Falling Edge' },
  { value: 'non_logic', label: 'Non-Logic' },
];

/** Derive a sensible pin direction from position relative to bounding box. */
export function derivePinDirection(
  pin: { position: Vec2; direction?: PinDirection },
  bb: { width: number; height: number },
): PinDirection {
  if (pin.direction) return pin.direction;
  const cx = bb.width / 2;
  const cy = bb.height / 2;
  // Bias toward horizontal: pins usually poke out left/right.
  const dx = Math.abs(pin.position.x - cx);
  const dy = Math.abs(pin.position.y - cy);
  if (dx >= dy) {
    return pin.position.x < cx ? 'left' : 'right';
  }
  return pin.position.y < cy ? 'up' : 'down';
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw a single pin at its position. The pin's stub extends from the body
 * inward to the outer end (position). `cellSize` is pixels-per-grid-unit.
 */
export function drawPin(
  ctx: CanvasRenderingContext2D,
  pin: SymbolPin,
  bb: { width: number; height: number },
  cellSize: number,
  options?: {
    selected?: boolean;
    showPinNumbers?: boolean;
    showPinNames?: boolean;
    showPinElecTypes?: boolean;
  },
) {
  const dir = derivePinDirection(pin, bb);
  const px = pin.position.x * cellSize;
  const py = pin.position.y * cellSize;
  const len = pin.length * cellSize;
  // Stub start (body side) and end (outer end = position)
  let sx = px, sy = py;
  if (dir === 'left') sx = px + len;
  else if (dir === 'right') sx = px - len;
  else if (dir === 'up') sy = py + len;
  else if (dir === 'down') sy = py - len;

  // Stub line
  const stubColor = PIN_ELEC_TYPE_COLOR[pin.electricalType] ?? '#94a3b8';
  ctx.save();
  ctx.strokeStyle = stubColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(px, py);
  ctx.stroke();

  // Pin shape decoration at the body (inner) end of the stub
  const bodyX = sx;
  const bodyY = sy;
  const r = cellSize * 0.12;
  if (pin.shape === 'inverted' || pin.shape === 'inverted_clock') {
    // bubble: small circle just inside the body end
    let bx = bodyX, by = bodyY;
    if (dir === 'left') bx -= r;
    else if (dir === 'right') bx += r;
    else if (dir === 'up') by -= r;
    else if (dir === 'down') by += r;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (pin.shape === 'clock' || pin.shape === 'inverted_clock' || pin.shape === 'clock_low' || pin.shape === 'falling_edge') {
    // clock: small ">" chevron just inside the body
    const c = cellSize * 0.18;
    ctx.beginPath();
    if (dir === 'left') {
      ctx.moveTo(bodyX - c, bodyY - c);
      ctx.lineTo(bodyX, bodyY);
      ctx.lineTo(bodyX - c, bodyY + c);
    } else if (dir === 'right') {
      ctx.moveTo(bodyX + c, bodyY - c);
      ctx.lineTo(bodyX, bodyY);
      ctx.lineTo(bodyX + c, bodyY + c);
    } else if (dir === 'up') {
      ctx.moveTo(bodyX - c, bodyY - c);
      ctx.lineTo(bodyX, bodyY);
      ctx.lineTo(bodyX + c, bodyY - c);
    } else {
      ctx.moveTo(bodyX - c, bodyY + c);
      ctx.lineTo(bodyX, bodyY);
      ctx.lineTo(bodyX + c, bodyY + c);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Outer-end marker: small filled square (terminal)
  ctx.save();
  ctx.fillStyle = stubColor;
  const sq = Math.max(3, cellSize * 0.14);
  ctx.fillRect(px - sq / 2, py - sq / 2, sq, sq);
  ctx.restore();

  // Labels
  ctx.save();
  ctx.fillStyle = '#cbd5e1';
  ctx.font = `${Math.max(9, Math.floor(cellSize * 0.42))}px ui-monospace, monospace`;
  const labelOffset = cellSize * 0.2;
  if (dir === 'left') {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(pin.label, px - labelOffset, py);
  } else if (dir === 'right') {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(pin.label, px + labelOffset, py);
  } else if (dir === 'up') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(pin.label, px, py - labelOffset);
  } else {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(pin.label, px, py + labelOffset);
  }
  // Pin name (inside body)
  if (options?.showPinNames && pin.name) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = `${Math.max(8, Math.floor(cellSize * 0.36))}px ui-monospace, monospace`;
    let nx = bodyX, ny = bodyY;
    if (dir === 'left') { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; nx += labelOffset; }
    else if (dir === 'right') { ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; nx -= labelOffset; }
    else if (dir === 'up') { ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ny += labelOffset; }
    else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ny -= labelOffset; }
    ctx.fillText(pin.name, nx, ny);
  }
  // Pin number (small text near outer end)
  if (options?.showPinNumbers && pin.number) {
    ctx.fillStyle = '#64748b';
    ctx.font = `${Math.max(7, Math.floor(cellSize * 0.32))}px ui-monospace, monospace`;
    let nx = px, ny = py;
    if (dir === 'left') { ctx.textAlign = 'right'; ctx.textBaseline = 'top'; nx -= labelOffset; ny += cellSize * 0.18; }
    else if (dir === 'right') { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; nx += labelOffset; ny += cellSize * 0.18; }
    else if (dir === 'up') { ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; nx += cellSize * 0.18; ny -= labelOffset; }
    else { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; nx += cellSize * 0.18; ny += labelOffset; }
    ctx.fillText(pin.number, nx, ny);
  }
  ctx.restore();

  // Selection halo
  if (options?.selected) {
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    const pad = cellSize * 0.4;
    ctx.strokeRect(
      Math.min(sx, px) - pad,
      Math.min(sy, py) - pad,
      Math.abs(sx - px) + pad * 2,
      Math.abs(sy - py) + pad * 2,
    );
    ctx.restore();
  }
}

/**
 * Render a full SymbolDesign onto a canvas context. The context is expected
 * to be already translated to the symbol's origin (top-left of bounding box)
 * and scaled by `cellSize`-per-grid-unit. Used both by the editor canvas and
 * by the generated plugin's render() so what-you-see-is-what-you-get.
 */
export function drawSymbolDesign(
  ctx: CanvasRenderingContext2D,
  design: SymbolDesign,
  cellSize: number,
  options?: {
    selectedId?: string | null;
    showPinNumbers?: boolean;
    showPinNames?: boolean;
    showPinElecTypes?: boolean;
  },
) {
  const selectedId = options?.selectedId ?? null;
  const bb = design.boundingBox;

  // Rectangles (body) — drawn first, behind everything else
  for (const rect of design.rects) {
    const x = rect.position.x * cellSize;
    const y = rect.position.y * cellSize;
    const w = rect.size.width * cellSize;
    const h = rect.size.height * cellSize;
    ctx.save();
    ctx.fillStyle = rect.fillColor || 'transparent';
    ctx.strokeStyle = rect.strokeColor;
    ctx.lineWidth = 1.5;
    if (rect.fillColor && rect.fillColor !== 'transparent') {
      ctx.fillRect(x, y, w, h);
    }
    ctx.strokeRect(x, y, w, h);
    if (selectedId === rect.id) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // Lines
  for (const line of design.lines) {
    const x1 = line.from.x * cellSize;
    const y1 = line.from.y * cellSize;
    const x2 = line.to.x * cellSize;
    const y2 = line.to.y * cellSize;
    ctx.save();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (selectedId === line.id) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      const pad = 4;
      ctx.strokeRect(
        Math.min(x1, x2) - pad,
        Math.min(y1, y2) - pad,
        Math.abs(x2 - x1) + pad * 2,
        Math.abs(y2 - y1) + pad * 2,
      );
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // Pins
  for (const pin of design.pins) {
    drawPin(ctx, pin, bb, cellSize, {
      selected: selectedId === pin.id,
      showPinNumbers: options?.showPinNumbers,
      showPinNames: options?.showPinNames,
      showPinElecTypes: options?.showPinElecTypes,
    });
  }

  // Texts
  for (const txt of design.texts) {
    const x = txt.position.x * cellSize;
    const y = txt.position.y * cellSize;
    ctx.save();
    ctx.fillStyle = txt.color;
    ctx.font = `${Math.max(8, Math.floor(txt.fontSize * cellSize / 12))}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(txt.text, x, y);
    if (selectedId === txt.id) {
      const metrics = ctx.measureText(txt.text);
      const tw = metrics.width;
      const th = Math.max(8, Math.floor(txt.fontSize * cellSize / 12));
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x - 2, y - 2, tw + 4, th + 4);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounding-box auto-fit
// ─────────────────────────────────────────────────────────────────────────────

/** Compute the bounding box that contains every element of the design. */
export function computeDesignBoundingBox(design: SymbolDesign): { width: number; height: number } {
  let maxX = 0, maxY = 0;
  for (const r of design.rects) {
    maxX = Math.max(maxX, r.position.x + r.size.width);
    maxY = Math.max(maxY, r.position.y + r.size.height);
  }
  for (const l of design.lines) {
    maxX = Math.max(maxX, l.from.x, l.to.x);
    maxY = Math.max(maxY, l.from.y, l.to.y);
  }
  for (const p of design.pins) {
    const dir = derivePinDirection(p, design.boundingBox);
    // Include the outer end (position) — the stub is inside the body already
    // for pins on the bounding box edge, but a pin may extend OUTSIDE the body
    // when the user moves it past the body edge. Include both ends to be safe.
    let endX = p.position.x;
    let endY = p.position.y;
    if (dir === 'left') endX = p.position.x - p.length;
    else if (dir === 'right') endX = p.position.x + p.length;
    else if (dir === 'up') endY = p.position.y - p.length;
    else if (dir === 'down') endY = p.position.y + p.length;
    maxX = Math.max(maxX, p.position.x, endX);
    maxY = Math.max(maxY, p.position.y, endY);
  }
  for (const t of design.texts) {
    maxX = Math.max(maxX, t.position.x + 3);
    maxY = Math.max(maxY, t.position.y + 1);
  }
  // Minimum 2x2 — never shrink to nothing
  return { width: Math.max(2, Math.ceil(maxX)), height: Math.max(2, Math.ceil(maxY)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// SymbolDesign → ComponentPlugin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a ComponentPlugin from a SymbolDesign. The plugin's render() reproduces
 * the editor canvas exactly. The plugin has NO `stamp()` (structural placeholder)
 * — assign a sub-circuit later if you want electrical behaviour.
 */
export function symbolDesignToPlugin(design: SymbolDesign): ComponentPlugin {
  const bb = design.boundingBox;

  const terminals: TerminalDef[] = design.pins.map((p) => ({
    id: p.id,
    label: p.label,
    position: p.position,
    electricalType: p.electricalType,
    name: p.name,
    number: p.number,
    length: p.length,
    shape: p.shape,
  }));

  const parameters: ParameterDef[] = [
    {
      key: 'value',
      label: 'Value',
      type: 'string',
      default: design.name,
      description: 'Part value or part number',
    },
  ];

  // Capture a frozen copy of the design at registration time so later edits in
  // the editor don't mutate the registered plugin behind the user's back.
  const frozenDesign: SymbolDesign = {
    name: design.name,
    type: design.type,
    description: design.description,
    boundingBox: { width: bb.width, height: bb.height },
    pins: design.pins.map((p) => ({ ...p, position: { ...p.position } })),
    rects: design.rects.map((r) => ({
      ...r,
      position: { ...r.position },
      size: { ...r.size },
    })),
    lines: design.lines.map((l) => ({
      ...l,
      from: { ...l.from },
      to: { ...l.to },
    })),
    texts: design.texts.map((t) => ({ ...t, position: { ...t.position } })),
  };

  const plugin: ComponentPlugin = {
    type: frozenDesign.type,
    name: frozenDesign.name,
    category: 'ic',
    description: frozenDesign.description || `User-defined symbol "${frozenDesign.name}"`,
    symbol: (frozenDesign.name.charAt(0).toUpperCase() || 'U') + frozenDesign.name.slice(1, 3),
    icon: 'SquareDashed',
    boundingBox: { width: bb.width, height: bb.height },
    terminals,
    parameters,
    defaults: { value: frozenDesign.name },
    keywords: ['symbol-editor', 'user', frozenDesign.type],
    render(ctx, _params, cellSize, _sim, instance) {
      // Body fill (semi-transparent) + reuse drawSymbolDesign for everything else
      // Slight tint of the canvas background so the body reads as a body
      drawSymbolDesign(ctx, frozenDesign, cellSize, {
        showPinNumbers: true,
        showPinNames: true,
        showPinElecTypes: false,
      });

      // Refdes above the box
      const refdes = instance?.refdes ?? 'U?';
      ctx.save();
      ctx.fillStyle = '#94a3b8';
      ctx.font = `${Math.max(9, Math.floor(cellSize * 0.42))}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(refdes, (bb.width * cellSize) / 2, -2);
      ctx.restore();
    },
    // No stamp() — symbol is a structural placeholder. The user can later
    // associate a sub-circuit definition to give it electrical behaviour.
    measure(params, terminals, sim) {
      return terminals.map((t) => {
        const pin = frozenDesign.pins.find((p) => p.id === t.terminalId);
        return {
          label: pin?.label ?? t.terminalId,
          value: (sim.nodeVoltage[t.nodeId] ?? 0).toFixed(3),
          unit: 'V',
        };
      });
    },
  };

  return plugin;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample designs (for tests / quick start)
// ─────────────────────────────────────────────────────────────────────────────

/** A simple 5-pin op-amp — useful as a starting template in the editor. */
export function sampleOpAmpDesign(): SymbolDesign {
  return {
    name: 'My Op-Amp',
    type: 'myOpamp',
    description: 'Sample op-amp symbol created with the symbol editor',
    // Body rect occupies the centre (x=[2,6], y=[1,6]); pins extend outward
    // to the bounding-box edges.
    boundingBox: { width: 8, height: 7 },
    rects: [
      {
        id: 'rect_body',
        position: { x: 2, y: 1 },
        size: { width: 4, height: 5 },
        strokeColor: '#22c55e',
        fillColor: 'transparent',
      },
    ],
    lines: [
      // + and - input markers (inside the body, just past the left edge)
      {
        id: 'line_in_plus',
        from: { x: 2.4, y: 2.5 },
        to: { x: 3.0, y: 2.5 },
        color: '#22d3ee',
        width: 1.5,
      },
      {
        id: 'line_in_minus',
        from: { x: 2.4, y: 5.0 },
        to: { x: 3.0, y: 5.0 },
        color: '#22d3ee',
        width: 1.5,
      },
    ],
    pins: [
      {
        id: 'in_plus', position: { x: 1, y: 2.5 },
        label: '+', name: 'IN+', number: '3',
        electricalType: 'input', shape: 'line', length: 1, direction: 'left',
      },
      {
        id: 'in_minus', position: { x: 1, y: 5.0 },
        label: '-', name: 'IN-', number: '2',
        electricalType: 'input', shape: 'line', length: 1, direction: 'left',
      },
      {
        id: 'out', position: { x: 7, y: 3.75 },
        label: 'OUT', name: 'OUT', number: '1',
        electricalType: 'output', shape: 'line', length: 1, direction: 'right',
      },
      {
        id: 'vcc', position: { x: 4, y: 0 },
        label: 'VCC', name: 'V+', number: '8',
        electricalType: 'power_in', shape: 'line', length: 1, direction: 'up',
      },
      {
        id: 'vee', position: { x: 4, y: 7 },
        label: 'VEE', name: 'V-', number: '4',
        electricalType: 'power_in', shape: 'line', length: 1, direction: 'down',
      },
    ],
    texts: [
      {
        id: 'text_name',
        position: { x: 3.0, y: 3.5 },
        text: 'OP',
        color: '#e2e8f0',
        fontSize: 12,
      },
    ],
  };
}

/** A blank design — just an empty body. */
export function blankDesign(): SymbolDesign {
  return {
    name: '',
    type: '',
    description: '',
    boundingBox: { width: 6, height: 5 },
    pins: [],
    rects: [
      {
        id: `rect_${Date.now().toString(36)}`,
        position: { x: 1, y: 0 },
        size: { width: 4, height: 5 },
        strokeColor: '#22c55e',
        fillColor: 'transparent',
      },
    ],
    lines: [],
    texts: [],
  };
}
