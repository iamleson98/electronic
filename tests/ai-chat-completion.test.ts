// AI chat completion batch — regression tests for the four deferred UX
// items (documented in worklog Task 9-b "Deferred"):
//
//   1. getProvider threw a PLAIN Error when the OpenAI/Anthropic provider was
//      selected without a server key → the client showed a generic retryable
//      error card (useless Retry button) instead of the SetupCard guidance.
//      Now: AIProviderConfigError → AI_NOT_CONFIGURED → SetupCard.
//   2. The app's OWN rate-limiter 429 carried no `code` → streamOnce threw,
//      the engine reconnect-hammered the endpoint (each fresh retry
//      re-recording against the limiter window) and ended on a misleading
//      "Connection lost" error. Now: code 'RATE_LIMITED' → finalize ONCE
//      with a distinct local-limiter message + wait time.
//   3. retryLast() always re-sent the NEWEST user message regardless of which
//      failed message's Retry button was clicked. Now: retryLast(msgId)
//      targets THAT turn's user message.
//   4. sse.ts end-of-stream tail flush only salvaged a single `data:` line —
//      multi-line truncated tails were dropped whole or mis-joined. Now: the
//      tail is processed through the same per-line rules.
//
// Harness follows tests/ai-chat-hardening.test.ts: the REAL turn-manager,
// routes, chat-session engine, and circuit store run; only the
// network/provider layer is mocked.

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

const { TurnManager } = await import('../src/lib/ai/turn-manager');
const { getProvider, AIProviderConfigError } = await import('../src/lib/ai/provider');
const { POST: POST_STREAM } = await import('../src/app/api/ai/chat/stream/route');
const { POST: POST_CHAT } = await import('../src/app/api/ai/chat/route');
const { checkRateLimit } = await import('../src/lib/ai/rate-limit');
const { useChatSession } = await import('../src/lib/ai/chat-session');
const { useEditor } = await import('../src/lib/circuit/store');
const { parseSseStream } = await import('../src/lib/ai/sse');
await import('../src/lib/circuit/components'); // register plugins

