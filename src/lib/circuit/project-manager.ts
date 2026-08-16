export function exportProjectFile(name: string, sheets: any[]): string {
  return JSON.stringify({ format: 'circuitsim-project', version: 1, metadata: { name, created: Date.now(), modified: Date.now() }, sheets }, null, 2);
}

export function importProjectFile(json: string): any {
  try {
    const p = JSON.parse(json);
    return { project: p, errors: [] };
  } catch (e) {
    return { project: null, errors: [(e as Error).message] };
  }
}

export function createVersionedProject(name: string, doc: any): any {
  return { id: 'proj_' + Date.now(), name, currentDoc: doc, versions: [], maxVersions: 50 };
}

export function saveVersion(p: any, desc: string): void {
  p.versions.push({ version: p.versions.length + 1, timestamp: Date.now(), description: desc, doc: JSON.parse(JSON.stringify(p.currentDoc)) });
  if (p.versions.length > p.maxVersions) p.versions.shift();
}

export function restoreVersion(p: any, v: number): boolean {
  const ver = p.versions.find((x: any) => x.version === v);
  if (!ver) return false;
  p.currentDoc = JSON.parse(JSON.stringify(ver.doc));
  return true;
}

export function listVersions(p: any): any[] {
  return p.versions.map((v: any) => ({ version: v.version, timestamp: v.timestamp, description: v.description }));
}

export function diffVersions(p: any, v1: number, v2: number): any {
  const ver1 = p.versions.find((v: any) => v.version === v1);
  const ver2 = p.versions.find((v: any) => v.version === v2);
  if (!ver1 || !ver2) return { componentCountDelta: 0, wireCountDelta: 0, addedComponents: [], removedComponents: [] };
  const ids1 = new Set(ver1.doc.components.map((c: any) => c.id));
  const ids2 = new Set(ver2.doc.components.map((c: any) => c.id));
  return {
    componentCountDelta: ver2.doc.components.length - ver1.doc.components.length,
    wireCountDelta: ver2.doc.wires.length - ver1.doc.wires.length,
    addedComponents: [...ids2].filter((id: any) => !ids1.has(id)),
    removedComponents: [...ids1].filter((id: any) => !ids2.has(id)),
  };
}
