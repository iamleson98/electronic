'use client';

import { useState, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HelpCircle, Keyboard, BookOpen, Lightbulb, Code } from 'lucide-react';
import { exampleCategories, type ExampleEntry } from '@/lib/circuit/examples';
import { exportSchematicSVG } from '@/lib/circuit/schematic-plot';
import { useEditor } from '@/lib/circuit/store';

interface Props { open: boolean; onClose: () => void; }

const SHORTCUTS = [
  { category: 'Schematic Editing', keys: [
    { key: 'Space', desc: 'Start/Pause simulation' },
    { key: 'R', desc: 'Rotate selected component 90°' },
    { key: 'Delete', desc: 'Delete selected component or wire' },
    { key: 'Escape', desc: 'Cancel current action / clear selection' },
    { key: 'Ctrl+Z', desc: 'Undo' },
    { key: 'Ctrl+Y', desc: 'Redo' },
    { key: 'Ctrl+C', desc: 'Copy selected components' },
    { key: 'Ctrl+V', desc: 'Paste copied components' },
    { key: 'Ctrl+D', desc: 'Duplicate selected components' },
    { key: 'Ctrl+A', desc: 'Select all' },
    { key: 'Shift+Click', desc: 'Add to multi-selection' },
    { key: '\\', desc: 'Toggle 45° wire routing' },
  ]},
  { category: 'PCB Layout', keys: [
    { key: '1', desc: 'Select/Move tool' },
    { key: '2', desc: 'Route tool (90°)' },
    { key: '3', desc: 'Add via' },
    { key: 'R', desc: 'Rotate footprint' },
    { key: 'Delete', desc: 'Delete selected trace' },
    { key: 'Ctrl+K', desc: 'Open Command Palette' },
  ]},
];

const GETTING_STARTED = [
  { step: 1, title: 'Add components', desc: 'Click a component in the left palette, or drag it onto the canvas.' },
  { step: 2, title: 'Wire components', desc: 'Click on a terminal (green dot) to start a wire. Click another terminal to connect.' },
  { step: 3, title: 'Add ground', desc: 'Every circuit needs a ground reference. Drag a Ground component and wire it.' },
  { step: 4, title: 'Set parameters', desc: 'Click a component, then edit its parameters in the right panel.' },
  { step: 5, title: 'Run simulation', desc: 'Press Space or click Play. Yellow dots show current flow.' },
  { step: 6, title: 'Switch to PCB', desc: 'Click "PCB Layout" at top. Click "Import" to bring your schematic in.' },
  { step: 7, title: '3D view', desc: 'Click "3D View" to see your board in 3D.' },
  { step: 8, title: 'Export', desc: 'Click "Gerbers" to download manufacturing files.' },
];

