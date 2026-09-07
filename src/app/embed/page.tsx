'use client';

// ─── /embed — read-only interactive circuit embed ───────────────────────────
// Renders a shared circuit (from the #circuit= URL hash, created by the main
// app's Share button) with the live simulation, scope and serial monitor, but
// no editing. Embeddable in blogs, docs and course pages via an iframe:
//
//   <iframe src="https://…/embed#circuit=…" width="900" height="620"></iframe>
//
// Viewers can still play with the circuit: pan/zoom, run/pause, speed, reset,
// flip switches and push buttons while running — exactly the interactions a
// course author wants a reader to have, and nothing else.

import { useEffect, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { hasSharedCircuit, loadFromShareURL } from '@/lib/circuit/share-url';
import { registerAllUserSymbols } from '@/lib/circuit/user-library';
import { useCircuitAudio } from '@/components/circuit/use-circuit-audio';
import { CircuitCanvas } from '@/components/circuit/CircuitCanvas';
import { ProbePanel } from '@/components/circuit/ProbePanel';
import { SimStatusBar } from '@/components/circuit/SimStatusBar';
import { Button } from '@/components/ui/button';
import { Play, Pause, RotateCcw, ExternalLink, Activity } from 'lucide-react';
import { toast } from 'sonner';
import '@/lib/circuit/components';

export default function EmbedPage() {
  const running = useEditor((s) => s.running);
  const speed = useEditor((s) => s.speed);
  const setRunning = useEditor((s) => s.setRunning);
  const setSpeed = useEditor((s) => s.setSpeed);
  const reset = useEditor((s) => s.reset);
  const [showPanel, setShowPanel] = useState(true);

  // Buzzer/speaker WebAudio poller — same as the main app
  useCircuitAudio();

  useEffect(() => {
    // Engage embed (read-only interactive) mode BEFORE any user interaction
    // can reach the canvas (the effect runs before the browser processes
    // input events). The canvas mounts immediately — its handlers read
    // embedMode from the store at event time.
    useEditor.getState().setEmbedMode(true);
    registerAllUserSymbols();

    const loadFromHash = (announce: boolean) => {
      if (hasSharedCircuit()) {
        const doc = loadFromShareURL(window.location.hash);
        if (doc && doc.components && doc.wires) {
          useEditor.getState().loadDocument(doc);
          // Embeds come alive immediately — the whole point of an embed is
          // seeing the circuit run.
          useEditor.getState().setRunning(true);
          if (announce) {
            toast.success(`Loaded shared circuit (${doc.components.length} components) — simulation running`);
          }
        } else {
          toast.error('No valid shared circuit found in the URL');
        }
      } else if (announce) {
        toast.info('Add a circuit to this embed URL: open a circuit in the editor and use Share, then embed the resulting link.');
      }
    };
    loadFromHash(true);

    // Hash-only navigations (same /embed path, different #circuit= hash) do
    // NOT reload the page — listen for them so swapping the embedded circuit
    // still works.
    const onHashChange = () => loadFromHash(false);
    window.addEventListener('hashchange', onHashChange);

    return () => {
      window.removeEventListener('hashchange', onHashChange);
      // Leaving the embed route (client-side nav) — restore normal editing.
      useEditor.getState().setEmbedMode(false);
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Compact control bar */}
      <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-1.5">
        <Activity size={14} className="text-cyan-400" />
        <span className="text-xs font-semibold tracking-wide text-slate-300">Interactive Circuit</span>
        <span className="text-[10px] text-slate-500">read-only embed</span>

        <div className="ml-4 flex items-center gap-1">
          <Button
            size="sm"
            variant={running ? 'default' : 'outline'}
            className="h-7 cursor-pointer px-2 text-xs"
            onClick={() => setRunning(!running)}
            title={running ? 'Pause the simulation (Space)' : 'Run the simulation (Space)'}
          >
            {running ? <Pause size={12} className="mr-1" /> : <Play size={12} className="mr-1" />}
            {running ? 'Pause' : 'Run'}
          </Button>
          <select
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            title="Simulation speed"
            aria-label="Simulation speed"
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1.5 py-1 text-xs text-slate-200"
          >
            {[0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].map((s) => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 cursor-pointer px-2 text-xs text-slate-400 hover:text-slate-100"
            onClick={() => { reset(); setRunning(true); }}
            title="Reset the simulation to t=0"
          >
            <RotateCcw size={12} className="mr-1" /> Reset
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 cursor-pointer px-2 text-xs text-slate-400 hover:text-slate-100"
            onClick={() => setShowPanel((v) => !v)}
            title={showPanel ? 'Hide the scope / serial panel' : 'Show the scope / serial panel'}
          >
            {showPanel ? 'Hide Panel' : 'Show Panel'}
          </Button>
        </div>

        <a
          href={typeof window !== 'undefined' ? `/${window.location.hash}` : '/'}
          suppressHydrationWarning
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-cyan-400 hover:bg-slate-800"
          title="Open this circuit in the full editor"
        >
          <ExternalLink size={12} className="mr-1" /> Open in editor
        </a>
      </div>

      {/* Circuit + probe panel */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <CircuitCanvas />
        </div>
        {showPanel && (
          <div className="h-64 shrink-0 border-t border-slate-800">
            <ProbePanel />
          </div>
        )}
        <SimStatusBar />
      </div>
    </div>
  );
}
