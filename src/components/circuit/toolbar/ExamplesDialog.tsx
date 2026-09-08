'use client';

// Example circuits browser — searchable accordion of categories.
//
// The library is ~45 circuits across 12 small categories (the
// examples-complex Falstad-class set + the classic retained examples); a
// flat dropdown no longer scales. This dialog gives each category its own
// collapsible section (multiple smaller accordion menus, easy to scan and
// find), with a search box that live-filters and auto-expands matching
// sections.

import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Search, Zap } from 'lucide-react';
import { exampleCategories, examples } from '@/lib/circuit/examples';
import type { CircuitDocument } from '@/lib/circuit/types';

export function ExamplesDialog({
  open,
  onOpenChange,
  loadDocument,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadDocument: (doc: CircuitDocument) => void;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return exampleCategories.map(cat => ({ ...cat, matchCount: cat.examples.length }));
    return exampleCategories
      .map(cat => {
        const hits = cat.examples.filter(ex =>
          ex.name.toLowerCase().includes(q) || ex.description.toLowerCase().includes(q) || cat.label.toLowerCase().includes(q),
        );
        return { label: cat.label, examples: hits, matchCount: hits.length };
      })
      .filter(cat => cat.matchCount > 0);
  }, [query]);

  const totalMatches = filtered.reduce((a, c) => a + c.matchCount, 0);

  // Auto-expand every section while searching; collapse to a sensible
  // default set otherwise (the first two categories).
  const defaultValue = query.trim()
    ? filtered.map(cat => cat.label)
    : [exampleCategories[0]?.label ?? '', exampleCategories[1]?.label ?? ''].filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100 max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-slate-800 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-slate-100">
            <Zap size={16} className="text-cyan-400" />
            Example Circuits
          </DialogTitle>
          <DialogDescription className="text-slate-400 text-xs">
            {examples.length} verified circuits across {exampleCategories.length} categories — every one is
            simulation-checked (transient + physics + current flow). Pick a category below, or search.
          </DialogDescription>
          <div className="relative mt-2">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search circuits (e.g. oscillator, 555, amplifier, rectifier)..."
              className="pl-9 bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-500 h-9"
              autoFocus
            />
            {query.trim() && (
              <Badge variant="secondary" className="absolute right-2 top-1/2 -translate-y-1/2 bg-slate-700 text-slate-300 text-[10px]">
                {totalMatches} match{totalMatches === 1 ? '' : 'es'}
              </Badge>
            )}
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-6 pb-4">
          <Accordion type="multiple" defaultValue={defaultValue} className="divide-y divide-slate-800">
            {filtered.map(cat => (
              <AccordionItem key={cat.label} value={cat.label} className="border-b-0">
                <AccordionTrigger className="py-3 text-slate-200 hover:no-underline group">
                  <span className="flex items-center gap-2 text-sm font-semibold tracking-wide">
                    <span className="text-cyan-400 uppercase text-[11px]">{cat.label}</span>
                    <Badge variant="secondary" className="bg-slate-800 text-slate-400 group-hover:bg-slate-700 text-[10px] font-normal">
                      {cat.matchCount}
                    </Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-3">
                  <div className="flex flex-col gap-1">
                    {cat.examples.map(ex => (
                      <button
                        key={ex.name}
                        onClick={() => {
                          loadDocument(ex.doc);
                          onOpenChange(false);
                          setQuery('');
                        }}
                        className="text-left rounded-md px-3 py-2 hover:bg-slate-800 focus-visible:bg-slate-800 focus-visible:outline-none transition-colors"
                      >
                        <span className="block text-sm font-medium text-slate-200">{ex.name}</span>
                        <span className="block text-xs text-slate-400 mt-0.5 leading-relaxed">{ex.description}</span>
                      </button>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
            {filtered.length === 0 && (
              <div className="py-10 text-center text-sm text-slate-500">
                No circuits match &ldquo;{query}&rdquo;.
              </div>
            )}
          </Accordion>
        </div>
      </DialogContent>
    </Dialog>
  );
}
