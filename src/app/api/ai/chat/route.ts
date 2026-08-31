// AI Chat API Route — /api/ai/chat
// ─────────────────────────────────────────────────────────────────────────────
// Receives: { messages, circuit (snapshot), pcb? }
// Returns: { response, toolCalls[], circuitChanges, error? }
//
// The AI loop:
//   1. Build a ToolContext from the circuit snapshot
//   2. Call the provider with messages + tools
//   3. If the provider returns tool_calls, execute them against the context
//      and feed the results back as 'tool' messages, then loop (max 8 iterations)
//   4. Return the final assistant message + the updated circuit (so the client
//      can apply the mutations)

import { NextRequest, NextResponse } from 'next/server';
import { getProvider, AIProviderConfigError, type ChatMessage, type ProviderName } from '@/lib/ai/provider';
import { TOOLS_BY_NAME, getToolDefinitions, type ToolContext } from '@/lib/ai/tools';
import type { CircuitDocument, CircuitComponent, Wire } from '@/lib/circuit/types';
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
    components: CircuitComponent[];
    wires: Wire[];
  };
  /** Live simulation context from the client (optional — same fields the stream route accepts). */
  simContext?: {
    nodeVoltage: number[];
    branchCurrent: number[];
    time: number;
    dt: number;
  } | null;
  /** Current simulation error message, if any. */
  simError?: string | null;
  /** Whether the simulation is currently running. */
  simRunning?: boolean;
  /** Currently selected component ID, if any. */
  selectedComponentId?: string | null;
  /** Per-request provider override (chosen from the AI panel dropdown). */
  provider?: ProviderName;
  /** Per-request model override (chosen from the AI panel model dropdown). */
  model?: string;
}

