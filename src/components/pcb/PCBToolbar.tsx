'use client';

import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Download, MousePointer2, Route, Plus, RotateCw, Trash2, Grid3x3, Eye, Zap } from 'lucide-react';
import { toast } from 'sonner';

export function PCBToolbar() {
  const tool = usePCB((s) => s.tool);
  const setTool = usePCB((s) => s.setTool);
  const activeLayer = usePCB((s) => s.activeLayer);
  const setActiveLayer = usePCB((s) => s.setActiveLayer);
  const defaultTraceWidth = usePCB((s) => s.defaultTraceWidth);
  const setDefaultTraceWidth = usePCB((s) => s.setDefaultTraceWidth);
  const showRatsnest = usePCB((s) => s.showRatsnest);
  const toggleRatsnest = usePCB((s) => s.toggleRatsnest);
  const showGrid = usePCB((s) => s.showGrid);
  const toggleGrid = usePCB((s) => s.toggleGrid);
  const showPadNets = usePCB((s) => s.showPadNets);
  const togglePadNets = usePCB((s) => s.togglePadNets);
  const selectedFootprintId = usePCB((s) => s.selectedFootprintId);
  const selectedTraceId = usePCB((s) => s.selectedTraceId);
  const rotateFootprint = usePCB((s) => s.rotateFootprint);
  const importFromSchematic = usePCB((s) => s.importFromSchematic);
  const serialize = usePCB((s) => s.serialize);
  const clearPCB = usePCB((s) => s.clearPCB);
  const cancelRouting = usePCB((s) => s.cancelRouting);

  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);

  const handleImport = () => {
    if (components.length === 0) {
      toast.error('No schematic components to import');
      return;
    }
    importFromSchematic(components, wires);
    toast.success(`Imported ${components.length} components from schematic`);
  };

  const handleExport = () => {
    const doc = serialize();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pcb_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('PCB layout exported');
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-900 px-3 py-2">
        {/* Brand */}
        <div className="mr-2 flex items-center gap-2 pr-3">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-emerald-500 to-cyan-600 text-white">
            <Zap size={16} strokeWidth={2.5} />
          </div>
          <span className="hidden text-sm font-semibold text-slate-100 sm:inline">PCB Layout</span>
        </div>

        {/* Import from schematic */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" className="bg-emerald-500 text-slate-900 hover:bg-emerald-400" onClick={handleImport}>
              <Zap size={14} className="mr-1" />
              <span className="hidden md:inline">Import Schematic</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import components & netlist from the schematic</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* Tools */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={tool === 'select' ? 'default' : 'ghost'} onClick={() => setTool('select')}>
              <MousePointer2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Select/Move (1)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={tool === 'route' ? 'default' : 'ghost'} onClick={() => setTool('route')}>
              <Route size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Route Trace (2)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={tool === 'via' ? 'default' : 'ghost'} onClick={() => setTool('via')}>
              <Plus size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add Via (3)</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* Layer selector */}
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={activeLayer === 'top' ? 'default' : 'ghost'}
            className={activeLayer === 'top' ? 'bg-red-600 text-white hover:bg-red-500' : ''}
            onClick={() => setActiveLayer('top')}
          >
            Top
          </Button>
          <Button
            size="sm"
            variant={activeLayer === 'bottom' ? 'default' : 'ghost'}
            className={activeLayer === 'bottom' ? 'bg-blue-600 text-white hover:bg-blue-500' : ''}
            onClick={() => setActiveLayer('bottom')}
          >
            Bottom
          </Button>
        </div>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* Trace width */}
        <div className="flex items-center gap-2 px-1">
          <span className="hidden text-xs text-slate-400 lg:inline">Width</span>
          <Slider
            value={[defaultTraceWidth * 10]}
            min={2}
            max={30}
            step={1}
            onValueChange={(v) => setDefaultTraceWidth(v[0] / 10)}
            className="w-20"
          />
          <span className="w-10 text-right font-mono text-xs text-slate-300">{defaultTraceWidth.toFixed(1)}mm</span>
        </div>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* Rotate / Delete */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => selectedFootprintId && rotateFootprint(selectedFootprintId)} disabled={!selectedFootprintId}>
              <RotateCw size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Rotate Footprint (R)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-400 hover:text-rose-300"
              onClick={() => {
                if (selectedTraceId) usePCB.getState().deleteTrace(selectedTraceId);
                else if (confirm('Clear entire PCB?')) clearPCB();
              }}
            >
              <Trash2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete trace / Clear PCB</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* View toggles */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={showRatsnest ? 'default' : 'ghost'} onClick={toggleRatsnest}>
              <Eye size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Ratsnest</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={showGrid ? 'default' : 'ghost'} onClick={toggleGrid}>
              <Grid3x3 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Grid</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={showPadNets ? 'default' : 'ghost'} onClick={togglePadNets}>
              <Label size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Net Names on Pads</TooltipContent>
        </Tooltip>

        <div className="ml-auto flex items-center gap-1">
          {/* Export */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={handleExport}>
                <Download size={14} />
                <span className="ml-1 hidden md:inline">Export</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export PCB as JSON</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
