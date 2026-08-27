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
import { getProvider, type ChatMessage, type ProviderName } from '@/lib/ai/provider';
import { TOOLS_BY_NAME, getToolDefinitions, type ToolContext } from '@/lib/ai/tools';
import type { CircuitDocument, CircuitComponent, Wire } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';
import { buildSystemPrompt, MUTATING_TOOL_NAMES, runAutoVerify, autoVerifyNeedsAttention, buildAutoVerifyMessages } from '@/lib/ai/system-prompt';
import { ensurePlugins } from '@/lib/ai/tools/helpers';

export const runtime = 'nodejs';
export const maxDuration = 300;  // 5 min — allows for long retry sequences on rate limits

interface RequestBody {
  messages: ChatMessage[];
  circuit?: {
    components: CircuitComponent[];
    wires: Wire[];
  };
  /** Per-request provider override (chosen from the AI panel dropdown). */
  provider?: ProviderName;
  /** Per-request model override (chosen from the AI panel model dropdown). */
  model?: string;
}

export async function POST(req: NextRequest) {
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

    // Build the message history (prepend the shared system prompt — includes
    // the live component catalog from the plugin registry)
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt() },
      ...body.messages,
    ];

    // AI loop: call provider, execute tools, repeat.
    // 50 iterations allows building complex circuits (e.g. a full power
    // supply = 11 components + 18 wires via patterns, or larger via raw calls).
    const executedToolCalls: any[] = [];
    const MAX_ITERATIONS = 50;
    let circuitMutated = false;
    let autoVerifyCount = 0;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const result = await provider.chat(messages, toolDefs, { temperature: 0.4, max_tokens: 16384 });

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
      warning: 'Max iterations reached',
    });
  } catch (e) {
    console.error('AI chat error:', e);
    return NextResponse.json({
      error: `AI chat failed: ${(e as Error).message}`,
    }, { status: 500 });
  }
}
