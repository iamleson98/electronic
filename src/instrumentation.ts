// Next.js instrumentation hook — runs once on server startup, before any
// request is handled. Used to run DB migrations OUT of the request path so
// the first request after a deploy doesn't pay the migration cost.
//
// See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation

export async function register() {
  // Only run on the server (not in the browser / edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runMigrations } = await import('./lib/db');
    try {
      await runMigrations();
      console.warn('[instrumentation] DB migrations applied');
    } catch (err) {
      // Don't crash the server — surface the error so the first request can
      // give a more helpful message via getDb()'s retry path.
      console.error('[instrumentation] DB migrations failed:', err);
    }
  }
}
