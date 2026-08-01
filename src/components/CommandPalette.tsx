'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Dialog, DialogContent,
} from '@/components/ui/dialog';
import { Search, ChevronRight } from 'lucide-react';
import { useEditor } from '@/lib/circuit/store';
import { usePCB } from '@/lib/pcb/store';
import { getAllPlugins } from '@/lib/circuit/registry';
import { toast } from 'sonner';

interface Command { id: string; label: string; category: string; icon: React.ReactNode; action: () => void; shortcut?: string; }
interface Props { open: boolean; onClose: () => void; }

export function CommandPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) { setQuery(''); setSelectedIndex(0); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const editor = useEditor.getState();
    const cmds: Command[] = [
      { id: 'run', label: 'Run Simulation', category: 'Simulation', icon: <span>▶</span>, action: () => editor.setRunning(true), shortcut: 'Space' },
      { id: 'pause', label: 'Pause Simulation', category: 'Simulation', icon: <span>⏸</span>, action: () => editor.setRunning(false), shortcut: 'Space' },
      { id: 'step', label: 'Step Simulation', category: 'Simulation', icon: <span>⏭</span>, action: () => editor.step() },
      { id: 'reset', label: 'Reset Simulation', category: 'Simulation', icon: <span>↺</span>, action: () => editor.reset() },
      { id: 'erc', label: 'Run ERC', category: 'Schematic', icon: <span>✓</span>, action: () => {
        const r = editor.runERC();
        if (r.passed) toast.success(`ERC passed`); else toast.warning(`ERC: ${r.stats.errors} error(s)`);
      }},
      { id: 'undo', label: 'Undo', category: 'Edit', icon: <span>↶</span>, action: () => editor.undo(), shortcut: 'Ctrl+Z' },
      { id: 'redo', label: 'Redo', category: 'Edit', icon: <span>↷</span>, action: () => editor.redo(), shortcut: 'Ctrl+Y' },
      { id: 'clear', label: 'Clear Schematic', category: 'Schematic', icon: <span>🗑</span>, action: () => editor.clear() },
      { id: 'reannotate', label: 'Re-annotate Components', category: 'Schematic', icon: <span>№</span>, action: () => editor.reannotate() },
      { id: 'copy', label: 'Copy', category: 'Edit', icon: <span>⎘</span>, action: () => editor.copySelection(), shortcut: 'Ctrl+C' },
      { id: 'paste', label: 'Paste', category: 'Edit', icon: <span>📋</span>, action: () => editor.paste(), shortcut: 'Ctrl+V' },
      { id: 'pcb-import', label: 'Import to PCB', category: 'PCB', icon: <span>⬆</span>, action: () => {
        const s = useEditor.getState(); usePCB.getState().importFromSchematic(s.components, s.wires); toast.success('Imported to PCB');
      }},
      { id: 'pcb-drc', label: 'Run DRC', category: 'PCB', icon: <span>✓</span>, action: () => usePCB.getState().runDRC() },
      { id: 'pcb-topo-route', label: 'Auto-Route (Topological)', category: 'PCB', icon: <span>⚡</span>, action: () => usePCB.getState().runTopoRoute() },
      { id: 'pcb-gerbers', label: 'Export Gerbers', category: 'Manufacturing', icon: <span>⬇</span>, action: () => usePCB.getState().exportGerbers() },
      { id: 'pcb-teardrops', label: 'Generate Teardrops', category: 'PCB', icon: <span>💧</span>, action: () => usePCB.getState().generateTeardrops() },
      ...getAllPlugins().slice(0, 15).map(p => ({
        id: `add-${p.type}`, label: `Add ${p.name}`, category: 'Components', icon: <span>+</span>,
        action: () => editor.addComponent(p.type, { x: 8, y: 8 }),
      })),
    ];
    return cmds;
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter(c => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => { setSelectedIndex(0); }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const cmd = filtered[selectedIndex]; if (cmd) { cmd.action(); onClose(); } }
  };

  const grouped = useMemo(() => {
    const g = new Map<string, Command[]>();
    for (const cmd of filtered) { if (!g.has(cmd.category)) g.set(cmd.category, []); g.get(cmd.category)!.push(cmd); }
    return Array.from(g.entries());
  }, [filtered]);

  let flatIndex = 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden bg-slate-900 border-slate-700 p-0">
        <div className="flex items-center gap-2 border-b border-slate-800 p-3">
          <Search size={16} className="text-slate-500" />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Type a command..." className="flex-1 bg-transparent text-slate-200 text-sm outline-none placeholder:text-slate-600" />
          <kbd className="text-[10px] text-slate-500 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700">ESC</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {grouped.map(([category, cmds]) => (
            <div key={category}>
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-950/50">{category}</div>
              {cmds.map(cmd => {
                const idx = flatIndex++;
                return (
                  <button key={cmd.id} onMouseEnter={() => setSelectedIndex(idx)} onClick={() => { cmd.action(); onClose(); }}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm ${idx === selectedIndex ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:bg-slate-800'}`}>
                    <span className="text-slate-500 w-4 text-center">{cmd.icon}</span>
                    <span className="flex-1">{cmd.label}</span>
                    {cmd.shortcut && <kbd className="text-[10px] text-slate-500 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700">{cmd.shortcut}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && <div className="p-8 text-center text-sm text-slate-500">No commands found</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
