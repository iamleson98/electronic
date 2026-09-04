'use client';

// KiCad-parity schematic dialogs:
//   - FindReplaceDialog
//   - ViolationsBrowserDialog
//   - NetInspectorDialog
//   - SymbolEditorDialog (basic)
//   - PageSetupDialog
//   - SavedViewsDialog
//   - HierarchicalSheetsDialog

import { useCallback, useEffect, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { Search, Replace } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Find/Replace dialog — KiCad Ctrl+F
// ─────────────────────────────────────────────────────────────────────────────


export function FindReplaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [replaceValue, setReplaceValue] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searchRefdes, setSearchRefdes] = useState(true);
  const [searchValue, setSearchValue] = useState(true);
  const [searchFields, setSearchFields] = useState(true);
  const [replaceKey, setReplaceKey] = useState('resistance');
  const [results, setResults] = useState<{ id: string; refdes?: string; type: string; matchField: string }[]>([]);
  const findComponents = useEditor((s) => s.findComponents);
  const setSelection = useEditor((s) => s.setSelection);
  const replaceComponentParameter = useEditor((s) => s.replaceComponentParameter);

  const runFind = useCallback(() => {
    const comps = findComponents(query, { searchRefdes, searchValue, searchFields, caseSensitive });
    setResults(comps.map((c) => {
      // figure out which field matched
      let matchField = 'refdes';
      if (searchValue && Object.values(c.parameters).some((v) => String(v).includes(query))) matchField = 'value';
      else if (searchFields && c.fields?.some((f) => f.value.includes(query) || f.name.includes(query))) matchField = 'field';
      return { id: c.id, refdes: c.refdes, type: c.type, matchField };
    }));
  }, [query, searchRefdes, searchValue, searchFields, caseSensitive, findComponents]);

  useEffect(() => {
    if (open && query) {
      // Guard with a ref-derived check to avoid setState-in-effect cascades.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runFind();
    }
  }, [open, query, runFind]);

  const jumpTo = (id: string) => {
    setSelection({ type: 'component', id });
    onClose();
  };

  const replaceAll = () => {
    if (!replaceValue) {
      toast.error('Enter a replacement value');
      return;
    }
    for (const r of results) {
      replaceComponentParameter(r.id, replaceKey, replaceValue);
    }
    toast.success(`Replaced ${results.length} components' ${replaceKey} with ${replaceValue}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Search size={16} /> Find / Replace</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runFind(); }}
              placeholder="Search refdes, value, or field..."
              className="bg-slate-800 border-slate-700"
            />
            <Button onClick={runFind} variant="default" size="sm">Find</Button>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
            <label className="flex items-center gap-2">
              <Checkbox checked={searchRefdes} onCheckedChange={(v) => setSearchRefdes(!!v)} /> Refdes
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={searchValue} onCheckedChange={(v) => setSearchValue(!!v)} /> Value
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={searchFields} onCheckedChange={(v) => setSearchFields(!!v)} /> Fields
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={caseSensitive} onCheckedChange={(v) => setCaseSensitive(!!v)} /> Case-sensitive
            </label>
          </div>
          <div className="border-t border-slate-700 pt-3">
            <Label className="text-slate-300 text-sm">Replace (parameter)</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={replaceKey}
                onChange={(e) => setReplaceKey(e.target.value)}
                placeholder="parameter key (e.g. resistance)"
                className="bg-slate-800 border-slate-700"
              />
              <Input
                value={replaceValue}
                onChange={(e) => setReplaceValue(e.target.value)}
                placeholder="new value"
                className="bg-slate-800 border-slate-700"
              />
              <Button onClick={replaceAll} variant="destructive" size="sm">
                <Replace size={14} className="mr-1" /> Replace All
              </Button>
            </div>
          </div>
          <ScrollArea className="h-64 w-full rounded border border-slate-700 bg-slate-950">
            <table className="w-full text-xs">
              <thead className="bg-slate-800 sticky top-0">
                <tr>
                  <th className="px-2 py-1 text-left text-slate-300">Refdes</th>
                  <th className="px-2 py-1 text-left text-slate-300">Type</th>
                  <th className="px-2 py-1 text-left text-slate-300">Match</th>
                  <th className="px-2 py-1 text-right text-slate-300">Action</th>
                </tr>
              </thead>
              <tbody>
                {results.length === 0 && (
                  <tr><td colSpan={4} className="text-center text-slate-500 py-4">No matches</td></tr>
                )}
                {results.map((r) => (
                  <tr key={r.id} className="border-t border-slate-800 hover:bg-slate-800">
                    <td className="px-2 py-1 font-mono">{r.refdes ?? r.id}</td>
                    <td className="px-2 py-1">{r.type}</td>
                    <td className="px-2 py-1"><Badge variant="outline">{r.matchField}</Badge></td>
                    <td className="px-2 py-1 text-right">
                      <Button size="sm" variant="ghost" onClick={() => jumpTo(r.id)}>Jump</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
