// Regression tests for reliability fixes — undo/redo full snapshot, clear/load
// state reset, toggleSwitch undoability, share-URL full document encoding,
// AutosaveManager getter pattern, NaN detection in sim loop.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { useEditor } from '../src/lib/circuit/store';
import { createShareURL, loadFromShareURL } from '../src/lib/circuit/share-url';
import { AutosaveManager, autosave, detectCrashRecovery, clearAutosave } from '../src/lib/circuit/autosave';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, CircuitDocument, DrawingPrimitive } from '../src/lib/circuit/types';

beforeAll(async () => {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/passive');
});

function comp(type: string, id: string, params?: any): CircuitComponent {
  const p = getPlugin(type);
  const defaults: any = {};
  if (p) for (const param of p.parameters) defaults[param.key] = param.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...defaults, ...params }, simState: {} };
}

beforeEach(() => {
  // Reset the store before each test
  useEditor.getState().clear();
  // Clear past/future history (clear() pushes to past)
  useEditor.setState({ past: [], future: [], drawings: [], noConnects: [], groups: [], netClasses: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Undo/redo restores the FULL snapshot — not just components and wires
// ─────────────────────────────────────────────────────────────────────────────

describe('Undo/redo: full snapshot restoration', () => {
  it('undo restores drawings', () => {
    const s = useEditor.getState();
    s.addComponent('resistor', { x: 5, y: 5 });
    s.pushHistory();
    const drawing: DrawingPrimitive = { type: 'line', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: '#ff0000', strokeWidth: 1 } as any;
    s.addDrawing(drawing);
    expect(useEditor.getState().drawings.length).toBe(1);
    s.undo();
    expect(useEditor.getState().drawings.length).toBe(0);
  });

  it('undo restores noConnects', () => {
    const s = useEditor.getState();
    const id = s.addComponent('resistor', { x: 5, y: 5 });
    s.pushHistory();
    s.addNoConnect(id, 'a');
    expect(useEditor.getState().noConnects.length).toBe(1);
    s.undo();
    expect(useEditor.getState().noConnects.length).toBe(0);
  });

  it('undo restores netClasses', () => {
    const s = useEditor.getState();
    s.addComponent('resistor', { x: 5, y: 5 });
    s.pushHistory();
    s.addNetClass('Power');
    expect(useEditor.getState().netClasses.length).toBe(1);
    s.undo();
    expect(useEditor.getState().netClasses.length).toBe(0);
  });

  it('undo restores groups', () => {
    const s = useEditor.getState();
    const id1 = s.addComponent('resistor', { x: 5, y: 5 });
    const id2 = s.addComponent('capacitor', { x: 10, y: 10 });
    s.pushHistory();
    s.createGroup('G1', [id1, id2]);
    expect(useEditor.getState().groups.length).toBe(1);
    s.undo();
    expect(useEditor.getState().groups.length).toBe(0);
  });

  it('redo restores drawings after undo', () => {
    const s = useEditor.getState();
    s.addComponent('resistor', { x: 5, y: 5 });
    s.pushHistory();
    const drawing: DrawingPrimitive = { type: 'line', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: '#ff0000', strokeWidth: 1 } as any;
    s.addDrawing(drawing);
    s.undo();
    expect(useEditor.getState().drawings.length).toBe(0);
    s.redo();
    expect(useEditor.getState().drawings.length).toBe(1);
  });

  it('undo preserves component parameters after setParameter', () => {
    const s = useEditor.getState();
    const id = s.addComponent('resistor', { x: 5, y: 5 });
    expect(useEditor.getState().components[0].parameters.resistance).toBe(1000);  // default
    s.setParameter(id, 'resistance', 2200);
    expect(useEditor.getState().components[0].parameters.resistance).toBe(2200);
    s.undo();
    expect(useEditor.getState().components[0].parameters.resistance).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. clear() and loadDocument() reset stale session state
// ─────────────────────────────────────────────────────────────────────────────

describe('clear()/loadDocument(): stale state reset', () => {
  it('clear() resets running to false', () => {
    const s = useEditor.getState();
    s.addComponent('dcVoltage', { x: 5, y: 5 }, { voltage: 5 } as any);
    s.addComponent('ground', { x: 5, y: 10 });
    s.setRunning(true);
    expect(useEditor.getState().running).toBe(true);
    s.clear();
    expect(useEditor.getState().running).toBe(false);
  });

  it('clear() resets simError', () => {
    const s = useEditor.getState();
    s.setSimError('something broke');
    expect(useEditor.getState().simError).toBe('something broke');
    s.clear();
    expect(useEditor.getState().simError).toBeNull();
  });

  it('loadDocument() resets running to false', () => {
    const s = useEditor.getState();
    s.addComponent('dcVoltage', { x: 5, y: 5 }, { voltage: 5 } as any);
    s.addComponent('ground', { x: 5, y: 10 });
    s.setRunning(true);
    expect(useEditor.getState().running).toBe(true);
    const doc: CircuitDocument = {
      version: 1,
      components: [comp('resistor', 'R1', { resistance: 1000 })],
      wires: [],
    };
    useEditor.getState().loadDocument(doc);
    expect(useEditor.getState().running).toBe(false);
  });

  it('loadDocument() resets simError', () => {
    const s = useEditor.getState();
    s.setSimError('old error');
    const doc: CircuitDocument = {
      version: 1,
      components: [comp('resistor', 'R1', { resistance: 1000 })],
      wires: [],
    };
    useEditor.getState().loadDocument(doc);
    expect(useEditor.getState().simError).toBeNull();
  });

  it('loadDocument() clears undo history', () => {
    const s = useEditor.getState();
    s.addComponent('resistor', { x: 5, y: 5 });
    expect(useEditor.getState().past.length).toBeGreaterThan(0);
    const doc: CircuitDocument = {
      version: 1,
      components: [comp('capacitor', 'C1', { capacitance: 1e-6 })],
      wires: [],
    };
    useEditor.getState().loadDocument(doc);
    expect(useEditor.getState().past.length).toBe(0);
    expect(useEditor.getState().future.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. toggleSwitch is undoable
// ─────────────────────────────────────────────────────────────────────────────

describe('toggleSwitch: undoable', () => {
  it('toggling a switch pushes history', () => {
    const s = useEditor.getState();
    const id = s.addComponent('switch', { x: 5, y: 5 });
    useEditor.setState({ past: [], future: [] });
    s.toggleSwitch(id);
    expect(useEditor.getState().past.length).toBeGreaterThan(0);
  });

  it('undo restores previous switch state', () => {
    const s = useEditor.getState();
    const id = s.addComponent('switch', { x: 5, y: 5 });
    const initialState = useEditor.getState().components[0].parameters.closed;
    useEditor.setState({ past: [], future: [] });
    s.toggleSwitch(id);
    expect(useEditor.getState().components[0].parameters.closed).toBe(!initialState);
    s.undo();
    expect(useEditor.getState().components[0].parameters.closed).toBe(initialState);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. createShareURL preserves full document
// ─────────────────────────────────────────────────────────────────────────────

describe('createShareURL: full document encoding', () => {
  it('round-trips drawings', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [comp('resistor', 'R1', { resistance: 1000 })],
      wires: [],
      drawings: [{ type: 'line', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: '#ff0000', strokeWidth: 1 }] as any,
    };
    const url = createShareURL(doc);
    const restored = loadFromShareURL(url.substring(url.indexOf('#')));
    expect(restored).not.toBeNull();
    expect(restored!.drawings).toBeDefined();
    expect(restored!.drawings!.length).toBe(1);
  });

  it('round-trips noConnects', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [comp('resistor', 'R1', { resistance: 1000 })],
      wires: [],
      noConnects: [{ componentId: 'R1', terminalId: 'a', position: { x: 5, y: 5 } }] as any,
    };
    const url = createShareURL(doc);
    const restored = loadFromShareURL(url.substring(url.indexOf('#')));
    expect(restored!.noConnects).toBeDefined();
    expect(restored!.noConnects!.length).toBe(1);
  });

  it('round-trips netClasses', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [comp('resistor', 'R1', { resistance: 1000 })],
      wires: [],
      netClasses: [{ id: 'nc1', name: 'Power', nets: ['VCC'] } as any],
    };
    const url = createShareURL(doc);
    const restored = loadFromShareURL(url.substring(url.indexOf('#')));
    expect(restored!.netClasses).toBeDefined();
    expect(restored!.netClasses!.length).toBe(1);
  });

  it('round-trips metadata', () => {
    const doc: CircuitDocument = {
      version: 1,
      components: [],
      wires: [],
      metadata: { title: 'My Circuit', author: 'Test', revision: 'Rev A' },
    };
    const url = createShareURL(doc);
    const restored = loadFromShareURL(url.substring(url.indexOf('#')));
    expect(restored!.metadata).toBeDefined();
    expect(restored!.metadata!.title).toBe('My Circuit');
  });

  it('strips simState from components', () => {
    const c = comp('resistor', 'R1', { resistance: 1000 });
    c.simState = { foo: 'bar' };
    const doc: CircuitDocument = { version: 1, components: [c], wires: [] };
    const url = createShareURL(doc);
    const restored = loadFromShareURL(url.substring(url.indexOf('#')));
    expect(restored!.components[0].simState).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. AutosaveManager — getter pattern
// ─────────────────────────────────────────────────────────────────────────────

class MockLS {
  private s = new Map<string, string>();
  getItem(k: string) { return this.s.get(k) ?? null; }
  setItem(k: string, v: string) { this.s.set(k, v); }
  removeItem(k: string) { this.s.delete(k); }
  clear() { this.s.clear(); }
}

describe('AutosaveManager: getter pattern', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MockLS();
  });

  it('start() + markDirty() + saveNow() uses the getter', () => {
    const mgr = new AutosaveManager();
    let counter = 0;
    mgr.start(() => {
      counter++;
      return { version: 1, components: [{ id: `R${counter}`, type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: { resistance: 1000 } }], wires: [] };
    });
    mgr.markDirty();
    // Before saveNow fires: getter not yet read
    expect(counter).toBe(0);
    // Flush immediately
    mgr.saveNow();
    expect(counter).toBe(1);
    const info = detectCrashRecovery();
    expect(info).not.toBeNull();
    expect(info!.componentCount).toBe(1);
  });

  it('multiple markDirty calls collapse into one save (debounce)', async () => {
    const mgr = new AutosaveManager();
    let saveCount = 0;
    mgr.start(() => {
      saveCount++;
      return { version: 1, components: [], wires: [] };
    });
    mgr.markDirty();
    mgr.markDirty();
    mgr.markDirty();
    // Wait for debounce (1 second)
    await new Promise(r => setTimeout(r, 1100));
    // Should have saved once (debounced)
    expect(saveCount).toBe(1);
  });

  it('shutdown() saves and marks clean', () => {
    const mgr = new AutosaveManager();
    mgr.start(() => ({ version: 1, components: [comp('resistor', 'R1', { resistance: 1000 })], wires: [] }));
    mgr.shutdown();
    const info = detectCrashRecovery();
    expect(info).not.toBeNull();
    expect(info!.crashed).toBe(false);  // clean shutdown
  });

  it('crash recovery detects crashed=true when shutdown not called', () => {
    autosave({ version: 1, components: [comp('resistor', 'R1', { resistance: 1000 })], wires: [] });
    // autosave() sets crashed='true' — only shutdown() → markCleanShutdown sets it to 'false'
    const info = detectCrashRecovery();
    expect(info).not.toBeNull();
    expect(info!.crashed).toBe(true);
  });

  it('clearAutosave removes all autosave keys', () => {
    autosave({ version: 1, components: [], wires: [] });
    expect(detectCrashRecovery()).not.toBeNull();
    clearAutosave();
    expect(detectCrashRecovery()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. beginDrag action exists
// ─────────────────────────────────────────────────────────────────────────────

describe('beginDrag action', () => {
  it('exists and pushes history', () => {
    const s = useEditor.getState();
    expect(typeof s.beginDrag).toBe('function');
    s.addComponent('resistor', { x: 5, y: 5 });
    useEditor.setState({ past: [], future: [] });
    s.beginDrag();
    expect(useEditor.getState().past.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. setSimError action exists
// ─────────────────────────────────────────────────────────────────────────────

describe('setSimError action', () => {
  it('exists and sets the error', () => {
    const s = useEditor.getState();
    expect(typeof s.setSimError).toBe('function');
    s.setSimError('test error');
    expect(useEditor.getState().simError).toBe('test error');
    s.setSimError(null);
    expect(useEditor.getState().simError).toBeNull();
  });
});
