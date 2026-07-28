'use client';

import { useState } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { CircuitBoard, Cpu, Zap, Box } from 'lucide-react';
import { CircuitCanvas } from '@/components/circuit/CircuitCanvas';
import { Toolbar } from '@/components/circuit/Toolbar';
import { ComponentPalette } from '@/components/circuit/ComponentPalette';
import { PropertyPanel } from '@/components/circuit/PropertyPanel';
import { ProbePanel } from '@/components/circuit/ProbePanel';
import { PCBCanvas } from '@/components/pcb/PCBCanvas';
import { PCBToolbar } from '@/components/pcb/PCBToolbar';
import { PCB3DViewer } from '@/components/pcb/PCB3DViewer';
import { usePCB } from '@/lib/pcb/store';
import '@/lib/circuit/components';

export default function Home() {
  const [mode, setMode] = useState<'schematic' | 'pcb' | '3d'>('schematic');

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
    </div>
  );
}
