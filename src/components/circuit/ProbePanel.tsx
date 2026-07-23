'use client';

import { useEffect, useRef } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin } from '@/lib/circuit/registry';
import { getTerminalsForComponent, buildNodeMap } from '@/lib/circuit/engine';
import { Activity, BarChart3, AlertCircle } from 'lucide-react';

export function ProbePanel() {
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const simContext = useEditor((s) => s.simContext);
  const traces = useEditor((s) => s.traces);
  const running = useEditor((s) => s.running);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
          measurements.push({
            componentId: comp.id,
            name: plugin.name,
            symbol: plugin.symbol,
            items: m,
          });
        }
      } catch (err) {
        console.error(`measure error in ${comp.type} (${comp.id}):`, err);
      }
    }
  }

  // draw traces on canvas
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

    // background
    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(0, 0, rect.width, rect.height);

    // grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < rect.width; x += 30) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rect.height);
    }
    for (let y = 0; y < rect.height; y += 24) {
      ctx.moveTo(0, y);
      ctx.lineTo(rect.width, y);
    }
    ctx.stroke();
    // center line
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

    // draw each trace
    const padding = 8;
    for (const trace of traces) {
      if (trace.samples.length < 2) continue;
      const samples = trace.samples;
      const tMin = samples[0].time;
      const tMax = samples[samples.length - 1].time;
      const tRange = Math.max(1e-6, tMax - tMin);
      // compute V range from data
      let vMin = Infinity, vMax = -Infinity;
      for (const s of samples) {
        if (s.voltage < vMin) vMin = s.voltage;
        if (s.voltage > vMax) vMax = s.voltage;
      }
      const vPad = Math.max(0.5, (vMax - vMin) * 0.15);
      vMin -= vPad;
      vMax += vPad;
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
      // label
      ctx.fillStyle = trace.color;
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(trace.label, padding + 4, padding + 4);
    }
    ctx.restore();
  }, [traces, simContext]);

  const hasCircuit = components.length > 0;
  const hasGround = components.some((c) => c.type === 'ground');
  const hasSource = components.some((c) => ['dcVoltage', 'acVoltage', 'pulseSource', 'currentSource', 'arduino', 'raspberryPi'].includes(c.type));

  return (
    <div className="flex h-full flex-col bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-cyan-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Probe & Oscilloscope</span>
        </div>
        {simContext && (
          <span className="font-mono text-[10px] text-slate-500">
            t = {simContext.time >= 1 ? `${simContext.time.toFixed(3)}s` : `${(simContext.time * 1000).toFixed(2)}ms`}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Oscilloscope */}
        <div className="border-b border-slate-800 p-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <BarChart3 size={10} className="mr-1 inline" />
              Waveform
            </span>
            <span className="text-[10px] text-slate-500">{traces.length} channel{traces.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="h-32 rounded-md border border-slate-800 bg-[#0a0f1c]">
            <canvas ref={canvasRef} className="h-full w-full" />
          </div>
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
                  <div
                    key={m.componentId}
                    className="rounded-md border border-slate-800 bg-slate-800/40 p-2"
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-950 text-[10px] font-bold text-cyan-300">
                        {m.symbol}
                      </span>
                      <span className="truncate text-[11px] font-medium text-slate-300">{m.name}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {m.items.map((it, i) => (
                        <div key={i} className="rounded bg-slate-950/60 px-1 py-1 text-center">
                          <div className="text-[9px] uppercase tracking-wider text-slate-500">{it.label}</div>
                          <div className="font-mono text-[11px] text-slate-100">
                            {it.value}<span className="text-slate-500">{it.unit}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
