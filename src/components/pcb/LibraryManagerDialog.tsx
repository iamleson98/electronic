'use client';

import { useState, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Library, Search, Package, ExternalLink } from 'lucide-react';
import { getAllPlugins, getPluginsByCategory } from '@/lib/circuit/registry';
import { searchParts, type PartInfo } from '@/lib/pcb/part-database';
import { footprintDefs } from '@/lib/pcb/footprints';

interface Props { open: boolean; onClose: () => void; }

export function LibraryManagerDialog({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => getPluginsByCategory(), []);
  const filteredGroups = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.toLowerCase();
    return groups.map(g => ({
      ...g,
      plugins: g.plugins.filter(p =>
        p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
      ),
    })).filter(g => g.plugins.length > 0);
  }, [groups, query]);

  const parts = useMemo(() => searchParts(query), [query]);
  const footprintList = useMemo(() => Object.entries(footprintDefs), []);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden bg-slate-900 border-slate-700">
        <DialogHeader>
          <DialogTitle className="text-slate-100 flex items-center gap-2">
            <Library size={18} /> Library Manager
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Browse symbols, footprints, and manufacturer parts.
          </DialogDescription>
        </DialogHeader>

        <div className="relative mb-3">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-500" />
          <input
            placeholder="Search components, footprints, parts..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-8 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded pl-8 pr-2"
          />
        </div>

        <ScrollArea className="h-[60vh]">
          <div className="space-y-4">
            {/* Symbols */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                Symbols ({filteredGroups.reduce((a, g) => a + g.plugins.length, 0)})
              </h3>
              <div className="grid grid-cols-4 gap-1">
                {filteredGroups.map(g => g.plugins.map(p => (
                  <div key={p.type} className="p-2 rounded border border-slate-800 bg-slate-950 text-xs">
                    <div className="font-medium text-slate-200 truncate">{p.name}</div>
                    <div className="text-[10px] text-slate-500 font-mono truncate">{p.type}</div>
                  </div>
                )))}
              </div>
            </div>

            {/* Footprints */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                Footprints ({footprintList.length})
              </h3>
              <div className="grid grid-cols-6 gap-1">
                {footprintList.filter(([type]) => !query || type.toLowerCase().includes(query.toLowerCase())).map(([type, def]) => (
                  <div key={type} className="p-2 rounded border border-slate-800 bg-slate-950 text-xs">
                    <div className="font-mono text-slate-300 truncate">{type}</div>
                    <div className="text-[10px] text-slate-500">{def.bodySize.width}×{def.bodySize.height}mm · {def.pads.length} pads</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Parts Database */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                Parts Database ({parts.length})
              </h3>
              <div className="space-y-1">
                {parts.slice(0, 30).map(p => <PartCard key={p.mpn} part={p} />)}
                {parts.length > 30 && <div className="text-center text-[10px] text-slate-500 py-2">Showing 30 of {parts.length} — refine search</div>}
              </div>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function PartCard({ part }: { part: PartInfo }) {
  return (
    <div className="p-2 rounded border border-slate-800 bg-slate-950 flex items-start justify-between gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-cyan-300 text-xs">{part.mpn}</span>
          <span className="text-[10px] text-slate-500">{part.manufacturer}</span>
        </div>
        <div className="text-xs text-slate-300 mt-0.5">{part.description}</div>
        <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
          <span>📦 {part.package}</span>
          {part.unitPrice && <span>${part.unitPrice.toFixed(2)}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {part.datasheet && (
          <a href={part.datasheet} target="_blank" rel="noopener noreferrer" className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
            <ExternalLink size={10} /> Datasheet
          </a>
        )}
        {part.digikeyPN && (
          <a href={`https://www.digikey.com/products/en?keywords=${encodeURIComponent(part.digikeyPN)}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1">
            <ExternalLink size={10} /> DigiKey
          </a>
        )}
        {part.mouserPN && (
          <a href={`https://www.mouser.com/c/?q=${encodeURIComponent(part.mouserPN)}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
            <ExternalLink size={10} /> Mouser
          </a>
        )}
      </div>
    </div>
  );
}
