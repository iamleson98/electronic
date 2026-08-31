// AI Provider Abstraction Layer
// ─────────────────────────────────────────────────────────────────────────────
// Supports multiple LLM providers via a unified interface:
//   - Z.ai (GLM-4.6) — two mutually-exclusive modes:
//       • "api-key"  : ZAI_API_KEY env var → calls the PUBLIC OpenAI-compatible
//                       endpoint (https://api.z.ai/api/paas/v4). Works from ANY
//                       deployment (Vercel/Netlify/Docker/any domain) because the
//                       call is server-to-server — browsers/CORS are never involved.
//       • "sandbox"  : no API key, but the Z.ai sandbox config exists
//                       (/etc/.z-ai-config, ~/.z-ai-config, ./.z-ai-config, or the
//                       ZAI_CONFIG env var) → uses z-ai-web-dev-sdk against the
//                       sandbox-internal gateway. This is the zero-config default
//                       inside the Z.ai coding sandbox.
//   - OpenAI — set OPENAI_API_KEY in .env
//   - Anthropic — set ANTHROPIC_API_KEY in .env
//
// Provider + model selection (in priority order):
//   1. Per-request override — caller passes `provider` + `model` to getProvider()
//      (e.g., user picks a different model in the ChatPanel dropdown)
//   2. AI_PROVIDER / ZAI_MODEL / OPENAI_MODEL / ANTHROPIC_MODEL env vars
//   3. 'zai' / 'glm-4.6' — built-in fallback
//
// All providers expose the same interface:
//   chat()       — one-shot completion (text and/or tool calls)
//   chatStream() — token-level streaming variant; invokes onTextDelta as
//                  fragments arrive and resolves to the same ChatResult shape
//                  (falls back to chat() for providers without SSE support).

import fsSync from 'fs';
import path from 'path';
import os from 'os';
import type { ToolCall, ChatMessage, ToolDefinition, ChatResult } from './provider-types';
import { accumulateOpenAiStream } from './sse';

export type { ToolCall, ToolDefinition, ChatMessage, ChatResult } from './provider-types';

export type ProviderName = 'zai' | 'openai' | 'anthropic';

export interface AIProvider {
  name: ProviderName;
  model: string;
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ProviderCallOptions,
  ): Promise<ChatResult>;
  /**
   * Streaming variant of chat(). Calls `onTextDelta(text)` as tokens arrive
   * (server-sent events), then resolves with the assembled full result —
   * identical semantics to chat(), so the tool-calling loop in the API routes
   * works unchanged. Default implementations fall back to a single delta.
   */
  chatStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ProviderCallOptions,
    onTextDelta?: (text: string) => void,
  ): Promise<ChatResult>;
}

/** Options shared by every provider call. */
export interface ProviderCallOptions {
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  /**
   * Invoked BEFORE each provider-level retry sleep so the caller can surface
   * "rate-limited, retrying in Ns" to the end user — without this the retries
   * are invisible for up to the whole retry budget (silent spinner).
   */
  onRetry?: (info: { attempt: number; waitMs: number; rateLimited: boolean; reason: string }) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration errors — surfaced to the UI with actionable setup guidance
// ─────────────────────────────────────────────────────────────────────────────

/** Error thrown when no AI backend is configured at all (deployed without keys). */
export class AIProviderConfigError extends Error {
  code = 'AI_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'AIProviderConfigError';
  }
}

/** Helper: does this look like a network-level failure (unreachable host)? */
function isNetworkError(e: unknown): boolean {
  const msg = String((e as Error)?.message || e);
  const cause = String((e as any)?.cause?.code || (e as any)?.cause?.message || '');
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|ECONNRESET|EPIPE|socket hang up|network|terminated/i
    .test(msg + ' ' + cause);
}

