// Tests for the Drizzle database layer — schema, CRUD operations, types.
// Uses @libsql/client with an in-memory database (no Turso credentials needed).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq, desc } from 'drizzle-orm';
import { savedCircuits, type SavedCircuit, type NewSavedCircuit } from '../src/lib/schema';

let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle(client, { schema: { savedCircuits } });
  // libsql's execute() only runs the first statement in a multi-statement string,
  // so we batch them separately.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS saved_circuits (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '' NOT NULL,
      document TEXT NOT NULL,
      tags TEXT DEFAULT '' NOT NULL,
      is_example INTEGER DEFAULT false NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `);
  await client.execute('CREATE INDEX IF NOT EXISTS saved_circuits_name_idx ON saved_circuits (name)');
  await client.execute('CREATE INDEX IF NOT EXISTS saved_circuits_updated_at_idx ON saved_circuits (updated_at)');
  await client.execute('DELETE FROM saved_circuits');
});

afterAll(() => {
  client.close();
});

describe('Drizzle Schema', () => {
  it('savedCircuits table exists', async () => {
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const tables = result.rows.map(r => r.name as string);
    expect(tables.some(t => t === 'saved_circuits')).toBe(true);
  });

  it('has correct columns', async () => {
    const result = await client.execute('PRAGMA table_info(saved_circuits)');
    const colNames = result.rows.map(r => (r as any).name as string);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('description');
    expect(colNames).toContain('document');
    expect(colNames).toContain('tags');
    expect(colNames).toContain('is_example');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
  });

  it('has indexes on name and updated_at', async () => {
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'saved_circuits%'");
    const indexes = result.rows.map(r => r.name as string);
    expect(indexes.some(i => i === 'saved_circuits_name_idx')).toBe(true);
    expect(indexes.some(i => i === 'saved_circuits_updated_at_idx')).toBe(true);
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
  });

  it('auto-generates UUID id', async () => {
    const [row1] = await db.insert(savedCircuits).values({ name: 'UUID1', document: '{}' }).returning();
    const [row2] = await db.insert(savedCircuits).values({ name: 'UUID2', document: '{}' }).returning();
    expect(row1.id).not.toBe(row2.id);
    expect(row1.id.length).toBeGreaterThan(10);
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
    await new Promise(r => setTimeout(r, 1100));
    const [r2] = await db.insert(savedCircuits).values({ name: 'Second', document: '{}' }).returning();

    const rows = await db.select().from(savedCircuits).orderBy(desc(savedCircuits.updatedAt));
    const idx1 = rows.findIndex(r => r.id === r1.id);
    const idx2 = rows.findIndex(r => r.id === r2.id);
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
