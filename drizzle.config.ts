// Drizzle Kit configuration.
// Used by `drizzle-kit push` / `generate` / `migrate` / `studio` to sync
// the schema in `src/lib/schema.ts` against the database.
//
// Resolution order (mirrors src/lib/db.ts):
//   1. TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  — remote Turso (production)
//   2. DATABASE_URL                            — local libsql file (dev)
//   3. file:./db/custom.db                     — local default (dev)
//
// `file:` URLs are plain local SQLite — no auth token needed — so
// `bun run db:push` works out of the box in local development.

import { defineConfig } from 'drizzle-kit';

const url =
  process.env.TURSO_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'file:./db/custom.db';
const authToken =
  url.startsWith('file:') ? undefined : process.env.TURSO_AUTH_TOKEN;

export default defineConfig({
  schema: './src/lib/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: { url, authToken },
  verbose: true,
  strict: true,
});
