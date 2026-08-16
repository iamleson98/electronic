import type { CircuitComponent, Wire, CircuitDocument, ComponentPlugin } from './types';
import { solveDC, buildNodeMap, getTerminalsForComponent, computeComponentCurrents } from './engine';

export interface SweepConfig { componentId: string; parameter: string; start: number; end: number; points: number; scale: 'linear' | 'log'; outputNode: string; measurement: 'voltage' | 'current'; }
export interface SweepResult { sweepValues: number[]; outputValues: number[]; sweepParameter: string; outputLabel: string; unit: string; ok: boolean; failedPoints: number; warnings: string[]; }

export function generateSweepValues(start: number, end: number, points: number, scale: 'linear' | 'log'): number[] {
  if (points <= 1) return [start];
  if (scale === 'log') {
    const ls = Math.log10(Math.max(start, 1e-15)), le = Math.log10(Math.max(end, 1e-15)), st = (le - ls) / (points - 1), r: number[] = [];
    for (let i = 0; i < points; i++) r.push(Math.pow(10, ls + i * st));
    return r;
  }
  const st = (end - start) / (points - 1), r: number[] = [];
  for (let i = 0; i < points; i++) r.push(start + i * st);
  return r;
}

export function runDCSweep(doc: CircuitDocument, config: SweepConfig, plugins: Map<string, ComponentPlugin>): SweepResult {
  const sweepValues = generateSweepValues(config.start, config.end, config.points, config.scale);
  const outputValues: number[] = [];
  let failedPoints = 0;
  const warnings: string[] = [];
  for (const sweepValue of sweepValues) {
    const components = doc.components.map(c => c.id === config.componentId ? { ...c, parameters: { ...c.parameters, [config.parameter]: sweepValue }, simState: {} } : { ...c, simState: {} });
    const sim = solveDC(components, doc.wires, plugins);
    if (!sim) { outputValues.push(NaN); failedPoints++; continue; }
    if (config.measurement === 'voltage') {
      const nm = buildNodeMap(components, doc.wires, plugins);
      const nodeId = nm.terminalNode.get(config.outputNode);
      outputValues.push(nodeId !== undefined ? (sim.nodeVoltage[nodeId] ?? 0) : NaN);
    } else {
      const cc = computeComponentCurrents(components, doc.wires, plugins, sim);
      outputValues.push(cc.get(config.outputNode) ?? NaN);
    }
  }
  return { sweepValues, outputValues, sweepParameter: `${config.componentId}.${config.parameter}`, outputLabel: config.measurement === 'voltage' ? `V(${config.outputNode})` : `I(${config.outputNode})`, unit: config.measurement === 'voltage' ? 'V' : 'A', ok: failedPoints === 0, failedPoints, warnings };
}
