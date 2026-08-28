// Tests for the React-bypassing canvas renderer (canvas-renderer.ts).
// Covers: view-state helpers (hoverEquals, createInitialView), the imperative
// cursor-style computation, the status-overlay text formatter, and a
// mocked-2d-context smoke render of renderScene (wires, components, grid,
// ERC markers, placement ghost, no-connects, drawings) plus resize/dirty
// logic of the view object.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderScene,
  createInitialView,
  hoverEquals,
  computeCursorStyle,
  formatStatusText,
  EMPTY_HOVER,
  type RenderScene,
  type CanvasView,
} from '../src/components/circuit/canvas-renderer';
import { getPlugin, registerPlugin } from '../src/lib/circuit/registry';
import type { ComponentPlugin } from '../src/lib/circuit/types';
import type { ERCError } from '../src/lib/circuit/erc';

// ---------------------------------------------------------------------------
// Minimal recorder "2d context": records every call; enough surface for the
// renderer to run end-to-end without a DOM.
// ---------------------------------------------------------------------------
function makeMockCtx() {
  const ops: Array<{ op: string; args: unknown[] }> = [];
  const styles: Array<{ op: string; args: unknown[] }> = [];
  const ctx: Record<string, unknown> = {};
  const methods = [
    'save', 'restore', 'setTransform', 'scale', 'translate', 'rotate',
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect', 'fillRect', 'strokeRect',
    'fill', 'stroke', 'clip', 'fillText', 'drawImage', 'setLineDash',
  ];
  for (const m of methods) {
    ctx[m] = (...args: unknown[]) => { ops.push({ op: m, args }); };
  }
  ctx.measureText = (text: string) => ({ width: String(text).length * 6 });
  // record style/property assignments (fillStyle, strokeStyle, ...)
  for (const prop of [
    'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'globalAlpha',
    'shadowColor', 'shadowBlur', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin',
  ]) {
    let v: unknown = undefined;
    Object.defineProperty(ctx, prop, {
      get: () => v,
      set: (nv: unknown) => { v = nv; styles.push({ op: prop, args: [nv] }); },
      configurable: true,
    });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops, styles };
}

function count(ops: Array<{ op: string; args: unknown[] }>, op: string) {
  return ops.filter((o) => o.op === op).length;
}

// ---------------------------------------------------------------------------
// A tiny test plugin (resistor-like) with 2 terminals and a render fn.
// ---------------------------------------------------------------------------
function makeTestPlugin(): ComponentPlugin {
  return {
    type: 'testRes',
    name: 'Test Resistor',
    label: 'Test Resistor',
    symbol: 'R',
    category: 'passive',
    description: 'resistor for renderer tests',
    boundingBox: { width: 4, height: 2 },
    parameters: [
      { key: 'resistance', label: 'R', unit: 'Ω', type: 'number', default: 1000, min: 0.1 },
    ],
    terminals: [
      { id: 'a', label: 'A', position: { x: 0, y: 1 }, number: '1', name: 'left' },
      { id: 'b', label: 'B', position: { x: 4, y: 1 }, number: '2', name: 'right' },
    ],
    render: (ctx) => { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(10, 10); ctx.stroke(); },
    stamp: () => {},
  } as unknown as ComponentPlugin;
}

function baseScene(overrides: Partial<RenderScene> = {}): RenderScene {
  const view = createInitialView();
  return {
    view,
    dpr: 1,
    components: [],
    wires: [],
    sheets: [],
    selection: { type: null, id: null },
    multiSelection: { components: new Set<string>(), wires: new Set<string>() },
    simContext: null,
    running: false,
    showGrid: true,
    wireDraft: null,
    noConnects: [],
    drawings: [],
    units: 'grid',
    showPinNumbers: false,
    showPinNames: false,
    showPinElecTypes: false,
    netClasses: [],
    showNetColors: false,
    ercErrors: [],
    placementDraft: null,
    theme: 'dark',
    drag: null,
    wireDrag: null,
    rotateDrag: null,
    panDrag: false,
    flowPhase: 0,
    ...overrides,
  };
}

