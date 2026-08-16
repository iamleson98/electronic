'use client';
import { Param, TraceSparkline } from './shared';

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
import type { AnalysisConfig, AnalysisResult } from '@/lib/circuit/analysis';
import type { SimOptions } from '@/lib/circuit/sim-options';
import { exportRawFile, TraceMath, computeFFT, complexToMagnitude, complexToPhase, complexToDb, type MeasCommand, parseMeasLine, type Stimulus, sampleStimulus, stimulusToSPICE } from '@/lib/circuit/measurement';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Activity, BarChart3, Sliders, Gauge, Waves, Sigma, AlertTriangle, CheckCircle,
  Save, FunctionSquare, Microscope, Wand2,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Dialog — choose analysis type, configure, run
// ─────────────────────────────────────────────────────────────────────────────



export function StimuliEditorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [stimType, setStimType] = useState<Stimulus['type']>('sine');
  const [voff, setVoff] = useState(0);
  const [vamp, setVamp] = useState(1);
  const [freq, setFreq] = useState(50);
  const [td, setTd] = useState(0);
  const [preview, setPreview] = useState<Float64Array>(new Float64Array(0));
  const [spiceText, setSpiceText] = useState('');

  const generate = () => {
    const times = new Float64Array(500);
    for (let i = 0; i < 500; i++) times[i] = i * 0.0001;
    const stim: Stimulus = {
      type: stimType,
      params: { voff, vamp, freq, td },
    };
    const vals = sampleStimulus(stim, times);
    setPreview(vals);
    setSpiceText(stimulusToSPICE(stim, 'V1'));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wand2 size={16} /> Stimuli Editor</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-2">
            <div>
              <Label className="text-slate-300 text-xs">Type</Label>
              <Select value={stimType} onValueChange={(v) => setStimType(v as any)}>
                <SelectTrigger className="bg-slate-800 border-slate-700 h-8"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-800">
                  <SelectItem value="sine">SINE</SelectItem>
                  <SelectItem value="pulse">PULSE</SelectItem>
                  <SelectItem value="pwl">PWL</SelectItem>
                  <SelectItem value="exp">EXP</SelectItem>
                  <SelectItem value="sffm">SFFM</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Param label="Voff" value={voff} step={0.1} onChange={setVoff} />
            <Param label="Vamp" value={vamp} step={0.1} onChange={setVamp} />
            <Param label="Freq" value={freq} step={1} onChange={setFreq} />
          </div>
          <Button onClick={generate} size="sm"><Microscope size={12} className="mr-1" /> Generate Preview</Button>
          {preview.length > 0 && (
            <TraceSparkline values={preview} xValues={Float64Array.from({ length: 500 }, (_, i) => i * 0.0001)} xLabel="time (s)" />
          )}
          {spiceText && (
            <div className="bg-slate-950 p-2 rounded font-mono text-xs text-emerald-400 border border-slate-700">
              {spiceText}
            </div>
          )}
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
