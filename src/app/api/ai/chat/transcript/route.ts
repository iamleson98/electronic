// AI transcript export API — GET /api/ai/chat/transcript
// Returns the current session transcript as Markdown. The client keeps the
// messages; this route exists for share-link / server-side archival flows and
// accepts an explicit messages payload.

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

interface TranscriptMessage {
  role: string;
  content?: string;
  toolCalls?: { name: string; ok: boolean }[];
  timestamp?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages: TranscriptMessage[] = Array.isArray(body.messages) ? body.messages : [];
    const lines: string[] = ['# Circuit Chat Transcript', '', `_Exported ${new Date().toISOString()}_`, ''];
    for (const m of messages.slice(-200)) {
      lines.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}`);
      lines.push('');
      lines.push(m.content || '(no text)');
      lines.push('');
      if (m.toolCalls && m.toolCalls.length > 0) {
        lines.push(`_Tools: ${m.toolCalls.map((c) => `${c.name}${c.ok ? '' : ' (failed)'}`).join(', ')}_`);
        lines.push('');
      }
    }
    return NextResponse.json({ markdown: lines.join('\n'), turns: Math.min(messages.length, 200) });
  } catch (e) {
    return NextResponse.json({ error: `Transcript failed: ${(e as Error).message}` }, { status: 500 });
  }
}
