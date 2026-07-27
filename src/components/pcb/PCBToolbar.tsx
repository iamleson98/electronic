'use client';

import { useRef } from 'react';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Download, MousePointer2, Route, Plus, RotateCw, Trash2, Grid3x3, Eye, Zap,
  ShieldCheck, Layers, FileDown, Wand2, GitCompare, Upload,
} from 'lucide-react';
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
  const runDRC = usePCB((s) => s.runDRC);
  const clearDRC = usePCB((s) => s.clearDRC);
  const drcErrors = usePCB((s) => s.drcErrors);
  const addCopperPour = usePCB((s) => s.addCopperPour);
  const removeCopperPour = usePCB((s) => s.removeCopperPour);
  const copperPours = usePCB((s) => s.copperPours);
  const exportGerbers = usePCB((s) => s.exportGerbers);
  const runAutoRoute = usePCB((s) => s.runAutoRoute);
  const runNetlistVerify = usePCB((s) => s.runNetlistVerify);

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

  const handleExportJSON = () => {
    const doc = serialize();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pcb_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('PCB layout exported as JSON');
  };

  const handleDRC = () => {
    runDRC();
    const errors = usePCB.getState().drcErrors;
    const errorCount = errors.filter((e) => e.severity === 'error').length;
    const warnCount = errors.filter((e) => e.severity === 'warning').length;
    if (errorCount === 0 && warnCount === 0) {
      toast.success('DRC passed — no errors found');
    } else {
      toast.warning(`DRC: ${errorCount} error(s), ${warnCount} warning(s)`);
    }
  };

  const kicadFileInputRef = useRef<HTMLInputElement | null>(null);
  const handleKiCadImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const content = reader.result as string;
        const { importKiCadFootprint, importKiCadFootprintsFromFile } = require('@/lib/pcb/kicad-import');
        const { footprintDefs } = require('@/lib/pcb/footprints');
        if (file.name.endsWith('.kicad_mod')) {
          const def = importKiCadFootprint(content);
          if (def) {
            footprintDefs[`kicad_${file.name.replace('.kicad_mod', '')}`] = def;
            toast.success(`Imported KiCad footprint: ${file.name}`);
          } else {
            toast.error('Failed to parse KiCad footprint');
          }
        } else if (file.name.endsWith('.kicad_pcb')) {
          const footprints = importKiCadFootprintsFromFile(content);
          for (const fp of footprints) {
            footprintDefs[`kicad_${fp.name}`] = fp.def;
          }
          toast.success(`Imported ${footprints.length} footprints from KiCad PCB`);
        } else {
          toast.error('Please select a .kicad_mod or .kicad_pcb file');
        }
      } catch (err) {
        toast.error('Import failed: ' + (err as Error).message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleGerberExport = () => {
    exportGerbers();
    toast.success('Gerber + drill + PnP files exported');
  };

  const handleAutoRoute = () => {
    if (usePCB.getState().footprints.length === 0) {
      toast.error('No footprints to route');
      return;
    }
    runAutoRoute();
    const state = usePCB.getState();
    const autoRouteCount = state.traces.filter(t => t.id.startsWith('auto_')).length;
    toast.success(`Auto-route complete: ${autoRouteCount} traces added`);
  };

  const handleNetlistVerify = () => {
    const result = runNetlistVerify();
    if (!result) {
      toast.error('Could not verify netlist — no schematic loaded');
      return;
    }
    if (result.ok && result.errors.length === 0) {
      toast.success(`Netlist verified: ${result.stats.matchedNets}/${result.stats.schematicNets} nets match`);
    } else {
      const errors = result.errors.filter((e) => e.severity === 'error').length;
      const warnings = result.errors.filter((e) => e.severity === 'warning').length;
      toast.warning(`Netlist: ${errors} error(s), ${warnings} warning(s)`);
    }
  };

  const handleCopperPour = () => {
    const hasPour = copperPours.some((p) => p.layer === activeLayer);
    if (hasPour) {
      removeCopperPour(activeLayer);
      toast.info(`Copper pour removed from ${activeLayer} layer`);
    } else {
      addCopperPour(activeLayer, 'GND');
      toast.success(`GND copper pour added to ${activeLayer} layer`);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-900 px-3 py-2 flex-wrap">
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
              <span className="hidden md:inline">Import</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import components & netlist from the schematic</TooltipContent>
        </Tooltip>

        {/* KiCad footprint/PCB import */}
        <input
          ref={kicadFileInputRef}
          type="file"
          accept=".kicad_mod,.kicad_pcb"
          onChange={handleKiCadImport}
          className="hidden"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => kicadFileInputRef.current?.click()}>
              <Upload size={14} />
              <span className="ml-1 hidden md:inline">KiCad</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import KiCad .kicad_mod or .kicad_pcb file</TooltipContent>
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
          <Button size="sm" variant={activeLayer === 'top' ? 'default' : 'ghost'}
            className={activeLayer === 'top' ? 'bg-red-600 text-white hover:bg-red-500' : ''}
            onClick={() => setActiveLayer('top')}>Top</Button>
          <Button size="sm" variant={activeLayer === 'bottom' ? 'default' : 'ghost'}
            className={activeLayer === 'bottom' ? 'bg-blue-600 text-white hover:bg-blue-500' : ''}
            onClick={() => setActiveLayer('bottom')}>Bot</Button>
        </div>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* Trace width */}
        <div className="flex items-center gap-2 px-1">
          <span className="hidden text-xs text-slate-400 lg:inline">Width</span>
          <Slider value={[defaultTraceWidth * 10]} min={2} max={30} step={1}
            onValueChange={(v) => setDefaultTraceWidth(v[0] / 10)} className="w-20" />
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
            <Button size="sm" variant="ghost" className="text-rose-400 hover:text-rose-300"
              onClick={() => { if (selectedTraceId) usePCB.getState().deleteTrace(selectedTraceId); }}>
              <Trash2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete selected trace</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px bg-slate-700" />

        {/* DRC */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={handleDRC} className={drcErrors.length > 0 ? 'text-amber-400' : ''}>
              <ShieldCheck size={14} />
              {drcErrors.length > 0 && <span className="ml-1 text-xs">{drcErrors.length}</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Run DRC (Design Rule Check)</TooltipContent>
        </Tooltip>

        {/* Copper pour */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={copperPours.some((p) => p.layer === activeLayer) ? 'default' : 'ghost'} onClick={handleCopperPour}>
              <Layers size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle GND copper pour on {activeLayer} layer</TooltipContent>
        </Tooltip>

        {/* Auto-route */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={handleAutoRoute} className="text-purple-400 hover:text-purple-300">
              <Wand2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Auto-route all unrouted nets (Lee's algorithm)</TooltipContent>
        </Tooltip>

        {/* Netlist verify */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={handleNetlistVerify} className="text-cyan-400 hover:text-cyan-300">
              <GitCompare size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Verify PCB netlist matches schematic</TooltipContent>
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

        <div className="ml-auto flex items-center gap-1">
          {/* Export JSON */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={handleExportJSON}>
                <Download size={14} />
                <span className="ml-1 hidden md:inline">JSON</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export PCB as JSON</TooltipContent>
          </Tooltip>
          {/* Export Gerbers */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" className="bg-amber-500 text-slate-900 hover:bg-amber-400" onClick={handleGerberExport}>
                <FileDown size={14} />
                <span className="ml-1 hidden md:inline">Gerbers</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export Gerber + Drill + PnP files</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
