'use client';
import { Param, Stat } from './shared';

// Simulation analysis UI — KiCad/ngspice parity.
//
// Provides:
//   - AnalysisDialog: configure and run AC / DC sweep / TF / Sens / Noise / Disto / Tran
//   - BatchSweepDialog: configure .step / .mc / .worst sweeps
//   - MeasurementDialog: run .meas post-process on traces
//   - OptionsDialog: edit sim options (reltol, gmin, method, temp, etc.)
//   - StimuliEditor: build PWL/SINE/PULSE/SFFM/EXP stimuli
//   - ResultsViewer: display traces + measurements + statistics

import { useEffect, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Waves,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Dialog — choose analysis type, configure, run
// ─────────────────────────────────────────────────────────────────────────────



export function BatchSweepDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const components = useEditor((s) => s.components);
  const runBatch = useEditor((s) => s.runBatch);
  const [batchType, setBatchType] = useState<'step' | 'mc' | 'worst'>('step');
  const [param, setParam] = useState('resistance');
  const [componentId, setComponentId] = useState('');
  const [start, setStart] = useState(1000);
  const [stop, setStop] = useState(10000);
  const [step, setStep] = useState(1000);
  const [runs, setRuns] = useState(50);
  const [tolerance, setTolerance] = useState(0.05);
  const [dist, setDist] = useState<'uniform' | 'gaussian' | 'worst_case'>('uniform');
  // Per-part tolerance table: component id → tolerance fraction. Rows default
  // from each part's own `tolerance` field; edits write back to the component
  // so Monte-Carlo uses them (config list empty → per-part mode).
  const [usePerPart, setUsePerPart] = useState(true);
  interface BatchRunResults {
    traces: { xValues: Float64Array; yValues: Float64Array }[];
    durationMs: number;
    stats?: { min: number; max: number; mean: number; std: number };
  }
  const [results, setResults] = useState<BatchRunResults | null>(null);

  useEffect(() => {
    if (open && !componentId && components.length > 0) {
      const c = components.find((c) => c.type === 'resistor') ?? components[0];
      if (c && componentId !== c.id) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setComponentId(c.id);
      }
    }
  }, [open, components, componentId]);

  const run = () => {
    const result = runBatch({
      type: batchType,
      param, componentId,
      start, stop, step,
      runs, tolerance,
      distribution: dist,
      inner: { type: 'ac', sweep: 'dec' as const, nPoints: 5, fStart: 10, fStop: 100000, sourceId: components.find(c => c.type === 'acVoltage')?.id ?? '', outputNode: 'p' },
    });
    setResults(result);
    if (result.stats) {
      toast.success(`Monte Carlo: mean=${result.stats.mean.toFixed(4)} σ=${result.stats.std.toFixed(4)}`);
    } else {
      toast.success(`${batchType} sweep: ${result.traces.length} traces`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Waves size={16} /> Batch Sweep / Monte Carlo</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-slate-300 text-xs">Batch Type</Label>
              <Select value={batchType} onValueChange={(v) => setBatchType(v as 'step' | 'mc' | 'worst')}>
                <SelectTrigger className="bg-slate-800 border-slate-700 h-8"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-800">
                  <SelectItem value="step">.step (parametric)</SelectItem>
                  <SelectItem value="mc">.mc (Monte Carlo)</SelectItem>
                  <SelectItem value="worst">.worst (worst-case)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-slate-300 text-xs">Component</Label>
              <Select value={componentId} onValueChange={setComponentId}>
                <SelectTrigger className="bg-slate-800 border-slate-700 h-8"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-800">
                  {components.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.refdes ?? c.id} ({c.type})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-slate-300 text-xs">Parameter key (resistance, voltage, vth, ...)</Label>
            <Input value={param} onChange={(e) => setParam(e.target.value)} className="bg-slate-800 border-slate-700 h-8" />
          </div>
          {batchType === 'step' && (
            <div className="grid grid-cols-3 gap-2">
              <Param label="Start" value={start} step={1} onChange={setStart} />
              <Param label="Stop" value={stop} step={1} onChange={setStop} />
              <Param label="Step" value={step} step={1} onChange={setStep} />
            </div>
          )}
          {batchType === 'mc' && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Param label="Nominal Value" value={start} step={1} onChange={setStart} />
                <Param label="Runs" value={runs} step={1} onChange={setRuns} />
                <Param label="Tolerance (±)" value={tolerance} step={0.01} onChange={setTolerance} />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={usePerPart}
                  onChange={(e) => setUsePerPart(e.target.checked)}
                  className="h-3.5 w-3.5 accent-cyan-500"
                />
                Use per-part tolerances from the Production panel (uncheck for single global ±)
              </label>
              {usePerPart && (
                <div className="max-h-32 overflow-y-auto rounded border border-slate-700 bg-slate-950">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-800">
                      <tr>
                        <th className="px-2 py-1 text-left text-slate-300">Part</th>
                        <th className="px-2 py-1 text-left text-slate-300">Type</th>
                        <th className="px-2 py-1 text-left text-slate-300">± Tol</th>
                      </tr>
                    </thead>
                    <tbody>
                      {components.filter((c) => ['resistor', 'capacitor', 'inductor', 'potentiometer', 'led', 'diode', 'zener'].includes(c.type)).map((c) => (
                        <tr key={c.id} className="border-t border-slate-800">
                          <td className="px-2 py-1 font-mono text-cyan-300">{c.refdes ?? c.id}</td>
                          <td className="px-2 py-1 text-slate-400">{c.type}</td>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              min={0}
                              max={1}
                              step={0.01}
                              value={c.tolerance ?? 0.05}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value);
                                useEditor.setState((s) => ({
                                  components: s.components.map((x) => x.id === c.id ? { ...x, tolerance: Number.isFinite(v) ? v : undefined } : x),
                                }));
                              }}
                              className="w-20 rounded border border-slate-700 bg-slate-800 px-1 py-0.5 font-mono text-xs text-slate-200"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div>
                <Label className="text-slate-300 text-xs">Distribution</Label>
                <Select value={dist} onValueChange={(v) => setDist(v as 'uniform' | 'gaussian' | 'worst_case')}>
                  <SelectTrigger className="bg-slate-800 border-slate-700 h-8"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-800">
                    <SelectItem value="uniform">Uniform</SelectItem>
                    <SelectItem value="gaussian">Gaussian (3σ = tol)</SelectItem>
                    <SelectItem value="worst_case">Worst-case (±tol)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {batchType === 'worst' && (
            <div className="grid grid-cols-2 gap-2">
              <Param label="Nominal" value={start} step={1} onChange={setStart} />
              <Param label="Tolerance (±)" value={tolerance} step={0.01} onChange={setTolerance} />
            </div>
          )}
          <Button onClick={run} className="bg-cyan-500 text-slate-900">
            <Waves size={14} className="mr-1" /> Run Batch
          </Button>
          {results && (
            <div className="bg-slate-950 p-3 rounded border border-slate-700 text-xs space-y-2">
              <div className="text-slate-300">Result: {results.traces.length} traces in {results.durationMs.toFixed(0)}ms</div>
              {results.stats && (
                <div className="grid grid-cols-4 gap-2">
                  <Stat label="Min" value={results.stats.min} />
                  <Stat label="Max" value={results.stats.max} />
                  <Stat label="Mean" value={results.stats.mean} />
                  <Stat label="σ" value={results.stats.std} />
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