const ORIGINAL_ENV = { ...process.env };
const enc = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeReq(url: string, body?: any, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
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

/** A JSON error Response (the shape both routes return for 429s). */
function jsonError(status: number, body: any, headers?: Record<string, string>): Response {
  return {
    ok: false, status, statusText: 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(headers ?? {}),
    body: null,
  } as unknown as Response;
}

/** Wait until fn() returns truthy (poll loop with timeout). */
async function waitFor(fn: () => boolean, timeoutMs = 8000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

function resetEditor() {
  useEditor.getState().loadDocument({ version: 1, components: [], wires: [] });
}

/** Stream a raw string through parseSseStream and collect events. */
async function parseSseText(text: string): Promise<Array<{ data: string; json: any; event?: string }>> {
  const stream = new ReadableStream({
    start(c) { c.enqueue(enc.encode(text)); c.close(); },
  });
  const events: Array<{ data: string; json: any; event?: string }> = [];
  for await (const ev of parseSseStream(stream.getReader())) events.push(ev);
  return events;
}

let mgr: TurnManager;

beforeEach(() => {
  vi.unstubAllGlobals();
  (globalThis as any).__aiGatewayCooldownUntil = 0;
  // Public Z.ai provider (fetch-mocked where needed); no OpenAI/Anthropic
  // keys so the missing-key paths are exercisable.
  process.env.ZAI_API_KEY = 'zai-key-test';
  process.env.ZAI_BASE_URL = 'https://api.example.test/v4';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_PROVIDER;
  delete process.env.ZAI_MODEL;
  delete process.env.ZAI_CONFIG;
  mgr = new TurnManager();
});

afterEach(() => {
  mgr.dispose();
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing provider key → AIProviderConfigError → SetupCard guidance
// ─────────────────────────────────────────────────────────────────────────────

describe('missing provider key classification', () => {
  it('getProvider throws AIProviderConfigError (not a plain Error) for an explicit openai request without a key', () => {
    let err: any;
    try {
      getProvider('openai');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIProviderConfigError);
    expect(err.message).toMatch(/OPENAI_API_KEY is not set/);
  });

  it('getProvider throws AIProviderConfigError for an explicit anthropic request without a key', () => {
    let err: any;
    try {
      getProvider('anthropic');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIProviderConfigError);
    expect(err.message).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it('a turn selecting a keyless provider finalizes with AI_NOT_CONFIGURED (drives the client SetupCard) and never touches the network', async () => {
    const fetchMock = vi.fn(() => { throw new Error('fetch must not be called'); });
    vi.stubGlobal('fetch', fetchMock);

    const events: any[] = [];
    const turnId = mgr.startTurn({ messages: [{ role: 'user', content: 'hi' }], provider: 'openai' });
    const attached = mgr.attach(turnId, { onEvent: e => events.push(e) })!;
    events.push(...attached.replay);

    await waitFor(() => mgr.getTurnStatus(turnId) === 'error', 5000, 'turn error');

    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    // THE regression: the code was undefined (plain Error) → the client
    // rendered a generic retryable card instead of the SetupCard.
    expect(err.data.code).toBe('AI_NOT_CONFIGURED');
    expect(err.data.message).toMatch(/OPENAI_API_KEY/);
    // Config errors must fail fast — zero provider attempts.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'status')).toBe(false);
  });

  it('the client classifies a plain "OPENAI_API_KEY is not set" message as config (regex hardening)', async () => {
    // Drive the client engine with a turn error whose message is the plain
    // missing-key text (no code) — the finalizeError regex must still route
    // it to the SetupCard ('config') instead of a Retry loop.
    useChatSession.setState({ messages: [], active: null, autoApply: true });
    resetEditor();
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_cfg', seq: 1 } },
      { event: 'error', data: { message: 'AI chat failed: OpenAI provider selected but OPENAI_API_KEY is not set. Add it to your .env file.', seq: 2 } },
    ])));

    useChatSession.getState().send('hello');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 8000, 'turn completion');

    const msg: any = useChatSession.getState().messages[1];
    expect(msg.error).toBe('true');
    expect(msg.errorKind).toBe('config');
    // Config errors are NOT retryable — retrying cannot set an API key.
    expect(msg.retryable).toBe(false);

    try { useChatSession.getState().stop(); } catch { /* not running */ }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The app's own rate-limiter 429 — code + single honest client finalize
// ─────────────────────────────────────────────────────────────────────────────

describe('app rate-limiter 429 contract', () => {
  it('POST /api/ai/chat/stream returns code RATE_LIMITED with the wait time', async () => {
    // Fill this IP's window directly (the route computes the same key from
    // x-forwarded-for) — avoids spawning 20 real turns.
    const key = '10.1.0.1';
    for (let i = 0; i < 20; i++) checkRateLimit(key);
    expect(checkRateLimit(key).ok).toBe(false);

    const res = await POST_STREAM(makeReq('http://localhost/api/ai/chat/stream',
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-forwarded-for': key }));
    expect(res.status).toBe(429);
    const body = await res.json();
    // THE regression: no code → the client reconnect-hammered the endpoint.
    expect(body.code).toBe('RATE_LIMITED');
    expect(typeof body.retryAfterSec).toBe('number');
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('POST /api/ai/chat (non-stream) returns code RATE_LIMITED too', async () => {
    const key = '10.1.0.2';
    for (let i = 0; i < 20; i++) checkRateLimit(key);

    const res = await POST_CHAT(makeReq('http://localhost/api/ai/chat',
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-forwarded-for': key }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(typeof body.retryAfterSec).toBe('number');
  });

  it('the client finalizes ONCE on RATE_LIMITED (no reconnect hammer) with the distinct local-limiter message', async () => {
    useChatSession.setState({ messages: [], active: null, autoApply: true });
    resetEditor();
    const fetchMock = vi.fn(() => jsonError(429, {
      error: 'Too many AI requests. Please wait a moment and try again.',
      code: 'RATE_LIMITED',
      retryAfterSec: 7,
    }, { 'Retry-After': '7' }));
    vi.stubGlobal('fetch', fetchMock);

    useChatSession.getState().send('hello');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading && !!s.messages[1].error;
    }, 8000, 'rate-limit finalize');

    // THE regression: streamOnce threw on the codeless 429 → the engine
    // retried with backoff, each fresh request re-recording against the
    // limiter window. Now: exactly ONE request, final.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const msg: any = useChatSession.getState().messages[1];
    expect(msg.errorKind).toBe('rate-limit');
    expect(msg.retryable).toBe(true);
    // The local-limiter message (NOT the provider-quota text) with the wait.
    expect(msg.content).toMatch(/20 AI requests per minute/);
    expect(msg.content).toMatch(/~7s/);
    expect(msg.content).not.toMatch(/service quota is temporarily exhausted/);

    try { useChatSession.getState().stop(); } catch { /* not running */ }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. retryLast targets the failed turn's own user message
// ─────────────────────────────────────────────────────────────────────────────

describe('retryLast targeting', () => {
  beforeEach(() => {
    useChatSession.setState({
      messages: [], active: null, autoApply: true,
      totalTokens: { prompt: 0, completion: 0, total: 0 },
    });
    resetEditor();
  });

  afterEach(() => {
    try { useChatSession.getState().stop(); } catch { /* not running */ }
  });

  function seededMessages() {
    return [
      { id: 'u1', role: 'user' as const, content: 'first question', timestamp: 1 },
      { id: 'a1', role: 'assistant' as const, content: '', timestamp: 2, error: 'true', retryable: true, toolCalls: [] },
      { id: 'u2', role: 'user' as const, content: 'second question', timestamp: 3 },
      { id: 'a2', role: 'assistant' as const, content: '', timestamp: 4, error: 'true', retryable: true, toolCalls: [] },
    ];
  }

  it('retryLast(failedMsgId) re-sends THAT turn\u2019s user message (the newest one is kept for later)', async () => {
    useChatSession.setState({ messages: seededMessages() });
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_retry1', seq: 1 } },
      { event: 'done', data: { response: 'Retried OK.', toolCalls: [], circuit: { components: [], wires: [] }, seq: 2 } },
    ])));

    // Retry the FIRST failed assistant message.
    useChatSession.getState().retryLast('a1');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 2 && !s.messages[1].loading;
    }, 8000, 'retry turn completion');

    const s = useChatSession.getState();
    // THE regression: the old code re-sent 'second question' here.
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].content).toBe('first question');
    expect(s.messages[1].content).toBe('Retried OK.');
    // The sent request body carries the retried user text.
    const call = (fetch as any).mock?.calls?.[0];
    expect(call).toBeTruthy();
    expect(String(call?.[1]?.body ?? '')).toContain('first question');
  });

  it('retryLast() with no argument keeps the legacy newest-message behavior', async () => {
    useChatSession.setState({ messages: seededMessages() });
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_retry2', seq: 1 } },
      { event: 'done', data: { response: 'Newest retried.', toolCalls: [], circuit: { components: [], wires: [] }, seq: 2 } },
    ])));

    useChatSession.getState().retryLast();
    // slice(0, u2Idx=2) keeps [u1, a1]; send() appends the re-sent user
    // message + a fresh assistant message → 4 total.
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 4 && !s.messages[3].loading;
    }, 8000, 'retry turn completion');

    const s = useChatSession.getState();
    expect(s.messages[2].role).toBe('user');
    expect(s.messages[2].content).toBe('second question');
    expect(s.messages[3].content).toBe('Newest retried.');
  });

  it('retryLast with an unknown message id falls back to the newest user message', async () => {
    useChatSession.setState({ messages: seededMessages() });
    vi.stubGlobal('fetch', vi.fn(() => clientSse([
      { event: 'turn', data: { turnId: 't_retry3', seq: 1 } },
      { event: 'done', data: { response: 'Fallback retried.', toolCalls: [], circuit: { components: [], wires: [] }, seq: 2 } },
    ])));

    useChatSession.getState().retryLast('id_that_does_not_exist');
    await waitFor(() => {
      const s = useChatSession.getState();
      return !s.active && s.messages.length === 4 && !s.messages[3].loading;
    }, 8000, 'retry turn completion');

    const s = useChatSession.getState();
    expect(s.messages[2].role).toBe('user');
    expect(s.messages[2].content).toBe('second question');
    expect(s.messages[3].content).toBe('Fallback retried.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. sse.ts — end-of-stream tail flush handles multi-line truncated tails
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSseStream tail flush', () => {
  it('recovers an unterminated "event: + data:" pair (previously dropped whole)', async () => {
    // A stream that dies right after the data line — no blank line follows.
    const events = await parseSseText('event: message\ndata: {"a":1}');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message');
    expect(events[0].json).toEqual({ a: 1 });
  });

  it('joins unterminated multi-line data fields correctly (previously mis-joined)', async () => {
    // Two data lines, stream ended before the dispatch blank line. Per the
    // SSE spec they join with \n — the old code pushed the whole remaining
    // buffer as ONE line, embedding a literal "data:" inside the payload.
    const events = await parseSseText('data: hello\ndata: world');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('hello\nworld');
    expect(events[0].data).not.toContain('data:');
  });

  it('a truncated JSON tail yields the raw payload with json undefined (not garbage)', async () => {
    const events = await parseSseText('data: {"choices":[{"delta":{"conte');
    expect(events).toHaveLength(1);
    expect(events[0].json).toBeUndefined();
    expect(events[0].data).toBe('{"choices":[{"delta":{"conte');
  });

  it('completed events before a truncated tail are unaffected', async () => {
    const events = await parseSseText('data: {"x":1}\n\nevent: message\ndata: {"y":2}');
    expect(events).toHaveLength(2);
    expect(events[0].json).toEqual({ x: 1 });
    expect(events[1].event).toBe('message');
    expect(events[1].json).toEqual({ y: 2 });
  });
});
