'use client';
import { Param } from './shared';

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



export function OptionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const simOptions = useEditor((s) => s.simOptions);
  const setSimOptions = useEditor((s) => s.setSimOptions);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sliders size={16} /> Simulation Options</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-96 overflow-y-auto">
          <div className="grid grid-cols-2 gap-2">
            <Param label="reltol" value={simOptions.reltol} step={1e-4} onChange={(v) => setSimOptions({ reltol: v })} />
            <Param label="vntol (V)" value={simOptions.vntol} step={1e-7} onChange={(v) => setSimOptions({ vntol: v })} />
            <Param label="abstol (A)" value={simOptions.abstol} step={1e-13} onChange={(v) => setSimOptions({ abstol: v })} />
            <Param label="gmin (S)" value={simOptions.gmin} step={1e-13} onChange={(v) => setSimOptions({ gmin: v })} />
            <Param label="itl1 (DC iter)" value={simOptions.itl1} step={5} onChange={(v) => setSimOptions({ itl1: v })} />
            <Param label="itl2 (TR iter)" value={simOptions.itl2} step={5} onChange={(v) => setSimOptions({ itl2: v })} />
            <Param label="pivtol" value={simOptions.pivtol} step={1e-14} onChange={(v) => setSimOptions({ pivtol: v })} />
            <Param label="temp (°C)" value={simOptions.temp} step={1} onChange={(v) => setSimOptions({ temp: v })} />
            <Param label="tnom (°C)" value={simOptions.tnom} step={1} onChange={(v) => setSimOptions({ tnom: v })} />
            <Param label="maxord (Gear)" value={simOptions.maxord} step={1} onChange={(v) => setSimOptions({ maxord: v })} />
          </div>
          <div>
            <Label className="text-slate-300">Integration Method</Label>
            <Select value={simOptions.method} onValueChange={(v) => setSimOptions({ method: v as any })}>
              <SelectTrigger className="bg-slate-800 border-slate-700"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-slate-800">
                <SelectItem value="euler">Backward Euler (default, stable)</SelectItem>
                <SelectItem value="trap">Trapezoidal (2nd order, faster)</SelectItem>
                <SelectItem value="gear">Gear (variable order)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="flex items-center justify-between text-sm">
              <span className="text-slate-200">gmin stepping</span>
              <Switch checked={simOptions.gminStep} onCheckedChange={(v) => setSimOptions({ gminStep: v })} />
            </label>
            <label className="flex items-center justify-between text-sm">
              <span className="text-slate-200">source stepping</span>
              <Switch checked={simOptions.sourceStep} onCheckedChange={(v) => setSimOptions({ sourceStep: v })} />
            </label>
            <label className="flex items-center justify-between text-sm">
              <span className="text-slate-200">pseudo-transient</span>
              <Switch checked={simOptions.pseudoTran} onCheckedChange={(v) => setSimOptions({ pseudoTran: v })} />
            </label>
            <label className="flex items-center justify-between text-sm">
              <span className="text-slate-200">Use Initial Conditions (UIC)</span>
              <Switch checked={simOptions.uic} onCheckedChange={(v) => setSimOptions({ uic: v })} />
            </label>
          </div>
        </div>
        <DialogFooter><Button variant="default" onClick={onClose}>OK</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
