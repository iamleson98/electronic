'use client';

// KiCad-parity schematic dialogs:
//   - FindReplaceDialog
//   - ViolationsBrowserDialog
//   - NetInspectorDialog
//   - SymbolEditorDialog (basic)
//   - PageSetupDialog
//   - SavedViewsDialog
//   - HierarchicalSheetsDialog

import { useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { BookOpen, Plus } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Find/Replace dialog — KiCad Ctrl+F
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
                                  onClick={() => removeSheetPin(s.id, pin.id)}
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
