import type { CircuitComponent, Wire, CircuitDocument, ComponentPlugin } from './types';
import { solveDC, buildNodeMap, getTerminalsForComponent, computeComponentCurrents, simulateStep } from './engine';
import { getPlugin } from './registry';

export const MAX_COMPONENTS = 2000;
export const MAX_WIRES = 5000;
export const MAX_NODES = 5000;
export const MAX_TRACE_SAMPLES = 10000;

export interface LimitCheckResult { ok: boolean; reason?: string; count: number; limit: number; }
export function checkComponentLimit(components: CircuitComponent[]): LimitCheckResult {
  if (components.length > MAX_COMPONENTS) return { ok: false, reason: 'Exceeds maximum', count: components.length, limit: MAX_COMPONENTS };
  return { ok: true, count: components.length, limit: MAX_COMPONENTS };
}
export function checkWireLimit(wires: Wire[]): LimitCheckResult {
  if (wires.length > MAX_WIRES) return { ok: false, reason: 'Exceeds maximum', count: wires.length, limit: MAX_WIRES };
  return { ok: true, count: wires.length, limit: MAX_WIRES };
}
export function checkNodeLimit(components: CircuitComponent[], wires: Wire[], plugins: Map<string, ComponentPlugin>): LimitCheckResult {
  const nm = buildNodeMap(components, wires, plugins);
  if (nm.numNodes > MAX_NODES) return { ok: false, reason: 'Exceeds maximum', count: nm.numNodes, limit: MAX_NODES };
  return { ok: true, count: nm.numNodes, limit: MAX_NODES };
}

function makeComp(type: string, id: string, params?: any): CircuitComponent {
  const p = plugins_getPlugin(type); const d: any = {};
  if (p) for (const pm of (p as any).parameters) d[pm.key] = pm.default;
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, parameters: { ...d, ...params }, simState: {} };
}
function plugins_getPlugin(type: string): any { return getPlugin(type) ?? null; }

export function generateResistorLadder(stages: number, resistance: number = 1000): CircuitDocument {
  const components: CircuitComponent[] = [
    makeComp('dcVoltage', 'V1', { voltage: 5 }),
    makeComp('ground', 'GND'),
  ];
  for (let i = 0; i < stages; i++) components.push(makeComp('resistor', `R${i}`, { resistance }));
  const wires: Wire[] = [
    { id: 'w0', from: { componentId: 'V1', terminalId: 'p' }, to: { componentId: 'R0', terminalId: 'a' } },
    { id: 'wgnd', from: { componentId: 'V1', terminalId: 'n' }, to: { componentId: 'GND', terminalId: 'g' } },
  ];
  for (let i = 0; i < stages - 1; i++) wires.push({ id: `w${i + 1}`, from: { componentId: `R${i}`, terminalId: 'b' }, to: { componentId: `R${i + 1}`, terminalId: 'a' } });
  wires.push({ id: 'wfinal', from: { componentId: `R${stages - 1}`, terminalId: 'b' }, to: { componentId: 'GND', terminalId: 'g' } });
  return { version: 1, components, wires };
}

export function generateLEDMatrix(rows: number, cols: number): CircuitDocument { return { version: 1, components: [], wires: [] }; }
export function generateRCFilterChain(stages: number, R?: number, C?: number): CircuitDocument { return { version: 1, components: [], wires: [] }; }
export function generateMixedCircuit(stages: number): CircuitDocument { return { version: 1, components: [], wires: [] }; }

export interface BenchmarkResult { componentCount: number; wireCount: number; nodeCount: number; buildNodeMapMs: number; solveDCMs: number; stepMs: number; usedSparseSolver: boolean; ok: boolean; error?: string; }
export function benchmarkCircuit(components: CircuitComponent[], wires: Wire[], plugins: Map<string, ComponentPlugin>): BenchmarkResult {
  const result: BenchmarkResult = { componentCount: components.length, wireCount: wires.length, nodeCount: 0, buildNodeMapMs: 0, solveDCMs: 0, stepMs: 0, usedSparseSolver: false, ok: true };
  try {
    const t0 = performance.now(); const nm = buildNodeMap(components, wires, plugins); result.buildNodeMapMs = performance.now() - t0; result.nodeCount = nm.numNodes; result.usedSparseSolver = nm.numNodes > 80;
    const t1 = performance.now(); const dc = solveDC(components, wires, plugins); result.solveDCMs = performance.now() - t1;
    if (!dc) { result.ok = false; result.error = 'singular'; return result; }
    let prev: any = undefined; const t2 = performance.now();
    for (let i = 0; i < 10; i++) { const r = simulateStep(components, wires, plugins, prev, 1e-4); if (!r) { result.ok = false; result.error = `step ${i} failed`; return result; } prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state }; }
    result.stepMs = (performance.now() - t2) / 10;
  } catch (err) { result.ok = false; result.error = (err as Error).message; }
  return result;
}
export function formatBenchmark(r: BenchmarkResult): string { return `Components: ${r.componentCount}\nNodes: ${r.nodeCount}\nSolve DC: ${r.solveDCMs.toFixed(2)}ms\nPer step: ${r.stepMs.toFixed(2)}ms`; }
