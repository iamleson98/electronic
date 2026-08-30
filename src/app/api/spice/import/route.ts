import { NextRequest, NextResponse } from 'next/server';
import { parseSpiceNetlist } from '@/lib/circuit/spice';
import { spiceImportSchema } from '@/lib/validation-schemas';

// POST /api/spice/import
// Body: { netlist: string }
// Returns: { document: CircuitDocument }
//
// Client-input problems (bad JSON, missing/non-string/oversized netlist, or a
// netlist the parser rejects — e.g. an X card referencing an undefined
// .subckt) are 400s: they are the caller's fault, not server failures.
// 500 is reserved for genuine server-side faults.
export async function POST(req: NextRequest) {
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

  const parseResult = spiceImportSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parseResult.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const document = parseSpiceNetlist(parseResult.data.netlist);
    return NextResponse.json({ document });
  } catch (err) {
    // The parser rejects structurally-broken netlists (unknown subcircuit,
    // bad card syntax, …) — a 400 with the parser's message, not a 500.
    return NextResponse.json({ error: `Invalid netlist: ${(err as Error).message}` }, { status: 400 });
  }
}
