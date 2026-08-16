import { describe, it, expect, beforeEach } from 'vitest';
import { saveToLocalStorage, loadFromLocalStorage, autosave, detectCrashRecovery, loadAutosave, clearAutosave, markCleanShutdown, AutosaveManager } from '../src/lib/circuit/autosave';
class MockLS { private s=new Map<string,string>();getItem(k:string){return this.s.get(k)??null;}setItem(k:string,v:string){this.s.set(k,v);}removeItem(k:string){this.s.delete(k);}clear(){this.s.clear();}}
beforeEach(() => { (globalThis as any).localStorage=new MockLS(); });
describe('Autosave', () => {
  it('saveToLocalStorage: stores doc', () => { expect(saveToLocalStorage('test',{version:1,components:[],wires:[]})).toBe(true);const l=loadFromLocalStorage('test');expect(l).not.toBeNull();});
  it('loadFromLocalStorage: null for missing', () => { expect(loadFromLocalStorage('nonexistent')).toBeNull();});
  it('autosave + detectCrashRecovery', () => { autosave({version:1,components:[{id:'R1',type:'resistor',position:{x:0,y:0},rotation:0,parameters:{}}],wires:[]}as any);const info=detectCrashRecovery();expect(info).not.toBeNull();expect(info!.crashed).toBe(true);});
  it('markCleanShutdown: crashed=false', () => { autosave({version:1,components:[],wires:[]}as any);markCleanShutdown();const info=detectCrashRecovery();expect(info!.crashed).toBe(false);});
  it('clearAutosave: removes all', () => { autosave({version:1,components:[],wires:[]}as any);clearAutosave();expect(detectCrashRecovery()).toBeNull();});
  it('AutosaveManager: saveNow', () => { const m=new AutosaveManager();expect(m.saveNow({version:1,components:[],wires:[]}as any)).toBe(true);});
});
