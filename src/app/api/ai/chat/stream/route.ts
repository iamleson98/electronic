// AI Chat Streaming API Route — /api/ai/chat/stream
// ─────────────────────────────────────────────────────────────────────────────
// Server-Sent Events (SSE) endpoint that streams the AI response incrementally.
//
// Event types:
//   - text_delta: { text: string }              — partial AI text response
//   - tool_call: { name, args, result, ok }     — a tool was executed
//   - circuit_update: { components, wires }     — the circuit was mutated
//   - done: { response, toolCalls, circuit }     — final result
//   - error: { message }                          — error occurred

import { NextRequest } from 'next/server';
import { getProvider, type ChatMessage } from '@/lib/ai/provider';
import { TOOLS_BY_NAME, getToolDefinitions, type ToolContext } from '@/lib/ai/tools';
import type { CircuitDocument } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';

export const runtime = 'nodejs';
export const maxDuration = 120;

const SYSTEM_PROMPT = `You are an expert electrical engineer and circuit design assistant in a circuit simulator app. You help users design, analyze, and debug circuits using the available tools.

CRITICAL RULES for building circuits:
1. ALWAYS connect voltage source "n" terminal to ground — no return path = sim fails.
2. Common terminals: sources=p/n, passives=a/b, LEDs/diodes=a/k, transistors=c/b/e, op-amps=in+/in-/out, ground=g.
3. Don't call getComponentInfo for common types — you know their terminals.
4. After building, ALWAYS run simulate.run then simulate.validatePhysics.
5. Space components ≥4 grid units apart to avoid overlap.

Be concise. If a tool fails, explain why and suggest a fix. If ambiguous, ask for clarification.

Grid: (x,y), x=right, y=down. Range 0-40 x, 0-30 y.`;

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      try {
        const body = await req.json();
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
          send('error', { message: 'messages array is required' });
          controller.close();
          return;
        }

        // Build the tool context from the circuit snapshot
        const doc: CircuitDocument = {
          version: 1,
          components: body.circuit?.components ? JSON.parse(JSON.stringify(body.circuit.components)) : [],
          wires: body.circuit?.wires ? JSON.parse(JSON.stringify(body.circuit.wires)) : [],
        };

        const plugins = new Map<string, any>();
        for (const c of doc.components) {
          const p = getPlugin(c.type);
          if (p) plugins.set(c.type, p);
        }

        const ctx: ToolContext = { doc, plugins, simContext: null };
        const provider = getProvider();
        const toolDefs = getToolDefinitions();

        const messages: ChatMessage[] = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...body.messages,
        ];

        const executedToolCalls: any[] = [];
        const MAX_ITERATIONS = 10;
        let circuitModified = false;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
          const result = await provider.chat(messages, toolDefs, { temperature: 0.4, max_tokens: 4096 });

          // Stream any text content
          if (result.content) {
            send('text_delta', { text: result.content });
          }

          // If tool calls, execute them
          if (result.tool_calls && result.tool_calls.length > 0) {
            messages.push({
              role: 'assistant',
              content: result.content,
              tool_calls: result.tool_calls,
            });

            for (const tc of result.tool_calls) {
              const tool = TOOLS_BY_NAME.get(tc.function.name);
              if (!tool) {
                const errMsg = `Unknown tool: ${tc.function.name}`;
                executedToolCalls.push({ name: tc.function.name, args: tc.function.arguments, error: errMsg, ok: false });
                send('tool_call', { name: tc.function.name, args: tc.function.arguments, error: errMsg, ok: false });
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.function.name,
                  content: JSON.stringify({ ok: false, error: errMsg }),
                });
                continue;
              }

              let args: any;
              try {
                args = JSON.parse(tc.function.arguments);
              } catch (e) {
                const errMsg = `Invalid JSON arguments: ${(e as Error).message}`;
                executedToolCalls.push({ name: tc.function.name, args: tc.function.arguments, error: errMsg, ok: false });
                send('tool_call', { name: tc.function.name, args: tc.function.arguments, error: errMsg, ok: false });
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.function.name,
                  content: JSON.stringify({ ok: false, error: errMsg }),
                });
                continue;
              }

              try {
                const toolResult = await tool.execute(args, ctx);
                executedToolCalls.push({
                  name: tc.function.name,
                  args,
                  result: toolResult.result,
                  error: toolResult.error,
                  ok: toolResult.ok,
                });

                // Send tool call event to client
                send('tool_call', {
                  name: tc.function.name,
                  args,
                  result: toolResult.result,
                  error: toolResult.error,
                  ok: toolResult.ok,
                });

                // If this was a circuit-mutating tool, mark as modified
                const mutators = [
                  'schematic.addComponent', 'schematic.removeComponent', 'schematic.moveComponent',
                  'schematic.rotateComponent', 'schematic.setParameter', 'schematic.addWire',
                  'schematic.removeWire', 'schematic.clear', 'schematic.reannotate',
                  'schematic.loadDocument', 'examples.load',
                ];
                if (mutators.includes(tc.function.name)) {
                  circuitModified = true;
                }

                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.function.name,
                  content: JSON.stringify(toolResult.ok ? toolResult.result : { error: toolResult.error }),
                });
              } catch (e) {
                const errMsg = `Tool execution error: ${(e as Error).message}`;
                executedToolCalls.push({ name: tc.function.name, args, error: errMsg, ok: false });
                send('tool_call', { name: tc.function.name, args, error: errMsg, ok: false });
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.function.name,
                  content: JSON.stringify({ ok: false, error: errMsg }),
                });
              }
            }

            // Send circuit update if modified
            if (circuitModified) {
              send('circuit_update', {
                components: ctx.doc.components,
                wires: ctx.doc.wires,
              });
            }
            continue;
          }

          // No tool calls — final response
          send('done', {
            response: result.content,
            toolCalls: executedToolCalls,
            circuit: {
              components: ctx.doc.components,
              wires: ctx.doc.wires,
            },
            provider: provider.name,
            model: provider.model,
          });
          controller.close();
          return;
        }

        // Max iterations reached
        send('done', {
          response: 'I reached the maximum number of tool-call iterations. Here is what I managed to do so far. Please continue with a follow-up message if you need more.',
          toolCalls: executedToolCalls,
          circuit: {
            components: ctx.doc.components,
            wires: ctx.doc.wires,
          },
          warning: 'Max iterations reached',
        });
        controller.close();
      } catch (e) {
        console.error('AI chat stream error:', e);
        send('error', { message: `AI chat failed: ${(e as Error).message}` });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
