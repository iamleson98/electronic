// Store-level tests for the keyboard-placement draft and virtual focus
// cycling (a11y P1 features).

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditor } from '../src/lib/circuit/store';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire } from '../src/lib/circuit/types';

beforeEach(async () => {
  await import('../src/lib/circuit/components');
  useEditor.getState().clear();
  useEditor.setState({ past: [], future: [] });
});

function addComp(type: string, id: string, p?: any): CircuitComponent {
  const pl = getPlugin(type)!;
  const d: any = {};
  if (pl) for (const pm of pl.parameters) d[pm.key] = pm.default;
  const c: CircuitComponent = {
    id, type, position: { x: 0, y: 0 }, rotation: 0,
    parameters: { ...d, ...p }, simState: {},
  };
  useEditor.setState((s) => ({ components: [...s.components, c] }));
  return c;
}
function addWire(id: string, f: string, ft: string, t: string, tt: string) {
  const w: Wire = { id, from: { componentId: f, terminalId: ft }, to: { componentId: t, terminalId: tt } };
  useEditor.setState((s) => ({ wires: [...s.wires, w] }));
}

describe('Keyboard placement draft', () => {
  it('startPlacement creates a draft; nudge moves it; confirm places and clears', () => {
    const s = useEditor.getState();
    s.startPlacement('resistor', { x: 5, y: 5 });
    let st = useEditor.getState();
    expect(st.placementDraft).toEqual({ type: 'resistor', position: { x: 5, y: 5 }, rotation: 0 });

    st.nudgePlacement(2, -1);
    st = useEditor.getState();
    expect(st.placementDraft!.position).toEqual({ x: 7, y: 4 });

    st.nudgePlacement(-100, 0); // clamps at 0
    st = useEditor.getState();
    expect(st.placementDraft!.position.x).toBe(0);

    const before = useEditor.getState().components.length;
    useEditor.getState().confirmPlacement(false);
    st = useEditor.getState();
    expect(st.components.length).toBe(before + 1);
    expect(st.placementDraft).toBeNull();
    // the new part is selected and placed at the (clamped) draft position
    expect(st.selection.type).toBe('component');
    const placed = st.components.find(c => c.id === st.selection.id)!;
    expect(placed.position).toEqual({ x: 0, y: 4 });
    expect(placed.type).toBe('resistor');
  });

  it('rotatePlacement cycles 0→1→2→3→0 and confirm applies the rotation', () => {
    const s = useEditor.getState();
    s.startPlacement('capacitor', { x: 1, y: 1 });
    useEditor.getState().rotatePlacement();
    useEditor.getState().rotatePlacement();
    expect(useEditor.getState().placementDraft!.rotation).toBe(2);
    useEditor.getState().confirmPlacement(false);
    const st = useEditor.getState();
    const placed = st.components.find(c => c.type === 'capacitor')!;
    expect(placed.rotation).toBe(2);
  });

  it('confirmPlacement(repeat) keeps a draft, offset for the next instance', () => {
    const s = useEditor.getState();
    s.startPlacement('led', { x: 10, y: 10 });
    useEditor.getState().confirmPlacement(true);
    const st = useEditor.getState();
    expect(st.placementDraft).not.toBeNull();
    expect(st.placementDraft!.position).toEqual({ x: 13, y: 13 });
    expect(st.components.filter(c => c.type === 'led').length).toBe(1);
    // place the repeat too
    useEditor.getState().confirmPlacement(false);
    expect(useEditor.getState().components.filter(c => c.type === 'led').length).toBe(2);
  });

  it('cancelPlacement clears the draft without adding anything', () => {
    const s = useEditor.getState();
    const before = s.components.length;
    s.startPlacement('diode', { x: 2, y: 2 });
    useEditor.getState().cancelPlacement();
    const st = useEditor.getState();
    expect(st.placementDraft).toBeNull();
    expect(st.components.length).toBe(before);
  });

  it('announces placement state for screen readers', () => {
    useEditor.getState().startPlacement('resistor', { x: 0, y: 0 });
    expect(useEditor.getState().announcement).toContain('Placing resistor');
    useEditor.getState().confirmPlacement(false);
    expect(useEditor.getState().announcement).toContain('Placed resistor');
  });
});

describe('Virtual focus cycling (Tab / Shift+Tab)', () => {
  it('cycles components then wires, wrapping around', () => {
    addComp('resistor', 'R1');
    addComp('capacitor', 'C1');
    addWire('w1', 'R1', 'a', 'C1', 'a');

    const s = useEditor.getState();
    s.focusCycle(1); // first item
    expect(useEditor.getState().selection).toEqual({ type: 'component', id: 'R1' });
    s.focusCycle(1);
    expect(useEditor.getState().selection).toEqual({ type: 'component', id: 'C1' });
    s.focusCycle(1); // into wires
    expect(useEditor.getState().selection).toEqual({ type: 'wire', id: 'w1' });
    s.focusCycle(1); // wraps to the first component
    expect(useEditor.getState().selection).toEqual({ type: 'component', id: 'R1' });
    s.focusCycle(-1); // backwards wraps to the last wire
    expect(useEditor.getState().selection).toEqual({ type: 'wire', id: 'w1' });
  });

  it('announces the focused item with a position ("2 of 2 components")', () => {
    addComp('resistor', 'R1');
    addComp('capacitor', 'C1');
    useEditor.getState().focusCycle(1);
    useEditor.getState().focusCycle(1);
    const a = useEditor.getState().announcement ?? '';
    expect(a).toContain('C1');
    expect(a).toContain('2 of 2');
  });

  it('is a no-op on an empty circuit', () => {
    useEditor.getState().focusCycle(1);
    expect(useEditor.getState().selection.type).toBeNull();
  });
});
