// AI Chat Streaming API Route — /api/ai/chat/stream
// ─────────────────────────────────────────────────────────────────────────────
// Server-Sent Events (SSE) endpoint backed by the resumable TurnManager.
//
// The AI agentic loop runs INSIDE the TurnManager, completely detached from
// this request — a client disconnect does NOT stop the AI. This route is just
// a subscriber: it replays the turn's buffered events, then streams live
// events until the turn finalizes (done / error / cancelled).
//
// Body:
//   { messages, circuit?, simContext?, simError?, simRunning?,
//     selectedComponentId?, provider?, model?, clientId?,
//     resume?: { turnId } }
//
// Resume: pass `resume.turnId` (from the `turn` event) to re-attach to a
// running or recently-finished turn. The server replays the FULL event log —
// the client rebuilds its state and suppresses already-applied side effects.
// Unknown turnId → SSE `error { code: 'TURN_LOST' }` (server restarted); the
// client transparently restarts the request.
//
// SSE event types (each data payload carries a monotonically increasing `seq`):
//   turn           { turnId, seq }
//   status         { phase, attempt?, delayMs?, reason?, seq }
//   text_delta     { text, seq }
//   tool_call      { name, args, result?, error?, ok, seq }
//   verify         { attempt, health, issueCount, dcConverged, seq }
//   circuit_update { components, wires, seq }
//   done           { response, toolCalls, circuit, usage?, warning?, seq }
//   error          { message, code?, seq }
//   cancelled      { reason, seq }
// Plus `: ping` comment heartbeats every 15s while the turn runs.

import { NextRequest } from 'next/server';
import { getTurnManager, type TurnEvent, type TurnParams, type TurnSubscriber } from '@/lib/ai/turn-manager';
import { checkRateLimit, clientIpFromRequest } from '@/lib/ai/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min — matches the turn hard cap

function formatSse(ev: TurnEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify({ ...ev.data, seq: ev.seq })}\n\n`;
}

export async function POST(req: NextRequest) {
  type StreamRequestBody = TurnParams & { resume?: { turnId?: unknown } };
  let body: StreamRequestBody | null = null;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const mgr = getTurnManager();

  let turnId: string | null = null;
  const resumeRaw: unknown = body?.resume?.turnId;
  const resumeId: string | undefined = typeof resumeRaw === 'string' ? resumeRaw : undefined;

  if (resumeId && typeof resumeId === 'string') {
    // Resuming an existing turn — no rate limit (no new provider work), and
    // never starts new work, so the messages array isn't required either.
    if (mgr.getTurnStatus(resumeId)) turnId = resumeId;
  } else {
    // New turn — validate + rate limit BEFORE any provider work happens.
    if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages array is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const rl = checkRateLimit(clientIpFromRequest(req));
    if (!rl.ok) {
      // `code: 'RATE_LIMITED'` — the app's OWN limiter (distinct from the
      // provider-quota AI_RATE_LIMITED). Without a code the client's
      // streamOnce treats the 429 as transient and reconnects with backoff,
      // and every fresh (non-resume) retry re-records against the limiter
      // window — a reconnect storm that makes the block worse. With the code
      // the client finalizes ONCE with the wait time.
      return new Response(
        JSON.stringify({
          error: 'Too many AI requests. Please wait a moment and try again.',
          code: 'RATE_LIMITED',
          retryAfterSec: rl.retryAfterSec,
        }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfterSec) },
        },
      );
    }
    // A fresh request supersedes this client's zombie turns (e.g. left behind
    // by an auto-restart after a server hiccup) so they stop burning tokens.
    if (typeof body.clientId === 'string' && body.clientId) {
      mgr.cancelClientTurns(body.clientId);
    }
    turnId = mgr.startTurn(body);
  }

  const encoder = new TextEncoder();

  // Subscriber + cleanup shared between start() and cancel().
  let sub: TurnSubscriber | null = null;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (sub && turnId) mgr.detach(turnId, sub);
  };

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let finished = false;

      const write = (chunk: string): boolean => {
        if (closed || finished) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          // Stream errored/cancelled (client went away mid-write) — detach;
          // the TURN keeps running detached (that's the whole point).
          closed = true;
          cleanup();
          return false;
        }
      };

      const isFinal = (type: string) => type === 'done' || type === 'error' || type === 'cancelled';

      sub = {
        onEvent: (ev) => {
          if (!write(formatSse(ev))) return;
          if (isFinal(ev.type)) {
            finished = true;
            cleanup();
            try { controller.close(); } catch { /* already closed */ }
          }
        },
        onHeartbeat: () => {
          // Keep-alive comment — keeps proxies from reaping an idle
          // connection during long tool calls / provider retry backoff.
          write(': ping\n\n');
        },
      };

      // Attach (atomic with the replay snapshot — see TurnManager.attach).
      const attached = turnId ? mgr.attach(turnId, sub) : null;
      if (!attached) {
        // Vanished between the status check above and now (GC race) — the
        // client treats TURN_LOST as "restart the request".
        write(formatSse({ seq: 0, type: 'error', data: { code: 'TURN_LOST', message: 'This AI session is no longer available on the server.' } }));
        try { controller.close(); } catch { /* already closed */ }
        return;
      }

      // Replay the buffered log. This is a no-op for a brand-new turn (the
      // only buffered event is `turn` itself) and the full history for a
      // reconnecting client.
      for (const ev of attached.replay) {
        if (!write(formatSse(ev))) return;
        if (isFinal(ev.type)) finished = true;
      }
      if (finished || !attached.running) {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    // Client disconnected. IMPORTANT: do NOT cancel the turn — the AI keeps
    // working server-side; the client will resume via `resume.turnId`.
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy response buffering (nginx & friends)
    },
  });
}
