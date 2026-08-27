// Circuits data-access service — keeps `saved_circuits`, `circuit_tags` and
// `circuits_fts` in sync, and implements the tag/search read paths.
// ─────────────────────────────────────────────────────────────────────────────
// Why this module exists: the tag/FTS consistency logic needs to be shared by
// the API routes (src/app/api/circuits/**), the startup backfill
// (src/lib/db.ts runMigrations) and the tests. Routes stay thin; everything
// here is exported and unit-testable against a plain :memory: libsql client.
//
// Consistency model:
//   - `saved_circuits.tags` (TEXT, canonical comma-separated string) is the
//     SOURCE OF TRUTH. `circuit_tags` and `circuits_fts` are derived,
//     rebuildable indexes (see rebuildTagsAndFts).
//   - Every write replaces the derived rows for that circuit inside the SAME
//     atomic `client.batch(stmts, 'write')` as the primary-table write —
//     libsql write batches are transactions, so a request either lands fully
//     or not at all.
//   - Read paths degrade gracefully: if the FTS/tag indexes are missing or a
//     MATCH expression fails, they fall back to the legacy LIKE filters
//     instead of erroring (see listCircuits).

import type { Client, InStatement } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, desc, eq, like, sql, type SQL } from 'drizzle-orm';
import { savedCircuits, type SavedCircuit } from './schema';
import { buildFtsMatchQuery, normalizeTag, parseTags, canonicalizeTags } from './tags';

/**
 * Any drizzle libsql instance (as returned by getDb()). The schema generic
 * only affects `db.query.*` (unused here — we use the query builder), so
 * `any` keeps every caller's instance assignable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CircuitsDb = LibSQLDatabase<any>;

// ─────────────────────────────────────────────────────────────────────────────
// Client access + derived-table bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the underlying libsql client from a drizzle instance. */
function rawClient(db: CircuitsDb): Client {
  const client = (db as { $client?: Client }).$client;
  if (!client) {
    throw new Error('circuits-service: drizzle instance has no $client (libsql)');
  }
  return client;
}

/**
 * DDL for the derived tables — MUST stay identical to drizzle/0001_tags_fts.sql
 * (the migration is the canonical creator; this is a lazy, idempotent
 * self-heal for DBs that were set up with `drizzle-kit push` instead of
 * migrations — push does not know about the FTS virtual table).
 */
const DERIVED_DDL: InStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS \`circuit_tags\` (
        \`id\` text PRIMARY KEY NOT NULL,
        \`circuit_id\` text NOT NULL,
        \`tag\` text NOT NULL,
        FOREIGN KEY (\`circuit_id\`) REFERENCES \`saved_circuits\`(\`id\`) ON UPDATE no action ON DELETE cascade
      )`,
  },
  { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS `circuit_tags_circuit_id_tag_idx` ON `circuit_tags` (`circuit_id`,`tag`)' },
  { sql: 'CREATE INDEX IF NOT EXISTS `circuit_tags_tag_idx` ON `circuit_tags` (`tag`)' },
  { sql: 'CREATE VIRTUAL TABLE IF NOT EXISTS `circuits_fts` USING fts5(`name`, `description`, `tags`, `circuit_id` UNINDEXED)' },
];

const ensuredClients = new WeakMap<Client, Promise<void>>();

/**
 * Make sure `circuit_tags` + `circuits_fts` exist. Cached per client so the
 * DDL runs at most once per connection, not per request.
 */
