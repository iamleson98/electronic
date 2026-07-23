import { NextRequest, NextResponse } from 'next/server';
import { parseSpiceNetlist } from '@/lib/circuit/spice';

// POST /api/spice/import
// Body: { netlist: string, name?: string, save?: boolean }
// Returns: { document: CircuitDocument, savedCircuit?: SavedCircuit }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { netlist } = body;
    if (!netlist || typeof netlist !== 'string') {
      return NextResponse.json({ error: 'netlist (string) is required' }, { status: 400 });
    }
    const document = parseSpiceNetlist(netlist);
    return NextResponse.json({ document });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