/** Standard deployment guidance appended to sandbox-network failures. */
const SANDBOX_NETWORK_HINT =
  'The Z.ai sandbox gateway (internal-api.z.ai) is only reachable from inside the Z.ai coding sandbox — ' +
  'this deployment is running elsewhere. To use the AI assistant here, set the ZAI_API_KEY environment variable ' +
  '(create a key at https://z.ai → API Keys) and restart. Server-to-server API calls work from any domain.';

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
    { id: 'glm-4.6', label: 'GLM-4.6 (Default)', description: 'Most capable Z.ai model — best for complex circuit design.', free: true },
    { id: 'glm-4.5', label: 'GLM-4.5', description: 'Previous generation flagship.', free: true },
    { id: 'glm-4-flash', label: 'GLM-4 Flash (Fast)', description: 'Lighter model for fast responses.', free: true },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini (Cheapest)', description: 'Fast and affordable. Best for most tasks.', free: false },
    { id: 'gpt-4o', label: 'GPT-4o', description: 'Most capable OpenAI model.', free: false },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano (Cheapest)', description: 'Smallest GPT-4.1 variant.', free: false },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Balanced cost/performance.', free: false },
  ],
  anthropic: [
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Fastest)', description: 'Fast and affordable Claude.', free: false },
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', description: 'Most capable Claude.', free: false },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Z.ai configuration detection (shared by the factory + providers route)
// ─────────────────────────────────────────────────────────────────────────────

/** The public Z.ai OpenAI-compatible endpoint (international). */
export const ZAI_PUBLIC_BASE_URL = 'https://api.z.ai/api/paas/v4';

/** Env var names accepted for the public Z.ai API key (first match wins). */
function zaiApiKey(): string | undefined {
  return process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY || undefined;
}

interface ZaiSandboxConfig {
  baseUrl: string;
  apiKey: string;
  chatId?: string;
  userId?: string;
  token?: string;
}

let sandboxConfigCache: { found: boolean; config?: ZaiSandboxConfig } | null = null;

/**
 * Locate the sandbox-mode Z.ai config the same way z-ai-web-dev-sdk does:
 * ZAI_CONFIG env var (JSON string) first — it is the documented way to carry
 * the sandbox identity to a non-sandbox host — then ./.z-ai-config,
 * ~/.z-ai-config, /etc/.z-ai-config. Returns undefined when none exists.
 * (Result cached; the config never changes within a process.)
 */
export function findSandboxZaiConfig(): ZaiSandboxConfig | undefined {
  if (sandboxConfigCache) return sandboxConfigCache.config;
  let config: ZaiSandboxConfig | undefined;
  const envJson = process.env.ZAI_CONFIG;
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (parsed.baseUrl && parsed.apiKey) config = parsed;
    } catch { /* malformed ZAI_CONFIG — fall through to files */ }
  }
  if (!config) {
    const candidates = [
      path.join(process.cwd(), '.z-ai-config'),
      path.join(os.homedir(), '.z-ai-config'),
      '/etc/.z-ai-config',
    ];
    for (const filePath of candidates) {
      try {
        const parsed = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
        if (parsed.baseUrl && parsed.apiKey) { config = parsed; break; }
      } catch { /* not found / invalid — try next */ }
    }
  }
  sandboxConfigCache = { found: !!config, config };
  return config;
}

/** For test isolation. */
export function _resetSandboxConfigCache() {
  sandboxConfigCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared retry policy — rate limits (429) and transient 5xx never fail the
// request outright; we back off and retry instead.
//
// TWO SEPARATE STRATEGIES (they were previously conflated, which caused the
// user-visible "endless spinning" loop):
//
//   • 429 rate limits are ACCOUNT-level quota throttling — every request on
//     the account is rejected until the quota window resets. Fast retries
//     (2s/4s/8s…) are actively HARMFUL: each rejected request burns budget,
//     re-triggers the limiter, and can sustain the 429 storm indefinitely
//     (self-perpetuating). We therefore wait LONG (30s, 60s), cap at 3 total
//     attempts, and coordinate ALL concurrent requests through a shared
//     global cooldown so tabs/turns never stampede the gateway.
//
//   • 5xx / network blips ARE transient — retry fast (2s/4s/8s/15s), up to 8
//     attempts inside a 150s budget, then hand off to the loop layer.
//
// Either way the user sees live "retrying in Ns" status events and always
// gets a terminal outcome (result or clear actionable error) — never a
// silent multi-minute spinner.
// ─────────────────────────────────────────────────────────────────────────────

/** Rate-limit waits: patient, quota-reset-aware. 3 attempts total. */
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000];
/** Transient (5xx/network) waits: fast recovery from blips. */
const TRANSIENT_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000];
const MAX_ATTEMPTS = 8;
/** Total wall-clock budget for provider-level retries within one model call
 * (transient path only — the rate-limit path is bounded by its own schedule). */
