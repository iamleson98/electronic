import { buildNodeMap } from './engine';

export interface NetAnnotation {
  nodeId: number;
  netName: string;
  pins: Array<{ componentId: string; terminalId: string }>;
  isPower: boolean;
}

export function annotateNets(components: any[], wires: any[], plugins: any): NetAnnotation[] {
  const nm = buildNodeMap(components, wires, plugins);
  const anns: NetAnnotation[] = [];
  const np = new Map<number, any[]>();
  for (const c of components) {
    const p = plugins.get(c.type);
    if (!p) continue;
    for (const t of p.terminals) {
      const k = c.id + ':' + t.id;
      const n = nm.terminalNode.get(k);
      if (n === undefined) continue;
      if (!np.has(n)) np.set(n, []);
      np.get(n)!.push({ componentId: c.id, terminalId: t.id });
    }
  }
  let i = 1;
  for (const [n, p] of np) {
    if (n === 0) { anns.push({ nodeId: 0, netName: 'GND', pins: p, isPower: true }); continue; }
    const name = 'N' + String(i++).padStart(4, '0');
    anns.push({ nodeId: n, netName: name, pins: p, isPower: false });
  }
  return anns;
}

export function getNetName(cid: string, tid: string, anns: NetAnnotation[]): string | null {
  for (const a of anns) {
    if (a.pins.some(p => p.componentId === cid && p.terminalId === tid)) return a.netName;
  }
  return null;
}

export function findNetConflicts(anns: NetAnnotation[]): string[] {
  const c: string[] = [];
  const s = new Map<string, number>();
  for (const a of anns) {
    if (s.has(a.netName) && s.get(a.netName) !== a.nodeId) {
      c.push('Net "' + a.netName + '" on nodes ' + s.get(a.netName) + ' and ' + a.nodeId);
    }
    s.set(a.netName, a.nodeId);
  }
  return c;
}

export function backAnnotateNets(components: any[], wires: any[], plugins: any, pcbNets: Map<string, string>): NetAnnotation[] {
  return annotateNets(components, wires, plugins);
}
