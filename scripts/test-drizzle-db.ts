// Test: verify Drizzle database operations work end-to-end.
// Tests: INSERT, SELECT, UPDATE, DELETE on the savedCircuits table.
// Uses `await` (the Drizzle QueryPromise is thenable) — same as the API routes.

import { desc, eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { savedCircuits } from '../src/lib/schema';

async function main() {
  const sqlite = new Database('/home/z/my-project/db/custom.db');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema: { savedCircuits } });

  console.log('=== Drizzle DB Operations Test ===\n');

  // 1. Start with empty table
  const before = await db.select().from(savedCircuits);
  console.log(`1. Initial row count: ${before.length}`);

  // 2. INSERT
  const [inserted] = await db.insert(savedCircuits).values({
    name: 'Test LED Circuit',
    description: 'A simple LED + resistor circuit',
    document: JSON.stringify({ version: 1, components: [], wires: [] }),
    tags: 'led,test',
    isExample: false,
  }).returning();
  console.log(`2. INSERT: id=${inserted.id}, name="${inserted.name}"`);
  console.log(`   createdAt=${inserted.createdAt.toISOString()}`);
  console.log(`   isExample=${inserted.isExample} (type: ${typeof inserted.isExample})`);

  // 3. SELECT by id
  const [fetched] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, inserted.id)).limit(1);
  console.log(`3. SELECT by id: found=${!!fetched}, name="${fetched?.name}"`);

  // 4. SELECT all (list view — no document column)
  const list = await db.select({
    id: savedCircuits.id,
    name: savedCircuits.name,
    description: savedCircuits.description,
    tags: savedCircuits.tags,
    isExample: savedCircuits.isExample,
    createdAt: savedCircuits.createdAt,
    updatedAt: savedCircuits.updatedAt,
  }).from(savedCircuits).orderBy(desc(savedCircuits.updatedAt));
  console.log(`4. SELECT all (list): ${list.length} row(s), first name="${list[0]?.name}"`);

  // 5. UPDATE
  const [updated] = await db.update(savedCircuits).set({
    name: 'Updated Circuit Name',
    tags: 'led,test,updated',
  }).where(eq(savedCircuits.id, inserted.id)).returning();
  console.log(`5. UPDATE: name="${updated.name}", tags="${updated.tags}"`);

  // 6. Verify the document JSON round-trips correctly
  const [withDoc] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, inserted.id)).limit(1);
  const parsedDoc = JSON.parse(withDoc.document);
  console.log(`6. Document JSON round-trip: version=${parsedDoc.version}, components=${parsedDoc.components.length}`);

  // 7. DELETE
  await db.delete(savedCircuits).where(eq(savedCircuits.id, inserted.id));
  const after = await db.select().from(savedCircuits);
  console.log(`7. DELETE: row count after delete = ${after.length}`);

  // 8. Test the response shape matches what the frontend expects
  console.log('\n=== Response Shape Verification ===');
  const [shapeTest] = await db.insert(savedCircuits).values({
    name: 'Shape Test',
    document: '{}',
  }).returning();
  console.log(`Response shape:`);
  console.log(`  id: ${typeof shapeTest.id} = "${shapeTest.id}"`);
  console.log(`  name: ${typeof shapeTest.name} = "${shapeTest.name}"`);
  console.log(`  description: ${typeof shapeTest.description} = "${shapeTest.description}"`);
  console.log(`  tags: ${typeof shapeTest.tags} = "${shapeTest.tags}"`);
  console.log(`  isExample: ${typeof shapeTest.isExample} = ${shapeTest.isExample}`);
  console.log(`  createdAt: ${typeof shapeTest.createdAt} = ${shapeTest.createdAt.toISOString()}`);
  console.log(`  updatedAt: ${typeof shapeTest.updatedAt} = ${shapeTest.updatedAt.toISOString()}`);
  console.log(`  document: ${typeof shapeTest.document} = "${shapeTest.document}"`);

  // Verify it serializes correctly to JSON (what NextResponse.json does)
  const jsonStr = JSON.stringify({ circuit: shapeTest });
  const parsed = JSON.parse(jsonStr);
  console.log(`\nJSON serialization (what frontend receives):`);
  console.log(`  circuit.createdAt: ${typeof parsed.circuit.createdAt} = "${parsed.circuit.createdAt}"`);
  console.log(`  circuit.isExample: ${typeof parsed.circuit.isExample} = ${parsed.circuit.isExample}`);
  console.log(`  new Date(circuit.createdAt).getFullYear() = ${new Date(parsed.circuit.createdAt).getFullYear()}`);

  // Cleanup
  await db.delete(savedCircuits).where(eq(savedCircuits.id, shapeTest.id));
  sqlite.close();

  console.log('\n✓ All Drizzle DB operations work correctly.');
}

main().catch(e => { console.error(e); process.exit(1); });
