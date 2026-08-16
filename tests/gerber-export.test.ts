import { describe, it, expect } from 'vitest';
import { exportGerberCopper, exportAllGerbers } from '../src/lib/pcb/gerber-export';
describe('Gerber export', () => {
  it('exportGerberCopper: valid RS-274X header', () => { const g=exportGerberCopper('top',[],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(g).toContain('%FSLAX26Y26*%');expect(g).toContain('%MOMM*%');expect(g.trim().endsWith('M02*')).toBe(true);});
  it('exportGerberCopper: bottom layer name', () => { const g=exportGerberCopper('bottom',[],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(g).toContain('%LNBOTTOM_COPPER*%');});
  it('exportAllGerbers: produces file set', () => { const files=exportAllGerbers([],[],[],{width:50,height:50,origin:{x:0,y:0}}as any);expect(files.length).toBeGreaterThanOrEqual(5);for(const f of files){expect(f.filename).toBeDefined();expect(f.content.length).toBeGreaterThan(0);}});
});
