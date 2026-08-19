'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { usePCB } from '@/lib/pcb/store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ChevronDown, ChevronRight, Send, Sparkles, Loader2, X, AlertCircle, CheckCircle2, Wrench, Undo2, Eye, GitBranch, Cpu } from 'lucide-react';
import { toast } from 'sonner';

// ─────────────────────────────────────────────────────────────────────────────
// Provider selection — fetched once on mount from /api/ai/providers.
// Persisted to localStorage so the user's choice survives reloads.
// ─────────────────────────────────────────────────────────────────────────────

interface ModelInfo {
  id: string;
  label: string;
  description: string;
  free: boolean;
}

interface ProviderInfo {
  name: 'zai' | 'openai' | 'anthropic';
  label: string;
  available: boolean;
  requiresKey: string | null;
  model: string;
  models: ModelInfo[];
}

const PROVIDER_STORAGE_KEY = 'circuit-lab.ai-provider';
const MODEL_STORAGE_KEY = 'circuit-lab.ai-model';

function loadStoredProvider(): 'zai' | 'openai' | 'anthropic' | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (v === 'zai' || v === 'openai' || v === 'anthropic') return v;
  } catch { /* localStorage disabled */ }
  return null;
}

function storeProvider(name: 'zai' | 'openai' | 'anthropic') {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(PROVIDER_STORAGE_KEY, name); } catch { /* ignore */ }
}

function loadStoredModel(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY);
  } catch { return null; }
}

function storeModel(model: string) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(MODEL_STORAGE_KEY, model); } catch { /* ignore */ }
}

interface ToolCallEntry {
  name: string;
  args: any;
  result?: any;
  error?: string;
  ok: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallEntry[];
  timestamp: number;
  loading?: boolean;
  error?: string;
  pendingDiff?: {
    components: any[];
    wires: any[];
    summary: string;
  };
  /** Token usage for this message (from the AI provider's response). */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface CircuitSnapshot {
  components: any[];
  wires: any[];
}

const SUGGESTED_PROMPTS = [
  'Build an LED blinker with a 555 timer',
  'Create an RC low-pass filter and verify the cutoff frequency',
  'Why doesn\'t my circuit work? Diagnose it',
  'Explain Ohm\'s Law and how it applies to my circuit',
  'What if I changed R1 to 10k? Compare the results',
];

// Tools that mutate the circuit (require undo checkpoint)
const MUTATING_TOOLS = new Set([
  'schematic.addComponent', 'schematic.removeComponent', 'schematic.moveComponent',
  'schematic.rotateComponent', 'schematic.setParameter', 'schematic.addWire',
  'schematic.removeWire', 'schematic.clear', 'schematic.reannotate',
  'schematic.loadDocument', 'examples.load',
]);

// Tools that require client-side PCB action
const PCB_TOOLS = new Set(['pcb.importFromSchematic', 'pcb.autoRoute', 'pcb.topoRoute', 'pcb.runDRC']);

// Tools that require client-side simulation action
const SIM_CONTROL_TOOLS = new Set(['simulate.start', 'simulate.pause', 'simulate.reset', 'simulate.setSpeed']);

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [autoApply, setAutoApply] = useState(false); // When false, show diff preview before applying
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Listen for external "ask AI" prompts (from ProbePanel, PropertyPanel, etc.)
  // Fills the input and auto-sends after a short delay.
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

  // AI provider + model selection state
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<'zai' | 'openai' | 'anthropic'>('zai');
  const [selectedModel, setSelectedModel] = useState<string>('glm-4.6');
  const [providersLoading, setProvidersLoading] = useState(true);
  // Cumulative token usage across all messages in this session
  const [totalTokens, setTotalTokens] = useState({ prompt: 0, completion: 0, total: 0 });

