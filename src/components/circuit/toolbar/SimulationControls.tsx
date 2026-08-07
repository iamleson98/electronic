// Simulation controls — extracted from Toolbar.tsx.
// Contains Run/Pause, Step, Reset, Speed slider, dt slider.

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Play, Pause, SkipForward, RotateCcw } from 'lucide-react';

export function SimulationControls({
  running,
  speed,
  dt,
  setRunning,
  setSpeed,
  setDt,
  step,
  reset,
}: {
  running: boolean;
  speed: number;
  dt: number;
  setRunning: (r: boolean) => void;
  setSpeed: (s: number) => void;
  setDt: (d: number) => void;
  step: () => void;
  reset: () => void;
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" onClick={() => setRunning(!running)}>
            {running ? <Pause size={14} /> : <Play size={14} />}
            <span className="ml-1 hidden sm:inline">{running ? 'Pause' : 'Run'}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{running ? 'Pause simulation (Space)' : 'Run simulation (Space)'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" onClick={step} disabled={running}>
            <SkipForward size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Single step</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" onClick={reset} disabled={running}>
            <RotateCcw size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reset simulation (stops + clears state)</TooltipContent>
      </Tooltip>

      <div className="mx-1 h-5 w-px bg-slate-700" />

      {/* Speed control */}
      <div className="flex items-center gap-2 px-1">
        <span className="hidden text-xs text-slate-400 lg:inline">Speed</span>
        <Slider
          value={[Math.log2(speed)]}
          min={-2}
          max={6}
          step={0.5}
          onValueChange={(v) => setSpeed(Math.pow(2, v[0]))}
          className="w-28"
        />
        <span className="w-12 text-right font-mono text-xs text-slate-300">{speed.toFixed(1)}x</span>
      </div>

      {/* Timestep control */}
      <div className="flex items-center gap-2 px-1">
        <span className="hidden text-xs text-slate-400 lg:inline">dt</span>
        <Slider
          value={[Math.log10(dt)]}
          min={-7}
          max={-2}
          step={0.5}
          onValueChange={(v) => setDt(Math.pow(10, v[0]))}
          className="w-24"
        />
        <span className="w-16 text-right font-mono text-xs text-slate-300">
          {dt >= 1e-3 ? `${(dt * 1e3).toFixed(1)}ms` : `${(dt * 1e6).toFixed(1)}µs`}
        </span>
      </div>
    </>
  );
}
