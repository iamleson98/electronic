'use client';

import { useState } from 'react';
import { usePCB } from '@/lib/pcb/store';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Layers3, SlidersHorizontal, Activity, CheckCircle2, X } from 'lucide-react';
import {
  DEFAULT_LAYER_STACK, FOUR_LAYER_STACK, SIX_LAYER_STACK,
  LAYER_COLORS, type CopperLayer, type LayerStack,
} from '@/lib/pcb/types';

// ─────────────────────────────────────────────────────────────────────────────
// Layer Stack Dialog — pick 2/4/6-layer stackup, configure dielectric thickness
// ─────────────────────────────────────────────────────────────────────────────


export function LengthTuneDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const traces = usePCB((s) => s.traces);
  const selectedTraceId = usePCB((s) => s.selectedTraceId);
  const lengthTuneTrace = usePCB((s) => s.lengthTuneTrace);
  const [targetLength, setTargetLength] = useState(20);

  const selectedTrace = traces.find((t) => t.id === selectedTraceId);
  const currentLength = selectedTrace
    ? selectedTrace.segments.reduce((s, seg) => s + Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y), 0)
    : 0;

  const apply = () => {
    if (!selectedTraceId) {
      toast.error('Select a trace first');
      return;
    }
    lengthTuneTrace(selectedTraceId, targetLength);
    toast.success(`Length-tuned to ${targetLength}mm (added ${(targetLength - currentLength).toFixed(2)}mm meander)`);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Activity size={16} /> Length Tuning</DialogTitle>
          <DialogDescription>Add a serpentine meander to the selected trace to reach a target length. Useful for length matching differential pairs and clock skew.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="rounded-md border border-slate-700 bg-slate-950 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">Selected trace:</span>
              <span className="font-mono text-slate-200">{selectedTraceId ?? 'none'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Net:</span>
              <span className="font-mono text-slate-200">{selectedTrace?.net ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Current length:</span>
              <span className="font-mono text-emerald-300">{currentLength.toFixed(2)} mm</span>
            </div>
          </div>
          <div>
            <Label className="text-xs text-slate-400 mb-1 block">Target length (mm)</Label>
            <Input
              type="number"
              value={targetLength}
              onChange={(e) => setTargetLength(parseFloat(e.target.value) || 0)}
              min={currentLength}
              step={0.5}
              className="bg-slate-800 border-slate-700"
            />
            <div className="text-xs text-slate-500 mt-1">
              Additional length needed: <span className="font-mono text-amber-400">{Math.max(0, targetLength - currentLength).toFixed(2)} mm</span>
            </div>
          </div>
          <div className="text-[10px] text-slate-500 bg-slate-800/50 rounded p-2">
            Note: Length tuning adds a serpentine meander pattern to the longest segment of the trace. The amplitude is fixed at 0.5mm; the number of bumps scales with the additional length needed.
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={apply}
            disabled={!selectedTraceId || targetLength <= currentLength}
            className="bg-amber-500 text-slate-900 hover:bg-amber-400"
          >
            Apply Meander
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
