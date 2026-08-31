// AI chat stack hardening — regression tests for the five confirmed bugs
// from the Task 6-a bug hunt:
//
//   Bug 1 (HIGH)   applyCircuitUpdate wiped user document state (drawings,
//                  sheets, no-connects, net classes, page setup, metadata)
//                  and stopped a running sim on EVERY AI turn.
//   Bug 2 (HIGH)   handler/side-effect exceptions inside streamOnce were
//                  misclassified as network failures → up to 10 fake
//                  reconnects re-crashing on the replayed event, ending in
//                  a misleading retryable "Connection lost" error.
//   Bug 3 (HIGH)   finalizeError/finalizeDone set rt.finalized BEFORE doing
//                  their work — a mid-finalize exception escaped, active
//                  stayed set, message.loading stayed true forever, send()
//                  permanently blocked.
//   Bug 4 (H/M)    stop() before the first `turn` SSE event never cancelled
//                  the server-side turn (zombie burning quota for up to 290s).
//   Bug 5 (MEDIUM) ZaiSandboxProvider.chatStream never wired the abort
//                  signal into the stream read — Stop / turn hard-cap could
//                  not interrupt an in-flight sandbox model stream.
//
// Harness follows tests/ai-turn-resume.test.ts: the REAL circuit store and
// chat-session engine run; only the network/provider layer is mocked.

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

// The z-ai-web-dev-sdk is mocked module-wide so the sandbox provider test
// (Bug 5) never touches the real internal gateway. Other tests use the
// ZAI_API_KEY public provider with a stubbed global fetch, so this mock is
// inert for them.
const sandboxMock = vi.hoisted(() => ({
  createImpl: null as null | ((body: any) => any),
  createCalls: 0,
}));
vi.mock('z-ai-web-dev-sdk', () => ({
  default: {
    create: async () => ({
      chat: {
        completions: {
          create: (body: any) => {
            sandboxMock.createCalls++;
            return sandboxMock.createImpl!(body);
          },
        },
      },
    }),
  },
}));

const { TurnManager, getTurnManager } = await import('../src/lib/ai/turn-manager');
const { getProvider } = await import('../src/lib/ai/provider');
const { POST: POST_STREAM } = await import('../src/app/api/ai/chat/stream/route');
const { POST: POST_CANCEL } = await import('../src/app/api/ai/chat/cancel/route');
const { useChatSession } = await import('../src/lib/ai/chat-session');
const { useEditor } = await import('../src/lib/circuit/store');
await import('../src/lib/circuit/components'); // register plugins

const ORIGINAL_ENV = { ...process.env };
const enc = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/** A Response whose stream never emits anything and errors when the request's
 *  abort signal fires (mimics a real aborted fetch — see hangingResponse in
 *  ai-turn-resume.test.ts). */
