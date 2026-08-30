// In-memory rate limiter for the AI chat endpoints.
// ─────────────────────────────────────────────────────────────────────────────
// The AI routes proxy paid/throttled LLM APIs and can hold a connection for
// minutes (streaming + tool loops). Without any limit a single client (or a
// runaway script) can open unbounded concurrent provider calls. This is a
// deliberately tiny per-process sliding-window limiter:
//   - Good enough for abuse resistance on a single Node instance / Vercel
//     lambda (each instance keeps its own window; per-instance limits are
//     strictly additive protection).
//   - No external store / config — works identically in dev and prod.
//
// Not a general-purpose middleware: imported directly by the two AI chat
// routes (POST /api/ai/chat and /api/ai/chat/stream).

export interface RateLimitOptions {
  /** Max requests inside the window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

export const AI_RATE_LIMIT: RateLimitOptions = { limit: 20, windowMs: 60_000 };

interface WindowState {
  timestamps: number[];
}

// Module-level state survives across requests in the same process. On the
// serverless runtime each warm lambda keeps its own copy — acceptable.
const globalForRateLimit = globalThis as unknown as {
  __aiRateLimitWindows: Map<string, WindowState> | undefined;
};
const windows: Map<string, WindowState> =
  globalForRateLimit.__aiRateLimitWindows ?? new Map<string, WindowState>();
globalForRateLimit.__aiRateLimitWindows = windows;

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the oldest request in the window ages out (for Retry-After). */
  retryAfterSec: number;
  remaining: number;
}

/** Sliding-window rate check. Records the request when allowed. */
export function checkRateLimit(key: string, opts: RateLimitOptions = AI_RATE_LIMIT): RateLimitResult {
  const now = Date.now();
  let state = windows.get(key);
  if (!state) {
    state = { timestamps: [] };
    windows.set(key, state);
  }
  // Drop timestamps outside the window
  state.timestamps = state.timestamps.filter((t) => now - t < opts.windowMs);

  if (state.timestamps.length >= opts.limit) {
    const oldest = state.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((opts.windowMs - (now - oldest)) / 1000));
    return { ok: false, retryAfterSec, remaining: 0 };
  }

  state.timestamps.push(now);
  // Opportunistic cleanup so the map cannot grow without bound when many
  // distinct keys appear (each entry is tiny, but be tidy).
  if (windows.size > 10_000) {
    for (const [k, s] of windows) {
      if (s.timestamps.every((t) => now - t >= opts.windowMs)) windows.delete(k);
    }
  }
  return { ok: true, retryAfterSec: 0, remaining: opts.limit - state.timestamps.length };
}

/** Best-effort client IP for rate-limit keying (proxy-aware). */
export function clientIpFromRequest(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    // May be a comma-separated chain — first hop is the client
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}
