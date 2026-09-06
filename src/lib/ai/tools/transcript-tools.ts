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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const session = require('@/lib/ai/chat-session') as typeof import('@/lib/ai/chat-session');
      const messages = session.useChatSession.getState().messages;
      const n = Math.max(1, Math.min(200, Math.trunc(args.maxTurns ?? 50)));
      const recent = messages.slice(-n * 2);
      const lines: string[] = [`# Circuit Chat Transcript`, '', `_Exported ${new Date().toISOString()}_`, ''];
      for (const m of recent) {
        lines.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}`);
        lines.push('');
        lines.push(m.content || '(no text)');
        lines.push('');
        const calls = (m as { toolCalls?: { name: string; ok: boolean }[] }).toolCalls;
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
