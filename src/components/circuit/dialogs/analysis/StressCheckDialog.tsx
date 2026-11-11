'use client';

// Component stress check (PSpice "Smoke"-style): simulate, then compare each
// part's peak V / peak I / average power with its datasheet absolute maxima.
// Failing parts also get a marker on the schematic (ERC marker layer).

import { useMemo, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import {
  DERATING_PRESETS, formatStressValue, type StressReport, type StressRow, type StressStatus,
} from '@/lib/circuit/stress-check';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Flame } from 'lucide-react';

const STATUS_STYLE: Record<StressStatus, string> = {
  ok: 'bg-emerald-900/50 text-emerald-300',
  warn: 'bg-amber-900/50 text-amber-300',
  fail: 'bg-red-900/60 text-red-300',
};
const STATUS_LABEL: Record<StressStatus, string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
const BAR_STYLE: Record<StressStatus, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', fail: 'bg-red-500' };

export function StressCheckDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const simOptions = useEditor((s) => s.simOptions);
  const setSimOptions = useEditor((s) => s.setSimOptions);
  const runStressCheck = useEditor((s) => s.runStressCheck);
  const setSelection = useEditor((s) => s.setSelection);
  const stored = useEditor((s) => s.stressReport);
  const [report, setReport] = useState<StressReport | null>(null);
  const [mode, setMode] = useState<'dc' | 'tran'>('tran');
  const [onlyProblems, setOnlyProblems] = useState(false);

  const derating = simOptions.stressDerating ?? 1;
  const shown = report ?? stored;
  const rows = useMemo(
    () => (shown?.rows ?? []).filter((r) => !onlyProblems || r.status !== 'ok'),
    [shown, onlyProblems],
  );

  const run = (d = derating, m = mode) => {
    const r = runStressCheck({ mode: m, derating: d });
    setReport(r);
    if (r.error) toast.error(`Stress check: ${r.error}`);
    else if (r.summary.fail > 0) toast.error(`${r.summary.failingParts} part(s) exceed absolute maximum ratings`);
    else if (r.summary.warn > 0) toast.warning(`${r.summary.warn} stress(es) above the derated limit`);
    else toast.success('All checked parts are within ratings');
  };

  const setDerating = (v: number) => {
    setSimOptions({ stressDerating: v });
    if (shown) run(v); // re-evaluate immediately with the new margin
  };

  const presetValue = DERATING_PRESETS.find((p) => p.value === derating)?.value.toString() ?? 'custom';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Flame size={16} /> Component Stress Check</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-slate-300 text-xs">Derating</Label>
              <Select value={presetValue} onValueChange={(v) => v !== 'custom' && setDerating(parseFloat(v))}>
                <SelectTrigger className="bg-slate-800 border-slate-700 h-8 w-72"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-800">
                  {DERATING_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value.toString()}>{p.label}</SelectItem>
                  ))}
                  {presetValue === 'custom' && <SelectItem value="custom">Custom ({Math.round(derating * 100)} %)</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-slate-300 text-xs">Evaluate over</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as 'dc' | 'tran')}>
                <SelectTrigger className="bg-slate-800 border-slate-700 h-8 w-64"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-800">
                  <SelectItem value="tran">Transient (0 – {formatStressValue(simOptions.tstop, 's')})</SelectItem>
                  <SelectItem value="dc">DC operating point</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => run()} className="bg-cyan-500 text-slate-900 h-8">
              <Flame size={14} className="mr-1" /> Run stress check
            </Button>
            <label className="flex items-center gap-1 text-xs text-slate-300 ml-auto">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              only warn / fail
            </label>
          </div>

          {shown && (
            <div className="text-xs text-slate-300 flex flex-wrap gap-3">
              <span className="text-red-300">{shown.summary.fail} fail</span>
              <span className="text-amber-300">{shown.summary.warn} warn</span>
              <span className="text-emerald-300">{shown.summary.ok} ok</span>
              <span className="text-slate-400">
                {shown.summary.parts} rated part(s) · {shown.mode === 'tran' ? `transient ${formatStressValue(shown.simulatedTime, 's')}` : 'DC operating point'}
                {' · '}peak V / I, average power{' · '}derating {Math.round(shown.derating * 100)} %
              </span>
              {shown.error && <span className="text-red-300">{shown.error}</span>}
            </div>
          )}

          <ScrollArea className="h-80 w-full rounded border border-slate-700 bg-slate-950">
            {!shown ? (
              <div className="text-center text-slate-500 py-10 text-sm">
                Run the stress check to compare each part with its datasheet absolute maximum ratings.
                <div className="text-xs mt-1">Re-run after editing the circuit — results are not updated live.</div>
              </div>
            ) : rows.length === 0 ? (
              <div className="text-center text-slate-500 py-10 text-sm">
                {shown.rows.length === 0 ? 'No part in this circuit has datasheet ratings.' : 'Nothing above its limit.'}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-800 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">Ref</th>
                    <th className="px-2 py-1 text-left">Part</th>
                    <th className="px-2 py-1 text-left">Metric</th>
                    <th className="px-2 py-1 text-right">Value</th>
                    <th className="px-2 py-1 text-right">Limit</th>
                    <th className="px-2 py-1 text-left w-36">% of limit</th>
                    <th className="px-2 py-1 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: StressRow, i) => (
                    <tr
                      key={`${r.componentId}-${r.metric}-${i}`}
                      className="border-t border-slate-800 hover:bg-slate-900 cursor-pointer"
                      title={r.note ?? 'Click to select the part'}
                      onClick={() => setSelection({ type: 'component', id: r.componentId })}
                    >
                      <td className="px-2 py-1 font-mono text-cyan-400">{r.ref}</td>
                      <td className="px-2 py-1 text-slate-300">{r.part ?? r.type}</td>
                      <td className="px-2 py-1 font-mono">{r.metric}</td>
                      <td className="px-2 py-1 font-mono text-right">{formatStressValue(r.value, r.unit)}</td>
                      <td className="px-2 py-1 font-mono text-right text-slate-400">
                        {formatStressValue(r.rating, r.unit)}
                        {r.deratedLimit !== r.rating && <div className="text-[10px]">derated {formatStressValue(r.deratedLimit, r.unit)}</div>}
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1">
                          <div className="h-1.5 flex-1 rounded bg-slate-800 overflow-hidden">
                            <div className={`h-full ${BAR_STYLE[r.status]}`} style={{ width: `${Math.min(100, r.ratio * 100)}%` }} />
                          </div>
                          <span className="font-mono w-10 text-right">{(r.ratio * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="px-2 py-1">
                        <span className={`px-1.5 py-0.5 rounded font-semibold ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                        {r.note && <div className="text-[10px] text-slate-500 max-w-48 truncate">{r.note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ScrollArea>
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
