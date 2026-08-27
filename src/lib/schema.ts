// Drizzle ORM schema — SQLite database.
// ─────────────────────────────────────────────────────────────────────────────
// Defines the `savedCircuits` table used by the circuit-save/load API.
// Migrated from Prisma (only the `SavedCircuit` model was actually used;
// the unused `User` and `Post` models were dropped during migration).
//
// Run `npm run db:push` to sync this schema into the SQLite file at `db/custom.db`.

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Saved user circuit (a serialized `CircuitDocument`).
 *
 * `document` stores the full circuit as a JSON string — components, wires,
 * sheets, drawings, etc. Kept as TEXT because SQLite has no native JSON type.
 */
export const savedCircuits = sqliteTable(
  'saved_circuits',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    document: text('document').notNull(),
    tags: text('tags').notNull().default(''),
    isExample: integer('is_example', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('saved_circuits_name_idx').on(table.name),
    index('saved_circuits_updated_at_idx').on(table.updatedAt),
  ],
);

/**
 * Normalized tag rows — one row per (circuit, tag).
 *
 * Design decision (Task: normalize tags + FTS5):
 * - The denormalized `saved_circuits.tags` TEXT column is KEPT as the source
 *   of truth (display + export + backward compatibility) and stays in sync on
 *   every write; `circuit_tags` is a derived, rebuildable index.
 * - `tag` is stored LOWERCASED (see src/lib/tags.ts) so exact-match filtering
 *   is case-insensitive without relying on collations. The unique index on
 *   (circuit_id, tag) then also enforces case-insensitive dedup per circuit.
 * - The FK uses ON DELETE CASCADE as documentation/belt-and-braces, but the
 *   app deletes tag rows explicitly in the same atomic batch — SQLite foreign
 *   keys are OFF by default in libsql, so the cascade is not relied upon.
 * - `id` is a text UUID to match the project's `saved_circuits` style.
 */
export const circuitTags = sqliteTable(
  'circuit_tags',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    circuitId: text('circuit_id')
      .notNull()
      .references(() => savedCircuits.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (table) => [
    uniqueIndex('circuit_tags_circuit_id_tag_idx').on(table.circuitId, table.tag),
    index('circuit_tags_tag_idx').on(table.tag),
  ],
);

// NOTE: `circuits_fts` (FTS5 virtual table, see drizzle/0001_tags_fts.sql) is
// intentionally NOT declared here — drizzle-kit would emit plain CREATE TABLE
// DDL for it (virtual tables are not supported by drizzle-kit), which would
// clash with the real virtual table. It is maintained by the application via
// raw SQL in src/lib/circuits-service.ts.

/** TypeScript row type for SELECT * from circuit_tags. */
export type CircuitTag = typeof circuitTags.$inferSelect;

/** TypeScript row type for INSERT into circuit_tags. */
export type NewCircuitTag = typeof circuitTags.$inferInsert;

/** TypeScript row type for SELECT * — Date fields are real `Date` objects. */
export type SavedCircuit = typeof savedCircuits.$inferSelect;

/** TypeScript row type for INSERT — `id`/timestamps are auto-generated. */
export type NewSavedCircuit = typeof savedCircuits.$inferInsert;
