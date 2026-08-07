'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { usePCB } from '@/lib/pcb/store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronRight, Send, Sparkles, Loader2, X, AlertCircle, CheckCircle2, Wrench } from 'lucide-react';
import { toast } from 'sonner';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: any[];
  timestamp: number;
  loading?: boolean;
  error?: string;
}

interface ApiResponse {
  response?: string;
  toolCalls?: any[];
  circuit?: {
    components: any[];
    wires: any[];
  };
  error?: string;
  warning?: string;
  provider?: string;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const SUGGESTED_PROMPTS = [
  'Build an LED blinker with a 555 timer',
  'Add a resistor and LED, then simulate',
  'Create an RC low-pass filter and verify the cutoff frequency',
  'Build a common-emitter amplifier and measure the gain',
  'Explain the current circuit',
  'Run physics validation on my circuit',
];

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Editor + PCB stores for circuit snapshot
  const components = useEditor(s => s.components);
  const wires = useEditor(s => s.wires);
  const loadDocument = useEditor(s => s.loadDocument);
  const setRunning = useEditor(s => s.setRunning);

  // PCB store (for PCB-related tool calls)
  const pcbFootprints = usePCB(s => s.footprints);
  const pcbTraces = usePCB(s => s.traces);
  const pcbVias = usePCB(s => s.vias);
  const pcbBoard = usePCB(s => s.board);
  const runAutoRoute = usePCB(s => s.runAutoRoute);
  const runTopoRoute = usePCB(s => s.runTopoRoute);
  const runDRC = usePCB(s => s.runDRC);
  const importFromSchematic = usePCB(s => s.importFromSchematic);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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
    const loadingMsg: ChatMessage = {
      id: `a_${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      loading: true,
    };
    setMessages(prev => [...prev, userMsg, loadingMsg]);

    // Capture circuit snapshot BEFORE sending (so we have the baseline)
    const circuitSnapshot = {
      components: JSON.parse(JSON.stringify(components)),
      wires: JSON.parse(JSON.stringify(wires)),
    };

    // Build message history for the API (only role + content)
    const apiMessages = [
      ...messages.filter(m => !m.loading && !m.error).map(m => ({
        role: m.role,
        content: m.content,
      })),
      { role: 'user' as const, content: text },
    ];

    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          circuit: circuitSnapshot,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: ApiResponse = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Apply circuit changes if the AI modified the circuit
      if (data.circuit && (
        data.circuit.components.length !== circuitSnapshot.components.length ||
        data.circuit.wires.length !== circuitSnapshot.wires.length ||
        JSON.stringify(data.circuit.components) !== JSON.stringify(circuitSnapshot.components)
      )) {
        // The AI made changes — load the new document
        loadDocument({
          version: 1,
          components: data.circuit.components,
          wires: data.circuit.wires,
        });
        toast.success('Circuit updated by AI');
      }

      // Handle PCB-side tool calls
      if (data.toolCalls) {
        for (const tc of data.toolCalls) {
          if (tc.name === 'pcb.importFromSchematic' && tc.ok) {
            importFromSchematic(components, wires);
            toast.success('Schematic imported to PCB');
          } else if (tc.name === 'pcb.autoRoute' && tc.ok) {
            runAutoRoute();
            toast.success('Auto-route complete — check PCB tab');
          } else if (tc.name === 'pcb.topoRoute' && tc.ok) {
            const result = runTopoRoute();
            toast.success(`Topo-routed: ${result.routed} routed, ${result.failed} failed`);
          } else if (tc.name === 'pcb.runDRC' && tc.ok) {
            runDRC();
            toast.success('DRC complete — check PCB tab for errors');
          }
        }
      }

      const assistantMsg: ChatMessage = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: data.response || '(no response)',
        toolCalls: data.toolCalls,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev.filter(m => m.id !== loadingMsg.id), assistantMsg]);
    } catch (e) {
      const errorMsg: ChatMessage = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: `Sorry, I encountered an error: ${(e as Error).message}`,
        timestamp: Date.now(),
        error: 'true',
      };
      setMessages(prev => [...prev.filter(m => m.id !== loadingMsg.id), errorMsg]);
      toast.error('AI request failed');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, components, wires, messages, loadDocument, importFromSchematic, runAutoRoute, runTopoRoute, runDRC]);

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
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
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
            <MessageBubble key={msg.id} message={msg} />
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
          Enter to send · Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-purple-600 px-3 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  // Assistant message
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
            {message.loading ? (
              <div className="flex items-center gap-2 text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Thinking...</span>
              </div>
            ) : (
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
            )}
          </div>
        </div>

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

function ToolCallDisplay({ toolCall }: { toolCall: any }) {
  const [open, setOpen] = useState(false);
  const success = toolCall.ok !== false;
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
            <pre className="mt-0.5 overflow-x-auto rounded bg-slate-900 p-1.5 text-slate-300">
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
