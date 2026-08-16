'use client';

// Shared helpers used by multiple analysis dialog components.
// Extracted from the original AnalysisDialogs.tsx during the refactor.

import { useState } from 'react';
import type { AnalysisResult } from '@/lib/circuit/analysis';
import { complexToPhase, complexToDb, complexToMagnitude, computeFFT, exportRawFile } from '@/lib/circuit/measurement';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { CheckCircle, AlertTriangle, Save } from 'lucide-react';

export type AnalysisType = 'ac' | 'dc' | 'tran' | 'tf' | 'sens' | 'noise' | 'disto' | 'pz' | 'four';

export function Param({ label, value, step, onChange }: { label: string; value: number | undefined; step: number; onChange: (v: number) => void }) {
  return (
    <div>
      <Label className="text-slate-300 text-xs">{label}</Label>
      <Input type="number" value={value ?? 0} step={step} onChange={(e) => onChange(parseFloat(e.target.value))} className="bg-slate-800 border-slate-700 h-8" />
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-900 p-2 rounded text-center">
      <div className="text-slate-400 text-xs">{label}</div>
      <div className="font-mono text-cyan-400">{value.toFixed(4)}</div>
    </div>
  );
}

export function ResultDisplay({ result }: { result: AnalysisResult }) {
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
            let displayValues: Float64Array;
            let xLabel: string;
            if ('yValues' in tr && tr.yValues instanceof Float64Array && tr.yValues.length === 2 * tr.xValues.length) {
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

export function TraceSparkline({ values, xValues, xLabel }: { values: Float64Array; xValues: Float64Array; xLabel: string }) {
  const width = 600;
  const height = 80;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1e-12);
  if (values.length < 2) return <div className="text-xs text-slate-500">—</div>;
  const xRange = xValues.length > 1 ? xValues[xValues.length - 1] - xValues[0] : 1;
  const xMin = xValues[0];
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
