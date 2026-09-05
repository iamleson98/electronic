'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useChatSession, stepLabelFor, type ChatMessage, type ToolCallEntry } from '@/lib/ai/chat-session';
import { summarizeCircuitDoc } from '@/lib/ai/circuit-summary';
import { CUSTOM_ENDPOINT_PRESETS, findPresetByUrl, customEndpointNeedsKey } from '@/lib/ai/provider-models';
import type { CircuitComponent, Wire } from '@/lib/circuit/types';
import { useEditor } from '@/lib/circuit/store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ChevronDown, ChevronRight, Send, Sparkles, Loader2, X, AlertCircle, CheckCircle2,
  Wrench, Undo2, Eye, GitBranch, Cpu, KeyRound, ExternalLink, Square, WifiOff,
  SquareSlash, RotateCcw, ClipboardList, CircuitBoard, Cable, Clock,
  PackageX, Settings2,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Suggested prompts (welcome screen)
// ─────────────────────────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  'Build a 555 LED blinker at 2 Hz with 60% duty cycle',
  'Build a 5V power supply with transformer, bridge rectifier and regulator',
  'Design an inverting amplifier with a gain of 10 and verify it',
  'Why doesn\'t my circuit work? Diagnose it',
  'What if I changed R1 to 10k? Compare the results',
];

/** Tools that mutate the circuit — used to decide whether to offer Undo. */
const MUTATING_TOOLS = new Set([
  'schematic.addComponent', 'schematic.removeComponent', 'schematic.moveComponent',
  'schematic.rotateComponent', 'schematic.setParameter', 'schematic.addWire',
  'schematic.removeWire', 'schematic.clear', 'schematic.reannotate',
  'schematic.undo', 'schematic.redo', 'schematic.loadDocument', 'examples.load',
  'design.buildPattern',
]);

/** Shared scroll-area styling (slim dark scrollbar). */
const SCROLL_AREA = 'max-h-56 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-700 [&::-webkit-scrollbar-track]:bg-transparent';

