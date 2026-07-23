'use client';

import { useCallback, useRef, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { examples } from '@/lib/circuit/examples';
import {
  Play,
  Pause,
  SkipForward,
  Save,
  Upload,
  Trash2,
  Undo2,
  Redo2,
  Square,
  Gauge,
  Zap,
  FileText,
  ChevronDown,
  Settings2,
  Database,
  FileCode,
  Boxes,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { MyCircuitsDialog } from './MyCircuitsDialog';
import { SpiceImportDialog } from './SpiceImportDialog';
import { SubCircuitDialog } from './SubCircuitDialog';

export function Toolbar() {
  const running = useEditor((s) => s.running);
  const speed = useEditor((s) => s.speed);
  const dt = useEditor((s) => s.dt);
  const setRunning = useEditor((s) => s.setRunning);
  const setSpeed = useEditor((s) => s.setSpeed);
  const setDt = useEditor((s) => s.setDt);
  const step = useEditor((s) => s.step);
  const reset = useEditor((s) => s.reset);
  const clear = useEditor((s) => s.clear);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const serialize = useEditor((s) => s.serialize);
  const loadDocument = useEditor((s) => s.loadDocument);
  const showGrid = useEditor((s) => s.showGrid);
  const setShowGrid = useEditor((s) => s.setShowGrid);
  const snapToGrid = useEditor((s) => s.snapToGrid);
  const setSnapToGrid = useEditor((s) => s.setSnapToGrid);
  const past = useEditor((s) => s.past.length);
  const future = useEditor((s) => s.future.length);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showMyCircuits, setShowMyCircuits] = useState(false);
  const [showSpiceImport, setShowSpiceImport] = useState(false);
  const [showSubCircuit, setShowSubCircuit] = useState(false);

  const handleSave = useCallback(() => {
    const doc = serialize();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `circuit_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [serialize]);

  const handleLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = JSON.parse(reader.result as string);
        if (doc.version === 1 && Array.isArray(doc.components) && Array.isArray(doc.wires)) {
          loadDocument(doc);
        } else {
          alert('Invalid circuit file');
        }
      } catch (err) {
        alert('Failed to parse file: ' + (err as Error).message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [loadDocument]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-900 px-3 py-2">
        {/* Brand */}
        <div className="mr-2 flex items-center gap-2 pr-3">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-cyan-400 to-emerald-500 text-slate-900">
            <Zap size={16} strokeWidth={2.5} />
          </div>
          <span className="hidden text-sm font-semibold text-slate-100 sm:inline">CircuitLab</span>
        </div>

        {/* Run / Pause / Step */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant={running ? 'destructive' : 'default'}
              className={running ? '' : 'bg-emerald-500 text-slate-900 hover:bg-emerald-400'}
              onClick={() => setRunning(!running)}
            >
              {running ? <Pause size={14} /> : <Play size={14} />}
              <span className="ml-1 hidden md:inline">{running ? 'Pause' : 'Run'}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause simulation (Space)' : 'Run simulation (Space)'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => step()}>
              <SkipForward size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Single step</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => reset()}>
              <Square size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset time / state</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* Speed control */}
        <div className="flex items-center gap-2 px-1">
          <Gauge size={14} className="text-slate-400" />
          <span className="hidden text-xs text-slate-400 sm:inline">Speed</span>
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

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* Undo / Redo */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => undo()} disabled={past === 0}>
              <Undo2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => redo()} disabled={future === 0}>
              <Redo2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo (Ctrl+Y)</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* Examples */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <FileText size={14} />
              <span className="ml-1 hidden md:inline">Examples</span>
              <ChevronDown size={12} className="ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 bg-slate-900 border-slate-700">
            <DropdownMenuLabel className="text-slate-300">Load Example Circuit</DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-slate-700" />
            {examples.map((ex) => (
              <DropdownMenuItem
                key={ex.name}
                onClick={() => loadDocument(ex.doc)}
                className="flex flex-col items-start gap-1 py-2 text-slate-200 hover:bg-slate-800"
              >
                <span className="text-sm font-medium">{ex.name}</span>
                <span className="text-xs text-slate-400">{ex.description}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Database (My Circuits) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowMyCircuits(true)}>
              <Database size={14} />
              <span className="ml-1 hidden lg:inline">My Circuits</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open the saved circuits library (database)</TooltipContent>
        </Tooltip>

        {/* SPICE Import */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowSpiceImport(true)}>
              <FileCode size={14} />
              <span className="ml-1 hidden lg:inline">SPICE</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import a SPICE netlist (.cir / .net)</TooltipContent>
        </Tooltip>

        {/* Sub-Circuit builder */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowSubCircuit(true)}>
              <Boxes size={14} />
              <span className="ml-1 hidden lg:inline">Sub-Circuit</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Convert current circuit into a reusable component</TooltipContent>
        </Tooltip>

        {/* Settings */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <Settings2 size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 bg-slate-900 border-slate-700">
            <DropdownMenuLabel className="text-slate-300">View Settings</DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-slate-700" />
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <Label htmlFor="grid-switch" className="text-slate-200 text-sm">Show Grid</Label>
              <Switch id="grid-switch" checked={showGrid} onCheckedChange={setShowGrid} />
            </div>
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <Label htmlFor="snap-switch" className="text-slate-200 text-sm">Snap to Grid</Label>
              <Switch id="snap-switch" checked={snapToGrid} onCheckedChange={setSnapToGrid} />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1">
          {/* Save / Load / Clear */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={handleSave}>
                <Save size={14} />
                <span className="ml-1 hidden md:inline">Save</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download circuit as JSON</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
                <Upload size={14} />
                <span className="ml-1 hidden md:inline">Load</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Load circuit from JSON</TooltipContent>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleLoad}
            className="hidden"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (confirm('Clear the entire circuit?')) clear();
                }}
                className="text-rose-400 hover:text-rose-300"
              >
                <Trash2 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear all</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Dialogs */}
      <MyCircuitsDialog open={showMyCircuits} onClose={() => setShowMyCircuits(false)} />
      <SpiceImportDialog open={showSpiceImport} onClose={() => setShowSpiceImport(false)} />
      <SubCircuitDialog open={showSubCircuit} onClose={() => setShowSubCircuit(false)} />
    </TooltipProvider>
  );
}