export function HelpDialog({ open, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden bg-slate-900 border-slate-700">
        <DialogHeader>
          <DialogTitle className="text-slate-100 flex items-center gap-2">
            <HelpCircle size={18} /> Help & Documentation
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="shortcuts" className="w-full">
          <TabsList className="grid w-full grid-cols-4 bg-slate-950">
            <TabsTrigger value="shortcuts" className="data-[state=active]:bg-slate-700 text-xs"><Keyboard size={12} className="mr-1" /> Shortcuts</TabsTrigger>
            <TabsTrigger value="guide" className="data-[state=active]:bg-slate-700 text-xs"><BookOpen size={12} className="mr-1" /> Getting Started</TabsTrigger>
            <TabsTrigger value="examples" className="data-[state=active]:bg-slate-700 text-xs"><Lightbulb size={12} className="mr-1" /> Examples</TabsTrigger>
            <TabsTrigger value="api" className="data-[state=active]:bg-slate-700 text-xs"><Code size={12} className="mr-1" /> API</TabsTrigger>
          </TabsList>
          <TabsContent value="shortcuts" className="mt-4">
            <ScrollArea className="h-[60vh]">
              <div className="space-y-4">
                {SHORTCUTS.map(group => (
                  <div key={group.category}>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">{group.category}</h3>
                    <div className="space-y-1">
                      {group.keys.map(s => (
                        <div key={s.key} className="flex items-center justify-between py-1 px-2 rounded hover:bg-slate-800">
                          <span className="text-sm text-slate-300">{s.desc}</span>
                          <kbd className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-xs font-mono text-cyan-300">{s.key}</kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="guide" className="mt-4">
            <ScrollArea className="h-[60vh]">
              <div className="space-y-4">
                {GETTING_STARTED.map(step => (
                  <div key={step.step} className="flex gap-3 p-3 rounded-md bg-slate-950 border border-slate-800">
                    <div className="shrink-0 w-8 h-8 rounded-full bg-cyan-500 text-slate-900 flex items-center justify-center font-bold text-sm">{step.step}</div>
                    <div><h4 className="text-sm font-medium text-slate-200">{step.title}</h4><p className="text-xs text-slate-400 mt-1">{step.desc}</p></div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="examples" className="mt-4">
            <ExamplesGallery />
          </TabsContent>
          <TabsContent value="api" className="mt-4">
            <ScrollArea className="h-[60vh]">
              <div className="space-y-4 text-xs">
                <div className="p-3 rounded-md bg-slate-950 border border-slate-800">
                  <h4 className="text-sm font-medium text-cyan-300 mb-2">Quick Start</h4>
                  <pre className="bg-slate-900 p-2 rounded text-xs text-slate-300 overflow-x-auto">{`circuitlab.listComponents()
circuitlab.addComponent('resistor', {x: 5, y: 5})
circuitlab.run()
circuitlab.getVoltage('r1:a')`}</pre>
                </div>
                <div className="p-3 rounded-md bg-slate-950 border border-slate-800">
                  <h4 className="text-sm font-medium text-cyan-300 mb-2">Schematic</h4>
                  <ul className="space-y-1 text-slate-400">
                    <li><code className="text-cyan-400">getSchematic()</code> → {`{components, wires}`}</li>
                    <li><code className="text-cyan-400">addComponent(type, pos, params?)</code> → id</li>
                    <li><code className="text-cyan-400">removeComponent(id)</code></li>
                    <li><code className="text-cyan-400">moveComponent(id, pos)</code></li>
                    <li><code className="text-cyan-400">setParameter(id, key, value)</code></li>
                    <li><code className="text-cyan-400">addWire(from, to)</code></li>
                    <li><code className="text-cyan-400">clear()</code></li>
                  </ul>
                </div>
                <div className="p-3 rounded-md bg-slate-950 border border-slate-800">
                  <h4 className="text-sm font-medium text-cyan-300 mb-2">Simulation</h4>
                  <ul className="space-y-1 text-slate-400">
                    <li><code className="text-cyan-400">run() / pause() / step() / reset()</code></li>
                    <li><code className="text-cyan-400">getVoltage('compId:termId')</code> → volts</li>
                    <li><code className="text-cyan-400">getCurrent('compId')</code> → amps</li>
                    <li><code className="text-cyan-400">getNodeVoltages()</code> → number[]</li>
                    <li><code className="text-cyan-400">getTime()</code> → seconds</li>
                  </ul>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ─── Examples gallery with live SVG thumbnails ───────────────────────────────

function ExamplesGallery() {
  const loadDocument = useEditor((s) => s.loadDocument);
  const clear = useEditor((s) => s.clear);

  // Pre-compute SVG thumbnails once per category (deterministic from examples.ts)
  const thumbnails = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of exampleCategories) {
      for (const ex of cat.examples) {
        try {
          const svg = exportSchematicSVG(ex.doc);
          // Strip the XML declaration so it can be inlined as data: URL or HTML
          const cleaned = svg.replace(/^<\?xml[^>]*\?>\s*/, '');
          map.set(`${cat.label}::${ex.name}`, cleaned);
        } catch {
          map.set(`${cat.label}::${ex.name}`, '');
        }
      }
    }
    return map;
  }, []);

  const handleLoad = (ex: ExampleEntry) => {
    clear();
    loadDocument(ex.doc);
  };

  return (
    <ScrollArea className="h-[60vh]">
      <div className="space-y-4">
        {exampleCategories.map((cat) => (
          <div key={cat.label}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{cat.label}</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {cat.examples.map((ex) => {
                const thumb = thumbnails.get(`${cat.label}::${ex.name}`);
                return (
                  <button
                    key={ex.name}
                    onClick={() => handleLoad(ex)}
                    className="cursor-pointer group overflow-hidden rounded-md border border-slate-800 bg-slate-950 text-left transition-colors hover:border-cyan-700 hover:bg-slate-900"
                    title={`Load example: ${ex.name}`}
                  >
                    {/* Thumbnail */}
                    <div
                      className="h-28 w-full overflow-hidden border-b border-slate-800 bg-[#fafafa]"
                      // Inline SVG is safe here — we generate it ourselves from the example docs
                      dangerouslySetInnerHTML={{ __html: thumb || '<div class="flex h-full items-center justify-center text-slate-400 text-xs">No preview</div>' }}
                    />
                    {/* Title + description */}
                    <div className="p-2">
                      <h4 className="text-xs font-medium text-cyan-300 group-hover:text-cyan-200">{ex.name}</h4>
                      <p className="mt-0.5 text-[10px] leading-tight text-slate-500">{ex.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
