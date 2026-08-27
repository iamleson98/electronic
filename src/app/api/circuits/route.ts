import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createCircuit, listCircuits, withTagList } from '@/lib/circuits-service';
import { createCircuitSchema } from '@/lib/validation-schemas';

// GET /api/circuits — list saved circuits with pagination + optional filters.
// Query params: ?cursor=<id>&limit=<n>&search=<text>&tag=<text>&isExample=<bool>
//
// `tag`   → exact, case-insensitive match against the normalized circuit_tags
//           rows (no more "power" matching "superpower").
// `search`→ FTS5 MATCH over name+description+tags with prefix matching on the
//           last term; falls back to the legacy name LIKE filter if the FTS
//           query fails. See src/lib/circuits-service.ts (listCircuits).
export async function GET(req?: NextRequest) {
  try {
    const url = req?.url ?? 'http://localhost/api/circuits';
    const { searchParams } = new URL(url);
    const limit = Number(searchParams.get('limit') ?? 50);

    const result = await listCircuits(await getDb(), {
      search: searchParams.get('search'),
      tag: searchParams.get('tag'),
      isExample: searchParams.get('isExample'),
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[API] GET /api/circuits error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/circuits — create a new saved circuit.
// The TEXT `tags` column, the normalized `circuit_tags` rows and the
// `circuits_fts` index entry are written atomically (one libsql write batch).
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

    const circuit = await createCircuit(await getDb(), {
      name: data.name,
      description: data.description,
      document: data.document,
      tags: data.tags,
      isExample: data.isExample,
    });

    // `tagList` is an added field; all pre-existing fields are unchanged.
    return NextResponse.json({ circuit: withTagList(circuit) }, { status: 201 });
  } catch (err) {
    console.error('[API] POST /api/circuits error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
