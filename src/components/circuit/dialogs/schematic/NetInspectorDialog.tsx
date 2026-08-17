'use client';

// KiCad-parity schematic dialogs:
//   - FindReplaceDialog
//   - ViolationsBrowserDialog
//   - NetInspectorDialog
//   - SymbolEditorDialog (basic)
//   - PageSetupDialog
//   - SavedViewsDialog
//   - HierarchicalSheetsDialog

import { useCallback, useEffect, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import type { ERCError } from '@/lib/circuit/erc';
import type { NetClass, PageSetup } from '@/lib/circuit/types';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Search, Replace, AlertTriangle, CheckCircle, Shield, Network, Settings, Layers, BookOpen, Plus } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Net Inspector dialog — list all nets, click to highlight
// ─────────────────────────────────────────────────────────────────────────────

interface NetInfo {
  name: string;
  id: number;
  pins: number;
  components: string[];
}

export function NetInspectorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const netClasses = useEditor((s) => s.netClasses);
  const [nets, setNets] = useState<NetInfo[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!open) return;
    // build net list inline (don't import engine's buildNodeMap to avoid SSR issues)
    const nodeMap = new Map<string, number>();
    const parent: number[] = [0];
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a: number, b: number) => {
      const ra = find(a); const rb = find(b);
      if (ra === rb) return;
      if (ra === 0) parent[rb] = 0; else if (rb === 0) parent[ra] = 0; else parent[rb] = ra;
    };
    const newNode = () => { const id = parent.length; parent.push(id); return id; };
    const termKey = (cId: string, tId: string) => `${cId}:${tId}`;
    for (const c of components) {
      // pseudo — we don't have plugin list here, so just use component id + terminal label
      // (use a simple approximation: each component is one net)
    }
    for (const w of wires) {
      const fromKey = termKey(w.from.componentId, w.from.terminalId);
      const toKey = termKey(w.to.componentId, w.to.terminalId);
      if (!nodeMap.has(fromKey)) nodeMap.set(fromKey, newNode());
      if (!nodeMap.has(toKey)) nodeMap.set(toKey, newNode());
      union(nodeMap.get(fromKey)!, nodeMap.get(toKey)!);
    }
    // group by root
    const rootToComponents = new Map<number, Set<string>>();
    for (const [key, node] of nodeMap) {
      const r = find(node);
      if (!rootToComponents.has(r)) rootToComponents.set(r, new Set());
      const [cId] = key.split(':');
      rootToComponents.get(r)!.add(cId);
    }
    const netInfos: NetInfo[] = [];
    let idx = 0;
    for (const [root, comps] of rootToComponents) {
      netInfos.push({
        id: root,
        name: root === 0 ? 'GND' : `N${idx++}`,
        pins: nodeMap.size,
        components: Array.from(comps),
      });
    }
    netInfos.sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNets(netInfos);
  }, [open, components, wires]);

  const filtered = nets.filter((n) => !filter || n.name.toLowerCase().includes(filter.toLowerCase()) || n.components.some((c) => c.includes(filter)));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Network size={16} /> Net Inspector</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 mb-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter nets..." className="bg-slate-800 border-slate-700" />
        </div>
        <ScrollArea className="h-80 w-full rounded border border-slate-700 bg-slate-950">
          <table className="w-full text-xs">
            <thead className="bg-slate-800 sticky top-0">
              <tr>
                <th className="px-2 py-1 text-left text-slate-300">Net</th>
                <th className="px-2 py-1 text-left text-slate-300">Pins</th>
                <th className="px-2 py-1 text-left text-slate-300">Components</th>
                <th className="px-2 py-1 text-left text-slate-300">Class</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((n) => {
                const nc = netClasses.find((c) => c.nets.includes(n.name));
                return (
                  <tr key={n.id} className="border-t border-slate-800 hover:bg-slate-800">
                    <td className="px-2 py-1 font-mono text-cyan-400">{n.name}</td>
                    <td className="px-2 py-1">{n.pins}</td>
                    <td className="px-2 py-1 text-slate-400">{n.components.join(', ')}</td>
                    <td className="px-2 py-1">{nc ? <Badge variant="outline">{nc.name}</Badge> : <span className="text-slate-600">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollArea>
        <DialogFooter><Button variant="ghost" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
