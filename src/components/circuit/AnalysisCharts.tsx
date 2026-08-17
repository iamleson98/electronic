'use client';

// Bode plot and parametric family plot — SVG-based (no external dependency).
// Used by the AnalysisDialog Results tab to show AC frequency response and
// .step sweep families.

import { useMemo } from 'react';
import type { RealTrace, ComplexTrace } from '@/lib/circuit/analysis';
import { complexToMagnitude, complexToPhase, complexToDb } from '@/lib/circuit/measurement';

// ─────────────────────────────────────────────────────────────────────────────
// BodePlot — dual-axis log-x chart for AC analysis
// ─────────────────────────────────────────────────────────────────────────────

interface BodePlotProps {
  trace: ComplexTrace;
  width?: number;
  height?: number;
}

export function BodePlot({ trace, width = 600, height = 300 }: BodePlotProps) {
  const { magData, phaseData, freqMin, freqMax, magMin, magMax, phaseMin, phaseMax } = useMemo(() => {
    const magTrace = complexToDb(trace);
    const phaseTrace = complexToPhase(trace);
    const freqs = Array.from(trace.xValues);
    const mags = Array.from(magTrace.yValues);
    const phases = Array.from(phaseTrace.yValues);
    const fMin = Math.min(...freqs);
    const fMax = Math.max(...freqs);
    const mMin = Math.min(...mags);
    const mMax = Math.max(...mags);
    const pMin = Math.min(...phases);
    const pMax = Math.max(...phases);
    return {
      magData: freqs.map((f, i) => ({ f, v: mags[i] })),
      phaseData: freqs.map((f, i) => ({ f, v: phases[i] })),
      freqMin: fMin, freqMax: fMax,
      magMin: mMin, magMax: mMax,
      phaseMin: pMin, phaseMax: pMax,
    };
  }, [trace]);

  const logMin = Math.log10(Math.max(freqMin, 1e-6));
  const logMax = Math.log10(Math.max(freqMax, freqMin * 10));
  const logRange = Math.max(1e-6, logMax - logMin);
  const magRange = Math.max(1, magMax - magMin);
  const phaseRange = Math.max(1, phaseMax - phaseMin);
  const pad = { l: 50, r: 50, t: 20, b: 30 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  const xScale = (f: number) => pad.l + (Math.log10(Math.max(f, 1e-6)) - logMin) / logRange * plotW;
  const magY = (v: number) => pad.t + (1 - (v - magMin) / magRange) * (plotH / 2);
  const phaseY = (v: number) => pad.t + plotH / 2 + (1 - (v - phaseMin) / phaseRange) * (plotH / 2);

  const magPath = magData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(d.f).toFixed(1)} ${magY(d.v).toFixed(1)}`).join(' ');
  const phasePath = phaseData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(d.f).toFixed(1)} ${phaseY(d.v).toFixed(1)}`).join(' ');

  // Frequency ticks (decade marks)
  const decades: number[] = [];
  for (let d = Math.ceil(logMin); d <= Math.floor(logMax); d++) decades.push(Math.pow(10, d));

  return (
    <svg width={width} height={height} className="rounded border border-slate-800 bg-[#0a0f1c]">
      {/* Grid */}
      {decades.map(f => {
        const x = xScale(f);
        return <line key={`g-${f}`} x1={x} y1={pad.t} x2={x} y2={pad.t + plotH} stroke="#1e293b" strokeWidth={1} />;
      })}
      {/* Mag axis (top half) */}
      <line x1={pad.l} y1={pad.t} x2={pad.l + plotW} y2={pad.t} stroke="#334155" strokeWidth={1} />
      <line x1={pad.l} y1={pad.t + plotH / 2} x2={pad.l + plotW} y2={pad.t + plotH / 2} stroke="#334155" strokeWidth={1} />
      {/* Mag trace */}
      <path d={magPath} fill="none" stroke="#22d3ee" strokeWidth={1.5} />
      {/* Phase trace */}
      <path d={phasePath} fill="none" stroke="#a855f7" strokeWidth={1.5} strokeDasharray="3 2" />
      {/* Y labels */}
      <text x={4} y={pad.t + 8} fill="#22d3ee" fontSize="10" fontFamily="monospace">dB</text>
      <text x={4} y={pad.t + plotH / 2 + 8} fill="#a855f7" fontSize="10" fontFamily="monospace">deg</text>
      {/* Mag range labels */}
      <text x={4} y={pad.t + 4} fill="#64748b" fontSize="9" fontFamily="monospace">{magMax.toFixed(0)}</text>
      <text x={4} y={pad.t + plotH / 2 - 4} fill="#64748b" fontSize="9" fontFamily="monospace">{magMin.toFixed(0)}</text>
      {/* Phase range labels */}
      <text x={4} y={pad.t + plotH / 2 + 12} fill="#64748b" fontSize="9" fontFamily="monospace">{phaseMax.toFixed(0)}</text>
      <text x={4} y={pad.t + plotH - 4} fill="#64748b" fontSize="9" fontFamily="monospace">{phaseMin.toFixed(0)}</text>
      {/* Frequency labels */}
      {decades.map(f => (
        <text key={`f-${f}`} x={xScale(f)} y={height - 8} fill="#64748b" fontSize="9" fontFamily="monospace" textAnchor="middle">
          {f >= 1000 ? `${f / 1000}k` : f}Hz
        </text>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FamilyPlot — overlay N traces with legend (for .step results)
// ─────────────────────────────────────────────────────────────────────────────

interface FamilyPlotProps {
  traces: RealTrace[];
  sweepValues?: number[];
  width?: number;
  height?: number;
}

export function FamilyPlot({ traces, sweepValues, width = 600, height = 250 }: FamilyPlotProps) {
  const colors = ['#22d3ee', '#f59e0b', '#a855f7', '#ef4444', '#22c55e', '#3b82f6', '#f97316', '#ec4899'];
  const pad = { l: 50, r: 10, t: 10, b: 25 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const t of traces) {
      for (let i = 0; i < t.xValues.length; i++) {
        if (t.xValues[i] < xMin) xMin = t.xValues[i];
        if (t.xValues[i] > xMax) xMax = t.xValues[i];
        if (t.yValues[i] < yMin) yMin = t.yValues[i];
        if (t.yValues[i] > yMax) yMax = t.yValues[i];
      }
    }
    const yPad = Math.max(0.1, (yMax - yMin) * 0.1);
    return { xMin, xMax, yMin: yMin - yPad, yMax: yMax + yPad };
  }, [traces]);

  const xRange = Math.max(1e-9, xMax - xMin);
  const yRange = Math.max(1e-9, yMax - yMin);

  const xScale = (v: number) => pad.l + (v - xMin) / xRange * plotW;
  const yScale = (v: number) => pad.t + (1 - (v - yMin) / yRange) * plotH;

  return (
    <svg width={width} height={height} className="rounded border border-slate-800 bg-[#0a0f1c]">
      {/* Grid */}
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + plotH} stroke="#334155" strokeWidth={1} />
      <line x1={pad.l} y1={pad.t + plotH} x2={pad.l + plotW} y2={pad.t + plotH} stroke="#334155" strokeWidth={1} />
      {/* Traces */}
      {traces.map((trace, ti) => {
        const color = colors[ti % colors.length];
        const path = Array.from(trace.xValues).map((x, i) =>
          `${i === 0 ? 'M' : 'L'} ${xScale(x).toFixed(1)} ${yScale(trace.yValues[i]).toFixed(1)}`
        ).join(' ');
        return <path key={ti} d={path} fill="none" stroke={color} strokeWidth={1.5} opacity={0.85} />;
      })}
      {/* Legend */}
      {traces.map((trace, ti) => {
        const color = colors[ti % colors.length];
        const label = sweepValues ? `${sweepValues[ti]}` : trace.name;
        return (
          <g key={`leg-${ti}`}>
            <line x1={pad.l + 4} y1={pad.t + 4 + ti * 12} x2={pad.l + 16} y2={pad.t + 4 + ti * 12} stroke={color} strokeWidth={2} />
            <text x={pad.l + 20} y={pad.t + 7 + ti * 12} fill={color} fontSize="9" fontFamily="monospace">{label}</text>
          </g>
        );
      })}
      {/* Y label */}
      <text x={4} y={pad.t + 10} fill="#64748b" fontSize="9" fontFamily="monospace">{yMax.toFixed(2)}</text>
      <text x={4} y={pad.t + plotH - 2} fill="#64748b" fontSize="9" fontFamily="monospace">{yMin.toFixed(2)}</text>
      {/* X label */}
      <text x={width / 2} y={height - 4} fill="#64748b" fontSize="9" fontFamily="monospace" textAnchor="middle">
        {traces[0]?.xLabel || 'X'}
      </text>
    </svg>
  );
}
