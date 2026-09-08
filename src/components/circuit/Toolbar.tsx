'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { toast } from 'sonner';
import {
  Play, Pause, SkipForward, Save, Upload, Trash2, Undo2, Redo2, Gauge, Zap,
  FileText, ChevronDown, Settings2, Database, FileCode, Boxes, ShieldCheck,
  Search, FileDown, Network, Layers, BookOpen, Wand2, Ruler, Pencil, Spline,
  Activity, Sliders, Sigma, Waves, ChevronRight, ChevronLeft, RotateCcw, Library,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuCheckboxItem,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MyCircuitsDialog } from './MyCircuitsDialog';
import { ExamplesDialog } from './toolbar/ExamplesDialog';
import { SpiceImportDialog } from './SpiceImportDialog';
import { SubCircuitDialog } from './SubCircuitDialog';
import { SymbolEditorDialog } from './SymbolEditorDialog';
import { KiCadLibraryImportDialog } from './dialogs/schematic/KiCadLibraryImportDialog';
import {
  FindReplaceDialog, ViolationsBrowserDialog, NetInspectorDialog,
  PageSetupDialog, SavedViewsDialog, HierarchicalSheetsDialog, NetClassesDialog,
  SettingsDialog,
} from './SchematicDialogs';
import {
  AnalysisDialog, OptionsDialog, MeasurementDialog, BatchSweepDialog, StimuliEditorDialog,
} from './AnalysisDialogs';
import {
  exportSchematicSVG, exportSchematicPNG, exportSchematicPDF,
  downloadBlob, downloadText,
} from '@/lib/circuit/schematic-plot';
import {
  exportSPICENetlist, exportKiCadNetlist,
  exportBOMCSV, exportBOMHTML, exportBOMXML,
} from '@/lib/circuit/netlist-export';
import { parseSchematicFile } from '@/lib/circuit/kicad-sch-import';
import { confirmDialog } from '@/lib/confirm';
import type { CircuitDocument } from '@/lib/circuit/types';

