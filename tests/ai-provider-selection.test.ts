// Tests for AI provider selection and the getAvailableProviders() factory.
// Verifies that:
//   - getProvider() picks the right implementation based on env var + override
//   - getAvailableProviders() reports the correct availability for each provider
//   - The fallback behavior when an API key is missing is correct
//
// These tests run without making real API calls — they only exercise the
// factory and metadata logic, not the chat() method.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getProvider, getAvailableProviders, _resetSandboxConfigCache, type ProviderName } from '../src/lib/ai/provider';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Clear AI-related env vars before each test
  delete process.env.AI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.ZAI_API_KEY;
  delete process.env.Z_AI_API_KEY;
  delete process.env.ZAI_MODEL;
  delete process.env.ZAI_BASE_URL;
  delete process.env.ZAI_CONFIG;
  _resetSandboxConfigCache();
});

afterEach(() => {
  // Restore original env
  process.env = { ...ORIGINAL_ENV };
  _resetSandboxConfigCache();
});

describe('getProvider — default selection', () => {
  it('returns Z.ai when no env vars set and no override requested', () => {
    const p = getProvider();
    expect(p.name).toBe('zai');
    expect(p.model).toBe('glm-4.6');
  });

  it('returns Z.ai when AI_PROVIDER=zai', () => {
    process.env.AI_PROVIDER = 'zai';
    expect(getProvider().name).toBe('zai');
  });

  it('returns Z.ai when AI_PROVIDER is unknown', () => {
    process.env.AI_PROVIDER = 'something-unknown';
    expect(getProvider().name).toBe('zai');
  });

  it('returns Z.ai when AI_PROVIDER is uppercase', () => {
    process.env.AI_PROVIDER = 'ZAI';
    expect(getProvider().name).toBe('zai');
  });
});

describe('getProvider — explicit override', () => {
  it('honors explicit "zai" override regardless of AI_PROVIDER', () => {
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getProvider('zai').name).toBe('zai');
  });

  it('honors explicit "openai" override when key is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const p = getProvider('openai');
    expect(p.name).toBe('openai');
  });

  it('honors explicit "anthropic" override when key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const p = getProvider('anthropic');
    expect(p.name).toBe('anthropic');
  });

  it('throws when explicit "openai" override requested but key missing', () => {
    expect(() => getProvider('openai')).toThrow(/OPENAI_API_KEY/);
  });

  it('throws when explicit "anthropic" override requested but key missing', () => {
    expect(() => getProvider('anthropic')).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('throws a user-friendly message mentioning the dropdown', () => {
    try {
      getProvider('openai');
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).toMatch(/choose a different provider/i);
    }
  });
});

describe('getProvider — env var fallback when key missing', () => {
  it('falls back to Z.ai when AI_PROVIDER=openai but key missing (no explicit override)', () => {
    process.env.AI_PROVIDER = 'openai';
    // No override argument → falls back to Z.ai silently
    expect(getProvider().name).toBe('zai');
  });

  it('falls back to Z.ai when AI_PROVIDER=anthropic but key missing', () => {
    process.env.AI_PROVIDER = 'anthropic';
    expect(getProvider().name).toBe('zai');
  });

  it('uses OpenAI when AI_PROVIDER=openai and key is set', () => {
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getProvider().name).toBe('openai');
  });

  it('uses Anthropic when AI_PROVIDER=anthropic and key is set', () => {
    process.env.AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(getProvider().name).toBe('anthropic');
  });
});

describe('getProvider — model overrides', () => {
  it('respects OPENAI_MODEL env var', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_MODEL = 'gpt-4-turbo';
    expect(getProvider('openai').model).toBe('gpt-4-turbo');
  });

  it('respects ANTHROPIC_MODEL env var', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANTHROPIC_MODEL = 'claude-3-opus-20240229';
    expect(getProvider('anthropic').model).toBe('claude-3-opus-20240229');
  });

  it('uses default OpenAI model when OPENAI_MODEL not set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getProvider('openai').model).toBe('gpt-4o-mini');
  });

  it('uses default Anthropic model when ANTHROPIC_MODEL not set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(getProvider('anthropic').model).toBe('claude-3-5-haiku-20241022');
  });
});

