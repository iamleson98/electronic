'use client';

import { useMemo } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { getPlugin } from '@/lib/circuit/registry';
import type { ParameterDef } from '@/lib/circuit/types';
import { RotateCw, Trash2, X, Info } from 'lucide-react';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';

export function PropertyPanel() {
  const selection = useEditor((s) => s.selection);
  const components = useEditor((s) => s.components);
  const setParameter = useEditor((s) => s.setParameter);
  const rotateComponent = useEditor((s) => s.rotateComponent);
  const deleteComponent = useEditor((s) => s.deleteComponent);
  const setSelection = useEditor((s) => s.setSelection);
  const simContext = useEditor((s) => s.simContext);

  const comp = useMemo(
    () => components.find((c) => c.id === selection.id) ?? null,
    [components, selection.id],
  );

  const plugin = useMemo(() => (comp ? getPlugin(comp.type) : null), [comp]);

  // find measurements for this component
  const measurements = useMemo(() => {
    if (!comp || !plugin || !plugin.measure || !simContext) return [];
    try {
      // we need the node map to resolve terminal ids, but we don't have it here directly.
      // For now, pass empty terminals and let the plugin handle gracefully (it can't measure without node ids).
      // To properly support this, we'd need to expose the node map from the store.
      // For simplicity, the probe panel uses the same logic and pulls voltages from simContext.
      return [];
    } catch {
      return [];
    }
  }, [comp, plugin, simContext]);

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
          className="flex-1 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
          onClick={() => rotateComponent(comp.id)}
        >
          <RotateCw size={12} className="mr-1" />
          Rotate (R)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-rose-900 bg-rose-950/50 text-rose-300 hover:bg-rose-900/50"
          onClick={() => deleteComponent(comp.id)}
        >
          <Trash2 size={12} className="mr-1" />
          Delete
        </Button>
      </div>

      {/* Parameters */}
      <ScrollArea className="flex-1">
        <div className="p-3">
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
      </ScrollArea>
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
