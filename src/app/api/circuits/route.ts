import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/circuits - list all saved circuits
export async function GET() {
  try {
    const circuits = await db.savedCircuit.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        tags: true,
        isExample: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return NextResponse.json({ circuits });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/circuits - create a new saved circuit
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, description, document, tags, isExample } = body;
    if (!name || !document) {
      return NextResponse.json({ error: 'name and document are required' }, { status: 400 });
    }
    const circuit = await db.savedCircuit.create({
      data: {
        name: String(name).slice(0, 200),
        description: String(description ?? '').slice(0, 1000),
        document: typeof document === 'string' ? document : JSON.stringify(document),
        tags: String(tags ?? '').slice(0, 500),
        isExample: !!isExample,
      },
    });
    return NextResponse.json({ circuit });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
