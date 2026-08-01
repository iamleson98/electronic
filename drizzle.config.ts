// Drizzle Kit configuration.
// Used by `drizzle-kit push` / `generate` / `migrate` / `studio` to sync
// the schema in `src/lib/schema.ts` against the SQLite file at `db/custom.db`.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL?.replace(/^file:/, '') ?? './db/custom.db',
  },
  verbose: true,
  strict: true,
});
