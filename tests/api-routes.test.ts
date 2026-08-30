// Tests for the API route handlers — tests GET/POST/PUT/DELETE with edge cases.
// Uses @libsql/client with an in-memory database and mocks getDb() so the
// API routes use the test DB instead of the real Turso connection.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock must be before imports of the route handlers
const { createClient } = await import('@libsql/client');
const { drizzle } = await import('drizzle-orm/libsql');
const { savedCircuits } = await import('../src/lib/schema');

// Create a test DB in memory — stored in a module-level variable so the
// mock factory can reference it.
const client = createClient({ url: ':memory:' });
const testDb = drizzle(client, { schema: { savedCircuits } });

vi.mock('@/lib/db', () => ({
  getDb: async () => testDb,
  dbReady: Promise.resolve(testDb),
}));

const { GET, POST } = await import('../src/app/api/circuits/route');
const { GET: GET_ID, PUT, DELETE } = await import('../src/app/api/circuits/[id]/route');

beforeAll(async () => {
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
  // Derived tag/FTS tables (mirrors drizzle/0001_tags_fts.sql; the service
  // also creates them lazily via ensureDerivedTables).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS circuit_tags (
      id TEXT PRIMARY KEY NOT NULL,
      circuit_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      FOREIGN KEY (circuit_id) REFERENCES saved_circuits(id) ON UPDATE no action ON DELETE cascade
    )
  `);
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS circuit_tags_circuit_id_tag_idx ON circuit_tags (circuit_id, tag)');
  await client.execute('CREATE INDEX IF NOT EXISTS circuit_tags_tag_idx ON circuit_tags (tag)');
  await client.execute("CREATE VIRTUAL TABLE IF NOT EXISTS circuits_fts USING fts5(name, description, tags, circuit_id UNINDEXED)");
  await client.execute('DELETE FROM circuits_fts');
  await client.execute('DELETE FROM circuit_tags');
  await client.execute('DELETE FROM saved_circuits');
});

function makeReq(url: string, method: string, body?: any): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
  });
}

describe('API: GET /api/circuits', () => {
  it('returns empty list initially', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuits).toBeDefined();
    expect(Array.isArray(data.circuits)).toBe(true);
  });

  it('returns tagList alongside the legacy tags field', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'TagList Shape',
      document: '{}',
      tags: 'alpha, Beta',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    const listRes = await GET(makeReq('http://localhost/api/circuits', 'GET'));
    const data = await listRes.json();
    const found = data.circuits.find((c: any) => c.name === 'TagList Shape');
    expect(found).toBeDefined();
    expect(found.tags).toBe('alpha, Beta'); // legacy field, unchanged
    expect(found.tagList).toEqual(['alpha', 'Beta']); // added field
  });
});

describe('API: POST /api/circuits', () => {
  it('creates a circuit and returns it', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Test Circuit',
      description: 'A test circuit',
      document: '{"version":1,"components":[],"wires":[]}',
      tags: 'test',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.circuit).toBeDefined();
    expect(data.circuit.name).toBe('Test Circuit');
    expect(data.circuit.id).toBeDefined();
  });

  it('accepts document as object (auto-stringifies)', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Object Doc',
      document: { version: 1, components: [{ id: 'R1', type: 'resistor' }] },
      tags: '',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('rejects missing name', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      document: '{}',
      tags: '',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/circuits', {
      method: 'POST',
      body: 'invalid json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('API: GET /api/circuits/[id]', () => {
  it('fetches a circuit by id', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Fetch Me',
      document: '{}',
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'GET');
    const res = await GET_ID(req, { params: Promise.resolve({ id: inserted.id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuit.name).toBe('Fetch Me');
  });

  it('returns 404 for nonexistent id', async () => {
    const req = makeReq('http://localhost/api/circuits/nonexistent', 'GET');
    const res = await GET_ID(req, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(res.status).toBe(404);
  });
});

describe('API: PUT /api/circuits/[id]', () => {
  it('updates a circuit', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Before Update',
      document: '{}',
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'PUT', {
      name: 'After Update',
      tags: 'updated',
    });
    const res = await PUT(req, { params: Promise.resolve({ id: inserted.id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuit.name).toBe('After Update');
    expect(data.circuit.tags).toBe('updated');
  });

  it('returns 404 for nonexistent id', async () => {
    const req = makeReq('http://localhost/api/circuits/nonexistent', 'PUT', {
      name: 'Nope',
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(res.status).toBe(404);
  });
});

describe('API: DELETE /api/circuits/[id]', () => {
  it('deletes a circuit', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Delete Me',
      document: '{}',
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'DELETE');
    const res = await DELETE(req, { params: Promise.resolve({ id: inserted.id }) });
    expect(res.status).toBe(204);
  });
});

describe('API: tag/FTS derived-table sync through the routes', () => {
  it('POST populates circuit_tags and circuits_fts', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Sync Me',
      description: 'synced description',
      document: '{}',
      tags: 'power, supply',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const { circuit } = await res.json();

    const tags = await client.execute({
      sql: 'SELECT tag FROM circuit_tags WHERE circuit_id = ? ORDER BY tag',
      args: [circuit.id],
    });
    expect(tags.rows.map((r) => r.tag)).toEqual(['power', 'supply']);

    const fts = await client.execute({
      sql: 'SELECT name, description, tags FROM circuits_fts WHERE circuit_id = ?',
      args: [circuit.id],
    });
    expect(fts.rows[0]).toMatchObject({
      name: 'Sync Me',
      description: 'synced description',
      tags: 'power, supply',
    });
  });

  it('PUT replaces circuit_tags and re-indexes FTS', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Before Sync Update',
      document: '{}',
      tags: 'old',
      isExample: false,
    });
    const { circuit } = await (await POST(req)).json();

    const putRes = await PUT(
      makeReq(`http://localhost/api/circuits/${circuit.id}`, 'PUT', {
        name: 'After Sync Update',
        tags: 'new, shiny',
      }),
      { params: Promise.resolve({ id: circuit.id }) },
    );
    expect(putRes.status).toBe(200);

    const tags = await client.execute({
      sql: 'SELECT tag FROM circuit_tags WHERE circuit_id = ? ORDER BY tag',
      args: [circuit.id],
    });
    expect(tags.rows.map((r) => r.tag)).toEqual(['new', 'shiny']);

    const fts = await client.execute({
      sql: 'SELECT name, tags FROM circuits_fts WHERE circuit_id = ?',
      args: [circuit.id],
    });
    expect(fts.rows[0]).toMatchObject({ name: 'After Sync Update', tags: 'new, shiny' });
  });

  it('DELETE removes circuit_tags and circuits_fts rows', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Delete Sync',
      document: '{}',
      tags: 'gone',
      isExample: false,
    });
    const { circuit } = await (await POST(req)).json();

    const res = await DELETE(makeReq(`http://localhost/api/circuits/${circuit.id}`, 'DELETE'), {
      params: Promise.resolve({ id: circuit.id }),
    });
    expect(res.status).toBe(204);

    const tags = await client.execute({
      sql: 'SELECT COUNT(*) as n FROM circuit_tags WHERE circuit_id = ?',
      args: [circuit.id],
    });
    const fts = await client.execute({
      sql: 'SELECT COUNT(*) as n FROM circuits_fts WHERE circuit_id = ?',
      args: [circuit.id],
    });
    expect(Number((tags.rows[0] as any).n)).toBe(0);
    expect(Number((fts.rows[0] as any).n)).toBe(0);
  });
});