export function ensureDerivedTables(client: Client): Promise<void> {
  let p = ensuredClients.get(client);
  if (!p) {
    p = (async () => {
      // libsql execute() only runs the FIRST statement of a multi-statement
      // string, so each DDL statement is issued separately.
      for (const stmt of DERIVED_DDL) await client.execute(stmt);
    })();
    ensuredClients.set(client, p);
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived-row sync statements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Statements that REPLACE the derived rows for one circuit:
 * delete + re-insert its `circuit_tags` rows and its `circuits_fts` row.
 * Idempotent by construction (always delete-then-insert).
 */
export function derivedSyncStatements(
  circuitId: string,
  name: string,
  description: string,
  tagsText: string,
): InStatement[] {
  const stmts: InStatement[] = [
    { sql: 'DELETE FROM circuit_tags WHERE circuit_id = ?', args: [circuitId] },
  ];
  for (const tag of parseTags(tagsText)) {
    stmts.push({
      sql: 'INSERT INTO circuit_tags (id, circuit_id, tag) VALUES (?, ?, ?)',
      args: [crypto.randomUUID(), circuitId, normalizeTag(tag)],
    });
  }
  stmts.push({ sql: 'DELETE FROM circuits_fts WHERE circuit_id = ?', args: [circuitId] });
  stmts.push({
    sql: 'INSERT INTO circuits_fts (name, description, tags, circuit_id) VALUES (?, ?, ?, ?)',
    args: [name, description, tagsText, circuitId],
  });
  return stmts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateCircuitInput {
  name: string;
  description?: string;
  document: string;
  tags?: string;
  isExample?: boolean;
}

export interface UpdateCircuitInput {
  name?: string;
  description?: string;
  document?: string;
  tags?: string;
  isExample?: boolean;
}

/**
 * Create a circuit AND its derived tag/FTS rows in one atomic write batch.
 * The `tags` TEXT column is canonicalized (parse → dedupe → join ', ').
 * Returns the freshly-read row (drizzle-mapped, like the old .returning()).
 * Throws if the row can't be read back (only possible on a corrupted DB).
 */
export async function createCircuit(db: CircuitsDb, data: CreateCircuitInput): Promise<SavedCircuit> {
  const client = rawClient(db);
  await ensureDerivedTables(client);

  const id = crypto.randomUUID();
  const name = data.name;
  const description = data.description ?? '';
  const tagsText = canonicalizeTags(data.tags ?? '');

  await client.batch(
    [
      {
        sql: 'INSERT INTO saved_circuits (id, name, description, document, tags, is_example, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())',
        args: [id, name, description, data.document, tagsText, data.isExample ? 1 : 0],
      },
      ...derivedSyncStatements(id, name, description, tagsText),
    ],
    'write',
  );

  const [row] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, id)).limit(1);
  if (!row) {
    throw new Error(`circuits-service: circuit ${id} missing after insert`);
  }
  return row;
}

/**
 * Update a circuit AND re-sync its derived tag/FTS rows atomically.
 * Partial-update semantics: only provided fields are written to
 * saved_circuits (name/description changes re-index FTS too).
 * Returns the updated row, or undefined when the id does not exist.
 */
export async function updateCircuit(
  db: CircuitsDb,
  id: string,
  updates: UpdateCircuitInput,
): Promise<SavedCircuit | undefined> {
  const client = rawClient(db);
  await ensureDerivedTables(client);

  const [current] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, id)).limit(1);
  if (!current) return undefined;

  const name = updates.name ?? current.name;
  const description = updates.description ?? current.description;
  // Canonicalize on write so TEXT and circuit_tags can never drift.
  const tagsText = updates.tags !== undefined ? canonicalizeTags(updates.tags) : current.tags;

  // Build `SET` from a fixed whitelist of columns only (values are bound
  // parameters — no user input is ever interpolated into SQL structure).
  const setClauses: string[] = ['updated_at = unixepoch()'];
  const args: (string | number)[] = [];
  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    args.push(name);
  }
  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    args.push(description);
  }
  if (updates.document !== undefined) {
    setClauses.push('document = ?');
    args.push(updates.document);
  }
  if (updates.tags !== undefined) {
    setClauses.push('tags = ?');
    args.push(tagsText);
  }
  if (updates.isExample !== undefined) {
    setClauses.push('is_example = ?');
    args.push(updates.isExample ? 1 : 0);
  }

  await client.batch(
    [
      { sql: `UPDATE saved_circuits SET ${setClauses.join(', ')} WHERE id = ?`, args: [...args, id] },
      ...derivedSyncStatements(id, name, description, tagsText),
    ],
    'write',
  );

  const [row] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, id)).limit(1);
  return row;
}

/**
 * Delete a circuit and its derived tag/FTS rows in one atomic batch.
 */
