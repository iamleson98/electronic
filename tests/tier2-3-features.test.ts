import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); await import('../src/lib/circuit/components/advanced'); await import('../src/lib/circuit/components/advanced-semi'); await import('../src/lib/circuit/components/advanced-devices'); });
describe('Tier 2-3 features', () => {
  it('bjtGPNpn registered', () => { expect(getPlugin('bjtGPNpn')).toBeDefined();});
  it('bjtGPPnp registered', () => { expect(getPlugin('bjtGPPnp')).toBeDefined();});
  it('diodeShockley registered', () => { expect(getPlugin('diodeShockley')).toBeDefined();});
  it('mosLevel1N registered', () => { expect(getPlugin('mosLevel1N')).toBeDefined();});
  it('jfetN registered', () => { expect(getPlugin('jfetN')).toBeDefined();});
  it('FootprintEditor: createCustomFootprint', async () => { const {createCustomFootprint}=await import('../src/lib/pcb/footprint-editor');const fp=createCustomFootprint('Test','desc');expect(fp.name).toBe('Test');});
  it('FootprintEditor: FOOTPRINT_TEMPLATES', async () => { const {FOOTPRINT_TEMPLATES}=await import('../src/lib/pcb/footprint-editor');const fp=FOOTPRINT_TEMPLATES['0805']();expect(fp.pads.length).toBe(2);});
  it('ProjectManager: export/import', async () => { const {exportProjectFile,importProjectFile}=await import('../src/lib/circuit/project-manager');const json=exportProjectFile('Test',[]);const r=importProjectFile(json);expect(r.project).not.toBeNull();});
  it('SPICE import: basic', async () => { const {importSpiceNetlist}=await import('../src/lib/circuit/spice-import');const r=importSpiceNetlist('V1 1 0 5\\nR1 1 0 1k\\n.end\\n');expect(r.errors.length).toBe(0);});
});
