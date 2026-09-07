'use client';

import { useState, useEffect } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { CircuitBoard, Zap, Box, HelpCircle, Share2, Library, Sparkles } from 'lucide-react';
import { CircuitCanvas } from '@/components/circuit/CircuitCanvas';
import { Toolbar } from '@/components/circuit/Toolbar';
import { ComponentPalette } from '@/components/circuit/ComponentPalette';
import { PropertyPanel } from '@/components/circuit/PropertyPanel';
import { ProbePanel } from '@/components/circuit/ProbePanel';
import { PCBCanvas } from '@/components/pcb/PCBCanvas';
import { PCBToolbar } from '@/components/pcb/PCBToolbar';
import dynamic from 'next/dynamic';
import { CommandPalette } from '@/components/CommandPalette';
import { HelpDialog } from '@/components/circuit/HelpDialog';
import { LibraryManagerDialog } from '@/components/pcb/LibraryManagerDialog';
import { SimStatusBar } from '@/components/circuit/SimStatusBar';
import { TipOfTheDay } from '@/components/circuit/TipOfTheDay';
import { ThemeManager } from '@/components/circuit/ThemeManager';

// Lazy-load heavy components to reduce initial bundle size.
// three.js (~600KB) only loads when user enters 3D mode.
// ChatPanel (AI SDK) only loads when user opens AI panel.
const PCB3DViewer = dynamic(() => import('@/components/pcb/PCB3DViewer').then(m => ({ default: m.PCB3DViewer })), { ssr: false });
const ChatPanel = dynamic(() => import('@/components/ai/ChatPanel').then(m => ({ default: m.ChatPanel })), { ssr: false });
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { useChatSession } from '@/lib/ai/chat-session';
import { installScriptingAPI } from '@/lib/scripting-api';
import { hasSharedCircuit, loadFromShareURL, createShareURL } from '@/lib/circuit/share-url';
import { AutosaveManager, detectCrashRecovery, loadAutosave, clearAutosave } from '@/lib/circuit/autosave';
import { registerAllUserSymbols } from '@/lib/circuit/user-library';
import { useCircuitAudio } from '@/components/circuit/use-circuit-audio';
import { confirmDialog } from '@/lib/confirm';
import { ConfirmDialogHost } from '@/components/ui/ConfirmDialogHost';
import '@/lib/circuit/components';
import { toast } from 'sonner';

// Module-level autosave manager — survives re-renders but is per-tab.
const autosaveMgr = new AutosaveManager();

