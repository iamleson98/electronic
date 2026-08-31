// AI Turn Cancel Route — POST /api/ai/chat/cancel
// ─────────────────────────────────────────────────────────────────────────────
// Because AI turns now run detached from the SSE connection (so a network
// hiccup can't kill the AI's work), the user's Stop button needs an explicit
// out-of-band channel to cancel the server-side turn. This is it.
//
// Body: { turnId: string }
// Always 200 — cancelling an unknown/finished turn is a no-op (idempotent),
// e.g. when the Stop click races the turn's natural completion.

import { NextRequest } from 'next/server';
import { getTurnManager } from '@/lib/ai/turn-manager';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const turnId = body?.turnId;
  if (typeof turnId !== 'string' || !turnId) {
    return new Response(JSON.stringify({ error: 'turnId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const cancelled = getTurnManager().cancelTurn(turnId);
  return new Response(JSON.stringify({ ok: true, cancelled }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
