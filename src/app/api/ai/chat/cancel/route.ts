// AI Turn Cancel Route — POST /api/ai/chat/cancel
// ─────────────────────────────────────────────────────────────────────────────
// Because AI turns now run detached from the SSE connection (so a network
// hiccup can't kill the AI's work), the user's Stop button needs an explicit
// out-of-band channel to cancel the server-side turn. This is it.
//
// Body: { turnId?: string, clientId?: string }
//   - turnId   → cancels exactly that turn (normal case: the client knows
//                the id from the `turn` SSE event).
//   - clientId → cancels every RUNNING turn of that client. This covers the
//                Stop race BEFORE the first `turn` event arrives: the turn is
//                already running server-side (the id simply hasn't completed
//                the round-trip to the browser yet). A client runs at most
//                one turn at a time (send() is gated on `active`), so this is
//                precise in practice.
// Always 200 — cancelling an unknown/finished turn is a no-op (idempotent),
// e.g. when the Stop click races the turn's natural completion.

import { NextRequest } from 'next/server';
import { getTurnManager } from '@/lib/ai/turn-manager';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { turnId?: unknown; clientId?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const turnId = body?.turnId;
  const clientId = body?.clientId;
  const mgr = getTurnManager();
  if (typeof turnId === 'string' && turnId) {
    const cancelled = mgr.cancelTurn(turnId);
    return new Response(JSON.stringify({ ok: true, cancelled }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (typeof clientId === 'string' && clientId) {
    // Stop pressed before the first `turn` event reached the client.
    const cancelled = mgr.cancelClientTurns(clientId);
    return new Response(JSON.stringify({ ok: true, cancelled }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: 'turnId or clientId is required' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}
