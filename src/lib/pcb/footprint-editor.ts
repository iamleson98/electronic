export function createCustomFootprint(name: string, desc: string): any {
  return { id: 'fp_' + Date.now(), name, description: desc, bodySize: { width: 5, height: 5 }, pads: [], silkOutline: [], courtyard: [], category: 'custom', created: Date.now(), modified: Date.now() };
}

export function addPad(fp: any, pad: any): any {
  const p = { ...pad, id: 'pad_' + (fp.pads.length + 1) };
  fp.pads.push(p);
  fp.modified = Date.now();
  return p;
}

export function updatePad(fp: any, padId: string, updates: any): boolean {
  const idx = fp.pads.findIndex((p: any) => p.id === padId);
  if (idx < 0) return false;
  fp.pads[idx] = { ...fp.pads[idx], ...updates };
  fp.modified = Date.now();
  return true;
}

export function removePad(fp: any, padId: string): boolean {
  const idx = fp.pads.findIndex((p: any) => p.id === padId);
  if (idx < 0) return false;
  fp.pads.splice(idx, 1);
  fp.modified = Date.now();
  return true;
}

export class FootprintLibrary {
  private fp = new Map<string, any>();
  add(f: any) { this.fp.set(f.id, f); }
  remove(id: string) { return this.fp.delete(id); }
  get(id: string) { return this.fp.get(id); }
  list() { return Array.from(this.fp.values()); }
  search(q: string) { const l = q.toLowerCase(); return this.list().filter((f: any) => f.name.toLowerCase().includes(l) || f.description.toLowerCase().includes(l)); }
  exportLibrary() { return JSON.stringify({ format: 'circuitsim-footprint-library', version: 1, footprints: this.list() }, null, 2); }
  importLibrary(json: string) { try { const p = JSON.parse(json); let c = 0; for (const f of p.footprints) { this.add(f); c++; } return { imported: c, errors: [] }; } catch (e) { return { imported: 0, errors: [(e as Error).message] }; } }
}

export const FOOTPRINT_TEMPLATES: Record<string, () => any> = {
  '0805': () => { const fp = createCustomFootprint('0805 SMD', '0805 package'); fp.bodySize = { width: 2.0, height: 1.25 }; addPad(fp, { name: '1', position: { x: -0.95, y: 0 }, shape: 'rect', size: { width: 0.5, height: 1.25 }, layer: 'top', drill: 0 }); addPad(fp, { name: '2', position: { x: 0.95, y: 0 }, shape: 'rect', size: { width: 0.5, height: 1.25 }, layer: 'top', drill: 0 }); return fp; },
  'DIP-8': () => { const fp = createCustomFootprint('DIP-8', '8-pin DIP'); fp.bodySize = { width: 9.3, height: 6.3 }; for (let i = 0; i < 8; i++) { const side = i < 4 ? -1 : 1; const y = ((i % 4) - 1.5) * 2.54; addPad(fp, { name: String(i + 1), position: { x: side * 3.81, y }, shape: 'circle', size: { width: 1.8, height: 1.8 }, layer: 'top', drill: 0.8 }); } return fp; },
};
