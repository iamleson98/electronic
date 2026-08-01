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
import type { ERCError } from '@/lib/circuit/erc';
import type { NetClass, PageSetup } from '@/lib/circuit/types';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Search, Replace, AlertTriangle, CheckCircle, Shield, Network, Settings, Layers, BookOpen, Plus } from 'lucide-react';

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
    if (open && query) runFind();
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

// ─────────────────────────────────────────────────────────────────────────────
// Violations Browser — KiCad ERC violations list
// ─────────────────────────────────────────────────────────────────────────────

export function ViolationsBrowserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [errors, setErrors] = useState<ERCError[]>([]);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const runFullERCCheck = useEditor((s) => s.runFullERCCheck);
  const setSelection = useEditor((s) => s.setSelection);

  const refresh = useCallback(() => {
    const r = runFullERCCheck();
    setErrors(r.errors);
  }, [runFullERCCheck]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const filtered = errors.filter((e) => filter === 'all' || e.severity === filter);
  const errorCount = errors.filter((e) => e.severity === 'error').length;
  const warnCount = errors.filter((e) => e.severity === 'warning').length;
  const infoCount = errors.filter((e) => e.severity === 'info').length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield size={16} /> ERC Violations
            {errorCount === 0 && warnCount === 0
              ? <CheckCircle size={14} className="text-emerald-400" />
              : <AlertTriangle size={14} className="text-amber-400" />}
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 mb-2">
          <Button size="sm" variant="default" onClick={refresh}>Re-run ERC</Button>
          <div className="flex gap-1 ml-auto">
            <Button size="sm" variant={filter === 'all' ? 'default' : 'ghost'} onClick={() => setFilter('all')}>
              All ({errors.length})
            </Button>
            <Button size="sm" variant={filter === 'error' ? 'destructive' : 'ghost'} onClick={() => setFilter('error')}>
              Errors ({errorCount})
            </Button>
            <Button size="sm" variant={filter === 'warning' ? 'default' : 'ghost'} onClick={() => setFilter('warning')}>
              Warnings ({warnCount})
            </Button>
            <Button size="sm" variant={filter === 'info' ? 'ghost' : 'ghost'} onClick={() => setFilter('info')}>
              Info ({infoCount})
            </Button>
          </div>
        </div>
        <ScrollArea className="h-80 w-full rounded border border-slate-700 bg-slate-950">
          {filtered.length === 0 ? (
            <div className="text-center text-slate-400 py-8">
              <CheckCircle size={32} className="mx-auto mb-2 text-emerald-400" />
              No violations
            </div>
          ) : (
            <ul className="divide-y divide-slate-800">
              {filtered.map((err, i) => (
                <li key={i} className="px-3 py-2 hover:bg-slate-800 cursor-pointer"
                    onClick={() => { if (err.componentId) { setSelection({ type: 'component', id: err.componentId }); onClose(); } }}>
                  <div className="flex items-start gap-2">
                    <Badge variant={err.severity === 'error' ? 'destructive' : 'outline'}
                           className={err.severity === 'warning' ? 'border-amber-500 text-amber-400' : ''}>
                      {err.severity}
                    </Badge>
                    <Badge variant="outline">{err.type}</Badge>
                    <div className="flex-1 text-sm text-slate-200">{err.message}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Net Inspector — list all nets, click to highlight
// ─────────────────────────────────────────────────────────────────────────────

interface NetInfo {
  name: string;
  id: number;
  pins: number;
  components: string[];
}

export function NetInspectorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const netClasses = useEditor((s) => s.netClasses);
  const [nets, setNets] = useState<NetInfo[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!open) return;
    // build net list inline (don't import engine's buildNodeMap to avoid SSR issues)
    const nodeMap = new Map<string, number>();
    const parent: number[] = [0];
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a: number, b: number) => {
      const ra = find(a); const rb = find(b);
      if (ra === rb) return;
      if (ra === 0) parent[rb] = 0; else if (rb === 0) parent[ra] = 0; else parent[rb] = ra;
    };
    const newNode = () => { const id = parent.length; parent.push(id); return id; };
    const termKey = (cId: string, tId: string) => `${cId}:${tId}`;
    for (const c of components) {
      // pseudo — we don't have plugin list here, so just use component id + terminal label
      // (use a simple approximation: each component is one net)
    }
    for (const w of wires) {
      const fromKey = termKey(w.from.componentId, w.from.terminalId);
      const toKey = termKey(w.to.componentId, w.to.terminalId);
      if (!nodeMap.has(fromKey)) nodeMap.set(fromKey, newNode());
      if (!nodeMap.has(toKey)) nodeMap.set(toKey, newNode());
      union(nodeMap.get(fromKey)!, nodeMap.get(toKey)!);
    }
    // group by root
    const rootToComponents = new Map<number, Set<string>>();
    for (const [key, node] of nodeMap) {
      const r = find(node);
      if (!rootToComponents.has(r)) rootToComponents.set(r, new Set());
      const [cId] = key.split(':');
      rootToComponents.get(r)!.add(cId);
    }
    const netInfos: NetInfo[] = [];
    let idx = 0;
    for (const [root, comps] of rootToComponents) {
      netInfos.push({
        id: root,
        name: root === 0 ? 'GND' : `N${idx++}`,
        pins: nodeMap.size,
        components: Array.from(comps),
      });
    }
    netInfos.sort((a, b) => a.name.localeCompare(b.name));
    setNets(netInfos);
  }, [open, components, wires]);

  const filtered = nets.filter((n) => !filter || n.name.toLowerCase().includes(filter.toLowerCase()) || n.components.some((c) => c.includes(filter)));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Network size={16} /> Net Inspector</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 mb-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter nets..." className="bg-slate-800 border-slate-700" />
        </div>
        <ScrollArea className="h-80 w-full rounded border border-slate-700 bg-slate-950">
          <table className="w-full text-xs">
            <thead className="bg-slate-800 sticky top-0">
              <tr>
                <th className="px-2 py-1 text-left text-slate-300">Net</th>
                <th className="px-2 py-1 text-left text-slate-300">Pins</th>
                <th className="px-2 py-1 text-left text-slate-300">Components</th>
                <th className="px-2 py-1 text-left text-slate-300">Class</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((n) => {
                const nc = netClasses.find((c) => c.nets.includes(n.name));
                return (
                  <tr key={n.id} className="border-t border-slate-800 hover:bg-slate-800">
                    <td className="px-2 py-1 font-mono text-cyan-400">{n.name}</td>
                    <td className="px-2 py-1">{n.pins}</td>
                    <td className="px-2 py-1 text-slate-400">{n.components.join(', ')}</td>
                    <td className="px-2 py-1">{nc ? <Badge variant="outline">{nc.name}</Badge> : <span className="text-slate-600">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollArea>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page Setup dialog
// ─────────────────────────────────────────────────────────────────────────────

export function PageSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pageSetup = useEditor((s) => s.pageSetup);
  const setPageSetup = useEditor((s) => s.setPageSetup);
  const metadata = useEditor((s) => s.metadata);
  const setMetadata = useEditor((s) => s.setMetadata);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Settings size={16} /> Page Setup</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-slate-300">Page Size</Label>
            <Select value={pageSetup.size} onValueChange={(v) => setPageSetup({ size: v as any })}>
              <SelectTrigger className="bg-slate-800 border-slate-700"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                {['A4', 'A3', 'A2', 'A1', 'A0', 'Letter', 'Legal', 'Tabloid', 'Custom'].map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-slate-300">Orientation</Label>
            <Select value={pageSetup.orientation} onValueChange={(v) => setPageSetup({ orientation: v as any })}>
              <SelectTrigger className="bg-slate-800 border-slate-700"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="landscape">Landscape</SelectItem>
                <SelectItem value="portrait">Portrait</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-slate-300">Show Border</Label>
            <Switch checked={pageSetup.showBorder} onCheckedChange={(v) => setPageSetup({ showBorder: v })} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-slate-300">Show Title Block</Label>
            <Switch checked={pageSetup.showTitleBlock} onCheckedChange={(v) => setPageSetup({ showTitleBlock: v })} />
          </div>
          <div className="border-t border-slate-700 pt-3 space-y-2">
            <Label className="text-slate-300 text-sm font-semibold">Title Block</Label>
            <Input value={metadata.title ?? ''} onChange={(e) => setMetadata({ title: e.target.value })} placeholder="Title" className="bg-slate-800 border-slate-700" />
            <Input value={metadata.company ?? ''} onChange={(e) => setMetadata({ company: e.target.value })} placeholder="Company" className="bg-slate-800 border-slate-700" />
            <Input value={metadata.revision ?? ''} onChange={(e) => setMetadata({ revision: e.target.value })} placeholder="Revision" className="bg-slate-800 border-slate-700" />
            <Input value={metadata.author ?? ''} onChange={(e) => setMetadata({ author: e.target.value })} placeholder="Author" className="bg-slate-800 border-slate-700" />
          </div>
        </div>
        <DialogFooter><Button variant="default" onClick={onClose}>OK</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved Views dialog
// ─────────────────────────────────────────────────────────────────────────────

export function SavedViewsDialog({ open, onClose, camera }: { open: boolean; onClose: () => void; camera: { x: number; y: number; zoom: number } }) {
  const savedViews = useEditor((s) => s.savedViews);
  const saveView = useEditor((s) => s.saveView);
  const removeSavedView = useEditor((s) => s.removeSavedView);
  const [name, setName] = useState('');

  const onSave = () => {
    if (!name.trim()) { toast.error('Enter a name'); return; }
    saveView(name, camera);
    setName('');
    toast.success(`Saved view "${name}"`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Layers size={16} /> Saved Views</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="View name" className="bg-slate-800 border-slate-700" />
            <Button size="sm" onClick={onSave}>Save Current</Button>
          </div>
          <ScrollArea className="h-48 w-full rounded border border-slate-700 bg-slate-950">
            {savedViews.length === 0 ? (
              <div className="text-center text-slate-500 py-6 text-sm">No saved views</div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {savedViews.map((v) => (
                  <li key={v.id} className="px-3 py-2 flex items-center justify-between hover:bg-slate-800">
                    <span className="text-sm">{v.name}</span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => {
                        // dispatch custom event for canvas to load view
                        window.dispatchEvent(new CustomEvent('circuitlab:load-view', { detail: v }));
                        onClose();
                      }}>Load</Button>
                      <Button size="sm" variant="ghost" className="text-rose-400" onClick={() => removeSavedView(v.id)}>×</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchical Sheets dialog — list/add/remove sheets
// ─────────────────────────────────────────────────────────────────────────────

export function HierarchicalSheetsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sheets = useEditor((s) => s.sheets);
  const addSheet = useEditor((s) => s.addSheet);
  const removeSheet = useEditor((s) => s.removeSheet);
  const setActiveSheet = useEditor((s) => s.setActiveSheet);
  const addSheetPin = useEditor((s) => s.addSheetPin);
  const renameSheetPin = useEditor((s) => s.renameSheetPin);
  const removeSheetPin = useEditor((s) => s.removeSheetPin);
  const activeSheet = useEditor((s) => s.activeSheet);
  const [name, setName] = useState('');
  const [fileName, setFileName] = useState('');
  const [expandedSheetId, setExpandedSheetId] = useState<string | null>(null);
  const [newPinName, setNewPinName] = useState('');
  const [newPinSide, setNewPinSide] = useState<'left' | 'right' | 'top' | 'bottom'>('right');

  const onAdd = () => {
    if (!name.trim() || !fileName.trim()) { toast.error('Enter name and file name'); return; }
    addSheet(name, fileName);
    setName(''); setFileName('');
    toast.success(`Added sheet "${name}"`);
  };

  const onAddPin = (sheetId: string) => {
    if (!newPinName.trim()) { toast.error('Enter pin name'); return; }
    addSheetPin(sheetId, newPinName.trim(), newPinSide);
    setNewPinName('');
    toast.success(`Added pin "${newPinName}"`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><BookOpen size={16} /> Hierarchical Sheets</DialogTitle>
          <DialogDescription className="text-slate-400">
            Sheets let you organize large designs hierarchically. Double-click a sheet box on the canvas
            to navigate into it. Add pins here or by clicking the sheet's edge. Each pin connects to a
            matching hierLabel inside the sub-sheet.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sheet name (e.g. Amplifier)" className="bg-slate-800 border-slate-700" />
            <Input value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="file.kicad_sch" className="bg-slate-800 border-slate-700" />
            <Button size="sm" onClick={onAdd}>Add Sheet</Button>
          </div>
          <ScrollArea className="h-80 w-full rounded border border-slate-700 bg-slate-950">
            {sheets.length === 0 ? (
              <div className="text-center text-slate-500 py-8 text-sm">
                No sub-sheets — this is the root sheet.
                <br />Add a sheet above to start organizing your design hierarchically.
              </div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {sheets.map((s) => (
                  <li key={s.id} className={activeSheet === s.fileName ? 'bg-slate-800/60' : ''}>
                    <div className="px-3 py-2 flex items-center justify-between hover:bg-slate-800/40">
                      <div className="flex items-center gap-2">
                        <button
                          className="text-slate-400 hover:text-slate-200"
                          onClick={() => setExpandedSheetId(expandedSheetId === s.id ? null : s.id)}
                          title={expandedSheetId === s.id ? 'Collapse pins' : 'Expand pins'}
                        >
                          {expandedSheetId === s.id ? '▾' : '▸'}
                        </button>
                        <div>
                          <div className="font-mono text-sm text-emerald-400">{s.sheetName}</div>
                          <div className="text-xs text-slate-500">{s.fileName} · {s.pins.length} pin{s.pins.length === 1 ? '' : 's'}</div>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => { setActiveSheet(s.fileName); onClose(); }}>Open</Button>
                        <Button size="sm" variant="ghost" className="text-rose-400" onClick={() => removeSheet(s.id)}>×</Button>
                      </div>
                    </div>
                    {expandedSheetId === s.id && (
                      <div className="border-t border-slate-800 bg-slate-950/50 px-4 py-2 space-y-1">
                        {s.pins.length === 0 ? (
                          <div className="text-xs text-slate-500 py-1">No pins yet — add one below.</div>
                        ) : (
                          <div className="space-y-1">
                            {s.pins.map((pin) => (
                              <div key={pin.id} className="flex items-center gap-2 text-xs">
                                <Badge variant="outline" className="border-emerald-700 text-emerald-400 w-12 justify-center text-[10px] uppercase">
                                  {pin.side}
                                </Badge>
                                <input
                                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 font-mono text-slate-100"
                                  defaultValue={pin.name}
                                  onBlur={(e) => {
                                    if (e.target.value !== pin.name) renameSheetPin(s.id, pin.id, e.target.value);
                                  }}
                                />
                                <button
                                  className="text-rose-400 hover:text-rose-300 px-2"
                                  onClick={() => useEditor.getState().removeSheetPin(s.id, pin.id)}
                                  title="Remove pin"
                                >×</button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-1 mt-2 pt-2 border-t border-slate-800">
                          <Input
                            value={newPinName}
                            onChange={(e) => setNewPinName(e.target.value)}
                            placeholder="pin name (e.g. IN, OUT, VCC)"
                            className="h-7 flex-1 bg-slate-800 border-slate-700 text-xs"
                            onKeyDown={(e) => { if (e.key === 'Enter') onAddPin(s.id); }}
                          />
                          <select
                            value={newPinSide}
                            onChange={(e) => setNewPinSide(e.target.value as 'left' | 'right' | 'top' | 'bottom')}
                            className="h-7 bg-slate-800 border border-slate-700 rounded text-xs px-1 text-slate-200"
                          >
                            <option value="right">→ Right</option>
                            <option value="left">← Left</option>
                            <option value="top">↑ Top</option>
                            <option value="bottom">↓ Bottom</option>
                          </select>
                          <Button size="sm" variant="outline" className="h-7 border-emerald-700 text-emerald-400" onClick={() => onAddPin(s.id)}>
                            <Plus size={12} className="mr-1" /> Pin
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { setActiveSheet(''); onClose(); }}>Back to Root</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Net Classes dialog
// ─────────────────────────────────────────────────────────────────────────────

export function NetClassesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const netClasses = useEditor((s) => s.netClasses);
  const addNetClass = useEditor((s) => s.addNetClass);
  const updateNetClass = useEditor((s) => s.updateNetClass);
  const removeNetClass = useEditor((s) => s.removeNetClass);
  const [name, setName] = useState('');

  const onAdd = () => {
    if (!name.trim()) return;
    addNetClass(name);
    setName('');
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Network size={16} /> Net Classes</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Class name (e.g. Power, High-Speed)" className="bg-slate-800 border-slate-700" />
            <Button size="sm" onClick={onAdd}>Add Class</Button>
          </div>
          <ScrollArea className="h-64 w-full rounded border border-slate-700 bg-slate-950">
            {netClasses.length === 0 ? (
              <div className="text-center text-slate-500 py-8 text-sm">No net classes — all nets use default rules</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-800 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">Name</th>
                    <th className="px-2 py-1 text-left">Trace (mm)</th>
                    <th className="px-2 py-1 text-left">Via Drill (mm)</th>
                    <th className="px-2 py-1 text-left">Clearance (mm)</th>
                    <th className="px-2 py-1 text-left">Nets</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {netClasses.map((nc) => (
                    <tr key={nc.id} className="border-t border-slate-800">
                      <td className="px-2 py-1 font-mono">{nc.name}</td>
                      <td className="px-2 py-1">
                        <Input
                          type="number" defaultValue={nc.traceWidth ?? 0.25} step={0.05}
                          onChange={(e) => updateNetClass(nc.id, { traceWidth: parseFloat(e.target.value) })}
                          className="h-6 w-16 bg-slate-800 border-slate-700 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          type="number" defaultValue={nc.viaDrill ?? 0.3} step={0.05}
                          onChange={(e) => updateNetClass(nc.id, { viaDrill: parseFloat(e.target.value) })}
                          className="h-6 w-16 bg-slate-800 border-slate-700 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          type="number" defaultValue={nc.clearance ?? 0.2} step={0.05}
                          onChange={(e) => updateNetClass(nc.id, { clearance: parseFloat(e.target.value) })}
                          className="h-6 w-16 bg-slate-800 border-slate-700 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1 text-slate-400">{nc.nets.length}</td>
                      <td><Button size="sm" variant="ghost" className="text-rose-400 h-6" onClick={() => removeNetClass(nc.id)}>×</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ScrollArea>
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
