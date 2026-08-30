// AI Provider Abstraction Layer
// ─────────────────────────────────────────────────────────────────────────────
// Supports multiple LLM providers via a unified interface:
//   - Z.ai (GLM-4.6) — default, no API key needed (built into this environment)
//   - OpenAI — set OPENAI_API_KEY in .env
//   - Anthropic — set ANTHROPIC_API_KEY in .env
//
// Provider + model selection (in priority order):
//   1. Per-request override — caller passes `provider` + `model` to getProvider()
//      (e.g., user picks a different model in the ChatPanel dropdown)
//   2. AI_PROVIDER / OPENAI_MODEL / ANTHROPIC_MODEL env vars — server-side defaults
//   3. 'zai' / 'glm-4.6' — built-in fallback (no API key required)
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
    options?: { temperature?: number; max_tokens?: number; signal?: AbortSignal },
  ): Promise<ChatResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Available models per provider — curated list of top free / low-cost models.
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  label: string;
  description: string;
  free: boolean;
}

export const AVAILABLE_MODELS: Record<ProviderName, ModelInfo[]> = {
  zai: [
    { id: 'glm-4.6', label: 'GLM-4.6 (Default, Free)', description: 'Z.ai built-in model. No API key needed.', free: true },
    { id: 'glm-4.5', label: 'GLM-4.5 (Free)', description: 'Previous generation Z.ai model.', free: true },
    { id: 'glm-4-flash', label: 'GLM-4 Flash (Free, Fast)', description: 'Lighter model for fast responses.', free: true },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini (Cheapest)', description: 'Fast and affordable. Best for most tasks.', free: false },
    { id: 'gpt-4o', label: 'GPT-4o', description: 'Most capable OpenAI model.', free: false },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano (Cheapest)', description: 'Smallest GPT-4.1 variant.', free: false },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Balanced cost/performance.', free: false },
  ],
  anthropic: [
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Fastest)', description: 'Fast and affordable Claude.', free: false },
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', description: 'Most capable Claude model.', free: false },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp max_tokens to the model's output limit. The Anthropic API returns a
 * 400 invalid_request_error when max_tokens exceeds the model's cap, so an
 * unclamped 16384 default would fail EVERY request on claude-3-* models.
 */
export function clampAnthropicMaxTokens(model: string, requested: number): number {
  // Claude 3.5 family caps at 8192 output tokens; Claude 3 (opus/sonnet) at 4096.
  const cap = model.includes('3-5') || model.includes('3.5') ? 8192 : 4096;
  return Math.max(1, Math.min(requested, cap));
}

/** Map Anthropic stop_reason values onto the OpenAI-style finish_reason union. */
function mapAnthropicStopReason(reason: string | undefined): 'stop' | 'length' | 'content_filter' {
  switch (reason) {
    case 'max_tokens': return 'length';
    case 'refusal': return 'content_filter';
    default: return 'stop';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a provider. Priority:
 *   1. Explicit `requested` argument (per-request override from the UI)
 *   2. AI_PROVIDER env var (server-side default)
 *   3. 'zai' (built-in fallback)
 *
 * The `model` parameter overrides the provider's default model.
 */
export function getProvider(requested?: ProviderName, model?: string): AIProvider {
  const name = (requested || process.env.AI_PROVIDER || 'zai').toLowerCase() as ProviderName;
  switch (name) {
    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        if (requested) {
          throw new Error(
            'OpenAI provider selected but OPENAI_API_KEY is not set. ' +
            'Add it to your .env file or choose a different provider in the AI panel.',
          );
        }
        return new ZaiProvider(model);
      }
      return new OpenAIProvider(model);
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY) {
        if (requested) {
          throw new Error(
            'Anthropic provider selected but ANTHROPIC_API_KEY is not set. ' +
            'Add it to your .env file or choose a different provider in the AI panel.',
          );
        }
        return new ZaiProvider(model);
      }
      return new AnthropicProvider(model);
    case 'zai':
    default:
      return new ZaiProvider(model);
  }
}

