// Tests for Task 6 — normalized tags + FTS5 full-text search.
//
// Uses @libsql/client with an in-memory database (same harness as
// tests/database.test.ts), but applies the REAL drizzle migrations (journal +
// SQL files) so drizzle/0001_tags_fts.sql — including the FTS5 virtual table
// and its SQL comment block — is exercised exactly as in production.
//
// Covers:
//   - parseTags / normalizeTag / canonicalizeTags / buildFtsMatchQuery units
//   - migration creates circuit_tags + circuits_fts
//   - write-path sync (create/update/delete keep TEXT + circuit_tags + FTS
//     consistent, atomically)
//   - tag filter: exact, case-insensitive, deduped (no "power"/"superpower")
//   - search: FTS over name/description/tags, prefix on last term, LIKE
//     fallback when the FTS table is missing
//   - backfill idempotency (rebuildTagsAndFts run twice → identical state)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { circuitTags, savedCircuits } from '../src/lib/schema';
import { parseTags, normalizeTag, canonicalizeTags, buildFtsMatchQuery } from '../src/lib/tags';
import {
  createCircuit,
  updateCircuit,
  deleteCircuit,
  listCircuits,
  rebuildTagsAndFts,
  type CircuitsDb,
} from '../src/lib/circuits-service';

let client: Client;
let db: CircuitsDb;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle(client, { schema: { savedCircuits, circuitTags } }) as CircuitsDb;
  // Apply the real migrations — proves 0001_tags_fts.sql (journal entry,
  // circuit_tags DDL + FTS5 virtual table) applies cleanly on a fresh DB.
  await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
});