function silentHangingResponse(signal?: AbortSignal): Response {
  let streamCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream({ start(c) { streamCtrl = c; } });
  if (signal) {
    const onAbort = () => streamCtrl?.error(new Error('The operation was aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({}), body: stream } as unknown as Response;
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

function resetEditor() {
  useEditor.getState().loadDocument({ version: 1, components: [], wires: [] });
}

/** The user-authored document furniture the AI's events never carry. */
function seedUserDocState() {
  useEditor.getState().loadDocument({
    version: 1,
    components: [{ id: 'R1', type: 'resistor', x: 10, y: 10, rotation: 0, parameters: { resistance: '1k' } }],
    wires: [],
    drawings: [{ type: 'line' as const, id: 'd1', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] as [{ x: number; y: number }, { x: number; y: number }], strokeWidth: 2, color: '#f00' }],
    noConnects: [{ id: 'nc1', componentId: 'R1', terminalId: 'a' }],
    sheets: [{ id: 'sh1', sheetName: 'Amp', fileName: 'amp.kicad_sch', position: { x: 40, y: 2 }, size: { width: 20, height: 10 }, pins: [] }],
    netClasses: [{ id: 'class1', name: 'Power', nets: ['VCC'] }],
    pageSetup: { size: 'A3' as const, width: 420, height: 297, orientation: 'landscape' as const, showBorder: true, showTitleBlock: true },
    metadata: { title: 'My Precious Design', revision: 'Rev B', author: 'me' },
  });
  // A running sim with a live context (values don't matter — the invariant
  // is that an AI update no longer hard-stops it).
  useEditor.setState({
    running: true,
    paused: false,
    simContext: { nodeVoltage: new Float64Array([0, 5]), branchCurrent: new Float64Array([1]), numNodes: 2, state: {}, time: 0.01, dt: 1e-4 },
  });
}

const AI_DOC_TWO_COMPONENTS = {
  components: [
    { id: 'R1', type: 'resistor', x: 10, y: 10, rotation: 0, parameters: { resistance: '2k' } },
    { id: 'R2', type: 'resistor', x: 20, y: 10, rotation: 0, parameters: { resistance: '1k' } },
  ],
  wires: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let originalLoadDocument: any;
let consoleErrorSpy: any;

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.ZAI_API_KEY = 'zai-key-test';
  process.env.ZAI_BASE_URL = 'https://api.example.test/v4';
  delete process.env.ZAI_MODEL;
  delete process.env.ZAI_CONFIG;
  delete process.env.Z_AI_API_KEY;
  (globalThis as any).__aiGatewayCooldownUntil = 0;
  useChatSession.setState({
    messages: [], active: null, autoApply: true,
    totalTokens: { prompt: 0, completion: 0, total: 0 },
  });
  resetEditor();
  originalLoadDocument = useEditor.getState().loadDocument;
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  useEditor.setState({ loadDocument: originalLoadDocument });
  // Kill any zombie engine from a failed test so later sends aren't blocked.
  try { useChatSession.getState().stop(); } catch { /* nothing running */ }
  consoleErrorSpy.mockRestore();
  getTurnManager().dispose();
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 1 — AI circuit updates must preserve user document state
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug 1 — AI circuit updates preserve user document state', () => {
  it('loadDocument(preserveUserState) keeps drawings/sheets/noConnects/netClasses/pageSetup/metadata and the running sim while replacing components/wires', () => {
    seedUserDocState();
    useEditor.getState().loadDocument(
      { version: 1, components: AI_DOC_TWO_COMPONENTS.components, wires: AI_DOC_TWO_COMPONENTS.wires },
      { keepHistory: true, preserveUserState: true },
    );
    const s = useEditor.getState();
    // The AI's components/wires DID land…
    expect(s.components.map(c => c.id)).toEqual(['R1', 'R2']);
    expect(s.components[0].parameters.resistance).toBe('2k');
    // …and every user-authored field survived.
    expect(s.drawings.length).toBe(1);
    expect(s.drawings[0].id).toBe('d1');
    expect(s.noConnects.length).toBe(1);
    expect(s.noConnects[0].id).toBe('nc1');
    expect(s.sheets.length).toBe(1);
    expect(s.sheets[0].fileName).toBe('amp.kicad_sch');
    expect(s.netClasses.length).toBe(1);
    expect(s.netClasses[0].name).toBe('Power');
    expect(s.pageSetup.size).toBe('A3');
    expect(s.metadata.title).toBe('My Precious Design');
    expect(s.metadata.revision).toBe('Rev B');
    // The sim kept running with its context intact.
    expect(s.running).toBe(true);
    expect(s.simContext).not.toBeNull();
    expect(s.simContext!.nodeVoltage[1]).toBe(5);
  });

  it('loadDocument without preserveUserState still resets to defaults (full loads keep their meaning)', () => {
    seedUserDocState();
    useEditor.getState().loadDocument({ version: 1, components: [], wires: [] });
    const s = useEditor.getState();
    expect(s.drawings).toEqual([]);
    expect(s.noConnects).toEqual([]);
    expect(s.sheets).toEqual([]);
    expect(s.netClasses).toEqual([]);
    expect(s.pageSetup.size).toBe('A4');
    expect(s.metadata.title).toBe('Untitled');
    expect(s.running).toBe(false);
    expect(s.simContext).toBeNull();
  });

  it('a full AI turn that changes components/wires preserves all user state and the running sim (chat-session engine path)', async () => {
    seedUserDocState();
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_preserve', seq: 1 } },
      { event: 'text_delta', data: { text: 'Adjusting R1…', seq: 2 } },
      { event: 'circuit_update', data: { ...AI_DOC_TWO_COMPONENTS, seq: 3 } },
      { event: 'done', data: { response: 'Adjusted R1 and added R2.', toolCalls: [], circuit: AI_DOC_TWO_COMPONENTS, seq: 4 } },
    ])));

    useChatSession.getState().send('Set R1 to 2k and add another resistor');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 8000, 'turn completion');

    const s = useChatSession.getState();
    expect(s.messages[1].applied).toBe(true);
    const e = useEditor.getState();
    // AI change applied…
    expect(e.components.length).toBe(2);
    expect(e.components.find(c => c.id === 'R1')?.parameters.resistance).toBe('2k');
    // …user state + sim preserved (THE regression — all wiped before).
    expect(e.drawings.length).toBe(1);
    expect(e.drawings[0].id).toBe('d1');
    expect(e.noConnects.map(n => n.id)).toEqual(['nc1']);
    expect(e.sheets.map(sh => sh.fileName)).toEqual(['amp.kicad_sch']);
    expect(e.netClasses.map(n => n.name)).toEqual(['Power']);
    expect(e.pageSetup.size).toBe('A3');
    expect(e.metadata.title).toBe('My Precious Design');
    expect(e.running).toBe(true);
    expect(e.simContext).not.toBeNull();
    expect(e.simContext!.nodeVoltage[1]).toBe(5);

    // One Ctrl+Z still reverts the whole AI turn (keepHistory semantics
    // unchanged by preserveUserState)…
    useEditor.getState().undo();
    const u = useEditor.getState();
    expect(u.components.length).toBe(1);
    expect(u.components[0].parameters.resistance).toBe('1k');
    // …and the undo snapshot restores the SAME user furniture.
    expect(u.drawings.length).toBe(1);
    expect(u.metadata.title).toBe('My Precious Design');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2 — handler exceptions are internal errors, not network failures
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug 2 — handler exceptions surface as non-retryable turn errors (no fake reconnect loop)', () => {
  it('an applyCircuitUpdate exception: exactly 1 stream request, non-retryable AI error, real exception logged', async () => {
    const streamCalls: string[] = [];
    // Poison the side effect: loadDocument throws like it can on an
    // inconsistent store state (proven reachable in the bug hunt).
    useEditor.setState({
      loadDocument: () => { throw new Error('poisoned store state'); },
    });
    // The stream would keep going — the engine must stop reading after the
    // handler error (the reader is cancelled), not hammer reconnects.
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      streamCalls.push(url);
      return clientSse([
        { event: 'turn', data: { turnId: 't_poison', seq: 1 } },
        { event: 'circuit_update', data: { ...AI_DOC_TWO_COMPONENTS, seq: 2 } },
        { event: 'text_delta', data: { text: 'more events follow', seq: 3 } },
      ]);
    }));

    useChatSession.getState().send('Break the apply path');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !!s.messages[1].error;
    }, 8000, 'error finalization');

    // Give any would-be reconnect a chance to fire — the old code started
    // one after a 1s backoff (then 9 more, then a fake "Connection lost").
    await new Promise(r => setTimeout(r, 400));
    expect(streamCalls.filter(u => u.includes('/api/ai/chat/stream')).length).toBe(1);

    const s = useChatSession.getState();
    const msg = s.messages[1];
    expect(msg.loading).toBe(false);
    expect(msg.content).toContain('poisoned store state');
    expect(msg.content).not.toContain('Connection lost');
    expect(msg.retryable).toBe(false);

    // The real exception was logged (visible in dev.log), not swallowed.
    const logged = consoleErrorSpy.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).toContain('poisoned store state');
  });

  it('a transport failure (stream dies mid-turn, no handler error) still reconnects — the new classification did not break real network retries', async () => {
    const circuit = { components: [{ id: 'R1', type: 'resistor', x: 5, y: 5, rotation: 0, parameters: { resistance: '1k' } }], wires: [] };
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
      calls.push(url);
      const isResume = init && typeof init.body === 'string' && init.body.includes('"resume"');
      if (!isResume) {
        // Connection 1: dies right after the turn event (transport drop).
        return clientSse([{ event: 'turn', data: { turnId: 't_drop2', seq: 1 } }]);
      }
      return clientSse([
        { event: 'turn', data: { turnId: 't_drop2', seq: 1 } },
        { event: 'done', data: { response: 'Recovered.', toolCalls: [], circuit, seq: 2 } },
      ]);
    }));

    useChatSession.getState().send('Say hi');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 12000, 'reconnect + completion');

    expect(calls.filter(u => u.includes('/api/ai/chat/stream')).length).toBe(2);
    expect(useChatSession.getState().messages[1].content).toBe('Recovered.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3 — a finalize-time exception must never wedge the session
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug 3 — finalize failures tear the turn down (send() never permanently blocked)', () => {
  it('a throw inside finalizeDone\'s final apply finalizes the message with an error and unblocks send()', async () => {
    // 1st load = circuit_update applies fine; 2nd load = finalizeDone's
    // final apply (done doc differs from the intermediate) throws.
    let loadCalls = 0;
    const realLoad = originalLoadDocument;
    useEditor.setState({
      loadDocument: (...args: any[]) => {
        loadCalls++;
        if (loadCalls >= 2) throw new Error('final apply exploded');
        return realLoad(...args);
      },
    });
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_final', seq: 1 } },
      { event: 'circuit_update', data: { ...AI_DOC_TWO_COMPONENTS, seq: 2 } },
      { event: 'done', data: { response: 'All done.', toolCalls: [], circuit: { ...AI_DOC_TWO_COMPONENTS, components: [...AI_DOC_TWO_COMPONENTS.components, { id: 'R3', type: 'resistor', x: 30, y: 10, rotation: 0, parameters: { resistance: '4k7' } }] }, seq: 3 } },
    ])));

    useChatSession.getState().send('Build something');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !!s.messages[1].error;
    }, 8000, 'error finalization after finalizeDone throw');

    // The turn was torn down completely (the old bug: active stuck set,
    // loading stuck true, send() permanently ignored).
    const s = useChatSession.getState();
    expect(s.active).toBeNull();
    expect(s.messages[1].loading).toBe(false);
    expect(s.messages[1].error).toBe('true');
    expect(s.messages[1].retryable).toBe(false);
    expect(s.messages[1].content).toMatch(/internal error/i);
    // The finalize exception itself was logged.
    const logged = consoleErrorSpy.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).toContain('finalizeDone failed');
    expect(logged).toContain('final apply exploded');

    // send() can start a new turn immediately.
    useEditor.setState({ loadDocument: realLoad });
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_after', seq: 1 } },
      { event: 'done', data: { response: 'Works again.', toolCalls: [], circuit: { components: [], wires: [] }, seq: 2 } },
    ])));
    useChatSession.getState().send('Try once more');
    await waitFor(() => {
      const s2 = useChatSession.getState();
      return !s2.active && s2.messages.length === 4 && !s2.messages[3].loading;
    }, 8000, 'second turn completion');
    expect(useChatSession.getState().messages[3].content).toBe('Works again.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 4 — Stop before the first `turn` event must cancel the server-side turn
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug 4 — stop() before the first turn event cancels the server-side turn', () => {
  it('POST /api/ai/chat/cancel accepts clientId-only bodies and cancels that client\'s running turn', async () => {
    // Provider hangs so the turn stays running server-side.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: any) => silentHangingResponse(init?.signal)));
    const req = makeReq('http://localhost/api/ai/chat/stream', {
      messages: [{ role: 'user', content: 'build' }],
      clientId: 'client_bug4',
    }, { 'x-forwarded-for': '9.9.9.42' });
    const res = await POST_STREAM(req);
    // The turn exists server-side (read the turn event like the browser would).
    const text = await readUntil(res, 'event: turn');
    const turnId = extractTurnId(text);
    expect(turnId).toBeTruthy();
    expect(getTurnManager().getTurnStatus(turnId!)).toBe('running');

    // Stop WITHOUT a turnId — the client doesn't know it yet (the event is
    // still in flight to the browser). Before the fix: 400 / no cancel.
    const cancelRes = await POST_CANCEL(makeReq('http://localhost/api/ai/chat/cancel', { clientId: 'client_bug4' }));
    expect(cancelRes.status).toBe(200);
    const body = await cancelRes.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(true);
    await waitFor(() => getTurnManager().getTurnStatus(turnId!) === 'cancelled');
  });

  it('clientId cancel leaves other clients\' turns alone', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: any) => silentHangingResponse(init?.signal)));
    const reqA = makeReq('http://localhost/api/ai/chat/stream', { messages: [{ role: 'user', content: 'a' }], clientId: 'client_bug4a' }, { 'x-forwarded-for': '9.9.9.43' });
    const reqB = makeReq('http://localhost/api/ai/chat/stream', { messages: [{ role: 'user', content: 'b' }], clientId: 'client_bug4b' }, { 'x-forwarded-for': '9.9.9.44' });
    const resA = await POST_STREAM(reqA);
    const resB = await POST_STREAM(reqB);
    const textA = await readUntil(resA, 'event: turn');
    const textB = await readUntil(resB, 'event: turn');
    const idA = extractTurnId(textA)!;
    const idB = extractTurnId(textB)!;
    expect(getTurnManager().getTurnStatus(idA)).toBe('running');
    expect(getTurnManager().getTurnStatus(idB)).toBe('running');

    const cancelRes = await POST_CANCEL(makeReq('http://localhost/api/ai/chat/cancel', { clientId: 'client_bug4a' }));
    const body = await cancelRes.json();
    expect(body.cancelled).toBe(true);
    await waitFor(() => getTurnManager().getTurnStatus(idA) === 'cancelled');
    expect(getTurnManager().getTurnStatus(idB)).toBe('running');
    getTurnManager().cancelTurn(idB);
  });

  it('the cancel route still requires a turnId or clientId', async () => {
    const res = await POST_CANCEL(makeReq('http://localhost/api/ai/chat/cancel', {}));
    expect(res.status).toBe(400);
  });

  it('client stop() in the pre-turn-event window fires a clientId-keyed cancel request', async () => {
    const cancelBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
      if (url.includes('/api/ai/chat/cancel')) {
        cancelBodies.push(init?.body ? JSON.parse(init.body) : null);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      // The stream is in flight but the first `turn` event has NOT arrived
      // yet — a connection that stays silent for a while.
      return silentHangingResponse(init?.signal);
    }));

    useChatSession.getState().send('Long request');
    await waitFor(() => useChatSession.getState().active !== null, 8000, 'active turn');
    // Still in the connecting phase — no turnId.
    expect(useChatSession.getState().active?.turnId).toBeNull();

    useChatSession.getState().stop();

    // THE regression: before the fix NO cancel request was fired at all —
    // the server-side turn kept running (zombie) until the 290s hard cap.
    await waitFor(() => cancelBodies.length === 1, 4000, 'cancel request');
    expect(cancelBodies[0].turnId).toBeUndefined();
    expect(typeof cancelBodies[0].clientId).toBe('string');
    expect(cancelBodies[0].clientId.length).toBeGreaterThan(0);

    const s = useChatSession.getState();
    expect(s.active).toBeNull();
    expect(s.messages[1].stopped).toBe(true);
    expect(s.messages[1].loading).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 5 — sandbox provider stream must be abortable
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug 5 — ZaiSandboxProvider.chatStream is abort-aware', () => {
  it('aborting mid-stream rejects promptly with the abort error (not after the stream ends)', async () => {
    // No API key → the sandbox provider (the default inside the sandbox).
    delete process.env.ZAI_API_KEY;
    delete process.env.Z_AI_API_KEY;

    // A never-ending model stream that yields a chunk every 10ms — it NEVER
    // ends, so the only way this test can pass is a prompt abort rejection.
    let streamCancelled = false;
    sandboxMock.createImpl = () => new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`));
          } catch {
            clearInterval(timer); // reader.cancel() closed the stream
            streamCancelled = true;
          }
        }, 10);
      },
    });
    const createCallsBefore = sandboxMock.createCalls;

    const provider = getProvider('zai');
    expect(provider.name).toBe('zai');

    const ctrl = new AbortController();
    const deltas: string[] = [];
    const promise = provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      { signal: ctrl.signal },
      (t) => deltas.push(t),
    );

    setTimeout(() => ctrl.abort(new DOMException('Stopped by user', 'AbortError')), 50);
    const started = Date.now();
    await expect(promise).rejects.toThrow(/aborted/i);
    const elapsed = Date.now() - started;

    // Rejected promptly (~100ms, not minutes/never)…
    expect(elapsed).toBeLessThan(400);
    // …deltas streamed until the abort (the read really was live)…
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    // …and exactly ONE provider attempt (the abort error is not retried).
    expect(sandboxMock.createCalls - createCallsBefore).toBe(1);
  });

  it('an already-aborted signal rejects without touching the SDK', async () => {
    delete process.env.ZAI_API_KEY;
    delete process.env.Z_AI_API_KEY;
    sandboxMock.createImpl = () => {
      throw new Error('SDK must not be called');
    };
    const provider = getProvider('zai');
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('Stopped by user', 'AbortError'));
    await expect(provider.chatStream([{ role: 'user', content: 'hi' }], undefined, { signal: ctrl.signal }))
      .rejects.toThrow(/aborted/i);
  });
});
