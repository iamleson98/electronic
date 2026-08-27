'use client';

import { useMemo } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin } from '@/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '@/lib/circuit/engine';
import type { ParameterDef } from '@/lib/circuit/types';
import { RotateCw, Trash2, X, Info, Sparkles } from 'lucide-react';
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

  // find measurements for this component
  const measurements = useMemo(() => {
    if (!comp || !plugin || !plugin.measure || !simContext) return [];
    try {
      // Build node map to resolve terminal node IDs
      const plugins = new Map<string, any>();
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
        <div className="flex-1 overflow-y-auto p-3">
          {/* Alignment tools */}
          <div className="mb-4 space-y-2">
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
          <div className="mb-4 space-y-2">
            <Label className="text-xs text-slate-400">Distribute</Label>
            <div className="grid grid-cols-2 gap-1">
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => distributeSelected('x')} disabled={multiComps.length < 3}>Horizontal</Button>
              <Button size="sm" variant="ghost" className="cursor-pointer text-xs" onClick={() => distributeSelected('y')} disabled={multiComps.length < 3}>Vertical</Button>
            </div>
          </div>
          {/* Common parameters */}
          {commonParams.length > 0 && (
            <div className="space-y-3">
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
      <div className="flex h-full flex-col bg-slate-900">
        <div className="border-b border-slate-800 p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Properties</h2>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Info size={28} className="text-slate-600" />
          <p className="text-xs text-slate-500">Select a component on the canvas to edit its parameters.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-900">
      {/* Header */}
      <div className="border-b border-slate-800 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded bg-slate-950 text-sm font-bold text-cyan-300">
                {plugin.symbol}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-100">{plugin.name}</div>
                <Badge variant="outline" className="mt-0.5 border-slate-700 text-[10px] text-slate-400">
                  {plugin.category}
                </Badge>
              </div>
            </div>
            <p className="mt-2 text-xs leading-snug text-slate-400">{plugin.description}</p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-slate-400 hover:text-slate-200"
            onClick={() => setSelection({ type: null, id: null })}
          >
            <X size={14} />
          </Button>
        </div>
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

      {/* Parameters */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`p-3 ${running ? 'pointer-events-none opacity-50' : ''}`}>
          {running && (
            <div className="mb-3 rounded-md border border-amber-700/50 bg-amber-950/30 p-2 text-center text-[11px] text-amber-300">
              ⏸ Pause simulation to edit parameters
            </div>
          )}
          {plugin.parameters.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-500">No editable parameters.</p>
          ) : (
            <div className="space-y-3">
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

          {/* Position info */}
          <div className="mt-4 rounded border border-slate-800 bg-slate-950/50 p-2">
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

function ParameterEditor({
  def,
  value,
  onChange,
}: {
  def: ParameterDef;
  value: number | string | boolean | undefined;
  onChange: (v: number | string | boolean) => void;
}) {
  if (def.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-slate-300">{def.label}</Label>
        <Switch checked={!!value} onCheckedChange={(v) => onChange(v)} />
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <div className="space-y-1">
        <Label className="text-xs text-slate-300">{def.label}</Label>
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
      </div>
    );
  }
  if (def.type === 'color') {
    return (
      <div className="space-y-1">
        <Label className="text-xs text-slate-300">{def.label}</Label>
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
          <div className="flex items-center justify-between">
            <Label className="text-xs text-slate-300">{def.label}</Label>
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
      <div className="space-y-1">
        <Label className="text-xs text-slate-300">{def.label}</Label>
        <Input
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 border-slate-700 bg-slate-800 text-xs text-slate-200"
        />
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
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-slate-300">{def.label}</Label>
        {def.unit && <span className="font-mono text-[10px] text-slate-500">{def.unit}</span>}
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
      {def.description && <p className="text-[10px] text-slate-500">{def.description}</p>}
    </div>
  );
}
