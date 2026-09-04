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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Network } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Find/Replace dialog — KiCad Ctrl+F
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
                    <th className="px-2 py-1 text-left">Color</th>
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
                        <input
                          type="color"
                          value={nc.color ?? '#22d3ee'}
                          onChange={(e) => updateNetClass(nc.id, { color: e.target.value })}
                          className="h-6 w-10 cursor-pointer rounded border border-slate-700 bg-slate-800"
                          title="Wire color for this net class"
                        />
                      </td>
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
