'use client';

import { useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import type { CircuitDocument } from '@/lib/circuit/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Upload, FileCode, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

const sampleNetlist = `* RC low-pass filter
V1 in 0 DC 0 SINE(0 5 100)
R1 in out 1k
C1 out 0 1u
.model DMOD D(Is=10f N=1)
.end`;

export function SpiceImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [netlist, setNetlist] = useState('');
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const loadDocument = useEditor((s) => s.loadDocument);

  const handleImport = async () => {
    if (!netlist.trim()) {
      toast.error('Please paste a SPICE netlist first');
      return;
    }
    setImporting(true);
    try {
      const res = await fetch('/api/spice/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ netlist }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      loadDocument(data.document as CircuitDocument);
      toast.success('SPICE netlist imported successfully');
      onClose();
    } catch (err) {
      toast.error('Import failed: ' + (err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setNetlist(reader.result as string);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl bg-slate-900 border-slate-700 text-slate-100 max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCode size={18} className="text-amber-400" />
            Import SPICE Netlist
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Paste a SPICE netlist (or drop a .cir / .net file). Supported: R, C, L, V (DC/SINE/PULSE),
            I, D, Q (NPN/PNP), M (NMOS/PMOS), X (sub-circuit calls), .model, .subckt/.ends, .ic.
          </DialogDescription>
        </DialogHeader>

        <div
          className={`rounded-md border-2 border-dashed p-3 transition-colors ${
            dragOver ? 'border-amber-400 bg-amber-400/10' : 'border-slate-700 bg-slate-800/40'
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <Label className="text-xs text-slate-400 mb-1.5 block">Netlist source</Label>
          <Textarea
            value={netlist}
            onChange={(e) => setNetlist(e.target.value)}
            placeholder={sampleNetlist}
            className="min-h-[300px] bg-slate-950 border-slate-700 font-mono text-xs text-slate-200"
            spellCheck={false}
          />
          <div className="flex items-center gap-2 mt-2">
            <label className="cursor-pointer">
              <input type="file" accept=".cir,.net,.sp,.txt" onChange={handleFileInput} className="hidden" />
              <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
                <Upload size={12} /> Choose .cir/.net file
              </span>
            </label>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-slate-400 hover:text-slate-200"
              onClick={() => setNetlist(sampleNetlist)}
            >
              <Sparkles size={12} className="mr-1" /> Load example
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            className="bg-amber-500 text-slate-900 hover:bg-amber-400"
            onClick={handleImport}
            disabled={importing}
          >
            <FileCode size={14} className="mr-1" />
            {importing ? 'Importing...' : 'Import Netlist'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