describe('canvas-renderer view helpers', () => {
  it('createInitialView returns neutral defaults', () => {
    const v = createInitialView();
    expect(v.pan).toEqual({ x: 0, y: 0 });
    expect(v.zoom).toBe(1);
    expect(v.width).toBe(800);
    expect(v.height).toBe(600);
    expect(v.hover).toBe(EMPTY_HOVER);
    expect(v.hoveredSheetId).toBeNull();
    expect(v.hoveredERC).toBeNull();
    expect(v.use45Routing).toBe(false);
  });

  it('hoverEquals detects field-level differences', () => {
    expect(hoverEquals(EMPTY_HOVER, { componentId: null, terminal: null, wireId: null, wireHandle: null, rotateHandle: null })).toBe(true);
    expect(hoverEquals(EMPTY_HOVER, { ...EMPTY_HOVER, componentId: 'r1' })).toBe(false);
    expect(hoverEquals(EMPTY_HOVER, { ...EMPTY_HOVER, wireId: 'w1' })).toBe(false);
    expect(hoverEquals(EMPTY_HOVER, { ...EMPTY_HOVER, rotateHandle: 'r1' })).toBe(false);
    const t = { componentId: 'r1', terminalId: 'a', pos: { x: 0, y: 0 } };
    expect(hoverEquals({ ...EMPTY_HOVER, terminal: t }, { ...EMPTY_HOVER, terminal: t })).toBe(true);
    expect(hoverEquals({ ...EMPTY_HOVER, terminal: t }, { ...EMPTY_HOVER, terminal: { ...t, terminalId: 'b' } })).toBe(false);
    const wh = { wireId: 'w1', segIndex: 0, pos: { x: 0, y: 0 } };
    expect(hoverEquals({ ...EMPTY_HOVER, wireHandle: wh }, { ...EMPTY_HOVER, wireHandle: wh })).toBe(true);
    expect(hoverEquals({ ...EMPTY_HOVER, wireHandle: wh }, { ...EMPTY_HOVER, wireHandle: { ...wh, segIndex: 1 } })).toBe(false);
  });
});

describe('canvas-renderer cursor style', () => {
  const comps = [
    { id: 'sw1', type: 'switch', position: { x: 0, y: 0 }, rotation: 0, parameters: { closed: true } },
  ] as never[];

  it('grabbing while rotating', () => {
    expect(computeCursorStyle(EMPTY_HOVER, false, [], true)).toBe('grabbing');
  });
  it('pointer over toggleable component while running', () => {
    const hover = { ...EMPTY_HOVER, componentId: 'sw1' };
    expect(computeCursorStyle(hover, true, comps, false)).toBe('pointer');
  });
  it('default elsewhere while running', () => {
    expect(computeCursorStyle(EMPTY_HOVER, true, comps, false)).toBe('default');
  });
  it('crosshair / grab / move / pointer ladder while editing', () => {
    expect(computeCursorStyle({ ...EMPTY_HOVER, terminal: { componentId: 'r1', terminalId: 'a', pos: { x: 0, y: 0 } } }, false, [], false)).toBe('crosshair');
    expect(computeCursorStyle({ ...EMPTY_HOVER, rotateHandle: 'r1' }, false, [], false)).toBe('grab');
    expect(computeCursorStyle({ ...EMPTY_HOVER, wireHandle: { wireId: 'w', segIndex: 0, pos: { x: 0, y: 0 } } }, false, [], false)).toBe('move');
    expect(computeCursorStyle({ ...EMPTY_HOVER, wireId: 'w' }, false, [], false)).toBe('pointer');
    expect(computeCursorStyle({ ...EMPTY_HOVER, componentId: 'r1' }, false, [], false)).toBe('move');
    expect(computeCursorStyle(EMPTY_HOVER, false, [], false)).toBe('crosshair');
  });
});

