'use client';
import { AnalysisType, ResultDisplay } from './shared';

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
import type { AnalysisConfig } from '@/lib/circuit/analysis';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Activity, Waves, Sigma, AlertTriangle, CheckCircle,
  Save, FunctionSquare, Microscope, Wand2,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Dialog — choose analysis type, configure, run
// ─────────────────────────────────────────────────────────────────────────────



export function AnalysisDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const components = useEditor((s) => s.components);
  const runAnalysis = useEditor((s) => s.runAnalysis);
  const lastResult = useEditor((s) => s.lastAnalysisResult);
  const [analysisType, setAnalysisType] = useState<AnalysisType>('ac');
  const [sourceId, setSourceId] = useState('');
  const [outputNode, setOutputNode] = useState('');
  const [fStart, setFStart] = useState(10);
  const [fStop, setFStop] = useState(100000);
  const [nPoints, setNPoints] = useState(50);
  const [sweepType, setSweepType] = useState<'dec' | 'oct' | 'lin'>('dec');
  const [vStart, setVStart] = useState(0);
  const [vStop, setVStop] = useState(5);
  const [vStep, setVStep] = useState(0.1);
  const [tStop, setTStop] = useState(0.01);
  const [tStep, setTStep] = useState(0.0001);
  const [param, setParam] = useState('resistance');

  // Find available sources
  useEffect(() => {
    if (open && !sourceId && components.length > 0) {
      const source = components.find((c) => c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'currentSource');
      if (source && sourceId !== source.id) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSourceId(source.id);
      }
    }
  }, [open, components, sourceId]);

  const run = () => {
    let config: AnalysisConfig;
    switch (analysisType) {
      case 'ac':
        config = { type: 'ac', sweep: sweepType, nPoints, fStart, fStop, sourceId, outputNode };
        break;
      case 'dc':
        config = { type: 'dc', sourceId, vStart, vStop, vStep, outputNode };
        break;
      case 'tran':
        config = { type: 'tran', tStop, tStep, probes: outputNode ? [outputNode] : [] };
        break;
      case 'tf':
        config = { type: 'tf', inputSourceId: sourceId, outputNode };
        break;
      case 'sens':
        config = { type: 'sens', outputNode, mode: 'dc', parameter: param } as any;
        break;
      case 'noise':
        config = { type: 'noise', outputNode, inputSourceId: sourceId, fStart, fStop, nPoints, sweep: sweepType };
        break;
      case 'disto':
        config = { type: 'disto', inputSourceId: sourceId, fStart, fStop, nPoints, sweep: sweepType, outputNode };
        break;
      case 'pz':
        config = { type: 'pz', inputNode: sourceId, outputNode };
        break;
      default:
        toast.error('Analysis type not yet supported');
        return;
    }
    try {
      const result = runAnalysis(config);
      if (!result) {
        toast.error('Analysis returned no result');
        return;
      }
      if (result.report.converged) {
        toast.success(`${analysisType.toUpperCase()} analysis complete: ${result.traces.length} trace(s) in ${result.durationMs.toFixed(0)}ms`);
      } else {
        toast.error(`Analysis failed: ${result.report.message ?? 'unknown error'}`);
      }
    } catch (e) {
      toast.error('Analysis failed: ' + (e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Activity size={16} /> Run Analysis</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="config">
          <TabsList className="bg-slate-800">
            <TabsTrigger value="config">Configuration</TabsTrigger>
            <TabsTrigger value="results">Results {lastResult && <Badge variant="outline" className="ml-2">{lastResult.traces.length}</Badge>}</TabsTrigger>
          </TabsList>
          <TabsContent value="config" className="space-y-3">
            <div>
              <Label className="text-slate-300">Analysis Type</Label>
              <Select value={analysisType} onValueChange={(v) => setAnalysisType(v as AnalysisType)}>
                <SelectTrigger className="bg-slate-800 border-slate-700"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem value="ac">AC Analysis (.ac)</SelectItem>
                  <SelectItem value="dc">DC Sweep (.dc)</SelectItem>
                  <SelectItem value="tran">Transient (.tran)</SelectItem>
                  <SelectItem value="tf">Transfer Function (.tf)</SelectItem>
                  <SelectItem value="sens">Sensitivity (.sens)</SelectItem>
                  <SelectItem value="noise">Noise (.noise)</SelectItem>
                  <SelectItem value="disto">Distortion (.disto)</SelectItem>
                  <SelectItem value="pz">Pole-Zero (.pz)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(analysisType === 'ac' || analysisType === 'noise' || analysisType === 'disto') && (
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <Label className="text-slate-300 text-xs">Sweep</Label>
                  <Select value={sweepType} onValueChange={(v) => setSweepType(v as any)}>
                    <SelectTrigger className="bg-slate-800 border-slate-700 h-8"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-slate-800">
                      <SelectItem value="dec">Decade</SelectItem>
                      <SelectItem value="oct">Octave</SelectItem>
                      <SelectItem value="lin">Linear</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-slate-300 text-xs">fStart (Hz)</Label>
                  <Input type="number" value={fStart} onChange={(e) => setFStart(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
                </div>
                <div>
                  <Label className="text-slate-300 text-xs">fStop (Hz)</Label>
                  <Input type="number" value={fStop} onChange={(e) => setFStop(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
                </div>
                <div>
                  <Label className="text-slate-300 text-xs">Points/dec</Label>
                  <Input type="number" value={nPoints} onChange={(e) => setNPoints(parseInt(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
                </div>
              </div>
            )}

            {analysisType === 'dc' && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-slate-300 text-xs">V Start</Label>
                  <Input type="number" value={vStart} onChange={(e) => setVStart(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
                </div>
                <div>
                  <Label className="text-slate-300 text-xs">V Stop</Label>
                  <Input type="number" value={vStop} onChange={(e) => setVStop(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
                </div>
                <div>
                  <Label className="text-slate-300 text-xs">V Step</Label>
                  <Input type="number" value={vStep} onChange={(e) => setVStep(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
                </div>
              </div>
            )}

            {analysisType === 'tran' && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-slate-300 text-xs">tStop (s)</Label>
                  <Input type="number" value={tStop} onChange={(e) => setTStop(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
                </div>
                <div>
                  <Label className="text-slate-300 text-xs">tStep (s)</Label>
                  <Input type="number" value={tStep} onChange={(e) => setTStep(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-slate-300 text-xs">Source (component id)</Label>
                <Select value={sourceId} onValueChange={setSourceId}>
                  <SelectTrigger className="bg-slate-800 border-slate-700 h-8"><SelectValue placeholder="Select source..." /></SelectTrigger>
                  <SelectContent className="bg-slate-800">
                    {components.filter((c) => ['dcVoltage', 'acVoltage', 'pulseSource', 'currentSource'].includes(c.type)).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.refdes ?? c.id} ({c.type})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-slate-300 text-xs">Output Node (terminal id or net name)</Label>
                <Input value={outputNode} onChange={(e) => setOutputNode(e.target.value)} placeholder="e.g. out, p, n1" className="bg-slate-800 border-slate-700 h-8" />
              </div>
            </div>

            {analysisType === 'sens' && (
              <div>
                <Label className="text-slate-300 text-xs">Parameter to vary</Label>
                <Input value={param} onChange={(e) => setParam(e.target.value)} placeholder="resistance, voltage, vth, ..." className="bg-slate-800 border-slate-700 h-8" />
              </div>
            )}

            <div className="flex justify-end pt-3">
              <Button onClick={run} className="bg-cyan-500 text-slate-900 hover:bg-cyan-400">
                <Activity size={14} className="mr-1" /> Run {analysisType.toUpperCase()} Analysis
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="results">
            {lastResult ? (
              <ResultDisplay result={lastResult} />
            ) : (
              <div className="text-center text-slate-500 py-8 text-sm">No analysis run yet — configure and run one above.</div>
            )}
          </TabsContent>
        </Tabs>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