/** Returns the list of providers available given the current env. */
export function getAvailableProviders(): Array<{ name: ProviderName; label: string; available: boolean; requiresKey: string | null; model: string; models: ModelInfo[] }> {
  return [
    {
      name: 'zai',
      label: 'Z.ai (GLM)',
      available: true,
      requiresKey: null,
      model: 'glm-4.6',
      models: AVAILABLE_MODELS.zai,
    },
    {
      name: 'openai',
      label: 'OpenAI (GPT)',
      available: !!process.env.OPENAI_API_KEY,
      requiresKey: 'OPENAI_API_KEY',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      models: AVAILABLE_MODELS.openai,
    },
    {
      name: 'anthropic',
      label: 'Anthropic (Claude)',
      available: !!process.env.ANTHROPIC_API_KEY,
      requiresKey: 'ANTHROPIC_API_KEY',
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022',
      models: AVAILABLE_MODELS.anthropic,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Z.ai (GLM-4.6) — OpenAI-compatible API
// ─────────────────────────────────────────────────────────────────────────────

class ZaiProvider implements AIProvider {
  name: ProviderName = 'zai';
  model: string;

  constructor(model?: string) {
    this.model = model || 'glm-4.6';
  }

  /**
   * Create a ZAI SDK instance.
   *
   * On the local dev environment, /etc/.z-ai-config exists and ZAI.create()
   * reads it automatically.
   *
   * On Vercel (or any environment where the config file is missing), we
   * bypass the file and construct the instance directly from the ZAI_CONFIG
   * env var (a JSON string with baseUrl, apiKey, token, userId, chatId).
   */
  private async createZAI(): Promise<any> {
    const { default: ZAI } = await import('z-ai-web-dev-sdk');
    try {
      // Try the normal file-based config first (works locally)
      return await ZAI.create();
    } catch {
      // File not found — construct from env var (Vercel deployment)
      const configJson = process.env.ZAI_CONFIG;
      if (!configJson) {
        throw new Error(
          'Z.ai config file not found and ZAI_CONFIG env var not set. ' +
          'On Vercel: set ZAI_CONFIG to the JSON config from /etc/.z-ai-config. ' +
          'Locally: ensure /etc/.z-ai-config exists.'
        );
      }
      const config = JSON.parse(configJson);
      // The constructor is private in the type declarations but works at runtime.
      // We cast to any to bypass the TypeScript private check — this is the only
      // way to initialize the SDK without a config file on Vercel.
      return new (ZAI as any)(config);
    }
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: { temperature?: number; max_tokens?: number; signal?: AbortSignal }): Promise<ChatResult> {
    const zai = await this.createZAI();
    const signal = options?.signal;

    const body: any = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.4,
      // Default to 16K tokens — complex circuits with many components/wires
      // can produce very long tool-call sequences. GLM-4.6 supports up to 16K
      // output tokens. The API caps at the model's actual limit.
      max_tokens: options?.max_tokens ?? 16384,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    // Retry indefinitely on rate-limit (429) and server errors (5xx).
    // The AI feature should NEVER fail due to rate limiting — it just keeps
    // retrying with backoff until the request succeeds. We cap at 20 attempts
    // (max ~10 minutes total) as a safety net against infinite loops, but
    // in practice the rate limit always clears within 1-2 minutes.
    //
    // Backoff schedule: 2s, 4s, 8s, 15s, 30s, then 30s for all subsequent attempts.
    const backoffSchedule = [2000, 4000, 8000, 15000, 30000];
    const MAX_ATTEMPTS = 20;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // The caller (API route) aborts this signal when the HTTP client
      // disconnects — stop retrying instead of burning the provider for
      // another ~10 minutes with nobody listening.
      if (signal?.aborted) {
        throw new Error('Z.ai request aborted (client disconnected)');
      }
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
        const msg = String(e?.message || e);
        // Rate-limit (429) and transient server errors (5xx) are retryable.
        // Everything else (400 Bad Request, 401 Unauthorized, etc.) fails immediately.
        const isRateLimit = msg.includes('429') || msg.includes('Too many requests') || msg.includes('rate limit');
        const isServerError = msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('Bad Gateway') || msg.includes('Service Unavailable') || msg.includes('Internal Server Error') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('socket hang up');

        if (!isRateLimit && !isServerError) {
          // Non-retryable error — throw immediately
          throw e;
        }

        // Calculate wait time: use the backoff schedule, then 30s for all later attempts
        const waitMs = attempt < backoffSchedule.length ? backoffSchedule[attempt] : 30000;
        const errorType = isRateLimit ? 'Rate limited' : 'Server error';
        console.warn(`[zai] ${errorType}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise<void>((resolve) => {
          // Wake early on abort so the loop-exit check above fires immediately
          const onAbort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, waitMs);
          if (signal) {
            if (signal.aborted) { clearTimeout(timer); resolve(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
    }

    // Exhausted all 20 attempts — this should be extremely rare (10+ minutes of retries)
    throw lastError || new Error('Z.ai request failed after 20 retry attempts');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI provider
// ─────────────────────────────────────────────────────────────────────────────

class OpenAIProvider implements AIProvider {
  name: ProviderName = 'openai';
  model: string;

  constructor(model?: string) {
    this.model = model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: { temperature?: number; max_tokens?: number; signal?: AbortSignal }): Promise<ChatResult> {
    const body: any = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.4,
      max_tokens: options?.max_tokens ?? 16384,
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
      signal: options?.signal,
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
  model: string;

  constructor(model?: string) {
    this.model = model || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: { temperature?: number; max_tokens?: number; signal?: AbortSignal }): Promise<ChatResult> {
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
          // Models occasionally emit empty/malformed argument strings; a throw
          // here would kill the whole request instead of degrading one call.
          let input: any = {};
          try {
            input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            input = {};
          }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
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
      // Per-model output caps — the API rejects max_tokens above the model's
      // limit with a 400 (claude-3-* families cap at 4096–8192), which would
      // fail EVERY request. Clamp to the per-family maximum.
      max_tokens: clampAnthropicMaxTokens(this.model, options?.max_tokens ?? 8192),
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
      signal: options?.signal,
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
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : mapAnthropicStopReason(data.stop_reason),
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
    };
  }
}
