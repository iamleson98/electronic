'use client';

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { CircuitCanvas } from '@/components/circuit/CircuitCanvas';
import { Toolbar } from '@/components/circuit/Toolbar';
import { ComponentPalette } from '@/components/circuit/ComponentPalette';
import { PropertyPanel } from '@/components/circuit/PropertyPanel';
import { ProbePanel } from '@/components/circuit/ProbePanel';
import '@/lib/circuit/components'; // register all plugins

export default function Home() {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <Toolbar />
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          {/* Left: Palette */}
          <ResizablePanel defaultSize={18} minSize={14} maxSize={28}>
            <ComponentPalette />
          </ResizablePanel>
          <ResizableHandle withHandle />

          {/* Center: Canvas + Probe */}
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

          {/* Right: Property panel */}
          <ResizablePanel defaultSize={18} minSize={14} maxSize={28}>
            <PropertyPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
