'use client';

import { useEffect, useMemo, useState } from 'react';
import { getPluginsByCategory } from '@/lib/circuit/registry';
import { useEditor } from '@/lib/circuit/store';
import { Search, Cpu, Zap, Radio, Lightbulb, CircuitBoard, Gauge, Microchip, Layers } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ComponentIcon } from './ComponentIcon';

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
  const running = useEditor((s) => s.running);
  // Re-fetch the plugin list when a new plugin is registered at runtime
  // (e.g. from the Symbol Editor or Sub-Circuit dialog). Without this the
  // palette memoizes an empty-deps snapshot and never sees the new entry.
  const [registryVersion, setRegistryVersion] = useState(0);
  useEffect(() => {
    const handler = () => setRegistryVersion((v) => v + 1);
    window.addEventListener('circuitlab:plugin-registered', handler);
    return () => window.removeEventListener('circuitlab:plugin-registered', handler);
  }, []);
  const groups = useMemo(
    () => getPluginsByCategory(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registryVersion],
  );

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
    <div className="flex h-full min-h-0 flex-col bg-slate-900">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-800 p-3">
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

      {/* List - scrollable */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-2">
          {filtered.length === 0 && (
            <div className="p-4 text-center text-xs text-slate-500">No components found</div>
          )}
          {filtered.map((group) => {
            const Icon = categoryIcons[group.category] ?? CircuitBoard;
            return (
              <div key={group.category} className="mb-3">
                <div className="mb-1.5 flex items-center gap-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <Icon size={11} />
                  {categoryLabels[group.category] ?? group.category}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {group.plugins.map((plugin) => (
                    <button
                      key={plugin.type}
                      draggable={!running}
                      onDragStart={(e) => {
                        if (running) return;
                        e.dataTransfer.setData('application/x-circuit-type', plugin.type);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => {
                        if (running) return;
                        addComponent(plugin.type, { x: 8, y: 8 });
                      }}
                      disabled={running}
                      title={running ? 'Pause simulation to add components' : `${plugin.name} — ${plugin.description}`}
                      className="group flex flex-col items-center justify-start gap-1 rounded-md border border-slate-800 bg-slate-800/50 p-2 text-center transition-all hover:border-cyan-500/50 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <div className="flex h-10 w-full items-center justify-center rounded bg-slate-950">
                        <ComponentIcon type={plugin.type} size={40} />
                      </div>
                      <div className="text-[10px] leading-tight text-slate-300">{plugin.name}</div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer hint */}
      <div className="shrink-0 border-t border-slate-800 p-2 text-center text-[10px] text-slate-500">
        {running ? '⏸ Pause to edit' : 'Drag onto canvas or click to add'}
      </div>
    </div>
  );
}
