import { NextRequest, NextResponse } from 'next/server';
import { desc, eq, sql, like, and } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { savedCircuits } from '@/lib/schema';
import { createCircuitSchema } from '@/lib/validation-schemas';

// GET /api/circuits — list saved circuits with pagination + optional filters.
// Query params: ?cursor=<id>&limit=<n>&search=<text>&tag=<text>&isExample=<bool>
export async function GET(req?: NextRequest) {
  try {
    const url = req?.url ?? 'http://localhost/api/circuits';
    const { searchParams } = new URL(url);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') ?? 50)));
    const search = searchParams.get('search');
    const tag = searchParams.get('tag');
    const isExample = searchParams.get('isExample');

    const conditions: any[] = [];
    if (search) conditions.push(like(savedCircuits.name, `%${search}%`));
    if (tag) conditions.push(like(savedCircuits.tags, `%${tag}%`));
    if (isExample === 'true') conditions.push(eq(savedCircuits.isExample, true));
    if (isExample === 'false') conditions.push(eq(savedCircuits.isExample, false));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const db = await getDb();
    const query = db
      .select({
        id: savedCircuits.id,
        name: savedCircuits.name,
        description: savedCircuits.description,
        tags: savedCircuits.tags,
        isExample: savedCircuits.isExample,
        createdAt: savedCircuits.createdAt,
        updatedAt: savedCircuits.updatedAt,
      })
      .from(savedCircuits)
      .orderBy(desc(savedCircuits.updatedAt))
      .limit(limit + 1); // +1 to check if there are more

    const circuits = where ? await query.where(where) : await query;

    const hasMore = circuits.length > limit;
    const items = hasMore ? circuits.slice(0, limit) : circuits;
    const nextCursor = hasMore ? items[items.length - 1]?.id : null;

    return NextResponse.json({ circuits: items, nextCursor });
  } catch (err) {
    console.error('[API] GET /api/circuits error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/circuits — create a new saved circuit.
export async function POST(req: NextRequest) {
  try {
    // Validate content-type
    const contentType = req.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Validate with Zod
    const parseResult = createCircuitSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parseResult.error.flatten() },
        { status: 400 },
      );
    }

    const data = parseResult.data;

    const db = await getDb();
    const [circuit] = await db
      .insert(savedCircuits)
      .values({
        name: data.name,
        description: data.description,
        document: data.document,
        tags: data.tags,
        isExample: data.isExample,
      })
      .returning();

    return NextResponse.json({ circuit }, { status: 201 });
  } catch (err) {
    console.error('[API] POST /api/circuits error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
