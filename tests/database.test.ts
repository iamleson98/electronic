// Tests for the Drizzle database layer — schema, CRUD operations, types.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, desc } from 'drizzle-orm';
import { savedCircuits, type SavedCircuit, type NewSavedCircuit } from '../src/lib/schema';

const testDbPath = '/tmp/test-drizzle-schema.db';
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  sqlite = new Database(testDbPath);
  sqlite.pragma('journal_mode = WAL');
  db = drizzle(sqlite, { schema: { savedCircuits } });
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS saved_circuits (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '' NOT NULL,
      document TEXT NOT NULL,
      tags TEXT DEFAULT '' NOT NULL,
      is_example INTEGER DEFAULT false NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS saved_circuits_name_idx ON saved_circuits (name);
    CREATE INDEX IF NOT EXISTS saved_circuits_updated_at_idx ON saved_circuits (updated_at);
  `);
  sqlite.exec('DELETE FROM saved_circuits');
});

afterAll(() => {
  sqlite.close();
});

describe('Drizzle Schema', () => {
  it('savedCircuits table exists', () => {
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.some(t => t.name === 'saved_circuits')).toBe(true);
  });

  it('has correct columns', () => {
    const cols = sqlite.prepare('PRAGMA table_info(saved_circuits)').all() as any[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('description');
    expect(colNames).toContain('document');
    expect(colNames).toContain('tags');
    expect(colNames).toContain('is_example');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
  });

  it('has indexes on name and updated_at', () => {
    const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    expect(indexes.some(i => i.name === 'saved_circuits_name_idx')).toBe(true);
    expect(indexes.some(i => i.name === 'saved_circuits_updated_at_idx')).toBe(true);
  });
});

describe('Drizzle CRUD — INSERT', () => {
  it('inserts a row and returns it', async () => {
    const [row] = await db.insert(savedCircuits).values({
      name: 'Test Insert',
      description: 'Test description',
      document: '{"version":1}',
      tags: 'test',
      isExample: false,
    }).returning();

    expect(row.id).toBeDefined();
    expect(typeof row.id).toBe('string');
    expect(row.name).toBe('Test Insert');
    expect(row.description).toBe('Test description');
    expect(row.document).toBe('{"version":1}');
    expect(row.tags).toBe('test');
    expect(row.isExample).toBe(false);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it('auto-generates UUID id', async () => {
    const [row1] = await db.insert(savedCircuits).values({ name: 'UUID1', document: '{}' }).returning();
    const [row2] = await db.insert(savedCircuits).values({ name: 'UUID2', document: '{}' }).returning();
    expect(row1.id).not.toBe(row2.id);
    expect(row1.id.length).toBeGreaterThan(10); // UUID is 36 chars
  });

  it('auto-sets timestamps', async () => {
    const before = new Date();
    const [row] = await db.insert(savedCircuits).values({ name: 'TS Test', document: '{}' }).returning();
    const after = new Date();
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it('uses default values for optional fields', async () => {
    const [row] = await db.insert(savedCircuits).values({ name: 'Defaults', document: '{}' }).returning();
    expect(row.description).toBe('');
    expect(row.tags).toBe('');
    expect(row.isExample).toBe(false);
  });
});

describe('Drizzle CRUD — SELECT', () => {
  it('selects all rows', async () => {
    const rows = await db.select().from(savedCircuits);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('selects by id with eq()', async () => {
    const [inserted] = await db.insert(savedCircuits).values({ name: 'Select By ID', document: '{}' }).returning();
    const [found] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, inserted.id)).limit(1);
    expect(found.name).toBe('Select By ID');
  });

  it('returns empty array for nonexistent id', async () => {
    const rows = await db.select().from(savedCircuits).where(eq(savedCircuits.id, 'nonexistent')).limit(1);
    expect(rows).toHaveLength(0);
  });

  it('orders by updatedAt desc', async () => {
    const [r1] = await db.insert(savedCircuits).values({ name: 'First', document: '{}' }).returning();
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 1100));
    const [r2] = await db.insert(savedCircuits).values({ name: 'Second', document: '{}' }).returning();

    const rows = await db.select().from(savedCircuits).orderBy(desc(savedCircuits.updatedAt));
    const idx1 = rows.findIndex(r => r.id === r1.id);
    const idx2 = rows.findIndex(r => r.id === r2.id);
    // r2 was created later, should come first in desc order
    expect(idx2).toBeLessThan(idx1);
  });
});

describe('Drizzle CRUD — UPDATE', () => {
  it('updates name and tags', async () => {
    const [inserted] = await db.insert(savedCircuits).values({ name: 'Before Update', document: '{}' }).returning();
    const [updated] = await db.update(savedCircuits).set({
      name: 'After Update',
      tags: 'updated',
    }).where(eq(savedCircuits.id, inserted.id)).returning();

    expect(updated.name).toBe('After Update');
    expect(updated.tags).toBe('updated');
  });

  it('auto-updates updatedAt on modification', async () => {
    const [inserted] = await db.insert(savedCircuits).values({ name: 'Timestamp Test', document: '{}' }).returning();
    const originalUpdatedAt = inserted.updatedAt.getTime();

    // Wait 1+ second to ensure timestamp changes
    await new Promise(r => setTimeout(r, 1100));

    const [updated] = await db.update(savedCircuits).set({ name: 'Updated' }).where(eq(savedCircuits.id, inserted.id)).returning();
    expect(updated.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt);
  });

  it('partial update only changes provided fields', async () => {
    const [inserted] = await db.insert(savedCircuits).values({
      name: 'Partial',
      description: 'Keep this',
      tags: 'keep',
      document: '{}',
    }).returning();

    const [updated] = await db.update(savedCircuits).set({ name: 'Changed' }).where(eq(savedCircuits.id, inserted.id)).returning();

    expect(updated.name).toBe('Changed');
    expect(updated.description).toBe('Keep this');
    expect(updated.tags).toBe('keep');
  });
});

describe('Drizzle CRUD — DELETE', () => {
  it('deletes a row', async () => {
    const [inserted] = await db.insert(savedCircuits).values({ name: 'Delete Me', document: '{}' }).returning();
    await db.delete(savedCircuits).where(eq(savedCircuits.id, inserted.id));

    const rows = await db.select().from(savedCircuits).where(eq(savedCircuits.id, inserted.id));
    expect(rows).toHaveLength(0);
  });

  it('does not throw when deleting nonexistent row', async () => {
    await expect(db.delete(savedCircuits).where(eq(savedCircuits.id, 'nonexistent'))).resolves.not.toThrow();
  });
});

describe('Drizzle Types — SavedCircuit / NewSavedCircuit', () => {
  it('SavedCircuit type has all fields', () => {
    const row: SavedCircuit = {
      id: 'test-id',
      name: 'Test',
      description: 'Desc',
      document: '{}',
      tags: 'test',
      isExample: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(row.id).toBe('test-id');
    expect(row.isExample).toBe(true);
  });

  it('NewSavedCircuit type allows partial (auto fields omitted)', () => {
    const newRow: NewSavedCircuit = {
      name: 'New',
      document: '{}',
    };
    expect(newRow.name).toBe('New');
    // id, timestamps, description, tags, isExample are optional (auto-generated)
  });
});

describe('Drizzle — JSON document round-trip', () => {
  it('stores and retrieves complex JSON document', async () => {
    const doc = {
      version: 1,
      components: [
        { id: 'r1', type: 'resistor', position: { x: 4, y: 6 }, rotation: 0, parameters: { resistance: 1000 } },
        { id: 'led1', type: 'led', position: { x: 10, y: 6 }, rotation: 0, parameters: { color: 'red', forwardV: 2.0 } },
      ],
      wires: [
        { id: 'w1', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'led1', terminalId: 'a' } },
      ],
    };

    const [inserted] = await db.insert(savedCircuits).values({
      name: 'JSON Round-trip',
      document: JSON.stringify(doc),
    }).returning();

    const [retrieved] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, inserted.id)).limit(1);
    const parsedDoc = JSON.parse(retrieved.document);

    expect(parsedDoc.version).toBe(1);
    expect(parsedDoc.components).toHaveLength(2);
    expect(parsedDoc.components[0].type).toBe('resistor');
    expect(parsedDoc.wires).toHaveLength(1);
  });
});