export async function deleteCircuit(db: CircuitsDb, id: string): Promise<void> {
  const client = rawClient(db);
  await ensureDerivedTables(client);
  await client.batch(
    [
      { sql: 'DELETE FROM circuit_tags WHERE circuit_id = ?', args: [id] },
      { sql: 'DELETE FROM circuits_fts WHERE circuit_id = ?', args: [id] },
      { sql: 'DELETE FROM saved_circuits WHERE id = ?', args: [id] },
    ],
    'write',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Read path
// ─────────────────────────────────────────────────────────────────────────────

export interface CircuitListItem {
  id: string;
  name: string;
  description: string;
  tags: string;
  /** Parsed tags (added field — backward-compatible addition). */
  tagList: string[];
  isExample: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListCircuitsOptions {
  search?: string | null;
  tag?: string | null;
  isExample?: string | null;
  limit?: number;
}

export interface ListCircuitsResult {
  circuits: CircuitListItem[];
  nextCursor: string | null;
}

/** Attach the derived `tagList` field to a row (parsed from the TEXT column). */
export function withTagList<T extends { tags: string }>(row: T): T & { tagList: string[] } {
  return { ...row, tagList: parseTags(row.tags) };
}

const LIST_FIELDS = {
  id: savedCircuits.id,
  name: savedCircuits.name,
  description: savedCircuits.description,
  tags: savedCircuits.tags,
  isExample: savedCircuits.isExample,
  createdAt: savedCircuits.createdAt,
  updatedAt: savedCircuits.updatedAt,
};

/**
 * List circuits with the exact pagination semantics of the old route:
 * limit+1 probe rows, desc(updatedAt), `nextCursor` = id of the last item
 * when more rows exist. (The `cursor` query param was never consumed by the
 * old route either — preserved as-is.)
 *
 * Filters:
 *   - `tag`  → exact, case-insensitive match against circuit_tags rows
 *              (no more "power" matching "superpower"). A circuit with
 *              several matching tag rows appears ONCE (IN subquery).
 *   - `search` → FTS5 MATCH over name+description+tags with prefix matching
 *              on the last term ("supp" finds "supply").
 *
 * Both fall back to the legacy LIKE filters if the optimized query throws
 * (missing table, malformed MATCH, …) — never a 500 for search problems.
 */
export async function listCircuits(db: CircuitsDb, opts: ListCircuitsOptions): Promise<ListCircuitsResult> {
  const limit = Math.min(100, Math.max(1, Number.isFinite(opts.limit as number) ? (opts.limit as number) : 50));

  const isExampleCondition =
    opts.isExample === 'true'
      ? eq(savedCircuits.isExample, true)
      : opts.isExample === 'false'
        ? eq(savedCircuits.isExample, false)
        : undefined;

  // ── Optimized conditions (normalized tag join + FTS MATCH) ──
  const optimized: SQL[] = [];
  if (isExampleCondition) optimized.push(isExampleCondition);

  const normalizedTag = opts.tag ? normalizeTag(opts.tag) : '';
  if (normalizedTag) {
    optimized.push(
      sql`(${savedCircuits.id} IN (SELECT circuit_id FROM circuit_tags WHERE tag = ${normalizedTag}))`,
    );
  }

  const ftsQuery = opts.search ? buildFtsMatchQuery(opts.search) : null;
  if (ftsQuery) {
    optimized.push(
      sql`(${savedCircuits.id} IN (SELECT circuit_id FROM circuits_fts WHERE circuits_fts MATCH ${ftsQuery}))`,
    );
  } else if (opts.search) {
    // Input that can't be turned into a safe MATCH expression (e.g. only
    // punctuation) → legacy behavior for that input.
    optimized.push(like(savedCircuits.name, `%${opts.search}%`));
  }

  // ── Legacy conditions (pre-Task-6 behavior — the fallback) ──
  const legacy: SQL[] = [];
  if (isExampleCondition) legacy.push(isExampleCondition);
  if (opts.search) legacy.push(like(savedCircuits.name, `%${opts.search}%`));
  if (opts.tag) legacy.push(like(savedCircuits.tags, `%${opts.tag}%`));

  const run = async (conditions: SQL[]): Promise<CircuitListItem[]> => {
    const query = db
      .select(LIST_FIELDS)
      .from(savedCircuits)
      .orderBy(desc(savedCircuits.updatedAt))
      .limit(limit + 1); // +1 to check if there are more
    const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
    return rows.map((r) => withTagList(r));
  };

  let items: CircuitListItem[];
  try {
    items = await run(optimized);
  } catch (err) {
    // Missing derived tables or a rejected MATCH expression — degrade to the
    // old LIKE filters instead of failing the request.
    console.warn('[circuits-service] optimized filter failed, falling back to LIKE:', err);
    items = await run(legacy);
  }

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? page[page.length - 1]?.id : null;
  return { circuits: page, nextCursor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Backfill / rebuild
// ─────────────────────────────────────────────────────────────────────────────

/** Flush accumulated per-circuit statement groups, never splitting a circuit. */
async function flush(client: Client, groups: InStatement[][]): Promise<void> {
  let batch: InStatement[] = [];
  const flushNow = async () => {
    if (batch.length > 0) {
      await client.batch(batch, 'write');
      batch = [];
    }
  };
  for (const group of groups) {
    if (batch.length + group.length > 100) await flushNow();
    batch.push(...group);
  }
  await flushNow();
}

/**
 * Rebuild `circuit_tags` and `circuits_fts` for ALL circuits from the TEXT
 * `tags` / name / description columns. Idempotent (delete + reinsert per
 * circuit, batched atomically) — safe to run any number of times.
 *
 * Called after migrations at server startup (src/lib/db.ts): it backfills
 * pre-existing rows once the new tables exist and self-heals any drift,
 * because the TEXT column is the source of truth.
 */
export async function rebuildTagsAndFts(client: Client): Promise<void> {
  await ensureDerivedTables(client);
  const result = await client.execute('SELECT id, name, description, tags FROM saved_circuits');
  const groups: InStatement[][] = [];
  for (const row of result.rows) {
    const r = row as unknown as { id: string; name: string; description: string; tags: string };
    groups.push(derivedSyncStatements(r.id, r.name, r.description, r.tags));
  }
  await flush(client, groups);
}
