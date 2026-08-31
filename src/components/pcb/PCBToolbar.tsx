'use client';

import { useRef, useState, type ReactNode } from 'react';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  Download, MousePointer2, Route, Plus, RotateCw, Trash2, Grid3x3, Eye, Zap,
  ShieldCheck, Layers3, FileDown, Wand2, GitCompare, Upload, GitBranch, Activity,
  ShieldOff, Droplet, ChevronDown, Frame, CircleDot, SlidersHorizontal, Eraser,
  FlipHorizontal, FileText, Pencil, Tag,
} from 'lucide-react';
import { toast } from 'sonner';
import { exportBOM, exportIPC2581 } from '@/lib/pcb/additional-exports';
import { exportAllGerbersX2 } from '@/lib/pcb/gerber-export';
import { importKiCadFootprint, importKiCadFootprintsFromFile } from '@/lib/pcb/kicad-import';
import { footprintDefs } from '@/lib/pcb/footprints';
import { FootprintEditorDialog } from './FootprintEditorDialog';
import { LayerStackDialog, DRCSettingsDialog, LengthTuneDialog } from './PCBDialogs';

/* ── Shared style tokens (dark slate, matches the schematic toolbar) ───────── */
const MENU_ITEM = 'text-slate-200 hover:bg-slate-800 cursor-pointer';
const MENU_LABEL = 'text-xs font-semibold uppercase tracking-wider text-slate-400';
const MENU_SEP = 'bg-slate-700';

/** Thin vertical divider between toolbar groups. */
function ToolbarDivider() {
  return <div className="mx-0.5 h-5 w-px flex-shrink-0 bg-slate-700" />;
}