const MAX_RETRY_TOTAL_MS = 150_000;

// Shared gateway cooldown: once ANY request observes a 429, every other
// provider request in this process waits until the cooldown expires before
// touching the gateway again. Stored on globalThis so Next.js dev HMR / route
// module duplication cannot fork the state. A 429 on one request is strong
// evidence the whole account is throttled — the others must NOT pile on.
const globalForCooldown = globalThis as unknown as { __aiGatewayCooldownUntil?: number };
function gatewayCooldownRemaining(): number {
  return Math.max(0, (globalForCooldown.__aiGatewayCooldownUntil ?? 0) - Date.now());
}
function extendGatewayCooldown(ms: number): void {
  globalForCooldown.__aiGatewayCooldownUntil = Math.max(
    globalForCooldown.__aiGatewayCooldownUntil ?? 0,
    Date.now() + ms,
  );
}

/** Marker included in the terminal rate-limit error so the loop layer
 * (turn-manager) and the client can route it to the friendly retryable UX. */
export const RATE_LIMIT_ERROR_MARKER = 'rate-limited (429)';

function isRateLimitError(e: unknown): boolean {
  const msg = String((e as Error)?.message || e);
  return /429|rate limit|too many requests|rate-limited/i.test(msg);
}

function sleepRespectingAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); resolve(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function isRetryableProviderError(e: unknown): boolean {
  const msg = String((e as Error)?.message || e);
  const isRateLimit = msg.includes('429') || msg.includes('Too many requests') || msg.includes('rate limit');
  const isServerError = msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')
    || msg.includes('Bad Gateway') || msg.includes('Service Unavailable') || msg.includes('Internal Server Error')
    || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('socket hang up');
  // Generic network failures (transient DNS/TCP/TLS problems) — "fetch
  // failed" (undici/Bun), "Failed to fetch" (browser-ish), "Could not reach
  // the … API" (our own wrapper), ENOTFOUND/EAI_AGAIN, premature connection
  // termination. These used to hard-fail the whole AI turn on the first blip.
  const isNetworkError = /fetch failed|failed to fetch|could not reach|network|ENOTFOUND|EAI_AGAIN|ECONNABORTED|EPIPE|UND_ERR|connection (?:reset|terminated|closed|refused)|terminated unexpectedly/i.test(msg);
  // Auth/config problems must NOT be retried — they need human action.
  const isAuthError = /HTTP 40[13]|API key|API_KEY|credentials|not configured/i.test(msg);
  return !isAuthError && (isRateLimit || isServerError || isNetworkError);
}

/**
 * Run an async provider call with retry-on-429/5xx backoff. The abort signal
 * (client disconnect) breaks the loop immediately. A total wall-clock budget
 * bounds the loop: once it is exhausted the (retryable) error is re-thrown so
 * the loop layer in turn-manager can retry the whole call with VISIBLE status
 * events — the user never faces a silent multi-minute spinner.
 */
async function runWithRetries<T>(
  fn: () => Promise<T>,
  label: string,
  signal?: AbortSignal,
  onRetry?: (info: { attempt: number; waitMs: number; rateLimited: boolean; reason: string }) => void,
): Promise<T> {
  let lastError: Error | null = null;
  const startedAt = Date.now();
  // Rate-limit attempts get their own, much smaller cap — once exhausted we
  // MUST stop touching the gateway (see policy comment above).
  const rateLimitMaxAttempts = RATE_LIMIT_BACKOFF_MS.length + 1;
  let rateLimitAttempts = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error(`${label} request aborted (client disconnected)`);
    // Another request already observed a 429 → respect the shared cooldown
    // before even attempting (staggered by a little jitter so simultaneous
    // waiters don't fire in lockstep and re-trigger the limiter).
    const cooldown = gatewayCooldownRemaining();
    if (cooldown > 0 && attempt > 0) {
      const jitter = Math.floor(Math.random() * 3_000);
      await sleepRespectingAbort(cooldown + jitter, signal);
    }
    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;
      if (!isRetryableProviderError(e)) throw e;
      const isRateLimit = isRateLimitError(e);

      if (isRateLimit) {
        rateLimitAttempts++;
        // We just saw a 429 — every OTHER in-flight/new request must now wait
        // too (the throttle is account-wide, not per-request).
        extendGatewayCooldown(45_000);
        if (rateLimitAttempts >= rateLimitMaxAttempts) {
          // Quota clearly exhausted for now — terminal, actionable error. Do
          // NOT keep hammering; do NOT let the loop layer re-hammer either.
          throw new Error(
            `${label} provider ${RATE_LIMIT_ERROR_MARKER} after ${rateLimitAttempts} attempt(s) / ${Math.round((Date.now() - startedAt) / 1000)}s: ` +
            'the AI service quota is temporarily exhausted (HTTP 429 — every request is being rejected, including new ones). ' +
            'This is a temporary service-side limit, not a problem with your circuit or message. ' +
            'Your message is saved — wait a minute or two, then press Retry.',
          );
        }
      }

      const schedule = isRateLimit ? RATE_LIMIT_BACKOFF_MS : TRANSIENT_BACKOFF_MS;
      const scheduleWait = attempt < schedule.length ? schedule[attempt] : schedule[schedule.length - 1];
      // The rate-limit path waits at least the shared cooldown (extended by
      // the 429 we just saw) — never a fast re-fire.
      const waitMs = isRateLimit
        ? Math.max(scheduleWait, gatewayCooldownRemaining())
        : scheduleWait;
      const elapsed = Date.now() - startedAt;

      // Budget check (transient path only) — if this sleep would blow the
      // total budget, stop here and let the loop layer take over.
      if (!isRateLimit && (elapsed + waitMs > MAX_RETRY_TOTAL_MS || attempt === MAX_ATTEMPTS - 1)) {
        throw new Error(
          `${label} provider still unavailable after ${attempt + 1} attempt(s) / ${Math.round(elapsed / 1000)}s: ${(e as Error).message}. ` +
          'The AI will retry automatically — if it keeps failing, wait a minute and press Retry.',
        );
      }

      console.warn(
        `[${label}] ${isRateLimit ? 'Rate limited' : 'Server error'}, retrying in ${Math.round(waitMs / 1000)}s ` +
        `(attempt ${attempt + 1}${isRateLimit ? `/${rateLimitMaxAttempts} rate-limit` : `/${MAX_ATTEMPTS}`}, ` +
        `${Math.round((MAX_RETRY_TOTAL_MS - Math.min(elapsed, MAX_RETRY_TOTAL_MS)) / 1000)}s budget left)`,
      );
      // Surface the retry to the caller BEFORE sleeping — this drives the
      // user-visible "AI provider rate-limited — retrying in Ns" status.
      if (onRetry) {
        try {
          onRetry({ attempt: attempt + 1, waitMs, rateLimited: isRateLimit, reason: String((e as Error).message).slice(0, 200) });
        } catch { /* callback must never break the retry loop */ }
      }
      await sleepRespectingAbort(waitMs, signal);
    }
  }
  throw lastError || new Error(`${label} request failed after ${MAX_ATTEMPTS} retry attempts`);
}

