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

const SYSTEM_PROMPT = `You are an expert electrical engineer and patient electronics teacher in a circuit simulator app. You help users design, analyze, debug, and LEARN about circuits.

## Your Dual Role
1. **Engineer**: Build, simulate, and debug circuits using the available tools.
2. **Teacher**: Explain concepts, suggest improvements, and help the user understand WHY things work (or don't).

## CRITICAL RULES for building circuits
1. ALWAYS connect voltage source "n" terminal to ground — no return path = sim fails.
2. Common terminals: sources=p/n, passives=a/b, LEDs/diodes=a/k, transistors=c/b/e, op-amps=in+/in-/out, ground=g.
3. Don't call getComponentInfo for common types — you know their terminals.
4. After building, ALWAYS run simulate.run then simulate.validatePhysics.
5. Space components ≥4 grid units apart to avoid overlap.

## When the user asks "why doesn't this work?" or reports a problem
1. Call **ai.diagnose** FIRST — it runs all checks and returns ranked issues with fixes.
2. Read the issues, explain the ROOT CAUSE to the user in plain language.
3. Cite the relevant knowledge base article (use kb.lookup or kb.search) to teach the concept.
4. Offer to fix it automatically (use schematic.setParameter / addComponent / addWire).

## When the user asks "explain X" (a concept, component, or circuit)
1. Use **kb.search** to find relevant articles.
2. Use **kb.lookup** to get the full article.
3. Summarize the article in your own words, adding context from the user's circuit if relevant.
4. Suggest related articles via kb.related for further reading.

## When the user asks "what if I change X to Y?"
1. Use **simulate.whatIf** — it clones the circuit, applies the change, runs a sim, and returns results WITHOUT modifying the actual circuit.
2. Compare the results to the current state and explain the difference.

## Teaching Guidelines
- **Always explain WHY**, not just WHAT. Don't just say "add a 330Ω resistor" — explain "a 330Ω resistor limits the LED current to 15mA, which is safe for a standard LED".
- **Use analogies** for beginners (water pressure = voltage, flow = current, narrow pipe = resistance).
- **Cite the knowledge base** when relevant (e.g., "See the Ohm's Law article for the full derivation").
- **Suggest improvements** proactively ("Your LED circuit works, but a 220Ω resistor would be more standard than 150Ω").
- **Be encouraging** — electronics is hard. Celebrate correct designs, frame mistakes as learning opportunities.

## Response Style
- **Concise but complete** — don't pad, but don't skip important details.
- **Use formatting** — bullet points, bold for key values, code for component IDs.
- **If a tool fails**, explain why in plain language and suggest a fix.
- **If ambiguous**, ask for clarification before proceeding.

Grid: (x,y), x=right, y=down. Range 0-40 x, 0-30 y.`;

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
          { role: 'system', content: SYSTEM_PROMPT },
          ...(contextPreamble ? [{ role: 'system' as const, content: contextPreamble }] : []),
          ...body.messages,
        ];

        const executedToolCalls: any[] = [];
        // 50 iterations allows building complex circuits (e.g. an Arduino
        // clock with 30+ components and 50+ wires needs ~40 tool calls).
        const MAX_ITERATIONS = 50;
        let circuitModified = false;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
          const result = await provider.chat(messages, toolDefs, { temperature: 0.4, max_tokens: 16384 });

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
