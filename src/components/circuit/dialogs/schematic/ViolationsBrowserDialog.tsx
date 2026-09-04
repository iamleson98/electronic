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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertTriangle, CheckCircle, Shield } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Find/Replace dialog — KiCad Ctrl+F
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

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
    }
  }, [open, refresh]);

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
