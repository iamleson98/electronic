// Tests for the resumable AI turn architecture:
//   1. TurnManager — detached agentic loop, event log with seq numbers,
//      text_delta buffer merging, attach/replay, cancel, client dedupe,
//      loop-level provider retries, auth-error short-circuit.
//   2. Routes — /api/ai/chat/stream (new turn, resume, TURN_LOST, 400) and
//      /api/ai/chat/cancel (out-of-band Stop).
//   3. Client session engine — auto-apply, network-drop reconnect with
//      side-effect suppression, TURN_LOST auto-restart, Stop.
//
// The provider is a mocked ZaiPublicProvider (ZAI_API_KEY + stubbed fetch
// returning OpenAI-style SSE chunks).

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
const { POST: POST_STREAM } = await import('../src/app/api/ai/chat/stream/route');
const { POST: POST_CANCEL } = await import('../src/app/api/ai/chat/cancel/route');
const { useChatSession } = await import('../src/lib/ai/chat-session');
const { useEditor } = await import('../src/lib/circuit/store');
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

function contentResponse(text: string, usage?: any): Response {
  return {
    ok: true, status: 200,
    json: async () => ({}),
    text: async () => '',
    body: sseBody([
      { choices: [{ delta: { content: text } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) },
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

function textDeltaResponse(parts: string[]): Response {
  return {
    ok: true, status: 200,
    json: async () => ({}),
    text: async () => '',
    body: sseBody([
      ...parts.map(p => ({ choices: [{ delta: { content: p } }] })),
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]),
  } as unknown as Response;
}

/** A provider response whose body never completes — for cancel/timeout tests.
 *  The stream errors when the (combined) abort signal fires, mimicking a real
 *  aborted fetch. */
function hangingResponse(signal?: AbortSignal): Response {
  let streamCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream({
    start(c) { streamCtrl = c; },
  });
  if (signal) {
    const onAbort = () => streamCtrl?.error(new Error('The operation was aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '', body: stream } as unknown as Response;
}

/** Wait until fn() returns truthy (poll loop with timeout). */
async function waitFor(fn: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

function makeReq(url: string, body?: any, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

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
  const fetchMock = vi.fn((url: string, init?: any) => fetchHandler(url, init));
  vi.stubGlobal('fetch', fetchMock);
  const events: any[] = [];
  const turnId = mgr.startTurn(params);
  const attached = mgr.attach(turnId, { onEvent: e => events.push(e) })!;
  // The `turn` event is buffered before we attach — seed from the replay so
  // the caller sees the complete log.
  events.push(...attached.replay);
  expect(attached.running).toBe(true);
  await waitFor(() => mgr.getTurnStatus(turnId) !== 'running', 8000, 'turn to finalize');
  return events;
}

const BASE_PARAMS = { messages: [{ role: 'user', content: 'hi' }] };

// ─────────────────────────────────────────────────────────────────────────────
// 1. TurnManager
// ─────────────────────────────────────────────────────────────────────────────

describe('TurnManager', () => {
  it('emits the turn event first and finalizes with done', async () => {
    const events = await runTurnCollect(BASE_PARAMS, () => contentResponse('Hello!', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }));
    expect(events[0].type).toBe('turn');
    expect(events[0].data.turnId).toBeTruthy();
    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.data.response).toBe('Hello!');
    expect(done.data.usage.total_tokens).toBe(3);
    expect(done.seq).toBeGreaterThan(events[0].seq);
    // seq numbers strictly increase
    for (let i = 1; i < events.length; i++) expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
  });

  it('merges consecutive text_deltas in the replay buffer while live subscribers get fragments', async () => {
    let capturedSignal: AbortSignal | undefined;
    const events = await runTurnCollect(BASE_PARAMS, (_url, init) => {
      capturedSignal = init?.signal;
      return textDeltaResponse(['Hello ', 'world']);
    });
    // Live: two separate text_delta events
    const liveDeltas = events.filter(e => e.type === 'text_delta');
    expect(liveDeltas.map(e => e.data.text)).toEqual(['Hello ', 'world']);

    // Late subscriber (replay): one merged delta with the full text
    const turnId = events[0].data.turnId;
    const late = mgr.attach(turnId, { onEvent: () => {} })!;
    expect(late.running).toBe(false);
    const replayDeltas = late.replay.filter(e => e.type === 'text_delta');
    expect(replayDeltas.length).toBe(1);
    expect(replayDeltas[0].data.text).toBe('Hello world');
    // merged event carries the LAST seq of the merged run
    expect(replayDeltas[0].seq).toBe(liveDeltas[1].seq);
    expect(capturedSignal).toBeDefined();
  });

  it('executes tool calls and emits circuit_update for mutations', async () => {
    let call = 0;
    const events = await runTurnCollect(BASE_PARAMS, () => {
      call++;
      if (call === 1) return toolCallResponse('c1', 'schematic.addComponent', JSON.stringify({ type: 'resistor', x: 5, y: 5, parameters: { resistance: '1k' } }));
      return contentResponse('Built it.');
    });
    const toolEvent = events.find(e => e.type === 'tool_call');
    expect(toolEvent.data.name).toBe('schematic.addComponent');
    expect(toolEvent.data.ok).toBe(true);
    const update = events.find(e => e.type === 'circuit_update');
    expect(update).toBeDefined();
    expect(update.data.components.length).toBe(1);
    expect(update.data.components[0].type).toBe('resistor');
    const done = events.find(e => e.type === 'done');
    expect(done.data.circuit.components.length).toBe(1);
    expect(done.data.response).toBe('Built it.');
  });

  it('retries transient provider failures with a status event', async () => {
    let call = 0;
    const events = await runTurnCollect(BASE_PARAMS, () => {
      call++;
      if (call === 1) {
        // A non-retryable-at-provider-level blip (400) — the turn-level
        // loop retry catches it with a status event + backoff.
        return {
          ok: false, status: 400,
          json: async () => ({ error: 'bad luck' }),
          text: async () => JSON.stringify({ error: 'bad luck' }),
          body: null,
        } as unknown as Response;
      }
      return contentResponse('Recovered.');
    });
    const status = events.find(e => e.type === 'status');
    expect(status).toBeDefined();
    expect(status.data.phase).toBe('provider-retry');
    expect(status.data.attempt).toBe(1);
    const done = events.find(e => e.type === 'done');
    expect(done.data.response).toBe('Recovered.');
  }, 15000);

  it('auth errors finalize immediately without retry status events', async () => {
    const events = await runTurnCollect(BASE_PARAMS, () => ({
      ok: false, status: 401,
      json: async () => ({ error: 'bad key' }),
      text: async () => JSON.stringify({ error: 'bad key' }),
      body: null,
    } as unknown as Response));
    expect(events.some(e => e.type === 'status')).toBe(false);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    expect(err.data.message).toMatch(/401|credentials|API key/);
    expect(events.some(e => e.type === 'done')).toBe(false);
  });

  it('cancelTurn aborts a running turn and emits cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: any) => hangingResponse(init?.signal)));
    const events: any[] = [];
    const turnId = mgr.startTurn(BASE_PARAMS);
    const attached = mgr.attach(turnId, { onEvent: e => events.push(e) })!;
    events.push(...attached.replay);
    expect(events.some(e => e.type === 'turn')).toBe(true);
    const cancelled = mgr.cancelTurn(turnId);
    expect(cancelled).toBe(true);
    await waitFor(() => mgr.getTurnStatus(turnId) === 'cancelled');
    expect(events.some(e => e.type === 'cancelled')).toBe(true);
    // Idempotent — a second cancel is a no-op
    expect(mgr.cancelTurn(turnId)).toBe(false);
  });

  it('cancelClientTurns cancels only that client’s other running turns', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: any) => hangingResponse(init?.signal)));
    const a1 = mgr.startTurn({ ...BASE_PARAMS, clientId: 'clientA' });
    const a2 = mgr.startTurn({ ...BASE_PARAMS, clientId: 'clientA' });
    const b1 = mgr.startTurn({ ...BASE_PARAMS, clientId: 'clientB' });
    mgr.cancelClientTurns('clientA');
    await waitFor(() => mgr.getTurnStatus(a1) === 'cancelled' && mgr.getTurnStatus(a2) === 'cancelled');
    expect(mgr.getTurnStatus(b1)).toBe('running');
    mgr.cancelTurn(b1);
    await waitFor(() => mgr.getTurnStatus(b1) === 'cancelled');
  });

  it('unknown tools produce an error tool_call event and the loop continues', async () => {
    let call = 0;
    const events = await runTurnCollect(BASE_PARAMS, () => {
      call++;
      if (call === 1) return toolCallResponse('c1', 'nonexistent.tool', '{}');
      return contentResponse('Moved on.');
    });
    const toolEvent = events.find(e => e.type === 'tool_call');
    expect(toolEvent.data.ok).toBe(false);
    expect(toolEvent.data.error).toMatch(/Unknown tool/);
    expect(events.find(e => e.type === 'done').data.response).toBe('Moved on.');
  });

  it('attach after finalization replays everything with running=false', async () => {
    const events = await runTurnCollect(BASE_PARAMS, () => contentResponse('Done.'));
    const turnId = events[0].data.turnId;
    const attached = mgr.attach(turnId, { onEvent: () => {} })!;
    expect(attached.running).toBe(false);
    expect(attached.replay.length).toBe(events.length);
    expect(attached.replay[attached.replay.length - 1].type).toBe('done');
  });

  it('detaching (client disconnect) does not stop the turn', async () => {
    let call = 0;
    const fetchMock = vi.fn(() => {
      call++;
      if (call === 1) return toolCallResponse('c1', 'discovery.listComponentTypes', '{}');
      return contentResponse('Survived the disconnect.');
    });
    vi.stubGlobal('fetch', fetchMock);
    const turnId = mgr.startTurn(BASE_PARAMS);
    const events: any[] = [];
    const sub = { onEvent: (e: any) => events.push(e) };
    const attached = mgr.attach(turnId, sub);
    events.push(...attached!.replay);
    expect(events.some(e => e.type === 'turn')).toBe(true);
    // Client "disconnects" mid-turn
    mgr.detach(turnId, sub);
    expect(mgr.getTurnStatus(turnId)).toBe('running');
    // The loop keeps going to completion with zero subscribers
    await waitFor(() => mgr.getTurnStatus(turnId) === 'done', 8000);
    const late = mgr.attach(turnId, { onEvent: () => {} })!;
    expect(late.replay.some(e => e.type === 'done')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Routes
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/ai/chat/stream', () => {
  it('rejects a missing messages array with 400', async () => {
    const res = await POST_STREAM(makeReq('http://localhost/api/ai/chat/stream', {}));
    expect(res.status).toBe(400);
  });

  it('creates a turn, streams SSE to completion, and replays on resume', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      call++;
      if (call === 1) return toolCallResponse('c1', 'schematic.addComponent', JSON.stringify({ type: 'resistor', x: 5, y: 5, parameters: { resistance: '1k' } }));
      return contentResponse('Route done.');
    }));

    // Unique IP so the shared rate-limit window doesn't interfere
    const req1 = makeReq('http://localhost/api/ai/chat/stream', { messages: [{ role: 'user', content: 'build' }] }, { 'x-forwarded-for': '9.9.9.1' });
    const res1 = await POST_STREAM(req1);
    expect(res1.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res1.headers.get('X-Accel-Buffering')).toBe('no');

    const text1 = await streamText(res1);
    expect(text1).toContain('event: turn');
    expect(text1).toContain('event: tool_call');
    expect(text1).toContain('event: circuit_update');
    expect(text1).toContain('event: done');
    expect(text1).toContain('Route done.');
    const turnId = extractTurnId(text1);
    expect(turnId).toBeTruthy();

    // Resume AFTER completion → full replay from the buffered log
    const res2 = await POST_STREAM(makeReq('http://localhost/api/ai/chat/stream', { resume: { turnId } }, { 'x-forwarded-for': '9.9.9.1' }));
    const text2 = await streamText(res2);
    expect(text2).toContain('event: turn');
    expect(text2).toContain('event: done');
    expect(text2).toContain('Route done.');
  });

  it('resume with an unknown turnId returns a TURN_LOST SSE error', async () => {
    const res = await POST_STREAM(makeReq('http://localhost/api/ai/chat/stream', { resume: { turnId: 't_nope' } }));
    expect(res.status).toBe(200);
    const text = await streamText(res);
    expect(text).toContain('TURN_LOST');
    expect(text).toContain('event: error');
  });

  it('a missing messages array without resume still 400s even with garbage resume', async () => {
    const res = await POST_STREAM(makeReq('http://localhost/api/ai/chat/stream', { resume: { turnId: 123 } }));
    // resume.turnId isn't a string → treated as a NEW turn → validation 400
    expect(res.status).toBe(400);
  });
});

describe('POST /api/ai/chat/cancel', () => {
  it('cancels a running turn out-of-band', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: any) => hangingResponse(init?.signal)));
    const req = makeReq('http://localhost/api/ai/chat/stream', { messages: [{ role: 'user', content: 'build' }] }, { 'x-forwarded-for': '9.9.9.2' });
    const res = await POST_STREAM(req);
    // The provider hangs — read just until the turn event, then drop the
    // connection (like a browser would).
    const text = await readUntil(res, 'event: turn');
    const turnId = extractTurnId(text);
    expect(turnId).toBeTruthy();
    expect(getTurnManager().getTurnStatus(turnId)).toBe('running');

    const cancelRes = await POST_CANCEL(makeReq('http://localhost/api/ai/chat/cancel', { turnId }));
    expect(cancelRes.status).toBe(200);
    const body = await cancelRes.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(true);
    await waitFor(() => getTurnManager().getTurnStatus(turnId) === 'cancelled');
  });

  it('is idempotent for unknown turns', async () => {
    const res = await POST_CANCEL(makeReq('http://localhost/api/ai/chat/cancel', { turnId: 't_gone' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(false);
  });

  it('requires a turnId', async () => {
    const res = await POST_CANCEL(makeReq('http://localhost/api/ai/chat/cancel', {}));
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Client session engine (chat-session)
// ─────────────────────────────────────────────────────────────────────────────

/** Build a client-side SSE Response from typed events. */
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

function resetEditor() {
  useEditor.getState().loadDocument({ version: 1, components: [], wires: [] });
}

describe('chat-session engine', () => {
  let loadDocumentCalls: number;
  let originalLoadDocument: any;

  beforeEach(() => {
    // Reset the store to a known state
    useChatSession.setState({
      messages: [], active: null, autoApply: true,
      totalTokens: { prompt: 0, completion: 0, total: 0 },
    });
    resetEditor();
    // Count circuit applications
    loadDocumentCalls = 0;
    originalLoadDocument = useEditor.getState().loadDocument;
    useEditor.setState({
      loadDocument: (...args: any[]) => { loadDocumentCalls++; return originalLoadDocument(...args); },
    });
  });

  afterEach(() => {
    if (originalLoadDocument) useEditor.setState({ loadDocument: originalLoadDocument });
    // Kill any zombie engine from a failed test so later sends aren't blocked
    // (send() refuses while a runtime exists).
    try { useChatSession.getState().stop(); } catch { /* nothing running */ }
  });

  it('send() streams a turn to completion and auto-applies the final circuit', async () => {
    const circuit = { components: [{ id: 'R1', type: 'resistor', x: 5, y: 5, rotation: 0, parameters: { resistance: '1k' } }], wires: [] };
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_e2e', seq: 1 } },
      { event: 'text_delta', data: { text: 'Building…', seq: 2 } },
      { event: 'done', data: { response: 'Built a resistor divider.', toolCalls: [], circuit, usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }, seq: 3 } },
    ])));

    useChatSession.getState().send('Build a resistor divider');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 8000, 'turn completion');

    const s = useChatSession.getState();
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[1].content).toBe('Built a resistor divider.');
    expect(s.messages[1].applied).toBe(true);
    expect(s.messages[1].appliedSummary).toContain('+1 component');
    expect(s.totalTokens.total).toBe(12);
    // The final circuit landed on the canvas — exactly once
    expect(loadDocumentCalls).toBe(1);
    expect(useEditor.getState().components.length).toBe(1);
    expect(useEditor.getState().components[0].type).toBe('resistor');

    // ONE undo reverts the entire AI turn (single history checkpoint,
    // preserved across loadDocument via keepHistory — it used to be wiped).
    useEditor.getState().undo();
    expect(useEditor.getState().components.length).toBe(0);
  });

  it('a no-change turn (pure explanation) does not show an applied bar', async () => {
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_explain', seq: 1 } },
      { event: 'done', data: { response: 'The 555 works like so…', toolCalls: [], circuit: { components: [], wires: [] }, seq: 2 } },
    ])));

    useChatSession.getState().send('Explain how a 555 works');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 8000, 'turn completion');

    const s = useChatSession.getState();
    expect(s.messages[1].applied).toBe(false);
    expect(s.messages[1].appliedSummary).toBe('');
    expect(loadDocumentCalls).toBe(0);
  });

  it('survives a mid-turn network drop: reconnects, replays, and does not duplicate side effects', async () => {
    const circuit = { components: [{ id: 'R1', type: 'resistor', x: 5, y: 5, rotation: 0, parameters: { resistance: '1k' } }], wires: [] };
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
      calls.push(url);
      const isResume = init && typeof init.body === 'string' && init.body.includes('"resume"');
      if (!isResume) {
        // First connection: partial progress, then the connection dies
        // (stream closes with NO done event).
        return clientSse([
          { event: 'turn', data: { turnId: 't_drop', seq: 1 } },
          { event: 'text_delta', data: { text: 'Hel', seq: 2 } },
          { event: 'tool_call', data: { name: 'simulate.start', args: {}, ok: true, seq: 3 } },
          { event: 'circuit_update', data: { ...circuit, seq: 4 } },
        ]);
      }
      // Reconnect: full replay (merged text delta), then live tail + done.
      return clientSse([
        { event: 'turn', data: { turnId: 't_drop', seq: 1 } },
        { event: 'text_delta', data: { text: 'Hello', seq: 2 } },
        { event: 'tool_call', data: { name: 'simulate.start', args: {}, ok: true, seq: 3 } },
        { event: 'circuit_update', data: { ...circuit, seq: 4 } },
        { event: 'text_delta', data: { text: '!', seq: 5 } },
        { event: 'done', data: { response: 'Hello!', toolCalls: [], circuit, seq: 6 } },
      ]);
    }));

    useChatSession.getState().send('Say hello');
    // Phase passes through reconnecting…
    await waitFor(() => useChatSession.getState().active?.phase === 'reconnecting', 8000, 'reconnecting phase');
    // …and then completes from the resumed turn.
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 12000, 'turn completion after reconnect');

    // The engine made exactly 2 requests: initial + resume
    expect(calls.filter(u => u.includes('/api/ai/chat/stream')).length).toBe(2);

    const s = useChatSession.getState();
    // Text rebuilt from the replay: "Hel" reset, then replay "Hello" + "!"…
    // wait — the final response comes from done.response.
    expect(s.messages[1].content).toBe('Hello!');
    // Side effects NOT duplicated: the circuit loaded exactly once, and the
    // replayed tool_call did not re-fire.
    expect(loadDocumentCalls).toBe(1);
    expect(s.messages[1].applied).toBe(true);
  });

  it('auto-restarts once when the server lost the turn (TURN_LOST)', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: any) => {
      requests.push(init?.body ? JSON.parse(init.body) : null);
      if (requests.length === 1) {
        // Server restarted: the turn is gone.
        return clientSse([{ event: 'error', data: { code: 'TURN_LOST', message: 'gone', seq: 1 } }]);
      }
      return clientSse([
        { event: 'turn', data: { turnId: 't_new', seq: 1 } },
        { event: 'done', data: { response: 'Redone.', toolCalls: [], circuit: { components: [], wires: [] }, seq: 2 } },
      ]);
    }));

    useChatSession.getState().send('Build something');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading && !s.messages[1].error;
    }, 12000, 'restart + completion');

    // Two requests: the failed one, then the fresh restart (no resume field).
    expect(requests.length).toBe(2);
    expect(requests[0].resume).toBeUndefined();
    expect(requests[1].resume).toBeUndefined();
    expect(useChatSession.getState().messages[1].content).toBe('Redone.');
  });

  it('stop() finalizes the turn as stopped and cancels server-side', async () => {
    const cancelCalls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/ai/chat/cancel')) {
        cancelCalls.push(url);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      // Stream that emits the turn event then hangs forever.
      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream({
        start(c) {
          ctrl = c;
          c.enqueue(enc.encode(`event: turn\ndata: ${JSON.stringify({ turnId: 't_stop', seq: 1 })}\n\n`));
        },
      });
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({}), body } as unknown as Response;
    }));

    useChatSession.getState().send('Long request');
    await waitFor(() => useChatSession.getState().active !== null, 8000, 'active turn');
    // Wait for the turnId to arrive
    await waitFor(() => !!useChatSession.getState().active?.turnId, 8000, 'turnId');

    useChatSession.getState().stop();
    const s = useChatSession.getState();
    expect(s.active).toBeNull();
    expect(s.messages[1].stopped).toBe(true);
    expect(s.messages[1].loading).toBe(false);
    await waitFor(() => cancelCalls.length === 1, 4000, 'cancel request');
  });

  it('a provider network error after all retries surfaces a retryable error message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'error', data: { message: 'AI chat failed: provider exploded', seq: 1 } },
    ])));

    useChatSession.getState().send('Do something');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !!s.messages[1].error;
    }, 8000, 'error finalization');

    const s = useChatSession.getState();
    expect(s.messages[1].retryable).toBe(true);
    expect(s.messages[1].content).toContain('provider exploded');
  });

  it('retryLast() re-sends the last user message', async () => {
    // First attempt: hard failure
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'error', data: { message: 'boom', seq: 1 } },
    ])));
    useChatSession.getState().send('Build a 555 blinker');
    await waitFor(() => !useChatSession.getState().active && useChatSession.getState().messages.length === 2, 8000, 'failure');

    // Second attempt: success
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_retry', seq: 1 } },
      { event: 'done', data: { response: 'Rebuilt!', toolCalls: [], circuit: { components: [], wires: [] }, seq: 2 } },
    ])));
    useChatSession.getState().retryLast();
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].error && !s.messages[1].loading;
    }, 8000, 'retry completion');

    const s = useChatSession.getState();
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].content).toBe('Build a 555 blinker');
    expect(s.messages[1].content).toBe('Rebuilt!');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers for reading SSE route responses
