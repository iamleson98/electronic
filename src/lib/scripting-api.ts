// JavaScript Scripting API — window.circuitlab
import { useEditor } from './circuit/store';
import { getPlugin, getAllPlugins, registerPlugin } from './circuit/registry';
import { buildNodeMap } from './circuit/engine';
import type { CircuitComponent, Wire, ComponentPlugin } from './circuit/types';

export interface ScriptingAPI {
  version: string;
  getSchematic: () => { components: CircuitComponent[]; wires: Wire[] };
  addComponent: (type: string, position: { x: number; y: number }, params?: Record<string, any>) => string;
  removeComponent: (id: string) => void;
  moveComponent: (id: string, position: { x: number; y: number }) => void;
  setParameter: (id: string, key: string, value: number | string | boolean) => void;
  addWire: (from: { componentId: string; terminalId: string }, to: { componentId: string; terminalId: string }) => void;
  clear: () => void;
  run: () => void;
  pause: () => void;
  step: () => void;
  reset: () => void;
  isRunning: () => boolean;
  getVoltage: (terminalKey: string) => number;
  getCurrent: (componentId: string) => number;
  getNodeVoltages: () => number[];
  getTime: () => number;
  listComponents: () => { type: string; name: string; category: string }[];
  getComponentInfo: (type: string) => any;
  registerPlugin: (plugin: ComponentPlugin) => void;
  on: (event: string, callback: (data: any) => void) => () => void;
}

const eventListeners = new Map<string, Set<(data: any) => void>>();

function emit(event: string, data: any) {
  const l = eventListeners.get(event);
  if (l) for (const cb of l) cb(data);
}

/** Validate a user-supplied position from the public console API.
 *  Accepts {x, y} with finite numbers (numbers-as-strings are coerced);
 *  throws a descriptive TypeError otherwise — a malformed position that
 *  slips through crashes PropertyPanel (comp.position.x.toFixed) and takes
 *  the whole app to the error boundary. */
function requirePosition(position: unknown, api: string): { x: number; y: number } {
  const bad = () => new TypeError(
    `circuitlab.${api}: position must be {x, y} with finite numbers — ` +
    `e.g. addComponent('resistor', {x: 10, y: 4}) (got ${typeof position === 'object' && position !== null ? JSON.stringify(position) : String(position)})`,
  );
  if (typeof position !== 'object' || position === null || Array.isArray(position)) throw bad();
  const { x, y } = position as { x?: unknown; y?: unknown };
  const nx = Number(x), ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw bad();
  return { x: nx, y: ny };
}

export function createScriptingAPI(): ScriptingAPI {
  return {
    version: '1.0.0',
    getSchematic: () => {
      const s = useEditor.getState();
      return { components: s.components.map(c => ({ ...c, simState: undefined })), wires: s.wires.map(w => ({ ...w })) };
    },
    addComponent: (type, position, params) => {
      const pos = requirePosition(position, 'addComponent');
      const id = useEditor.getState().addComponent(type, pos);
      if (params) for (const [k, v] of Object.entries(params)) useEditor.getState().setParameter(id, k, v);
      emit('componentAdded', { id, type, position: pos });
      return id;
    },
    removeComponent: (id) => { useEditor.getState().deleteComponent(id); emit('componentRemoved', { id }); },
    moveComponent: (id, position) => { const pos = requirePosition(position, 'moveComponent'); useEditor.getState().moveComponent(id, pos); emit('componentMoved', { id, position: pos }); },
    setParameter: (id, key, value) => { useEditor.getState().setParameter(id, key, value); emit('parameterChanged', { id, key, value }); },
    addWire: (from, to) => {
      const s = useEditor.getState();
      s.pushHistory();
      const id = `wire_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      useEditor.setState((st) => ({ wires: [...st.wires, { id, from, to }] }));
      emit('wireAdded', { id, from, to });
    },
    clear: () => { useEditor.getState().clear(); emit('schematicCleared', {}); },
    run: () => { useEditor.getState().setRunning(true); emit('simulationStarted', {}); },
    pause: () => { useEditor.getState().setRunning(false); emit('simulationPaused', {}); },
    step: () => { useEditor.getState().step(); emit('simulationStepped', {}); },
    reset: () => { useEditor.getState().reset(); emit('simulationReset', {}); },
    isRunning: () => useEditor.getState().running,
    getVoltage: (terminalKey) => {
      const s = useEditor.getState();
      if (!s.simContext) return 0;
      const plugins = new Map<string, any>();
      for (const c of s.components) { const p = getPlugin(c.type); if (p) plugins.set(c.type, p); }
      const nodeMap = buildNodeMap(s.components, s.wires, plugins);
      const nodeId = nodeMap.terminalNode.get(terminalKey) ?? 0;
      return s.simContext.nodeVoltage[nodeId] ?? 0;
    },
    getCurrent: (componentId) => {
      const s = useEditor.getState();
      if (!s.simContext) return 0;
      const comp = s.components.find(c => c.id === componentId);
      return (comp?.simState?.__current as number) ?? 0;
    },
    getNodeVoltages: () => {
      const s = useEditor.getState();
      return s.simContext ? Array.from(s.simContext.nodeVoltage) : [];
    },
    getTime: () => useEditor.getState().simContext?.time ?? 0,
    listComponents: () => getAllPlugins().map(p => ({ type: p.type, name: p.name, category: p.category })),
    getComponentInfo: (type) => {
      const p = getPlugin(type);
      if (!p) return null;
      return { type: p.type, name: p.name, category: p.category, description: p.description, boundingBox: p.boundingBox, terminals: p.terminals, parameters: p.parameters };
    },
    registerPlugin: (plugin) => { registerPlugin(plugin); emit('pluginRegistered', { type: plugin.type }); },
    on: (event, callback) => {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event)!.add(callback);
      return () => eventListeners.get(event)?.delete(callback);
    },
  };
}

export function installScriptingAPI(): void {
  if (typeof window === 'undefined') return;
  if ((window as any).circuitlab) return;
  (window as any).circuitlab = createScriptingAPI();
  console.warn('%c[CircuitLab] Scripting API ready — use `circuitlab` in console.', 'color: #22d3ee;');
}
