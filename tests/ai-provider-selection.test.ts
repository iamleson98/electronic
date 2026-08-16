// Tests for AI provider selection and the getAvailableProviders() factory.
// Verifies that:
//   - getProvider() picks the right implementation based on env var + override
//   - getAvailableProviders() reports the correct availability for each provider
//   - The fallback behavior when an API key is missing is correct
//
// These tests run without making real API calls — they only exercise the
// factory and metadata logic, not the chat() method.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProvider, getAvailableProviders, type ProviderName } from '../src/lib/ai/provider';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Clear AI-related env vars before each test
  delete process.env.AI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

afterEach(() => {
  // Restore original env
  process.env = { ...ORIGINAL_ENV };
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
    expect(getProvider('openai').model).toBe('gpt-4o');
  });

  it('uses default Anthropic model when ANTHROPIC_MODEL not set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(getProvider('anthropic').model).toBe('claude-3-5-sonnet-20241022');
  });
});

describe('getAvailableProviders', () => {
  it('returns exactly 3 providers', () => {
    const list = getAvailableProviders();
    expect(list.length).toBe(3);
  });

  it('returns zai, openai, anthropic in order', () => {
    const list = getAvailableProviders();
    expect(list.map(p => p.name)).toEqual(['zai', 'openai', 'anthropic']);
  });

  it('zai is always available regardless of env vars', () => {
    const zai = getAvailableProviders().find(p => p.name === 'zai')!;
    expect(zai.available).toBe(true);
    expect(zai.requiresKey).toBeNull();
    expect(zai.model).toBe('glm-4.6');
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
    expect(list.find(p => p.name === 'openai')!.model).toBe('gpt-4o');
    expect(list.find(p => p.name === 'anthropic')!.model).toBe('claude-3-5-sonnet-20241022');
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