export async function POST(req: NextRequest) {
  // The AI loop can run for minutes and drives paid provider APIs — rate
  // limit per client so it can't be hammered.
  const rl = checkRateLimit(clientIpFromRequest(req));
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many AI requests. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  try {
    const body: RequestBody = await req.json();

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return NextResponse.json({ error: 'messages array is required' }, { status: 400 });
    }

    // Build the tool context from the circuit snapshot
    const doc: CircuitDocument = {
      version: 1,
      components: body.circuit?.components ? JSON.parse(JSON.stringify(body.circuit.components)) : [],
      wires: body.circuit?.wires ? JSON.parse(JSON.stringify(body.circuit.wires)) : [],
    };

    // Build plugins map for the components in the circuit
    const plugins = new Map<string, any>();
    for (const c of doc.components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }

    const ctx: ToolContext = {
      doc,
      plugins,
      simContext: null,
    };

    // Get the AI provider (per-request override if provided)
    const provider = getProvider(body.provider, body.model);
    const toolDefs = getToolDefinitions();

    // Context preamble — the same netlist + operating-point visibility the
    // stream route gives the model (kept in sync via buildContextPreamble).
    const contextPreamble = buildContextPreamble({
      doc,
      simContext: body.simContext ?? null,
      simError: body.simError ?? null,
      simRunning: body.simRunning,
      selectedComponentId: body.selectedComponentId ?? null,
    });

    // Build the message history (prepend the shared system prompt — includes
    // the live component catalog from the plugin registry). Cap the history at
    // the most recent 60 messages so a long session can't grow the prompt
    // without bound and blow the model's context window.
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt() },
      ...(contextPreamble ? [{ role: 'system' as const, content: contextPreamble }] : []),
      ...body.messages.slice(-60),
    ];

    // AI loop: call provider, execute tools, repeat.
    // 50 iterations allows building complex circuits (e.g. a full power
    // supply = 11 components + 18 wires via patterns, or larger via raw calls).
    const executedToolCalls: any[] = [];
    const MAX_ITERATIONS = 50;
    let circuitMutated = false;
    let autoVerifyCount = 0;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // Client disconnected — stop the loop instead of burning provider
      // tokens (and up to 10 min of retry backoff) on a response nobody will
      // receive. Partial results are returned for observability.
      if (req.signal.aborted) {
        return NextResponse.json(
          {
            response: '',
            toolCalls: executedToolCalls,
            circuit: { components: ctx.doc.components, wires: ctx.doc.wires },
            warning: 'Client disconnected',
          },
          { status: 499 },
        );
      }

      const result = await provider.chat(messages, toolDefs, { temperature: 0.4, max_tokens: 8192, signal: req.signal });

      // If the AI wants to call tools, execute them
      if (result.tool_calls && result.tool_calls.length > 0) {
        // Add the assistant message (with tool calls) to history
        messages.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.tool_calls,
        });

        // Execute each tool call
        for (const tc of result.tool_calls) {
          const tool = TOOLS_BY_NAME.get(tc.function.name);
          if (!tool) {
            const errMsg = `Unknown tool: ${tc.function.name}`;
            executedToolCalls.push({ name: tc.function.name, args: tc.function.arguments, error: errMsg });
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
            const errMsg = `Invalid JSON arguments for ${tc.function.name}: ${(e as Error).message}`;
            executedToolCalls.push({ name: tc.function.name, args: tc.function.arguments, error: errMsg });
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
            if (toolResult.ok && MUTATING_TOOL_NAMES.has(tc.function.name)) {
              circuitMutated = true;
              // Keep the plugin map in sync with any newly added component types
              // (the map was built from the initial client snapshot).
              ensurePlugins(ctx);
            }
            executedToolCalls.push({
              name: tc.function.name,
              args,
              result: toolResult.result,
              error: toolResult.error,
              ok: toolResult.ok,
            });
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.function.name,
              content: JSON.stringify(toolResult.ok ? toolResult.result : { error: toolResult.error }),
            });
          } catch (e) {
            const errMsg = `Tool execution error: ${(e as Error).message}`;
            executedToolCalls.push({ name: tc.function.name, args, error: errMsg });
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.function.name,
              content: JSON.stringify({ ok: false, error: errMsg }),
            });
          }
        }

        // Continue the loop to let the AI respond to the tool results
        continue;
      }

      // No tool calls — this is the final response... unless the circuit was
      // mutated and an automatic verification pass finds problems the model
      // should fix before answering (max 2 auto-verify rounds per request).
      if (circuitMutated && autoVerifyCount < 2) {
        const report = runAutoVerify(ctx);
        if (autoVerifyNeedsAttention(report)) {
          autoVerifyCount++;
          messages.push(...(buildAutoVerifyMessages(report, autoVerifyCount) as ChatMessage[]));
          continue;
        }
      }

      return NextResponse.json({
        response: result.content,
        toolCalls: executedToolCalls,
        circuit: {
          components: ctx.doc.components,
          wires: ctx.doc.wires,
        },
        pcb: ctx.pcb ? {
          version: 1,
          board: ctx.pcb.board,
          footprints: ctx.pcb.footprints,
          traces: ctx.pcb.traces,
          vias: ctx.pcb.vias,
          ratsnest: ctx.pcb.ratsnest,
          padNets: Array.from(ctx.pcb.padNets.entries()),
        } : undefined,
        missingComponents: ctx.missingComponents && ctx.missingComponents.size > 0
          ? Array.from(ctx.missingComponents)
          : undefined,
        usage: result.usage,
        provider: provider.name,
        model: provider.model,
      });
    }

    // Ran out of iterations
    return NextResponse.json({
      response: 'I reached the maximum number of tool-call iterations. Here is what I managed to do so far. Please continue with a follow-up message if you need more.',
      toolCalls: executedToolCalls,
      circuit: {
        components: ctx.doc.components,
        wires: ctx.doc.wires,
      },
      missingComponents: ctx.missingComponents && ctx.missingComponents.size > 0
        ? Array.from(ctx.missingComponents)
        : undefined,
      warning: 'Max iterations reached',
    });
  } catch (e) {
    // No AI backend configured (fresh deployment without an API key) — tell
    // the caller exactly what to set instead of an opaque 500.
    if (e instanceof AIProviderConfigError) {
      return NextResponse.json(
        { error: e.message, code: 'AI_NOT_CONFIGURED' },
        { status: 503 },
      );
    }
    // Client went away mid-loop (provider.chat throws on abort) — nothing to
    // deliver; report it as such instead of a misleading 500.
    if (req.signal.aborted) {
      return NextResponse.json({ error: 'Client disconnected' }, { status: 499 });
    }
    console.error('AI chat error:', e);
    return NextResponse.json({
      error: `AI chat failed: ${(e as Error).message}`,
    }, { status: 500 });
  }
}
