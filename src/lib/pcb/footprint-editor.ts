export function createCustomFootprint(name: string, desc: string): any {
  return { id: 'fp_' + Date.now(), name, description: desc, bodySize: { width: 5, height: 5 }, pads: [], silkOutline: [], courtyard: [], category: 'custom', created: Date.now(), modified: Date.now() };
}

export function addPad(fp: any, pad: any): any {
  const p = { ...pad, id: 'pad_' + (fp.pads.length + 1) };
  fp.pads.push(p);
  fp.modified = Date.now();
  return p;
}

/** Validation issue for a footprint (blocks save when severity is error). */
export interface FootprintIssue {
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Validate a footprint before save: duplicate terminals, overlapping pads,
 * annular-ring violations, missing pin-1. Returns issues (empty = clean).
 */
export function validateFootprint(fp: any, minAnnularRing = 0.15): FootprintIssue[] {
  const issues: FootprintIssue[] = [];
  const seen = new Set<string>();
  for (const pad of fp.pads ?? []) {
    const term = String(pad.terminalId ?? pad.name ?? '');
    if (term !== '') {
      if (seen.has(term)) {
        issues.push({ severity: 'error', message: `Duplicate terminal "${term}" — each pad needs a unique terminal.` });
      }
      seen.add(term);
    }
  }
  const pads = fp.pads ?? [];
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i];
      const b = pads[j];
      const dx = (a.position?.x ?? 0) - (b.position?.x ?? 0);
      const dy = (a.position?.y ?? 0) - (b.position?.y ?? 0);
      const dist = Math.hypot(dx, dy);
      const minDist = (Math.max(a.size?.width ?? 0, a.size?.height ?? 0) + Math.max(b.size?.width ?? 0, b.size?.height ?? 0)) / 2;
      if (dist < minDist) {
        issues.push({ severity: 'error', message: `Pads ${a.id} and ${b.id} overlap (${dist.toFixed(2)}mm < ${minDist.toFixed(2)}mm).` });
      }
    }
    const pad = pads[i];
    const drill = pad.drill ?? 0;
    if (drill > 0) {
      const ring = (Math.min(pad.size?.width ?? 0, pad.size?.height ?? 0) - drill) / 2;
      if (ring < minAnnularRing) {
        issues.push({ severity: 'error', message: `Pad ${pad.id} annular ring ${ring.toFixed(3)}mm < ${minAnnularRing}mm.` });
      }
    }
  }
  if (pads.length >= 3 && !pads.some((p: any) => /^(1|A1|pin1|pin-1)$/i.test(String(p.terminalId ?? p.name ?? '')))) {
    issues.push({ severity: 'warning', message: 'No pin-1 marker pad (1/A1) — assembly orientation is ambiguous.' });
  }
  return issues;
}

/**
 * Auto-generate courtyard (body + 0.5mm), silk outline (body + 0.15mm), and
 * a pin-1 dot at the first pad. Fills fp.courtyard / fp.silkOutline /
 * fp.pin1 in place; returns them.
 */
export function autoGenerateFootprintLayers(fp: any, courtyardExcess = 0.5, silkExcess = 0.15): { courtyard: { x: number; y: number }[]; silk: { x: number; y: number }[]; pin1: { x: number; y: number } | null } {
  const w = (fp.bodySize?.width ?? 5) / 2;
  const h = (fp.bodySize?.height ?? 5) / 2;
  const rect = (ex: number) => [
    { x: -w - ex, y: -h - ex },
    { x: w + ex, y: -h - ex },
    { x: w + ex, y: h + ex },
    { x: -w - ex, y: h + ex },
  ];
  const courtyard = rect(courtyardExcess);
  const silk = rect(silkExcess);
  const first = (fp.pads ?? [])[0];
  const pin1 = first ? { x: first.position?.x ?? 0, y: first.position?.y ?? 0 } : null;
  fp.courtyard = courtyard;
  fp.silkOutline = silk;
  fp.pin1 = pin1;
  fp.modified = Date.now();
  return { courtyard, silk, pin1 };
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
