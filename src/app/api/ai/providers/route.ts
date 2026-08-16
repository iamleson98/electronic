// Available AI Providers API Route — /api/ai/providers
// ─────────────────────────────────────────────────────────────────────────────
// Returns the list of AI providers the server is configured to support. Used by
// the ChatPanel dropdown so the UI can show which providers have API keys set
// (e.g., dim "OpenAI" if OPENAI_API_KEY is missing).
//
// No secrets are exposed — only a boolean `available` flag and the env-var name
// the user would need to set to enable that provider.

import { NextResponse } from 'next/server';
import { getAvailableProviders, getProvider, type ProviderName } from '@/lib/ai/provider';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const providers = getAvailableProviders();
    // Resolve the currently-active default provider (env-var based).
    let defaultProvider: ProviderName;
    try {
      defaultProvider = getProvider().name;
    } catch {
      // If the env-var default is misconfigured (key missing), fall back to 'zai'.
      defaultProvider = 'zai';
    }
    return NextResponse.json({
      providers,
      default: defaultProvider,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to list providers: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
