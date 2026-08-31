'use client';

import { useMemo } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin } from '@/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '@/lib/circuit/engine';
import type { ComponentPlugin, ParameterDef, PinElecType, TerminalDef } from '@/lib/circuit/types';
import { RotateCw, Trash2, X, Info, Sparkles, Pin, Cable, Activity, Pause, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

// ─────────────────────────────────────────────────────────────────────────────
// Category badges / pin electrical-type colour coding (matches the palette:
// inputs cyan · outputs emerald · power amber · bidirectional + tri-state
// violet · passive/other slate)
// ─────────────────────────────────────────────────────────────────────────────

const categoryLabels: Record<string, string> = {
  io: 'I/O',
  source: 'Source',
  passive: 'Passive',
  semiconductor: 'Semiconductor',
  ic: 'IC',
  logic: 'Logic',
  meter: 'Meter',
  mcu: 'MCU',
  sensor: 'Sensor',
};

function prettyCategory(category: string): string {
  return categoryLabels[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

const PIN_ELEC_COLORS: Record<PinElecType, string> = {
  input: '#22d3ee', // cyan-400
  tri_state: '#a78bfa', // violet-400 (grouped with bidirectional)
  output: '#34d399', // emerald-400
  open_collector: '#34d399',
  open_emitter: '#34d399',
  bidirectional: '#a78bfa', // violet-400
  power_in: '#fbbf24', // amber-400
  power_out: '#fbbf24',
  passive: '#94a3b8', // slate-400
  unconnected: '#64748b',
  nc: '#64748b',
  free: '#94a3b8',
  unspecified: '#94a3b8',
};

const PIN_ELEC_LABELS: Record<PinElecType, string> = {
  input: 'Input',
  output: 'Output',
  bidirectional: 'Bidirectional',
  tri_state: 'Tri-state',
  passive: 'Passive',
  power_in: 'Power In',
  power_out: 'Power Out',
  open_collector: 'Open Collector',
  open_emitter: 'Open Emitter',
  unconnected: 'Unconnected',
  nc: 'No Connect',
  free: 'Free',
  unspecified: 'Unspecified',
};

function pinColor(type: PinElecType | undefined): string {
  return PIN_ELEC_COLORS[type ?? 'passive'] ?? '#94a3b8';
}

function pinLabel(type: PinElecType | undefined): string {
  return PIN_ELEC_LABELS[type ?? 'passive'] ?? 'Passive';
}

/** Coarse colour group (for the compact legend under the pin table). */
function pinGroup(type: PinElecType | undefined): { label: string; color: string } {
  switch (type) {
    case 'input':
      return { label: 'Input', color: '#22d3ee' };
    case 'tri_state':
      return { label: 'Tri-state', color: '#a78bfa' };
    case 'output':
    case 'open_collector':
    case 'open_emitter':
      return { label: 'Output', color: '#34d399' };
    case 'power_in':
    case 'power_out':
      return { label: 'Power', color: '#fbbf24' };
    case 'bidirectional':
      return { label: 'Bidirectional', color: '#a78bfa' };
    default:
      return { label: 'Passive', color: '#94a3b8' };
  }
}

/** Colored dot marking a terminal's electrical type. */
function PinDot({ type, className = '' }: { type: PinElecType | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full border border-black/40 ${className}`}
      style={{ backgroundColor: pinColor(type) }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

/** SI-prefixed value formatting: 1000 → "1.00 k", 4.7e-6 → "4.70 µ". */
function formatSI(v: number, unit?: string): string {
  if (!isFinite(v)) return String(v);
  const a = Math.abs(v);
  const suffix = (prefix: string) => `${prefix}${unit ?? ''}`.trim();
  if (a === 0) return `0 ${suffix('')}`.trim();
  const steps: [number, string][] = [
    [1e18, 'E'],
    [1e15, 'P'],
    [1e12, 'T'],
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
    [1e-9, 'n'],
    [1e-12, 'p'],
  ];
  for (const [scale, prefix] of steps) {
    if (a >= scale) {
      const n = v / scale;
      const digits = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
      return `${n.toFixed(digits)} ${suffix(prefix)}`.trim();
    }
  }
  return `${v.toExponential(2)} ${suffix('')}`.trim();
}

/** Voltage formatting with adaptive units: 12 V · 0.65 V · 4.2 mV · 12.0 µV. */
function formatVolts(v: number): string {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100) return `${v.toFixed(1)} V`;
  if (a >= 1) return `${v.toFixed(2)} V`;
  if (a >= 0.001) return `${(v * 1000).toFixed(2)} mV`;
  if (a >= 1e-6) return `${(v * 1e6).toFixed(1)} µV`;
  return v === 0 ? '0 V' : `${(v * 1e6).toFixed(1)} µV`;
}

/** True when the current value differs from the parameter's default.
 *  Loose String() comparison on both sides: harmless type drift (4.7 vs
 *  "4.7", true vs "true") must not surface a spurious reset button, while a
 *  genuine change — or a broken null value — must. */
function valueDiffersFromDefault(
  def: ParameterDef,
  value: number | string | boolean | undefined,
): boolean {
  if (def.default === undefined) return false;
  return String(value) !== String(def.default);
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────────────────────────────────────

export function PropertyPanel() {
  const selection = useEditor((s) => s.selection);
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const multiSelection = useEditor((s) => s.multiSelection);
  const setParameter = useEditor((s) => s.setParameter);
  const rotateComponent = useEditor((s) => s.rotateComponent);
  const deleteComponent = useEditor((s) => s.deleteComponent);
  const setSelection = useEditor((s) => s.setSelection);
  const alignSelected = useEditor((s) => s.alignSelected);
  const distributeSelected = useEditor((s) => s.distributeSelected);
  const simContext = useEditor((s) => s.simContext);
  const running = useEditor((s) => s.running);

  const comp = useMemo(
    () => components.find((c) => c.id === selection.id) ?? null,
    [components, selection.id],
  );

  const plugin = useMemo(() => (comp ? getPlugin(comp.type) : null), [comp]);

  // Resolve each terminal of the selected component to its electrical node,
  // so the pin table can show live node voltages. (buildNodeMap is cached on
  // components/wires identity, so the extra call is cheap.)
  const terminalNodes = useMemo(() => {
    if (!comp || !plugin) return null;
    try {
      const plugins = new Map<string, ComponentPlugin>();
      for (const c of components) {
        const p = getPlugin(c.type);
        if (p) plugins.set(c.type, p);
      }
      const nodeMap = buildNodeMap(components, wires, plugins);
      return getTerminalsForComponent(comp, plugin, nodeMap);
    } catch {
      return null;
    }
  }, [comp, plugin, components, wires]);

  // find measurements for this component
  const measurements = useMemo(() => {
    if (!comp || !plugin || !plugin.measure || !simContext) return [];
    try {
      // Build node map to resolve terminal node IDs
      const plugins = new Map<string, ComponentPlugin>();
      for (const c of components) {
        const p = getPlugin(c.type);
        if (p) plugins.set(c.type, p);
      }
      const nodeMap = buildNodeMap(components, wires, plugins);
      const terms = getTerminalsForComponent(comp, plugin, nodeMap);
      return plugin.measure(comp.parameters, terms, simContext, comp);
    } catch {
      return [];
    }
  }, [comp, plugin, simContext, components, wires]);

  // Node voltages read straight from the simulation context: live while the
  // sim runs, frozen at the last step while paused, null once stopped or
  // never run (pins then show "—" with a hint to run the simulation).
  const nodeVoltageAt = useMemo(() => {
    if (!simContext) return null;
    const nv = simContext.nodeVoltage;
    return (nodeId: number) => {
      if (nodeId < 0 || nodeId >= nv.length) return null;
      const v = nv[nodeId];
      return isFinite(v) ? v : null;
    };
  }, [simContext]);

  // Multi-edit mode: when 2+ components are selected, show common parameters
  const multiCompIds = new Set(multiSelection.components);
  if (selection.type === 'component' && selection.id) multiCompIds.add(selection.id);
  const multiComps = components.filter(c => multiCompIds.has(c.id));
  if (multiComps.length >= 2) {
    // Find common parameters across all selected components
    const firstPlugin = getPlugin(multiComps[0].type);
    const commonParams: ParameterDef[] = [];
    if (firstPlugin) {
      for (const param of firstPlugin.parameters) {
        const allHave = multiComps.every(c => {
          const p = getPlugin(c.type);
          return p && p.parameters.some(pp => pp.key === param.key && pp.type === param.type);
        });
        if (allHave) commonParams.push(param);
      }
    }
    return (
      <div className="flex h-full flex-col bg-slate-900" role="complementary" aria-label="Property panel">
        <div className="border-b border-slate-800 p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Multi-Edit</h2>
          <p className="mt-1 text-xs text-slate-500">{multiComps.length} components selected</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* Alignment tools */}
          <div className="space-y-2 border-b border-slate-800 p-3">
            <Label className="text-xs text-slate-400">Alignment</Label>
            <div className="grid grid-cols-3 gap-1">
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => alignSelected('x', 'min')}>Left</Button>
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => alignSelected('x', 'center')}>Center X</Button>
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => alignSelected('x', 'max')}>Right</Button>
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => alignSelected('y', 'min')}>Top</Button>
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => alignSelected('y', 'center')}>Center Y</Button>
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => alignSelected('y', 'max')}>Bottom</Button>
            </div>
          </div>
          <div className="space-y-2 border-b border-slate-800 p-3">
            <Label className="text-xs text-slate-400">Distribute</Label>
            <div className="grid grid-cols-2 gap-1">
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => distributeSelected('x')} disabled={multiComps.length < 3}>Horizontal</Button>
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => distributeSelected('y')} disabled={multiComps.length < 3}>Vertical</Button>
            </div>
          </div>
          {/* Common parameters */}
          {commonParams.length > 0 && (
            <div className="space-y-2.5 p-3">
              <Label className="text-xs text-slate-400">Common Parameters</Label>
              {commonParams.map((param) => (
                <div key={param.key}>
                  <Label className="text-xs text-slate-300">{param.label}{param.unit ? ` (${param.unit})` : ''}</Label>
                  {param.type === 'number' && (
                    <Input
                      type="number"
                      className="mt-1 h-8 bg-slate-800"
                      placeholder="varies"
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (isNaN(val)) return;
                        for (const c of multiComps) {
                          setParameter(c.id, param.key, val);
                        }
                      }}
                    />
                  )}
                  {param.type === 'boolean' && (
                    <Switch
                      className="mt-1"
                      onCheckedChange={(v) => {
                        for (const c of multiComps) setParameter(c.id, param.key, v);
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!comp || !plugin) {
    return (
      <div className="flex h-full flex-col bg-slate-900" role="complementary" aria-label="Property panel">
        <div className="border-b border-slate-800 p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Properties</h2>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-800 bg-slate-800/40">
            <Info size={18} className="text-slate-600" />
          </div>
          <p className="text-xs text-slate-500">Select a component on the canvas to edit its parameters.</p>
        </div>
      </div>
    );
  }

  const nodeIdByTerminal = new Map<string, number>();
  if (terminalNodes) {
    for (const t of terminalNodes) nodeIdByTerminal.set(t.terminalId, t.nodeId);
  }
  // Which terminals of the selected component have a wire attached? (A pin
  // that resolves to node 0 without being wired is floating, not grounded.)
  const wiredTerminals = new Set<string>();
  for (const w of wires) {
    if (w.from.componentId === comp.id) wiredTerminals.add(w.from.terminalId);
    if (w.to.componentId === comp.id) wiredTerminals.add(w.to.terminalId);
  }

  return (
    <div className="flex h-full flex-col bg-slate-900" role="complementary" aria-label="Property panel">
      {/* Header */}
      <div className="border-b border-slate-800 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-500/30 bg-gradient-to-br from-cyan-500/20 via-slate-900 to-slate-950 text-sm font-bold text-cyan-300 shadow-inner">
              {plugin.symbol}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-slate-100">{plugin.name}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <Badge variant="outline" className="border-slate-700 px-1.5 text-[9px] uppercase tracking-wider text-slate-400">
                  {prettyCategory(plugin.category)}
                </Badge>
                <span className="font-mono text-[9px] text-slate-500">{plugin.terminals.length} {plugin.terminals.length === 1 ? 'pin' : 'pins'}</span>
              </div>
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0 text-slate-400 hover:text-slate-200"
            onClick={() => setSelection({ type: null, id: null })}
            title="Deselect"
            aria-label="Deselect component"
          >
            <X size={14} />
          </Button>
        </div>
        <p className="mt-2 text-xs leading-snug text-slate-400">{plugin.description}</p>
      </div>

      {/* Actions */}
      <div className="flex gap-1 border-b border-slate-800 p-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
          onClick={() => rotateComponent(comp.id)}
          disabled={running}
          title={running ? 'Pause simulation to rotate' : 'Rotate component'}
        >
          <RotateCw size={12} className="mr-1" />
          Rotate (R)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-rose-900 bg-rose-950/50 text-rose-300 hover:bg-rose-900/50 disabled:opacity-40"
          onClick={() => deleteComponent(comp.id)}
          disabled={running}
          title={running ? 'Pause simulation to delete' : 'Delete component'}
        >
          <Trash2 size={12} className="mr-1" />
          Delete
        </Button>
      </div>

      {/* Ask AI to explain this component */}
      <div className="border-b border-slate-800 p-2">
        <Button
          size="sm"
          variant="outline"
          className="w-full cursor-pointer border-cyan-700 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-900/50"
          onClick={() => {
            const prompt = `Explain component ${comp.id} (${plugin.name}). What does it do, how does it work, and what should I watch out for? Also check if its current parameter values are appropriate for this circuit.`;
            window.dispatchEvent(new CustomEvent('circuitlab:ask-ai', { detail: prompt }));
          }}
          title="Ask AI to explain this component"
        >
          <Sparkles size={12} className="mr-1" />
          Ask AI to explain
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Pins — terminal table with live node voltages (read-only, stays
            interactive while the simulation runs). */}
        <PinsSection
          plugin={plugin}
          nodeIdByTerminal={nodeIdByTerminal}
          wiredTerminals={wiredTerminals}
          getVoltage={nodeVoltageAt}
        />

        {/* Parameters */}
        <div className={`border-b border-slate-800 p-3 ${running ? 'pointer-events-none opacity-50' : ''}`}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <SlidersHorizontal size={11} className="text-slate-500" />
              Parameters
            </div>
            {plugin.parameters.length > 0 && (
              <span className="font-mono text-[9px] text-slate-500">{plugin.parameters.length}</span>
            )}
          </div>
          {running && (
            <div className="mb-3 flex items-center justify-center gap-1.5 rounded-md border border-amber-700/50 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-300">
              <Pause size={10} />
              Pause simulation to edit parameters
            </div>
          )}
          {plugin.parameters.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-500">No editable parameters.</p>
          ) : (
            <div className="space-y-2.5">
              {plugin.parameters.map((p) => (
                <ParameterEditor
                  key={p.key}
                  def={p}
                  value={comp.parameters[p.key]}
                  onChange={(v) => setParameter(comp.id, p.key, v)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Live measurements (while the simulation runs) */}
        {measurements.length > 0 && (
          <div className="border-b border-slate-800 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <Activity size={11} className="text-emerald-400" />
              Live Measurements
            </div>
            <div className="space-y-1">
              {measurements.map((m, i) => (
                <div
                  key={`${m.label}-${i}`}
                  className="flex items-baseline justify-between gap-2 rounded-md border border-slate-800/60 bg-slate-950/40 px-2 py-1"
                >
                  <span className="text-[10px] text-slate-400">{m.label}</span>
                  <span className="font-mono text-[11px] tabular-nums text-cyan-200">
                    {m.value}
                    {m.unit ? ` ${m.unit}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Position info */}
        <div className="p-3">
          <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Instance</div>
            <div className="font-mono text-[10px] text-slate-400">{comp.id}</div>
            <div className="mt-1 font-mono text-[10px] text-slate-500">
              pos: ({comp.position.x.toFixed(1)}, {comp.position.y.toFixed(1)}) · rot: {comp.rotation * 90}°
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pins section — terminal table with electrical types + live voltages
// ─────────────────────────────────────────────────────────────────────────────

function PinsSection({
  plugin,
  nodeIdByTerminal,
  wiredTerminals,
  getVoltage,
}: {
  plugin: ComponentPlugin;
  nodeIdByTerminal: Map<string, number>;
  wiredTerminals: Set<string>;
  getVoltage: ((nodeId: number) => number | null) | null;
}) {
  // Legend entries: unique electrical-type groups used by this component.
  const legend = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of plugin.terminals) {
      const g = pinGroup(t.electricalType);
      if (!seen.has(g.label)) seen.set(g.label, g.color);
    }
    return Array.from(seen, ([label, color]) => ({ label, color }));
  }, [plugin]);

  return (
    <div className="border-b border-slate-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          <Pin size={11} className="text-cyan-400" />
          Pins
        </div>
        <span className="font-mono text-[9px] text-slate-500">
          {plugin.terminals.length} {plugin.terminals.length === 1 ? 'terminal' : 'terminals'}
        </span>
      </div>

      <div className="max-h-80 divide-y divide-slate-800/60 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/50 shadow-inner">
        {plugin.terminals.map((t) => {
          const nodeId = nodeIdByTerminal.get(t.id);
          // Hidden power pins are auto-connected by net name — treat as wired.
          const wired = wiredTerminals.has(t.id) || !!t.hidden;
          const voltage = wired && nodeId !== undefined && getVoltage ? getVoltage(nodeId) : null;
          return (
            <PinRow
              key={t.id}
              terminal={t}
              nodeId={nodeId}
              voltage={voltage}
              wired={wired}
            />
          );
        })}
      </div>

      {/* Electrical-type colour legend */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-0.5">
        {legend.map((g) => (
          <span key={g.label} className="flex items-center gap-1 text-[9px] text-slate-500">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full border border-black/40"
              style={{ backgroundColor: g.color }}
            />
            {g.label}
          </span>
        ))}
      </div>

      {/* Wire hint */}
      <div className="mt-2 flex items-start gap-1.5 rounded-md border border-slate-800/70 bg-slate-800/30 px-2 py-1.5 text-[9px] leading-snug text-slate-500">
        <Cable size={10} className="mt-px shrink-0" />
        Wire tool (W) connects pins — click a pin on the canvas
      </div>
    </div>
  );
}

/** One terminal row: dot, label, id, pin number, electrical type, live voltage. */
function PinRow({
  terminal,
  nodeId,
  voltage,
  wired,
}: {
  terminal: TerminalDef;
  nodeId: number | undefined;
  voltage: number | null;
  wired: boolean;
}) {
  const color = pinColor(terminal.electricalType);
  const isGround = wired && nodeId === 0;
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <PinDot type={terminal.electricalType} />
        <span className="shrink-0 text-xs font-semibold text-slate-200">
          {terminal.label || terminal.id}
        </span>
        <code className="min-w-0 truncate font-mono text-xs text-slate-500">{terminal.id}</code>
        {terminal.number != null && terminal.number !== '' && (
          <span className="shrink-0 rounded bg-slate-800 px-1 font-mono text-[9px] leading-4 text-slate-400">
            #{terminal.number}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {isGround && (
            <span
              className="rounded bg-slate-800/80 px-1 text-[8px] leading-4 text-slate-400"
              title="Connected to the ground node"
            >
              GND
            </span>
          )}
          <span
            className={`font-mono text-[10px] tabular-nums ${voltage !== null ? 'text-cyan-200' : 'text-slate-600'}`}
            title={
              voltage !== null
                ? 'Live node voltage'
                : wired
                  ? 'Run the simulation to see live voltages'
                  : 'Not connected — click a pin on the canvas or use the Wire tool (W)'
            }
          >
            {voltage !== null ? formatVolts(voltage) : '—'}
          </span>
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[9px]">
        <span className="shrink-0 font-medium tracking-wide" style={{ color }}>
          {pinLabel(terminal.electricalType)}
        </span>
        {terminal.name && terminal.name !== terminal.label && (
          <span className="min-w-0 truncate text-slate-500">· {terminal.name}</span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter editor
// ─────────────────────────────────────────────────────────────────────────────

function ResetToDefaultButton({ label, onReset }: { label: string; onReset: () => void }) {
  return (
    <button
      type="button"
      onClick={onReset}
      title="Reset to default"
      aria-label={`Reset ${label} to default`}
      className="shrink-0 rounded-full p-0.5 text-slate-500 transition-colors duration-150 hover:bg-slate-700/60 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/60"
    >
      <RotateCcw size={12} />
    </button>
  );
}

function ParameterEditor({
  def,
  value,
  onChange,
}: {
  def: ParameterDef;
  value: number | string | boolean | undefined;
  onChange: (v: number | string | boolean) => void;
}) {
  const differs = valueDiffersFromDefault(def, value);

  if (def.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-800/60 bg-slate-800/20 px-2.5 py-2">
        <Label className="min-w-0 cursor-pointer truncate text-xs text-slate-300">{def.label}</Label>
        <span className="flex shrink-0 items-center gap-1.5">
          {differs && <ResetToDefaultButton label={def.label} onReset={() => onChange(def.default)} />}
          <Switch checked={!!value} onCheckedChange={(v) => onChange(v)} />
        </span>
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <div className="space-y-1 rounded-lg border border-slate-800/60 bg-slate-800/20 px-2.5 py-2">
        <div className="flex items-center justify-between gap-1.5">
          <Label className="text-xs text-slate-300">{def.label}</Label>
          {differs && <ResetToDefaultButton label={def.label} onReset={() => onChange(def.default)} />}
        </div>
        <Select value={String(value ?? '')} onValueChange={(v) => onChange(v)}>
          <SelectTrigger className="h-8 border-slate-700 bg-slate-800 text-xs text-slate-200">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-700">
            {def.options?.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs text-slate-200">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {def.description && <p className="text-[10px] leading-snug text-slate-500">{def.description}</p>}
      </div>
    );
  }
  if (def.type === 'color') {
    return (
      <div className="space-y-1 rounded-lg border border-slate-800/60 bg-slate-800/20 px-2.5 py-2">
        <div className="flex items-center justify-between gap-1.5">
          <Label className="text-xs text-slate-300">{def.label}</Label>
          {differs && <ResetToDefaultButton label={def.label} onReset={() => onChange(def.default)} />}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={String(value ?? '#22d3ee')}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-slate-700 bg-slate-800"
          />
          <Input
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 border-slate-700 bg-slate-800 font-mono text-xs text-slate-200"
          />
        </div>
      </div>
    );
  }
  if (def.type === 'string') {
    // Special case: long sketch source code (multi-line) -> use textarea + sample picker
    if (def.key === 'sketch' || (typeof value === 'string' && value.includes('\n'))) {
      const sampleSketches: Record<string, string> = {
        blink: `// Classic blink
loop:
D2 = HIGH
wait 500ms
D2 = LOW
wait 500ms
goto loop`,
        button: `// Read A0, mirror to D3
loop:
if A0 > 2.5 goto on
D3 = LOW
wait 10ms
goto loop
on:
D3 = HIGH
wait 10ms
goto loop`,
        pwm_50: `// Software PWM 50% on D3 at ~1kHz
loop:
D3 = HIGH
wait 0.5ms
D3 = LOW
wait 0.5ms
goto loop`,
        counter: `// 4-bit binary counter on D2-D5
loop:
D2 = HIGH
wait 100ms
D2 = LOW
D3 = HIGH
wait 100ms
D3 = LOW
D4 = HIGH
wait 100ms
D4 = LOW
D5 = HIGH
wait 100ms
D5 = LOW
goto loop`,
      };
      return (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-1.5">
            <Label className="min-w-0 truncate text-xs text-slate-300">{def.label}</Label>
            <span className="flex shrink-0 items-center gap-1.5">
              {differs && <ResetToDefaultButton label={def.label} onReset={() => onChange(def.default)} />}
              <Select onValueChange={(v) => onChange(sampleSketches[v] || '')}>
                <SelectTrigger className="h-6 w-32 border-slate-700 bg-slate-800 text-[10px] text-slate-300">
                  <SelectValue placeholder="Load sample..." />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {Object.keys(sampleSketches).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs text-slate-200">{k}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          </div>
          <textarea
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="min-h-[200px] w-full resize-y rounded border border-slate-700 bg-slate-950 p-2 font-mono text-[11px] leading-snug text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
          <p className="text-[10px] text-slate-500">
            Commands: pin D2 output · D2 = HIGH/LOW · wait 500ms · if A0 &gt; 2.5 goto label · loop: · goto loop
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-1 rounded-lg border border-slate-800/60 bg-slate-800/20 px-2.5 py-2">
        <div className="flex items-center justify-between gap-1.5">
          <Label className="text-xs text-slate-300">{def.label}</Label>
          {differs && <ResetToDefaultButton label={def.label} onReset={() => onChange(def.default)} />}
        </div>
        <Input
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 border-slate-700 bg-slate-800 text-xs text-slate-200"
        />
        {def.description && <p className="text-[10px] leading-snug text-slate-500">{def.description}</p>}
      </div>
    );
  }
  // number
  const numVal = typeof value === 'number' ? value : (def.default as number);
  const min = def.min ?? 0;
  const max = def.max ?? 100;
  const range = max - min;
  // use slider only for "reasonable" ranges
  const useSlider = range > 0 && range <= 100000 && (def.step ?? 1) <= 1;
  const hasRange = def.min != null && def.max != null;
  return (
    <div className="space-y-1.5 rounded-lg border border-slate-800/60 bg-slate-800/20 px-2.5 py-2">
      <div className="flex items-center justify-between gap-1.5">
        <Label className="min-w-0 truncate text-xs text-slate-300">{def.label}</Label>
        <span className="flex shrink-0 items-center gap-1">
          <span className="font-mono text-[10px] tabular-nums text-cyan-300/90">
            {formatSI(numVal, def.unit)}
          </span>
          {differs && <ResetToDefaultButton label={def.label} onReset={() => onChange(def.default)} />}
        </span>
      </div>
      {useSlider ? (
        <div className="flex items-center gap-2">
          <Slider
            value={[numVal]}
            min={min}
            max={max}
            step={def.step ?? 0.01}
            onValueChange={(v) => onChange(v[0])}
            className="flex-1"
          />
          <Input
            type="number"
            value={numVal}
            min={def.min}
            max={def.max}
            step={def.step ?? 0.01}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            className="h-8 w-20 border-slate-700 bg-slate-800 font-mono text-xs text-slate-200"
          />
        </div>
      ) : (
        <Input
          type="number"
          value={numVal}
          min={def.min}
          max={def.max}
          step={def.step ?? 0.01}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="h-8 border-slate-700 bg-slate-800 font-mono text-xs text-slate-200"
        />
      )}
      {(def.description || hasRange) && (
        <p className="text-[10px] leading-snug text-slate-500">
          {def.description}
          {hasRange && (
            <span className="text-slate-600">
              {def.description ? ' · ' : 'Range '}
              {formatSI(def.min as number, def.unit)} – {formatSI(def.max as number, def.unit)}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