describe('API: Response shape compatibility', () => {
  it('returns circuit with id, name, description fields', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Shape Test',
      description: 'desc',
      document: '{}',
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'GET');
    const res = await GET_ID(req, { params: Promise.resolve({ id: inserted.id }) });
    const data = await res.json();
    expect(data.circuit.id).toBeDefined();
    expect(data.circuit.name).toBe('Shape Test');
    expect(data.circuit.description).toBe('desc');
    expect(typeof data.circuit.createdAt).toMatch(/^(object|string|number)$/); // Date, string, or number
  });

  it('returns boolean for isExample', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Example Circuit',
      document: '{}',
      isExample: true,
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'GET');
    const res = await GET_ID(req, { params: Promise.resolve({ id: inserted.id }) });
    const data = await res.json();
    expect(typeof data.circuit.isExample).toBe('boolean');
    expect(data.circuit.isExample).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2-c: POST /api/spice/import — client-input problems must be 400s,
// not 500s (bad JSON body, schema failure, parser-rejected netlist).
// ─────────────────────────────────────────────────────────────────────────────

describe('API: POST /api/spice/import', () => {
  it('imports a valid netlist', async () => {
    const { POST } = await import('../src/app/api/spice/import/route');
    const req = new NextRequest('http://localhost/api/spice/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ netlist: 'V1 p 0 DC 5\nR1 p out 1k\nR2 out 0 1k\n.end' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.document.components.length).toBeGreaterThan(0);
  });

  it('returns 400 for an invalid JSON body (was 500)', async () => {
    const { POST } = await import('../src/app/api/spice/import/route');
    const req = new NextRequest('http://localhost/api/spice/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid JSON/);
  });

  it('returns 400 when netlist is missing or not a string', async () => {
    const { POST } = await import('../src/app/api/spice/import/route');
    const req = new NextRequest('http://localhost/api/spice/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ netlist: 123 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when the parser rejects the netlist, with the parser message (was 500)', async () => {
    const { POST } = await import('../src/app/api/spice/import/route');
    const req = new NextRequest('http://localhost/api/spice/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ netlist: 'X1 a b MISSING_SUBCKT' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid netlist: .*subcircuit/i);
  });

  it('returns 415 for a non-JSON content type', async () => {
    const { POST } = await import('../src/app/api/spice/import/route');
    const req = new NextRequest('http://localhost/api/spice/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'V1 p 0 DC 5',
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
  });
});
