// Client-safe AI provider model catalog — NO Node.js imports.
// ─────────────────────────────────────────────────────────────────────────────
// This module is importable from Client Components (e.g. ChatPanel). It must
// NEVER import 'fs', 'path', 'os', 'z-ai-web-dev-sdk', or './provider'.
// The server-only provider.ts re-exports everything from here so existing
// server imports keep working.

export type ProviderName = 'zai' | 'openai' | 'anthropic' | 'custom';

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
  custom: [
    { id: 'custom', label: 'Custom endpoint', description: 'User-configured OpenAI-compatible API (URL + key + model).', free: false },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Custom endpoint presets — hardcoded OpenAI-compatible URLs, each with its
// own curated model list (top free + flagship-smart). The user picks a preset
// (URL fills in), picks a model, pastes a key — no typing URLs or model IDs.
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomEndpointPreset {
  id: string;
  label: string;
  baseUrl: string;
  keyUrl: string;
  keyPlaceholder: string;
  /** False for local endpoints (Ollama/LM Studio) that accept no key. */
  needsKey: boolean;
  models: ModelInfo[];
}

export const CUSTOM_ENDPOINT_PRESETS: CustomEndpointPreset[] = [
  {
    id: 'muse-spark',
    label: 'Muse Spark (this assistant)',
    baseUrl: 'https://api.musespark.ai/v1',
    keyUrl: 'https://musespark.ai → API Keys',
    keyPlaceholder: 'ms-…',
    needsKey: true,
    models: [
      { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 (Smartest)', description: 'Flagship — best for complex circuit design.', free: false },
      { id: 'muse-spark-1.3-mini', label: 'Muse Spark 1.3 Mini', description: 'Fast + cheap, still very capable.', free: true },
    ],
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com → Get API key',
    keyPlaceholder: 'AIza…',
    needsKey: true,
    models: [
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash (Free)', description: 'Fast flagship-flash tier — generous free quota.', free: true },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', description: 'Most capable Gemini — deep reasoning.', free: false },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Free)', description: 'Previous flash — large free tier.', free: true },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Previous pro — strong reasoning.', free: false },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com → API Keys',
    keyPlaceholder: 'sk-…',
    needsKey: true,
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek V3 (Cheap)', description: 'Flagship chat — very low price.', free: false },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1 (Reasoning)', description: 'Deep reasoning — best for hard design.', free: false },
    ],
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI (GPT)',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com → API Keys',
    keyPlaceholder: 'sk-…',
    needsKey: true,
    models: [
      { id: 'gpt-5-mini', label: 'GPT-5 Mini', description: 'Balanced cost/performance.', free: false },
      { id: 'gpt-5-nano', label: 'GPT-5 Nano (Cheapest)', description: 'Smallest GPT-5 — fastest.', free: false },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Cheap previous-gen workhorse.', free: false },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai → Keys',
    keyPlaceholder: 'sk-or-…',
    needsKey: true,
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (Free)', description: 'Strong open flagship via OpenRouter free tier.', free: true },
      { id: 'google/gemini-2.0-flash-001:free', label: 'Gemini 2.0 Flash (Free)', description: 'Fast Gemini free tier.', free: true },
      { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (Free)', description: 'Reasoning model, free tier.', free: true },
      { id: 'qwen/qwen-2.5-72b-instruct:free', label: 'Qwen 2.5 72B (Free)', description: 'Strong open model, free tier.', free: true },
    ],
  },
  {
    id: 'together',
    label: 'Together (free models)',
    baseUrl: 'https://api.together.xyz/v1',
    keyUrl: 'https://api.together.ai → API Keys',
    keyPlaceholder: '…',
    needsKey: true,
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', description: 'Fast open flagship — free credits.', free: true },
      { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1', description: 'Reasoning — free credits.', free: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen 2.5 72B Turbo', description: 'Strong open model.', free: true },
    ],
  },
  {
    id: 'groq',
    label: 'Groq (free, ultra-fast)',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com → API Keys',
    keyPlaceholder: 'gsk_…',
    needsKey: true,
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Free)', description: 'Ultra-fast inference, free tier.', free: true },
      { id: 'deepseek-r1-distill-llama-70b', label: 'R1 Distill 70B (Free)', description: 'Reasoning distill, free tier.', free: true },
      { id: 'qwen-2.5-72b-instruct', label: 'Qwen 2.5 72B (Free)', description: 'Strong open model, free tier.', free: true },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (local, free)',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: 'No key needed (local)',
    keyPlaceholder: '(none)',
    needsKey: false,
    models: [
      { id: 'llama3.3', label: 'Llama 3.3 (Local)', description: 'Strong local open model.', free: true },
      { id: 'qwen2.5:72b', label: 'Qwen 2.5 72B (Local)', description: 'Needs ~48GB RAM / GPU.', free: true },
      { id: 'deepseek-r1:32b', label: 'DeepSeek R1 32B (Local)', description: 'Local reasoning.', free: true },
    ],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local, free)',
    baseUrl: 'http://localhost:1234/v1',
    keyUrl: 'No key needed (local)',
    keyPlaceholder: '(none)',
    needsKey: false,
    models: [
      { id: 'local-model', label: 'Loaded model (Local)', description: 'Whatever is loaded in LM Studio.', free: true },
    ],
  },
];

/** Find a preset by its base URL (for recognizing a pasted URL). */
export function findPresetByUrl(baseUrl: string): CustomEndpointPreset | undefined {
  const norm = (baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  return CUSTOM_ENDPOINT_PRESETS.find(p => p.baseUrl.toLowerCase() === norm);
}

/** True for loopback-hosted endpoints (Ollama/LM Studio defaults and the like). */
export function isLocalEndpoint(baseUrl: string): boolean {
  const v = (baseUrl || '').trim().toLowerCase();
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(v);
}

/**
 * Does this endpoint require an API key? Preset match wins; unknown URLs
 * require a key unless they are loopback-local. Client-safe (no Node imports).
 */
export function customEndpointNeedsKey(baseUrl: string): boolean {
  const hit = findPresetByUrl(baseUrl);
  if (hit) return hit.needsKey;
  return !isLocalEndpoint(baseUrl);
}
