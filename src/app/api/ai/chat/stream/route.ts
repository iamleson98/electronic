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
import { getProvider, type ChatMessage, type ProviderName } from '@/lib/ai/provider';
import { TOOLS_BY_NAME, getToolDefinitions, type ToolContext } from '@/lib/ai/tools';
import type { CircuitDocument } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';
import { buildSystemPrompt, MUTATING_TOOL_NAMES, runAutoVerify, autoVerifyNeedsAttention, buildAutoVerifyMessages } from '@/lib/ai/system-prompt';
import { ensurePlugins } from '@/lib/ai/tools/helpers';

export const runtime = 'nodejs';
export const maxDuration = 300;  // 5 min — allows for long retry sequences on rate limits

interface RequestBody {
  messages: ChatMessage[];
  circuit?: {
    components: any[];
    wires: any[];
  };
  /** Live simulation context (node voltages, currents, sim time) — lets the AI see circuit state without calling simulate.run first. */
  simContext?: {
    nodeVoltage: number[];
    branchCurrent: number[];
    time: number;
    dt: number;
  } | null;
  /** Current simulation error message (if any) — lets the AI diagnose issues immediately. */
  simError?: string | null;
  /** Whether the simulation is currently running. */
  simRunning?: boolean;
  /** Currently selected component ID (if any) — lets the AI answer "explain this component". */
  selectedComponentId?: string | null;
  /** Per-request provider override (chosen from the AI panel dropdown). */
  provider?: ProviderName;
  /** Per-request model override (chosen from the AI panel model dropdown). */
  model?: string;
}



function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build a system-message preamble that gives the AI immediate visibility into
 * the circuit's live state. This means the AI can answer "why doesn't this
 * work?" without first calling simulate.run — it already knows the error and
 * the current voltages.
 */
function buildContextPreamble(body: RequestBody, doc: CircuitDocument): string | null {
  const parts: string[] = [];

  // Circuit summary
  if (doc.components.length > 0) {
    const compTypes = doc.components.reduce((acc, c) => {
      acc[c.type] = (acc[c.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const summary = Object.entries(compTypes).map(([t, n]) => `${n}× ${t}`).join(', ');
    parts.push(`## Current Circuit\n${doc.components.length} components (${summary}), ${doc.wires.length} wires.`);
  } else {
    parts.push('## Current Circuit\nThe canvas is empty. No components or wires yet.');
  }

  // Simulation state
  if (body.simRunning !== undefined) {
    parts.push(`## Simulation State\nStatus: ${body.simRunning ? 'RUNNING' : 'STOPPED'}.`);
  }
  if (body.simContext) {
    const nodeCount = body.simContext.nodeVoltage.length;
    const nonZeroNodes = body.simContext.nodeVoltage.filter(v => Math.abs(v) > 1e-6).length;
    parts.push(`Sim time: ${(body.simContext.time * 1000).toFixed(2)}ms. ${nodeCount} nodes (${nonZeroNodes} non-zero).`);
  }

  // Simulation error (CRITICAL — this is what lets the AI diagnose immediately)
  if (body.simError) {
    parts.push(`## ⚠️ SIMULATION ERROR\nThe user's simulation is failing with this error:\n"${body.simError}"\nThis is likely the root cause of whatever the user is asking about. Call ai.diagnose to get a full analysis.`);
  }

  // Selected component
  if (body.selectedComponentId) {
    const comp = doc.components.find(c => c.id === body.selectedComponentId);
    if (comp) {
      parts.push(`## Selected Component\nThe user has selected ${comp.id} (${comp.type}) at position (${comp.position.x}, ${comp.position.y}). If they ask "explain this" or "what's wrong with this", they mean this component.`);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
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

        const ctx: ToolContext = {
          doc,
          plugins,
          simContext: body.simContext ? {
            nodeVoltage: Float64Array.from(body.simContext.nodeVoltage),
            branchCurrent: Float64Array.from(body.simContext.branchCurrent),
            state: {},
            time: body.simContext.time,
            dt: body.simContext.dt,
          } : null,
        };
        // Per-request provider override (chosen from the AI panel dropdown).
        const provider = getProvider((body as RequestBody).provider, (body as RequestBody).model);
        const toolDefs = getToolDefinitions();

        // Build a context preamble that gives the AI immediate visibility into
        // the circuit's live state (so it doesn't have to call simulate.run
        // just to see if the circuit is working).
        const contextPreamble = buildContextPreamble(body, doc);

        const messages: ChatMessage[] = [
          { role: 'system', content: buildSystemPrompt() },
          ...(contextPreamble ? [{ role: 'system' as const, content: contextPreamble }] : []),
          ...body.messages,
        ];

        const executedToolCalls: any[] = [];
        // 50 iterations allows building complex circuits (e.g. an Arduino
        // clock with 30+ components and 50+ wires needs ~40 tool calls).
        const MAX_ITERATIONS = 50;
        let circuitModified = false;
        let autoVerifyCount = 0;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
          const result = await provider.chat(messages, toolDefs, { temperature: 0.4, max_tokens: 16384 });

          // If tool calls, execute them (text streamed here narrates the tool use)
          if (result.tool_calls && result.tool_calls.length > 0) {
            if (result.content) {
              send('text_delta', { text: result.content });
            }
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

                // If this was a circuit-mutating tool, mark as modified and
                // keep the plugin map in sync with newly added component types
                // (the map was built from the initial client snapshot).
                if (MUTATING_TOOL_NAMES.has(tc.function.name)) {
                  circuitModified = true;
                  ensurePlugins(ctx);
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

          // No tool calls — final response... unless the circuit was mutated
          // and the automatic verification pass finds problems the model
          // should fix first (max 2 auto-verify rounds per request).
          if (circuitModified && autoVerifyCount < 2) {
            const report = runAutoVerify(ctx);
            if (autoVerifyNeedsAttention(report)) {
              autoVerifyCount++;
              send('verify', {
                attempt: autoVerifyCount,
                health: report.health,
                issueCount: report.issues.length,
                dcConverged: report.dcConverged,
              });
              messages.push(...(buildAutoVerifyMessages(report, autoVerifyCount) as ChatMessage[]));
              continue;
            }
          }

          if (result.content) {
            send('text_delta', { text: result.content });
          }
          send('done', {
            response: result.content,
            toolCalls: executedToolCalls,
            circuit: {
              components: ctx.doc.components,
              wires: ctx.doc.wires,
            },
            provider: provider.name,
            model: provider.model,
            usage: result.usage,
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