export function Toolbar() {
  const running = useEditor((s) => s.running);
  const speed = useEditor((s) => s.speed);
  const simError = useEditor((s) => s.simError);
  const setRunning = useEditor((s) => s.setRunning);
  const setSpeed = useEditor((s) => s.setSpeed);
  const step = useEditor((s) => s.step);
  const reset = useEditor((s) => s.reset);

  // Toast sim errors when they occur
  useEffect(() => {
    if (simError) {
      toast.error(simError);
    }
  }, [simError]);
  const clear = useEditor((s) => s.clear);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const serialize = useEditor((s) => s.serialize);
  const loadDocument = useEditor((s) => s.loadDocument);
  // Hierarchical sheet navigation
  const activeSheet = useEditor((s) => s.activeSheet);
  const setActiveSheet = useEditor((s) => s.setActiveSheet);
  const sheets = useEditor((s) => s.sheets);
  const childSheets = useEditor((s) => s.childSheets);
  const showGrid = useEditor((s) => s.showGrid);
  const setShowGrid = useEditor((s) => s.setShowGrid);
  const snapToGrid = useEditor((s) => s.snapToGrid);
  const setSnapToGrid = useEditor((s) => s.setSnapToGrid);
  const past = useEditor((s) => s.past.length);
  const future = useEditor((s) => s.future.length);
  // KiCad-parity new state
  const showRefdes = useEditor((s) => s.showRefdes);
  const setShowRefdes = useEditor((s) => s.setShowRefdes);
  const showValues = useEditor((s) => s.showValues);
  const setShowValues = useEditor((s) => s.setShowValues);
  const showNetColors = useEditor((s) => s.showNetColors);
  const setShowNetColors = useEditor((s) => s.setShowNetColors);
  const theme = useEditor((s) => s.theme);
  const setTheme = useEditor((s) => s.setTheme);
  const activeTool = useEditor((s) => s.activeTool);
  const setActiveTool = useEditor((s) => s.setActiveTool);
  // Tools the canvas interaction layer actually implements. The rest exist in
  // the store type but have no canvas handler — selecting them previously did
  // nothing at all (silent dead UI). Route them to a toast instead so the
  // user gets feedback instead of a no-op checkbox.
  const pickTool = (t: typeof activeTool) => {
    if (t === 'wire' || t === 'select') {
      setActiveTool(activeTool === t ? 'select' : t);
      return;
    }
    toast.info(`"${t}" tool is not implemented yet — use the Component palette instead`);
  };
  const straightenWires = useEditor((s) => s.straightenWires);
  const hasBendyWires = useEditor((s) => s.wires.some((w) => w.waypoints && w.waypoints.length > 0));

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const schImportInputRef = useRef<HTMLInputElement | null>(null);
  const [showMyCircuits, setShowMyCircuits] = useState(false);
  const [showSpiceImport, setShowSpiceImport] = useState(false);
  const [showSubCircuit, setShowSubCircuit] = useState(false);
  const [showSymbolEditor, setShowSymbolEditor] = useState(false);
  const [showKiCadLibImport, setShowKiCadLibImport] = useState(false);
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [showViolations, setShowViolations] = useState(false);
  const [showNetInspector, setShowNetInspector] = useState(false);
  const [showPageSetup, setShowPageSetup] = useState(false);
  const [showSavedViews, setShowSavedViews] = useState(false);
  const [showSheets, setShowSheets] = useState(false);
  const [showNetClasses, setShowNetClasses] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Simulation analysis dialogs
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [showMeasurement, setShowMeasurement] = useState(false);
  const [showBatchSweep, setShowBatchSweep] = useState(false);
  const [showStimuliEditor, setShowStimuliEditor] = useState(false);
  // Track camera so SaveViewDialog gets current pan/zoom
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });

  // Listen for "open find/replace" event from canvas hotkey
  useEffect(() => {
    const handler = () => setShowFindReplace(true);
    window.addEventListener('circuitlab:open-find-replace', handler);
    // poll camera from canvas via custom event
    const camHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) setCamera(detail);
    };
    window.addEventListener('circuitlab:camera', camHandler);
    // ask canvas for current camera
    const askCamera = () => window.dispatchEvent(new CustomEvent('circuitlab:request-camera'));
    askCamera();
    const interval = setInterval(askCamera, 2000);
    return () => {
      window.removeEventListener('circuitlab:open-find-replace', handler);
      window.removeEventListener('circuitlab:camera', camHandler);
      clearInterval(interval);
    };
  }, []);

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
        if (doc && doc.version === 1 && Array.isArray(doc.components) && Array.isArray(doc.wires)) {
          loadDocument(doc);
          toast.success(`Loaded circuit: ${file.name}`);
        } else {
          toast.error('Invalid circuit file: missing version, components, or wires array');
        }
      } catch (err) {
        toast.error('Failed to parse file: ' + (err as Error).message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [loadDocument]);

  // KiCad / Eagle schematic import
  const handleSchImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const result = parseSchematicFile(text, file.name);
        loadDocument(result.document);
        if (result.unknownSymbols.length > 0) {
          toast.warning(`Imported with ${result.unknownSymbols.length} unknown symbols skipped`, {
            description: result.unknownSymbols.slice(0, 5).join('\n'),
          });
        } else {
          toast.success(`Imported ${file.name}`);
        }
        if (result.warnings.length > 0) {
          console.warn('Import warnings:', result.warnings);
        }
      } catch (err) {
        toast.error('Import failed: ' + (err as Error).message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [loadDocument]);

  const handlePlotSVG = useCallback(() => {
    const doc = serialize();
    const svg = exportSchematicSVG(doc);
    downloadText(svg, `schematic_${Date.now()}.svg`, 'image/svg+xml');
    toast.success('Exported SVG');
  }, [serialize]);

  const handlePlotPNG = useCallback(async () => {
    try {
      const doc = serialize();
      const blob = await exportSchematicPNG(doc, 2);
      downloadBlob(blob, `schematic_${Date.now()}.png`);
      toast.success('Exported PNG');
    } catch (err) {
      toast.error('PNG export failed: ' + (err as Error).message);
    }
  }, [serialize]);

  const handlePlotPDF = useCallback(async () => {
    try {
      const doc = serialize();
      const blob = await exportSchematicPDF(doc);
      downloadBlob(blob, `schematic_${Date.now()}.pdf`);
      toast.success('Exported PDF');
    } catch (err) {
      toast.error('PDF export failed: ' + (err as Error).message);
    }
  }, [serialize]);

  const handleExportSPICE = useCallback(() => {
    const doc = serialize();
    const net = exportSPICENetlist(doc, doc.metadata?.title ?? 'Circuit');
    downloadText(net, `circuit_${Date.now()}.cir`, 'text/plain');
    toast.success('Exported SPICE netlist');
  }, [serialize]);

  const handleExportKiCadNet = useCallback(() => {
    const doc = serialize();
    const net = exportKiCadNetlist(doc, doc.metadata?.title ?? 'Circuit');
    downloadText(net, `circuit_${Date.now()}.net`, 'application/xml');
    toast.success('Exported KiCad netlist');
  }, [serialize]);

  const handleExportBOM = useCallback((format: 'csv' | 'html' | 'xml') => {
    const doc = serialize();
    // const ext = format;
    if (format === 'csv') {
      downloadText(exportBOMCSV(doc), `bom_${Date.now()}.csv`, 'text/csv');
    } else if (format === 'html') {
      downloadText(exportBOMHTML(doc), `bom_${Date.now()}.html`, 'text/html');
    } else {
      downloadText(exportBOMXML(doc), `bom_${Date.now()}.xml`, 'application/xml');
    }
    toast.success(`Exported BOM (${format.toUpperCase()})`);
  }, [serialize]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-0.5 border-b border-slate-800 bg-slate-900 px-2 py-1.5 overflow-hidden">
        {/* Brand — compact, no text on narrow screens */}
        <div className="mr-1 flex shrink-0 items-center gap-2 pr-2">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-linear-to-br from-cyan-400 to-emerald-500 text-slate-900">
            <Zap size={14} strokeWidth={2.5} />
          </div>
          <span className="hidden text-sm font-semibold text-slate-100 xl:inline">CircuitLab</span>
        </div>

        {/* Hierarchical sheet breadcrumb — only when inside a sub-sheet */}
        {activeSheet && (
          <div
            className="mr-1 flex shrink-0 items-center gap-1 rounded-md border border-emerald-700/50 bg-emerald-950/40 px-2 py-0.5 text-xs font-mono whitespace-nowrap shadow-sm"
            role="navigation"
            aria-label="Sheet hierarchy breadcrumb"
          >
            <button
              className="flex cursor-pointer items-center gap-0.5 text-slate-300 hover:text-emerald-300 transition-colors"
              onClick={() => setActiveSheet('')}
              title="Back to root sheet (Esc)"
            >
              <ChevronLeft size={12} />
              <span className="hidden sm:inline">Root</span>
            </button>
            <ChevronRight size={12} className="text-slate-500" />
            <span className="max-w-20 truncate font-semibold text-emerald-300" title={activeSheet}>
              {sheets.find((s) => s.fileName === activeSheet)?.sheetName ??
                childSheets[activeSheet]?.sheets?.find?.((s: { fileName: string; sheetName?: string }) => s.fileName === activeSheet)?.sheetName ??
                activeSheet.replace(/\.kicad_sch$/, '')}
            </span>
            {(() => {
              const sheet = sheets.find((s) => s.fileName === activeSheet);
              const pinCount = sheet?.pins?.length ?? 0;
              return pinCount > 0 ? (
                <span className="ml-0.5 rounded-full bg-emerald-700/40 px-1 py-0.5 text-[10px] text-emerald-200" title="Sheet pin count">
                  {pinCount}
                </span>
              ) : null;
            })()}
          </div>
        )}

        {/* ─── PRIMARY CONTROLS (always visible) ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant={running ? 'destructive' : 'default'}
              className={running ? 'h-7 px-2' : 'h-7 px-2 bg-emerald-500 text-slate-900 hover:bg-emerald-400'}
              onClick={() => setRunning(!running)}
            >
              {running ? <Pause size={14} /> : <Play size={14} />}
              <span className="ml-1 hidden xl:inline">{running ? 'Pause' : 'Run'}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause simulation (Space)' : 'Run simulation (Space)'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => step()} disabled={running}>
              <SkipForward size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Single step</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => reset()} disabled={running}>
              <RotateCcw size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset simulation</TooltipContent>
        </Tooltip>

        {/* Undo / Redo — always visible */}
        <div className="mx-0.5 h-5 w-px shrink-0 bg-slate-700" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => undo()} disabled={past === 0 || running}>
              <Undo2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause to undo' : 'Undo (Ctrl+Z)'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => redo()} disabled={future === 0 || running}>
              <Redo2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause to redo' : 'Redo (Ctrl+Y)'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => straightenWires()}
              disabled={!hasBendyWires || running}
              aria-label="Straighten wires"
            >
              <Spline size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {running ? 'Pause to straighten' : 'Straighten wires — collapse every wire to its direct / L-shaped route'}
          </TooltipContent>
        </Tooltip>

        {/* ─── SECONDARY CONTROLS (visible on md+ screens) ─── */}
        <div className="hidden md:flex items-center gap-1">
          <div className="mx-0.5 h-5 w-px shrink-0 bg-slate-700" />
          {/* Speed control — compact */}
          <div className="flex items-center gap-1 px-1">
            <Gauge size={12} className="text-slate-400" />
            <Slider
              value={[Math.log2(speed)]}
              min={-2}
              max={6}
              step={0.5}
              onValueChange={(v) => setSpeed(Math.pow(2, v[0]))}
              className="w-20"
            />
            <span className="w-8 text-right font-mono text-[10px] text-slate-300">{speed.toFixed(1)}x</span>
          </div>
        </div>

        {/* ─── TERTIARY CONTROLS (visible on lg+ screens) ─── */}
        <div className="hidden lg:flex items-center gap-1">
          <div className="mx-0.5 h-5 w-px shrink-0 bg-slate-700" />
          {/* Examples dialog (searchable accordion of categories) */}
          <ExamplesDialogButton loadDocument={loadDocument} disabled={running} />

          {/* Simulate menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 px-2" disabled={running}>
                <Activity size={14} />
                <span className="ml-1 hidden 2xl:inline">Simulate</span>
                <ChevronDown size={10} className="ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 bg-slate-900 border-slate-700">
              <DropdownMenuLabel className="text-slate-300">Analysis</DropdownMenuLabel>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowAnalysis(true)}>
                <Activity size={14} className="mr-2" /> Run Analysis (AC/DC/TF/Sens/Noise/...)
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowBatchSweep(true)}>
                <Waves size={14} className="mr-2" /> Batch Sweep / Monte Carlo
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowMeasurement(true)}>
                <Sigma size={14} className="mr-2" /> Measurements (.meas)
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowStimuliEditor(true)}>
                <Wand2 size={14} className="mr-2" /> Stimuli Editor
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-slate-700" />
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowOptions(true)}>
                <Sliders size={14} className="mr-2" /> Simulation Options
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => {
                  const { sim, report } = useEditor.getState().solveDCRobust();
                  if (sim) {
                    toast.success(`Robust DC solve converged (${report.attempts.join(' → ') || 'direct'})`);
                  } else {
                    toast.error(report.message ?? 'Robust DC solve failed — see convergence report');
                  }
                }}>
                <ShieldCheck size={14} className="mr-2" /> Robust DC Solve (gmin → source → pseudo-tran)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Inspect menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 px-2" disabled={running}>
                <Network size={14} />
                <span className="ml-1 hidden 2xl:inline">Inspect</span>
                <ChevronDown size={10} className="ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-slate-900 border-slate-700">
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowViolations(true)}>
                <ShieldCheck size={14} className="mr-2" /> ERC Violations
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowNetInspector(true)}>
                <Network size={14} className="mr-2" /> Net Inspector
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowNetClasses(true)}>
                <Layers size={14} className="mr-2" /> Net Classes
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-slate-700" />
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowSheets(true)}>
                <BookOpen size={14} className="mr-2" /> Hierarchical Sheets
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowPageSetup(true)}>
                <Ruler size={14} className="mr-2" /> Page Setup
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                onClick={() => setShowSavedViews(true)}>
                <Layers size={14} className="mr-2" /> Saved Views
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Tools menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 px-2" disabled={running}>
                <Pencil size={14} />
                <span className="ml-1 hidden 2xl:inline">Tools</span>
                <ChevronDown size={10} className="ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-slate-900 border-slate-700">
              <DropdownMenuLabel className="text-slate-300">Schematic Tools</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'wire'} onCheckedChange={() => setActiveTool(activeTool === 'wire' ? 'select' : 'wire')}>
                Wire
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'bus'} onCheckedChange={() => pickTool('bus')}>
                Bus
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'label'} onCheckedChange={() => pickTool('label')}>
                Local Label
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'globalLabel'} onCheckedChange={() => pickTool('globalLabel')}>
                Global Label
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'hierLabel'} onCheckedChange={() => pickTool('hierLabel')}>
                Hierarchical Label
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'junction'} onCheckedChange={() => pickTool('junction')}>
                Junction
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'noConnect'} onCheckedChange={() => pickTool('noConnect')}>
                No-Connect (N)
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'powerPort'} onCheckedChange={() => pickTool('powerPort')}>
                Power Port
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator className="bg-slate-700" />
              <DropdownMenuLabel className="text-slate-300">Drawing Primitives</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'text'} onCheckedChange={() => pickTool('text')}>
                Text
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'line'} onCheckedChange={() => pickTool('line')}>
                Line
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'poly'} onCheckedChange={() => pickTool('poly')}>
                Polygon
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={activeTool === 'image'} onCheckedChange={() => pickTool('image')}>
                Image
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Plot/Export menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 px-2" disabled={running}>
                <FileDown size={14} />
                <span className="ml-1 hidden 2xl:inline">Export</span>
                <ChevronDown size={10} className="ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-slate-900 border-slate-700">
              <DropdownMenuLabel className="text-slate-300">Plot Schematic</DropdownMenuLabel>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handlePlotPDF}>
                PDF
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handlePlotSVG}>
                SVG
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handlePlotPNG}>
                PNG (rasterized)
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-slate-700" />
              <DropdownMenuLabel className="text-slate-300">Export Netlist</DropdownMenuLabel>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handleExportSPICE}>
                SPICE Netlist (.cir)
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handleExportKiCadNet}>
                KiCad PCB Netlist (.net)
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-slate-700" />
              <DropdownMenuLabel className="text-slate-300">Export BOM</DropdownMenuLabel>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => handleExportBOM('csv')}>
                BOM CSV
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => handleExportBOM('html')}>
                BOM HTML
              </DropdownMenuItem>
              <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => handleExportBOM('xml')}>
                BOM XML
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* ─── "MORE" DROPDOWN (always visible — contains all secondary actions) ─── */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
              <Settings2 size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 bg-slate-900 border-slate-700 max-h-[80vh] overflow-y-auto">
            {/* File operations */}
            <DropdownMenuLabel className="text-slate-300">File</DropdownMenuLabel>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={handleSave} disabled={running}>
              <Save size={14} className="mr-2" /> Save (JSON)
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => fileInputRef.current?.click()} disabled={running}>
              <Upload size={14} className="mr-2" /> Load (JSON)
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => setShowMyCircuits(true)} disabled={running}>
              <Database size={14} className="mr-2" /> My Circuits
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => setShowSpiceImport(true)} disabled={running}>
              <FileCode size={14} className="mr-2" /> Import SPICE
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => schImportInputRef.current?.click()} disabled={running}>
              <Upload size={14} className="mr-2" /> Import KiCad .sch
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => setShowKiCadLibImport(true)} disabled={running}>
              <Library size={14} className="mr-2" /> Import KiCad Library…
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-slate-700" />
            {/* Design tools */}
            <DropdownMenuLabel className="text-slate-300">Design</DropdownMenuLabel>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => setShowSubCircuit(true)} disabled={running}>
              <Boxes size={14} className="mr-2" /> Sub-Circuit Builder
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => setShowSymbolEditor(true)} disabled={running}>
              <Pencil size={14} className="mr-2" /> Symbol Editor
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => setShowSheets(true)} disabled={running}>
              <BookOpen size={14} className="mr-2" /> Hierarchical Sheets
              {sheets.length > 0 && <span className="ml-auto rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">{sheets.length}</span>}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => setShowFindReplace(true)} disabled={running}>
              <Search size={14} className="mr-2" /> Find / Replace
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-slate-700" />
            {/* ERC */}
            <DropdownMenuLabel className="text-slate-300">Validation</DropdownMenuLabel>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => {
              const result = useEditor.getState().runERC();
              if (result.passed) {
                toast.success(`ERC passed — ${result.stats.warnings} warning(s)`);
              } else {
                toast.warning(`ERC: ${result.stats.errors} error(s), ${result.stats.warnings} warning(s)`);
              }
            }} disabled={running}>
              <ShieldCheck size={14} className="mr-2" /> Run ERC
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-slate-700" />
            {/* View settings */}
            <DropdownMenuLabel className="text-slate-300">View</DropdownMenuLabel>
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <Label htmlFor="grid-switch" className="text-slate-200 text-sm">Show Grid</Label>
              <Switch id="grid-switch" checked={showGrid} onCheckedChange={setShowGrid} />
            </div>
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <Label htmlFor="snap-switch" className="text-slate-200 text-sm">Snap to Grid</Label>
              <Switch id="snap-switch" checked={snapToGrid} onCheckedChange={setSnapToGrid} />
            </div>
            <DropdownMenuCheckboxItem checked={showRefdes} onCheckedChange={setShowRefdes}>
              Show RefDes
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showValues} onCheckedChange={setShowValues}>
              Show Values
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showNetColors} onCheckedChange={setShowNetColors}>
              Color-Code Wires by Net
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator className="bg-slate-700" />
            {/* Theme */}
            <DropdownMenuLabel className="text-slate-300">Theme</DropdownMenuLabel>
            <div className="flex gap-1 px-2 py-1">
              {(['dark', 'high-contrast'] as const).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={theme === t ? 'default' : 'ghost'}
                  className="flex-1 h-7 text-xs"
                  onClick={() => setTheme(t)}
                >
                  {t === 'high-contrast' ? 'Contrast' : 'Dark'}
                </Button>
              ))}
            </div>
            <DropdownMenuSeparator className="bg-slate-700" />
            {/* Settings */}
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer" onClick={() => setShowSettings(true)}>
              <Settings2 size={14} className="mr-2" /> Settings (hotkeys, etc.)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Hidden file inputs */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleLoad}
          className="hidden"
        />
        <input
          ref={schImportInputRef}
          type="file"
          accept=".kicad_sch,.sch,application/json"
          onChange={handleSchImport}
          className="hidden"
        />

        {/* Clear button — right-aligned, always visible */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-rose-400 hover:text-rose-300"
                onClick={() => {
                  // In-app dialog (never native confirm — those block the page
                  // and silently no-op in sandboxed preview iframes).
                  confirmDialog({
                    title: 'Clear the entire circuit?',
                    description: 'Removes all components and wires from the canvas. You can undo with Ctrl+Z.',
                    confirmLabel: 'Clear',
                    danger: true,
                  }).then((ok) => {
                    if (ok) clear();
                  });
                }}
                disabled={running}
              >
                <Trash2 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{running ? 'Pause simulation to clear' : 'Clear all'}</TooltipContent>
          </Tooltip>
        </div>
      </div>


      {/* Dialogs */}
      <MyCircuitsDialog open={showMyCircuits} onClose={() => setShowMyCircuits(false)} />
      <SpiceImportDialog open={showSpiceImport} onClose={() => setShowSpiceImport(false)} />
      <SubCircuitDialog open={showSubCircuit} onClose={() => setShowSubCircuit(false)} />
      <SymbolEditorDialog
        open={showSymbolEditor}
        onClose={() => setShowSymbolEditor(false)}
        onSaved={() => {
          // Notify the component palette to refresh — newly registered plugin
          // won't show up otherwise because it uses a memoized empty-deps fetch.
          window.dispatchEvent(new CustomEvent('circuitlab:plugin-registered'));
        }}
      />
      <KiCadLibraryImportDialog open={showKiCadLibImport} onClose={() => setShowKiCadLibImport(false)} />
      <FindReplaceDialog open={showFindReplace} onClose={() => setShowFindReplace(false)} />
      <ViolationsBrowserDialog open={showViolations} onClose={() => setShowViolations(false)} />
      <NetInspectorDialog open={showNetInspector} onClose={() => setShowNetInspector(false)} />
      <NetClassesDialog open={showNetClasses} onClose={() => setShowNetClasses(false)} />
      <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
      <HierarchicalSheetsDialog open={showSheets} onClose={() => setShowSheets(false)} />
      <PageSetupDialog open={showPageSetup} onClose={() => setShowPageSetup(false)} />
      <SavedViewsDialog open={showSavedViews} onClose={() => setShowSavedViews(false)} camera={camera} />
      {/* Simulation analysis dialogs */}
      <AnalysisDialog open={showAnalysis} onClose={() => setShowAnalysis(false)} />
      <OptionsDialog open={showOptions} onClose={() => setShowOptions(false)} />
      <MeasurementDialog open={showMeasurement} onClose={() => setShowMeasurement(false)} />
      <BatchSweepDialog open={showBatchSweep} onClose={() => setShowBatchSweep(false)} />
      <StimuliEditorDialog open={showStimuliEditor} onClose={() => setShowStimuliEditor(false)} />
    </TooltipProvider>
  );
}

// Trigger button + searchable accordion dialog for the example library.
// (The old flat dropdown didn't scale to 45 circuits / 12 categories.)
function ExamplesDialogButton({
  loadDocument,
  disabled,
}: {
  loadDocument: (doc: CircuitDocument) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" className="h-7 px-2" disabled={disabled} onClick={() => setOpen(true)}>
        <FileText size={14} />
        <span className="ml-1 hidden 2xl:inline">Examples</span>
      </Button>
      <ExamplesDialog open={open} onOpenChange={setOpen} loadDocument={loadDocument} />
    </>
  );
}
