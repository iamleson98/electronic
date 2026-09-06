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
import { BodePlot, PoleZeroPlot } from '@/components/circuit/AnalysisCharts';

export type AnalysisType = 'ac' | 'dc' | 'tran' | 'tf' | 'sens' | 'noise' | 'disto' | 'pz' | 'four';

type MathOperation = 'magnitude' | 'phase' | 'db' | 'fft' | 'raw';

interface AnalysisTraceValues {
  name: string;
  xValues: Float64Array;
  yValues: Float64Array;
  xLabel?: string;
  yLabel?: string;
}

interface ConvergenceReport {
  trapRings?: number;
}

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
  const [mathOp, setMathOp] = useState<MathOperation>('magnitude');
  // Dedicated branches for analyses with structured results (sens table,
  // S-plane, noise NF, distortion HD table) — before the generic display.
  if (result.type === 'sens') return <SensResultDisplay result={result} />;
  if (result.type === 'pz') return <PZResultDisplay result={result} />;
  if (result.type === 'noise') return <NoiseResultDisplay result={result} />;
  if (result.type === 'disto') return <DistoResultDisplay result={result} />;
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
      {((result.report as ConvergenceReport).trapRings ?? 0) > 0 && (
        <div className="text-xs text-sky-300 bg-sky-500/10 p-2 rounded">
          Trapezoidal ringing guard engaged {((result.report as ConvergenceReport).trapRings ?? 0)}× (numerical (−1)ⁿ mode suppressed with backward-Euler fallback steps). If this count is large, the timestep is coarse relative to a capacitor/inductor time constant — reduce the step or switch to Gear.
        </div>
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
          <Select value={mathOp} onValueChange={(v) => setMathOp(v as MathOperation)}>
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
                const t = complexToPhase(tr as AnalysisTraceValues);
                displayValues = t.yValues;
                xLabel = t.xLabel ?? '';
              } else if (mathOp === 'db') {
                const t = complexToDb(tr as AnalysisTraceValues);
                displayValues = t.yValues;
                xLabel = t.xLabel ?? '';
              } else {
                const t = complexToMagnitude(tr as AnalysisTraceValues);
                displayValues = t.yValues;
                xLabel = t.xLabel ?? '';
              }
            } else if ('yValues' in tr) {
              const rt = tr as AnalysisTraceValues;
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
                  <span className="font-mono text-cyan-400">{(tr as AnalysisTraceValues).name}</span>
                  <span className="text-slate-500">{displayValues.length} pts</span>
                </div>
                {/* If complex trace (AC analysis) and showing magnitude/dB, render Bode plot */}
                {'yValues' in tr && tr.yValues instanceof Float64Array && tr.yValues.length === 2 * tr.xValues.length ? (
                  <BodePlot trace={tr as AnalysisTraceValues} width={580} height={280} />
                ) : (
                  <TraceSparkline values={displayValues} xValues={(tr as AnalysisTraceValues).xValues ?? new Float64Array(0)} xLabel={xLabel} />
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => {
          const raw = exportRawFile(result.traces.filter((t): t is AnalysisTraceValues => 'yValues' in t) as AnalysisTraceValues[], 'Analysis');
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

// ─────────────────────────────────────────────────────────────────────────────
// Dedicated result branches — structured displays for sens / pz / noise /
// disto (previously all fell through to the generic sparkline).
// ─────────────────────────────────────────────────────────────────────────────

function ResultHeader({ result, title }: { result: AnalysisResult; title: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {result.report.converged
          ? <CheckCircle size={14} className="text-emerald-400" />
          : <AlertTriangle size={14} className="text-amber-400" />}
        <Badge variant="outline">{title}</Badge>
        <span className="text-xs text-slate-400">{result.durationMs.toFixed(1)}ms</span>
      </div>
      {result.report.message && (
        <div className="text-xs text-amber-400 bg-amber-500/10 p-2 rounded">{result.report.message}</div>
      )}
    </div>
  );
}

function SensResultDisplay({ result }: { result: AnalysisResult }) {
  const trace = result.traces[0] as unknown as
    | { xValues: Float64Array; yValues: Float64Array; name: string } | undefined;
  const n = trace?.yValues.length ?? 0;
  const rows = Array.from({ length: n }, (_, i) => ({ i, v: trace!.yValues[i] ?? 0 }))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  return (
    <div className="space-y-3">
      <ResultHeader result={result} title="SENSITIVITY" />
      {result.scalars.vOutNominal !== undefined && (
        <div className="text-xs text-slate-400">Nominal output: <span className="font-mono text-cyan-300">{result.scalars.vOutNominal.toFixed(6)} V</span></div>
      )}
      <ScrollArea className="h-64 w-full rounded border border-slate-700 bg-slate-950">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-800">
            <tr>
              <th className="px-2 py-1 text-left text-slate-300">#</th>
              <th className="px-2 py-1 text-right text-slate-300">dV/dP</th>
              <th className="px-2 py-1 text-right text-slate-300">|dV/dP|</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.i} className="border-t border-slate-800">
                <td className="px-2 py-1 font-mono text-slate-400">P{r.i}</td>
                <td className="px-2 py-1 text-right font-mono text-cyan-300">{r.v.toExponential(3)}</td>
                <td className="px-2 py-1 text-right font-mono text-slate-400">{Math.abs(r.v).toExponential(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

function PZResultDisplay({ result }: { result: AnalysisResult }) {
  const poles = (result.scalars.poles as unknown as { real: number; imag: number; freq: number }[] | undefined) ?? [];
  const zeros = (result.scalars.zeros as unknown as { real: number; imag: number; freq: number }[] | undefined) ?? [];
  // Fallback: parse pole/zero scalars if stored flat.
  return (
    <div className="space-y-3">
      <ResultHeader result={result} title="POLE-ZERO" />
      <PoleZeroPlot poles={poles} zeros={zeros} width={580} height={280} />
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-slate-700 bg-slate-950 p-2">
          <div className="mb-1 font-semibold text-cyan-300">Poles ({poles.length})</div>
          {poles.slice(0, 12).map((p, i) => (
            <div key={i} className="font-mono text-slate-400">
              {p.real.toExponential(2)}{p.imag >= 0 ? '+' : ''}{p.imag.toExponential(2)}j
              {p.freq ? <span className="text-slate-500"> · {(p.freq).toExponential(2)}Hz</span> : null}
            </div>
          ))}
        </div>
        <div className="rounded border border-slate-700 bg-slate-950 p-2">
          <div className="mb-1 font-semibold text-amber-300">Zeros ({zeros.length})</div>
          {zeros.slice(0, 12).map((z, i) => (
            <div key={i} className="font-mono text-slate-400">
              {z.real.toExponential(2)}{z.imag >= 0 ? '+' : ''}{z.imag.toExponential(2)}j
              {z.freq ? <span className="text-slate-500"> · {(z.freq).toExponential(2)}Hz</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NoiseResultDisplay({ result }: { result: AnalysisResult }) {
  const integrated = result.scalars.integratedNoise_Vrms;
  return (
    <div className="space-y-3">
      <ResultHeader result={result} title="NOISE" />
      {integrated !== undefined && (
        <div className="rounded border border-slate-700 bg-slate-950 p-2 text-xs text-slate-300">
          Integrated output noise: <span className="font-mono text-cyan-300">{integrated.toExponential(3)} Vrms</span>
        </div>
      )}
      {result.traces.map((tr, idx) => {
        const rt = tr as unknown as { name: string; yValues: Float64Array; xValues: Float64Array };
        const vals = Array.from(rt.yValues);
        const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        return (
          <div key={idx} className="rounded border border-slate-700 bg-slate-950 p-2">
            <div className="mb-1 font-mono text-xs text-cyan-300">{rt.name}</div>
            <TraceSparkline values={rt.yValues} xValues={rt.xValues} xLabel={rt.name} />
            <div className="mt-1 font-mono text-[10px] text-slate-500">mean {avg.toExponential(3)}</div>
          </div>
        );
      })}
    </div>
  );
}

function DistoResultDisplay({ result }: { result: AnalysisResult }) {
  const get = (name: string) => result.traces.find((t) => (t as { name: string }).name === name) as unknown as
    | { xValues: Float64Array; yValues: Float64Array } | undefined;
  const hd2 = get('HD2');
  const hd3 = get('HD3');
  const thd = get('THD');
  const n = thd?.yValues.length ?? 0;
  return (
    <div className="space-y-3">
      <ResultHeader result={result} title="DISTORTION" />
      {(result.scalars.max_THD !== undefined) && (
        <div className="grid grid-cols-3 gap-1 text-xs">
          <div className="rounded bg-slate-950 p-2 text-center"><div className="text-slate-500">max THD</div><div className="font-mono text-cyan-300">{(result.scalars.max_THD * 100).toFixed(2)}%</div></div>
          <div className="rounded bg-slate-950 p-2 text-center"><div className="text-slate-500">max HD2</div><div className="font-mono text-cyan-300">{((result.scalars.max_HD2 ?? 0) * 100).toFixed(2)}%</div></div>
          <div className="rounded bg-slate-950 p-2 text-center"><div className="text-slate-500">max HD3</div><div className="font-mono text-cyan-300">{((result.scalars.max_HD3 ?? 0) * 100).toFixed(2)}%</div></div>
        </div>
      )}
      <ScrollArea className="h-64 w-full rounded border border-slate-700 bg-slate-950">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-800">
            <tr>
              <th className="px-2 py-1 text-right text-slate-300">Freq</th>
              <th className="px-2 py-1 text-right text-slate-300">HD2 %</th>
              <th className="px-2 py-1 text-right text-slate-300">HD3 %</th>
              <th className="px-2 py-1 text-right text-slate-300">THD %</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: n }, (_, i) => (
              <tr key={i} className="border-t border-slate-800">
                <td className="px-2 py-1 text-right font-mono text-slate-400">{(thd?.xValues[i] ?? 0).toExponential(2)}</td>
                <td className="px-2 py-1 text-right font-mono text-slate-300">{((hd2?.yValues[i] ?? 0) * 100).toFixed(3)}</td>
                <td className="px-2 py-1 text-right font-mono text-slate-300">{((hd3?.yValues[i] ?? 0) * 100).toFixed(3)}</td>
                <td className="px-2 py-1 text-right font-mono text-cyan-300">{((thd?.yValues[i] ?? 0) * 100).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}
