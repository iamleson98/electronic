import { describe, it, expect, beforeAll } from 'vitest';
import { useEditor } from '../src/lib/circuit/store';
import { getPlugin } from '../src/lib/circuit/registry';
beforeAll(async () => { await import('../src/lib/circuit/components/sources'); await import('../src/lib/circuit/components/passive'); await import('../src/lib/circuit/components/semiconductors'); await import('../src/lib/circuit/components/extra'); });
function state(){return useEditor.getState();}
function reset(){state().clear();state().reset();}
describe('E2E flows', () => {
  it('build LED circuit and run sim', () => { reset();const v1=state().addComponent('dcVoltage',{x:4,y:6});state().setParameter(v1,'voltage',5);const r1=state().addComponent('resistor',{x:10,y:6});state().setParameter(r1,'resistance',330);const led=state().addComponent('led',{x:16,y:6});const gnd=state().addComponent('ground',{x:10,y:12});state().startWire({componentId:v1,terminalId:'p'},{x:5,y:7});state().completeWire({componentId:r1,terminalId:'a'});state().startWire({componentId:r1,terminalId:'b'},{x:11,y:7});state().completeWire({componentId:led,terminalId:'a'});state().startWire({componentId:led,terminalId:'k'},{x:17,y:7});state().completeWire({componentId:gnd,terminalId:'g'});state().startWire({componentId:v1,terminalId:'n'},{x:5,y:13});state().completeWire({componentId:gnd,terminalId:'g'});expect(state().components.length).toBe(4);expect(state().wires.length).toBe(4);state().setRunning(true);state().step();expect(state().simContext).not.toBeNull();expect(state().simError).toBeNull();state().setRunning(false);});
  it('undo/redo 10 times', () => { reset();for(let i=0;i<10;i++)state().addComponent('resistor',{x:i*4,y:0});expect(state().components.length).toBe(10);for(let i=0;i<10;i++)state().undo();expect(state().components.length).toBe(0);for(let i=0;i<10;i++)state().redo();expect(state().components.length).toBe(10);});
  it('rotate and delete', () => { reset();const id=state().addComponent('resistor',{x:5,y:5});expect(state().components[0].rotation).toBe(0);state().rotateComponent(id);expect(state().components[0].rotation).toBe(1);state().deleteComponent(id);expect(state().components.length).toBe(0);});
});
