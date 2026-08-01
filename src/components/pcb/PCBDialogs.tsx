'use client';

import { useState } from 'react';
import { usePCB } from '@/lib/pcb/store';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Layers3, SlidersHorizontal, Activity, CheckCircle2, X } from 'lucide-react';
import {
  DEFAULT_LAYER_STACK, FOUR_LAYER_STACK, SIX_LAYER_STACK,
  LAYER_COLORS, type CopperLayer, type LayerStack,
} from '@/lib/pcb/types';

// ─────────────────────────────────────────────────────────────────────────────
// Layer Stack Dialog — pick 2/4/6-layer stackup, configure dielectric thickness
// ─────────────────────────────────────────────────────────────────────────────

export function LayerStackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const layerStack = usePCB((s) => s.layerStack);
  const setLayerStack = usePCB((s) => s.setLayerStack);

  const presets: { name: string; stack: LayerStack; description: string }[] = [
    { name: '2-Layer', stack: DEFAULT_LAYER_STACK, description: 'Top + Bottom — basic PCBs, hobby projects' },
    { name: '4-Layer', stack: FOUR_LAYER_STACK, description: 'Top + PWR + GND + Bottom — standard 4-layer with inner planes' },
    { name: '6-Layer', stack: SIX_LAYER_STACK, description: 'Signal-GND-Signal-Signal-PWR-Signal — impedance-controlled' },
  ];

  const isPresetActive = (preset: LayerStack) =>
    JSON.stringify(preset.layers) === JSON.stringify(layerStack.layers);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Layers3 size={16} /> Layer Stack</DialogTitle>
          <DialogDescription>Choose a board stackup. 4-layer enables inner power/ground planes; 6-layer supports impedance-controlled routing.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {presets.map((preset) => (
            <button
              key={preset.name}
              onClick={() => setLayerStack(preset.stack)}
              className={`w-full text-left rounded-md border p-3 transition-colors ${
                isPresetActive(preset.stack)
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-slate-700 bg-slate-800/50 hover:border-slate-500'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-slate-100">{preset.name}</span>
                  {isPresetActive(preset.stack) && <CheckCircle2 size={14} className="text-emerald-400" />}
                </div>
                <div className="flex gap-1">
                  {preset.stack.layers.map((l) => (
                    <span
                      key={l}
                      className="inline-block h-3 w-6 rounded-sm"
                      style={{ background: LAYER_COLORS[l] }}
                      title={l}
                    />
                  ))}
                </div>
              </div>
              <div className="text-xs text-slate-400 mt-1">{preset.description}</div>
              <div className="text-[10px] text-slate-500 mt-1 font-mono">
                {preset.stack.layers.join(' / ')} · dielectric: {preset.stack.dielectric.join(' / ')} mm · {preset.stack.material}
              </div>
            </button>
          ))}
        </div>
        <div className="rounded-md border border-slate-700 bg-slate-950 p-3">
          <Label className="text-xs text-slate-400 mb-2 block">Current stack visualization</Label>
          <div className="flex flex-col gap-0.5">
            {layerStack.layers.slice().reverse().map((layer, i) => {
              const idx = layerStack.layers.length - 1 - i;
              const prevDielectric = idx > 0 ? layerStack.dielectric[idx - 1] : null;
              return (
                <div key={layer}>
                  {prevDielectric !== null && (
                    <div className="flex items-center justify-center text-[10px] text-slate-500 font-mono py-0.5">
                      ↓ {prevDielectric.toFixed(2)}mm dielectric ↓
                    </div>
                  )}
                  <div
                    className="flex items-center justify-between rounded px-3 py-1.5"
                    style={{ background: `${LAYER_COLORS[layer]}33`, borderLeft: `4px solid ${LAYER_COLORS[layer]}` }}
                  >
                    <span className="font-mono text-xs text-slate-100">{layer}</span>
                    <span className="text-[10px] text-slate-400">{(layerStack.thickness[layer] * 1000).toFixed(0)}μm Cu · {(layerStack.copperWeight ?? 1)}oz</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="text-xs text-slate-400 mt-2">
            Total board thickness: ~{(
              layerStack.layers.reduce((s, l) => s + layerStack.thickness[l], 0) +
              layerStack.dielectric.reduce((s, d) => s + d, 0)
            ).toFixed(2)}mm
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DRC Settings + Exclusions Dialog
// ─────────────────────────────────────────────────────────────────────────────

export function DRCSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const drcErrors = usePCB((s) => s.drcErrors);
  const runDRC = usePCB((s) => s.runDRC);
  const clearDRC = usePCB((s) => s.clearDRC);
  // Exclusions are stored locally for now (could be added to PCB store)
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [severityOverrides, setSeverityOverrides] = useState<Record<string, 'error' | 'warning' | 'info' | 'ignore'>>({});

  const toggleExclude = (key: string) => {
    setExcludedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filteredErrors = drcErrors.filter((e) => {
    // Apply exclusion by message hash
    const key = `${e.type}:${e.position.x.toFixed(2)},${e.position.y.toFixed(2)}`;
    if (excludedKeys.has(key)) return false;
    const override = severityOverrides[e.type];
    if (override === 'ignore') return false;
    return true;
  });

  const errorTypeCounts = drcErrors.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><SlidersHorizontal size={16} /> DRC Settings + Exclusions</DialogTitle>
          <DialogDescription>Manage DRC violations, exclude specific errors, override severities.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { runDRC(); toast.success('DRC re-run'); }}>Re-run DRC</Button>
            <Button size="sm" variant="ghost" onClick={() => { clearDRC(); setExcludedKeys(new Set()); toast.info('DRC cleared'); }}>Clear all</Button>
            <div className="ml-auto flex gap-2 text-xs">
              <Badge variant="destructive">{drcErrors.filter(e => e.severity === 'error').length} errors</Badge>
              <Badge className="bg-amber-500/20 text-amber-400 border-amber-700">{drcErrors.filter(e => e.severity === 'warning').length} warnings</Badge>
              <Badge variant="outline" className="text-slate-400">{excludedKeys.size} excluded</Badge>
            </div>
          </div>

          {/* Severity overrides by error type */}
          {Object.keys(errorTypeCounts).length > 0 && (
            <div className="rounded-md border border-slate-700 bg-slate-950 p-3">
              <Label className="text-xs text-slate-400 mb-2 block">Severity overrides by error type</Label>
              <div className="space-y-1">
                {Object.entries(errorTypeCounts).map(([type, count]) => (
                  <div key={type} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-slate-300 min-w-[140px]">{type}</span>
                    <Badge variant="outline" className="text-slate-400">{count}</Badge>
                    <select
                      value={severityOverrides[type] ?? 'default'}
                      onChange={(e) => {
                        const v = e.target.value as 'error' | 'warning' | 'info' | 'ignore' | 'default';
                        setSeverityOverrides((prev) => {
                          const next = { ...prev };
                          if (v === 'default') delete next[type];
                          else next[type] = v;
                          return next;
                        });
                      }}
                      className="bg-slate-800 border border-slate-700 rounded text-xs px-1 py-0.5 text-slate-200"
                    >
                      <option value="default">Default</option>
                      <option value="error">Error</option>
                      <option value="warning">Warning</option>
                      <option value="info">Info</option>
                      <option value="ignore">Ignore</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Violations list with per-error exclusion toggle */}
          <ScrollArea className="h-64 rounded border border-slate-700 bg-slate-950">
            {filteredErrors.length === 0 ? (
              <div className="text-center text-slate-500 py-8 text-sm">
                {drcErrors.length === 0 ? 'No DRC violations — board is clean.' : 'All violations excluded.'}
              </div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {filteredErrors.map((err, i) => {
                  const key = `${err.type}:${err.position.x.toFixed(2)},${err.position.y.toFixed(2)}`;
                  return (
                    <li key={i} className="px-3 py-2 flex items-center gap-2">
                      <Badge variant={err.severity === 'error' ? 'destructive' : 'outline'}
                             className={err.severity === 'warning' ? 'border-amber-500 text-amber-400' : ''}>
                        {err.severity}
                      </Badge>
                      <span className="text-xs font-mono text-slate-400 min-w-[100px]">{err.type}</span>
                      <span className="flex-1 text-sm text-slate-100">{err.message}</span>
                      <button
                        className="text-slate-500 hover:text-rose-400 p-1 rounded"
                        onClick={() => toggleExclude(key)}
                        title="Exclude this violation"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Length Tune Dialog — set target length and apply serpentine meander
// ─────────────────────────────────────────────────────────────────────────────

export function LengthTuneDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const traces = usePCB((s) => s.traces);
  const selectedTraceId = usePCB((s) => s.selectedTraceId);
  const lengthTuneTrace = usePCB((s) => s.lengthTuneTrace);
  const [targetLength, setTargetLength] = useState(20);

  const selectedTrace = traces.find((t) => t.id === selectedTraceId);
  const currentLength = selectedTrace
    ? selectedTrace.segments.reduce((s, seg) => s + Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y), 0)
    : 0;

  const apply = () => {
    if (!selectedTraceId) {
      toast.error('Select a trace first');
      return;
    }
    lengthTuneTrace(selectedTraceId, targetLength);
    toast.success(`Length-tuned to ${targetLength}mm (added ${(targetLength - currentLength).toFixed(2)}mm meander)`);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Activity size={16} /> Length Tuning</DialogTitle>
          <DialogDescription>Add a serpentine meander to the selected trace to reach a target length. Useful for length matching differential pairs and clock skew.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="rounded-md border border-slate-700 bg-slate-950 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">Selected trace:</span>
              <span className="font-mono text-slate-200">{selectedTraceId ?? 'none'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Net:</span>
              <span className="font-mono text-slate-200">{selectedTrace?.net ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Current length:</span>
              <span className="font-mono text-emerald-300">{currentLength.toFixed(2)} mm</span>
            </div>
          </div>
          <div>
            <Label className="text-xs text-slate-400 mb-1 block">Target length (mm)</Label>
            <Input
              type="number"
              value={targetLength}
              onChange={(e) => setTargetLength(parseFloat(e.target.value) || 0)}
              min={currentLength}
              step={0.5}
              className="bg-slate-800 border-slate-700"
            />
            <div className="text-xs text-slate-500 mt-1">
              Additional length needed: <span className="font-mono text-amber-400">{Math.max(0, targetLength - currentLength).toFixed(2)} mm</span>
            </div>
          </div>
          <div className="text-[10px] text-slate-500 bg-slate-800/50 rounded p-2">
            Note: Length tuning adds a serpentine meander pattern to the longest segment of the trace. The amplitude is fixed at 0.5mm; the number of bumps scales with the additional length needed.
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={apply}
            disabled={!selectedTraceId || targetLength <= currentLength}
            className="bg-amber-500 text-slate-900 hover:bg-amber-400"
          >
            Apply Meander
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
