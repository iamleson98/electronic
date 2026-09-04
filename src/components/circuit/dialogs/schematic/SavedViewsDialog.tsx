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
import { toast } from 'sonner';
import { Layers } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Find/Replace dialog — KiCad Ctrl+F
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
