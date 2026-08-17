'use client';

// Simulation status bar — shows node count, FPS, solver iterations, speed.
// Rendered at the bottom of the schematic canvas area.

import { useEditor } from '@/lib/circuit/store';
import { useEffect, useRef, useState } from 'react';
import { Cpu, Zap, Clock, Activity } from 'lucide-react';

export function SimStatusBar() {
  const running = useEditor((s) => s.running);
  const speed = useEditor((s) => s.speed);
  const simContext = useEditor((s) => s.simContext);
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(performance.now());

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      frameCountRef.current++;
      const now = performance.now();
      if (now - lastFpsTimeRef.current >= 1000) {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
        lastFpsTimeRef.current = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const nodeCount = simContext?.nodeVoltage?.length ?? 0;
  const branchCount = simContext?.branchCurrent?.length ?? 0;
  const simTime = simContext?.time ?? 0;

  return (
    <div className="flex items-center gap-4 border-t border-slate-800 bg-slate-900 px-3 py-1 text-[10px] font-mono text-slate-500">
      <span className="flex items-center gap-1">
        <Cpu size={10} className={running ? 'text-cyan-400' : 'text-slate-600'} />
        {components.length} comp
      </span>
      <span className="flex items-center gap-1">
        <Activity size={10} className="text-slate-600" />
        {wires.length} wire
      </span>
      <span className="flex items-center gap-1">
        <Zap size={10} className={running ? 'text-amber-400' : 'text-slate-600'} />
        {nodeCount} nodes · {branchCount} branches
      </span>
      <span className="flex items-center gap-1">
        <Clock size={10} />
        t={simTime >= 1 ? `${simTime.toFixed(3)}s` : `${(simTime * 1000).toFixed(1)}ms`}
      </span>
      <span>{running ? `${speed}× speed` : 'paused'}</span>
      <span className={fps > 30 ? 'text-emerald-400' : fps > 15 ? 'text-amber-400' : 'text-rose-400'}>
        {fps} fps
      </span>
    </div>
  );
}