afterAll(() => {
  client.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function tagsFor(circuitId: string): Promise<string[]> {
  const r = await client.execute({
    sql: 'SELECT tag FROM circuit_tags WHERE circuit_id = ? ORDER BY tag',
    args: [circuitId],
  });
  return r.rows.map((row) => row.tag as string);
}

async function ftsRowFor(circuitId: string): Promise<{ name: string; description: string; tags: string } | undefined> {
  const r = await client.execute({
    sql: 'SELECT name, description, tags FROM circuits_fts WHERE circuit_id = ?',
    args: [circuitId],
  });
  return r.rows[0] as { name: string; description: string; tags: string } | undefined;
}

/** Wipe all data (kept by the read-path describes for deterministic assertions). */
async function resetData(): Promise<void> {
  await client.execute('DELETE FROM circuit_tags');
  await client.execute('DELETE FROM circuits_fts');
  await client.execute('DELETE FROM saved_circuits');
}

// ── parseTags & friends ──────────────────────────────────────────────────────

describe('parseTags', () => {
  it('splits on commas', () => {
    expect(parseTags('power, supply')).toEqual(['power', 'supply']);
  });

  it('splits on whitespace', () => {
    expect(parseTags('opamp filter')).toEqual(['opamp', 'filter']);
  });

  it('splits on mixed commas and whitespace, trimming extras', () => {
    expect(parseTags('  a ,, b ,  c  d ')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('trims individual tags', () => {
    expect(parseTags(' power , supply ')).toEqual(['power', 'supply']);
  });

  it('dedupes case-insensitively, keeping the first spelling', () => {
    expect(parseTags('Power, POWER, power Supply')).toEqual(['Power', 'Supply']);
  });

  it('returns [] for empty / blank input', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('   ')).toEqual([]);
    expect(parseTags(' , , ')).toEqual([]);
  });

  it('keeps a single tag intact', () => {
    expect(parseTags('superpower')).toEqual(['superpower']);
  });
});

describe('normalizeTag / canonicalizeTags', () => {
  it('normalizes for storage: trimmed + lowercased', () => {
    expect(normalizeTag('  PoWeR  ')).toBe('power');
    expect(normalizeTag('Supply')).toBe('supply');
  });

  it('canonicalizes to a comma-separated string that round-trips', () => {
    const raw = 'b, a, A, C';
    const canonical = canonicalizeTags(raw);
    expect(canonical).toBe('b, a, C');
    expect(parseTags(canonical)).toEqual(parseTags(raw));
  });
});

describe('buildFtsMatchQuery (sanitizer)', () => {
  it('wraps a single term and appends prefix *', () => {
    expect(buildFtsMatchQuery('supply')).toBe('"supply"*');
  });

  it('quotes every term but only prefixes the LAST term', () => {
    expect(buildFtsMatchQuery('power supp')).toBe('"power" "supp"*');
  });

  it('strips embedded double quotes (phrase-escaping)', () => {
    expect(buildFtsMatchQuery('foo"bar')).toBe('"foobar"*');
  });

  it('neutralizes FTS operators (NEAR/AND/OR, parens, colons)', () => {
    expect(buildFtsMatchQuery('NEAR(')).toBe('"NEAR("*');
    expect(buildFtsMatchQuery('a:b')).toBe('"a:b"*');
    // AND/OR/NOT become quoted strings, not operators
    expect(buildFtsMatchQuery('AND OR NOT')).toBe('"AND" "OR" "NOT"*');
  });

  it('returns null for input with no usable terms', () => {
    expect(buildFtsMatchQuery('')).toBeNull();
    expect(buildFtsMatchQuery('   ')).toBeNull();
    expect(buildFtsMatchQuery('"""')).toBeNull();
  });
});

// ── migration ────────────────────────────────────────────────────────────────

describe('migration 0001_tags_fts', () => {
  it('creates the circuit_tags table', async () => {
    const r = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='circuit_tags'");
    expect(r.rows.map((row) => row.name)).toContain('circuit_tags');
  });

  it('creates the circuits_fts FTS5 virtual table', async () => {
    const r = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='circuits_fts'");
    expect(r.rows.map((row) => row.name)).toContain('circuits_fts');
  });

  it('creates the unique (circuit_id, tag) index and the tag index', async () => {
    const r = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='circuit_tags'");
    const names = r.rows.map((row) => row.name);
    expect(names).toContain('circuit_tags_circuit_id_tag_idx');
    expect(names).toContain('circuit_tags_tag_idx');
  });

  it('records both migrations in __drizzle_migrations', async () => {
    const r = await client.execute('SELECT COUNT(*) as n FROM __drizzle_migrations');
    expect(Number((r.rows[0] as { n: number }).n)).toBe(2);
  });
});

// ── write path ───────────────────────────────────────────────────────────────

describe('createCircuit: tags/FTS sync on create', () => {
  it('writes TEXT column, circuit_tags rows and FTS row consistently', async () => {
    const circuit = await createCircuit(db, {
      name: 'Power Supply',
      description: '5V regulated supply',
      document: '{"version":1}',
      tags: 'power, supply',
      isExample: false,
    });
    expect(circuit).toBeDefined();

    // TEXT column is canonical
    expect(circuit!.tags).toBe('power, supply');
    // normalized (lowercased) rows
    expect(await tagsFor(circuit!.id)).toEqual(['power', 'supply']);
    // FTS row mirrors the searchable text
    expect(await ftsRowFor(circuit!.id)).toMatchObject({
      name: 'Power Supply',
      description: '5V regulated supply',
      tags: 'power, supply',
    });
  });

  it('canonicalizes messy tag input (dedupe + trim, case preserved in TEXT)', async () => {
    const circuit = await createCircuit(db, {
      name: 'Messy Tags',
      description: '',
      document: '{}',
      tags: '  POWER,  Power SUPPLY ',
    });
    // first-seen case preserved for display, separators normalized
    expect(circuit!.tags).toBe('POWER, SUPPLY');
    // stored normalized + deduped
    expect(await tagsFor(circuit!.id)).toEqual(['power', 'supply']);
  });

  it('handles empty tags (no circuit_tags rows, empty FTS tags)', async () => {
    const circuit = await createCircuit(db, { name: 'No Tags', document: '{}', tags: '' });
    expect(circuit!.tags).toBe('');
    expect(await tagsFor(circuit!.id)).toEqual([]);
    expect((await ftsRowFor(circuit!.id))?.tags).toBe('');
  });
});

describe('updateCircuit: tags/FTS sync on update', () => {
  it('replaces circuit_tags and FTS when tags change', async () => {
    const circuit = await createCircuit(db, {
      name: 'Tag Swap',
      description: 'before',
      document: '{}',
      tags: 'old, stale',
    });

    const updated = await updateCircuit(db, circuit!.id, { tags: 'filter, digital' });
    expect(updated!.tags).toBe('filter, digital');
    // stale rows fully replaced, not appended
    expect(await tagsFor(circuit!.id)).toEqual(['digital', 'filter']);
    expect((await ftsRowFor(circuit!.id))?.tags).toBe('filter, digital');
  });

  it('re-indexes FTS when the name changes (tags untouched)', async () => {
    const circuit = await createCircuit(db, {
      name: 'Before Rename',
      description: 'keeps tags',
      document: '{}',
      tags: 'keepme',
    });

    const updated = await updateCircuit(db, circuit!.id, { name: 'After Rename' });
    expect(updated!.name).toBe('After Rename');
    expect(updated!.tags).toBe('keepme');
    expect(await tagsFor(circuit!.id)).toEqual(['keepme']);
    expect((await ftsRowFor(circuit!.id))?.name).toBe('After Rename');
  });

  it('partial update (document only) leaves tags and FTS intact', async () => {
    const circuit = await createCircuit(db, {
      name: 'Partial Update',
      description: 'desc',
      document: '{}',
      tags: 'keep',
    });

    await updateCircuit(db, circuit!.id, { document: '{"version":2}' });
    const [row] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, circuit!.id));
    expect(row.document).toBe('{"version":2}');
    expect(row.tags).toBe('keep');
    expect(await tagsFor(circuit!.id)).toEqual(['keep']);
    expect((await ftsRowFor(circuit!.id))?.tags).toBe('keep');
  });

  it('clears derived rows when tags are set to empty', async () => {
    const circuit = await createCircuit(db, { name: 'Clear Tags', document: '{}', tags: 'gone, soon' });
    const updated = await updateCircuit(db, circuit!.id, { tags: '' });
    expect(updated!.tags).toBe('');
    expect(await tagsFor(circuit!.id)).toEqual([]);
    expect((await ftsRowFor(circuit!.id))?.tags).toBe('');
  });

  it('returns undefined for a nonexistent id (no partial writes)', async () => {
    expect(await updateCircuit(db, 'does-not-exist', { name: 'X' })).toBeUndefined();
    const r = await client.execute("SELECT COUNT(*) as n FROM saved_circuits WHERE id = 'does-not-exist'");
    expect(Number((r.rows[0] as { n: number }).n)).toBe(0);
  });
});

describe('deleteCircuit: full cleanup', () => {
  it('removes saved_circuits, circuit_tags AND circuits_fts rows', async () => {
    const circuit = await createCircuit(db, {
      name: 'Delete Me',
      description: 'bye',
      document: '{}',
      tags: 'temp, junk',
    });

    await deleteCircuit(db, circuit!.id);

    const sc = await client.execute({
      sql: 'SELECT COUNT(*) as n FROM saved_circuits WHERE id = ?',
      args: [circuit!.id],
    });
    const ct = await client.execute({
      sql: 'SELECT COUNT(*) as n FROM circuit_tags WHERE circuit_id = ?',
      args: [circuit!.id],
    });
    const fts = await client.execute({
      sql: 'SELECT COUNT(*) as n FROM circuits_fts WHERE circuit_id = ?',
      args: [circuit!.id],
    });
    expect(Number((sc.rows[0] as { n: number }).n)).toBe(0);
    expect(Number((ct.rows[0] as { n: number }).n)).toBe(0);
    expect(Number((fts.rows[0] as { n: number }).n)).toBe(0);
  });
});

// ── read path: tag filter ────────────────────────────────────────────────────

describe('listCircuits: ?tag= exact matching', () => {
  beforeAll(resetData);

  it('matches tags exactly (case-insensitive) — no substring false positives', async () => {
    const a = await createCircuit(db, { name: 'PSU', description: '', document: '{}', tags: 'power, supply' });
    const b = await createCircuit(db, { name: 'Super Amp', description: '', document: '{}', tags: 'superpower' });

    // "power" must NOT match the "superpower" tag (the old LIKE bug)
    let r = await listCircuits(db, { tag: 'power' });
    expect(r.circuits.map((c) => c.id)).toEqual([a!.id]);

    // exact match is case-insensitive
    r = await listCircuits(db, { tag: 'POWER' });
    expect(r.circuits.map((c) => c.id)).toEqual([a!.id]);

    // the full tag still matches its own circuit
    r = await listCircuits(db, { tag: 'superpower' });
    expect(r.circuits.map((c) => c.id)).toEqual([b!.id]);

    // unknown tag → empty
    r = await listCircuits(db, { tag: 'nosuchtag' });
    expect(r.circuits).toEqual([]);
  });

  it('returns a circuit with several matching tag rows exactly ONCE', async () => {
    // same circuit matched via multiple distinct tags is impossible for one
    // ?tag= value, but duplicate tag *rows* must not duplicate results — the
    // unique index plus the IN subquery guarantee that. Emulate via two
    // circuits sharing a tag + one of them having extra tags.
    const a = await createCircuit(db, { name: 'Analog One', description: '', document: '{}', tags: 'analog, rc, filter' });
    await createCircuit(db, { name: 'Analog Two', description: '', document: '{}', tags: 'analog' });

    const r = await listCircuits(db, { tag: 'analog' });
    expect(r.circuits).toHaveLength(2);
    expect(new Set(r.circuits.map((c) => c.id)).size).toBe(2);
    const aRow = r.circuits.find((c) => c.id === a!.id);
    expect(aRow).toBeDefined();
  });
});

// ── read path: FTS search ────────────────────────────────────────────────────

describe('listCircuits: ?search= FTS5', () => {
  beforeAll(resetData);

  it('finds matches in name, description and tags', async () => {
    const byName = await createCircuit(db, { name: 'Blinkenlights', description: '', document: '{}', tags: '' });
    const byDesc = await createCircuit(db, { name: 'Untitled', description: 'astable multivibrator', document: '{}', tags: '' });
    const byTags = await createCircuit(db, { name: 'Untitled 2', description: '', document: '{}', tags: 'oscillator' });

    expect((await listCircuits(db, { search: 'blinken' })).circuits.map((c) => c.id)).toEqual([byName!.id]);
    expect((await listCircuits(db, { search: 'multivibrator' })).circuits.map((c) => c.id)).toEqual([byDesc!.id]);
    expect((await listCircuits(db, { search: 'oscillator' })).circuits.map((c) => c.id)).toEqual([byTags!.id]);
  });

  it('prefix-matches the last term ("supp" finds "supply")', async () => {
    const a = await createCircuit(db, { name: 'Lab PSU', description: '', document: '{}', tags: 'supply' });
    await createCircuit(db, { name: 'Unrelated', description: '', document: '{}', tags: 'filter' });
    const r = await listCircuits(db, { search: 'supp' });
    expect(r.circuits.map((c) => c.id)).toEqual([a!.id]);
  });

  it('multi-term search ANDs terms with prefix only on the last', async () => {
    const a = await createCircuit(db, { name: 'OpAmp Filter', description: 'low pass audio', document: '{}', tags: 'opamp filter' });
    await createCircuit(db, { name: 'OpAmp Amp', description: '', document: '{}', tags: 'opamp' });
    // "opamp" AND "fil"* — only the filter matches
    const r = await listCircuits(db, { search: 'opamp fil' });
    expect(r.circuits.map((c) => c.id)).toEqual([a!.id]);
  });

  it('matches case-insensitively', async () => {
    await createCircuit(db, { name: 'CaseInsensitiveName', description: '', document: '{}', tags: '' });
    const r = await listCircuits(db, { search: 'caseinsensitivenam' });
    expect(r.circuits).toHaveLength(1);
  });

  it('does NOT match mid-word fragments (token-based, unlike LIKE)', async () => {
    await createCircuit(db, { name: 'Regulator Board', description: '', document: '{}', tags: '' });
    const r = await listCircuits(db, { search: 'egulat' });
    expect(r.circuits).toEqual([]);
  });

  it('never throws on operator-laden or malformed input (sanitized MATCH)', async () => {
    for (const q of ['NEAR(', '"unterminated', 'AND OR NOT', 'a"b', '   ', '"', 'col:value*']) {
      await expect(listCircuits(db, { search: q })).resolves.toBeDefined();
    }
  });

  it('adds a tagList field (parsed tags) to every row', async () => {
    const a = await createCircuit(db, { name: 'Tagged', description: '', document: '{}', tags: 'alpha, Beta' });
    const r = await listCircuits(db, { search: 'Tagged' });
    expect(r.circuits[0].tagList).toEqual(['alpha', 'Beta']);
    expect(r.circuits[0].tags).toBe('alpha, Beta');
    expect(a).toBeDefined();
  });
});

// ── read path: fallbacks + pagination ────────────────────────────────────────

describe('listCircuits: LIKE fallback when FTS table is missing', () => {
  // Separate DB: simulate an un-migrated database by dropping the derived
  // tables, then confirm reads degrade to the legacy LIKE filters.
  let fClient: Client;
  let fDb: CircuitsDb;

  beforeAll(async () => {
    fClient = createClient({ url: ':memory:' });
    fDb = drizzle(fClient, { schema: { savedCircuits, circuitTags } }) as CircuitsDb;
    await migrate(fDb, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    await createCircuit(fDb, { name: 'Fallback Name Hit', description: 'zzz-description-only', document: '{}', tags: 'xyzzy' });
    await createCircuit(fDb, { name: 'Other', description: '', document: '{}', tags: '' });
    await fClient.execute('DROP TABLE circuits_fts');
    await fClient.execute('DROP TABLE circuit_tags');
  });

  afterAll(() => fClient.close());

  it('falls back to name-LIKE for search (never a 500)', async () => {
    const r = await listCircuits(fDb, { search: 'fallback name' });
    expect(r.circuits.map((c) => c.name)).toEqual(['Fallback Name Hit']);
  });

  it('legacy search matches the NAME only (old behavior preserved)', async () => {
    const r = await listCircuits(fDb, { search: 'zzz-description-only' });
    expect(r.circuits).toEqual([]);
  });

  it('falls back to tags-LIKE for tag filtering (old behavior preserved)', async () => {
    const r = await listCircuits(fDb, { tag: 'xyzzy' });
    expect(r.circuits.map((c) => c.name)).toEqual(['Fallback Name Hit']);
  });
});

describe('listCircuits: pagination semantics', () => {
  it('uses limit+1 probing with desc(updatedAt) and reports nextCursor', async () => {
    // Insert with explicit timestamps for deterministic ordering.
    for (let i = 1; i <= 5; i++) {
      await client.execute({
        sql: "INSERT INTO saved_circuits (id, name, description, document, tags, is_example, created_at, updated_at) VALUES (?, ?, '', '{}', '', 0, ?, ?)",
        args: [`page-${i}`, `Page Circuit ${i}`, 1000 + i, 2000 + i],
      });
    }
    await rebuildTagsAndFts(client);

    const page1 = await listCircuits(db, { limit: 2 });
    expect(page1.circuits).toHaveLength(2);
    // newest first
    expect(page1.circuits[0].id).not.toBe('page-5'); // unix-now circuits are newer
    expect(page1.nextCursor).toBe(page1.circuits[1].id);

    // full list ordering check over the seeded rows
    const all = await listCircuits(db, { limit: 100 });
    const idx = (id: string) => all.circuits.findIndex((c) => c.id === id);
    expect(idx('page-5')).toBeLessThan(idx('page-4'));
    expect(idx('page-4')).toBeLessThan(idx('page-3'));
    expect(idx('page-3')).toBeLessThan(idx('page-2'));
    expect(idx('page-2')).toBeLessThan(idx('page-1'));

    // a page covering everything → no cursor
    const big = await listCircuits(db, { limit: 100 });
    expect(big.nextCursor).toBeNull();
  });

  it('filters by isExample', async () => {
    await createCircuit(db, { name: 'Example Circuit', document: '{}', tags: '', isExample: true });
    await createCircuit(db, { name: 'User Circuit', document: '{}', tags: '', isExample: false });

    const examples = await listCircuits(db, { isExample: 'true' });
    expect(examples.circuits.every((c) => c.isExample)).toBe(true);
    expect(examples.circuits.some((c) => c.name === 'Example Circuit')).toBe(true);

    const users = await listCircuits(db, { isExample: 'false' });
    expect(users.circuits.every((c) => !c.isExample)).toBe(true);
    expect(users.circuits.some((c) => c.name === 'User Circuit')).toBe(true);
  });

  it('combines tag + isExample filters', async () => {
    await createCircuit(db, { name: 'Analog Example', document: '{}', tags: 'analog', isExample: true });
    await createCircuit(db, { name: 'Analog User', document: '{}', tags: 'analog', isExample: false });

    const r = await listCircuits(db, { tag: 'analog', isExample: 'false' });
    expect(r.circuits.length).toBeGreaterThan(0);
    expect(r.circuits.every((c) => !c.isExample)).toBe(true);
    expect(r.circuits.map((c) => c.name)).toContain('Analog User');
    expect(r.circuits.map((c) => c.name)).not.toContain('Analog Example');
    // every returned circuit really has the tag
    for (const c of r.circuits) {
      expect(c.tagList.map((t) => t.toLowerCase())).toContain('analog');
    }
  });
});

// ── backfill ─────────────────────────────────────────────────────────────────

describe('rebuildTagsAndFts (backfill)', () => {
  it('parses messy legacy TEXT tags into normalized rows (dedup + lowercase)', async () => {
    // Raw insert bypassing the service — simulates pre-migration data.
    await client.execute({
      sql: "INSERT INTO saved_circuits (id, name, description, document, tags, is_example, created_at, updated_at) VALUES ('legacy-1', 'Legacy One', 'legacy description', '{}', 'Power,  POWER supply', 0, 100, 100)",
    });
    // No derived rows yet
    expect(await tagsFor('legacy-1')).toEqual([]);

    await rebuildTagsAndFts(client);

    expect(await tagsFor('legacy-1')).toEqual(['power', 'supply']);
    expect(await ftsRowFor('legacy-1')).toMatchObject({
      name: 'Legacy One',
      description: 'legacy description',
      tags: 'Power,  POWER supply',
    });
    // the TEXT column is untouched — it remains the source of truth
    const r = await client.execute({ sql: 'SELECT tags FROM saved_circuits WHERE id = ?', args: ['legacy-1'] });
    expect((r.rows[0] as { tags: string }).tags).toBe('Power,  POWER supply');
  });

  it('is idempotent — running twice yields the identical derived state', async () => {
    const snapshot = async () => {
      const ct = await client.execute('SELECT circuit_id, tag FROM circuit_tags ORDER BY circuit_id, tag');
      const fts = await client.execute('SELECT circuit_id, name, description, tags FROM circuits_fts ORDER BY circuit_id');
      return JSON.stringify({ ct: ct.rows, fts: fts.rows });
    };
    await rebuildTagsAndFts(client);
    const first = await snapshot();
    await rebuildTagsAndFts(client);
    const second = await snapshot();
    expect(second).toBe(first);
    // and no duplicates crept in
    const dupe = await client.execute(
      'SELECT circuit_id, tag, COUNT(*) as n FROM circuit_tags GROUP BY circuit_id, tag HAVING n > 1',
    );
    expect(dupe.rows).toEqual([]);
  });

  it('backfilled rows are queryable through the tag filter and FTS search', async () => {
    const byTag = await listCircuits(db, { tag: 'supply' });
    expect(byTag.circuits.some((c) => c.id === 'legacy-1')).toBe(true);
    const bySearch = await listCircuits(db, { search: 'legacy des' });
    expect(bySearch.circuits.some((c) => c.id === 'legacy-1')).toBe(true);
  });
});