  // Fetch available providers on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/providers');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setProviders(data.providers || []);
        // Initialize selection: prefer localStorage, fall back to server default, then 'zai'.
        const stored = loadStoredProvider();
        const serverDefault = data.default as 'zai' | 'openai' | 'anthropic' | undefined;
        const initial = stored || serverDefault || 'zai';
        // If the stored/default provider isn't available (missing API key), fall back to 'zai'.
        const info = (data.providers as ProviderInfo[]).find(p => p.name === initial);
        const providerName = info && info.available ? initial : 'zai';
        setSelectedProvider(providerName);
        // Initialize model: prefer localStorage, fall back to provider's default model.
        const storedModel = loadStoredModel();
        const providerInfo = (data.providers as ProviderInfo[]).find(p => p.name === providerName);
        if (providerInfo) {
          const modelToUse = storedModel && providerInfo.models.some(m => m.id === storedModel)
            ? storedModel
            : providerInfo.model;
          setSelectedModel(modelToUse);
        }
      } catch (e) {
        // Network or server error — default to Z.ai (always available).
        if (!cancelled) {
          setProviders([
            { name: 'zai', label: 'Z.ai (GLM)', available: true, requiresKey: null, model: 'glm-4.6', models: [
              { id: 'glm-4.6', label: 'GLM-4.6 (Default, Free)', description: 'Z.ai built-in model.', free: true },
            ] },
          ]);
          setSelectedProvider('zai');
          setSelectedModel('glm-4.6');
        }
      } finally {
        if (!cancelled) setProvidersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleProviderChange = useCallback((name: 'zai' | 'openai' | 'anthropic') => {
    setSelectedProvider(name);
    storeProvider(name);
    const info = providers.find(p => p.name === name);
    if (info) {
      // Switch to the provider's default model
      setSelectedModel(info.model);
      storeModel(info.model);
      toast.success(`AI provider: ${info.label}`);
    }
  }, [providers]);

  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    storeModel(modelId);
    const provider = providers.find(p => p.name === selectedProvider);
    const model = provider?.models.find(m => m.id === modelId);
    if (model) {
      toast.success(`Model: ${model.label}`);
    }
  }, [providers, selectedProvider]);

  // Editor + PCB stores
  const components = useEditor(s => s.components);
  const wires = useEditor(s => s.wires);
  const loadDocument = useEditor(s => s.loadDocument);
  const pushHistory = useEditor(s => s.pushHistory);
  const undo = useEditor(s => s.undo);
  const setRunning = useEditor(s => s.setRunning);
  const setSpeed = useEditor(s => s.setSpeed);
  const reset = useEditor(s => s.reset);

  // PCB store
  const runAutoRoute = usePCB(s => s.runAutoRoute);
  const runTopoRoute = usePCB(s => s.runTopoRoute);
  const runDRC = usePCB(s => s.runDRC);
  const importFromSchematic = usePCB(s => s.importFromSchematic);
  const setBoardSize = usePCB(s => s.setBoardSize);
  const setDefaultTraceWidth = usePCB(s => s.setDefaultTraceWidth);
  const setActiveLayer = usePCB(s => s.setActiveLayer);
  const addCopperPour = usePCB(s => s.addCopperPour);
  const generateTeardrops = usePCB(s => s.generateTeardrops);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const applyCircuitUpdate = useCallback((newComponents: any[], newWires: any[], isFinal: boolean) => {
    // Push current state to undo stack BEFORE applying (so Ctrl+Z reverts the AI change)
    pushHistory();
    loadDocument({
      version: 1,
      components: newComponents,
      wires: newWires,
    });
    if (isFinal) {
      toast.success('Circuit updated by AI — press Ctrl+Z to undo');
    }
  }, [pushHistory, loadDocument]);

  const handleClientSideAction = useCallback((tc: ToolCallEntry) => {
    if (tc.name === 'simulate.start') {
      setRunning(true);
      toast.success('Simulation started');
    } else if (tc.name === 'simulate.pause') {
      setRunning(false);
      toast.success('Simulation paused');
    } else if (tc.name === 'simulate.reset') {
      reset();
      toast.success('Simulation reset');
    } else if (tc.name === 'simulate.setSpeed') {
      setSpeed(tc.args.speed);
      toast.success(`Speed set to ${tc.args.speed}×`);
    } else if (tc.name === 'pcb.importFromSchematic') {
      importFromSchematic(useEditor.getState().components, useEditor.getState().wires);
      toast.success('Schematic imported to PCB');
    } else if (tc.name === 'pcb.autoRoute') {
      runAutoRoute();
      toast.success('Auto-route complete');
    } else if (tc.name === 'pcb.topoRoute') {
      const r = runTopoRoute();
      toast.success(`Topo-route: ${r.routed} routed, ${r.failed} failed`);
    } else if (tc.name === 'pcb.runDRC') {
      runDRC();
      toast.success('DRC complete');
    } else if (tc.name === 'pcb.setBoardSize') {
      setBoardSize(tc.args.width, tc.args.height);
      toast.success(`Board size set to ${tc.args.width}×${tc.args.height}mm`);
    } else if (tc.name === 'pcb.setDefaultTraceWidth') {
      setDefaultTraceWidth(tc.args.width);
      toast.success(`Trace width set to ${tc.args.width}mm`);
    } else if (tc.name === 'pcb.setActiveLayer') {
      setActiveLayer(tc.args.layer);
      toast.success(`Active layer: ${tc.args.layer}`);
    } else if (tc.name === 'pcb.addCopperPour') {
      addCopperPour(tc.args.layer, tc.args.net);
      toast.success(`Copper pour added on ${tc.args.layer} for ${tc.args.net}`);
    } else if (tc.name === 'pcb.generateTeardrops') {
      generateTeardrops();
      toast.success('Teardrops generated');
    }
  }, [setRunning, reset, setSpeed, importFromSchematic, runAutoRoute, runTopoRoute, runDRC, setBoardSize, setDefaultTraceWidth, setActiveLayer, addCopperPour, generateTeardrops]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    setIsLoading(true);
    setInput('');

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    const assistantMsgId = `a_${Date.now()}`;
    const loadingMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      loading: true,
      toolCalls: [],
    };
    setMessages(prev => [...prev, userMsg, loadingMsg]);

    // Capture circuit snapshot + live sim state for the AI
    const editorState = useEditor.getState();
    const circuitSnapshot: CircuitSnapshot = {
      components: JSON.parse(JSON.stringify(components)),
      wires: JSON.parse(JSON.stringify(wires)),
    };
    const simContext = editorState.simContext ? {
      nodeVoltage: Array.from(editorState.simContext.nodeVoltage),
      branchCurrent: Array.from(editorState.simContext.branchCurrent),
      time: editorState.simContext.time,
      dt: editorState.simContext.dt,
    } : null;
    const simError = editorState.simError || null;
    const simRunning = editorState.running;
    const selectedComponentId = editorState.selection?.type === 'component' ? editorState.selection.id : null;

    // Build message history for the API
    const apiMessages = [
      ...messages.filter(m => !m.loading && !m.error).map(m => ({
        role: m.role,
        content: m.content,
      })),
      { role: 'user' as const, content: text },
    ];

    try {
      const response = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          circuit: circuitSnapshot,
          simContext,
          simError,
          simRunning,
          selectedComponentId,
          provider: selectedProvider,
          model: selectedModel,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let textContent = '';
      const toolCalls: ToolCallEntry[] = [];
      let pendingCircuitUpdate: CircuitSnapshot | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          } else if (line === '') {
            // Empty line = end of event
            if (eventType && dataLines.length > 0) {
              const data = JSON.parse(dataLines.join(''));

              if (eventType === 'text_delta') {
                textContent += data.text;
                setMessages(prev => prev.map(m =>
                  m.id === assistantMsgId
                    ? { ...m, content: textContent, loading: false }
                    : m
                ));
              } else if (eventType === 'tool_call') {
                const tc: ToolCallEntry = {
                  name: data.name,
                  args: typeof data.args === 'string' ? JSON.parse(data.args) : data.args,
                  result: data.result,
                  error: data.error,
                  ok: data.ok !== false,
                };
                toolCalls.push(tc);
                setMessages(prev => prev.map(m =>
                  m.id === assistantMsgId
                    ? { ...m, toolCalls: [...(m.toolCalls || []), tc], loading: false }
                    : m
                ));

                // Handle client-side actions immediately
                if (SIM_CONTROL_TOOLS.has(tc.name) || PCB_TOOLS.has(tc.name) || tc.name.startsWith('pcb.')) {
                  handleClientSideAction(tc);
                }
              } else if (eventType === 'circuit_update') {
                pendingCircuitUpdate = { components: data.components, wires: data.wires };

                // If auto-apply is on, apply immediately; otherwise store as pending diff
                if (autoApply) {
                  applyCircuitUpdate(data.components, data.wires, false);
                } else {
                  // Compute diff summary
                  const addedComps = data.components.length - circuitSnapshot.components.length;
                  const addedWires = data.wires.length - circuitSnapshot.wires.length;
                  const summary = `${addedComps >= 0 ? '+' : ''}${addedComps} components, ${addedWires >= 0 ? '+' : ''}${addedWires} wires`;
                  setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId
                      ? { ...m, pendingDiff: { components: data.components, wires: data.wires, summary } }
                      : m
                  ));
                }
              } else if (eventType === 'done') {
                textContent = data.response || textContent;
                // Capture token usage from the done event
                if (data.usage) {
                  const usage = data.usage;
                  setTotalTokens(prev => ({
                    prompt: prev.prompt + (usage.prompt_tokens || 0),
                    completion: prev.completion + (usage.completion_tokens || 0),
                    total: prev.total + (usage.total_tokens || 0),
                  }));
                  // Attach usage to the assistant message
                  setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId ? { ...m, usage } : m
                  ));
                }
                // Apply final circuit if not auto-applied and there's a pending diff
                if (!autoApply && data.circuit && (
                  data.circuit.components.length !== circuitSnapshot.components.length ||
                  data.circuit.wires.length !== circuitSnapshot.wires.length ||
                  JSON.stringify(data.circuit.components) !== JSON.stringify(circuitSnapshot.components)
                )) {
                  // Leave as pending diff for user to review
                  const addedComps = data.circuit.components.length - circuitSnapshot.components.length;
                  const addedWires = data.circuit.wires.length - circuitSnapshot.wires.length;
                  const summary = `${addedComps >= 0 ? '+' : ''}${addedComps} components, ${addedWires >= 0 ? '+' : ''}${addedWires} wires`;
                  setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          content: textContent,
                          toolCalls,
                          loading: false,
                          pendingDiff: { components: data.circuit.components, wires: data.circuit.wires, summary },
                        }
                      : m
                  ));
                } else if (autoApply && pendingCircuitUpdate) {
                  // Final apply with toast
                  applyCircuitUpdate(pendingCircuitUpdate.components, pendingCircuitUpdate.wires, true);
                  setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId
                      ? { ...m, content: textContent, toolCalls, loading: false }
                      : m
                  ));
                } else {
                  setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId
                      ? { ...m, content: textContent, toolCalls, loading: false }
                      : m
                  ));
                }
              } else if (eventType === 'error') {
                throw new Error(data.message);
              }
            }
            eventType = '';
            dataLines.length = 0;
          }
        }
      }
    } catch (e) {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId
          ? {
              ...m,
              content: `Sorry, I encountered an error: ${(e as Error).message}`,
              loading: false,
              error: 'true',
            }
          : m
      ));
      toast.error('AI request failed');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, components, wires, messages, autoApply, selectedProvider, selectedModel, applyCircuitUpdate, handleClientSideAction]);

  // Keep sendRef in sync so the circuitlab:ai-prompt event listener can call it
  useEffect(() => {
    sendRef.current = (text: string) => {
      if (!text.trim() || isLoading) return;
      sendMessage(text);
    };
  }, [sendMessage, isLoading]);

  const applyPendingDiff = useCallback((msgId: string) => {
    // Find the message FIRST (outside the setMessages updater — React updaters
    // must be pure, no side effects like pushHistory/loadDocument).
    const msg = messages.find(m => m.id === msgId);
    if (!msg || !msg.pendingDiff) return;

    // Apply the circuit update (side effect — pushHistory + loadDocument)
    applyCircuitUpdate(msg.pendingDiff.components, msg.pendingDiff.wires, true);

    // Then update the message state (pure updater — no side effects)
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, pendingDiff: undefined } : m
    ));
  }, [messages, applyCircuitUpdate]);

  const dismissPendingDiff = useCallback((msgId: string) => {
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, pendingDiff: undefined } : m
    ));
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className="flex h-full w-full flex-col border-l border-slate-800 bg-slate-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-purple-400" />
          <div>
            <h2 className="text-sm font-semibold text-slate-100">AI Assistant</h2>
            <p className="text-xs text-slate-500">Designs, analyzes & debugs circuits</p>
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
                    onValueChange={(v) => handleProviderChange(v as 'zai' | 'openai' | 'anthropic')}
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
                onValueChange={(v) => handleModelChange(v)}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoApply(s => !s)}
            className="h-7 px-2 text-xs cursor-pointer hover:bg-slate-800"
            title={autoApply ? 'Auto-apply ON — changes apply immediately' : 'Auto-apply OFF — review before applying'}
          >
            <GitBranch className={`h-3.5 w-3.5 ${autoApply ? 'text-emerald-400' : 'text-amber-400'}`} />
            <span className="ml-1 hidden sm:inline">{autoApply ? 'Auto' : 'Review'}</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 cursor-pointer hover:bg-slate-800">
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
            onClick={() => setTotalTokens({ prompt: 0, completion: 0, total: 0 })}
            className="ml-auto cursor-pointer text-slate-600 hover:text-slate-400"
            title="Reset token counter"
          >
            reset
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-4">
          {messages.length === 0 && (
            <div className="space-y-3">
              <div className="rounded-lg border border-purple-900/30 bg-purple-950/20 p-4 text-sm text-slate-300">
                <p className="mb-2 font-medium text-purple-300">Hi! I'm your AI circuit design assistant.</p>
                <p className="text-slate-400">I can build circuits, run simulations, validate physics, and explain behavior. Try one of these:</p>
              </div>
              {SUGGESTED_PROMPTS.map(prompt => (
                <button
                  key={prompt}
                  onClick={() => sendMessage(prompt)}
                  className="block w-full rounded-lg border border-slate-800 bg-slate-900 p-3 text-left text-sm text-slate-300 transition-colors hover:border-purple-700 hover:bg-slate-800"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          {messages.map(msg => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onApplyDiff={() => applyPendingDiff(msg.id)}
              onDismissDiff={() => dismissPendingDiff(msg.id)}
              onUndo={() => undo()}
            />
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
            placeholder="Ask me to build, analyze, or debug a circuit..."
            disabled={isLoading}
            className="min-h-[60px] max-h-[200px] resize-none bg-slate-900 pr-12 text-sm text-slate-100 placeholder:text-slate-500"
          />
          <Button
            onClick={() => sendMessage(input)}
            disabled={isLoading || !input.trim()}
            size="icon"
            className="absolute bottom-2 right-2 h-8 w-8"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-1 px-1 text-[10px] text-slate-600">
          Enter to send · Shift+Enter for newline · Ctrl+Z to undo AI changes
        </p>
      </div>
    </div>
  );
}

function MessageBubble({ message, onApplyDiff, onDismissDiff, onUndo }: { message: ChatMessage; onApplyDiff: () => void; onDismissDiff: () => void; onUndo: () => void }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-purple-600 px-3 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

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
            {message.loading && !message.content ? (
              <div className="flex items-center gap-2 text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Thinking...</span>
              </div>
            ) : (
              <div className="whitespace-pre-wrap break-words">{message.content || (message.loading ? '...' : '')}</div>
            )}
          </div>
        </div>

        {/* Pending diff preview */}
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
              <Button size="sm" onClick={onApplyDiff} className="h-7 bg-emerald-600 text-xs hover:bg-emerald-500">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Apply changes
              </Button>
              <Button size="sm" variant="outline" onClick={onDismissDiff} className="h-7 border-slate-700 text-xs">
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

        {/* Undo button (shown if changes were applied) */}
        {!message.loading && !message.error && message.toolCalls && message.toolCalls.some(tc => MUTATING_TOOLS.has(tc.name)) && !message.pendingDiff && (
          <div className="ml-6">
            <Button size="sm" variant="ghost" onClick={onUndo} className="h-7 text-xs text-slate-400 hover:text-slate-200">
              <Undo2 className="mr-1 h-3 w-3" />
              Undo these changes
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

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