/** Compact icon-only toggle button with a tooltip (quick tool modes, view toggles). */
function QuickToolButton(props: {
  tooltip: string;
  active: boolean;
  onClick: () => void;
  activeClassName?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant={props.active ? 'default' : 'ghost'}
          className={cn('h-7 w-7 p-0', props.active && props.activeClassName)}
          onClick={props.onClick}
          aria-label={props.tooltip}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Dropdown trigger button: icon + hidden-on-narrow label + chevron, wrapped in a tooltip. */
function MenuTriggerButton(props: {
  tooltip: string;
  label: string;
  icon: ReactNode;
  buttonClassName?: string;
  labelClassName?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className={cn('h-7 gap-1 px-2 text-slate-300', props.buttonClassName)} aria-label={`${props.label} menu`}>
            {props.icon}
            <span className={cn('hidden 2xl:inline', props.labelClassName)}>{props.label}</span>
            <ChevronDown size={10} className="text-slate-500" />
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent>{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

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
  const runDRC = usePCB((s) => s.runDRC);
  const drcErrors = usePCB((s) => s.drcErrors);
  const addCopperPour = usePCB((s) => s.addCopperPour);
  const removeCopperPour = usePCB((s) => s.removeCopperPour);
  const copperPours = usePCB((s) => s.copperPours);
  const exportGerbers = usePCB((s) => s.exportGerbers);
  const runAutoRoute = usePCB((s) => s.runAutoRoute);
  const runNetlistVerify = usePCB((s) => s.runNetlistVerify);

  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);

  const [showFootprintEditor, setShowFootprintEditor] = useState(false);
  const [showLayerStack, setShowLayerStack] = useState(false);
  const [showDRCSettings, setShowDRCSettings] = useState(false);
  const [showLengthTune, setShowLengthTune] = useState(false);

  const hasCopperPour = copperPours.some((p) => p.layer === activeLayer);

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

  const handleBOMExport = () => {
    const s = usePCB.getState();
    const csv = exportBOM(s.footprints);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bom.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('BOM exported');
  };

  const handleIPC2581Export = () => {
    const s = usePCB.getState();
    const xml = exportIPC2581(s.footprints, s.traces, s.vias, s.board, s.padNets);
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pcb.ipc2581.xml';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('IPC-2581 exported');
  };

  const handleAutoRoute = () => {
    if (usePCB.getState().footprints.length === 0) {
      toast.error('No footprints to route — import the schematic first');
      return;
    }
    const t0 = performance.now();
    const stats = runAutoRoute();
    const wallMs = performance.now() - t0;
    if (stats.routed === 0 && stats.unroutedCount > 0) {
      toast.error(`Auto-route: 0/${stats.routed + stats.unroutedCount} connections routed — try moving components apart or widening the board`);
      return;
    }
    const parts = [
      `${stats.routed}/${stats.routed + stats.unroutedCount} connections`,
      `${stats.vias} vias`,
      `${stats.totalLength.toFixed(0)}mm copper`,
      `${(wallMs / 1000).toFixed(1)}s`,
    ];
    if (stats.rippedUp > 0) parts.push(`${stats.rippedUp} rip-ups`);
    if (stats.unroutedCount > 0) {
      toast.warning(`Auto-route: ${parts.join(' · ')} — ${stats.unroutedCount} unrouted`);
    } else {
      toast.success(`Auto-route complete: ${parts.join(' · ')}`);
    }
  };

  const handleUnrouteAll = () => {
    const s = usePCB.getState();
    if (s.traces.length === 0 && s.vias.length === 0) {
      toast.info('Nothing to unroute');
      return;
    }
    const n = s.traces.length;
    const v = s.vias.length;
    s.unrouteAll();
    toast.success(`Removed ${n} trace${n === 1 ? '' : 's'} and ${v} via${v === 1 ? '' : 's'}`);
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

  const handleLengthTune20 = () => {
    const id = usePCB.getState().selectedTraceId;
    if (!id) {
      toast.error('Select a trace first');
      return;
    }
    const trace = usePCB.getState().traces.find((t) => t.id === id);
    if (!trace) return;
    const len = trace.segments.reduce((a, s) => a + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y), 0);
    usePCB.getState().lengthTuneTrace(id, len * 1.2);
    toast.success('Length-tuned: +20% (serpentine meander)');
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
    if (hasCopperPour) {
      removeCopperPour(activeLayer);
      toast.info(`Copper pour removed from ${activeLayer} layer`);
    } else {
      addCopperPour(activeLayer, 'GND');
      toast.success(`GND copper pour added to ${activeLayer} layer`);
    }
  };

  const handleTeardrops = () => {
    usePCB.getState().generateTeardrops();
    toast.success('Teardrops generated');
  };

  const handleFlipFootprint = () => {
    const id = usePCB.getState().selectedFootprintId;
    if (!id) {
      toast.error('Select a footprint first');
      return;
    }
    usePCB.getState().flipFootprint(id);
    toast.success('Flipped to other side');
  };

  const handleRotateFootprint = () => {
    if (selectedFootprintId) rotateFootprint(selectedFootprintId);
  };

  const handleDeleteTrace = () => {
    if (selectedTraceId) usePCB.getState().deleteTrace(selectedTraceId);
  };

  return (
    <TooltipProvider delayDuration={200}>
      {/* Single non-wrapping 40px-tall row: icons on narrow screens (labels appear ≥xl);
          horizontal scroll (invisible scrollbar) only as a very-narrow-viewport fallback. */}
      <div className="flex flex-nowrap items-center gap-0.5 overflow-x-auto border-b border-slate-800 bg-slate-900 px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Brand */}
        <div className="mr-1 flex flex-shrink-0 items-center gap-2 pr-2">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-emerald-500 to-cyan-600 text-white">
            <Zap size={16} strokeWidth={2.5} />
          </div>
          <span className="hidden text-sm font-semibold text-slate-100 xl:inline">PCB Layout</span>
        </div>

        {/* Import from schematic — primary action */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" className="h-7 gap-1 px-2 bg-emerald-500 text-slate-900 hover:bg-emerald-400" onClick={handleImport} aria-label="Import from schematic">
              <Zap size={14} />
              <span className="hidden md:inline">Import</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import components &amp; netlist from the schematic</TooltipContent>
        </Tooltip>

        {/* Hidden file input for KiCad footprint/PCB import (triggered from the File menu) */}
        <input
          ref={kicadFileInputRef}
          type="file"
          accept=".kicad_mod,.kicad_pcb"
          onChange={handleKiCadImport}
          className="hidden"
        />

        {/* ── File menu: KiCad import, footprint editor, all file exports ── */}
        <DropdownMenu>
          <MenuTriggerButton tooltip="Import / export — KiCad, JSON, Gerbers, BOM, IPC-2581" label="File" icon={<FileText size={14} />} />
          <DropdownMenuContent align="start" className="w-64 border-slate-700 bg-slate-900">
            <DropdownMenuLabel className={MENU_LABEL}>Import</DropdownMenuLabel>
            <DropdownMenuItem className={MENU_ITEM} onClick={() => kicadFileInputRef.current?.click()}>
              <Upload size={14} className="mr-2" /> KiCad Footprint / PCB
              <span className="ml-auto text-[10px] text-slate-500">.kicad_mod / .kicad_pcb</span>
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={() => setShowFootprintEditor(true)}>
              <Frame size={14} className="mr-2" /> Footprint Editor…
            </DropdownMenuItem>
            <DropdownMenuSeparator className={MENU_SEP} />
            <DropdownMenuLabel className={MENU_LABEL}>Export</DropdownMenuLabel>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleExportJSON}>
              <Download size={14} className="mr-2" /> PCB Layout
              <span className="ml-auto text-[10px] text-slate-500">JSON</span>
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleGerberExport}>
              <FileDown size={14} className="mr-2" /> Gerbers X1 (RS-274X)
              <span className="ml-auto text-[10px] text-slate-500">legacy</span>
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleGerberX2Export}>
              <FileDown size={14} className="mr-2" /> Gerbers X2 (attributes)
              <span className="ml-auto text-[10px] text-emerald-400">recommended</span>
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleBOMExport}>
              <FileDown size={14} className="mr-2" /> Bill of Materials
              <span className="ml-auto text-[10px] text-slate-500">CSV</span>
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleIPC2581Export}>
              <FileDown size={14} className="mr-2" /> IPC-2581
              <span className="ml-auto text-[10px] text-slate-500">XML</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* ── Edit menu: rotate/delete, alignment, distribute, flip ── */}
        <DropdownMenu>
          <MenuTriggerButton tooltip="Edit — rotate, delete, align, distribute, flip" label="Edit" icon={<Pencil size={14} />} />
          <DropdownMenuContent align="start" className="w-56 border-slate-700 bg-slate-900">
            <DropdownMenuLabel className={MENU_LABEL}>Footprint</DropdownMenuLabel>
            <DropdownMenuItem className={MENU_ITEM} disabled={!selectedFootprintId} onClick={handleRotateFootprint}>
              <RotateCw size={14} className="mr-2" /> Rotate Footprint
              <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={cn(MENU_ITEM, 'text-rose-400 hover:bg-rose-950/40 focus:bg-rose-950/40 focus:text-rose-300')}
              disabled={!selectedTraceId}
              onClick={handleDeleteTrace}
            >
              <Trash2 size={14} className="mr-2" /> Delete Trace
            </DropdownMenuItem>
            <DropdownMenuSeparator className={MENU_SEP} />
            <DropdownMenuLabel className={MENU_LABEL}>Align (2+ selected)</DropdownMenuLabel>
            <div className="grid grid-cols-3 gap-1 p-1.5">
              <DropdownMenuItem className="justify-center text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => usePCB.getState().alignSelected('left')}>Left</DropdownMenuItem>
              <DropdownMenuItem className="justify-center text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => usePCB.getState().alignSelected('hCenter')}>H Center</DropdownMenuItem>
              <DropdownMenuItem className="justify-center text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => usePCB.getState().alignSelected('right')}>Right</DropdownMenuItem>
              <DropdownMenuItem className="justify-center text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => usePCB.getState().alignSelected('top')}>Top</DropdownMenuItem>
              <DropdownMenuItem className="justify-center text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => usePCB.getState().alignSelected('vCenter')}>V Center</DropdownMenuItem>
              <DropdownMenuItem className="justify-center text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => usePCB.getState().alignSelected('bottom')}>Bottom</DropdownMenuItem>
            </div>
            <DropdownMenuLabel className={MENU_LABEL}>Distribute (3+ selected)</DropdownMenuLabel>
            <div className="grid grid-cols-2 gap-1 p-1.5">
              <DropdownMenuItem className="justify-center text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => usePCB.getState().distributeSelected('horizontal')}>Horizontal</DropdownMenuItem>
              <DropdownMenuItem className="justify-center text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => usePCB.getState().distributeSelected('vertical')}>Vertical</DropdownMenuItem>
            </div>
            <DropdownMenuSeparator className={MENU_SEP} />
            <DropdownMenuItem className={MENU_ITEM} onClick={handleFlipFootprint}>
              <FlipHorizontal size={14} className="mr-2" /> Flip to Other Side
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolbarDivider />

        {/* ── Quick tool modes — always-visible icon toggles (used constantly) ── */}
        <QuickToolButton tooltip="Select/Move (1)" active={tool === 'select'} onClick={() => setTool('select')}>
          <MousePointer2 size={14} />
        </QuickToolButton>
        <QuickToolButton
          tooltip="Route Trace — 90° (2)"
          active={tool === 'route'}
          activeClassName="bg-cyan-600 text-white hover:bg-cyan-500"
          onClick={() => setTool('route')}
        >
          <Route size={14} />
        </QuickToolButton>
        <QuickToolButton
          tooltip="Route Trace — 45° (Shift+2)"
          active={tool === 'route45'}
          activeClassName="bg-cyan-600 text-white hover:bg-cyan-500"
          onClick={() => setTool('route45')}
        >
          <Route size={14} className="rotate-45" />
        </QuickToolButton>
        <QuickToolButton tooltip="Add Via (3)" active={tool === 'via'} onClick={() => setTool('via')}>
          <Plus size={14} />
        </QuickToolButton>
        <QuickToolButton
          tooltip="Add Keepout Area (4)"
          active={tool === 'keepout'}
          activeClassName="bg-rose-600 text-white hover:bg-rose-500"
          onClick={() => setTool('keepout')}
        >
          <ShieldOff size={14} />
        </QuickToolButton>

        {/* ── Route menu: all tool modes (with active state) + high-speed routing ── */}
        <DropdownMenu>
          <MenuTriggerButton tooltip="Routing tools & high-speed options" label="Route" icon={<Route size={14} />} />
          <DropdownMenuContent align="start" className="w-60 border-slate-700 bg-slate-900">
            <DropdownMenuLabel className={MENU_LABEL}>Tool Modes</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={tool === 'select'} onCheckedChange={() => setTool('select')} className={MENU_ITEM}>
              Select / Move <DropdownMenuShortcut>1</DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={tool === 'route'} onCheckedChange={() => setTool('route')} className={MENU_ITEM}>
              Route 90° <DropdownMenuShortcut>2</DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={tool === 'route45'} onCheckedChange={() => setTool('route45')} className={MENU_ITEM}>
              Route 45° <DropdownMenuShortcut>⇧2</DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={tool === 'via'} onCheckedChange={() => setTool('via')} className={MENU_ITEM}>
              Add Via <DropdownMenuShortcut>3</DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={tool === 'keepout'} onCheckedChange={() => setTool('keepout')} className={MENU_ITEM}>
              Add Keepout <DropdownMenuShortcut>4</DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator className={MENU_SEP} />
            <DropdownMenuLabel className={MENU_LABEL}>High-Speed Routing</DropdownMenuLabel>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleRouteDiffPair}>
              <GitBranch size={14} className="mr-2 text-cyan-400" /> Route Differential Pair
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleLengthTune}>
              <Activity size={14} className="mr-2 text-amber-400" /> Length-Tune Trace…
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleLengthTune20}>
              <Droplet size={14} className="mr-2" /> Length-Tune +20%
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* ── Auto menu: autorouter, unroute, teardrops, HDI vias ── */}
        <DropdownMenu>
          <MenuTriggerButton tooltip="Automation — auto-route, unroute, teardrops, HDI vias" label="Auto" icon={<Wand2 size={14} />} />
          <DropdownMenuContent align="start" className="w-60 border-slate-700 bg-slate-900">
            <DropdownMenuLabel className={MENU_LABEL}>Automation</DropdownMenuLabel>
            <DropdownMenuItem
              className="cursor-pointer text-purple-300 hover:bg-purple-950/60 hover:text-purple-200 focus:bg-purple-950/60 focus:text-purple-200"
              onClick={handleAutoRoute}
            >
              <Wand2 size={14} className="mr-2 text-purple-400" /> Auto-Route All
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleUnrouteAll}>
              <Eraser size={14} className="mr-2" /> Unroute All
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleTeardrops}>
              <Droplet size={14} className="mr-2" /> Generate Teardrops
            </DropdownMenuItem>
            <DropdownMenuSeparator className={MENU_SEP} />
            <DropdownMenuLabel className={MENU_LABEL}>HDI Vias</DropdownMenuLabel>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleAddBlindVia}>
              <CircleDot size={14} className="mr-2" /> Blind Via (top → inner1)
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={handleAddMicroVia}>
              <CircleDot size={14} className="mr-2" /> Microvia (top → inner1, laser)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* ── Design menu: copper pour, layer stack, DRC rules ── */}
        <DropdownMenu>
          <MenuTriggerButton tooltip="Board setup — copper pour, layer stack, DRC rules" label="Design" icon={<SlidersHorizontal size={14} />} />
          <DropdownMenuContent align="start" className="w-60 border-slate-700 bg-slate-900">
            <DropdownMenuLabel className={MENU_LABEL}>Board Setup</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={hasCopperPour} onCheckedChange={handleCopperPour} className={MENU_ITEM}>
              GND Copper Pour — {activeLayer} layer
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={() => setShowLayerStack(true)}>
              <Layers3 size={14} className="mr-2" /> Layer Stack…
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM} onClick={() => setShowDRCSettings(true)}>
              <SlidersHorizontal size={14} className="mr-2" /> DRC Settings…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolbarDivider />

        {/* Layer selector — red = top copper, blue = bottom copper (industry convention) */}
        <div className="flex flex-shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={activeLayer === 'top' ? 'default' : 'ghost'}
                className={cn('h-7 px-2 text-xs', activeLayer === 'top' && 'bg-red-600 text-white hover:bg-red-500')}
                onClick={() => setActiveLayer('top')}
              >
                Top
              </Button>
            </TooltipTrigger>
            <TooltipContent>Route on the top copper layer (F.Cu)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={activeLayer === 'bottom' ? 'default' : 'ghost'}
                className={cn('h-7 px-2 text-xs', activeLayer === 'bottom' && 'bg-blue-600 text-white hover:bg-blue-500')}
                onClick={() => setActiveLayer('bottom')}
              >
                Bot
              </Button>
            </TooltipTrigger>
            <TooltipContent>Route on the bottom copper layer (B.Cu)</TooltipContent>
          </Tooltip>
        </div>

        {/* Trace width */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-shrink-0 items-center gap-1.5 px-1">
              <span className="hidden text-xs text-slate-400 lg:inline">Width</span>
              <Slider
                value={[defaultTraceWidth * 10]}
                min={2}
                max={30}
                step={1}
                onValueChange={(v) => setDefaultTraceWidth(v[0] / 10)}
                className="w-16 lg:w-20"
              />
              <span className="w-10 text-right font-mono text-xs text-slate-300">{defaultTraceWidth.toFixed(1)}mm</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>Default trace width for new routes</TooltipContent>
        </Tooltip>

        <ToolbarDivider />

        {/* View toggles */}
        <QuickToolButton tooltip="Toggle Ratsnest" active={showRatsnest} onClick={toggleRatsnest}>
          <Eye size={14} />
        </QuickToolButton>
        <QuickToolButton tooltip="Toggle Grid" active={showGrid} onClick={toggleGrid}>
          <Grid3x3 size={14} />
        </QuickToolButton>
        <QuickToolButton tooltip="Show pad net names" active={showPadNets} onClick={togglePadNets}>
          <Tag size={14} />
        </QuickToolButton>

        {/* ── Right side: verification + primary manufacturing export ── */}
        <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="relative h-7 w-7 p-0"
                onClick={handleDRC}
                aria-label="Run DRC"
              >
                <ShieldCheck size={14} className={drcErrors.length > 0 ? 'text-amber-400' : undefined} />
                {drcErrors.length > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold leading-none text-slate-900">
                    {drcErrors.length > 99 ? '99+' : drcErrors.length}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {drcErrors.length > 0 ? `Run DRC — ${drcErrors.length} violation(s) found` : 'Run DRC (Design Rule Check)'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-cyan-400 hover:text-cyan-300" onClick={handleNetlistVerify} aria-label="Verify netlist">
                <GitCompare size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Verify PCB netlist matches schematic</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <MenuTriggerButton
              tooltip="Export manufacturing files (Gerber + drill + PnP)"
              label="Gerbers"
              icon={<FileDown size={14} />}
              buttonClassName="bg-amber-500 text-slate-900 hover:bg-amber-400 hover:text-slate-900"
              labelClassName="hidden md:inline"
            />
            <DropdownMenuContent align="end" className="w-56 border-slate-700 bg-slate-900">
              <DropdownMenuLabel className={MENU_LABEL}>Manufacturing Export</DropdownMenuLabel>
              <DropdownMenuItem className={MENU_ITEM} onClick={handleGerberExport}>
                Gerber X1 (RS-274X)
                <span className="ml-auto text-[10px] text-slate-500">legacy</span>
              </DropdownMenuItem>
              <DropdownMenuItem className={MENU_ITEM} onClick={handleGerberX2Export}>
                Gerber X2 (with attributes)
                <span className="ml-auto text-[10px] text-emerald-400">recommended</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
