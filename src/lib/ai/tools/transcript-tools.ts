// AI transcript export tool — serialize the visible conversation to Markdown.

import type { Tool, ToolContext } from './types';

export const transcriptExportTool: Tool = {
  name: 'transcript.export',
  category: 'AI Diagnosis & Teaching',
  description: 'Export the conversation transcript as Markdown (user + assistant turns with tool-call summaries). Returns the Markdown text for saving/sharing.',
  parameters: {
    type: 'object',
    properties: {
      maxTurns: { type: 'number', description: 'Max recent turns to include (default 50).' },
    },
  },
  execute(args: { maxTurns?: number }, ctx: ToolContext) {
    try {
      // Read the conversation from the turn runner's ToolContext snapshot.
      // The previous implementation lazy-required the CLIENT-side chat-session
      // store — under ESM test runners `require` is undefined (tool returned
      // ok:false), and on the server the store module instance is always
      // empty, so the transcript was dead on both paths.
      const all = Array.isArray(ctx.messages) ? ctx.messages : [];
      const n = Math.max(1, Math.min(200, Math.trunc(args.maxTurns ?? 50)));
      const recent = all.slice(-n * 2);
      const lines: string[] = [`# Circuit Chat Transcript`, '', `_Exported ${new Date().toISOString()}_`, ''];
      if (recent.length === 0) {
        lines.push(`_No conversation turns available yet._`);
        lines.push('');
      }
      for (const m of recent) {
        const calls = m.toolCalls;
        if (!m.content && !(calls && calls.length > 0)) continue; // empty in-progress entry
        lines.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}`);
        lines.push('');
        if (m.content) {
          lines.push(m.content);
          lines.push('');
        }
        if (calls && calls.length > 0) {
          lines.push(`_Tools: ${calls.map((c) => `${c.name}${c.ok ? '' : ' (failed)'}`).join(', ')}_`);
          lines.push('');
        }
      }
      void ctx;
      return { ok: true, result: { markdown: lines.join('\n'), turns: recent.length } };
    } catch (e) {
      return { ok: false, error: `Transcript failed: ${(e as Error).message}` };
    }
  },
};
