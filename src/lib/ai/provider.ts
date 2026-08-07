// AI Provider Abstraction Layer
// ─────────────────────────────────────────────────────────────────────────────
// Supports multiple LLM providers via a unified interface:
//   - Z.ai (GLM-4.6) — default, no API key needed (built into this environment)
//   - OpenAI — set OPENAI_API_KEY in .env
//   - Anthropic — set ANTHROPIC_API_KEY in .env
//
// The provider is selected at runtime via env vars:
//   AI_PROVIDER=zai | openai | anthropic  (default: zai)
//
// All providers expose the same interface: a chat() method that takes
// messages + tools, and returns either a text response or a tool-call request.

export type ProviderName = 'zai' | 'openai' | 'anthropic';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;  // for role: 'tool' messages
  name?: string;           // tool name (for role: 'tool')
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

export interface AIProvider {
  name: ProviderName;
  model: string;
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { temperature?: number; max_tokens?: number },
  ): Promise<ChatResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider factory
// ─────────────────────────────────────────────────────────────────────────────

export function getProvider(): AIProvider {
  const requested = (process.env.AI_PROVIDER || 'zai').toLowerCase() as ProviderName;
  switch (requested) {
    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('AI_PROVIDER=openai but OPENAI_API_KEY is not set. Add it to .env');
      }
      return new OpenAIProvider();
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. Add it to .env');
      }
      return new AnthropicProvider();
    case 'zai':
    default:
      return new ZaiProvider();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Z.ai (GLM-4.6) — OpenAI-compatible API
// ─────────────────────────────────────────────────────────────────────────────

class ZaiProvider implements AIProvider {
  name: ProviderName = 'zai';
  model = 'glm-4.6';

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: { temperature?: number; max_tokens?: number }): Promise<ChatResult> {
    const { default: ZAI } = await import('z-ai-web-dev-sdk');
    const zai = await ZAI.create();

    const body: any = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.4,
      max_tokens: options?.max_tokens ?? 4096,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    // Retry with exponential backoff on 429 (rate limit)
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await zai.chat.completions.create(body);
        const choice = response.choices[0];
        const message = choice.message;

        return {
          content: message.content || '',
          tool_calls: message.tool_calls,
          finish_reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason,
          usage: response.usage ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          } : undefined,
        };
      } catch (e: any) {
        lastError = e;
        // Check if it's a 429 rate-limit error
        const isRateLimit = e?.message?.includes('429') || e?.message?.includes('Too many requests');
        if (!isRateLimit) throw e;
        // Wait before retrying: 2s, 4s, 8s
        const waitMs = 2000 * Math.pow(2, attempt);
        console.warn(`[zai] Rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    throw lastError || new Error('Z.ai request failed after retries');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI provider
// ─────────────────────────────────────────────────────────────────────────────

class OpenAIProvider implements AIProvider {
  name: ProviderName = 'openai';
  model = process.env.OPENAI_MODEL || 'gpt-4o';

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: { temperature?: number; max_tokens?: number }): Promise<ChatResult> {
    const body: any = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.4,
      max_tokens: options?.max_tokens ?? 4096,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const choice = data.choices[0];
    const message = choice.message;

    return {
      content: message.content || '',
      tool_calls: message.tool_calls,
      finish_reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason,
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      } : undefined,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Claude provider — translates OpenAI-style tool calls to Claude's API
// ─────────────────────────────────────────────────────────────────────────────

class AnthropicProvider implements AIProvider {
  name: ProviderName = 'anthropic';
  model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: { temperature?: number; max_tokens?: number }): Promise<ChatResult> {
    // Separate system message from conversation
    const systemMsg = messages.find(m => m.role === 'system');
    const conversationMsgs = messages.filter(m => m.role !== 'system');

    // Convert to Anthropic's format
    // Anthropic uses 'tool_result' blocks instead of 'tool' role messages
    const anthropicMessages: any[] = [];
    for (const msg of conversationMsgs) {
      if (msg.role === 'tool') {
        // Tool result — Anthropic expects this as a 'user' message with tool_result content
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          }],
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // Assistant message with tool calls — Anthropic format
        const content: any[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else {
        anthropicMessages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    const body: any = {
      model: this.model,
      max_tokens: options?.max_tokens ?? 4096,
      temperature: options?.temperature ?? 0.4,
      messages: anthropicMessages,
    };
    if (systemMsg) body.system = systemMsg.content;
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    // Convert Anthropic response back to OpenAI-style format
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const block of data.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : data.stop_reason,
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
    };
  }
}
