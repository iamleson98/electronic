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
