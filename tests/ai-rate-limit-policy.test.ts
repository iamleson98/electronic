// Tests for the rate-limit-aware provider retry policy + honest turn
// finalization (the "endless spinning" fix):
//
//   1. Persistent 429s → EXACTLY 3 provider attempts (was 8), patient
//      30s/60s-style backoff, terminal `error` event with code
//      AI_RATE_LIMITED and an actionable message — never a 5-minute
//      silent spinner that ends in a misleading "I ran out of time" done.
//   2. Transient 429s that recover → the patient retries land the turn as
//      `done` with the correct response.
//   3. Mid-stream network failure after partial text → provider retry emits
//      `text_reset` so the retried stream cannot duplicate the narration.
//   4. The shared gateway cooldown (globalThis) stops a second concurrent
//      request from hammering the throttled gateway while the first one is
//      already in its backoff loop.
//
// The provider is a mocked ZaiPublicProvider (ZAI_API_KEY + stubbed fetch).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

const { TurnManager, getTurnManager } = await import('../src/lib/ai/turn-manager');
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

function rateLimitResponse(): Response {
  return {
    ok: false, status: 429,
    json: async () => ({ error: 'Too many requests, please try again later' }),
    text: async () => JSON.stringify({ error: 'Too many requests, please try again later' }),
    body: null,
  } as unknown as Response;
}

/** Streams `parts` then errors mid-stream (network reset style). The
 *  error must be DELAYED: controller.error() discards chunks still in the
 *  stream queue, so a synchronous enqueue+error never delivers the text. */
function explodingStreamResponse(parts: string[], errorMessage: string): Response {
  const chunks = parts.map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  const text = chunks.join('');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      setTimeout(() => controller.error(new Error(errorMessage)), 20);
    },
  });
  return { ok: true, status: 200, json: async () => ({}), text: async () => '', body: stream } as unknown as Response;
}

const BASE_PARAMS = { messages: [{ role: 'user', content: 'hi' }] };

/** Drive a turn under FAKE timers until it finalizes (or time runs out). */
async function runTurnFakeTimers(mgr: TurnManager, params: any, fetchHandler: FetchHandler, maxAdvanceMs = 180_000): Promise<{ events: any[]; fetchCount: number }> {
  const fetchMock = vi.fn((url: string, init?: any) => fetchHandler(url, init));
  vi.stubGlobal('fetch', fetchMock);
  const events: any[] = [];
  const turnId = mgr.startTurn(params);
  const attached = mgr.attach(turnId, { onEvent: e => events.push(e) })!;
  events.push(...attached.replay);
  expect(attached.running).toBe(true);
  let advanced = 0;
  while (mgr.getTurnStatus(turnId) === 'running' && advanced < maxAdvanceMs) {
    await vi.advanceTimersByTimeAsync(5_000);
    advanced += 5_000;
  }
  return { events, fetchCount: fetchMock.mock.calls.length };
}

let mgr: TurnManager;

