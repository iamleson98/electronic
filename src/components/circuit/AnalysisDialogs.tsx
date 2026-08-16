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

type AnalysisType = 'ac' | 'dc' | 'tran' | 'tf' | 'sens' | 'noise' | 'disto' | 'pz' | 'four';

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
      if (source && sourceId !== source.id) setSourceId(source.id);
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

function ResultDisplay({ result }: { result: AnalysisResult }) {
  const [mathOp, setMathOp] = useState<'magnitude' | 'phase' | 'db' | 'fft' | 'raw'>('magnitude');
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {result.report.converged
          ? <CheckCircle size={14} className="text-emerald-400" />
          : <AlertTriangle size={14} className="text-amber-400" />}
        <Badge variant="outline">{result.type.toUpperCase()}</Badge>
        <span className="text-xs text-slate-400">{result.durationMs.toFixed(1)}ms · {result.report.iterations} iter</span>
      </div>
      {result.report.message && (
        <div className="text-xs text-amber-400 bg-amber-500/10 p-2 rounded">{result.report.message}</div>
      )}
      {Object.keys(result.scalars).length > 0 && (
        <div className="grid grid-cols-2 gap-1 bg-slate-950 p-2 rounded text-xs">
          {Object.entries(result.scalars).map(([k, v]) => (
            <div key={k}><span className="text-slate-400">{k}:</span> <span className="font-mono text-cyan-400">{v.toFixed(6)}</span></div>
          ))}
        </div>
      )}
      {result.traces.length > 0 && (
        <div>
          <Label className="text-slate-300 text-xs">Math Transform</Label>
          <Select value={mathOp} onValueChange={(v) => setMathOp(v as any)}>
            <SelectTrigger className="bg-slate-800 border-slate-700 h-8"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-slate-800">
              <SelectItem value="magnitude">Magnitude (|V|)</SelectItem>
              <SelectItem value="phase">Phase (degrees)</SelectItem>
              <SelectItem value="db">Magnitude (dB)</SelectItem>
              <SelectItem value="fft">FFT</SelectItem>
              <SelectItem value="raw">Raw Values</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <ScrollArea className="h-64 w-full rounded border border-slate-700 bg-slate-950">
        <div className="p-2">
          {result.traces.map((tr, idx) => {
            // For complex traces, apply the selected math transform
            let displayValues: Float64Array;
            let xLabel: string;
            if ('yValues' in tr && tr.yValues instanceof Float64Array && tr.yValues.length === 2 * tr.xValues.length) {
              // complex trace
              if (mathOp === 'phase') {
                const t = complexToPhase(tr as any);
                displayValues = t.yValues;
                xLabel = t.xLabel ?? '';
              } else if (mathOp === 'db') {
                const t = complexToDb(tr as any);
                displayValues = t.yValues;
                xLabel = t.xLabel ?? '';
              } else {
                const t = complexToMagnitude(tr as any);
                displayValues = t.yValues;
                xLabel = t.xLabel ?? '';
              }
            } else if ('yValues' in tr) {
              const rt = tr as any;
              if (mathOp === 'fft' && rt.yValues.length > 2) {
                const fftTrace = computeFFT(rt);
                displayValues = fftTrace.yValues;
                xLabel = fftTrace.xLabel ?? '';
              } else {
                displayValues = rt.yValues;
                xLabel = rt.xLabel ?? '';
              }
            } else {
              displayValues = new Float64Array(0);
              xLabel = '';
            }
            return (
              <div key={idx} className="mb-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono text-cyan-400">{(tr as any).name}</span>
                  <span className="text-slate-500">{displayValues.length} pts</span>
                </div>
                <TraceSparkline values={displayValues} xValues={(tr as any).xValues ?? new Float64Array(0)} xLabel={xLabel} />
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => {
          const raw = exportRawFile(result.traces.filter((t): t is any => 'yValues' in t) as any[], 'Analysis');
          const blob = new Blob([raw], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `analysis_${Date.now()}.raw`; a.click();
          URL.revokeObjectURL(url);
          toast.success('Exported raw file');
        }}>
          <Save size={12} className="mr-1" /> Export Raw File
        </Button>
      </div>
    </div>
  );
}

function TraceSparkline({ values, xValues, xLabel }: { values: Float64Array; xValues: Float64Array; xLabel: string }) {
  const width = 600;
  const height = 80;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1e-12);
  if (values.length < 2) return <div className="text-xs text-slate-500">—</div>;
  const xRange = xValues.length > 1 ? xValues[xValues.length - 1] - xValues[0] : 1;
  const xMin = xValues[0];
  // build SVG path
  let path = '';
  for (let i = 0; i < values.length; i++) {
    const x = ((xValues[i] - xMin) / xRange) * width;
    const y = height - ((values[i] - min) / range) * height;
    path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  }
  return (
    <div>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className="bg-slate-950 border border-slate-800 rounded">
        <path d={path} stroke="#22d3ee" strokeWidth="1.5" fill="none" />
      </svg>
      <div className="flex justify-between text-xs text-slate-500 mt-1">
        <span>{min.toExponential(2)}</span>
        <span>{xLabel}</span>
        <span>{max.toExponential(2)}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation Options Dialog
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

function Param({ label, value, step, onChange }: { label: string; value: number | undefined; step: number; onChange: (v: number) => void }) {
  return (
    <div>
      <Label className="text-slate-300 text-xs">{label}</Label>
      <Input type="number" value={value ?? 0} step={step} onChange={(e) => onChange(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement Dialog — run .meas on the last analysis result
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
    const tr = lastResult.traces[0] as any;
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

// ─────────────────────────────────────────────────────────────────────────────
// Batch Sweep Dialog — .step / .mc / .worst
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
  const [results, setResults] = useState<any>(null);

  useEffect(() => {
    if (open && !componentId && components.length > 0) {
      const c = components.find((c) => c.type === 'resistor') ?? components[0];
      if (c && componentId !== c.id) setComponentId(c.id);
    }
  }, [open, components, componentId]);

  const run = () => {
    const result = runBatch({
      type: batchType,
      param, componentId,
      start, stop, step,
      runs, tolerance,
      distribution: dist,
      inner: { type: 'ac', sweep: 'dec', nPoints: 5, fStart: 10, fStop: 100000, sourceId: components.find(c => c.type === 'acVoltage')?.id ?? '', outputNode: 'p' } as any,
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
              <Select value={batchType} onValueChange={(v) => setBatchType(v as any)}>
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
              <div>
                <Label className="text-slate-300 text-xs">Distribution</Label>
                <Select value={dist} onValueChange={(v) => setDist(v as any)}>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-900 p-2 rounded text-center">
      <div className="text-slate-400 text-xs">{label}</div>
      <div className="font-mono text-cyan-400">{value.toFixed(4)}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stimuli Editor — build PWL/SINE/PULSE/SFFM/EXP waveform definitions
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