describe('canvas-renderer status text', () => {
  it('formats coordinates, zoom and run state', () => {
    expect(formatStatusText({ x: 12.34, y: -5.6 }, 1.25, true))
      .toBe('(12.3, -5.6)  zoom: 1.25x  ▶ running');
    expect(formatStatusText({ x: 0, y: 0 }, 0.4, false))
      .toBe('(0.0, 0.0)  zoom: 0.40x  ⏸ paused');
  });
});

describe('canvas-renderer renderScene (mocked ctx)', () => {
  let pluginRegistered = false;

  beforeEach(() => {
    if (!pluginRegistered) {
      registerPlugin(makeTestPlugin());
      pluginRegistered = true;
    }
  });

  it('renders an empty scene: background + grid only', () => {
    const { ctx, ops } = makeMockCtx();
    renderScene(ctx, baseScene());
    expect(count(ops, 'fillRect')).toBeGreaterThanOrEqual(1); // bg
    expect(count(ops, 'stroke')).toBeGreaterThanOrEqual(1); // grid lines
    // dpr transform applied and reset
    const setT = ops.filter((o) => o.op === 'setTransform');
    expect(setT.length).toBe(2);
    expect(setT[0].args).toEqual([1, 0, 0, 1, 0, 0]);
    expect(setT[1].args).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('skips grid when showGrid=false', () => {
    const { ctx, ops } = makeMockCtx();
    renderScene(ctx, baseScene({ showGrid: false }));
    // only background fill remains; no grid stroke loop
    expect(count(ops, 'fillRect')).toBe(1);
  });

  it('renders a component with refdes and terminals', () => {
    const { ctx, ops } = makeMockCtx();
    const comp = {
      id: 'r1', type: 'testRes', position: { x: 2, y: 2 }, rotation: 0,
      parameters: { resistance: 1000 }, refdes: 'R1',
    } as never;
    renderScene(ctx, baseScene({
      components: [comp],
      selection: { type: 'component', id: 'r1' },
    }));
    // selection halo rect + keyboard focus ring rect
    expect(count(ops, 'rect')).toBeGreaterThanOrEqual(2);
    // refdes text drawn
    const fillTexts = ops.filter((o) => o.op === 'fillText' && String(o.args[0]) === 'R1');
    expect(fillTexts.length).toBeGreaterThanOrEqual(1);
    // terminal dots (2 terminals, arc circles)
    expect(count(ops, 'arc')).toBeGreaterThanOrEqual(2);
  });

  it('renders a wire between two components with midpoint handles when idle', () => {
    const { ctx, ops } = makeMockCtx();
    const a = { id: 'r1', type: 'testRes', position: { x: 2, y: 2 }, rotation: 0, parameters: {} } as never;
    const b = { id: 'r2', type: 'testRes', position: { x: 10, y: 2 }, rotation: 0, parameters: {} } as never;
    const wire = {
      id: 'w1',
      from: { componentId: 'r1', terminalId: 'b' },
      to: { componentId: 'r2', terminalId: 'a' },
    } as never;
    renderScene(ctx, baseScene({ components: [a, b], wires: [wire] }));
    // wires drawn twice (below + overlay pass) + 2 terminal arcs
    expect(count(ops, 'moveTo')).toBeGreaterThanOrEqual(2);
    expect(count(ops, 'arc')).toBeGreaterThanOrEqual(2);
  });

  it('renders ERC markers when not running', () => {
    const { ctx, ops } = makeMockCtx();
    const comp = { id: 'r1', type: 'testRes', position: { x: 2, y: 2 }, rotation: 0, parameters: {} } as never;
    const err: ERCError = {
      severity: 'error', type: 'floating_pin', message: 'Floating input pin',
      componentId: 'r1', terminalId: 'a', position: { x: 2, y: 3 },
    } as never;
    renderScene(ctx, baseScene({ components: [comp], ercErrors: [err] }));
    // ERC marker draws an X (lines) at the marker position
    expect(count(ops, 'lineTo')).toBeGreaterThanOrEqual(2);
  });

  it('renders placement ghost at 50% alpha', () => {
    const { ctx, ops, styles } = makeMockCtx();
    renderScene(ctx, baseScene({
      placementDraft: { type: 'testRes', position: { x: 5, y: 5 }, rotation: 1 },
    }));
    // dashed ghost ring
    expect(count(ops, 'strokeRect')).toBeGreaterThanOrEqual(1);
    // alpha was lowered to 0.5 then restored
    const alphas = styles.filter((s) => s.op === 'globalAlpha').map((s) => s.args[0]);
    expect(alphas).toContain(0.5);
    expect(alphas[alphas.length - 1]).toBe(1);
  });

  it('renders no-connect X markers', () => {
    const { ctx, ops } = makeMockCtx();
    const comp = { id: 'r1', type: 'testRes', position: { x: 2, y: 2 }, rotation: 0, parameters: {} } as never;
    renderScene(ctx, baseScene({
      components: [comp],
      noConnects: [{ componentId: 'r1', terminalId: 'a' } as never],
    }));
    // X = 2 lineTo pairs
    expect(count(ops, 'lineTo')).toBeGreaterThanOrEqual(2);
  });

  it('renders drawing primitives (line + circle + text)', () => {
    const { ctx, ops } = makeMockCtx();
    renderScene(ctx, baseScene({
      drawings: [
        { type: 'line', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: '#fff', strokeWidth: 1 } as never,
        { type: 'circle', center: { x: 3, y: 3 }, radius: 2, color: '#fff', strokeWidth: 1 } as never,
        { type: 'text', position: { x: 1, y: 1 }, text: 'hello', color: '#fff', fontSize: 10 } as never,
      ],
    }));
    const texts = ops.filter((o) => o.op === 'fillText' && String(o.args[0]) === 'hello');
    expect(texts.length).toBe(1);
    expect(count(ops, 'arc')).toBeGreaterThanOrEqual(1);
  });

  it('uses light background for light theme', () => {
    const { ctx, styles } = makeMockCtx();
    renderScene(ctx, baseScene({ theme: 'light' }));
    const fills = styles.filter((s) => s.op === 'fillStyle').map((s) => s.args[0]);
    expect(fills[0]).toBe('#f8fafc');
  });

  it('does not throw with a render-erroring plugin', () => {
    const bad = makeTestPlugin();
    bad.type = 'testBad';
    (bad as { name?: string }).name = 'Test Bad';
    bad.render = () => { throw new Error('boom'); };
    registerPlugin(bad);
    const comp = { id: 'b1', type: 'testBad', position: { x: 0, y: 0 }, rotation: 0, parameters: {} } as never;
    const { ctx } = makeMockCtx();
    expect(() => renderScene(ctx, baseScene({ components: [comp] }))).not.toThrow();
  });

  it('viewRef mutation + renderScene reflects pan/zoom changes without React', () => {
    // Simulate what the render loop does: mutate view, re-render, check the
    // grid moves (background origin rect position changes with pan).
    const view: CanvasView = createInitialView();
    const { ctx, ops } = makeMockCtx();
    renderScene(ctx, baseScene({ view }));
    const origin1 = ops.find((o) => o.op === 'fillRect' && String(o.args[2]) === '3');
    view.pan = { x: 40, y: 20 };
    const { ctx: ctx2, ops: ops2 } = makeMockCtx();
    renderScene(ctx2 as unknown as CanvasRenderingContext2D, baseScene({ view }));
    const origin2 = ops2.find((o) => o.op === 'fillRect' && String(o.args[2]) === '3');
    expect(origin1).toBeDefined();
    expect(origin2).toBeDefined();
    expect(origin1?.args[0]).not.toEqual(origin2?.args[0]); // pan moved the origin dot
  });
});
