'use client';

import { useRef, useState } from 'react';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Download, MousePointer2, Route, Plus, RotateCw, Trash2, Grid3x3, Eye, Zap,
  ShieldCheck, Layers, Layers3, FileDown, Wand2, GitCompare, Upload, GitBranch, Activity,
  ShieldOff, Droplet, AlignLeft, FlipHorizontal, ChevronDown, Frame, CircleDot, SlidersHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { exportBOM, exportIPC2581 } from '@/lib/pcb/additional-exports';
import { exportAllGerbersX2 } from '@/lib/pcb/gerber-export';
import { importKiCadFootprint, importKiCadFootprintsFromFile } from '@/lib/pcb/kicad-import';
import { footprintDefs } from '@/lib/pcb/footprints';
import { FootprintEditorDialog } from './FootprintEditorDialog';
import { LayerStackDialog, DRCSettingsDialog, LengthTuneDialog } from './PCBDialogs';

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
  const runTopoRoute = usePCB((s) => s.runTopoRoute);
  const runNetlistVerify = usePCB((s) => s.runNetlistVerify);

  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);

  const [showFootprintEditor, setShowFootprintEditor] = useState(false);
  const [showLayerStack, setShowLayerStack] = useState(false);
  const [showDRCSettings, setShowDRCSettings] = useState(false);
  const [showLengthTune, setShowLengthTune] = useState(false);

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
    toast.success('Gerber X1 + drill + PnP files exported');
  };

  const handleGerberX2Export = () => {
    const s = usePCB.getState();
    const files = exportAllGerbersX2(s.footprints, s.traces, s.vias, s.board);
    for (const file of files) {
      const blob = new Blob([file.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
    }
    toast.success(`Gerber X2 + drill + PnP exported (${files.length} files)`);
  };

  const handleAutoRoute = () => {
    if (usePCB.getState().footprints.length === 0) {
      toast.error('No footprints to route');
      return;
    }
    // Use the new topological push-and-shove router (A* + 45° + shove + rip-up).
    // Falls back to legacy BFS if it fails completely.
    const stats = runTopoRoute();
    const state = usePCB.getState();
    const topoCount = state.traces.filter(t => t.id.startsWith('topo_')).length;
    if (stats.routed === 0 && topoCount === 0) {
      // Topo router produced nothing — try legacy
      runAutoRoute();
      const legacyCount = usePCB.getState().traces.filter(t => t.id.startsWith('auto_')).length;
      toast.success(`Legacy BFS router: ${legacyCount} traces added`);
    } else {
      toast.success(
        `Topological router: ${stats.routed} routed` +
        (stats.failed ? ` · ${stats.failed} failed` : '') +
        (stats.shoved ? ` · ${stats.shoved} shoved` : '') +
        (stats.rippedUp ? ` · ${stats.rippedUp} ripped` : ''),
      );
    }
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

  const handleLengthTune = () => {
    if (!selectedTraceId) {
      toast.error('Select a trace first, then click Length Tune');
      return;
    }
    setShowLengthTune(true);
  };

  const handleRouteDiffPair = () => {
    // Use the active layer; for demo, route a diff pair on pads R1.1 ↔ R2.1
    // (in a real implementation the user would pick the pads via a tool)
    const footprints = usePCB.getState().footprints;
    if (footprints.length < 2) {
      toast.error('Need at least 2 footprints to route a diff pair');
      return;
    }
    const padA = footprints[0].pads[0];
    const padB = footprints[1].pads[0];
    if (!padA || !padB) {
      toast.error('Could not find pads on the first two footprints');
      return;
    }
    const result = usePCB.getState().routeDiffPair(padA.id, padB.id, `${padA.net ?? 'DATA'}_P`, `${padA.net ?? 'DATA'}_N`);
    if (result.routedP && result.routedN) {
      toast.success('Differential pair routed (P + N traces added)');
    } else {
      toast.error('Diff pair routing failed');
    }
  };

  const handleAddBlindVia = () => {
    // Add a blind via at the center of the selected footprint (or board center)
    const fp = usePCB.getState().footprints.find((f) => f.id === selectedFootprintId);
    const pos = fp ? fp.position : { x: usePCB.getState().board.width / 2, y: usePCB.getState().board.height / 2 };
    usePCB.getState().addTypedVia(pos, 'unrouted', 'blind', 'top', 'inner1');
    toast.success('Blind via added (top → inner1)');
  };

  const handleAddMicroVia = () => {
    const fp = usePCB.getState().footprints.find((f) => f.id === selectedFootprintId);
    const pos = fp ? fp.position : { x: usePCB.getState().board.width / 2, y: usePCB.getState().board.height / 2 };
    usePCB.getState().addTypedVia(pos, 'unrouted', 'micro', 'top', 'inner1');
    toast.success('Microvia added (top → inner1, laser-drilled)');
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

        {/* Footprint editor — opens the WYSIWYG canvas dialog */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowFootprintEditor(true)}>
              <Frame size={14} />
              <span className="ml-1 hidden md:inline">Footprint Editor</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open the WYSIWYG footprint editor</TooltipContent>
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
          <TooltipContent>Route Trace — 90° (2)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={tool === 'route45' ? 'default' : 'ghost'} onClick={() => setTool('route45')}
              className={tool === 'route45' ? 'bg-cyan-600 text-white hover:bg-cyan-500' : ''}>
              <Route size={14} className="rotate-45" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Route Trace — 45° (Shift+2)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={tool === 'via' ? 'default' : 'ghost'} onClick={() => setTool('via')}>
              <Plus size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add Via (3)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant={tool === 'keepout' ? 'default' : 'ghost'} onClick={() => setTool('keepout')}
              className={tool === 'keepout' ? 'bg-rose-600 text-white hover:bg-rose-500' : ''}>
              <ShieldOff size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add Keepout Area (4)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => { usePCB.getState().generateTeardrops(); toast.success('Teardrops generated'); }}>
              <Droplet size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Generate Teardrops</TooltipContent>
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

        {/* Differential pair routing */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={handleRouteDiffPair} className="text-cyan-400 hover:text-cyan-300">
              <GitBranch size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Route differential pair (P+N traces, parallel)</TooltipContent>
        </Tooltip>

        {/* Length tuning */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={handleLengthTune} className="text-amber-400 hover:text-amber-300">
              <Activity size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Length-tune selected trace (serpentine meander)</TooltipContent>
        </Tooltip>

        {/* Layer stack dialog */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowLayerStack(true)} className="text-slate-300">
              <Layers3 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Layer stack editor (2/4/6-layer)</TooltipContent>
        </Tooltip>

        {/* HDI vias dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="text-emerald-400 hover:text-emerald-300">
              <CircleDot size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 bg-slate-900 border-slate-700">
            <DropdownMenuLabel className="text-slate-300">HDI Vias</DropdownMenuLabel>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handleAddBlindVia}>
              Blind via (top → inner1)
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handleAddMicroVia}>
              Microvia (top → inner1, laser)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* DRC settings dialog */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowDRCSettings(true)} className="text-slate-300">
              <SlidersHorizontal size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>DRC settings + exclusions</TooltipContent>
        </Tooltip>

        {/* Tools dropdown: align, distribute, flip, length-tune */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <AlignLeft size={14} />
              <ChevronDown size={12} className="ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 bg-slate-900 border-slate-700">
            <DropdownMenuLabel className="text-slate-300">Alignment (select 2+)</DropdownMenuLabel>
            <div className="grid grid-cols-3 gap-1 p-2">
              <DropdownMenuItem className="justify-center" onClick={() => usePCB.getState().alignSelected('left')}>Left</DropdownMenuItem>
              <DropdownMenuItem className="justify-center" onClick={() => usePCB.getState().alignSelected('hCenter')}>H Center</DropdownMenuItem>
              <DropdownMenuItem className="justify-center" onClick={() => usePCB.getState().alignSelected('right')}>Right</DropdownMenuItem>
              <DropdownMenuItem className="justify-center" onClick={() => usePCB.getState().alignSelected('top')}>Top</DropdownMenuItem>
              <DropdownMenuItem className="justify-center" onClick={() => usePCB.getState().alignSelected('vCenter')}>V Center</DropdownMenuItem>
              <DropdownMenuItem className="justify-center" onClick={() => usePCB.getState().alignSelected('bottom')}>Bottom</DropdownMenuItem>
            </div>
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuLabel className="text-slate-300">Distribute (3+)</DropdownMenuLabel>
            <div className="grid grid-cols-2 gap-1 p-2">
              <DropdownMenuItem className="justify-center" onClick={() => usePCB.getState().distributeSelected('horizontal')}>Horizontal</DropdownMenuItem>
              <DropdownMenuItem className="justify-center" onClick={() => usePCB.getState().distributeSelected('vertical')}>Vertical</DropdownMenuItem>
            </div>
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuItem onClick={() => {
              const id = usePCB.getState().selectedTraceId;
              if (!id) { toast.error('Select a trace first'); return; }
              const trace = usePCB.getState().traces.find(t => t.id === id);
              if (!trace) return;
              const len = trace.segments.reduce((a, s) => a + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y), 0);
              usePCB.getState().lengthTuneTrace(id, len * 1.2);
              toast.success(`Length-tuned: +20% (serpentine meander)`);
            }}>
              <Droplet size={12} className="mr-2" /> Length-Tune Trace (+20%)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => {
              const id = usePCB.getState().selectedFootprintId;
              if (!id) { toast.error('Select a footprint first'); return; }
              usePCB.getState().flipFootprint(id);
              toast.success('Flipped to other side');
            }}>
              <FlipHorizontal size={12} className="mr-2" /> Flip to Other Side
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
          {/* Export Gerbers (X1 + X2) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="bg-amber-500 text-slate-900 hover:bg-amber-400">
                <FileDown size={14} />
                <span className="ml-1 hidden md:inline">Gerbers</span>
                <ChevronDown size={12} className="ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-slate-900 border-slate-700">
              <DropdownMenuLabel className="text-slate-300">Manufacturing Export</DropdownMenuLabel>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handleGerberExport}>
                Gerber X1 (RS-274X)
                <span className="ml-auto text-[10px] text-slate-500">legacy</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handleGerberX2Export}>
                Gerber X2 (with attributes)
                <span className="ml-auto text-[10px] text-emerald-400">recommended</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Export BOM */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={() => {
                const s = usePCB.getState();
                const csv = exportBOM(s.footprints);
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = 'bom.csv'; a.click();
                URL.revokeObjectURL(url);
                toast.success('BOM exported');
              }}>
                <FileDown size={14} />
                <span className="ml-1 hidden md:inline">BOM</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export Bill of Materials (CSV)</TooltipContent>
          </Tooltip>
          {/* Export IPC-2581 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={() => {
                const s = usePCB.getState();
                const xml = exportIPC2581(s.footprints, s.traces, s.vias, s.board, s.padNets);
                const blob = new Blob([xml], { type: 'application/xml' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = 'pcb.ipc2581.xml'; a.click();
                URL.revokeObjectURL(url);
                toast.success('IPC-2581 exported');
              }}>
                <FileDown size={14} />
                <span className="ml-1 hidden md:inline">IPC-2581</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export IPC-2581 (single XML manufacturing file)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Footprint Editor dialog */}
      <FootprintEditorDialog
        open={showFootprintEditor}
        onClose={() => setShowFootprintEditor(false)}
        onSave={() => {
          // Notify any listening UI that the footprint registry changed
          // (e.g. future Library Manager auto-refresh).
          window.dispatchEvent(new CustomEvent('circuitlab:footprint-registered'));
        }}
      />

      {/* Layer Stack dialog */}
      <LayerStackDialog open={showLayerStack} onClose={() => setShowLayerStack(false)} />

      {/* DRC Settings + Exclusions dialog */}
      <DRCSettingsDialog open={showDRCSettings} onClose={() => setShowDRCSettings(false)} />

      {/* Length Tune dialog */}
      <LengthTuneDialog open={showLengthTune} onClose={() => setShowLengthTune(false)} />
    </TooltipProvider>
  );
}
