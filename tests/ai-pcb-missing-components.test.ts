// Tests for the server-side PCB verification pipeline + missing-components
// logging added to the AI assistant:
//
//   1. TurnManager — pcb_update events with real PCB snapshots, done.pcb,
//      missing_component events + done.missingComponents, provider-level
//      429 retry visibility (status events with rateLimited reason).
//   2. Client session engine — pcb_update loads into the usePCB store
//      (footprints/traces/vias/board/padNets/ratsnest), missing_component
//      lands on the assistant message, done.pcb / done.missingComponents
//      merge correctly, server-applied setBoardSize is not double-executed.
//
// Provider is a mocked ZaiPublicProvider (ZAI_API_KEY + stubbed fetch
// returning OpenAI-style SSE chunks) — same harness as ai-turn-resume.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

const { TurnManager, getTurnManager } = await import('../src/lib/ai/turn-manager');
const { useChatSession } = await import('../src/lib/ai/chat-session');
const { useEditor } = await import('../src/lib/circuit/store');
const { usePCB } = await import('../src/lib/pcb/store');
await import('../src/lib/circuit/components'); // register plugins

const ORIGINAL_ENV = { ...process.env };
const enc = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — provider fetch mock (OpenAI-compatible SSE)
// ─────────────────────────────────────────────────────────────────────────────

type FetchHandler = (url: string, init?: any) => Response | Promise<Response>;

