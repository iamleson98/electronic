'use client';

import { useState } from 'react';
import { usePCB } from '@/lib/pcb/store';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { SlidersHorizontal, X } from 'lucide-react';


// ─────────────────────────────────────────────────────────────────────────────
// Layer Stack Dialog — pick 2/4/6-layer stackup, configure dielectric thickness
// ─────────────────────────────────────────────────────────────────────────────


export function DRCSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const drcErrors = usePCB((s) => s.drcErrors);
  const runDRC = usePCB((s) => s.runDRC);
  const clearDRC = usePCB((s) => s.clearDRC);
  const drcWaivers = usePCB((s) => s.drcWaivers);
  const waiveDRCError = usePCB((s) => s.waiveDRCError);
  const unwaiveDRCError = usePCB((s) => s.unwaiveDRCError);
  const fabPreset = usePCB((s) => s.fabPreset);
  const applyFabPreset = usePCB((s) => s.applyFabPreset);
  const [severityOverrides, setSeverityOverrides] = useState<Record<string, 'error' | 'warning' | 'info' | 'ignore'>>({});

  const waivedKeys = new Set(drcWaivers.map((w) => w.key));

  const filteredErrors = drcErrors.filter((e) => {
    // Waived violations are already filtered by runDRC — this is a display
    // fallback for errors produced before the waiver was added.
    const key = `${e.type}:${e.position.x.toFixed(2)},${e.position.y.toFixed(2)}`;
    if (waivedKeys.has(key)) return false;
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
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => { runDRC(); toast.success('DRC re-run'); }}>Re-run DRC</Button>
            <Button size="sm" variant="ghost" onClick={() => { clearDRC(); toast.info('DRC cleared'); }}>Clear all</Button>
            <label className="ml-auto flex items-center gap-1 text-xs text-slate-400">
              Fab
              <select
                value={fabPreset}
                onChange={(e) => {
                  if (e.target.value === '') return;
                  const ok = applyFabPreset(e.target.value);
                  toast[ok ? 'success' : 'error'](ok ? `DRC rules set to ${e.target.value}` : `Unknown fab ${e.target.value}`);
                }}
                aria-label="Manufacturer DRC preset"
                className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-xs text-slate-200"
              >
                <option value="">Custom</option>
                <option value="JLCPCB">JLCPCB</option>
                <option value="PCBWay">PCBWay</option>
                <option value="OSHPark">OSHPark</option>
                <option value="Aisler">Aisler</option>
                <option value="Seeed Fusion">Seeed Fusion</option>
              </select>
            </label>
            <div className="flex gap-2 text-xs">
              <Badge variant="destructive">{drcErrors.filter(e => e.severity === 'error').length} errors</Badge>
              <Badge className="bg-amber-500/20 text-amber-400 border-amber-700">{drcErrors.filter(e => e.severity === 'warning').length} warnings</Badge>
              <Badge variant="outline" className="text-slate-400">{drcWaivers.length} waived</Badge>
            </div>
          </div>

          {/* Severity overrides by error type */}
          {Object.keys(errorTypeCounts).length > 0 && (
            <div className="rounded-md border border-slate-700 bg-slate-950 p-3">
              <Label className="text-xs text-slate-400 mb-2 block">Severity overrides by error type</Label>
              <div className="space-y-1">
                {Object.entries(errorTypeCounts).map(([type, count]) => (
                  <div key={type} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-slate-300 min-w-35">{type}</span>
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
                  const waived = waivedKeys.has(key);
                  return (
                    <li key={i} className="px-3 py-2 flex items-center gap-2">
                      <Badge variant={err.severity === 'error' ? 'destructive' : 'outline'}
                        className={err.severity === 'warning' ? 'border-amber-500 text-amber-400' : ''}>
                        {err.severity}
                      </Badge>
                      <span className="text-xs font-mono text-slate-400 min-w-25">{err.type}</span>
                      <span className="flex-1 text-sm text-slate-100">{err.message}</span>
                      <button
                        className={`p-1 rounded ${waived ? 'text-amber-400 hover:text-amber-300' : 'text-slate-500 hover:text-rose-400'}`}
                        onClick={() => {
                          if (waived) unwaiveDRCError(key);
                          else {
                            waiveDRCError(err, 'waived from DRC dialog');
                            toast.success('Violation waived (persisted with the board)');
                          }
                        }}
                        title={waived ? 'Remove waiver' : 'Waive this violation (persisted)'}
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