/** mm:ss-style duration for turn headers. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Session store — survives panel close (the AI keeps building in background)
  const messages = useChatSession(s => s.messages);
  const active = useChatSession(s => s.active);
  const autoApply = useChatSession(s => s.autoApply);
  const setAutoApply = useChatSession(s => s.setAutoApply);
  const providers = useChatSession(s => s.providers);
  const providersLoading = useChatSession(s => s.providersLoading);
  const selectedProvider = useChatSession(s => s.selectedProvider);
  const selectedModel = useChatSession(s => s.selectedModel);
  const setProvider = useChatSession(s => s.setProvider);
  const setModel = useChatSession(s => s.setModel);
  const customEndpoint = useChatSession(s => s.customEndpoint);
  const setCustomEndpoint = useChatSession(s => s.setCustomEndpoint);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const totalTokens = useChatSession(s => s.totalTokens);
  const resetTokens = useChatSession(s => s.resetTokens);
  const send = useChatSession(s => s.send);
  const stop = useChatSession(s => s.stop);

  const isLoading = !!active;

  const handleProviderChange = (name: 'zai' | 'openai' | 'anthropic' | 'custom') => {
    if (name === 'custom') {
      setSettingsOpen(true);
      return;
    }
    setProvider(name);
  };

  // One-time initialization: provider list + resume a turn that was in flight
  // when the page reloaded (network drop, refresh, crash).
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void useChatSession.getState().initProviders();
    useChatSession.getState().resumeAfterReload();
  }, []);

  // Listen for external "ask AI" prompts (ProbePanel, PropertyPanel, etc.)
  const sendRef = useRef<((text: string) => void) | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      const prompt = (e as CustomEvent<string>).detail;
      if (prompt && sendRef.current) {
        sendRef.current(prompt);
      } else if (prompt) {
        setInput(prompt);
      }
    };
    window.addEventListener('circuitlab:ai-prompt', onPrompt as EventListener);
    return () => window.removeEventListener('circuitlab:ai-prompt', onPrompt as EventListener);
  }, []);

  useEffect(() => {
    sendRef.current = (text: string) => {
      if (!text.trim() || useChatSession.getState().active) return;
      send(text);
    };
  }, [send]);

  // Auto-scroll while streaming (but not if the user scrolled up to read)
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    if (stickToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, active?.statusText]);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isLoading && input.trim()) {
        send(input);
        setInput('');
      }
    }
  };

  const handleSendClick = () => {
    if (isLoading) { stop(); return; }
    if (!input.trim()) return;
    send(input);
    setInput('');
  };

  return (
    <div className="relative flex h-full w-full flex-col border-l border-slate-800 bg-slate-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className={`h-5 w-5 ${active ? 'animate-pulse text-purple-300' : 'text-purple-400'}`} />
          <div>
            <h2 className="text-sm font-semibold text-slate-100">AI Assistant</h2>
            <p className="text-xs text-slate-500">
              {active ? 'Working — building on your canvas' : 'Builds directly on your canvas'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* Provider selector */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Select
                    value={selectedProvider}
                    onValueChange={(v) => handleProviderChange(v as 'zai' | 'openai' | 'anthropic' | 'custom')}
                    disabled={providersLoading || providers.length === 0}
                  >
                    <SelectTrigger className="h-7 w-32.5 gap-1 border-slate-700 bg-slate-800 px-2 text-xs text-slate-200 cursor-pointer hover:border-slate-600">
                      <Cpu className="h-3 w-3 text-cyan-400" />
                      <SelectValue placeholder="Provider…" />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map(p => (
                        <SelectItem
                          key={p.name}
                          value={p.name}
                          // 'custom' is always selectable — configured in settings.
                          disabled={!p.available && p.name !== 'custom'}
                          className="cursor-pointer"
                        >
                          <div className="flex flex-col">
                            <span className="text-xs font-medium">{p.label}</span>
                            <span className={`text-[10px] ${p.available || p.name === 'custom' ? 'text-slate-400' : 'text-amber-400'}`}>
                              {p.name === 'custom'
                                ? (customEndpoint.baseUrl ? customEndpoint.baseUrl : 'configure URL + key')
                                : p.available ? `${p.models.length} models` : `needs ${p.requiresKey}`}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Choose which AI provider to use</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {/* Model selector — hidden for custom (model lives in settings) */}
          {(() => {
            if (selectedProvider === 'custom') {
              return (
                <span
                  className="hidden h-7 max-w-40 truncate px-2 font-mono text-[11px] leading-7 text-cyan-300 sm:inline"
                  title={customEndpoint.model || 'Set the model in settings (gear icon)'}
                >
                  {customEndpoint.model || 'set model…'}
                </span>
              );
            }
            const provider = providers.find(p => p.name === selectedProvider);
            const models = provider?.models ?? [];
            if (models.length === 0) return null;
            return (
              <Select
                value={selectedModel}
                onValueChange={(v) => setModel(v)}
                disabled={providersLoading}
              >
                <SelectTrigger className="h-7 w-40 gap-1 border-slate-700 bg-slate-800 px-2 text-xs text-slate-200 cursor-pointer hover:border-slate-600">
                  <SelectValue placeholder="Model…" />
                </SelectTrigger>
                <SelectContent>
                  {models.map(m => (
                    <SelectItem key={m.id} value={m.id} className="cursor-pointer">
                      <div className="flex flex-col">
                        <span className="text-xs font-medium">
                          {m.label}
                          {m.free && <span className="ml-1 text-emerald-400">●</span>}
                        </span>
                        <span className="text-[10px] text-slate-500">{m.description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          })()}
          {/* Custom endpoint settings (API URL + key + model for any agent) */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSettingsOpen(true)}
                  className={`h-7 w-7 cursor-pointer hover:bg-slate-800 ${selectedProvider === 'custom' && !customEndpoint.baseUrl ? 'text-amber-400' : ''}`}
                  title="AI provider settings — endpoint, key, model"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>AI settings — endpoint, key, model</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {/* Auto / Review toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoApply(!autoApply)}
            className="h-7 px-2 text-xs cursor-pointer hover:bg-slate-800"
            title={autoApply
              ? 'Auto-build ON — AI changes apply to your schematic immediately (Ctrl+Z to undo)'
              : 'Review mode — AI changes wait for your approval before applying'}
          >
            <GitBranch className={`h-3.5 w-3.5 ${autoApply ? 'text-emerald-400' : 'text-amber-400'}`} />
            <span className="ml-1 hidden sm:inline">{autoApply ? 'Auto' : 'Review'}</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 cursor-pointer hover:bg-slate-800" title="Close (AI keeps working in the background)">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Token usage bar */}
      {totalTokens.total > 0 && (
        <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/50 px-4 py-1.5 text-[10px] text-slate-500">
          <span className="font-mono">Tokens:</span>
          <span>↑ {totalTokens.prompt.toLocaleString()}</span>
          <span>↓ {totalTokens.completion.toLocaleString()}</span>
          <span className="font-mono text-cyan-400">Σ {totalTokens.total.toLocaleString()}</span>
          <button
            onClick={resetTokens}
            className="ml-auto cursor-pointer text-slate-600 hover:text-slate-400"
            title="Reset token counter"
          >
            reset
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-4">
          {selectedProvider === 'custom' && !customEndpoint.baseUrl && !active && (
            <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-200">
              <p className="font-medium">Custom AI endpoint needs setup.</p>
              <p className="mt-1 text-amber-200/80">
                Open settings (gear icon above) and enter the API URL, model, and key —
                e.g. a local Ollama (<span className="font-mono">http://localhost:11434/v1</span>) or any OpenAI-compatible agent.
              </p>
              <button
                onClick={() => setSettingsOpen(true)}
                className="mt-2 cursor-pointer rounded bg-amber-800/60 px-2 py-1 font-medium text-amber-100 hover:bg-amber-700/60"
              >
                Open settings
              </button>
            </div>
          )}
          {selectedProvider === 'custom' && !!customEndpoint.baseUrl && !customEndpoint.apiKey.trim() && customEndpointNeedsKey(customEndpoint.baseUrl) && !active && (
            <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-200">
              <p className="font-medium">
                {(findPresetByUrl(customEndpoint.baseUrl)?.label ?? 'This endpoint')} needs an API key.
              </p>
              <p className="mt-1 text-amber-200/80">
                {(() => {
                  const preset = findPresetByUrl(customEndpoint.baseUrl);
                  return preset
                    ? <>Get a key at {preset.keyUrl} and paste it in settings — requests without one are rejected (HTTP 401).</>
                    : <>Paste a key in settings — hosted endpoints reject keyless requests (HTTP 401).</>;
                })()}
              </p>
              <button
                onClick={() => setSettingsOpen(true)}
                className="mt-2 cursor-pointer rounded bg-amber-800/60 px-2 py-1 font-medium text-amber-100 hover:bg-amber-700/60"
              >
                Open settings
              </button>
            </div>
          )}
          {messages.length === 0 && !active && (
            <div className="space-y-3">
              <div className="rounded-lg border border-purple-900/30 bg-purple-950/20 p-4 text-sm text-slate-300">
                <p className="mb-2 font-medium text-purple-300">Hi! I'm your AI circuit design assistant.</p>
                <p className="text-slate-400">
                  I build circuits <strong className="text-slate-200">directly on your canvas</strong> — you'll
                  watch every component and wire appear live as I work, then I verify the design by
                  simulation. One <kbd className="rounded bg-slate-900 px-1 text-[10px] text-cyan-300">Ctrl+Z</kbd> undoes everything I did.
                </p>
              </div>
              {SUGGESTED_PROMPTS.map(prompt => (
                <button
                  key={prompt}
                  onClick={() => send(prompt)}
                  className="block w-full rounded-lg border border-slate-800 bg-slate-900 p-3 text-left text-sm text-slate-300 transition-colors hover:border-purple-700 hover:bg-slate-800"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          {messages.map(msg => (
            <MessageBubble key={msg.id} message={msg} isActive={active?.assistantMsgId === msg.id} />
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-slate-800 p-3">
        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isLoading ? 'AI is working — press Stop to interrupt…' : 'Ask me to build, analyze, or debug a circuit…'}
            className="min-h-15 max-h-50 resize-none bg-slate-900 pr-12 text-sm text-slate-100 placeholder:text-slate-500"
          />
          <Button
            onClick={handleSendClick}
            disabled={!isLoading && !input.trim()}
            size="icon"
            title={isLoading ? 'Stop the AI' : 'Send'}
            className={`absolute bottom-2 right-2 h-8 w-8 ${isLoading ? 'bg-rose-600 hover:bg-rose-500' : ''}`}
          >
            {isLoading
              ? <Square className="h-3.5 w-3.5 fill-current" />
              : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-1 px-1 text-[10px] text-slate-600">
          {isLoading
            ? (active?.phase === 'reconnecting' || active?.phase === 'restarting')
              ? 'Reconnecting — your request continues on the server'
              : 'Enter to send · Shift+Enter for newline · Ctrl+Z to undo AI changes'
            : 'Enter to send · Shift+Enter for newline · Ctrl+Z to undo AI changes'}
        </p>
      </div>

      {/* Custom endpoint settings dialog */}
      {settingsOpen && (
        <CustomEndpointDialog
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom endpoint settings — preset URL select + per-preset model select +
// API key. Presets cover Muse Spark, Gemini, DeepSeek, GPT, OpenRouter,
// Together, Groq (free), Ollama/LM Studio (local free). Stored in
// localStorage; sent per-request; never in env.
// ─────────────────────────────────────────────────────────────────────────────

function CustomEndpointDialog({ onClose }: { onClose: () => void }) {
  const customEndpoint = useChatSession(s => s.customEndpoint);
  const setCustomEndpoint = useChatSession(s => s.setCustomEndpoint);
  const setProvider = useChatSession(s => s.setProvider);
  const [presetId, setPresetId] = useState(customEndpoint.presetId || 'muse-spark');
  const preset = CUSTOM_ENDPOINT_PRESETS.find(p => p.id === presetId) ?? CUSTOM_ENDPOINT_PRESETS[0];
  const [url, setUrl] = useState(customEndpoint.baseUrl || preset.baseUrl);
  const [key, setKey] = useState(customEndpoint.apiKey);
  const [model, setModelState] = useState(customEndpoint.model || preset.models[0]?.id || '');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const pickPreset = (id: string) => {
    const p = CUSTOM_ENDPOINT_PRESETS.find(x => x.id === id);
    if (!p) return;
    setPresetId(id);
    setUrl(p.baseUrl);
    setModelState(p.models[0]?.id || '');
    setTestResult(null);
  };

  // Pasted a raw URL — recognize it as a preset when it matches.
  const onUrlChange = (v: string) => {
    setUrl(v);
    const hit = findPresetByUrl(v);
    if (hit && hit.id !== presetId) {
      setPresetId(hit.id);
      if (!model || !hit.models.some(m => m.id === model)) setModelState(hit.models[0]?.id || '');
    }
  };

  const save = () => {
    setCustomEndpoint({ baseUrl: url.trim(), apiKey: key, model: model.trim(), presetId });
    setProvider('custom');
    onClose();
  };

  const testConnection = async () => {
    const base = url.trim().replace(/\/+$/, '');
    if (!base) {
      setTestResult({ ok: false, message: 'Pick a preset or enter an API URL first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      // Token-cheap probe: /models list when available (no completion tokens).
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = `Bearer ${key}`;
      let res = await fetch(`${base}/models`, { headers });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const ids: string[] = Array.isArray(data?.data) ? data.data.map((m: { id?: string }) => m.id).filter(Boolean) : [];
        const hasModel = model.trim() ? ids.includes(model.trim()) : true;
        setTestResult({
          ok: true,
          message: ids.length > 0
            ? `Connected — ${ids.length} model(s).${model.trim() && !hasModel ? ` Note: "${model.trim()}" not in list.` : ''}`
            : 'Connected — endpoint reachable.',
        });
      } else {
        // No /models route — try a minimal chat completion instead (4 tokens).
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: model.trim() || 'default', messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
        });
        if (res.ok) setTestResult({ ok: true, message: 'Connected — chat endpoint answered.' });
        else setTestResult({ ok: false, message: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` });
      }
    } catch (e) {
      setTestResult({ ok: false, message: `Unreachable: ${(e as Error).message.slice(0, 160)}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="AI provider settings"
    >
      <div
        className="max-h-full w-full max-w-sm overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">AI provider settings</h3>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7 cursor-pointer hover:bg-slate-800" title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-slate-400">
          Pick an endpoint, pick a model, paste a key — the assistant uses it immediately.
          The key stays in your browser (localStorage) and is only sent to your endpoint.
        </p>
        <label className="mb-1 block text-xs font-medium text-slate-300" htmlFor="ai-custom-preset">
          API URL <span className="font-normal text-slate-500">(preset — select, no typing)</span>
        </label>
        <Select value={presetId} onValueChange={pickPreset}>
          <SelectTrigger id="ai-custom-preset" className="mb-1 h-8 w-full gap-1 border-slate-700 bg-slate-950 px-2.5 text-xs text-slate-100 cursor-pointer hover:border-slate-600">
            <SelectValue placeholder="Endpoint…" />
          </SelectTrigger>
          <SelectContent>
            {CUSTOM_ENDPOINT_PRESETS.map(p => (
              <SelectItem key={p.id} value={p.id} className="cursor-pointer">
                <div className="flex flex-col">
                  <span className="text-xs font-medium">{p.label}</span>
                  <span className="font-mono text-[10px] text-slate-500">{p.baseUrl}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://…/v1"
          spellCheck={false}
          aria-label="Custom API base URL"
          className="mb-3 w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-[11px] text-slate-400 placeholder:text-slate-600 focus:border-cyan-600 focus:outline-none"
        />
        <label className="mb-1 block text-xs font-medium text-slate-300" htmlFor="ai-custom-model">
          Model <span className="font-normal text-slate-500">(top free + flagship-smart per endpoint)</span>
        </label>
        <Select value={model} onValueChange={(v) => setModelState(v)}>
          <SelectTrigger id="ai-custom-model" className="mb-3 h-8 w-full gap-1 border-slate-700 bg-slate-950 px-2.5 text-xs text-slate-100 cursor-pointer hover:border-slate-600">
            <SelectValue placeholder="Model…" />
          </SelectTrigger>
          <SelectContent>
            {preset.models.map(m => (
              <SelectItem key={m.id} value={m.id} className="cursor-pointer">
                <div className="flex flex-col">
                  <span className="text-xs font-medium">
                    {m.label}
                    {m.free && <span className="ml-1 text-emerald-400">●</span>}
                  </span>
                  <span className="font-mono text-[10px] text-slate-500">{m.id} — {m.description}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="mb-1 block text-xs font-medium text-slate-300" htmlFor="ai-custom-key">
          API key <span className="font-normal text-slate-500">({preset.keyPlaceholder}) — </span>
          <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="font-normal text-cyan-400 hover:underline" onClick={(e) => e.stopPropagation()}>
            get key
          </a>
        </label>
        <div className="relative mb-1">
          <input
            id="ai-custom-key"
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={preset.keyPlaceholder}
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 pr-14 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-600 focus:outline-none"
          />
          <button
            onClick={() => setShowKey(!showKey)}
            className="absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:text-slate-300"
            title={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? 'hide' : 'show'}
          </button>
        </div>
        <p className="mb-3 text-[10px] leading-relaxed text-slate-600">
          Stored only in this browser. Requests go browser → your Next.js server → your endpoint (server-to-server, no CORS issues).
        </p>
        {testResult && (
          <p className={`mb-3 rounded-md border px-2 py-1.5 text-xs ${testResult.ok ? 'border-emerald-800/60 bg-emerald-950/30 text-emerald-200' : 'border-rose-800/60 bg-rose-950/30 text-rose-200'}`}>
            {testResult.message}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={testConnection}
            disabled={testing}
            className="h-8 cursor-pointer text-xs hover:bg-slate-800"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Test'}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 cursor-pointer text-xs hover:bg-slate-800">
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!url.trim() || !model.trim()} className="h-8 cursor-pointer text-xs">
            Save & use
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Live status pill
// ─────────────────────────────────────────────────────────────────────────────

function StatusLine({ message }: { message: ChatMessage }) {
  const active = useChatSession(s => s.active);
  if (!active || active.assistantMsgId !== message.id) return null;

  const Icon =
    active.phase === 'reconnecting' || active.phase === 'restarting' ? WifiOff
      : active.phase === 'stopping' ? SquareSlash
        : Loader2;
  const color =
    active.phase === 'reconnecting' || active.phase === 'restarting' ? 'text-amber-400'
      : active.phase === 'stopping' ? 'text-rose-400'
        : 'text-purple-400';

  return (
    <div className={`mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${active.phase === 'reconnecting' || active.phase === 'restarting'
      ? 'border-amber-800/50 bg-amber-950/20 text-amber-200'
      : 'border-purple-900/40 bg-purple-950/20 text-slate-300'
      }`}>
      <Icon className={`h-3.5 w-3.5 ${color} ${active.phase === 'stopping' ? '' : 'animate-spin'}`} aria-hidden="true" />
      <span className="flex-1">{active.statusText}</span>
      {active.reconnectAttempt > 0 && (
        <span className="rounded bg-amber-900/50 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
          retry {active.reconnectAttempt}
        </span>
      )}
      <span className="sr-only" role="status">{active.statusText}</span>
    </div>
  );
}

/** Live elapsed-seconds counter (only while the turn is running). */
function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <span className="font-mono text-[10px] text-slate-500">{s}s</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Working-progress accordion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The AI's streamed narration, collapsed by default so the chat never turns
 * into an ever-growing wall of text. While the turn runs the header pulses;
 * afterwards it becomes a quiet "Worked for Xs" summary (Claude-style).
 */
function ProgressAccordion({ message, isActive }: { message: ChatMessage; isActive: boolean }) {
  const active = useChatSession(s => s.active);
  const [open, setOpen] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const text = message.progressText ?? '';

  // Keep the open panel pinned to the newest line while streaming.
  useEffect(() => {
    if (open && isActive && textRef.current) {
      textRef.current.scrollTop = textRef.current.scrollHeight;
    }
  }, [text, open, isActive]);

  // Nothing to show: never streamed narration, or it's identical to the final
  // answer already displayed in the bubble (stopped turns). Checked AFTER the
  // hooks — hooks must run unconditionally.
  if (!text || text === message.content) return null;

  const connecting = isActive && active?.phase === 'connecting';
  const title = isActive
    ? 'Working progress'
    : `Worked for ${formatDuration(message.durationMs ?? 0)}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={`group flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer ${isActive
          ? 'border-purple-800/60 bg-purple-950/30 hover:bg-purple-950/50'
          : 'border-slate-800 bg-slate-900/50 hover:bg-slate-800/60'
          }`}
        aria-expanded={open}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
          : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
        {isActive ? (
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-purple-400" />
          </span>
        ) : (
          <Clock className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
        )}
        <span className={`flex-1 font-medium ${isActive ? 'animate-pulse text-purple-200' : 'text-slate-400'}`}>
          {title}
        </span>
        {isActive && active && <ElapsedTimer startedAt={active.startedAt} />}
        {isActive && connecting && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" aria-hidden="true" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          ref={textRef}
          className={`mt-1 whitespace-pre-wrap wrap-break-word rounded-md border border-slate-800/60 bg-slate-950/60 p-2.5 text-xs leading-relaxed text-slate-400 ${SCROLL_AREA}`}
        >
          {text}
          {isActive && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-purple-400 align-middle" aria-hidden="true" />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps accordion
// ─────────────────────────────────────────────────────────────────────────────

function StepRow({ step }: { step: ToolCallEntry & { live?: string } }) {
  const [open, setOpen] = useState(false);
  const failed = !!step.error;
  const live = step.live; // synthetic in-flight step (label = live status)
  const hasDetails = !live && (step.args !== undefined || step.result !== undefined || failed);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-800/40">
        {live ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-purple-400" aria-hidden="true" />
        ) : failed ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
        )}
        {live ? (
          <span className="flex-1 truncate text-xs text-purple-300">{live}</span>
        ) : hasDetails ? (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 cursor-pointer items-center gap-1.5 truncate text-left text-xs text-slate-300 hover:text-slate-100"
              title={`${step.name} — click for details`}
            >
              <span className="truncate">{stepLabelFor(step.name)}</span>
              {open
                ? <ChevronDown className="h-3 w-3 shrink-0 text-slate-600" />
                : <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />}
            </button>
          </CollapsibleTrigger>
        ) : (
          <span className="flex-1 truncate text-xs text-slate-300">{stepLabelFor(step.name)}</span>
        )}
        {!live && (
          <span className="hidden font-mono text-[9px] text-slate-600 sm:inline">{step.name}</span>
        )}
      </div>
      <CollapsibleContent>
        <div className="mb-1 ml-6 space-y-1 rounded border border-slate-800/50 bg-slate-950/50 p-2 text-xs">
          <div className="flex items-center gap-1.5 text-slate-500">
            <Wrench className="h-3 w-3" aria-hidden="true" />
            <span className="font-mono">{step.name}</span>
          </div>
          {step.args !== undefined && (
            <div>
              <span className="text-slate-500">Args:</span>
              <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-slate-900 p-1.5 text-slate-300 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-700">
                {JSON.stringify(step.args, null, 2)}
              </pre>
            </div>
          )}
          {step.result !== undefined && (
            <div>
              <span className="text-slate-500">Result:</span>
              <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-slate-900 p-1.5 text-slate-300 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-700">
                {JSON.stringify(step.result, null, 2)}
              </pre>
            </div>
          )}
          {failed && (
            <div>
              <span className="text-rose-400">Error:</span>
              <pre className="mt-0.5 overflow-x-auto rounded bg-rose-950/30 p-1.5 text-rose-300">{step.error}</pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The tool-call history as a compact step list. While the turn runs, the
 * header carries a spinner and the current activity appears as a live
 * in-flight step at the bottom of the list.
 */
function StepsAccordion({ message, isActive }: { message: ChatMessage; isActive: boolean }) {
  const active = useChatSession(s => s.active);
  const [open, setOpen] = useState(false);
  const steps = message.toolCalls ?? [];
  if (steps.length === 0 && !isActive) return null;

  const failed = steps.some(s => s.error);
  const liveStatus = isActive ? active?.statusText : undefined;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={`group flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer ${isActive
          ? 'border-cyan-900/50 bg-cyan-950/20 hover:bg-cyan-950/40'
          : 'border-slate-800 bg-slate-900/50 hover:bg-slate-800/60'
          }`}
        aria-expanded={open}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
          : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
        <ClipboardList className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-cyan-400' : 'text-slate-500'}`} aria-hidden="true" />
        <span className="flex-1 font-medium text-slate-400">Steps</span>
        <span className="font-mono text-[10px] text-slate-500">{steps.length}</span>
        {isActive ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" aria-hidden="true" />
        ) : failed ? (
          <AlertCircle className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" />
        ) : steps.length > 0 ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={`mt-1 space-y-0.5 rounded-md border border-slate-800/60 bg-slate-950/60 p-1.5 ${SCROLL_AREA}`}>
          {steps.map((tc, i) => (
            <StepRow key={i} step={tc} />
          ))}
          {liveStatus && (
            <StepRow key="live" step={{ name: 'In progress', args: undefined, ok: true, live: liveStatus }} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit summary — BOM + wire connections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two things that matter about a built circuit: what parts it uses
 * (bill of materials) and how they are wired (net connections). Computed
 * deterministically from the applied document — never from model text.
 */
function CircuitSummaryCard({ components, wires }: { components: CircuitComponent[]; wires: Wire[] }) {
  const summary = useMemo(
    () => summarizeCircuitDoc(components ?? [], wires ?? []),
    [components, wires],
  );
  if (summary.componentCount === 0) return null;

  return (
    <div className="ml-6 overflow-hidden rounded-lg border border-slate-700/60 bg-slate-900/70">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2">
        <CircuitBoard className="h-4 w-4 text-cyan-400" aria-hidden="true" />
        <span className="text-xs font-semibold text-slate-200">Circuit summary</span>
        <span className="ml-auto font-mono text-[10px] text-slate-500">
          {summary.componentCount} components · {summary.wireCount} wires · {summary.netCount} nets
        </span>
      </div>

      {/* Bill of Materials */}
      <div className="border-b border-slate-800 px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          <span>Bill of Materials</span>
        </div>
        <div className={SCROLL_AREA}>
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-900 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-medium">Qty</th>
                <th className="py-1 pr-2 font-medium">Part</th>
                <th className="py-1 pr-2 font-medium">Value</th>
                <th className="py-1 font-medium">Refs</th>
              </tr>
            </thead>
            <tbody>
              {summary.bom.map((e, i) => (
                <tr key={i} className="border-t border-slate-800/60 align-top">
                  <td className="py-1 pr-2 font-mono text-cyan-300">{e.count}×</td>
                  <td className="py-1 pr-2 text-slate-300">{e.name}</td>
                  <td className="py-1 pr-2 font-mono text-amber-300">{e.value || '—'}</td>
                  <td className="py-1 font-mono text-[10px] leading-relaxed text-slate-500">{e.refdes.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Wire connections */}
      <div className="px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          <Cable className="h-3 w-3" aria-hidden="true" />
          <span>Wire connections</span>
        </div>
        <div className={SCROLL_AREA}>
          <ul className="space-y-1">
            {summary.nets.map((net, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-slate-800/60 py-1 first:border-t-0">
                <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${net.name === 'GND'
                  ? 'bg-slate-800 text-slate-300'
                  : net.name.startsWith('+')
                    ? 'bg-rose-950/60 text-rose-300'
                    : 'bg-cyan-950/60 text-cyan-300'
                  }`}>
                  {net.name}
                </span>
                <span className="font-mono text-[10px] leading-relaxed text-slate-500">
                  {net.members.join('  ·  ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Missing components — what the AI asked for but the library doesn't have
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The AI records every component type it tried to add that doesn't exist in
 * the library. This card tells the user exactly what to create (Symbol
 * Editor / Sub-Circuit) so the AI can finish the job on the next message.
 */
function MissingComponentsCard({ types }: { types: string[] }) {
  if (types.length === 0) return null;
  return (
    <div className="ml-6 overflow-hidden rounded-lg border border-amber-700/60 bg-amber-950/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-amber-900/40 px-3 py-2">
        <PackageX className="h-4 w-4 text-amber-400" aria-hidden="true" />
        <span className="text-xs font-semibold text-amber-200">Missing components</span>
        <span className="ml-auto font-mono text-[10px] text-amber-400/80">
          {types.length} type{types.length === 1 ? '' : 's'} the AI needs
        </span>
      </div>
      <div className="px-3 py-2">
        <p className="mb-2 text-[11px] leading-relaxed text-amber-200/80">
          The AI tried to place these components but they are not in the library yet. Create them
          (Symbol Editor or Sub-Circuit dialog) and ask the AI to continue — it will pick them up.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {types.map((t) => (
            <span
              key={t}
              className="rounded border border-amber-800/60 bg-amber-900/30 px-2 py-0.5 font-mono text-[11px] text-amber-200"
              title={`Component type "${t}" is not registered`}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Message bubbles
// ─────────────────────────────────────────────────────────────────────────────

function MessageBubble({ message, isActive }: { message: ChatMessage; isActive: boolean }) {
  const applyPendingDiff = useChatSession(s => s.applyPendingDiff);
  const dismissPendingDiff = useChatSession(s => s.dismissPendingDiff);
  const retryLast = useChatSession(s => s.retryLast);
  const undo = useEditor(s => s.undo);

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-purple-600 px-3 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  const hasMutating = message.toolCalls?.some(tc => MUTATING_TOOLS.has(tc.name));
  const hasContent = !!message.content;
  const summaryDoc = message.appliedDoc ?? (message.pendingDiff
    ? { components: message.pendingDiff.components, wires: message.pendingDiff.wires }
    : null);

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-2">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 shrink-0">
            <Sparkles className="h-4 w-4 text-purple-400" />
          </div>
          <div
            className={`flex-1 space-y-2 rounded-lg rounded-tl-sm px-3 py-2 text-sm ${message.error
              ? 'border border-rose-800 bg-rose-950/30 text-rose-200'
              : 'border border-slate-800 bg-slate-900 text-slate-200'
              }`}
          >
            {isActive && <StatusLine message={message} />}

            {/* While streaming, the narration lives in the progress accordion
                below — the bubble itself stays compact. */}
            {message.loading && !hasContent ? (
              !isActive ? (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  <span>Thinking…</span>
                </div>
              ) : null
            ) : null}

            {hasContent && (
              <div className="whitespace-pre-wrap wrap-break-word">{message.content}</div>
            )}

            {message.stopped && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                <Square className="h-3 w-3" />
                <span>Stopped — partial results kept</span>
              </div>
            )}
          </div>
        </div>

        {/* Provider-not-configured setup card */}
        {message.errorKind === 'config' && (
          <SetupCard />
        )}

        {/* Error with retry — pass the FAILED message id so retryLast re-sends
            THIS turn's user message, not whatever the user sent most recently. */}
        {message.error && message.retryable && (
          <div className="ml-6 flex items-center gap-2">
            <Button size="sm" onClick={() => retryLast(message.id)} className="h-7 bg-purple-600 text-xs hover:bg-purple-500">
              <RotateCcw className="mr-1 h-3 w-3" />
              Retry request
            </Button>
            <span className="text-[10px] text-slate-500">Re-sends this turn's message</span>
          </div>
        )}

        {/* App-side rate limit — distinct from a provider-quota 429: the AI
            service is fine, the client is simply sending too fast. */}
        {message.errorKind === 'rate-limit' && (
          <div className="ml-6 flex items-center gap-1.5 text-xs text-amber-400">
            <Clock className="h-3 w-3" aria-hidden="true" />
            <span>App rate limit — wait a moment, then press Retry</span>
          </div>
        )}

        {/* Applied bar — the auto-mode outcome (replaces the old accept gate) */}
        {!message.loading && message.applied && !message.pendingDiff && (
          <div className="ml-6 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-800/50 bg-emerald-950/20 px-3 py-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span className="text-xs font-medium text-emerald-300">Applied to schematic</span>
            {message.appliedSummary && (
              <span className="rounded bg-emerald-900/50 px-2 py-0.5 font-mono text-[10px] text-emerald-200">
                {message.appliedSummary}
              </span>
            )}
            {hasMutating && (
              <Button
                size="sm"
                variant="ghost"
                onClick={undo}
                className="ml-auto h-6 px-2 text-xs text-slate-400 hover:text-slate-200"
              >
                <Undo2 className="mr-1 h-3 w-3" />
                Undo
              </Button>
            )}
          </div>
        )}

        {/* Pending diff preview (Review mode) */}
        {message.pendingDiff && (
          <div className="ml-6 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Eye className="h-4 w-4 text-amber-400" />
              <span className="text-xs font-medium text-amber-300">Circuit changes ready to apply</span>
              <span className="ml-auto rounded bg-amber-900/50 px-2 py-0.5 text-[10px] font-mono text-amber-200">
                {message.pendingDiff.summary}
              </span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => applyPendingDiff(message.id)} className="h-7 bg-emerald-600 text-xs hover:bg-emerald-500">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Apply changes
              </Button>
              <Button size="sm" variant="outline" onClick={() => dismissPendingDiff(message.id)} className="h-7 border-slate-700 text-xs">
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* BOM + wire connections — the things that matter about the circuit */}
        {summaryDoc && (
          <CircuitSummaryCard components={summaryDoc.components} wires={summaryDoc.wires} />
        )}

        {/* Missing components — the AI is blocked on library availability */}
        {message.missingComponents && message.missingComponents.length > 0 && (
          <MissingComponentsCard types={message.missingComponents} />
        )}

        {/* PCB chip — this turn also produced/updated a PCB layout */}
        {message.pcbUpdated && (
          <div className="ml-6 inline-flex items-center gap-1.5 rounded-lg border border-emerald-800/50 bg-emerald-950/20 px-3 py-1.5">
            <CircuitBoard className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            <span className="text-xs font-medium text-emerald-300">PCB layout updated</span>
            <span className="text-[10px] text-emerald-400/70">see the PCB tab</span>
          </div>
        )}

        {/* Steps (tool calls) accordion */}
        <div className="ml-6">
          <StepsAccordion message={message} isActive={isActive} />
        </div>

        {/* Working-progress narration accordion */}
        <div className="ml-6">
          <ProgressAccordion message={message} isActive={isActive} />
        </div>
      </div>
    </div>
  );
}

function SetupCard() {
  return (
    <div className="ml-6 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3 text-xs text-slate-300">
      <div className="mb-2 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-amber-400" />
        <span className="font-medium text-amber-300">Enable the AI assistant on this server</span>
      </div>
      <p className="mb-2 text-slate-400">
        The AI backend works inside the Z.ai sandbox out of the box. On any other deployment (Vercel, Docker,
        your own domain), set <strong>one</strong> of these environment variables and restart — all requests
        run server-to-server, so it works from any domain with no CORS setup:
      </p>
      <ul className="mb-2 list-disc space-y-1 pl-4 text-slate-400">
        <li>
          <code className="rounded bg-slate-900 px-1 font-mono text-cyan-300">ZAI_API_KEY</code>
          {' '}— Z.ai public API (recommended). Create a key at{' '}
          <a href="https://z.ai/manage-apikey/apikey-list" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-purple-300 underline hover:text-purple-200">
            z.ai <ExternalLink className="h-3 w-3" />
          </a>
          {' '}(GLM-4.6 / GLM-4.5 / GLM-4 Flash). Optionally set <code className="rounded bg-slate-900 px-1 font-mono text-cyan-300">ZAI_BASE_URL</code> to use a different OpenAI-compatible endpoint.
        </li>
        <li>
          <code className="rounded bg-slate-900 px-1 font-mono text-cyan-300">OPENAI_API_KEY</code>
          {' '}— OpenAI (GPT-4o, GPT-4.1 …)
        </li>
        <li>
          <code className="rounded bg-slate-900 px-1 font-mono text-cyan-300">ANTHROPIC_API_KEY</code>
          {' '}— Anthropic (Claude)
        </li>
      </ul>
      <p className="text-slate-500">Then reload this page — the provider dropdown will pick it up automatically.</p>
    </div>
  );
}
