'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { exampleCategories } from '@/lib/circuit/examples';
import { toast } from 'sonner';
import {
  Play, Pause, SkipForward, Save, Upload, Trash2, Undo2, Redo2, Gauge, Zap,
  FileText, ChevronDown, Settings2, Database, FileCode, Boxes, ShieldCheck,
  Search, FileDown, Network, Layers, BookOpen, Wand2, Ruler, Pencil,
  Activity, Sliders, Sigma, Waves, ChevronRight, ChevronLeft, RotateCcw,
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
import { SpiceImportDialog } from './SpiceImportDialog';
import { SubCircuitDialog } from './SubCircuitDialog';
import { SymbolEditorDialog } from './SymbolEditorDialog';
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

export function Toolbar() {
  const running = useEditor((s) => s.running);
  const speed = useEditor((s) => s.speed);
  const dt = useEditor((s) => s.dt);
  const simError = useEditor((s) => s.simError);
  const setRunning = useEditor((s) => s.setRunning);
  const setSpeed = useEditor((s) => s.setSpeed);
  const setDt = useEditor((s) => s.setDt);
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
  const units = useEditor((s) => s.units);
  const setUnits = useEditor((s) => s.setUnits);
  const showPinNumbers = useEditor((s) => s.showPinNumbers);
  const setShowPinNumbers = useEditor((s) => s.setShowPinNumbers);
  const showPinNames = useEditor((s) => s.showPinNames);
  const setShowPinNames = useEditor((s) => s.setShowPinNames);
  const showPinElecTypes = useEditor((s) => s.showPinElecTypes);
  const setShowPinElecTypes = useEditor((s) => s.setShowPinElecTypes);
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

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const schImportInputRef = useRef<HTMLInputElement | null>(null);
  const [showMyCircuits, setShowMyCircuits] = useState(false);
  const [showSpiceImport, setShowSpiceImport] = useState(false);
  const [showSubCircuit, setShowSubCircuit] = useState(false);
  const [showSymbolEditor, setShowSymbolEditor] = useState(false);
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
          console.log('Import warnings:', result.warnings);
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
    const ext = format;
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
      <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900 px-3 py-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* Brand */}
        <div className="mr-2 flex flex-shrink-0 items-center gap-2 pr-3">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-cyan-400 to-emerald-500 text-slate-900">
            <Zap size={16} strokeWidth={2.5} />
          </div>
          <span className="hidden text-sm font-semibold text-slate-100 sm:inline">CircuitLab</span>
        </div>

        {/* Hierarchical sheet breadcrumb — sticky, prominent when inside a sub-sheet.
            Shows Root / Sub-sheet with a left-arrow icon for back navigation. */}
        {activeSheet && (
          <div
            className="mr-2 flex flex-shrink-0 items-center gap-1 rounded-md border border-emerald-700/50 bg-emerald-950/40 px-2 py-1 text-xs font-mono whitespace-nowrap shadow-sm"
            role="navigation"
            aria-label="Sheet hierarchy breadcrumb"
          >
            <button
              className="flex cursor-pointer items-center gap-0.5 text-slate-300 hover:text-emerald-300 transition-colors"
              onClick={() => setActiveSheet('')}
              title="Back to root sheet (Esc)"
            >
              <ChevronLeft size={12} />
              <span>Root</span>
            </button>
            <ChevronRight size={12} className="text-slate-500" />
            <span className="font-semibold text-emerald-300">
              {sheets.find((s) => s.fileName === activeSheet)?.sheetName ??
                childSheets[activeSheet]?.sheets?.find?.((s: any) => s.fileName === activeSheet)?.sheetName ??
                activeSheet.replace(/\.kicad_sch$/, '')}
            </span>
            {/* Pin count badge */}
            {(() => {
              const sheet = sheets.find((s) => s.fileName === activeSheet);
              const pinCount = sheet?.pins?.length ?? 0;
              return pinCount > 0 ? (
                <span className="ml-1 rounded-full bg-emerald-700/40 px-1.5 py-0.5 text-[10px] text-emerald-200" title="Sheet pin count">
                  {pinCount} pin{pinCount !== 1 ? 's' : ''}
                </span>
              ) : null;
            })()}
          </div>
        )}

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
            <Button size="sm" variant="ghost" onClick={() => step()} disabled={running}>
              <SkipForward size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Single step</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => reset()} disabled={running}>
              <RotateCcw size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset simulation (stops + clears state)</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px flex-shrink-0 bg-slate-700" />

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

        <div className="mx-1 h-5 w-px flex-shrink-0 bg-slate-700" />

        {/* Undo / Redo */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => undo()} disabled={past === 0 || running}>
              <Undo2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause to undo' : 'Undo (Ctrl+Z)'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => redo()} disabled={future === 0 || running}>
              <Redo2 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause to redo' : 'Redo (Ctrl+Y)'}</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px flex-shrink-0 bg-slate-700" />

        {/* Examples */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={running}>
              <FileText size={14} />
              <span className="ml-1 hidden md:inline">Examples</span>
              <ChevronDown size={12} className="ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 bg-slate-900 border-slate-700 max-h-[70vh] overflow-y-auto">
            <DropdownMenuLabel className="text-slate-300">Load Example Circuit</DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-slate-700" />
            {exampleCategories.map((cat) => (
              <DropdownMenuGroup key={cat.label}>
                <DropdownMenuLabel className="text-xs text-cyan-400 font-semibold uppercase tracking-wide px-2 pt-3 pb-1">
                  {cat.label}
                </DropdownMenuLabel>
                {cat.examples.map((ex) => (
                  <DropdownMenuItem
                    key={ex.name}
                    onClick={() => loadDocument(ex.doc)}
                    className="flex flex-col items-start gap-1 py-2 text-slate-200 hover:bg-slate-800"
                  >
                    <span className="text-sm font-medium">{ex.name}</span>
                    <span className="text-xs text-slate-400">{ex.description}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Database (My Circuits) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowMyCircuits(true)} disabled={running}>
              <Database size={14} />
              <span className="ml-1 hidden lg:inline">My Circuits</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause simulation to manage saved circuits' : 'Open the saved circuits library (database)'}</TooltipContent>
        </Tooltip>

        {/* SPICE Import */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowSpiceImport(true)} disabled={running}>
              <FileCode size={14} />
              <span className="ml-1 hidden lg:inline">SPICE</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause simulation to import SPICE' : 'Import a SPICE netlist (.cir / .net)'}</TooltipContent>
        </Tooltip>

        {/* Sub-Circuit builder */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowSubCircuit(true)} disabled={running}>
              <Boxes size={14} />
              <span className="ml-1 hidden lg:inline">Sub-Circuit</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause simulation to create sub-circuits' : 'Convert current circuit into a reusable component'}</TooltipContent>
        </Tooltip>

        {/* Symbol Editor — WYSIWYG symbol designer */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowSymbolEditor(true)} disabled={running}>
              <Pencil size={14} />
              <span className="ml-1 hidden lg:inline">Symbol Editor</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{running ? 'Pause simulation to design symbols' : 'Open the WYSIWYG symbol editor to design new component symbols'}</TooltipContent>
        </Tooltip>

        {/* ERC (Electrical Rule Check) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => {
              const result = useEditor.getState().runERC();
              if (result.passed) {
                toast.success(`ERC passed — ${result.stats.warnings} warning(s)`);
              } else {
                toast.warning(`ERC: ${result.stats.errors} error(s), ${result.stats.warnings} warning(s)`);
              }
            }} disabled={running}>
              <ShieldCheck size={14} />
              <span className="ml-1 hidden lg:inline">ERC</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Electrical Rule Check — find unconnected pins, power shorts, conflicting drivers</TooltipContent>
        </Tooltip>

        {/* Find */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => setShowFindReplace(true)} disabled={running}>
              <Search size={14} />
              <span className="ml-1 hidden lg:inline">Find</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Find / Replace (Ctrl+F)</TooltipContent>
        </Tooltip>

        {/* Simulate menu — KiCad/ngspice parity */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <Activity size={14} />
              <span className="ml-1 hidden lg:inline">Simulate</span>
              <ChevronDown size={12} className="ml-1" />
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
              <Waves size={14} className="mr-2" /> Batch Sweep / Monte Carlo (.step/.mc/.worst)
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
              onClick={() => setShowMeasurement(true)}>
              <Sigma size={14} className="mr-2" /> Measurements (.meas)
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
              onClick={() => setShowStimuliEditor(true)}>
              <Wand2 size={14} className="mr-2" /> Stimuli Editor (PWL/SINE/PULSE/SFFM/EXP)
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
              onClick={() => setShowOptions(true)}>
              <Sliders size={14} className="mr-2" /> Simulation Options (reltol/gmin/method/temp)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Inspect: ERC violations + Net inspector + Net classes */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={running}>
              <Network size={14} />
              <span className="ml-1 hidden lg:inline">Inspect</span>
              <ChevronDown size={12} className="ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 bg-slate-900 border-slate-700">
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
              onClick={() => setShowViolations(true)}>
              <ShieldCheck size={14} className="mr-2" /> ERC Violations Browser
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
              <Ruler size={14} className="mr-2" /> Page Setup & Title Block
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
              onClick={() => setShowSavedViews(true)}>
              <Layers size={14} className="mr-2" /> Saved Views
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Tools toolbar — left-rail tools (Wire / Bus / Label / etc.) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={running}>
              <Pencil size={14} />
              <span className="ml-1 hidden lg:inline">Tools</span>
              <ChevronDown size={12} className="ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 bg-slate-900 border-slate-700">
            <DropdownMenuLabel className="text-slate-300">Schematic Tools</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'wire'} onCheckedChange={() => setActiveTool(activeTool === 'wire' ? 'select' : 'wire')}>
              Wire
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'bus'} onCheckedChange={() => setActiveTool(activeTool === 'bus' ? 'select' : 'bus')}>
              Bus
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'label'} onCheckedChange={() => setActiveTool(activeTool === 'label' ? 'select' : 'label')}>
              Local Label
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'globalLabel'} onCheckedChange={() => setActiveTool(activeTool === 'globalLabel' ? 'select' : 'globalLabel')}>
              Global Label
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'hierLabel'} onCheckedChange={() => setActiveTool(activeTool === 'hierLabel' ? 'select' : 'hierLabel')}>
              Hierarchical Label
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'junction'} onCheckedChange={() => setActiveTool(activeTool === 'junction' ? 'select' : 'junction')}>
              Junction
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'noConnect'} onCheckedChange={() => setActiveTool(activeTool === 'noConnect' ? 'select' : 'noConnect')}>
              No-Connect (N)
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'powerPort'} onCheckedChange={() => setActiveTool(activeTool === 'powerPort' ? 'select' : 'powerPort')}>
              Power Port
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuLabel className="text-slate-300">Drawing Primitives</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'text'} onCheckedChange={() => setActiveTool(activeTool === 'text' ? 'select' : 'text')}>
              Text
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'line'} onCheckedChange={() => setActiveTool(activeTool === 'line' ? 'select' : 'line')}>
              Line
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'poly'} onCheckedChange={() => setActiveTool(activeTool === 'poly' ? 'select' : 'poly')}>
              Polygon
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={activeTool === 'image'} onCheckedChange={() => setActiveTool(activeTool === 'image' ? 'select' : 'image')}>
              Image
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Hierarchical Sheets — quick actions */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={running}
              onClick={() => setShowSheets(true)}
              className="text-slate-300"
            >
              <BookOpen size={14} />
              <span className="ml-1 hidden lg:inline">Sheets</span>
              {sheets.length > 0 && (
                <span className="ml-1 rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">
                  {sheets.length}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Manage hierarchical sheets</TooltipContent>
        </Tooltip>

        {/* Plot menu — PDF/SVG/PNG */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={running}>
              <FileDown size={14} />
              <span className="ml-1 hidden lg:inline">Plot</span>
              <ChevronDown size={12} className="ml-1" />
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

        {/* Settings — theme + hotkeys */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowSettings(true)}
              className="text-slate-300"
            >
              <Settings2 size={14} />
              <span className="ml-1 hidden lg:inline">Settings</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Theme + hotkey customization</TooltipContent>
        </Tooltip>

        {/* Import KiCad / Eagle schematic */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => schImportInputRef.current?.click()} disabled={running}>
              <Upload size={14} />
              <span className="ml-1 hidden lg:inline">Import .sch</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Import KiCad .kicad_sch or Eagle .sch</TooltipContent>
        </Tooltip>
        <input
          ref={schImportInputRef}
          type="file"
          accept=".kicad_sch,.sch,application/json"
          onChange={handleSchImport}
          className="hidden"
        />

        {/* Settings */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <Settings2 size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 bg-slate-900 border-slate-700">
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
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuLabel className="text-slate-300">Display</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={showRefdes} onCheckedChange={setShowRefdes}>
              Show Reference Designators
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showValues} onCheckedChange={setShowValues}>
              Show Values
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showPinNumbers} onCheckedChange={setShowPinNumbers}>
              Show Pin Numbers
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showPinNames} onCheckedChange={setShowPinNames}>
              Show Pin Names
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showPinElecTypes} onCheckedChange={setShowPinElecTypes}>
              Show Pin Electrical Types
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showNetColors} onCheckedChange={setShowNetColors}>
              Color-Code Wires by Net
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuLabel className="text-slate-300">Theme</DropdownMenuLabel>
            <div className="flex gap-1 px-2 py-1">
              {(['dark', 'high-contrast'] as const).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={theme === t ? 'default' : 'ghost'}
                  className="flex-1 h-7 text-xs"
                  onClick={() => setTheme(t)}
                  title={t === 'high-contrast' ? 'WCAG AAA high-contrast theme for low-vision users' : 'Default dark theme'}
                >
                  {t === 'high-contrast' ? 'High Contrast' : 'Dark'}
                </Button>
              ))}
            </div>
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuLabel className="text-slate-300">Units</DropdownMenuLabel>
            <div className="flex gap-1 px-2 py-1">
              {(['grid', 'mm', 'mil', 'in'] as const).map((u) => (
                <Button
                  key={u}
                  size="sm"
                  variant={units === u ? 'default' : 'ghost'}
                  className="flex-1 h-7 text-xs"
                  onClick={() => setUnits(u)}
                >
                  {u}
                </Button>
              ))}
            </div>
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuLabel className="text-slate-300">Schematic Tools</DropdownMenuLabel>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
              onClick={() => {
                if (running) return;
                useEditor.getState().reannotateByPosition();
                toast.success('Re-annotated by X-then-Y position');
              }}
              disabled={running}
            >
              Re-annotate (by position)
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
              onClick={() => {
                if (running) return;
                useEditor.getState().reannotate();
                toast.success('Re-annotated (insertion order)');
              }}
              disabled={running}
            >
              Re-annotate (insertion order)
            </DropdownMenuItem>
            <DropdownMenuItem className="text-slate-200 hover:bg-slate-800 cursor-pointer"
              onClick={() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\' }));
                toast.info('Toggled 45° wire routing');
              }}
            >
              Toggle 45° Wire Routing
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex flex-shrink-0 items-center gap-1">
          {/* Save / Load / Clear */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={handleSave} disabled={running}>
                <Save size={14} />
                <span className="ml-1 hidden md:inline">Save</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{running ? 'Pause simulation to save' : 'Download circuit as JSON'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={running}>
                <Upload size={14} />
                <span className="ml-1 hidden md:inline">Load</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{running ? 'Pause simulation to load' : 'Load circuit from JSON'}</TooltipContent>
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
                disabled={running}
                className="text-rose-400 hover:text-rose-300"
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
