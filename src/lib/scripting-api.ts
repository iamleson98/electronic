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

let eventListeners = new Map<string, Set<(data: any) => void>>();

function emit(event: string, data: any) {
  const l = eventListeners.get(event);
  if (l) for (const cb of l) cb(data);
}

export function createScriptingAPI(): ScriptingAPI {
  return {
    version: '1.0.0',
    getSchematic: () => {
      const s = useEditor.getState();
      return { components: s.components.map(c => ({ ...c, simState: undefined })), wires: s.wires.map(w => ({ ...w })) };
    },
    addComponent: (type, position, params) => {
      const id = useEditor.getState().addComponent(type, position);
      if (params) for (const [k, v] of Object.entries(params)) useEditor.getState().setParameter(id, k, v);
      emit('componentAdded', { id, type, position });
      return id;
    },
    removeComponent: (id) => { useEditor.getState().deleteComponent(id); emit('componentRemoved', { id }); },
    moveComponent: (id, position) => { useEditor.getState().moveComponent(id, position); emit('componentMoved', { id, position }); },
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
  console.log('%c[CircuitLab] Scripting API ready — use `circuitlab` in console.', 'color: #22d3ee;');
}
