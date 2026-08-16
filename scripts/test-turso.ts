// Test Turso connection and CRUD operations.
// Run with: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... bun scripts/test-turso.ts

import { getDb } from '../src/lib/db';
import { savedCircuits } from '../src/lib/schema';
import { eq } from 'drizzle-orm';

async function main() {
  console.log('=== Turso Connection Test ===');
  console.log('TURSO_DATABASE_URL:', process.env.TURSO_DATABASE_URL ? '(set)' : '(not set)');
  console.log('TURSO_AUTH_TOKEN:', process.env.TURSO_AUTH_TOKEN ? '(set)' : '(not set)');
  console.log('');

  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error('ERROR: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set.');
    process.exit(1);
  }

  try {
    const db = await getDb();
    console.log('✓ Database connection established');

    // 1. INSERT — create a test circuit
    const testId = `test_${Date.now()}`;
    const [inserted] = await db
      .insert(savedCircuits)
      .values({
        id: testId,
        name: 'Turso Test Circuit',
        description: 'Test circuit for Turso CRUD verification',
        document: JSON.stringify({ version: 1, components: [], wires: [] }),
        tags: 'test,turso',
        isExample: false,
      })
      .returning();
    console.log('✓ INSERT: created circuit', inserted.id);

    // 2. SELECT — fetch by id
    const [selected] = await db
      .select()
      .from(savedCircuits)
      .where(eq(savedCircuits.id, testId))
      .limit(1);
    if (!selected) throw new Error('SELECT returned no rows');
    console.log('✓ SELECT: fetched circuit', selected.name);

    // 3. UPDATE — modify the circuit
    const [updated] = await db
      .update(savedCircuits)
      .set({ name: 'Turso Test Circuit (updated)' })
      .where(eq(savedCircuits.id, testId))
      .returning();
    if (!updated) throw new Error('UPDATE returned no rows');
    console.log('✓ UPDATE: renamed to', updated.name);

    // 4. SELECT all — list circuits
    const all = await db.select({ id: savedCircuits.id, name: savedCircuits.name }).from(savedCircuits).limit(10);
    console.log(`✓ SELECT all: ${all.length} circuits found`);

    // 5. DELETE — remove the test circuit
    await db.delete(savedCircuits).where(eq(savedCircuits.id, testId));
    console.log('✓ DELETE: removed test circuit');

    // Verify deletion
    const [afterDelete] = await db
      .select()
      .from(savedCircuits)
      .where(eq(savedCircuits.id, testId))
      .limit(1);
    if (afterDelete) throw new Error('DELETE failed — row still exists');
    console.log('✓ DELETE verified: row no longer exists');

    console.log('\n=== All CRUD operations passed! Turso is ready. ===');
  } catch (e) {
    console.error('\n✗ Test failed:', e);
    process.exit(1);
  }
}

main();
