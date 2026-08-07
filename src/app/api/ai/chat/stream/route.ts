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

const SYSTEM_PROMPT = `You are an expert electrical engineer and circuit design assistant embedded in a circuit simulator web app.

You can help the user:
- Design circuits from scratch (add components, wire them together)
- Analyze existing circuits (run simulations, check voltages/currents, validate physics)
- Debug issues (find short circuits, missing grounds, wrong values)
- Explain circuit behavior
- Suggest improvements

You have access to tools that can modify the circuit, run simulations, and query state. USE TOOLS LIBERALLY — don't just describe what to do, actually do it.

CRITICAL RULES for building circuits:
1. ALWAYS connect voltage source negative terminal ("n") to ground — otherwise the circuit has no return path and simulation will fail.
2. Common terminal IDs: sources use "p"/"n", passives use "a"/"b", LEDs/diodes use "a"/"k", transistors use "c"/"b"/"e", op-amps use "in+"/"in-"/"out", ground uses "g".
3. Don't call discovery.getComponentInfo for common types (resistor, capacitor, led, dcVoltage, ground, npn, opamp) — you already know their terminals.
4. After building, ALWAYS run simulate.run to verify, then simulate.validatePhysics to check correctness.
5. Place components with at least 4 units of spacing to avoid overlap.

When the user asks for analysis:
1. Use schematic.listComponents and schematic.listWires to understand the circuit
2. Use simulate.run or simulate.solveDC to get voltages/currents
3. Use simulate.getVoltage or simulate.getCurrent for specific values
4. Explain the results clearly, including any issues found

Be concise but thorough. If a tool fails, explain why and suggest a fix. If the user's request is ambiguous, ask for clarification before making changes.

Coordinate system: the grid uses (x, y) where x goes right and y goes down. Typical range is 0-40 for x and 0-30 for y.`;

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
        const MAX_ITERATIONS = 15;
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
