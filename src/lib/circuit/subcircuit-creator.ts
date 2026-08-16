export function findExternalConnections(ids: Set<string>, comps: any[], wires: any[]): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const w of wires) {
    const fi = ids.has(w.from.componentId);
    const ti = ids.has(w.to.componentId);
    if (fi && !ti) {
      const k = w.from.componentId + ':' + w.from.terminalId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push({ componentId: w.to.componentId, terminalId: w.to.terminalId });
    } else if (!fi && ti) {
      const k = w.to.componentId + ':' + w.to.terminalId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push({ componentId: w.from.componentId, terminalId: w.from.terminalId });
    }
  }
  return m;
}

export function createSubcircuitFromSelection(doc: any, ids: Set<string>, name: string): any {
  return {
    childDoc: { version: 1, components: [], wires: [] },
    sheet: { id: '', sheetName: name, fileName: '', position: { x: 0, y: 0 }, size: { width: 10, height: 4 }, pins: [] },
    pins: [],
    externalNets: new Map(),
  };
}

export function canIncludeInSubcircuit(c: any): boolean {
  return c.type !== 'ground' && c.type !== 'junction';
}

export function validateSubcircuitSelection(doc: any, ids: Set<string>): string[] {
  return [];
}