/** Combine an optional caller signal with a timeout into one abort signal.
 *  NOTE: cleanup() clears only the TIMEOUT timer — the caller→combined abort
 *  propagation stays wired for the lifetime of the signal, so aborting the
 *  caller mid-stream (user Stop, turn time cap) still tears down the response
 *  body read. Previously cleanup removed that listener and a Stop couldn't
 *  interrupt an in-flight provider stream. */
function combineSignals(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(new Error(`Request timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  const callerAborted = () => timeoutCtrl.abort(new Error('Request aborted (client disconnected)'));
  if (signal) {
    if (signal.aborted) callerAborted();
    else signal.addEventListener('abort', callerAborted, { once: true });
  }
  return {
    signal: timeoutCtrl.signal,
    cleanup: () => {
      clearTimeout(timer);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Z.ai — PUBLIC API mode (ZAI_API_KEY): works from any deployment/domain.
// Direct OpenAI-compatible fetch, SSE streaming, no SDK involvement.
// ─────────────────────────────────────────────────────────────────────────────

class ZaiPublicProvider implements AIProvider {
  name: ProviderName = 'zai';
  model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(model?: string) {
    this.model = model || process.env.ZAI_MODEL || 'glm-4.6';
    this.baseUrl = (process.env.ZAI_BASE_URL || ZAI_PUBLIC_BASE_URL).replace(/\/+$/, '');
    this.apiKey = zaiApiKey()!;
  }

  private async doFetch(body: any, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const { signal: combined, cleanup } = combineSignals(timeoutMs, signal);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!response.ok) {
        const errorBody = await response.text();
        // Enrich auth failures so users see exactly what to fix.
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Z.ai API rejected the credentials (HTTP ${response.status}): ${errorBody.slice(0, 300)} — check the ZAI_API_KEY environment variable.`);
        }
        throw new Error(`Z.ai API error ${response.status}: ${errorBody.slice(0, 500)}`);
      }
      return response;
    } catch (e) {
      if (isNetworkError(e)) {
        throw new Error(`Could not reach the Z.ai API at ${this.baseUrl}: ${(e as Error).message}. If this host cannot reach the public internet, check ZAI_BASE_URL. ${SANDBOX_NETWORK_HINT}`);
      }
      throw e;
    } finally {
      cleanup();
    }
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions): Promise<ChatResult> {
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
    return runWithRetries(async () => {
      // 180s covers long 8k-token completions on slow models.
      const response = await this.doFetch(body, 180_000, options?.signal);
      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice?.message) throw new Error(`Z.ai API returned a malformed response: ${JSON.stringify(data).slice(0, 300)}`);
      return {
        content: choice.message.content || '',
        tool_calls: choice.message.tool_calls,
        finish_reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason,
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        } : undefined,
      } as ChatResult;
    }, 'zai', options?.signal, options?.onRetry);
  }

  async chatStream(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions, onTextDelta?: (text: string) => void): Promise<ChatResult> {
    const body: any = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.4,
      max_tokens: options?.max_tokens ?? 16384,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return runWithRetries(async () => {
      // Timeout applies to establishing the response (headers); the streamed
      // body itself may legitimately run for minutes.
      const response = await this.doFetch(body, 60_000, options?.signal);
      if (!response.body) throw new Error('Z.ai API returned no stream body');
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      try {
        const result = await accumulateOpenAiStream(reader, onTextDelta);
        return {
          content: result.content,
          tool_calls: result.tool_calls,
          finish_reason: result.finish_reason,
          usage: result.usage,
        } as ChatResult;
      } finally {
        // If the caller aborted mid-stream, release the connection.
        if (options?.signal?.aborted) {
          try { await reader.cancel(); } catch { /* already closed */ }
        }
      }
    }, 'zai', options?.signal, options?.onRetry);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Z.ai — SANDBOX mode: z-ai-web-dev-sdk against the internal gateway.
// Zero-config inside the Z.ai coding sandbox; carries the sandbox identity
// from the ZAI_CONFIG env var on hosts that replicate it.
// ─────────────────────────────────────────────────────────────────────────────

class ZaiSandboxProvider implements AIProvider {
  name: ProviderName = 'zai';
  model: string;

  constructor(model?: string) {
    this.model = model || 'glm-4.6';
  }

  /** Create a ZAI SDK instance (lazily — construction must never throw). */
  private async createZAI(): Promise<any> {
    const { default: ZAI } = await import('z-ai-web-dev-sdk');
    // The SDK itself checks cwd/.z-ai-config, ~/.z-ai-config and
    // /etc/.z-ai-config — try it first.
    try {
      return await ZAI.create();
    } catch {
      // No config file — construct from the ZAI_CONFIG env var if present.
      const configJson = process.env.ZAI_CONFIG;
      if (!configJson) {
        throw new AIProviderConfigError(
          'The Z.ai AI backend is not configured for this deployment. ' +
          'Set the ZAI_API_KEY environment variable to use the public Z.ai API (recommended — works from any domain; ' +
          'create a key at https://z.ai → API Keys), or copy the sandbox JSON config into ZAI_CONFIG. ' +
          'OpenAI (OPENAI_API_KEY) and Anthropic (ANTHROPIC_API_KEY) are also supported.',
        );
      }
      try {
        const config = JSON.parse(configJson);
        return new (ZAI as any)(config);
      } catch (e) {
        throw new AIProviderConfigError(`ZAI_CONFIG env var is set but invalid: ${(e as Error).message}`);
      }
    }
  }

  /**
   * The internal gateway (internal-api.z.ai) resolves to private IPs — only
   * reachable from inside the Z.ai sandbox. When a deployment outside the
   * sandbox tries to use it, convert the opaque network failure into an
   * actionable message instead of a mysterious hang/timeout.
   */
  private wrapSandboxNetworkError(e: unknown): Error {
    if (isNetworkError(e)) {
      const cfg = findSandboxZaiConfig();
      if (!cfg || /internal-api/i.test(cfg.baseUrl)) {
        return new Error(`${(e as Error).message}. ${SANDBOX_NETWORK_HINT}`);
      }
    }
    return e as Error;
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions): Promise<ChatResult> {
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
    return runWithRetries(async () => {
      const zai = await this.createZAI();
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
        } as ChatResult;
      } catch (e) {
        // Config errors pass through untouched; network errors get the hint.
        if (e instanceof AIProviderConfigError) throw e;
        throw this.wrapSandboxNetworkError(e);
      }
    }, 'zai', options?.signal, options?.onRetry);
  }

  async chatStream(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions, onTextDelta?: (text: string) => void): Promise<ChatResult> {
    const body: any = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.4,
      max_tokens: options?.max_tokens ?? 16384,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return runWithRetries(async () => {
      const zai = await this.createZAI();
      let streamOrResponse: any;
      try {
        // The SDK returns response.body (a ReadableStream) when stream:true
        // and the content type is text/event-stream or text/plain.
        streamOrResponse = await zai.chat.completions.create(body);
      } catch (e) {
        if (e instanceof AIProviderConfigError) throw e;
        throw this.wrapSandboxNetworkError(e);
      }
      // Defensive: if the gateway ignored stream:true and returned a full
      // completion object, degrade gracefully to non-streaming behavior.
      if (!streamOrResponse || typeof streamOrResponse.getReader !== 'function') {
        const choice = streamOrResponse?.choices?.[0];
        const message = choice?.message;
        if (!message) throw new Error('Z.ai sandbox gateway returned a malformed response.');
        const content = message.content || '';
        if (content && onTextDelta) onTextDelta(content);
        return {
          content,
          tool_calls: message.tool_calls,
          finish_reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason,
          usage: streamOrResponse.usage ? {
            prompt_tokens: streamOrResponse.usage.prompt_tokens,
            completion_tokens: streamOrResponse.usage.completion_tokens,
            total_tokens: streamOrResponse.usage.total_tokens,
          } : undefined,
        } as ChatResult;
      }
      const reader = streamOrResponse.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      try {
        const result = await accumulateOpenAiStream(reader, onTextDelta);
        return {
          content: result.content,
          tool_calls: result.tool_calls,
          finish_reason: result.finish_reason,
          usage: result.usage,
        } as ChatResult;
      } catch (e) {
        if (options?.signal?.aborted) throw new Error('zai request aborted (client disconnected)');
        throw this.wrapSandboxNetworkError(e);
      } finally {
        if (options?.signal?.aborted) {
          try { await reader.cancel(); } catch { /* already closed */ }
        }
      }
    }, 'zai', options?.signal, options?.onRetry);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI provider (with SSE streaming)
// ─────────────────────────────────────────────────────────────────────────────

class OpenAIProvider implements AIProvider {
  name: ProviderName = 'openai';
  model: string;

  constructor(model?: string) {
    this.model = model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  }

  private buildBody(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions, stream = false): any {
    const body: any = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.4,
      max_tokens: options?.max_tokens ?? 16384,
    };
    if (stream) body.stream = true;
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return body;
  }

  private async doFetch(body: any, signal?: AbortSignal): Promise<Response> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 500)}`);
    }
    return response;
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions): Promise<ChatResult> {
    const body = this.buildBody(messages, tools, options);
    return runWithRetries(async () => {
      const response = await this.doFetch(body, options?.signal);
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
      } as ChatResult;
    }, 'openai', options?.signal, options?.onRetry);
  }

  async chatStream(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions, onTextDelta?: (text: string) => void): Promise<ChatResult> {
    const body = this.buildBody(messages, tools, options, true);
    return runWithRetries(async () => {
      const response = await this.doFetch(body, options?.signal);
      if (!response.body) throw new Error('OpenAI API returned no stream body');
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const result = await accumulateOpenAiStream(reader, onTextDelta);
      return {
        content: result.content,
        tool_calls: result.tool_calls,
        finish_reason: result.finish_reason,
        usage: result.usage,
      } as ChatResult;
    }, 'openai', options?.signal, options?.onRetry);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Claude provider — translates OpenAI-style tool calls to Claude's API
// (non-streaming; chatStream emits the complete text as a single delta)
// ─────────────────────────────────────────────────────────────────────────────

class AnthropicProvider implements AIProvider {
  name: ProviderName = 'anthropic';
  model: string;

  constructor(model?: string) {
    this.model = model || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions): Promise<ChatResult> {
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

  async chatStream(messages: ChatMessage[], tools?: ToolDefinition[], options?: ProviderCallOptions, onTextDelta?: (text: string) => void): Promise<ChatResult> {
    // Anthropic streaming uses a different SSE schema (content_block_delta
    // events) — for now, complete non-streaming and emit one delta.
    const result = await this.chat(messages, tools, options);
    if (result.content && onTextDelta) onTextDelta(result.content);
    return result;
  }
}

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
        return createZaiProvider(model);
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
        return createZaiProvider(model);
      }
      return new AnthropicProvider(model);
    case 'zai':
    default:
      return createZaiProvider(model);
  }
}

/**
 * Pick the Z.ai implementation for this environment:
 *   - ZAI_API_KEY set          → public API provider (works on any domain)
 *   - sandbox config available → sandbox provider (zero-config in sandbox)
 *   - neither                  → sandbox provider anyway; chat() will throw an
 *                                actionable AIProviderConfigError at request time
 *                                (construction stays non-throwing so the
 *                                providers listing route never 500s).
 */
function createZaiProvider(model?: string): AIProvider {
  if (zaiApiKey()) return new ZaiPublicProvider(model);
  return new ZaiSandboxProvider(model);
}

export interface ProviderInfoEntry {
  name: ProviderName;
  label: string;
  available: boolean;
  requiresKey: string | null;
  model: string;
  models: ModelInfo[];
  /**
   * How the Z.ai backend is wired on this host:
   *   'api-key'  — ZAI_API_KEY set → public API, works from any domain
   *   'sandbox'  — sandbox gateway config found (zero-config, sandbox-only)
   *   'unconfigured' — no Z.ai backend available
   */
  mode?: 'api-key' | 'sandbox' | 'unconfigured';
}

/** Returns the list of providers available given the current env. */
export function getAvailableProviders(): ProviderInfoEntry[] {
  const apiKey = zaiApiKey();
  const sandboxCfg = findSandboxZaiConfig();
  const zaiMode: 'api-key' | 'sandbox' | 'unconfigured' = apiKey ? 'api-key' : sandboxCfg ? 'sandbox' : 'unconfigured';
  return [
    {
      name: 'zai',
      label: apiKey ? 'Z.ai (GLM) — API key' : 'Z.ai (GLM)',
      available: zaiMode !== 'unconfigured',
      requiresKey: zaiMode === 'unconfigured' ? 'ZAI_API_KEY' : null,
      model: process.env.ZAI_MODEL || 'glm-4.6',
      models: AVAILABLE_MODELS.zai,
      mode: zaiMode,
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
