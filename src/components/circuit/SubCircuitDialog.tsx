'use client';

import { useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { registerSubCircuit } from '@/lib/circuit/subcircuit';
import type { CircuitComponent } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Boxes, Plus } from 'lucide-react';
import { toast } from 'sonner';

interface PinDef {
  pinId: string;
  label: string;
  componentId: string;
  terminalId: string;
  enabled: boolean;
}

export function SubCircuitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const serialize = useEditor((s) => s.serialize);

  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [pins, setPins] = useState<PinDef[]>([]);

  // Collect all terminals from all components for the pin picker
  const allTerminals: { componentId: string; terminalId: string; label: string; compType: string }[] = [];
  for (const c of components) {
    const p = getPlugin(c.type);
    if (!p) continue;
    for (const t of p.terminals) {
      allTerminals.push({
        componentId: c.id,
        terminalId: t.id,
        label: `${c.type}.${t.id}`,
        compType: c.type,
      });
    }
  }

  const togglePin = (t: { componentId: string; terminalId: string; label: string }) => {
    const key = `${t.componentId}:${t.terminalId}`;
    setPins((prev) => {
      const existing = prev.find((p) => `${p.componentId}:${p.terminalId}` === key);
      if (existing) {
        return prev.map((p) =>
          `${p.componentId}:${p.terminalId}` === key ? { ...p, enabled: !p.enabled } : p,
        );
      }
      return [
        ...prev,
        {
          pinId: `pin${prev.length + 1}`,
          label: t.label,
          componentId: t.componentId,
          terminalId: t.terminalId,
          enabled: true,
        },
      ];
    });
  };

  const updatePinLabel = (idx: number, label: string) => {
    setPins((prev) => prev.map((p, i) => (i === idx ? { ...p, label } : p)));
  };

  const updatePinId = (idx: number, pinId: string) => {
    setPins((prev) => prev.map((p, i) => (i === idx ? { ...p, pinId } : p)));
  };

  const handleRegister = () => {
    if (!name.trim() || !type.trim()) {
      toast.error('Please enter both a name and a type id');
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/i.test(type)) {
      toast.error('Type id must start with a letter and contain only letters/digits/underscores');
      return;
    }
    const enabledPins = pins.filter((p) => p.enabled);
    if (enabledPins.length === 0) {
      toast.error('Select at least one pin');
      return;
    }
    try {
      const doc = serialize();
      // Auto-layout pin positions on a bounding box
      const bbox = { width: 6, height: Math.max(3, enabledPins.length + 1) };
      const leftCount = Math.ceil(enabledPins.length / 2);
      const pinPositions = enabledPins.map((p, i) => ({
        ...p,
        position: i < leftCount
          ? { x: 0, y: 1 + i }
          : { x: bbox.width, y: 1 + (i - leftCount) },
      }));
      registerSubCircuit({
        type: type.toLowerCase(),
        name: name.trim(),
        description: `User-defined sub-circuit "${name.trim()}"`,
        pins: pinPositions.map((p) => ({ id: p.pinId, label: p.label, position: p.position })),
        document: doc,
        pinMap: pinPositions.map((p) => ({
          pinId: p.pinId,
          componentId: p.componentId,
          terminalId: p.terminalId,
        })),
        boundingBox: bbox,
      });
      toast.success(`Sub-circuit "${name}" registered. Find it in the palette under "IC" category.`);
      onClose();
    } catch (err) {
      toast.error('Failed: ' + (err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl bg-slate-900 border-slate-700 text-slate-100 max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Boxes size={18} className="text-purple-400" />
            Create Sub-Circuit
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Convert the current circuit into a reusable component. Select which terminals become
            external pins. The new component will appear in the palette under the "IC" category
            for this session.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-slate-400">Component Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Amplifier"
              className="bg-slate-800 border-slate-700 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs text-slate-400">Type ID (unique)</Label>
            <Input
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="myAmp"
              className="bg-slate-800 border-slate-700 text-sm font-mono"
            />
          </div>
        </div>

        <div className="rounded-md border border-slate-800 bg-slate-800/30 p-2">
          <Label className="text-xs text-slate-400 mb-2 block">
            Select terminals to expose as pins ({allTerminals.length} available)
          </Label>
          <ScrollArea className="h-[280px]">
            <div className="space-y-1">
              {allTerminals.length === 0 && (
                <div className="text-center py-6 text-xs text-slate-500">
                  No components on canvas. Add some components first.
                </div>
              )}
              {allTerminals.map((t, i) => {
                const idx = pins.findIndex((p) => `${p.componentId}:${p.terminalId}` === `${t.componentId}:${t.terminalId}`);
                const pin = idx >= 0 ? pins[idx] : null;
                return (
                  <div
                    key={i}
                    className={`flex items-center gap-2 rounded p-1.5 ${
                      pin?.enabled ? 'bg-purple-950/40 border border-purple-700/50' : 'border border-transparent'
                    }`}
                  >
                    <Checkbox
                      checked={!!pin?.enabled}
                      onCheckedChange={() => togglePin(t)}
                    />
                    <span className="text-xs font-mono text-slate-300 min-w-[140px]">{t.label}</span>
                    {pin?.enabled && (
                      <>
                        <Input
                          value={pin.pinId}
                          onChange={(e) => updatePinId(idx, e.target.value)}
                          placeholder="pin1"
                          className="h-7 w-24 bg-slate-800 border-slate-700 text-xs font-mono"
                        />
                        <Input
                          value={pin.label}
                          onChange={(e) => updatePinLabel(idx, e.target.value)}
                          placeholder="Label"
                          className="h-7 flex-1 bg-slate-800 border-slate-700 text-xs"
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            className="bg-purple-500 text-white hover:bg-purple-400"
            onClick={handleRegister}
          >
            <Plus size={14} className="mr-1" />
            Register Sub-Circuit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
