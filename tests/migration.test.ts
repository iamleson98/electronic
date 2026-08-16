import { describe, it, expect } from 'vitest';
import { migrateDocument, validateDocument, loadCircuitDocument, saveCircuitDocument, detectVersion, CURRENT_SCHEMA_VERSION } from '../src/lib/circuit/migration';
describe('Migration', () => {
  it('detectVersion: 0 for no version', () => { expect(detectVersion({components:[],wires:[]})).toBe(0);});
  it('detectVersion: returns version number', () => { expect(detectVersion({version:1})).toBe(1);expect(detectVersion({version:2})).toBe(2);});
  it('migrateDocument: v0 → current', () => { const r=migrateDocument({components:[{id:'R1',type:'resistor',position:{x:0,y:0},rotation:0,parameters:{resistance:1000}}],wires:[]});expect(r.doc.version).toBe(CURRENT_SCHEMA_VERSION);expect(r.doc.components.length).toBe(1);});
  it('validateDocument: catches missing version', () => { const r=validateDocument({components:[],wires:[]}as any);expect(r.ok).toBe(false);});
  it('validateDocument: catches duplicate IDs', () => { const r=validateDocument({version:2,components:[{id:'R1',type:'resistor',position:{x:0,y:0},rotation:0,parameters:{}},{id:'R1',type:'resistor',position:{x:5,y:0},rotation:0,parameters:{}}],wires:[]}as any);expect(r.ok).toBe(false);});
  it('saveCircuitDocument: sets version', () => { const j=saveCircuitDocument({version:1,components:[],wires:[]}as any);expect(JSON.parse(j).version).toBe(CURRENT_SCHEMA_VERSION);});
  it('loadCircuitDocument: valid v0', () => { const j=JSON.stringify({components:[],wires:[]});const r=loadCircuitDocument(j);expect(r.doc).not.toBeNull();});
  it('loadCircuitDocument: JSON error', () => { const r=loadCircuitDocument('{ invalid');expect(r.doc).toBeNull();});
  it('round-trip: save→load→save identical', () => { const o:CircuitDocument={version:CURRENT_SCHEMA_VERSION,components:[],wires:[]};const j1=saveCircuitDocument(o);const r=loadCircuitDocument(j1);const j2=saveCircuitDocument(r.doc!);expect(JSON.parse(j2)).toEqual(JSON.parse(j1));});
});