describe('getAvailableProviders', () => {
  it('returns exactly 4 providers (incl. custom endpoint)', () => {
    const list = getAvailableProviders();
    expect(list.length).toBe(4);
  });

  it('returns zai, openai, anthropic, custom in order', () => {
    const list = getAvailableProviders();
    expect(list.map(p => p.name)).toEqual(['zai', 'openai', 'anthropic', 'custom']);
  });

  it('custom endpoint is always selectable (user-configured URL/key/model)', () => {
    const custom = getAvailableProviders().find(p => p.name === 'custom')!;
    expect(custom.available).toBe(true);
    // Without a per-request URL the factory throws an actionable config error.
    expect(() => getProvider('custom')).toThrow(/API URL/);
    const prov = getProvider('custom', undefined, { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' });
    expect(prov.name).toBe('custom');
    expect(prov.model).toBe('llama3.1');
  });

  it('custom endpoint throws a clear config error when a hosted URL has no key (e.g. Groq)', () => {
    // Groq without a key used to send a keyless request that came back as an
    // opaque HTTP 401 + console stack trace — now it fails fast with guidance.
    expect(() => getProvider('custom', undefined, { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' }))
      .toThrow(/needs an API key/);
  });

  it('custom endpoint allows keyless local URLs (Ollama/LM Studio)', () => {
    expect(getProvider('custom', undefined, { baseUrl: 'http://localhost:11434/v1', model: 'llama3.3' }).name).toBe('custom');
    expect(getProvider('custom', undefined, { baseUrl: 'http://localhost:1234/v1', model: 'local-model' }).name).toBe('custom');
  });

  it('sends the frontend custom URL and API key to that exact endpoint', async () => {
    process.env.CUSTOM_AI_BASE_URL = 'https://server-default.example/v1';
    process.env.CUSTOM_AI_API_KEY = 'server-default-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = getProvider('custom', undefined, {
      baseUrl: 'https://frontend.example/openai/v1/chat/completions',
      apiKey: 'frontend-key',
      model: 'frontend-model',
    });
    await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://frontend.example/openai/v1/chat/completions');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer frontend-key');
    expect(JSON.parse(String(init.body)).model).toBe('frontend-model');
  });

  it('zai availability reflects the environment (api-key > sandbox > unconfigured)', () => {
    const zai = getAvailableProviders().find(p => p.name === 'zai')!;
    // In the Z.ai sandbox → 'sandbox' (zero-config); in CI (no config) →
    // 'unconfigured'; with ZAI_API_KEY → 'api-key'. All three are valid states
    // depending on where the suite runs — but they must be self-consistent.
    expect(['api-key', 'sandbox', 'unconfigured']).toContain(zai.mode);
    expect(zai.available).toBe(zai.mode !== 'unconfigured');
    expect(zai.model).toBe('glm-4.6');
    if (zai.mode === 'unconfigured') {
      expect(zai.requiresKey).toBe('ZAI_API_KEY');
    }
  });

  it('ZAI_API_KEY switches zai to public-API mode (works on any domain)', () => {
    process.env.ZAI_API_KEY = 'zai-key-test';
    const zai = getAvailableProviders().find(p => p.name === 'zai')!;
    expect(zai.mode).toBe('api-key');
    expect(zai.available).toBe(true);
    expect(zai.requiresKey).toBeNull();
  });

  it('openai.available=false when OPENAI_API_KEY not set', () => {
    const openai = getAvailableProviders().find(p => p.name === 'openai')!;
    expect(openai.available).toBe(false);
    expect(openai.requiresKey).toBe('OPENAI_API_KEY');
  });

  it('openai.available=true when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const openai = getAvailableProviders().find(p => p.name === 'openai')!;
    expect(openai.available).toBe(true);
  });

  it('anthropic.available=false when ANTHROPIC_API_KEY not set', () => {
    const anthropic = getAvailableProviders().find(p => p.name === 'anthropic')!;
    expect(anthropic.available).toBe(false);
    expect(anthropic.requiresKey).toBe('ANTHROPIC_API_KEY');
  });

  it('anthropic.available=true when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const anthropic = getAvailableProviders().find(p => p.name === 'anthropic')!;
    expect(anthropic.available).toBe(true);
  });

  it('all providers have a label and model', () => {
    for (const p of getAvailableProviders()) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.model.length).toBeGreaterThan(0);
    }
  });

  it('uses default models when env overrides absent', () => {
    const list = getAvailableProviders();
    expect(list.find(p => p.name === 'openai')!.model).toBe('gpt-4o-mini');
    expect(list.find(p => p.name === 'anthropic')!.model).toBe('claude-3-5-haiku-20241022');
  });

  it('reflects OPENAI_MODEL override in the model field', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    expect(getAvailableProviders().find(p => p.name === 'openai')!.model).toBe('gpt-4o-mini');
  });

  it('reflects ANTHROPIC_MODEL override in the model field', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANTHROPIC_MODEL = 'claude-3-haiku-20240307';
    expect(getAvailableProviders().find(p => p.name === 'anthropic')!.model).toBe('claude-3-haiku-20240307');
  });
});

