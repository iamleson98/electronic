'use client';

// Simulation status bar — shows node count, FPS, solver iterations, speed.
// Rendered at the bottom of the schematic canvas area.
// Also hosts the circuit-sound toggle (buzzers/speakers WebAudio).

import { useEditor } from '@/lib/circuit/store';
import { circuitAudio } from '@/lib/circuit/audio';
import { useEffect, useRef, useState } from 'react';
import { Cpu, Zap, Clock, Activity, Volume2, VolumeX } from 'lucide-react';

export function SimStatusBar() {
  const running = useEditor((s) => s.running);
  const speed = useEditor((s) => s.speed);
  const simContext = useEditor((s) => s.simContext);
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const [fps, setFps] = useState(0);
  // Read the persisted sound preference lazily (one read; the value only
  // changes through the toggle handler).
  const [soundOn, setSoundOn] = useState(() => circuitAudio.isEnabled());
  const frameCountRef = useRef(0);
  // Initialize lazily inside useEffect to avoid calling performance.now()
  // during render (which is an impure function call).
  const lastFpsTimeRef = useRef(0);

  const toggleSound = async () => {
    // setEnabled must run inside this click handler (user gesture) so the
    // AudioContext is allowed to start.
    const ok = await circuitAudio.setEnabled(!soundOn);
    if (ok) {
      setSoundOn(!soundOn);
    } else {
      // Could not start audio (unsupported/blocked) — revert the toggle.
      setSoundOn(circuitAudio.isEnabled());
    }
  };

  useEffect(() => {
    // Initialize the FPS timer inside the effect (avoids calling
    // performance.now() during render).
    lastFpsTimeRef.current = performance.now();
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
    <div className="flex items-center gap-4 border-t border-slate-800 bg-slate-900 px-3 py-1 text-[10px] font-mono text-slate-500" role="status" aria-label="Simulation status">
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
      <button
        onClick={toggleSound}
        aria-pressed={soundOn}
        title={soundOn ? 'Mute buzzer/speaker sounds' : 'Enable buzzer/speaker sounds'}
        className={`ml-auto flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
          soundOn ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
        }`}
      >
        {soundOn ? <Volume2 size={10} /> : <VolumeX size={10} />}
        {soundOn ? 'sound on' : 'sound off'}
      </button>
    </div>
  );
}
