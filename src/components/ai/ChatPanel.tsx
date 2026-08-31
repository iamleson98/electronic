'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChatSession, type ChatMessage, type ToolCallEntry } from '@/lib/ai/chat-session';
import { useEditor } from '@/lib/circuit/store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ChevronDown, ChevronRight, Send, Sparkles, Loader2, X, AlertCircle, CheckCircle2,
  Wrench, Undo2, Eye, GitBranch, Cpu, KeyRound, ExternalLink, Square, WifiOff,
  SquareSlash, RotateCcw,
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
  'schematic.loadDocument', 'examples.load', 'design.buildPattern',
]);

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
  const totalTokens = useChatSession(s => s.totalTokens);
  const resetTokens = useChatSession(s => s.resetTokens);
  const send = useChatSession(s => s.send);
  const stop = useChatSession(s => s.stop);

  const isLoading = !!active;

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
    <div className="flex h-full w-full flex-col border-l border-slate-800 bg-slate-950">
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
                    onValueChange={(v) => setProvider(v as 'zai' | 'openai' | 'anthropic')}
                    disabled={providersLoading || providers.length === 0}
                  >
                    <SelectTrigger className="h-7 w-[130px] gap-1 border-slate-700 bg-slate-800 px-2 text-xs text-slate-200 cursor-pointer hover:border-slate-600">
                      <Cpu className="h-3 w-3 text-cyan-400" />
                      <SelectValue placeholder="Provider…" />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map(p => (
                        <SelectItem
                          key={p.name}
                          value={p.name}
                          disabled={!p.available}
                          className="cursor-pointer"
                        >
                          <div className="flex flex-col">
                            <span className="text-xs font-medium">{p.label}</span>
                            <span className={`text-[10px] ${p.available ? 'text-slate-400' : 'text-amber-400'}`}>
                              {p.available ? `${p.models.length} models` : `needs ${p.requiresKey}`}
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
          {/* Model selector */}
          {(() => {
            const provider = providers.find(p => p.name === selectedProvider);
            const models = provider?.models ?? [];
            if (models.length === 0) return null;
            return (
              <Select
                value={selectedModel}
                onValueChange={(v) => setModel(v)}
                disabled={providersLoading}
              >
                <SelectTrigger className="h-7 w-[160px] gap-1 border-slate-700 bg-slate-800 px-2 text-xs text-slate-200 cursor-pointer hover:border-slate-600">
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
            className="min-h-[60px] max-h-[200px] resize-none bg-slate-900 pr-12 text-sm text-slate-100 placeholder:text-slate-500"
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Message bubbles
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
    <div className={`mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${
      active.phase === 'reconnecting' || active.phase === 'restarting'
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

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-2">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex-shrink-0">
            <Sparkles className="h-4 w-4 text-purple-400" />
          </div>
          <div
            className={`flex-1 rounded-lg rounded-tl-sm px-3 py-2 text-sm ${
              message.error
                ? 'border border-rose-800 bg-rose-950/30 text-rose-200'
                : 'border border-slate-800 bg-slate-900 text-slate-200'
            }`}
          >
            {isActive && <StatusLine message={message} />}

            {message.loading && !message.content ? (
              <div className="flex items-center gap-2 text-slate-400">
                <span className="ml-1 text-xs">{isActive ? '' : 'Thinking…'}</span>
              </div>
            ) : null}

            {(message.content || !message.loading) && (
              <div className="whitespace-pre-wrap break-words">
                {message.content}
                {message.loading && message.content && (
                  <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-purple-400 align-middle" aria-hidden="true" />
                )}
              </div>
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

        {/* Error with retry */}
        {message.error && message.retryable && (
          <div className="ml-6 flex items-center gap-2">
            <Button size="sm" onClick={retryLast} className="h-7 bg-purple-600 text-xs hover:bg-purple-500">
              <RotateCcw className="mr-1 h-3 w-3" />
              Retry request
            </Button>
            <span className="text-[10px] text-slate-500">Re-sends your last message</span>
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
            <div className="mb-2 text-xs text-slate-400">
              {message.pendingDiff.components.length} components · {message.pendingDiff.wires.length} wires
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

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="ml-6 space-y-1">
            {message.toolCalls.map((tc, i) => (
              <ToolCallDisplay key={i} toolCall={tc} />
            ))}
          </div>
        )}
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

// ─────────────────────────────────────────────────────────────────────────────
// Tool call chips
// ─────────────────────────────────────────────────────────────────────────────

function ToolCallDisplay({ toolCall }: { toolCall: ToolCallEntry }) {
  const [open, setOpen] = useState(false);
  const success = toolCall.ok;
  const hasResult = toolCall.result !== undefined;
  const hasError = !!toolCall.error;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded border border-slate-800 bg-slate-900/50 px-2 py-1 text-left text-xs hover:bg-slate-800">
        {open ? <ChevronDown className="h-3 w-3 text-slate-500" /> : <ChevronRight className="h-3 w-3 text-slate-500" />}
        <Wrench className="h-3 w-3 text-slate-500" />
        <span className="font-mono text-slate-400">{toolCall.name}</span>
        {success && !hasError && <CheckCircle2 className="ml-auto h-3 w-3 text-emerald-500" />}
        {hasError && <AlertCircle className="ml-auto h-3 w-3 text-rose-500" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1 rounded border border-slate-800/50 bg-slate-950/50 p-2 text-xs">
          <div>
            <span className="text-slate-500">Args:</span>
            <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-slate-900 p-1.5 text-slate-300">
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
          </div>
          {hasResult && (
            <div>
              <span className="text-slate-500">Result:</span>
              <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-slate-900 p-1.5 text-slate-300">
                {JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
          {hasError && (
            <div>
              <span className="text-rose-400">Error:</span>
              <pre className="mt-0.5 overflow-x-auto rounded bg-rose-950/30 p-1.5 text-rose-300">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
