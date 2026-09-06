// Shared AI provider type definitions.
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from provider.ts so the SSE accumulator (sse.ts) can consume
// ToolCall without a circular import (provider.ts → sse.ts → provider-types.ts).

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;  // for role: 'tool' messages
  name?: string;           // tool name (for role: 'tool')
  /** Attached images (data URLs) — vision-capable providers receive them as
   *  image_url parts; text-only providers get a "[image attached]" note. */
  images?: string[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export interface ChatResult {
  content: string;            // text response (may be empty if tool_calls present)
  tool_calls?: ToolCall[];    // tool calls the model wants to execute
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