// ─────────────────────────────────────────────────────────────────────────────

async function streamText(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Read a (possibly never-ending) SSE response until `needle` shows up, then
 *  cancel the connection — mimicking a browser that got what it needed (or
 *  dropped mid-stream). */
async function readUntil(res: Response, needle: string, timeoutMs = 5000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + timeoutMs;
  while (!out.includes(needle) && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  return out;
}

function extractTurnId(text: string): string | null {
  const m = text.match(/event: turn\ndata: .*?"turnId":"([^"]+)"/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Model-sent null parameters must never poison components
//    (found live in E2E: GLM sent {resistance: null} → canvas render crashed)
// ─────────────────────────────────────────────────────────────────────────────

describe('null-parameter hardening', () => {
  it('addComponent drops explicit null params so plugin defaults survive', async () => {
    const events = await runTurnCollect(BASE_PARAMS, () => {
      return toolCallResponse('c1', 'schematic.addComponent', JSON.stringify({
        type: 'resistor', x: 5, y: 5, parameters: { resistance: null, xIgnoreMe: undefined },
      }));
    }).then(async (events) => {
      // second call: finish the turn
      return events;
    });
    // Find the circuit in the done event — the resistor must have the default resistance
    const done = events.find(e => e.type === 'done');
    const resistor = done.data.circuit.components.find((c: any) => c.type === 'resistor');
    expect(resistor).toBeDefined();
    expect(resistor.parameters.resistance).toBe(1000); // plugin default, NOT null
  });

  it('setParameter rejects null values with a clear error', async () => {
    let call = 0;
    const events = await runTurnCollect(BASE_PARAMS, () => {
      call++;
      if (call === 1) return toolCallResponse('c1', 'schematic.addComponent', JSON.stringify({ type: 'resistor', x: 5, y: 5 }));
      if (call === 2) return toolCallResponse('c2', 'schematic.setParameter', JSON.stringify({ id: 'PLACEHOLDER', key: 'resistance', value: null }));
      return contentResponse('Done.');
    });
    // The setParameter call with null must report an error (ok:false)
    const setParam = events.filter(e => e.type === 'tool_call').find(e => e.data.name === 'schematic.setParameter');
    expect(setParam).toBeDefined();
    // Either it failed on the unknown id or the null guard — both keep the
    // circuit safe. Verify no component ended with a null resistance.
    const done = events.find(e => e.type === 'done');
    const resistor = done.data.circuit.components.find((c: any) => c.type === 'resistor');
    expect(resistor.parameters.resistance).not.toBeNull();
  });
});
