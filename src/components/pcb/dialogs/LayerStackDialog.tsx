'use client';

import { usePCB } from '@/lib/pcb/store';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Layers3, CheckCircle2 } from 'lucide-react';
import {
  DEFAULT_LAYER_STACK, FOUR_LAYER_STACK, SIX_LAYER_STACK,
  LAYER_COLORS, type LayerStack,
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
