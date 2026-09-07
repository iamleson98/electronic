'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useEditor, type ProbeTrace } from '@/lib/circuit/store';
import { getPlugin } from '@/lib/circuit/registry';
import { getTerminalsForComponent, buildNodeMap } from '@/lib/circuit/engine';
import { parseMeasLine, execMeas, computeFFT, type MeasCommand, type MeasResult } from '@/lib/circuit/measurement';
import { computeTHD, downsampleSpectrum, type THDResult } from '@/lib/circuit/fourier';
import {
  applyCoupling, computeCursorDeltas, computeMathSamples, computeMeasurements, computeTimeWindow, computeVoltageWindow,
  createDefaultScopeConfig, cursorIntervalStats, formatDuration, formatFrequency, formatTimebase, formatVoltage,
  formatVoltageScale, getVoltageAtTime, mapTimeToX, mapVoltageToY, mapXToTime, meanVoltage,
  pickDefaultVoltageScale, PROBE_MODELS, refitVoltageScale, resolveTriggerAnchor, stepPreset, SCOPE_H_DIVS, SCOPE_V_DIVS,
  TIMEBASE_PRESETS, VOLTAGE_SCALE_PRESETS, type MathOp, type ScopeChannel, type ScopeConfig,
} from '@/lib/circuit/scope-viewer';
import { SerialMonitorTab } from './SerialMonitorTab';
import { Activity, BarChart3, AlertCircle, Crosshair, Waves, Sparkles, Zap, Sigma, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** User-adjustable per-channel scope settings, keyed by trace componentId. */
interface ScopeChannelSettings {
  voltageScale: number;   // V/div (steps through VOLTAGE_SCALE_PRESETS)
  voltageOffset: number;  // voltage pinned to the grid's vertical center (V)
  coupling: 'DC' | 'AC';  // AC removes the channel's DC component (mean)
  visible: boolean;
  /** true once the user changes scale/offset — disables the grow-only refit */
  touched: boolean;
}

export function ProbePanel() {
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const simContext = useEditor((s) => s.simContext);
  const traces = useEditor((s) => s.traces);
  const running = useEditor((s) => s.running);
  const speed = useEditor((s) => s.speed);
  const simError = useEditor((s) => s.simError);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // const containerRef = useRef<HTMLDivElement | null>(null);

  // ─── Oscilloscope (scope-viewer) state ────────────────────────────────
  // Deliberately panel-local React state (NOT the editor store): scope view
  // settings must never mark the document dirty, enter undo/redo history or
  // autosave. ProbePanel stays mounted, so this survives tab switches.
  // Persisted to localStorage so timebase/trigger/cursors survive reloads.
  const [scopeConfig, setScopeConfig] = useState<ScopeConfig>(() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem('scope-config-v1') : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ScopeConfig>;
        return { ...createDefaultScopeConfig(), ...parsed, cursorA: { ...createDefaultScopeConfig().cursorA, ...(parsed.cursorA ?? {}) }, cursorB: { ...createDefaultScopeConfig().cursorB, ...(parsed.cursorB ?? {}) }, trigger: { ...createDefaultScopeConfig().trigger, ...(parsed.trigger ?? {}) } };
      }
    } catch { /* corrupted prefs — fall through to defaults */ }
    return createDefaultScopeConfig();
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('scope-config-v1', JSON.stringify({
        timebase: scopeConfig.timebase,
        cursorA: scopeConfig.cursorA,
        cursorB: scopeConfig.cursorB,
        trigger: scopeConfig.trigger,
        showGrid: scopeConfig.showGrid,
        showMeasurements: scopeConfig.showMeasurements,
      }));
    } catch { /* storage full/blocked — scope still works */ }
  }, [scopeConfig.timebase, scopeConfig.cursorA, scopeConfig.cursorB, scopeConfig.trigger, scopeConfig.showGrid, scopeConfig.showMeasurements]);
  const [channelSettings, setChannelSettings] = useState<Record<string, ScopeChannelSettings>>({});
  const [selectedChannel, setSelectedChannel] = useState(0);
  const [activeTab, setActiveTab] = useState<'scope' | 'measurements' | 'meas' | 'spectrum' | 'serial'>('scope');
  const [xyMode, setXyMode] = useState(false);
  const [probeModel, setProbeModel] = useState(0);

  // ─── Scope math channels (A±B, A×B) ───────────────────────────────────
  // Definitions are panel-local (never dirty the document / undo history) and
  // persisted so they survive reloads. Computed traces are appended to the
  // trace list passed to the scope — they flow through ALL existing channel
  // machinery (V/div knobs, coupling, cursors, XY, measurements, spectrum).
  const [mathChannels, setMathChannels] = useState<MathChannelDef[]>(() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem('scope-math-v1') : null;
      if (raw) {
        const parsed = JSON.parse(raw) as MathChannelDef[];
        if (Array.isArray(parsed)) {
          return parsed.filter((d) => d && typeof d.op === 'string' && typeof d.aIdx === 'number' && typeof d.bIdx === 'number');
        }
      }
    } catch { /* corrupted prefs — fall through to defaults */ }
    return [];
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('scope-math-v1', JSON.stringify(mathChannels));
    } catch { /* storage full/blocked */ }
  }, [mathChannels]);

  const displayTraces = useMemo(() => {
    if (mathChannels.length === 0) return traces;
    const mathTraces: ProbeTrace[] = [];
    for (const def of mathChannels) {
      if (!def.visible) continue;
      const a = traces[def.aIdx];
      const b = traces[def.bIdx];
      if (!a || !b) continue; // trace removed — definition goes dormant
      const samples = computeMathSamples(a.samples, b.samples, def.op);
      if (samples.length < 2) continue;
      mathTraces.push({
        componentId: def.id,
        color: '#f472b6',
        label: mathLabel(def, a, b),
        samples,
      });
    }
    return mathTraces.length > 0 ? [...traces, ...mathTraces] : traces;
  }, [traces, mathChannels]);

  // ─── .meas commands ───────────────────────────────────────────────────
  const [measCommands, setMeasCommands] = useState<MeasCommand[]>([]);
  const [measResults, setMeasResults] = useState<MeasResult[]>([]);
  const [measInput, setMeasInput] = useState('');

  // ─── Parameter sweep slider ──────────────────────────────────────────
  const [sweepCompId, setSweepCompId] = useState('');
  const [sweepParam, setSweepParam] = useState('resistance');
  const [sweepMin] = useState(100);
  const [sweepMax] = useState(10000);
  const [sweepValue, setSweepValue] = useState(1000);
  const setParameter = useEditor((s) => s.setParameter);

  // build a per-component measurements list
  const measurements: { componentId: string; name: string; symbol: string; items: { label: string; value: string; unit?: string }[] }[] = [];
  if (simContext && components.length > 0) {
    const plugins = new Map<string, NonNullable<ReturnType<typeof getPlugin>>>();
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
        const m = plugin.measure(comp.parameters, terminals, simContext, comp);
        if (m && m.length > 0) {
          measurements.push({ componentId: comp.id, name: plugin.name, symbol: plugin.symbol, items: m });
        }
      } catch {
        // ignore measure errors
      }
    }
  }

  // ─── Scope: seed / grow-fit per-channel V/div ───────────────────────
  // The first time a trace produces a real signal (≥2 samples) we pick a
  // V/div preset that fits it. Untouched channels are re-fitted upward only
  // (grow-only) so a ramping signal stays on screen; once the user turns a
  // scale/offset knob the channel is "touched" and never auto-adjusted again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChannelSettings((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const t of displayTraces) {
        const cs = next[t.componentId];
        if (cs?.touched || t.samples.length < 2) continue;
        let vMin = Infinity, vMax = -Infinity;
        for (const s of t.samples) {
          if (s.voltage < vMin) vMin = s.voltage;
          if (s.voltage > vMax) vMax = s.voltage;
        }
        if (!cs) {
          next[t.componentId] = {
            voltageScale: pickDefaultVoltageScale(vMin, vMax),
            voltageOffset: 0,
            coupling: 'DC',
            visible: true,
            touched: false,
          };
          changed = true;
        } else {
          const fitted = refitVoltageScale(cs.voltageScale, vMin, vMax, cs.voltageOffset);
          if (fitted !== cs.voltageScale) {
            next[t.componentId] = { ...cs, voltageScale: fitted };
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [displayTraces]);

  const updateChannelSetting = useCallback((componentId: string, patch: Partial<ScopeChannelSettings>) => {
    setChannelSettings((prev) => {
      const base: ScopeChannelSettings = prev[componentId] ?? {
        voltageScale: 1, voltageOffset: 0, coupling: 'DC', visible: true, touched: true,
      };
      const merged = { ...base, ...patch };
      // any explicit scale/offset change freezes the auto-refit for this channel
      if (patch.voltageScale !== undefined || patch.voltageOffset !== undefined) merged.touched = true;
      return { ...prev, [componentId]: merged };
    });
  }, []);

  // ─── Cursor-A readout (feeds the header "Ask AI" prompt) ───────────
  // Pure computation — no canvas access — evaluated for the selected channel.
  const scopeReadout = useMemo(() => {
    if (!scopeConfig.cursorA.enabled) return null;
    const idx = displayTraces.length > 0 ? Math.min(selectedChannel, displayTraces.length - 1) : -1;
    const trace = idx >= 0 ? displayTraces[idx] : null;
    if (!trace || trace.samples.length === 0) return null;
    const cs = channelSettings[trace.componentId];
    const coupled = applyCoupling(trace.samples, cs?.coupling ?? 'DC');
    const v = getVoltageAtTime(coupled, scopeConfig.cursorA.time);
    if (v === null) return null;
    return { label: trace.label, color: trace.color, time: scopeConfig.cursorA.time, voltage: v };
  }, [scopeConfig.cursorA, displayTraces, selectedChannel, channelSettings]);

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
    const results = measCommands.map(cmd => execMeas(cmd, realTrace));
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
          {/* Cursor A toggle */}
          <button
            onClick={() => setScopeConfig((s) => ({ ...s, cursorA: { ...s.cursorA, enabled: !s.cursorA.enabled } }))}
            aria-pressed={scopeConfig.cursorA.enabled}
            className={`cursor-pointer rounded p-1 ${scopeConfig.cursorA.enabled ? 'bg-amber-500/20 text-amber-400' : 'text-slate-500 hover:text-slate-300'}`}
            title="Toggle cursor A"
          >
            <Crosshair size={12} />
          </button>
          {/* Ask AI why the voltage is wrong */}
          <button
            onClick={() => {
              const prompt = simError
                ? `The simulation is failing with this error: "${simError}". Diagnose the root cause and explain how to fix it.`
                : scopeReadout
                  ? `The voltage at ${scopeReadout.label} is ${scopeReadout.voltage.toFixed(3)}V at t=${(scopeReadout.time * 1000).toFixed(2)}ms. Is this expected? If not, diagnose why and suggest a fix.`
                  : 'Run a diagnosis on my circuit and tell me if the voltages are correct.';
              window.dispatchEvent(new CustomEvent('circuitlab:ask-ai', { detail: prompt }));
            }}
            className="cursor-pointer rounded p-1 text-slate-500 hover:text-cyan-300"
            title="Ask AI to diagnose this circuit"
          >
            <Sparkles size={12} />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-800">
        {(['scope', 'measurements', 'meas', 'spectrum', 'serial'] as const).map(tab => (
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
            {/* Oscilloscope — div-based scope UI driven by scope-viewer */}
            <ScopeTab
              traces={displayTraces}
              realTraceCount={traces.length}
              mathChannels={mathChannels}
              setMathChannels={setMathChannels}
              scopeConfig={scopeConfig}
              setScopeConfig={setScopeConfig}
              channelSettings={channelSettings}
              updateChannelSetting={updateChannelSetting}
              selectedChannel={selectedChannel}
              setSelectedChannel={setSelectedChannel}
              canvasRef={canvasRef}
              xyMode={xyMode}
              setXyMode={setXyMode}
              probeModel={probeModel}
              setProbeModel={setProbeModel}
            />

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

        {activeTab === 'spectrum' && <SpectrumTab traces={displayTraces} canvasRef={spectrumCanvasRef} />}
        {activeTab === 'serial' && <SerialMonitorTab />}
      </div>
    </div>
  );
}

// ─── Scope math channels ────────────────────────────────────────────────────

/** User-defined math channel: A (op) B over two real scope traces. */
export interface MathChannelDef {
  id: string;
  op: MathOp;
  /** index into the REAL trace list (not the display list) */
  aIdx: number;
  bIdx: number;
  visible: boolean;
}

function mathLabel(def: MathChannelDef, a: { label: string }, b: { label: string }): string {
  const sym = def.op === 'add' ? '+' : def.op === 'sub' ? '−' : '×';
  return `${a.label} ${sym} ${b.label}`;
}

// ─── Scope tab — real oscilloscope UI driven by scope-viewer ────────────────

interface ScopeTabProps {
  /** real traces + computed math traces (math appended at the end) */
  traces: ProbeTrace[];
  /** how many leading entries of `traces` are real (non-math) channels */
  realTraceCount: number;
  mathChannels: MathChannelDef[];
  setMathChannels: React.Dispatch<React.SetStateAction<MathChannelDef[]>>;
  scopeConfig: ScopeConfig;
  setScopeConfig: React.Dispatch<React.SetStateAction<ScopeConfig>>;
  channelSettings: Record<string, ScopeChannelSettings>;
  updateChannelSetting: (componentId: string, patch: Partial<ScopeChannelSettings>) => void;
  selectedChannel: number;
  setSelectedChannel: React.Dispatch<React.SetStateAction<number>>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  xyMode: boolean;
  setXyMode: React.Dispatch<React.SetStateAction<boolean>>;
  probeModel: number;
  setProbeModel: React.Dispatch<React.SetStateAction<number>>;
}

function ScopeTab({ traces, realTraceCount, mathChannels, setMathChannels, scopeConfig, setScopeConfig, channelSettings, updateChannelSetting, selectedChannel, setSelectedChannel, canvasRef, xyMode, setXyMode, probeModel, setProbeModel }: ScopeTabProps) {
  const a = scopeConfig.cursorA;
  const b = scopeConfig.cursorB;
  const trig = scopeConfig.trigger;

  // Derived channel view models: store traces + per-channel user settings.
  const channels: ScopeChannel[] = useMemo(() => traces.map((t) => {
    const cs = channelSettings[t.componentId];
    return {
      id: t.componentId,
      label: t.label,
      color: t.color,
      samples: t.samples,
      visible: cs?.visible ?? true,
      voltageScale: cs?.voltageScale ?? 1,
      voltageOffset: cs?.voltageOffset ?? 0,
      coupling: cs?.coupling ?? 'DC',
    };
  }), [traces, channelSettings]);

  const traceIdx = traces.length > 0 ? Math.min(selectedChannel, traces.length - 1) : 0;
  const selected = channels[traceIdx];

  // Display anchor: auto = free-running newest sample; normal/single =
  // re-anchor on the latest qualifying trigger edge (real acquisition).
  // Single mode freezes at the captured edge once disarmed; the freeze time
  // lives in trigger state (frozenAt) — read here as plain state (no refs
  // during render) and written via a deferred microtask (no setState in
  // render or in an effect — both are lint errors).
  const centerTime = useMemo(() => {
    let latest = 0;
    for (const t of traces) {
      const s = t.samples;
      if (s.length > 0) latest = Math.max(latest, s[s.length - 1].time);
    }
    if (scopeConfig.trigger.mode === 'auto') return latest;
    const src = channels[scopeConfig.trigger.source];
    if (!src || src.samples.length < 2) return latest;
    const coupled = applyCoupling(src.samples, src.coupling);
    const anchor = resolveTriggerAnchor(coupled, scopeConfig.trigger, latest, scopeConfig.trigger.frozenAt);
    // Single-shot capture: once a qualifying edge exists and we are armed,
    // freeze at it + disarm atomically. Deferred to a microtask so the memo
    // stays side-effect-free.
    if (scopeConfig.trigger.mode === 'single' && scopeConfig.trigger.armed && anchor !== latest) {
      const captured = anchor;
      const freeze = () => setScopeConfig((s) =>
        s.trigger.mode === 'single' && s.trigger.armed
          ? { ...s, trigger: { ...s.trigger, armed: false, frozenAt: captured } }
          : s);
      if (typeof queueMicrotask === 'function') queueMicrotask(freeze);
      else setTimeout(freeze, 0);
      return anchor;
    }
    return anchor;
  }, [traces, channels, scopeConfig.trigger, setScopeConfig]);

  const timeWindow = useMemo(
    () => computeTimeWindow(scopeConfig.timebase, centerTime),
    [scopeConfig.timebase, centerTime],
  );

  // ─── Canvas rendering (div-based, replaces the old auto-fit drawing) ────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { cursorA, cursorB, trigger, timebase, maxSamples, showGrid } = scopeConfig;
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(0, 0, W, H);

    // Standard scope graticule: 10 × 8 divisions with subtle lines, a slightly
    // stronger center crosshair and minor ticks along the center axes.
    if (showGrid) {
      const divX = W / SCOPE_H_DIVS;
      const divY = H / SCOPE_V_DIVS;
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= SCOPE_H_DIVS; i++) {
        const x = Math.round(i * divX) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, H);
      }
      for (let j = 0; j <= SCOPE_V_DIVS; j++) {
        const y = Math.round(j * divY) + 0.5;
        ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
      const cx = Math.round(W / 2) + 0.5;
      const cy = Math.round(H / 2) + 0.5;
      ctx.strokeStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
      ctx.moveTo(0, cy); ctx.lineTo(W, cy);
      ctx.stroke();
      ctx.beginPath();
      for (let i = 1; i < SCOPE_H_DIVS * 5; i++) {
        if (i % 5 === 0) continue;
        const x = Math.round(i * (divX / 5)) + 0.5;
        ctx.moveTo(x, cy - 2); ctx.lineTo(x, cy + 2);
      }
      for (let j = 1; j < SCOPE_V_DIVS * 5; j++) {
        if (j % 5 === 0) continue;
        const y = Math.round(j * (divY / 5)) + 0.5;
        ctx.moveTo(cx - 2, y); ctx.lineTo(cx + 2, y);
      }
      ctx.stroke();
    }

    if (channels.length === 0) {
      ctx.fillStyle = '#475569';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Place an Oscilloscope component to capture waveforms', W / 2, H / 2 - 8);
      ctx.fillText('Probes measure voltage across their + and - terminals', W / 2, H / 2 + 10);
    }

    // XY mode: plot CH2 vs CH1 (Lissajous / curve-tracer). Needs two
    // visible channels; X = first, Y = second.
    const xyPair = xyMode ? [channels.find((c) => c.visible), channels.filter((c) => c.visible)[1]] : null;
    if (xyMode && xyPair && xyPair[0] && xyPair[1]) {
      const xCh = xyPair[0];
      const yCh = xyPair[1];
      const xs = applyCoupling(xCh.samples.slice(-maxSamples), xCh.coupling);
      const ys = applyCoupling(yCh.samples.slice(-maxSamples), yCh.coupling);
      const n = Math.min(xs.length, ys.length);
      const xWin = computeVoltageWindow(xCh.voltageScale, xCh.voltageOffset);
      const yWin = computeVoltageWindow(yCh.voltageScale, yCh.voltageOffset);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        // X maps through the voltage window (vBottom→left, vTop→right)
        const x = ((xs[i].voltage - xWin.vBottom) / Math.max(1e-12, xWin.vTop - xWin.vBottom)) * W;
        const y = mapVoltageToY(ys[i].voltage, yWin, 0, H);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#64748b';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`X: ${xCh.label}  Y: ${yCh.label}`, 6, 4);
    }

    // Traces: shared X mapping (time window), per-channel Y mapping
    // (V/div + offset); AC coupling removes the channel mean first.
    // Skipped in XY mode (the Lissajous view above replaces them).
    for (const ch of channels) {
      if (xyMode) break;
      if (!ch.visible || ch.samples.length < 2) continue;
      const samples = ch.samples.length > maxSamples ? ch.samples.slice(-maxSamples) : ch.samples;
      const coupled = applyCoupling(samples, ch.coupling);
      const vWin = computeVoltageWindow(ch.voltageScale, ch.voltageOffset);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H); // clip the trace to the graticule
      ctx.clip();
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < coupled.length; i++) {
        const x = mapTimeToX(coupled[i].time, timeWindow, 0, W);
        const y = mapVoltageToY(coupled[i].voltage, vWin, 0, H);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Trigger level marker: drawn through the source channel's Y mapping so it
    // tracks that channel's V/div / offset / coupling. In normal/single modes
    // the window re-anchors on this edge (real acquisition); auto streams.
    const trigCh = channels[trigger.source];
    if (trigCh) {
      const vWin = computeVoltageWindow(trigCh.voltageScale, trigCh.voltageOffset);
      const level = trigger.level - (trigCh.coupling === 'AC' ? meanVoltage(trigCh.samples) : 0);
      const y = mapVoltageToY(level, vWin, 0, H);
      if (y >= 0 && y <= H) {
        ctx.strokeStyle = '#fb923c';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(W, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        // slope arrow at the left edge (▲ rising / ▼ falling)
        ctx.fillStyle = '#fb923c';
        ctx.beginPath();
        const s = 5;
        if (trigger.edge === 'rising') {
          ctx.moveTo(4, y - s);
          ctx.lineTo(4 + s * 0.8, y + s * 0.6);
          ctx.lineTo(4 - s * 0.8, y + s * 0.6);
        } else {
          ctx.moveTo(4, y + s);
          ctx.lineTo(4 + s * 0.8, y - s * 0.6);
          ctx.lineTo(4 - s * 0.8, y - s * 0.6);
        }
        ctx.closePath();
        ctx.fill();
      }
    }

    // Channel label boxes along the left edge: "CHn <V/div> <s/div>"
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let boxY = 4;
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      if (!ch.visible) continue;
      const text = `CH${i + 1} ${formatVoltageScale(ch.voltageScale)} ${formatTimebase(timebase)}`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(10, 15, 28, 0.85)';
      ctx.fillRect(4, boxY, tw + 10, 14);
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(4.5, boxY + 0.5, tw + 9, 13);
      ctx.fillStyle = ch.color;
      ctx.fillText(text, 9, boxY + 2);
      boxY += 17;
    }

    // A/B cursors: A solid amber, B dashed cyan, with a flag label at the top.
    const drawCursorLine = (time: number, color: string, dashed: boolean, label: string) => {
      const x = mapTimeToX(time, timeWindow, 0, W);
      if (x < -1 || x > W + 1) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      if (dashed) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x, 2);
    };
    if (cursorA.enabled) drawCursorLine(cursorA.time, '#f59e0b', false, 'A');
    if (cursorB.enabled) drawCursorLine(cursorB.time, '#22d3ee', true, 'B');

    ctx.restore();
  }, [channels, scopeConfig, timeWindow, canvasRef, xyMode]);

  useEffect(() => { draw(); }, [draw]);
  // Redraw when the canvas (re)mounts or resizes — covers tab switches, which
  // remount the canvas without changing any draw dependency.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef, draw]);

  // ─── Cursor dragging (pointer events) ──────────────────────────────────
  const dragRef = useRef<'A' | 'B' | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!a.enabled && !b.enabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // grab the nearest enabled cursor within 10 px
    let best: 'A' | 'B' | null = null;
    let bestDist = 10;
    if (a.enabled) {
      const d = Math.abs(mapTimeToX(a.time, timeWindow, 0, rect.width) - px);
      if (d <= bestDist) { best = 'A'; bestDist = d; }
    }
    if (b.enabled) {
      const d = Math.abs(mapTimeToX(b.time, timeWindow, 0, rect.width) - px);
      if (d <= bestDist) { best = 'B'; bestDist = d; }
    }
    if (best) {
      dragRef.current = best;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const key = dragRef.current;
    if (!key) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = mapXToTime(e.clientX - rect.left, timeWindow, 0, rect.width);
    setScopeConfig((s) =>
      key === 'A'
        ? { ...s, cursorA: { ...s.cursorA, time: t } }
        : { ...s, cursorB: { ...s.cursorB, time: t } },
    );
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already have been released
    }
  };

  // ─── Toolbar actions ───────────────────────────────────────────────────
  const stepTimebase = (dir: 1 | -1) =>
    setScopeConfig((s) => ({ ...s, timebase: stepPreset(TIMEBASE_PRESETS, s.timebase, dir) }));

  const stepVoltsPerDiv = (dir: 1 | -1) => {
    if (!selected) return;
    updateChannelSetting(selected.id, { voltageScale: stepPreset(VOLTAGE_SCALE_PRESETS, selected.voltageScale, dir) });
  };

  const stepOffset = (dir: 1 | -1) => {
    if (!selected) return;
    // quarter-division steps keep the control useful at every V/div
    const next = selected.voltageOffset + dir * (selected.voltageScale / 4);
    updateChannelSetting(selected.id, { voltageOffset: Math.max(-1000, Math.min(1000, next)) });
  };

  const toggleCoupling = () => {
    if (!selected) return;
    updateChannelSetting(selected.id, { coupling: selected.coupling === 'DC' ? 'AC' : 'DC' });
  };

  const toggleCursor = (key: 'A' | 'B') =>
    setScopeConfig((s) => {
      const cur = key === 'A' ? s.cursorA : s.cursorB;
      // drop a newly-enabled cursor at the window center ("now")
      const time = cur.enabled ? cur.time : (timeWindow.tStart + timeWindow.tEnd) / 2;
      return key === 'A'
        ? { ...s, cursorA: { ...cur, enabled: !cur.enabled, time } }
        : { ...s, cursorB: { ...cur, enabled: !cur.enabled, time } };
    });

  const nudgeCursor = (key: 'A' | 'B', dir: 1 | -1) =>
    setScopeConfig((s) => {
      // 0.1 division per press — fine enough for 1/Δt frequency measurements
      const step = s.timebase / 10;
      return key === 'A'
        ? { ...s, cursorA: { ...s.cursorA, time: s.cursorA.time + dir * step } }
        : { ...s, cursorB: { ...s.cursorB, time: s.cursorB.time + dir * step } };
    });

  // ─── Readouts ──────────────────────────────────────────────────────────
  // Cursor readouts: Δt, 1/Δt and the (coupling-adjusted) voltage of the
  // selected channel at each cursor position, plus A–B interval stats
  // (AVG/RMS/PP/integral/mean-slope over the selected channel).
  const cursorData = useMemo(() => {
    if (!a.enabled && !b.enabled) return null;
    const samples = selected ? applyCoupling(selected.samples, selected.coupling) : [];
    const vA = a.enabled ? getVoltageAtTime(samples, a.time) : null;
    const vB = b.enabled ? getVoltageAtTime(samples, b.time) : null;
    const deltas = a.enabled && b.enabled ? computeCursorDeltas(a.time, b.time) : null;
    const interval = a.enabled && b.enabled
      ? cursorIntervalStats(samples, a.time, b.time)
      : null;
    return { vA, vB, deltas, interval };
  }, [a.enabled, a.time, b.enabled, b.time, selected]);

  // Live measurements for the selected channel (coupling applied, so AC shows
  // the coupled waveform's stats — Vavg ≈ 0, Vpp unchanged).
  const measurements = useMemo(
    () => (selected ? computeMeasurements(applyCoupling(selected.samples, selected.coupling)) : []),
    [selected],
  );

  return (
    <div className="border-b border-slate-800 p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          <BarChart3 size={10} className="mr-1 inline" />
          Waveform {(a.enabled || b.enabled) && '· Cursors ON'}
        </span>
        <span className="text-[10px] text-slate-500">{traces.length} channel{traces.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Compact scope toolbar */}
      <div className="mb-1.5 space-y-1">
        {/* Row 1: timebase + trigger status */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[9px] uppercase tracking-wider text-slate-500">Time</span>
          <ToolBtn label="Decrease timebase (finer)" onClick={() => stepTimebase(-1)}>−</ToolBtn>
          <span className="w-21 text-center font-mono text-[10px] text-slate-200" aria-live="polite">{formatTimebase(scopeConfig.timebase)}</span>
          <ToolBtn label="Increase timebase (coarser)" onClick={() => stepTimebase(1)}>+</ToolBtn>
          <ToolBtn
            label="Cycle trigger mode (auto → normal → single)"
            onClick={() => setScopeConfig((s) => {
              const next = s.trigger.mode === 'auto' ? 'normal' : s.trigger.mode === 'normal' ? 'single' : 'auto';
              return { ...s, trigger: { ...s.trigger, mode: next, armed: true } };
            })}
            active={trig.mode !== 'auto'}
          >
            {trig.mode.toUpperCase()}
          </ToolBtn>
          <ToolBtn
            label="Re-arm single trigger"
            onClick={() => { setScopeConfig((s) => ({ ...s, trigger: { ...s.trigger, frozenAt: undefined, armed: true } })); }}
            disabled={trig.mode !== 'single'}
          >
            ARM
          </ToolBtn>
          <span className="ml-auto flex items-center gap-1 font-mono text-[10px]" title={trig.mode === 'auto' ? 'Trigger marker (auto: free-running)' : `Trigger ${trig.mode}: window re-anchors on CH${trig.source + 1} ${trig.edge} edge at ${formatVoltage(trig.level)}`}>
            <Zap size={10} className={trig.armed ? 'text-orange-400' : 'text-slate-600'} aria-hidden="true" />
            <span className={trig.armed ? 'text-orange-400' : 'text-slate-500'}>{trig.armed ? 'ARMED' : 'IDLE'}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400">{`CH${trig.source + 1}`}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400">{trig.edge === 'rising' ? '↑' : '↓'}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400">{formatVoltage(trig.level)}</span>
          </span>
        </div>

        {/* Row 2: selected-channel vertical controls */}
        <div className="flex flex-wrap items-center gap-1">
          <select
            value={traceIdx}
            onChange={(e) => setSelectedChannel(parseInt(e.target.value, 10))}
            disabled={traces.length === 0}
            aria-label="Selected channel"
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200"
          >
            {traces.length === 0 ? (
              <option value={0}>No traces</option>
            ) : (
              traces.map((t, i) => (
                <option key={t.componentId} value={i}>{`CH${i + 1}: ${t.label}`}</option>
              ))
            )}
          </select>
          <ToolBtn label="Decrease volts per division" onClick={() => stepVoltsPerDiv(-1)} disabled={!selected}>−</ToolBtn>
          <span className="w-21 text-center font-mono text-[10px] text-slate-200" aria-live="polite">{selected ? formatVoltageScale(selected.voltageScale) : '—'}</span>
          <ToolBtn label="Increase volts per division" onClick={() => stepVoltsPerDiv(1)} disabled={!selected}>+</ToolBtn>
          <ToolBtn
            label={selected?.coupling === 'AC' ? 'Switch coupling to DC' : 'Switch coupling to AC (removes DC offset)'}
            onClick={toggleCoupling}
            disabled={!selected}
            active={selected?.coupling === 'AC'}
          >
            {selected?.coupling ?? 'DC'}
          </ToolBtn>
          <span className="text-[9px] uppercase tracking-wider text-slate-500" title="Vertical offset — voltage at screen center">Ofs</span>
          <ToolBtn label="Decrease vertical offset" onClick={() => stepOffset(-1)} disabled={!selected}>−</ToolBtn>
          <span className="w-17.5 text-center font-mono text-[10px] text-slate-200" aria-live="polite">{selected ? formatVoltage(selected.voltageOffset) : '—'}</span>
          <ToolBtn label="Increase vertical offset" onClick={() => stepOffset(1)} disabled={!selected}>+</ToolBtn>
        </div>

        {/* Row 3: A/B cursors + XY + probe */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[9px] uppercase tracking-wider text-slate-500">Cursors</span>
          <ToolBtn label="Toggle cursor A" onClick={() => toggleCursor('A')} active={a.enabled}>A</ToolBtn>
          <ToolBtn label="Move cursor A left (0.1 div)" onClick={() => nudgeCursor('A', -1)} disabled={!a.enabled}>◀</ToolBtn>
          <ToolBtn label="Move cursor A right (0.1 div)" onClick={() => nudgeCursor('A', 1)} disabled={!a.enabled}>▶</ToolBtn>
          <ToolBtn label="Toggle cursor B" onClick={() => toggleCursor('B')} active={b.enabled}>B</ToolBtn>
          <ToolBtn label="Move cursor B left (0.1 div)" onClick={() => nudgeCursor('B', -1)} disabled={!b.enabled}>◀</ToolBtn>
          <ToolBtn label="Move cursor B right (0.1 div)" onClick={() => nudgeCursor('B', 1)} disabled={!b.enabled}>▶</ToolBtn>
          <ToolBtn label="Toggle XY mode (CH2 vs CH1 Lissajous)" onClick={() => setXyMode((v) => !v)} active={xyMode}>XY</ToolBtn>
          <select
            value={probeModel}
            onChange={(e) => setProbeModel(parseInt(e.target.value, 10))}
            aria-label="Probe model"
            title="Probe loading model (what a real probe would read)"
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-[10px] text-slate-200"
          >
            {PROBE_MODELS.map((p, i) => (
              <option key={p.label} value={i}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* Row 4: math channels (A±B, A×B) */}
        <MathChannelRow
          traces={traces}
          realTraceCount={realTraceCount}
          mathChannels={mathChannels}
          setMathChannels={setMathChannels}
        />
      </div>

      {/* Graticule canvas: 10 × 8 divisions, pointer-draggable A/B cursors */}
      <div className="relative h-48 rounded-md border border-slate-800 bg-[#0a0f1c]">
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none"
          aria-label="Oscilloscope waveform display"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      </div>

      {/* Cursor readout row */}
      <div className="mt-1 rounded border border-slate-800 bg-slate-800/40 px-2 py-1 font-mono text-[10px]">
        {cursorData ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {selected && <span style={{ color: selected.color }}>{selected.label}</span>}
            {a.enabled && <span className="text-amber-400">tA={formatDuration(a.time)}</span>}
            {cursorData.vA !== null && <span className="text-slate-200">VA={formatVoltage(cursorData.vA)}</span>}
            {b.enabled && <span className="text-cyan-300">tB={formatDuration(b.time)}</span>}
            {cursorData.vB !== null && <span className="text-slate-200">VB={formatVoltage(cursorData.vB)}</span>}
            {cursorData.deltas && <span className="text-slate-300">Δt={formatDuration(cursorData.deltas.dt)}</span>}
            {cursorData.deltas?.freq != null && <span className="text-cyan-300">1/Δt={formatFrequency(cursorData.deltas.freq)}</span>}
            {cursorData.interval && (
              <span className="text-slate-400" title="A–B interval: average / RMS / peak-peak / integral / mean slope">
                AVG={formatVoltage(cursorData.interval.vAvg)} RMS={formatVoltage(cursorData.interval.vRms)} PP={formatVoltage(cursorData.interval.vPp)}
              </span>
            )}
          </div>
        ) : (
          <span className="text-slate-500">Enable cursor A/B to measure Δt, 1/Δt and voltages</span>
        )}
      </div>

      {/* Measurements row (selected channel) */}
      {scopeConfig.showMeasurements && measurements.length > 0 && (
        <div className="mt-1 grid grid-cols-5 gap-1">
          {measurements.map((m) => (
            <div key={m.name} className="rounded bg-slate-950/60 px-1 py-1 text-center" title={`${m.name} — selected channel`}>
              <div className="text-[9px] uppercase tracking-wider text-slate-500">{m.name}</div>
              <div className="font-mono text-[10px] text-slate-100">{m.value.toFixed(3)}<span className="text-slate-500"> V</span></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tiny keyboard-accessible toolbar button used by the scope controls. */
function ToolBtn({ children, label, onClick, disabled, active }: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none transition-colors ${
        active
          ? 'border-amber-500/50 bg-amber-500/20 text-amber-300'
          : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

/** Math-channel definition row: pick A (op) B and manage existing math traces. */
function MathChannelRow({ traces, realTraceCount, mathChannels, setMathChannels }: {
  traces: ProbeTrace[];
  realTraceCount: number;
  mathChannels: MathChannelDef[];
  setMathChannels: React.Dispatch<React.SetStateAction<MathChannelDef[]>>;
}) {
  const [aIdx, setAIdx] = useState(0);
  const [bIdx, setBIdx] = useState(Math.min(1, Math.max(0, realTraceCount - 1)));
  const [op, setOp] = useState<MathOp>('add');

  const canAdd = realTraceCount >= 2;
  const addMath = () => {
    if (!canAdd) return;
    if (aIdx === bIdx) return; // A op A is pointless — guard it
    const id = `math_${Date.now().toString(36)}`;
    setMathChannels((prev) => [...prev, { id, op, aIdx, bIdx, visible: true }]);
  };
  const clampIdx = (v: number) => Math.min(Math.max(0, v), Math.max(0, realTraceCount - 1));

  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
        <Sigma size={10} /> Math
      </span>
      <select
        value={clampIdx(aIdx)}
        onChange={(e) => setAIdx(parseInt(e.target.value, 10))}
        disabled={!canAdd}
        aria-label="Math channel source A"
        className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-[10px] text-slate-200 disabled:opacity-40"
      >
        {traces.slice(0, realTraceCount).map((t, i) => (
          <option key={t.componentId} value={i}>{t.label}</option>
        ))}
      </select>
      <select
        value={op}
        onChange={(e) => setOp(e.target.value as MathOp)}
        aria-label="Math operation"
        className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-[10px] text-slate-200"
      >
        <option value="add">+</option>
        <option value="sub">−</option>
        <option value="mul">×</option>
      </select>
      <select
        value={clampIdx(bIdx)}
        onChange={(e) => setBIdx(parseInt(e.target.value, 10))}
        disabled={!canAdd}
        aria-label="Math channel source B"
        className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-[10px] text-slate-200 disabled:opacity-40"
      >
        {traces.slice(0, realTraceCount).map((t, i) => (
          <option key={t.componentId} value={i}>{t.label}</option>
        ))}
      </select>
      <ToolBtn
        label={canAdd ? 'Add math channel A op B' : 'Needs two scope channels'}
        onClick={addMath}
        disabled={!canAdd || aIdx === bIdx}
      >
        + Add
      </ToolBtn>
      {mathChannels.map((def) => {
        const a = traces[def.aIdx];
        const b = traces[def.bIdx];
        const live = a && b;
        return (
          <span
            key={def.id}
            className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
              def.visible && live
                ? 'border-pink-500/50 bg-pink-500/10 text-pink-300'
                : 'border-slate-700 bg-slate-800/60 text-slate-500'
            }`}
            title={live ? `Math trace ${mathLabel(def, a, b)}` : 'Source trace removed — dormant'}
          >
            {live ? mathLabel(def, a, b) : `${def.op} (dormant)`}
            <button
              type="button"
              aria-label={def.visible ? 'Hide math channel' : 'Show math channel'}
              onClick={() => setMathChannels((prev) => prev.map((d) => d.id === def.id ? { ...d, visible: !d.visible } : d))}
              className="cursor-pointer text-slate-500 hover:text-slate-200"
            >
              {def.visible ? '◉' : '○'}
            </button>
            <button
              type="button"
              aria-label="Remove math channel"
              onClick={() => setMathChannels((prev) => prev.filter((d) => d.id !== def.id))}
              className="cursor-pointer text-slate-500 hover:text-rose-400"
            >
              <X size={9} />
            </button>
          </span>
        );
      })}
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
  const [fftWindow, setFftWindow] = useState<'hann' | 'rect' | 'hamming' | 'blackman' | 'kaiser'>('hann');

  // Pick the active trace
  const traceIdx = Math.min(selectedTrace, Math.max(0, traces.length - 1));
  const trace = traces[traceIdx];

  // Build a RealTrace suitable for computeFFT/computeTHD
  const realTrace = useMemo(() => trace && trace.samples.length >= 8 ? {
    name: trace.label,
    xValues: Float64Array.from(trace.samples.map(s => s.time)),
    yValues: Float64Array.from(trace.samples.map(s => s.voltage)),
    xLabel: 'Time (s)',
    yLabel: 'Voltage (V)',
  } : null, [trace]);

  const thdResult: THDResult | null = useMemo(
    () => realTrace ? computeTHD(realTrace, maxHarmonics) : null,
    [realTrace, maxHarmonics],
  );

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
    const fullSpectrum = computeFFT(realTrace, fftWindow);
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
  }, [thdResult, realTrace, traces.length, canvasRef, fftWindow]);

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
          <label className="flex items-center gap-1 text-[10px] text-slate-400" title="FFT window function">
            Win
            <select
              value={fftWindow}
              onChange={(e) => setFftWindow(e.target.value as typeof fftWindow)}
              className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-xs text-slate-200"
            >
              <option value="hann">Hann</option>
              <option value="rect">Rect</option>
              <option value="hamming">Hamming</option>
              <option value="blackman">Blackman</option>
              <option value="kaiser">Kaiser</option>
            </select>
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
