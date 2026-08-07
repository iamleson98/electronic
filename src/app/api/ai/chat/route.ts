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
import { getProvider, type ChatMessage, type ToolCall } from '@/lib/ai/provider';
import { TOOLS_BY_NAME, getToolDefinitions, type ToolContext } from '@/lib/ai/tools';
import type { CircuitDocument, CircuitComponent, Wire } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface RequestBody {
  messages: ChatMessage[];
  circuit?: {
    components: CircuitComponent[];
    wires: Wire[];
  };
}

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

Always be concise but thorough. If a tool fails, explain why and suggest a fix. If the user's request is ambiguous, ask for clarification before making changes.

Coordinate system: the grid uses (x, y) where x goes right and y goes down. Typical range is 0-40 for x and 0-30 for y.`;

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

    // Get the AI provider
    const provider = getProvider();
    const toolDefs = getToolDefinitions();

    // Build the message history (prepend system prompt)
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...body.messages,
    ];

    // AI loop: call provider, execute tools, repeat
    const executedToolCalls: any[] = [];
    const MAX_ITERATIONS = 15;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const result = await provider.chat(messages, toolDefs, { temperature: 0.4, max_tokens: 4096 });

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

      // No tool calls — this is the final response
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
