'use client';

import { useMemo, useState } from 'react';
import { getPluginsByCategory } from '@/lib/circuit/registry';
import { useEditor } from '@/lib/circuit/store';
import { Search, Cpu, Zap, Radio, Lightbulb, CircuitBoard, Gauge, Microchip, Layers } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

const categoryLabels: Record<string, string> = {
  io: 'Inputs / Outputs',
  source: 'Power Sources',
  passive: 'Passive Components',
  semiconductor: 'Semiconductors',
  ic: 'Integrated Circuits',
  logic: 'Logic Gates',
  meter: 'Meters & Probes',
  mcu: 'Microcontrollers',
};

const categoryIcons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  io: Lightbulb,
  source: Zap,
  passive: Radio,
  semiconductor: CircuitBoard,
  ic: Microchip,
  logic: Layers,
  meter: Gauge,
  mcu: Cpu,
};

export function ComponentPalette() {
  const [query, setQuery] = useState('');
  const addComponent = useEditor((s) => s.addComponent);
  const groups = useMemo(() => getPluginsByCategory(), []);

  const filtered = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        plugins: g.plugins.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.type.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.symbol.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.plugins.length > 0);
  }, [groups, query]);

  return (
    <div className="flex h-full flex-col bg-slate-900">
      {/* Header */}
      <div className="border-b border-slate-800 p-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Components</h2>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-500" />
          <Input
            placeholder="Search components..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 border-slate-700 bg-slate-800 pl-8 text-xs text-slate-200 placeholder:text-slate-500"
          />
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {filtered.length === 0 && (
            <div className="p-4 text-center text-xs text-slate-500">No components found</div>
          )}
          {filtered.map((group) => {
            const Icon = categoryIcons[group.category] ?? CircuitBoard;
            return (
              <div key={group.category} className="mb-3">
                <div className="mb-1 flex items-center gap-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <Icon size={11} />
                  {categoryLabels[group.category] ?? group.category}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {group.plugins.map((plugin) => (
                    <button
                      key={plugin.type}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-circuit-type', plugin.type);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => {
                        // click-to-add: drop at center of canvas (will be added at a default spot)
                        // The canvas will handle drop. For click, add at (5, 5) as a fallback.
                        addComponent(plugin.type, { x: 8, y: 8 });
                      }}
                      title={`${plugin.name} — ${plugin.description}`}
                      className="group flex flex-col items-center justify-start gap-1 rounded-md border border-slate-800 bg-slate-800/50 p-2 text-center transition-all hover:border-cyan-500/50 hover:bg-slate-800"
                    >
                      <div className="flex h-8 w-full items-center justify-center rounded bg-slate-950 text-sm font-bold text-cyan-300">
                        {plugin.symbol}
                      </div>
                      <div className="text-[10px] leading-tight text-slate-300">{plugin.name}</div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Footer hint */}
      <div className="border-t border-slate-800 p-2 text-center text-[10px] text-slate-500">
        Drag onto canvas or click to add
      </div>
    </div>
  );
}
