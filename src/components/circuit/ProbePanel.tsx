'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin } from '@/lib/circuit/registry';
import { getTerminalsForComponent, buildNodeMap } from '@/lib/circuit/engine';
import { parseMeasLine, execMeas, computeFFT, type MeasCommand, type MeasResult } from '@/lib/circuit/measurement';
import { computeTHD, downsampleSpectrum, type THDResult } from '@/lib/circuit/fourier';
import { Activity, BarChart3, AlertCircle, Crosshair, Table2, Waves } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface CursorState {
  active: boolean;
  x: number; // pixel position on canvas
  traceIndex: number;
}

export function ProbePanel() {
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const simContext = useEditor((s) => s.simContext);
  const traces = useEditor((s) => s.traces);
  const running = useEditor((s) => s.running);
  const speed = useEditor((s) => s.speed);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ─── Cursor state for measurement readouts ────────────────────────────
  const [cursor, setCursor] = useState<CursorState>({ active: false, x: 0, traceIndex: 0 });
  const [cursorEnabled, setCursorEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState<'scope' | 'measurements' | 'meas' | 'spectrum'>('scope');

  // ─── .meas commands ───────────────────────────────────────────────────
  const [measCommands, setMeasCommands] = useState<MeasCommand[]>([]);
  const [measResults, setMeasResults] = useState<MeasResult[]>([]);
  const [measInput, setMeasInput] = useState('');

  // ─── Parameter sweep slider ──────────────────────────────────────────
  const [sweepCompId, setSweepCompId] = useState('');
  const [sweepParam, setSweepParam] = useState('resistance');
  const [sweepMin, setSweepMin] = useState(100);
  const [sweepMax, setSweepMax] = useState(10000);
  const [sweepValue, setSweepValue] = useState(1000);
  const setParameter = useEditor((s) => s.setParameter);

  // build a per-component measurements list
  const measurements: { componentId: string; name: string; symbol: string; items: { label: string; value: string; unit?: string }[] }[] = [];
  if (simContext && components.length > 0) {
    const plugins = new Map<string, any>();
    for (const c of components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    const nodeMap = buildNodeMap(components, wires, plugins);
    for (const comp of components) {
      const plugin = plugins.get(comp.type);
      if (!plugin || !plugin.measure) continue;
      const terminals = getTerminalsForComponent(comp, plugin, nodeMap);
      try {
        const m = plugin.measure(comp.parameters, terminals, simContext);
        if (m && m.length > 0) {
          measurements.push({ componentId: comp.id, name: plugin.name, symbol: plugin.symbol, items: m });
        }
      } catch (err) {
        // ignore measure errors
      }
    }
  }

  // ─── Compute cursor readout values ───────────────────────────────────
  const cursorReadout = useCallback(() => {
    if (!cursorEnabled || !cursor.active || traces.length === 0) return null;
    const trace = traces[cursor.traceIndex] || traces[0];
    if (!trace || trace.samples.length < 2) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const padding = 8;
    const tMin = trace.samples[0].time;
    const tMax = trace.samples[trace.samples.length - 1].time;
    const tRange = Math.max(1e-6, tMax - tMin);
    // Convert pixel X to time
    const t = tMin + ((cursor.x - padding) / (rect.width - 2 * padding)) * tRange;
    // Find nearest sample
    let nearest = trace.samples[0];
    let minDist = Infinity;
    for (const s of trace.samples) {
      const d = Math.abs(s.time - t);
      if (d < minDist) { minDist = d; nearest = s; }
    }
    // Compute V range
    let vMin = Infinity, vMax = -Infinity;
    for (const s of trace.samples) {
      if (s.voltage < vMin) vMin = s.voltage;
      if (s.voltage > vMax) vMax = s.voltage;
    }
    return { time: nearest.time, voltage: nearest.voltage, label: trace.label, color: trace.color, vMin, vMax };
  }, [cursor, cursorEnabled, traces]);

  // ─── Draw scope with traces + cursor ─────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(0, 0, rect.width, rect.height);

    // grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < rect.width; x += 30) { ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); }
    for (let y = 0; y < rect.height; y += 24) { ctx.moveTo(0, y); ctx.lineTo(rect.width, y); }
    ctx.stroke();
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(0, rect.height / 2);
    ctx.lineTo(rect.width, rect.height / 2);
    ctx.stroke();

    if (traces.length === 0) {
      ctx.fillStyle = '#475569';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Place an Oscilloscope component to capture waveforms', rect.width / 2, rect.height / 2 - 8);
      ctx.fillText('Probes measure voltage across their + and - terminals', rect.width / 2, rect.height / 2 + 10);
    }

    const padding = 8;
    for (let ti = 0; ti < traces.length; ti++) {
      const trace = traces[ti];
      if (trace.samples.length < 2) continue;
      const samples = trace.samples;
      const tMin = samples[0].time;
      const tMax = samples[samples.length - 1].time;
      const tRange = Math.max(1e-6, tMax - tMin);
      let vMin = Infinity, vMax = -Infinity;
      for (const s of samples) { if (s.voltage < vMin) vMin = s.voltage; if (s.voltage > vMax) vMax = s.voltage; }
      const vPad = Math.max(0.5, (vMax - vMin) * 0.15);
      vMin -= vPad; vMax += vPad;
      const vRange = Math.max(1e-6, vMax - vMin);

      ctx.strokeStyle = trace.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const x = padding + ((s.time - tMin) / tRange) * (rect.width - 2 * padding);
        const y = padding + (1 - (s.voltage - vMin) / vRange) * (rect.height - 2 * padding);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = trace.color;
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(trace.label, padding + 4, padding + 4 + ti * 14);
    }

    // Draw cursor line + readout
    if (cursorEnabled && cursor.active) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cursor.x, 0);
      ctx.lineTo(cursor.x, rect.height);
      ctx.stroke();
      ctx.setLineDash([]);
      // Readout box
      const readout = cursorReadout();
      if (readout) {
        const text = `${readout.label}: t=${(readout.time * 1000).toFixed(3)}ms V=${readout.voltage.toFixed(3)}V`;
        ctx.font = '10px ui-monospace, monospace';
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(cursor.x + 4, 4, tw + 8, 16);
        ctx.fillStyle = readout.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(text, cursor.x + 8, 7);
      }
    }
    ctx.restore();
  }, [traces, simContext, cursor, cursorEnabled, cursorReadout]);

  // ─── Handle mouse move on canvas for cursor ─────────────────────────
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cursorEnabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setCursor({ active: true, x: e.clientX - rect.left, traceIndex: 0 });
  };
  const handleCanvasMouseLeave = () => {
    setCursor((c) => ({ ...c, active: false }));
  };

  // ─── .meas handlers ──────────────────────────────────────────────────
  const handleAddMeas = () => {
    const cmd = parseMeasLine(measInput);
    if (cmd) {
      setMeasCommands([...measCommands, cmd]);
      setMeasInput('');
    }
  };
  const handleRunMeas = () => {
    if (traces.length === 0 || measCommands.length === 0) return;
    const trace = traces[0];
    const realTrace = {
      name: trace.label,
      xValues: Float64Array.from(trace.samples.map(s => s.time)),
      yValues: Float64Array.from(trace.samples.map(s => s.voltage)),
      xLabel: 'Time (s)',
      yLabel: 'Voltage (V)',
    };
    const results = measCommands.map(cmd => execMeas(cmd, realTrace as any));
    setMeasResults(results);
  };

  // ─── Parameter sweep handler ────────────────────────────────────────
  const handleSweepChange = (val: number) => {
    setSweepValue(val);
    if (sweepCompId) {
      setParameter(sweepCompId, sweepParam, val);
    }
  };

  const hasCircuit = components.length > 0;
  const hasGround = components.some((c) => c.type === 'ground');
  const hasSource = components.some((c) => ['dcVoltage', 'acVoltage', 'pulseSource', 'currentSource', 'arduino', 'arduinoReal', 'raspberryPi', 'vco', 'crystal', 'timer555'].includes(c.type));
  const readout = cursorReadout();

  return (
    <div className="flex h-full flex-col bg-slate-900" role="complementary" aria-label="Probe and oscilloscope panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-cyan-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Probe & Oscilloscope</span>
        </div>
        <div className="flex items-center gap-2">
          {simContext && (
            <span className="font-mono text-[10px] text-slate-500">
              t = {simContext.time >= 1 ? `${simContext.time.toFixed(3)}s` : `${(simContext.time * 1000).toFixed(2)}ms`}
              {running && ` · ${speed}×`}
            </span>
          )}
          {/* Cursor toggle */}
          <button
            onClick={() => setCursorEnabled(!cursorEnabled)}
            className={`cursor-pointer rounded p-1 ${cursorEnabled ? 'bg-amber-500/20 text-amber-400' : 'text-slate-500 hover:text-slate-300'}`}
            title="Toggle measurement cursor"
          >
            <Crosshair size={12} />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-800">
        {(['scope', 'measurements', 'meas', 'spectrum'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`cursor-pointer px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              activeTab === tab ? 'border-b-2 border-cyan-400 text-cyan-400' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {tab === 'meas' ? '.meas' : tab}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === 'scope' && (
          <>
            {/* Oscilloscope */}
            <div className="border-b border-slate-800 p-2">
              <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <BarChart3 size={10} className="mr-1 inline" />
                  Waveform {cursorEnabled && '· Cursor ON'}
                </span>
                <span className="text-[10px] text-slate-500">{traces.length} channel{traces.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="relative h-40 rounded-md border border-slate-800 bg-[#0a0f1c]">
                <canvas
                  ref={canvasRef}
                  className="h-full w-full"
                  onMouseMove={handleCanvasMouseMove}
                  onMouseLeave={handleCanvasMouseLeave}
                />
                {/* Cursor readout overlay */}
                {cursorEnabled && readout && (
                  <div className="absolute right-2 top-2 rounded border border-slate-700 bg-slate-900/90 px-2 py-1 font-mono text-[10px]">
                    <span style={{ color: readout.color }}>{readout.label}</span>
                    <span className="text-slate-400"> · t={(readout.time * 1000).toFixed(3)}ms</span>
                    <span className="text-slate-200"> · V={readout.voltage.toFixed(3)}V</span>
                  </div>
                )}
              </div>
            </div>

            {/* Parameter sweep slider */}
            <div className="border-b border-slate-800 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Parameter Sweep
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={sweepCompId}
                  onChange={(e) => setSweepCompId(e.target.value)}
                  className="cursor-pointer flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
                >
                  <option value="">Select component...</option>
                  {components.filter(c => {
                    const p = getPlugin(c.type);
                    return p && p.parameters.some(pa => pa.type === 'number');
                  }).map(c => (
                    <option key={c.id} value={c.id}>{c.refdes ?? c.id} ({c.type})</option>
                  ))}
                </select>
                <select
                  value={sweepParam}
                  onChange={(e) => setSweepParam(e.target.value)}
                  className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
                >
                  {sweepCompId ? (() => {
                    const c = components.find(c => c.id === sweepCompId);
                    const p = c ? getPlugin(c.type) : null;
                    return p?.parameters.filter(pa => pa.type === 'number').map(pa => (
                      <option key={pa.key} value={pa.key}>{pa.label}</option>
                    )) || null;
                  })() : null}
                </select>
              </div>
              {sweepCompId && (
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={sweepMin}
                    max={sweepMax}
                    value={sweepValue}
                    onChange={(e) => handleSweepChange(parseFloat(e.target.value))}
                    className="flex-1 cursor-pointer accent-cyan-400"
                  />
                  <span className="w-16 text-right font-mono text-[10px] text-cyan-300">{sweepValue.toFixed(1)}</span>
                </div>
              )}
            </div>

            {/* Live measurements */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="p-2">
                {!hasCircuit ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                    <AlertCircle size={24} className="text-slate-600" />
                    <p className="text-xs text-slate-500">No circuit yet. Add components to see measurements.</p>
                  </div>
                ) : !hasGround ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                    <AlertCircle size={24} className="text-amber-500" />
                    <p className="text-xs text-amber-400">Add a Ground component. The simulator needs a 0V reference.</p>
                  </div>
                ) : !hasSource ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                    <AlertCircle size={24} className="text-amber-500" />
                    <p className="text-xs text-amber-400">Add a power source (DC/AC/Pulse) to energize the circuit.</p>
                  </div>
                ) : measurements.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-500">
                    {running ? 'Solving...' : 'Press Run to start the simulation.'}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {measurements.map((m) => (
                      <div key={m.componentId} className="rounded-md border border-slate-800 bg-slate-800/40 p-2">
                        <div className="mb-1 flex items-center gap-1.5">
                          <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-950 text-[10px] font-bold text-cyan-300">{m.symbol}</span>
                          <span className="truncate text-[11px] font-medium text-slate-300">{m.name}</span>
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          {m.items.map((it, i) => (
                            <div key={i} className="rounded bg-slate-950/60 px-1 py-1 text-center">
                              <div className="text-[9px] uppercase tracking-wider text-slate-500">{it.label}</div>
                              <div className="font-mono text-[11px] text-slate-100">{it.value}<span className="text-slate-500">{it.unit}</span></div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === 'measurements' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="mb-3 text-xs text-slate-400">
              Live component measurements. Run the simulation to see voltage/current values.
            </div>
            {measurements.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                {running ? 'Solving...' : 'No measurements available. Run the simulation.'}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-2 py-1 text-left">Component</th>
                    <th className="px-2 py-1 text-left">Parameter</th>
                    <th className="px-2 py-1 text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {measurements.flatMap(m =>
                    m.items.map((it, i) => (
                      <tr key={`${m.componentId}-${i}`} className="border-t border-slate-800">
                        <td className="px-2 py-1 text-slate-300">{m.name}</td>
                        <td className="px-2 py-1 text-slate-400">{it.label}</td>
                        <td className="px-2 py-1 text-right font-mono text-cyan-300">{it.value} {it.unit}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'meas' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="mb-3 text-xs text-slate-400">
              Enter .meas commands (SPICE-style). Results appear after running.
            </div>
            <div className="mb-3 flex gap-2">
              <Input
                value={measInput}
                onChange={(e) => setMeasInput(e.target.value)}
                placeholder=".meas tran vout AVG V(out)"
                className="bg-slate-800 text-xs"
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddMeas(); }}
              />
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={handleAddMeas}>Add</Button>
              <Button size="sm" variant="default" className="cursor-pointer text-xs" onClick={handleRunMeas} disabled={traces.length === 0 || measCommands.length === 0}>Run</Button>
            </div>
            {measCommands.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Commands</div>
                {measCommands.map((cmd, i) => (
                  <div key={i} className="mb-1 rounded bg-slate-800/40 px-2 py-1 font-mono text-[10px] text-slate-300">
                    .meas {cmd.mode} {cmd.name} {cmd.type} {cmd.expr}
                  </div>
                ))}
              </div>
            )}
            {measResults.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Results</div>
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-2 py-1 text-left">Name</th>
                      <th className="px-2 py-1 text-right">Value</th>
                      <th className="px-2 py-1 text-left">Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {measResults.map((r, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="px-2 py-1 text-slate-300">{r.name}</td>
                        <td className="px-2 py-1 text-right font-mono text-cyan-300">{r.value.toFixed(6)}</td>
                        <td className="px-2 py-1 text-slate-500">{r.unit || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'spectrum' && <SpectrumTab traces={traces} canvasRef={spectrumCanvasRef} />}
      </div>
    </div>
  );
}

// ─── Spectrum tab — FFT bar chart + THD/SNR/SINAD readout ────────────────────

interface SpectrumTabProps {
  traces: ReturnType<typeof useEditor.getState>['traces'];
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

function SpectrumTab({ traces, canvasRef }: SpectrumTabProps) {
  const [selectedTrace, setSelectedTrace] = useState(0);
  const [maxHarmonics, setMaxHarmonics] = useState(10);

  // Pick the active trace
  const traceIdx = Math.min(selectedTrace, Math.max(0, traces.length - 1));
  const trace = traces[traceIdx];

  // Build a RealTrace suitable for computeFFT/computeTHD
  const realTrace = trace && trace.samples.length >= 8 ? {
    name: trace.label,
    xValues: Float64Array.from(trace.samples.map(s => s.time)),
    yValues: Float64Array.from(trace.samples.map(s => s.voltage)),
    xLabel: 'Time (s)',
    yLabel: 'Voltage (V)',
  } : null;

  const thdResult: THDResult | null = realTrace ? computeTHD(realTrace as any, maxHarmonics) : null;

  // Draw the spectrum bar chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(0, 0, rect.width, rect.height);

    // grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < rect.width; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); }
    for (let y = 0; y < rect.height; y += 24) { ctx.moveTo(0, y); ctx.lineTo(rect.width, y); }
    ctx.stroke();

    if (!thdResult || !realTrace) {
      ctx.fillStyle = '#475569';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        traces.length === 0
          ? 'Place an Oscilloscope component to capture a waveform'
          : 'Run the simulation to compute the FFT spectrum',
        rect.width / 2,
        rect.height / 2,
      );
      ctx.restore();
      return;
    }

    // Re-derive the spectrum via computeFFT (kept separate from thdResult for chart)
    // thdResult.harmonics holds the discrete peaks; for a continuous bar chart
    // we downsample the raw spectrum.
    const fullSpectrum = computeFFT(realTrace as any);
    const downsampled = downsampleSpectrum(fullSpectrum.yValues, fullSpectrum.xValues, 48);

    const padding = 8;
    const chartW = rect.width - 2 * padding;
    const chartH = rect.height - 2 * padding - 14; // leave 14px for x-axis label
    let maxMag = 0;
    for (const m of downsampled.mags) if (m > maxMag) maxMag = m;
    if (maxMag <= 0) maxMag = 1;
    const barW = chartW / downsampled.mags.length;

    // Highlight harmonic frequencies with vertical markers
    const harmonicFreqs = new Set(thdResult.harmonics.map(h => h.frequency));
    const freqToX = (freq: number) => {
      const fMin = Math.max(1, downsampled.freqs[0] || 1);
      const fMax = downsampled.freqs[downsampled.freqs.length - 1] || fMin * 2;
      const logMin = Math.log10(fMin);
      const logMax = Math.log10(fMax);
      if (logMax <= logMin) return padding;
      const t = (Math.log10(Math.max(fMin, freq)) - logMin) / (logMax - logMin);
      return padding + t * chartW;
    };

    // bars
    for (let i = 0; i < downsampled.mags.length; i++) {
      const m = downsampled.mags[i];
      const h = (m / maxMag) * chartH;
      const x = padding + i * barW;
      const y = padding + chartH - h;
      const isHarmonic = harmonicFreqs.has(downsampled.freqs[i]);
      ctx.fillStyle = isHarmonic ? '#fbbf24' : '#22d3ee';
      ctx.fillRect(x, y, Math.max(1, barW - 1), h);
    }

    // harmonic frequency labels (H1, H2, H3, ...)
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const h of thdResult.harmonics) {
      const x = freqToX(h.frequency);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padding);
      ctx.lineTo(x, padding + chartH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(`H${h.harmonic}`, x, padding + 1);
    }

    // axis label
    ctx.fillStyle = '#475569';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      `Frequency (Hz) · fs=${(thdResult.sampleRate / 1000).toFixed(1)}kHz · Δf=${thdResult.frequencyResolution.toFixed(1)}Hz`,
      rect.width / 2,
      rect.height - 2,
    );

    ctx.restore();
  }, [thdResult, realTrace, traces.length, canvasRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-slate-800 p-2">
        <div className="mb-2 flex items-center gap-2">
          <Waves size={12} className="text-cyan-400" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            FFT Spectrum + THD
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={traceIdx}
            onChange={(e) => setSelectedTrace(parseInt(e.target.value))}
            className="cursor-pointer flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
            disabled={traces.length === 0}
          >
            {traces.length === 0 ? (
              <option value={0}>No traces</option>
            ) : (
              traces.map((t, i) => (
                <option key={i} value={i}>{t.label}</option>
              ))
            )}
          </select>
          <label className="flex items-center gap-1 text-[10px] text-slate-400">
            Harms
            <input
              type="number"
              min={2}
              max={50}
              value={maxHarmonics}
              onChange={(e) => setMaxHarmonics(Math.min(50, Math.max(2, parseInt(e.target.value) || 10)))}
              className="w-12 rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-xs text-slate-200"
            />
          </label>
        </div>
      </div>

      {/* Bar chart */}
      <div className="border-b border-slate-800 p-2">
        <div className="relative h-44 rounded-md border border-slate-800 bg-[#0a0f1c]">
          <canvas ref={canvasRef} className="h-full w-full" />
        </div>
      </div>

      {/* THD / SNR / SINAD readout */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!thdResult ? (
          <div className="py-8 text-center text-xs text-slate-500">
            {traces.length === 0
              ? 'Place an Oscilloscope to capture a waveform.'
              : 'Run the simulation (or pause after running) to compute the spectrum.'}
          </div>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <ReadoutCard label="Fundamental" value={formatFreq(thdResult.fundamentalFreq)} hint={`${thdResult.harmonics[0].magnitudeDb.toFixed(1)} dB`} />
              <ReadoutCard label="THD" value={`${thdResult.thdPercent.toFixed(2)}%`} hint={`${thdResult.thdDb.toFixed(1)} dB`} accent={thdResult.thdPercent < 1 ? 'good' : thdResult.thdPercent < 5 ? 'warn' : 'bad'} />
              <ReadoutCard label="SNR" value={`${thdResult.snrDb.toFixed(1)} dB`} />
              <ReadoutCard label="SINAD" value={`${thdResult.sinadDb.toFixed(1)} dB`} />
            </div>

            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Harmonics</div>
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-2 py-1 text-left">#</th>
                  <th className="px-2 py-1 text-right">Freq</th>
                  <th className="px-2 py-1 text-right">Mag</th>
                  <th className="px-2 py-1 text-right">dB</th>
                  <th className="px-2 py-1 text-right">% Fund</th>
                </tr>
              </thead>
              <tbody>
                {thdResult.harmonics.map(h => (
                  <tr key={h.harmonic} className="border-t border-slate-800">
                    <td className="px-2 py-1 text-slate-300">H{h.harmonic}</td>
                    <td className="px-2 py-1 text-right font-mono text-slate-200">{formatFreq(h.frequency)}</td>
                    <td className="px-2 py-1 text-right font-mono text-slate-400">{h.magnitude.toFixed(4)}</td>
                    <td className="px-2 py-1 text-right font-mono text-cyan-300">{h.magnitudeDb.toFixed(1)}</td>
                    <td className={`px-2 py-1 text-right font-mono ${h.harmonic === 1 ? 'text-amber-400' : 'text-slate-400'}`}>{h.percentOfFundamental.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function formatFreq(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
  return `${hz.toFixed(1)} Hz`;
}

function ReadoutCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: 'good' | 'warn' | 'bad' }) {
  const accentColor = accent === 'good' ? 'text-emerald-400' : accent === 'warn' ? 'text-amber-400' : accent === 'bad' ? 'text-red-400' : 'text-slate-100';
  return (
    <div className="rounded-md border border-slate-800 bg-slate-800/40 p-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-sm ${accentColor}`}>{value}</div>
      {hint && <div className="font-mono text-[10px] text-slate-500">{hint}</div>}
    </div>
  );
}
