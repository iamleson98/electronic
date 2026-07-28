'use client';

import { useState, useEffect } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { CircuitBoard, Cpu, Zap, Box, HelpCircle, Share2, Library } from 'lucide-react';
import { CircuitCanvas } from '@/components/circuit/CircuitCanvas';
import { Toolbar } from '@/components/circuit/Toolbar';
import { ComponentPalette } from '@/components/circuit/ComponentPalette';
import { PropertyPanel } from '@/components/circuit/PropertyPanel';
import { ProbePanel } from '@/components/circuit/ProbePanel';
import { PCBCanvas } from '@/components/pcb/PCBCanvas';
import { PCBToolbar } from '@/components/pcb/PCBToolbar';
import { PCB3DViewer } from '@/components/pcb/PCB3DViewer';
import { CommandPalette } from '@/components/CommandPalette';
import { HelpDialog } from '@/components/circuit/HelpDialog';
import { LibraryManagerDialog } from '@/components/pcb/LibraryManagerDialog';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { installScriptingAPI } from '@/lib/scripting-api';
import { hasSharedCircuit, loadFromShareURL, createShareURL } from '@/lib/circuit/share-url';
import '@/lib/circuit/components';
import { toast } from 'sonner';

export default function Home() {
  const [mode, setMode] = useState<'schematic' | 'pcb' | '3d'>('schematic');
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);

  useEffect(() => {
    const initTimer = setTimeout(() => {
      try {
        installScriptingAPI();
        if (hasSharedCircuit()) {
          const doc = loadFromShareURL(window.location.hash);
          if (doc && doc.components && doc.wires) useEditor.getState().loadDocument(doc);
        }
      } catch (e) { console.warn('Init failed:', e); }
    }, 500);
    return () => clearTimeout(initTimer);
  }, []);

  // Ctrl+K command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowCommandPalette(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleShare = () => {
    const doc = useEditor.getState().serialize();
    const url = createShareURL(doc);
    navigator.clipboard.writeText(url).then(() => toast.success('Share URL copied!')).catch(() => window.prompt('Copy URL:', url));
  };

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
          <Button size="sm" variant="ghost" onClick={handleShare}><Share2 size={14} /><span className="ml-1 hidden md:inline">Share</span></Button>
          <Button size="sm" variant="ghost" onClick={() => setShowLibrary(true)}><Library size={14} /><span className="ml-1 hidden md:inline">Library</span></Button>
          <Button size="sm" variant="ghost" onClick={() => setShowHelp(true)}><HelpCircle size={14} /></Button>
        </div>
      </div>

      {mode === 'schematic' ? (
        <>
          <Toolbar />
          <div className="min-h-0 flex-1">
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel defaultSize={18} minSize={14} maxSize={28}>
                <ComponentPalette />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={64} minSize={40}>
                <ResizablePanelGroup direction="vertical">
                  <ResizablePanel defaultSize={70} minSize={30}>
                    <CircuitCanvas />
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={30} minSize={15}>
                    <ProbePanel />
                  </ResizablePanel>
                </ResizablePanelGroup>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={18} minSize={14} maxSize={28}>
                <PropertyPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
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
              {usePCB.getState().footprints.length} components ·
              {' '}{usePCB.getState().traces.length} traces ·
              {' '}{usePCB.getState().board.width}×{usePCB.getState().board.height}mm
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

      <CommandPalette open={showCommandPalette} onClose={() => setShowCommandPalette(false)} />
      <HelpDialog open={showHelp} onClose={() => setShowHelp(false)} />
      <LibraryManagerDialog open={showLibrary} onClose={() => setShowLibrary(false)} />
    </div>
  );
}
