// SSE (Server-Sent Events) parsing utilities for streaming LLM responses.
// ─────────────────────────────────────────────────────────────────────────────
// Works with any OpenAI-compatible streaming endpoint (Z.ai public API,
// Z.ai sandbox gateway, OpenAI, Groq, DeepSeek, OpenRouter, …) which all
// emit `data: {json}\n\n` chunks terminated by `data: [DONE]`.
//
// Two layers:
//   1. parseSseStream()  — byte Reader → per-event JSON objects (robust to
//      partial network chunks, CRLF line endings, multi-line `data:` fields)
//   2. OpenAiDeltaAccumulator — streams of `choices[0].delta` fragments → a
//      complete ChatResult (concatenated content + reassembled tool calls)
//
// Used by the provider layer to give the AI Assistant panel token-level
// streaming instead of waiting for the full completion.

import type { ToolCall } from './provider';

/** One parsed SSE event: the decoded JSON payload (or raw string if not JSON). */
export interface SseEvent {
  /** Raw `data:` payload (joined when the event spans multiple data lines). */
  data: string;
  /** Parsed JSON — undefined when the payload was not valid JSON. */
  json: any;
  /** The `event:` field, if the server sent one. */
  event?: string;
}

/**
 * Read a byte stream and yield complete SSE events.
 *
 * Handles:
 *  - events split across arbitrary network chunk boundaries
 *  - `\r\n` as well as `\n` line endings
 *  - multi-line `data:` fields (concatenated with `\n` per the SSE spec)
 *  - comment lines starting with `:` (keep-alive heartbeats)
 */
export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const flush = function* (): Generator<SseEvent> {
    if (dataLines.length > 0) {
      const data = dataLines.join('\n');
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        json = undefined;
      }
      yield { data, json, event: eventName };
    }
    dataLines = [];
    eventName = undefined;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process every complete line currently in the buffer.
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      // Strip a trailing CR from CRLF endings.
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        // Blank line = end of event dispatch.
        yield* flush();
      } else if (line.startsWith(':')) {
        // Comment / keep-alive — ignore.
      } else if (line.startsWith('data:')) {
        let payload = line.slice(5);
        if (payload.startsWith(' ')) payload = payload.slice(1);
        dataLines.push(payload);
      } else if (line.startsWith('event:')) {
        let payload = line.slice(6);
        if (payload.startsWith(' ')) payload = payload.slice(1);
        eventName = payload;
      }
      // Unknown fields (id:, retry:) are ignored.
    }
  }
  // Flush any trailing event that wasn't terminated by a blank line.
  buffer += decoder.decode();
  if (buffer.trim().startsWith('data:')) {
    dataLines.push(buffer.trim().slice(5).replace(/^ /, ''));
  }
  yield* flush();
}

/**
 * Accumulates OpenAI-style streaming deltas into a complete chat result.
 *
 * A single streamed response may contain any mix of:
 *   - `delta.content` fragments (text tokens) → concatenated, each passed to
 *     onTextDelta as it arrives
 *   - `delta.tool_calls[{index,id,function:{name,arguments}}]` fragments →
 *     reassembled by index; `arguments` strings concatenate across fragments
 *   - `delta.reasoning_content` → captured separately (not surfaced as answer
 *     text) so thinking models don't pollute the visible reply
 *   - `finish_reason` on the final chunk
 *   - `usage` (some providers attach it to the final chunk)
 */
export class OpenAiDeltaAccumulator {
  private content = '';
  private reasoning = '';
  private toolCalls: Array<ToolCall | undefined> = [];
  private finishReason: string | undefined;
  private usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

  /** Feed one parsed SSE JSON chunk. Returns true if it produced visible text. */
  consume(chunk: any): boolean {
    if (!chunk || typeof chunk !== 'object') return false;

    if (chunk.usage && typeof chunk.usage === 'object') {
      this.usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return false;

    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta || typeof delta !== 'object') return false;

    let producedText = false;
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.content += delta.content;
      producedText = true;
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      this.reasoning += delta.reasoning_content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const frag of delta.tool_calls) {
        const idx = typeof frag.index === 'number' ? frag.index : this.toolCalls.length;
        let tc = this.toolCalls[idx];
        if (!tc) {
          tc = {
            id: frag.id ?? `call_${idx}`,
            type: 'function',
            function: { name: '', arguments: '' },
          };
          this.toolCalls[idx] = tc;
        }
        if (frag.id) tc.id = frag.id;
        if (frag.function?.name) {
          // Some providers stream the name in fragments too — append safely.
          if (tc.function.name && !frag.function.name.startsWith(tc.function.name)) {
            tc.function.name += frag.function.name;
          } else {
            tc.function.name = frag.function.name;
          }
        }
        if (typeof frag.function?.arguments === 'string') {
          tc.function.arguments += frag.function.arguments;
        }
      }
    }
    return producedText;
  }

  /** True when the model requested at least one complete-looking tool call. */
  hasToolCalls(): boolean {
    return this.toolCalls.some(tc => tc !== undefined && tc.function.name !== '');
  }

  getToolCalls(): ToolCall[] | undefined {
    const calls = this.toolCalls.filter((tc): tc is ToolCall => tc !== undefined && tc.function.name !== '');
    return calls.length > 0 ? calls : undefined;
  }

  getContent(): string {
    return this.content;
  }

  getFinishReason(): 'stop' | 'tool_calls' | 'length' | 'content_filter' {
    if (this.hasToolCalls()) return 'tool_calls';
    switch (this.finishReason) {
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  getUsage() {
    return this.usage;
  }
}

/**
 * Convenience: drive a byte-Reader SSE stream of OpenAI chunks through the
 * accumulator, invoking `onTextDelta` for each visible text fragment.
 * Returns the fully-assembled result. Throws on stream read errors — callers
 * apply their own retry/error policy.
 */
export async function accumulateOpenAiStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onTextDelta?: (text: string) => void,
): Promise<{ content: string; tool_calls?: ToolCall[]; finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'; usage?: any }> {
  const acc = new OpenAiDeltaAccumulator();
  for await (const ev of parseSseStream(reader)) {
    if (ev.data === '[DONE]') break;
    if (ev.json === undefined) continue; // keep-alive or malformed line — skip
    const producedText = acc.consume(ev.json);
    if (producedText && onTextDelta) {
      // Re-extract just the fragment added by this chunk — cheaper than
      // threading the fragment out of consume(); the delta text equals the
      // new tail of the accumulated content.
      const chunk = ev.json.choices?.[0]?.delta?.content;
      if (typeof chunk === 'string' && chunk.length > 0) onTextDelta(chunk);
    }
  }
  return {
    content: acc.getContent(),
    tool_calls: acc.getToolCalls(),
    finish_reason: acc.getFinishReason(),
    usage: acc.getUsage(),
  };
}
