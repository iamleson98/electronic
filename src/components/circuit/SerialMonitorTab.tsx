'use client';

// ─── Serial Monitor + Serial Plotter tab ─────────────────────────────────────
// The MCU serial console, Tinkercad-style. The arduinoReal plugin writes
// print/println/plot output into the persistent sim-state map
// (`arduinoReal_<id>_serial`); this tab renders it live:
//  - Monitor: scrolling console of completed lines (+ the pending partial
//    line), auto-follow unless the user scrolls up, clear + download.
//  - Plotter: multi-series line chart of `plot <label> <pin>` points with
//    auto-scaling axes — like the Arduino IDE's Serial Plotter.

import { useState, useEffect, useRef, useMemo } from 'react';
import { useEditor } from '@/lib/circuit/store';
import type { SerialState } from '@/lib/circuit/components/arduino-real';
import { SERIAL_MAX_LINES } from '@/lib/circuit/components/arduino-real';
import { Terminal, Trash2, Download, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PLOT_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#a855f7', '#34d399', '#fb7185', '#60a5fa'];

function serialKeyFor(compId: string): string {
  return `arduinoReal_${compId}_serial`;
}

export function SerialMonitorTab() {
  const components = useEditor((s) => s.components);
  const simContext = useEditor((s) => s.simContext);
  const running = useEditor((s) => s.running);

  // Programmable MCUs that emit serial output (arduinoReal today)
  const mcus = useMemo(
    () => components.filter((c) => c.type === 'arduinoReal'),
    [components],
  );
  const [selectedMcu, setSelectedMcu] = useState('');
  const activeMcu = mcus.find((c) => c.id === selectedMcu) ?? mcus[0] ?? null;
  const clearSerialMonitor = useEditor((s) => s.clearSerialMonitor);

  const serial = activeMcu
    ? (simContext?.state?.[serialKeyFor(activeMcu.id)] as SerialState | undefined)
    : undefined;

  const logRef = useRef<HTMLDivElement | null>(null);
  const plotCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const followRef = useRef(true);

  // Auto-scroll the monitor when new lines arrive (only if already at the
  // bottom — scrolling up pins the view).
  const version = serial?.version ?? 0;
  const lineCount = serial?.lines.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [version, lineCount]);

  const handleScroll = () => {
    const el = logRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const handleClear = () => {
    if (!activeMcu) return;
    clearSerialMonitor(activeMcu.id);
  };

  const handleDownload = () => {
    if (!serial || serial.lines.length === 0) return;
    const text = serial.lines.map((l) => l.text).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `serial-log-${activeMcu?.refdes ?? activeMcu?.id ?? 'mcu'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Plotter drawing ────────────────────────────────────────────────────
  const plotVersion = serial?.version ?? 0;
  useEffect(() => {
    const canvas = plotCanvasRef.current;
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
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(0, 0, W, H);

    const seriesEntries = serial ? Object.entries(serial.plots).filter(([, s]) => s.points.length > 1) : [];
    if (!serial || seriesEntries.length === 0) {
      ctx.fillStyle = '#475569';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        serial
          ? 'Use "plot <pin>" or "plot <label> <pin>" in the sketch to stream values here'
          : 'Run the simulation to see serial output',
        W / 2,
        H / 2,
      );
      ctx.restore();
      return;
    }

    // Time window: the last 30 s of sim time (or the full span if shorter)
    let tMax = -Infinity;
    for (const [, s] of seriesEntries) {
      const last = s.points[s.points.length - 1].t;
      if (last > tMax) tMax = last;
    }
    const tMin = Math.max(0, tMax - 30);
    // Auto-scale Y over the visible window
    let vMin = Infinity;
    let vMax = -Infinity;
    const visible = seriesEntries.map(([name, s]) => ({
      name,
      color: PLOT_COLORS[0],
      pts: s.points.filter((p) => p.t >= tMin),
    }));
    visible.forEach((v) => {
      v.pts.forEach((p) => {
        if (p.v < vMin) vMin = p.v;
        if (p.v > vMax) vMax = p.v;
      });
    });
    if (!isFinite(vMin) || !isFinite(vMax)) { vMin = 0; vMax = 1; }
    if (vMax - vMin < 1e-9) { vMax = vMin + 1; }
    const pad = (vMax - vMin) * 0.08;
    vMin -= pad;
    vMax += pad;

    // grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 6; i++) {
      const x = (i / 6) * W;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let j = 1; j < 4; j++) {
      const y = (j / 4) * H;
      ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    ctx.stroke();
    // zero line (if in range)
    if (vMin < 0 && vMax > 0) {
      const y0 = H - ((0 - vMin) / (vMax - vMin)) * H;
      ctx.strokeStyle = '#334155';
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(W, y0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // series
    const mapX = (t: number) => ((t - tMin) / Math.max(1e-9, tMax - tMin)) * W;
    const mapY = (v: number) => H - ((v - vMin) / (vMax - vMin)) * H;
    seriesEntries.forEach((entry, idx) => {
      const color = PLOT_COLORS[idx % PLOT_COLORS.length];
      const pts = entry[1].points.filter((p) => p.t >= tMin);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = mapX(pts[i].t);
        const y = mapY(pts[i].v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    // axis labels + legend
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#64748b';
    ctx.fillText(`${formatT(tMin)}`, 4, H - 12);
    ctx.textAlign = 'right';
    ctx.fillText(`${formatT(tMax)}`, W - 4, H - 12);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let lx = 4;
    seriesEntries.forEach((entry, idx) => {
      const color = PLOT_COLORS[idx % PLOT_COLORS.length];
      const last = entry[1].points[entry[1].points.length - 1];
      const label = `${entry[0]}=${last.v.toFixed(2)}`;
      ctx.fillStyle = color;
      ctx.fillRect(lx, 4, 8, 8);
      ctx.fillStyle = color;
      ctx.fillText(label, lx + 12, 4);
      lx += 14 + ctx.measureText(label).width + 10;
    });
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${vMin.toFixed(2)} … ${vMax.toFixed(2)}`, W - 4, H - 14);

    ctx.restore();
  }, [plotVersion, serial]);

  // ── Render ─────────────────────────────────────────────────────────────
  if (mcus.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Cpu size={24} className="text-slate-600" />
        <p className="text-xs text-slate-400">
          Place an <span className="font-medium text-slate-200">Arduino (programmable)</span> component to use the Serial Monitor.
        </p>
        <p className="max-w-md text-[11px] leading-relaxed text-slate-500">
          Write <span className="font-mono text-cyan-400">print "text" A0</span> / <span className="font-mono text-cyan-400">println</span> statements for the
          monitor and <span className="font-mono text-cyan-400">plot A0</span> for the plotter in the Arduino&apos;s sketch.
        </p>
      </div>
    );
  }

  const lines = serial?.lines ?? [];
  const pending = serial?.pending ?? '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: MCU selector + controls */}
      <div className="flex items-center gap-2 border-b border-slate-800 p-2">
        <Terminal size={12} className="text-cyan-400" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Serial</span>
        {mcus.length > 1 ? (
          <select
            value={activeMcu?.id ?? ''}
            onChange={(e) => setSelectedMcu(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200"
            aria-label="Serial source"
          >
            {mcus.map((c) => (
              <option key={c.id} value={c.id}>{c.refdes ?? c.id} (Arduino)</option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-[10px] text-slate-400">{activeMcu?.refdes ?? activeMcu?.id}</span>
        )}
        <span className={`font-mono text-[10px] ${running ? 'text-emerald-400' : 'text-slate-500'}`}>
          {running ? '● running' : '○ paused'}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 cursor-pointer px-2 text-[10px] text-slate-400 hover:text-slate-200"
            onClick={handleDownload}
            disabled={lines.length === 0}
            title="Download the serial log as a .txt file"
          >
            <Download size={11} className="mr-1" /> Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 cursor-pointer px-2 text-[10px] text-slate-400 hover:text-slate-200"
            onClick={handleClear}
            disabled={lines.length === 0 && !pending}
            title="Clear the serial monitor and plotter"
          >
            <Trash2 size={11} className="mr-1" /> Clear
          </Button>
        </span>
      </div>

      {/* Monitor console */}
      <div
        ref={logRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto border-b border-slate-800 bg-[#0a0f1c] p-2 font-mono text-[11px] leading-relaxed"
        aria-label="Serial monitor output"
        aria-live="polite"
      >
        {lines.length === 0 && !pending ? (
          <div className="py-6 text-center text-slate-500">
            {running ? 'Waiting for serial output… add print/println to the sketch' : 'Run the simulation to start the sketch'}
          </div>
        ) : (
          <>
            {lines.slice(-200).map((l, i) => (
              <div key={`${l.t}-${i}`} className="whitespace-pre-wrap break-all">
                <span className="mr-2 text-slate-600">{formatT(l.t)}</span>
                <span className="text-slate-200">{l.text}</span>
              </div>
            ))}
            {pending && (
              <div className="whitespace-pre-wrap break-all">
                <span className="mr-2 text-slate-600">{formatT(serial?.pendingT ?? 0)}</span>
                <span className="text-cyan-300">{pending}</span>
                <span className="animate-pulse text-cyan-400">▌</span>
              </div>
            )}
          </>
        )}
        {lines.length >= SERIAL_MAX_LINES && (
          <div className="mt-1 text-center text-[10px] text-slate-600">
            (buffer holds the last {SERIAL_MAX_LINES} lines)
          </div>
        )}
      </div>

      {/* Plotter */}
      <div className="p-2">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Serial Plotter</div>
        <div className="relative h-40 rounded-md border border-slate-800 bg-[#0a0f1c]">
          <canvas ref={plotCanvasRef} className="h-full w-full" aria-label="Serial plotter chart" />
        </div>
      </div>
    </div>
  );
}

function formatT(t: number): string {
  if (t >= 1) return `[${t.toFixed(2)}s]`;
  return `[${(t * 1000).toFixed(0)}ms]`;
}