beforeEach(() => {
  vi.unstubAllGlobals();
  // Reset the shared gateway cooldown — it lives on globalThis and would
  // otherwise leak between tests (that sharing is intentional in production).
  (globalThis as any).__aiGatewayCooldownUntil = 0;
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
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Persistent 429 — bounded attempts, honest terminal error
// ─────────────────────────────────────────────────────────────────────────────

describe('rate-limit retry policy', () => {
  it('gives up after exactly 3 attempts on persistent 429s and finalizes with an actionable AI_RATE_LIMITED error', async () => {
    vi.useFakeTimers();
    const { events, fetchCount } = await runTurnFakeTimers(mgr, BASE_PARAMS, () => rateLimitResponse());

    // THE regression: the old policy fired 8 provider attempts (+ up to 4
    // loop-level restarts = ~32 requests) over ~5 minutes. Now: 3, period.
    expect(fetchCount).toBe(3);

    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    expect(err.data.code).toBe('AI_RATE_LIMITED');
    expect(err.data.message).toMatch(/rate-limited \(429\)/);
    expect(err.data.message).toMatch(/press Retry/i);

    // The user must SEE the waiting (status events), not a silent spinner.
    const retryStatuses = events.filter(e => e.type === 'status' && e.data.phase === 'provider-retry');
    expect(retryStatuses.length).toBeGreaterThanOrEqual(1);
    expect(retryStatuses[0].data.reason).toMatch(/rate limited \(429\)/i);

    // A rate-limited turn never pretends to succeed.
    expect(events.some(e => e.type === 'done')).toBe(false);
  }, 20000);

  it('recovers with done when the 429s are transient (quota window resets)', async () => {
    vi.useFakeTimers();
    let call = 0;
    const { events, fetchCount } = await runTurnFakeTimers(mgr, BASE_PARAMS, () => {
      call++;
      if (call <= 2) return rateLimitResponse();
      return contentResponse('All better now.', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    });

    expect(fetchCount).toBe(3);
    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.data.response).toBe('All better now.');
    expect(events.some(e => e.type === 'error')).toBe(false);
  }, 20000);

  it('waits at least the shared cooldown before re-attempting after a 429', async () => {
    vi.useFakeTimers();
    const attemptTimes: number[] = [];
    const started = Date.now();
    const { fetchCount } = await runTurnFakeTimers(mgr, BASE_PARAMS, () => {
      attemptTimes.push(Date.now() - started);
      return rateLimitResponse();
    });
    expect(fetchCount).toBe(3);
    // First attempt fires immediately (cheap probe), but the second attempt
    // must wait the extended cooldown (45s) and the third even longer —
    // no 2s/4s/8s rapid-fire hammering.
    expect(attemptTimes.length).toBe(3);
    expect(attemptTimes[1]).toBeGreaterThanOrEqual(40_000);
    expect(attemptTimes[2]).toBeGreaterThanOrEqual(attemptTimes[1] + 55_000);
  }, 20000);

  it('a concurrent request respects the shared cooldown (no gateway stampede)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => rateLimitResponse());
    vi.stubGlobal('fetch', fetchMock);

    const eventsA: any[] = [];
    const eventsB: any[] = [];
    const idA = mgr.startTurn(BASE_PARAMS);
    const idB = mgr.startTurn(BASE_PARAMS);
    mgr.attach(idA, { onEvent: e => eventsA.push(e) });
    mgr.attach(idB, { onEvent: e => eventsB.push(e) });

    let advanced = 0;
    // Two interleaved turns share the global cooldown, so their patient
    // waits chain: worst case ~3 cooldown periods each (≈45s + 60s + 60s
    // plus stagger) — 240s of fake time is a generous ceiling.
    while ((mgr.getTurnStatus(idA) === 'running' || mgr.getTurnStatus(idB) === 'running') && advanced < 240_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      advanced += 5_000;
    }

    // Both turns terminal, both honest errors…
    expect(mgr.getTurnStatus(idA)).toBe('error');
    expect(mgr.getTurnStatus(idB)).toBe('error');
    // …and the pair made at most 6 total attempts (3 each) — never the old
    // 8+8 interleaved storm. The cooldown's stagger keeps them from firing
    // in lockstep.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Mid-stream retry resets stale narration (no duplicated text)
// ─────────────────────────────────────────────────────────────────────────────

describe('text_reset on mid-stream retries', () => {
  it('emits text_reset when a retried model call already streamed partial text, so the narration cannot duplicate', async () => {
    let call = 0;
    const fetchHandler: FetchHandler = () => {
      call++;
      if (call === 1) {
        // Streams half the answer, then the connection dies (transient
        // network error — retryable, NOT a rate limit).
        return explodingStreamResponse(['I will build a voltage div'], 'socket hang up');
      }
      return contentResponse('I will build a voltage divider for you.');
    };

    const fetchMock = vi.fn((url: string, init?: any) => fetchHandler(url, init));
    vi.stubGlobal('fetch', fetchMock);
    const events: any[] = [];
    const turnId = mgr.startTurn(BASE_PARAMS);
    mgr.attach(turnId, { onEvent: e => events.push(e) });

    const started = Date.now();
    while (mgr.getTurnStatus(turnId) === 'running' && Date.now() - started < 10_000) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(mgr.getTurnStatus(turnId)).toBe('done');

    // The retried attempt re-narrates from scratch — the stale partial text
    // must be dropped via text_reset between the two delta runs.
    const resets = events.filter(e => e.type === 'text_reset');
    expect(resets.length).toBeGreaterThanOrEqual(1);

    // Replay the event log the way the client engine does (concatenate
    // text_delta, clear on text_reset) — the final text must be exactly the
    // second attempt's narration, with no duplicated prefix.
    let replayed = '';
    for (const e of events) {
      if (e.type === 'text_delta') replayed += e.data.text;
      else if (e.type === 'text_reset') replayed = '';
    }
    expect(replayed).toBe('I will build a voltage divider for you.');
    expect(replayed.includes('divI will')).toBe(false);

    const done = events.find(e => e.type === 'done');
    expect(done.data.response).toBe('I will build a voltage divider for you.');
  }, 15000);
});