function sseBody(chunks: any[]): ReadableStream<Uint8Array> {
  const text = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function contentResponse(text: string): Response {
  return {
    ok: true, status: 200,
    json: async () => ({}),
    text: async () => '',
    body: sseBody([
      { choices: [{ delta: { content: text } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  } as unknown as Response;
}

function toolCallResponse(id: string, name: string, args: string): Response {
  return {
    ok: true, status: 200,
    json: async () => ({}),
    text: async () => '',
    body: sseBody([
      { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  } as unknown as Response;
}

function rateLimitedResponse(): Response {
  return {
    ok: false, status: 429,
    json: async () => ({ error: 'Too many requests' }),
    text: async () => JSON.stringify({ error: 'Too many requests' }),
    body: null,
  } as unknown as Response;
}

/** Wait until fn() returns truthy (poll loop with timeout). */
async function waitFor(fn: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

let mgr: TurnManager;

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.ZAI_API_KEY = 'zai-key-test';
  process.env.ZAI_BASE_URL = 'https://api.example.test/v4';
  delete process.env.ZAI_MODEL;
  delete process.env.ZAI_CONFIG;
  mgr = new TurnManager();
});

afterEach(() => {
  mgr.dispose();
  getTurnManager().dispose();
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run a turn with the given provider fetch handler and return all events. */
async function runTurnCollect(params: any, fetchHandler: FetchHandler): Promise<any[]> {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => fetchHandler(url, init)));
  const events: any[] = [];
  const turnId = mgr.startTurn(params);
  const attached = mgr.attach(turnId, { onEvent: e => events.push(e) })!;
  events.push(...attached.replay);
  expect(attached.running).toBe(true);
  await waitFor(() => mgr.getTurnStatus(turnId) !== 'running', 15000, 'turn to finalize');
  return events;
}

function clientSse(events: Array<{ event: string; data: any }>): Response {
  const body = events.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({}),
    body: new ReadableStream({
      start(c) { c.enqueue(enc.encode(body)); c.close(); },
    }),
  } as unknown as Response;
}

const BASE_PARAMS = { messages: [{ role: 'user', content: 'build a PCB please' }] };

/** A small working circuit the PCB tools can import for real. */
const LED_CIRCUIT = {
  components: [
    { id: 'gnd', type: 'ground', position: { x: 0, y: 6 }, rotation: 0, parameters: { net: 'GND' } },
    { id: 'v1', type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0, parameters: { voltage: 5 } },
    { id: 'r1', type: 'resistor', position: { x: 6, y: 0 }, rotation: 0, parameters: { resistance: 1000 } },
    { id: 'led1', type: 'led', position: { x: 12, y: 0 }, rotation: 0, parameters: {} },
  ],
  wires: [
    { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
    { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'led1', terminalId: 'a' } },
    { id: 'w3', from: { componentId: 'led1', terminalId: 'k' }, to: { componentId: 'gnd', terminalId: 'g' } },
    { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. TurnManager — pcb_update / missing_component / retry visibility
// ─────────────────────────────────────────────────────────────────────────────

describe('TurnManager: server-side PCB pipeline events', () => {
  it('emits pcb_update with a real footprint snapshot and pcb in done', async () => {
    let call = 0;
    const events = await runTurnCollect(
      { ...BASE_PARAMS, circuit: LED_CIRCUIT },
      () => {
        call++;
        if (call === 1) return toolCallResponse('c1', 'pcb.importFromSchematic', '{}');
        if (call === 2) return toolCallResponse('c2', 'pcb.autoRoute', '{}');
        return contentResponse('PCB routed and verified.');
      },
    );

    const pcbUpdates = events.filter(e => e.type === 'pcb_update');
    // One per mutating PCB tool (import + autoRoute)
    expect(pcbUpdates.length).toBe(2);

    const afterImport = pcbUpdates[0].data;
    expect(Array.isArray(afterImport.footprints)).toBe(true);
    expect(afterImport.footprints.length).toBeGreaterThanOrEqual(3);
    expect(afterImport.traces).toEqual([]);
    expect(afterImport.board.width).toBeGreaterThan(0);
    expect(Array.isArray(afterImport.padNets)).toBe(true);
    expect(afterImport.padNets.length).toBeGreaterThan(0);
    expect(Array.isArray(afterImport.ratsnest)).toBe(true);
    expect(afterImport.ratsnest.length).toBeGreaterThan(0);

    const afterRoute = pcbUpdates[1].data;
    expect(afterRoute.traces.length).toBeGreaterThan(0); // REAL routing happened

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.data.pcb).toBeDefined();
    expect(done.data.pcb.traces.length).toBeGreaterThan(0);
    // Events carry strictly increasing seq
    const seqs = events.map(e => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  }, 20000);

  it('autoRoute returns REAL statistics to the model (tool result content)', async () => {
    let call = 0;
    let routeToolJson = '';
    const events = await runTurnCollect(
      { ...BASE_PARAMS, circuit: LED_CIRCUIT },
      () => {
        call++;
        if (call === 1) return toolCallResponse('c1', 'pcb.importFromSchematic', '{}');
        if (call === 2) return toolCallResponse('c2', 'pcb.autoRoute', '{}');
        return contentResponse('Done.');
      },
    );
    // The tool_call event carries the result the model saw
    const routeCall = events.find(e => e.type === 'tool_call' && e.data.name === 'pcb.autoRoute');
    expect(routeCall).toBeDefined();
    routeToolJson = JSON.stringify(routeCall.data.result);
    expect(routeToolJson).toContain('routed');
    expect(routeCall.data.result.totalConnections).toBeGreaterThan(0);
    expect(routeCall.data.result.drc).toBeDefined();
    // done.toolCalls carries it too
    const done = events.find(e => e.type === 'done');
    const doneRoute = done.data.toolCalls.find((t: any) => t.name === 'pcb.autoRoute');
    expect(doneRoute.result.vias).toBeDefined();
    expect(doneRoute.result.totalLengthMm).toBeGreaterThanOrEqual(0);
    expect(routeToolJson.length).toBeGreaterThan(0);
  }, 20000);

  it('emits missing_component + includes the list in done when addComponent hits an unknown type', async () => {
    let call = 0;
    const events = await runTurnCollect(BASE_PARAMS, () => {
      call++;
      if (call === 1) return toolCallResponse('c1', 'schematic.addComponent', JSON.stringify({ type: 'fluxCapacitor42', x: 2, y: 2 }));
      if (call === 2) return toolCallResponse('c2', 'schematic.addComponent', JSON.stringify({ type: 'anotherMissingPart', x: 4, y: 4 }));
      return contentResponse('I could not place some parts.');
    });

    const missing = events.filter(e => e.type === 'missing_component');
    expect(missing.length).toBe(2);
    expect(missing[0].data.type).toBe('fluxCapacitor42');
    expect(missing[1].data.type).toBe('anotherMissingPart');

    const done = events.find(e => e.type === 'done');
    expect(done.data.missingComponents).toEqual(['fluxCapacitor42', 'anotherMissingPart']);
  }, 20000);

  it('does NOT emit missing_component for types that exist', async () => {
    let call = 0;
    const events = await runTurnCollect(BASE_PARAMS, () => {
      call++;
      if (call === 1) return toolCallResponse('c1', 'schematic.addComponent', JSON.stringify({ type: 'resistor', x: 2, y: 2 }));
      return contentResponse('Added.');
    });
    expect(events.some(e => e.type === 'missing_component')).toBe(false);
    const done = events.find(e => e.type === 'done');
    expect(done.data.missingComponents).toBeUndefined();
  }, 20000);

  it('provider-level 429 retries emit user-visible provider-retry status events (rateLimited)', async () => {
    // Rate-limit backoffs are short (12s confirmation retry — the observed
    // account-level quota block lasts hours, so waiting longer only
    // manufactures spinner time), so this test drives the turn under fake
    // timers instead of waiting wall-clock time.
    let call = 0;
    const fetchMock = vi.fn((_url: string, _init?: any) => {
      call++;
      // One transient 429 then success — the single retry recovers.
      if (call <= 1) return rateLimitedResponse();
      return contentResponse('Recovered.');
    });
    vi.stubGlobal('fetch', fetchMock);
    const events: any[] = [];
    vi.useFakeTimers();
    try {
      const turnId = mgr.startTurn(BASE_PARAMS);
      const attached = mgr.attach(turnId, { onEvent: e => events.push(e) })!;
      events.push(...attached.replay);
      expect(attached.running).toBe(true);
      let advanced = 0;
      while (mgr.getTurnStatus(turnId) === 'running' && advanced < 180_000) {
        await vi.advanceTimersByTimeAsync(5_000);
        advanced += 5_000;
      }
      expect(mgr.getTurnStatus(turnId)).toBe('done');
    } finally {
      vi.useRealTimers();
    }

    const retries = events.filter(e => e.type === 'status' && e.data.phase === 'provider-retry');
    expect(retries.length).toBe(1);
    expect(retries[0].data.attempt).toBe(1);
    expect(retries[0].data.reason).toMatch(/rate limited/i);
    // Short confirmation backoff: ~12s — never a fast 2s re-fire, never the
    // old 45s+ patient ladder.
    expect(retries[0].data.delayMs).toBeGreaterThanOrEqual(11_000);
    expect(retries[0].data.delayMs).toBeLessThan(30_000);
    const done = events.find(e => e.type === 'done');
    expect(done.data.response).toBe('Recovered.');
    // Exactly two gateway touches — no hammering.
    expect(fetchMock.mock.calls.length).toBe(2);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Client session engine — pcb_update / missing_component handling
// ─────────────────────────────────────────────────────────────────────────────

describe('chat-session engine: pcb + missing component handling', () => {
  beforeEach(() => {
    useChatSession.setState({
      messages: [], active: null, autoApply: true,
      totalTokens: { prompt: 0, completion: 0, total: 0 },
    });
    useEditor.getState().loadDocument({ version: 1, components: [], wires: [] });
    usePCB.setState({
      board: { width: 80, height: 60 },
      footprints: [], traces: [], vias: [], ratsnest: [],
      padNets: new Map(), drcErrors: [], copperPours: [], teardrops: [],
      activeLayer: 'top', defaultTraceWidth: 0.25,
      selectedFootprintId: null, selectedTraceId: null,
    });
  });

  afterEach(() => {
    try { useChatSession.getState().stop(); } catch { /* nothing running */ }
  });

  it('pcb_update events load the server PCB into the usePCB store live', async () => {
    const pcbDoc = {
      version: 1,
      board: { width: 62, height: 44 },
      footprints: LED_CIRCUIT.components.map((c, i) => ({
        id: `fp_${c.id}`,
        componentId: c.id,
        refdes: `U${i}`,
        position: { x: 10 + i * 8, y: 10 },
        rotation: 0,
        layer: 'top',
        bodySize: { width: 4, height: 3 },
        pads: [],
      })),
      traces: [{ id: 't1', net: 'N1', layer: 'top', width: 0.25, segments: [{ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } }] }],
      vias: [],
      ratsnest: [{ fromPadId: 'p1', toPadId: 'p2', net: 'N1' }],
      padNets: [['v1:p', 'N1'], ['r1:a', 'N1']],
    };
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_pcb', seq: 1 } },
      { event: 'pcb_update', data: { ...pcbDoc, seq: 2 } },
      { event: 'done', data: { response: 'PCB laid out.', toolCalls: [], circuit: { components: [], wires: [] }, seq: 3 } },
    ])));

    useChatSession.getState().send('Make me a PCB');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 8000, 'turn completion');

    const pcb = usePCB.getState();
    expect(pcb.footprints.length).toBe(4);
    expect(pcb.board.width).toBe(62);
    expect(pcb.traces.length).toBe(1);
    expect(pcb.ratsnest.length).toBe(1);
    expect(pcb.padNets.get('v1:p')).toBe('N1');
    expect(pcb.padNets.get('r1:a')).toBe('N1');
    expect(useChatSession.getState().messages[1].pcbUpdated).toBe(true);
  });

  it('missing_component events accumulate on the assistant message (deduped)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_miss', seq: 1 } },
      { event: 'missing_component', data: { type: 'fluxCapacitor42', seq: 2 } },
      { event: 'missing_component', data: { type: 'fluxCapacitor42', seq: 3 } },
      { event: 'missing_component', data: { type: 'galvanicSensor', seq: 4 } },
      { event: 'done', data: { response: 'Some parts missing.', toolCalls: [], circuit: { components: [], wires: [] }, seq: 5 } },
    ])));

    useChatSession.getState().send('Build a flux capacitor circuit');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 8000, 'turn completion');

    const msg = useChatSession.getState().messages[1];
    expect(msg.missingComponents).toEqual(['fluxCapacitor42', 'galvanicSensor']);
  });

  it('done.pcb applies even without a live pcb_update (reload-resume path) and done.missingComponents merge', async () => {
    const pcbDoc = {
      version: 1,
      board: { width: 50, height: 40 },
      footprints: [{ id: 'fp1', componentId: 'r1', refdes: 'R1', position: { x: 10, y: 10 }, rotation: 0, layer: 'top', bodySize: { width: 4, height: 3 }, pads: [] }],
      traces: [], vias: [], ratsnest: [], padNets: [],
    };
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_donepcb', seq: 1 } },
      { event: 'done', data: {
        response: 'Done.', toolCalls: [], circuit: { components: [], wires: [] },
        pcb: pcbDoc, missingComponents: ['thingOne'], seq: 2,
      } },
    ])));

    useChatSession.getState().send('PCB please');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 8000, 'turn completion');

    expect(usePCB.getState().footprints.length).toBe(1);
    expect(usePCB.getState().board.width).toBe(50);
    expect(useChatSession.getState().messages[1].missingComponents).toEqual(['thingOne']);
    expect(useChatSession.getState().messages[1].pcbUpdated).toBe(true);
  });

  it('server-applied pcb.setBoardSize is NOT double-executed on the client', async () => {
    let clientSetBoardSizeCalls = 0;
    const orig = usePCB.getState().setBoardSize;
    usePCB.setState({
      setBoardSize: (...args: any[]) => { clientSetBoardSizeCalls++; return (orig as any)(...args); },
    });
    try {
      const pcbDoc = {
        version: 1,
        board: { width: 100, height: 80 },
        footprints: [], traces: [], vias: [], ratsnest: [], padNets: [],
      };
      vi.stubGlobal('fetch', vi.fn(() => clientSse([
        { event: 'turn', data: { turnId: 't_size', seq: 1 } },
        { event: 'tool_call', data: { name: 'pcb.setBoardSize', args: { width: 100, height: 80 }, result: { width: 100, height: 80, applied: 'server' }, ok: true, seq: 2 } },
        { event: 'pcb_update', data: { ...pcbDoc, seq: 3 } },
        { event: 'done', data: { response: 'Resized.', toolCalls: [], circuit: { components: [], wires: [] }, seq: 4 } },
      ])));
      useChatSession.getState().send('Make the board bigger');
      await waitFor(() => {
        const s = useChatSession.getState();
        return !s.active && s.messages.length === 2 && !s.messages[1].loading;
      }, 8000, 'turn completion');
      // The client action was suppressed (applied:'server') — only the
      // pcb_update load touched the store.
      expect(clientSetBoardSizeCalls).toBe(0);
      expect(usePCB.getState().board.width).toBe(100);
    } finally {
      usePCB.setState({ setBoardSize: orig });
    }
  });
});
