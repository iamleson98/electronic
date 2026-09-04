'use client';

// Simulation analysis UI — KiCad/ngspice parity.
//
// Provides:
//   - AnalysisDialog: configure and run AC / DC sweep / TF / Sens / Noise / Disto / Tran
//   - BatchSweepDialog: configure .step / .mc / .worst sweeps
//   - MeasurementDialog: run .meas post-process on traces
//   - OptionsDialog: edit sim options (reltol, gmin, method, temp, etc.)
//   - StimuliEditor: build PWL/SINE/PULSE/SFFM/EXP stimuli
//   - ResultsViewer: display traces + measurements + statistics

import { useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { parseMeasLine } from '@/lib/circuit/measurement';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Sigma,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Dialog — choose analysis type, configure, run
// ─────────────────────────────────────────────────────────────────────────────



export function MeasurementDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lastResult = useEditor((s) => s.lastAnalysisResult);
  const runMeasurement = useEditor((s) => s.runMeasurement);
  const [measLine, setMeasLine] = useState('.meas tran vout_avg AVG V(out) FROM=0 TO=1ms');
  const [results, setResults] = useState<{ name: string; value: number; unit?: string }[]>([]);

  const runMeas = () => {
    const cmd = parseMeasLine(measLine);
    if (!cmd) {
      toast.error('Failed to parse .meas line');
      return;
    }
    if (!lastResult || lastResult.traces.length === 0) {
      toast.error('No traces to measure — run an analysis first');
      return;
    }
    const tr = lastResult.traces[0];
    const result = runMeasurement(cmd, tr);
    setResults([...results, result]);
    toast.success(`Measurement "${result.name}" = ${result.value.toFixed(6)}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sigma size={16} /> Measurements (.meas)</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-slate-300">.meas command</Label>
            <Textarea
              value={measLine}
              onChange={(e) => setMeasLine(e.target.value)}
              className="bg-slate-800 border-slate-700 font-mono text-xs"
              rows={2}
            />
          </div>
          <div className="text-xs text-slate-400 bg-slate-950 p-2 rounded">
            <div className="font-mono">.meas tran &lt;name&gt; AVG|MIN|MAX|PP|RMS V(node) FROM=t1 TO=t2</div>
            <div className="font-mono">.meas tran &lt;name&gt; FIND V(out) WHEN V(in)=value</div>
            <div className="font-mono">.meas tran &lt;name&gt; WHEN V(node)=value</div>
            <div className="font-mono">.meas tran &lt;name&gt; TRIG V(in)=v1 TARG V(out)=v2</div>
          </div>
          <Button onClick={runMeas} className="bg-cyan-500 text-slate-900">
            <Sigma size={14} className="mr-1" /> Run Measurement
          </Button>
          <ScrollArea className="h-48 w-full rounded border border-slate-700 bg-slate-950">
            {results.length === 0 ? (
              <div className="text-center text-slate-500 py-6 text-sm">No measurements yet</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-800 sticky top-0">
                  <tr><th className="px-2 py-1 text-left">Name</th><th className="px-2 py-1 text-left">Value</th><th className="px-2 py-1 text-left">Unit</th></tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="border-t border-slate-800">
                      <td className="px-2 py-1 font-mono text-cyan-400">{r.name}</td>
                      <td className="px-2 py-1 font-mono">{r.value.toFixed(6)}</td>
                      <td className="px-2 py-1 text-slate-400">{r.unit ?? ''}</td>
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
