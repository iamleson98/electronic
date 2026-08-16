export const CURRENT_SCHEMA_VERSION = 2;

export function detectVersion(doc: any): number {
  if (!doc || typeof doc !== 'object') return 0;
  return typeof doc.version === 'number' ? doc.version : 0;
}

export function migrateDocument(doc: any): any {
  if (!doc || typeof doc !== 'object') return { doc: { version: 2, components: [], wires: [] }, fromVersion: 0, toVersion: 2, warnings: [], errors: ['Invalid'] };
  let v = detectVersion(doc);
  const w: string[] = [];
  if (v === 0) { w.push('v0→v1'); v = 1; }
  if (v < 2) { w.push('v1→v2'); v = 2; }
  if (!Array.isArray(doc.components)) doc.components = [];
  if (!Array.isArray(doc.wires)) doc.wires = [];
  doc.version = CURRENT_SCHEMA_VERSION;
  return { doc, fromVersion: detectVersion(doc), toVersion: CURRENT_SCHEMA_VERSION, warnings: w, errors: [] };
}

export function validateDocument(doc: any): any {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!doc) { return { ok: false, errors: ['null document'], warnings, componentCount: 0, wireCount: 0 }; }
  if (!doc.version) errors.push('Missing version field');
  if (!Array.isArray(doc.components)) errors.push('components is not an array');
  if (!Array.isArray(doc.wires)) errors.push('wires is not an array');
  if (errors.length > 0) return { ok: false, errors, warnings, componentCount: 0, wireCount: 0 };
  const ids = new Set<string>();
  for (const c of doc.components) {
    if (!c.id) { errors.push('Component missing id'); continue; }
    if (ids.has(c.id)) errors.push('Duplicate id: ' + c.id);
    ids.add(c.id);
  }
  const wireIds = new Set<string>();
  for (const w of doc.wires) {
    if (!w.id) { errors.push('Wire missing id'); continue; }
    if (wireIds.has(w.id)) errors.push('Duplicate wire id: ' + w.id);
    wireIds.add(w.id);
    if (w.from && w.from.componentId && !ids.has(w.from.componentId)) errors.push('Wire references missing component: ' + w.from.componentId);
    if (w.to && w.to.componentId && !ids.has(w.to.componentId)) errors.push('Wire references missing component: ' + w.to.componentId);
  }
  return { ok: errors.length === 0, errors, warnings, componentCount: doc.components.length, wireCount: doc.wires.length };
}

export function loadCircuitDocument(json: string): any {
  try {
    const p = JSON.parse(json);
    const m = migrateDocument(p);
    const v = validateDocument(m.doc);
    return { doc: v.ok ? m.doc : null, migration: m, validation: v };
  } catch (e) {
    return { doc: null, migration: { doc: { version: 2, components: [], wires: [] }, fromVersion: 0, toVersion: 2, warnings: [], errors: ['JSON error'] }, validation: { ok: false, errors: ['Parse failed'], warnings: [], componentCount: 0, wireCount: 0 } };
  }
}

export function saveCircuitDocument(doc: any): string {
  return JSON.stringify({ ...doc, version: CURRENT_SCHEMA_VERSION }, null, 2);
}