describe('getProvider — ProviderName type', () => {
  it('ProviderName accepts zai', () => {
    const x: ProviderName = 'zai';
    expect(x).toBe('zai');
  });
  it('ProviderName accepts openai', () => {
    const x: ProviderName = 'openai';
    expect(x).toBe('openai');
  });
  it('ProviderName accepts anthropic', () => {
    const x: ProviderName = 'anthropic';
    expect(x).toBe('anthropic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2-c: in-memory AI rate limiter (used by the AI chat routes).
// ─────────────────────────────────────────────────────────────────────────────

describe('checkRateLimit (AI endpoint limiter)', () => {
  it('allows up to the limit and then blocks with a retry hint', async () => {
    const { checkRateLimit } = await import('../src/lib/ai/rate-limit');
    const key = `test-rl-${Math.random()}`;
    const opts = { limit: 3, windowMs: 1000 };
    expect(checkRateLimit(key, opts).ok).toBe(true);
    expect(checkRateLimit(key, opts).ok).toBe(true);
    const third = checkRateLimit(key, opts);
    expect(third.ok).toBe(true);
    expect(third.remaining).toBe(0);
    const blocked = checkRateLimit(key, opts);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(1);
  });

  it('a blocked request does not extend the window (no new timestamp recorded)', async () => {
    const { checkRateLimit } = await import('../src/lib/ai/rate-limit');
    const key = `test-rl2-${Math.random()}`;
    const opts = { limit: 1, windowMs: 200 };
    expect(checkRateLimit(key, opts).ok).toBe(true);
    expect(checkRateLimit(key, opts).ok).toBe(false);
    // window expires → allowed again
    await new Promise(r => setTimeout(r, 250));
    expect(checkRateLimit(key, opts).ok).toBe(true);
  });

  it('separate keys have separate windows', async () => {
    const { checkRateLimit } = await import('../src/lib/ai/rate-limit');
    const opts = { limit: 1, windowMs: 5000 };
    expect(checkRateLimit('k-a', opts).ok).toBe(true);
    expect(checkRateLimit('k-b', opts).ok).toBe(true);
    expect(checkRateLimit('k-a', opts).ok).toBe(false);
    expect(checkRateLimit('k-b', opts).ok).toBe(false);
  });

  it('clientIpFromRequest reads x-forwarded-for chains', async () => {
    const { clientIpFromRequest } = await import('../src/lib/ai/rate-limit');
    const req = new Request('http://localhost/x', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    expect(clientIpFromRequest(req)).toBe('203.0.113.7');
    const req2 = new Request('http://localhost/x', { headers: { 'x-real-ip': '198.51.100.9' } });
    expect(clientIpFromRequest(req2)).toBe('198.51.100.9');
    expect(clientIpFromRequest(new Request('http://localhost/x'))).toBe('unknown');
  });
});
