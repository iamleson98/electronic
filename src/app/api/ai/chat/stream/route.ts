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
import { getProvider, AIProviderConfigError, type ChatMessage, type ProviderName } from '@/lib/ai/provider';
import { TOOLS_BY_NAME, getToolDefinitions, type ToolContext } from '@/lib/ai/tools';
import type { CircuitDocument } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';
import { buildSystemPrompt, MUTATING_TOOL_NAMES, runAutoVerify, autoVerifyNeedsAttention, buildAutoVerifyMessages } from '@/lib/ai/system-prompt';
import { buildContextPreamble } from '@/lib/ai/netlist-summary';
import { ensurePlugins } from '@/lib/ai/tools/helpers';
import { checkRateLimit, clientIpFromRequest } from '@/lib/ai/rate-limit';

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

export async function POST(req: NextRequest) {
  // The AI loop can run for minutes and drives paid provider APIs — rate
  // limit per client so it can't be hammered. Must happen BEFORE the stream
  // is created (a 429 has to be a regular JSON response).
  const rl = checkRateLimit(clientIpFromRequest(req));
  if (!rl.ok) {
    return new Response(
      JSON.stringify({ error: 'Too many AI requests. Please wait a moment and try again.' }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfterSec) },
      },
    );
  }

  const encoder = new TextEncoder();
  // Set when the HTTP client disconnects (request aborted or stream
  // cancelled). Once true, no further provider calls are made and all
  // controller writes are skipped — enqueueing into a cancelled stream
  // throws, which used to escalate into an unhandled rejection.
  let clientGone = false;
  const onAbort = () => { clientGone = true; };
  if (req.signal.aborted) clientGone = true;
  else req.signal.addEventListener('abort', onAbort, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          // Stream errored/cancelled (client went away mid-write) — stop
          // writing; the loop checks clientGone and bails.
          clientGone = true;
        }
      };
      const closeStream = () => {
        try {
          controller.close();
        } catch {
          // Already closed or cancelled (client gone) — nothing to do.
        }
      };

      try {
        const body = await req.json();
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
          send('error', { message: 'messages array is required' });
          closeStream();
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
        // the circuit's live state (full netlist + operating point + errors) so
        // it can diagnose "why doesn't this work?" without a single tool call.
        const contextPreamble = buildContextPreamble({
          doc,
          simContext: body.simContext ?? null,
          simError: body.simError ?? null,
          simRunning: body.simRunning,
          selectedComponentId: body.selectedComponentId ?? null,
        });

        const messages: ChatMessage[] = [
          { role: 'system', content: buildSystemPrompt() },
          ...(contextPreamble ? [{ role: 'system' as const, content: contextPreamble }] : []),
          // Cap the history at the most recent 60 messages so a long session
          // can't grow the prompt without bound and blow the context window.
          ...body.messages.slice(-60),
        ];

        const executedToolCalls: any[] = [];
        // 50 iterations allows building complex circuits (e.g. an Arduino
        // clock with 30+ components and 50+ wires needs ~40 tool calls).
        const MAX_ITERATIONS = 50;
        let circuitModified = false;
        let autoVerifyCount = 0;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
          // Client disconnected — stop the loop instead of burning provider
          // tokens (and up to 10 min of retry backoff) writing to nobody.
          if (clientGone || req.signal.aborted) {
            clientGone = true;
            break;
          }

          const result = await provider.chatStream(
            messages,
            toolDefs,
            { temperature: 0.4, max_tokens: 8192, signal: req.signal },
            // Token-level streaming: every text fragment goes straight to the
            // client as a text_delta SSE event (was: one big blob per iteration).
            (delta) => send('text_delta', { text: delta }),
          );

          // If tool calls, execute them. NOTE: any narration text was already
          // streamed token-by-token via the onTextDelta callback — do NOT send
          // result.content again (it would duplicate on the client).
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

          // Final response — already streamed token-by-token via onTextDelta;
          // `done` carries the full assembled text (the client replaces, not
          // appends, so no duplication).
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
          closeStream();
          return;
        }

        // Max iterations reached (or client disconnected mid-loop — still
        // close the stream so the connection doesn't hang open).
        send('done', {
          response: 'I reached the maximum number of tool-call iterations. Here is what I managed to do so far. Please continue with a follow-up message if you need more.',
          toolCalls: executedToolCalls,
          circuit: {
            components: ctx.doc.components,
            wires: ctx.doc.wires,
          },
          warning: clientGone ? 'Client disconnected' : 'Max iterations reached',
        });
        closeStream();
      } catch (e) {
        console.error('AI chat stream error:', e);
        // Configuration problems get their own machine-readable code so the
        // ChatPanel can render actionable setup guidance instead of a scary
        // generic error (typical on a fresh deployment without an API key).
        if (e instanceof AIProviderConfigError) {
          send('error', { code: 'AI_NOT_CONFIGURED', message: e.message });
        } else {
          send('error', { message: `AI chat failed: ${(e as Error).message}` });
        }
        closeStream();
      } finally {
        req.signal.removeEventListener('abort', onAbort);
      }
    },
    // Consumer cancelled the response body (client closed the tab / aborted
    // the fetch) — flip the flag so the in-flight loop stops early.
    cancel() {
      clientGone = true;
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