export default function Home() {
  const [mode, setMode] = useState<'schematic' | 'pcb' | '3d'>('schematic');
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const [hasUnseenChangelog, setHasUnseenChangelog] = useState(false);
  // Screen-reader announcements (keyboard focus cycling / placement mode)
  const announcement = useEditor((s) => s.announcement);
  // Buzzer/speaker WebAudio poller (voices are driven from live sim state)
  useCircuitAudio();

  // "What's New" badge — visible on the Help button when there's an unseen changelog entry.
  useEffect(() => {
    try {
      const seen = localStorage.getItem('circuit-lab.changelog-seen');
      setHasUnseenChangelog(seen !== '2026-08-17');
    } catch { /* localStorage disabled */ }
  }, []);

  const openHelp = () => {
    setShowHelp(true);
    // Clear the badge as soon as the user opens Help
    try {
      localStorage.setItem('circuit-lab.changelog-seen', '2026-08-17');
      setHasUnseenChangelog(false);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    try {
      installScriptingAPI();
      // Re-register persisted user symbols (Symbol Editor creations + KiCad
      // library imports) BEFORE loading any document so their plugin types
      // resolve when components are placed back on the canvas.
      registerAllUserSymbols();
      if (hasSharedCircuit()) {
        const doc = loadFromShareURL(window.location.hash);
        if (doc && doc.components && doc.wires) useEditor.getState().loadDocument(doc);
      } else {
        // Crash recovery — if the previous session crashed (tab closed
        // unexpectedly, browser crashed, etc.), offer to restore the last
        // autosaved circuit. Previously: unsaved work was silently lost.
        //
        // Uses the in-app confirm dialog (never a native window.confirm —
        // native dialogs block the whole page and are suppressed/invisible
        // in embedded preview iframes, which freezes the app on load).
        const info = detectCrashRecovery();
        if (info && info.crashed && info.componentCount > 0) {
          const when = new Date(info.timestamp).toLocaleString();
          confirmDialog({
            title: 'Recover unsaved work?',
            description:
              `A previous session ended unexpectedly (${when}).\n` +
              `${info.componentCount} components and ${info.wireCount} wires were recovered.`,
            confirmLabel: 'Restore',
            cancelLabel: 'Start fresh',
          }).then((restore) => {
            if (restore) {
              const doc = loadAutosave();
              if (doc) useEditor.getState().loadDocument(doc);
            } else {
              clearAutosave();
            }
          });
        }
      }
    } catch (e) { console.warn('Init failed:', e); }
  }, []);

  // Autosave: subscribe to store changes, debounce-save to localStorage,
  // and flush on tab close. Without this, any browser crash = total data loss.
  useEffect(() => {
    autosaveMgr.start(() => {
      const s = useEditor.getState();
      // Strip simState before saving — it's runtime-only and bloats the payload.
      return {
        version: 1 as const,
        components: s.components.map(c => ({ ...c, simState: undefined, parameters: { ...c.parameters }, fields: c.fields ? c.fields.map(f => ({ ...f })) : undefined })),
        wires: s.wires.map(w => ({ ...w })),
        drawings: s.drawings,
        noConnects: s.noConnects,
        groups: s.groups,
        sheets: s.sheets,
        netClasses: s.netClasses,
        pageSetup: s.pageSetup,
        metadata: s.metadata,
      };
    });
    // Subscribe to store changes — mark dirty only on circuit structure changes,
    // NOT on 60Hz simContext/traces updates (which would flood localStorage).
    let lastComponents = useEditor.getState().components;
    let lastWires = useEditor.getState().wires;
    const unsub = useEditor.subscribe((state) => {
      // Only mark dirty if the circuit structure actually changed
      if (state.components !== lastComponents || state.wires !== lastWires) {
        lastComponents = state.components;
        lastWires = state.wires;
        autosaveMgr.markDirty();
      }
    });
    // Save on tab close / navigation / browser close.
    const onUnload = () => autosaveMgr.shutdown();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      unsub();
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  // Ctrl+K command palette, Ctrl+J AI panel, ? for help
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowCommandPalette(true); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'j') { e.preventDefault(); setShowAI(s => !s); }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        // Don't hijack "?" while the user is typing in an input/textarea —
        // previously this made it impossible to type a literal "?" anywhere.
        const target = e.target as HTMLElement | null;
        if (target && (
          target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' || target.isContentEditable
        )) return;
        e.preventDefault();
        openHelp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Listen for "ask AI" events from other panels (ProbePanel, PropertyPanel, etc.)
  // Opens the AI panel and pre-fills the prompt.
  useEffect(() => {
    const onAskAI = (e: Event) => {
      const prompt = (e as CustomEvent<string>).detail;
      setShowAI(true);
      // Small delay to let the panel render, then dispatch the prompt
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('circuitlab:ai-prompt', { detail: prompt }));
      }, 100);
    };
    window.addEventListener('circuitlab:ask-ai', onAskAI as EventListener);
    return () => window.removeEventListener('circuitlab:ask-ai', onAskAI as EventListener);
  }, []);

  const handleShare = () => {
    const doc = useEditor.getState().serialize();
    const url = createShareURL(doc);
    // Clipboard write can fail in embedded iframes (permission denied) — fall
    // back to a legacy copy, then to a toast. Never window.prompt: it blocks
    // the page and is suppressed in sandboxed frames.
    const legacyCopy = (text: string): boolean => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    };
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success('Share URL copied!'))
      .catch(() => {
        if (legacyCopy(url)) {
          toast.success('Share URL copied!');
        } else {
          toast.info('Share URL', {
            description: url,
            duration: 20000,
          });
        }
      });
  };

  // Reactive PCB state for 3D header
  const pcbFootprints = usePCB((s) => s.footprints);
  const pcbTraces = usePCB((s) => s.traces);
  const pcbBoard = usePCB((s) => s.board);

  // AI turn in flight (even with the panel closed — the session store keeps
  // streaming and applying circuit changes in the background)
  const aiActive = useChatSession((s) => s.active);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Mode Toggle Bar */}
      <div className="flex items-center justify-center gap-2 border-b border-slate-800 bg-slate-900 py-1.5">
        <Button
          size="sm"
          variant={mode === 'schematic' ? 'default' : 'ghost'}
          className={mode === 'schematic' ? 'bg-cyan-500 text-slate-900 hover:bg-cyan-400' : ''}
          onClick={() => setMode('schematic')}
        >
          <Zap size={14} className="mr-1.5" />
          Schematic
        </Button>
        <Button
          size="sm"
          variant={mode === 'pcb' ? 'default' : 'ghost'}
          className={mode === 'pcb' ? 'bg-emerald-500 text-slate-900 hover:bg-emerald-400' : ''}
          onClick={() => setMode('pcb')}
        >
          <CircuitBoard size={14} className="mr-1.5" />
          PCB Layout
        </Button>
        <Button
          size="sm"
          variant={mode === '3d' ? 'default' : 'ghost'}
          className={mode === '3d' ? 'bg-purple-500 text-white hover:bg-purple-400' : ''}
          onClick={() => setMode('3d')}
        >
          <Box size={14} className="mr-1.5" />
          3D View
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={showAI ? 'default' : 'ghost'}
            className={`relative ${showAI ? 'bg-purple-600 text-white hover:bg-purple-500' : ''}`}
            onClick={() => setShowAI(s => !s)}
            title="Toggle AI Assistant (Ctrl+J)"
          >
            <Sparkles size={14} className={aiActive ? 'animate-pulse' : ''} />
            <span className="ml-1 hidden md:inline">AI Assistant</span>
            {aiActive && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5"
                title="AI is working — click to view progress"
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-purple-500" />
              </span>
            )}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleShare}><Share2 size={14} /><span className="ml-1 hidden md:inline">Share</span></Button>
          <Button size="sm" variant="ghost" onClick={() => setShowLibrary(true)}><Library size={14} /><span className="ml-1 hidden md:inline">Library</span></Button>
          <Button size="sm" variant="ghost" onClick={openHelp} className="relative">
            <HelpCircle size={14} />
            {hasUnseenChangelog && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5"
                title="New features — click to view"
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
              </span>
            )}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Main editor area */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {mode === 'schematic' ? (
            <>
              <Toolbar />
              <div className="min-h-0 flex-1" id="main-content">
                {/* ARIA live region for screen reader announcements.
                    Shows the store's `announcement` (set by keyboard focus
                    cycling / placement) when present, else the sim state. */}
                <div aria-live="polite" className="sr-only">
                  {announcement ??
                    (useEditor.getState().running ? 'Simulation running' : 'Simulation stopped')}
                </div>
                <ResizablePanelGroup direction="horizontal">
                  <ResizablePanel defaultSize={14} minSize={10} maxSize={28}>
                    <nav aria-label="Component palette" className="h-full min-h-0">
                      <ComponentPalette />
                    </nav>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={72} minSize={40}>
                    <ResizablePanelGroup direction="vertical">
                      <ResizablePanel defaultSize={75} minSize={30}>
                        <main aria-label="Circuit canvas" className="h-full min-h-0">
                          <CircuitCanvas />
                        </main>
                      </ResizablePanel>
                      <ResizableHandle withHandle />
                      <ResizablePanel defaultSize={25} minSize={12}>
                        <ProbePanel />
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={14} minSize={10} maxSize={28}>
                    <PropertyPanel />
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
              <SimStatusBar />
            </>
          ) : mode === 'pcb' ? (
            <>
              <PCBToolbar />
              <div className="min-h-0 flex-1">
                <PCBCanvas />
              </div>
            </>
          ) : (
            /* 3D View mode */
            <>
              <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2">
                <span className="text-sm font-semibold text-slate-100">3D PCB Preview</span>
                <span className="text-xs text-slate-500">·</span>
                <span className="text-xs text-slate-400">
                  {pcbFootprints.length} components ·
                  {' '}{pcbTraces.length} traces ·
                  {' '}{pcbBoard.width}×{pcbBoard.height}mm
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-slate-500">Left-drag: rotate · Right-drag: pan · Scroll: zoom</span>
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <PCB3DViewer />
              </div>
            </>
          )}
        </div>

        {/* AI Chat Panel (right side, collapsible) */}
        {showAI && (
          <div className="w-[400px] min-w-[320px] max-w-[600px] shrink-0 overflow-hidden">
            <ChatPanel onClose={() => setShowAI(false)} />
          </div>
        )}
      </div>

      <CommandPalette open={showCommandPalette} onClose={() => setShowCommandPalette(false)} />
      <HelpDialog open={showHelp} onClose={() => setShowHelp(false)} />
      <LibraryManagerDialog open={showLibrary} onClose={() => setShowLibrary(false)} />
      <TipOfTheDay />
      <ThemeManager />
      <ConfirmDialogHost />
    </div>
  );
}
