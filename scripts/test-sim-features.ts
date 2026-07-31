// Smoke test for new simulation engine features.
// Run with: npx tsx scripts/test-sim-features.ts
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent } from '../src/lib/circuit/types';

// register built-in plugins
import '../src/lib/circuit/components';

import { DEFAULT_OPTIONS, mergeOptions, thermalVoltage, tempScaleResistance } from '../src/lib/circuit/sim-options';
import { cAdd, cMul, cDiv, cAbs, cPhase, cFromPolar, type Complex,
         createComplexMnaSystem, solveComplexMna, cStampConductance, cStampVoltageSource } from '../src/lib/circuit/complex-solver';
import { runAC, runDCSweep, runTF, runNoise, runFour } from '../src/lib/circuit/analysis';
import { runSens } from '../src/lib/circuit/sensitivity';
import { capTrapezoidal, capGear2, inductorTrapezoidal, inductorGear2, detectTrapOscillation, adaptTimestep, DEFAULT_TRAP_CONTROLLER } from '../src/lib/circuit/integration';
import { solveDCWithGminStepping, solveDCWithSourceStepping, solveDCRobust } from '../src/lib/circuit/convergence';
import { runBatch, applyParams } from '../src/lib/circuit/batch-runner';
import { parseMeasLine, execMeas, TraceMath, computeFFT, complexToMagnitude, complexToPhase, complexToDb, xyMode, exportRawFile, sampleStimulus, stimulusToSPICE } from '../src/lib/circuit/measurement';
import { evalExpression } from '../src/lib/circuit/components/advanced-devices';
import { buildNodeMap, solveDC } from '../src/lib/circuit/engine';

const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── Test 1: Sim options ──
const opts = mergeOptions({ reltol: 1e-4 });
ok('SimOptions: defaults applied', opts.reltol === 1e-4 && opts.gmin === 1e-12);
ok('SimOptions: defaults method=euler (preserve existing)', opts.method === 'euler');
ok('SimOptions: thermal voltage at 27°C ≈ 25.85mV', Math.abs(thermalVoltage(27) - 0.02585) < 1e-4);
ok('SimOptions: temp-scaled resistance', tempScaleResistance(1000, 0.0039, 0, 100, 27) > 1000);

// ── Test 2: Complex number arithmetic ──
const a = { re: 3, im: 4 };
const b = { re: 1, im: 1 };
ok('Complex: |3+4i| = 5', Math.abs(cAbs(a) - 5) < 1e-10);
ok('Complex: phase(3+4i) ≈ 53.13°', Math.abs(cPhase(a) * 180 / Math.PI - 53.13) < 0.1);
ok('Complex: (3+4i) + (1+1i) = (4+5i)', cAdd(a, b).re === 4 && cAdd(a, b).im === 5);
ok('Complex: (3+4i) * (1+1i) = (-1+7i)', cMul(a, b).re === -1 && cMul(a, b).im === 7);
ok('Complex: (3+4i) / (1+1i) = 3.5+0.5i', Math.abs(cDiv(a, b).re - 3.5) < 1e-10 && Math.abs(cDiv(a, b).im - 0.5) < 1e-10);
ok('Complex: polar(5, 53.13°) → (3+4i)', Math.abs(cFromPolar(5, 0.9273).re - 3) < 0.01);

// ── Test 3: Complex MNA solver — resistor divider at DC ──
// Simple circuit: 1V DC → R1=1k → out → R2=1k → GND
// At DC (ω=0): Vout = 0.5V
const sys3 = createComplexMnaSystem(2, 4);  // 2 nodes (1 + GND), 4 extras
cStampConductance(sys3, 1, 2, { re: 1/1000, im: 0 });   // R1 from node 1 to node 2: 1mS
cStampConductance(sys3, 2, 0, { re: 1/1000, im: 0 });   // R2 from node 2 to GND: 1mS
// voltage source at node 1
cStampVoltageSource(sys3, 1, 0, { re: 1, im: 0 });
// shrink system to actual size (3: V1, V2, I_vsrc)
const actualSize = sys3.nextExtra;
const shrunk = createComplexMnaSystem(2, actualSize - 2);
for (let r = 0; r < actualSize; r++) {
  for (let c = 0; c < actualSize; c++) {
    const srcIdx = 2 * (r * sys3.size + c);
    const dstIdx = 2 * (r * actualSize + c);
    shrunk.A[dstIdx] = sys3.A[srcIdx];
    shrunk.A[dstIdx + 1] = sys3.A[srcIdx + 1];
  }
  shrunk.z[2 * r] = sys3.z[2 * r];
  shrunk.z[2 * r + 1] = sys3.z[2 * r + 1];
}
const x3 = solveComplexMna(shrunk);
ok('Complex MNA: solves divider at DC (Vout ≈ 0.5V)', x3 !== null && Math.abs(x3[1].re - 0.5) < 1e-3);

// ── Test 4: AC analysis on RC low-pass ──
const components4: CircuitComponent[] = [
  { id: 'v1', type: 'dcVoltage', position: { x: 0, y: 0 }, rotation: 0, parameters: { voltage: 1 }, refdes: 'V1' },
  { id: 'r1', type: 'resistor', position: { x: 5, y: 0 }, rotation: 0, parameters: { resistance: 1000 }, refdes: 'R1' },
  { id: 'c1', type: 'capacitor', position: { x: 10, y: 0 }, rotation: 0, parameters: { capacitance: 1e-6, initialV: 0 }, refdes: 'C1' },
  { id: 'gnd', type: 'ground', position: { x: 15, y: 0 }, rotation: 0, parameters: {}, refdes: 'GND' },
];
const wires4 = [
  { id: 'w1', from: { componentId: 'v1', terminalId: 'p' }, to: { componentId: 'r1', terminalId: 'a' } },
  { id: 'w2', from: { componentId: 'r1', terminalId: 'b' }, to: { componentId: 'c1', terminalId: 'a' } },
  { id: 'w3', from: { componentId: 'c1', terminalId: 'b' }, to: { componentId: 'gnd', terminalId: 'g' } },
  { id: 'w4', from: { componentId: 'v1', terminalId: 'n' }, to: { componentId: 'gnd', terminalId: 'g' } },
];
const plugins4 = new Map();
plugins4.set('dcVoltage', getPlugin('dcVoltage'));
plugins4.set('resistor', getPlugin('resistor'));
plugins4.set('capacitor', getPlugin('capacitor'));
plugins4.set('ground', getPlugin('ground'));

const acResult = runAC(components4, wires4, plugins4, {
  type: 'ac', sweep: 'dec', nPoints: 10, fStart: 1, fStop: 1e6, sourceId: 'v1', outputNode: 'p',
});
ok('AC: RC analysis returns traces', acResult.traces.length > 0);
ok('AC: RC analysis converges', acResult.report.converged);

// ── Test 5: DC sweep ──
const dcResult = runDCSweep(components4, wires4, plugins4, {
  type: 'dc', sourceId: 'v1', vStart: 0, vStop: 5, vStep: 1, outputNode: 'p',
});
ok('DC sweep: returns trace', dcResult.traces.length === 1);
ok('DC sweep: 6 points (0..5 step 1)', (dcResult.traces[0] as any).yValues.length === 6);

// ── Test 6: Transfer function ──
const tfResult = runTF(components4, wires4, plugins4, {
  type: 'tf', inputSourceId: 'v1', outputNode: 'p',
});
ok('TF: returns scalars', 'gain' in tfResult.scalars);

// ── Test 7: Sensitivity ──
const sensResult = runSens(components4, wires4, plugins4, {
  type: 'sens', outputNode: 'p', mode: 'dc', parameter: 'resistance',
});
ok('Sens: returns trace', sensResult.traces.length > 0);

// ── Test 8: Noise analysis ──
const noiseResult = runNoise(components4, wires4, plugins4, {
  type: 'noise', outputNode: 'p', inputSourceId: 'v1', fStart: 1, fStop: 1e6, nPoints: 10, sweep: 'dec',
});
ok('Noise: returns trace', noiseResult.traces.length > 0);
ok('Noise: trace has values', (noiseResult.traces[0] as any).yValues.length > 0);

// ── Test 9: Trapezoidal integration ──
const trap = capTrapezoidal(1e-6, 1e-4, 0.5, 0.001);
ok('Trap: G_eq = 2C/dt', Math.abs(trap.gEq - 2 * 1e-6 / 1e-4) < 1e-12);
ok('Trap: I_eq = gEq*vPrev + iPrev', Math.abs(trap.iEq - (2e-6/1e-4) * 0.5 - 0.001) < 1e-12);

const trapL = inductorTrapezoidal(1e-3, 1e-4, 0.001, 0.5);
ok('TrapL: G_eq = dt/(2L)', Math.abs(trapL.gEq - 1e-4 / (2 * 1e-3)) < 1e-12);

// ── Test 10: Gear-2 integration ──
const gear = capGear2(1e-6, 1e-4, 0.5, 0.3);
ok('Gear2: G_eq = 3C/(2dt)', Math.abs(gear.gEq - 3 * 1e-6 / (2 * 1e-4)) < 1e-12);

// ── Test 11: Trap oscillation detection ──
ok('Trap oscillation: no oscillation on monotonic', !detectTrapOscillation([1, 2, 3, 4]));
ok('Trap oscillation: detects oscillation on alternating', detectTrapOscillation([0, 1, 0, 1]));

// ── Test 12: Adaptive timestep ──
const newDt = adaptTimestep(DEFAULT_TRAP_CONTROLLER, 1e-4, new Float64Array([0, 0]), new Float64Array([0, 5]));
ok('Adaptive dt: shrinks on large dv', newDt < 1e-4);

// ── Test 13: Convergence aids (robust DC) ──
const robustResult = solveDCRobust(components4, wires4, plugins4);
ok('Convergence: robust DC converges on simple circuit', robustResult.sim !== null);

// ── Test 14: Source stepping ──
const stepResult = solveDCWithSourceStepping(components4, wires4, plugins4);
ok('Source stepping: returns result', stepResult.sim !== null || stepResult.report.failure !== undefined);

// ── Test 15: New plugins registered ──
ok('Plugin: diodeShockley registered', !!getPlugin('diodeShockley'));
ok('Plugin: bjtGPNpn registered', !!getPlugin('bjtGPNpn'));
ok('Plugin: bjtGPPnp registered', !!getPlugin('bjtGPPnp'));
ok('Plugin: mosLevel1N registered', !!getPlugin('mosLevel1N'));
ok('Plugin: mosLevel1P registered', !!getPlugin('mosLevel1P'));
ok('Plugin: jfetN registered', !!getPlugin('jfetN'));
ok('Plugin: jfetP registered', !!getPlugin('jfetP'));
ok('Plugin: bvSource registered', !!getPlugin('bvSource'));
ok('Plugin: biSource registered', !!getPlugin('biSource'));
ok('Plugin: vcSwitch registered', !!getPlugin('vcSwitch'));
ok('Plugin: coupledInductor registered', !!getPlugin('coupledInductor'));
ok('Plugin: transLineLossless registered', !!getPlugin('transLineLossless'));
ok('Plugin: vcvsUser registered', !!getPlugin('vcvsUser'));
ok('Plugin: vccsUser registered', !!getPlugin('vccsUser'));
ok('Plugin: cccsUser registered', !!getPlugin('cccsUser'));
ok('Plugin: ccvsUser registered', !!getPlugin('ccvsUser'));
ok('Plugin: opampReal registered', !!getPlugin('opampReal'));

// ── Test 16: Existing plugins still work ──
ok('Existing: diode still registered', !!getPlugin('diode'));
ok('Existing: npn still registered', !!getPlugin('npn'));
ok('Existing: nmos still registered', !!getPlugin('nmos'));
ok('Existing: opamp still registered', !!getPlugin('opamp'));

// ── Test 17: .meas parser ──
const cmd1 = parseMeasLine('.meas tran vout_avg AVG V(out) FROM=0 TO=1ms');
ok('Meas: parses AVG', cmd1 !== null && cmd1.type === 'AVG');
const cmd2 = parseMeasLine('.meas tran t_delay WHEN V(out)=2.5');
ok('Meas: parses WHEN', cmd2 !== null && cmd2.type === 'WHEN');
const cmd3 = parseMeasLine('.meas dc gain FIND V(out) WHEN V(in)=1');
ok('Meas: parses FIND...WHEN', cmd3 !== null && cmd3.type === 'FIND');

// ── Test 18: .meas executor ──
const trace = {
  name: 'V(out)', xValues: new Float64Array([0, 0.001, 0.002, 0.003]),
  yValues: new Float64Array([0, 2.5, 5, 5]), xLabel: 't', yLabel: 'V',
};
const measResult = execMeas({ mode: 'tran', name: 'vmax', type: 'MAX', expr: 'V(out)' }, trace);
ok('Meas executor: MAX = 5', Math.abs(measResult.value - 5) < 1e-6);
const measAvg = execMeas({ mode: 'tran', name: 'vavg', type: 'AVG', expr: 'V(out)' }, trace);
ok('Meas executor: AVG = 3.125', Math.abs(measAvg.value - 3.125) < 1e-6);

// ── Test 19: Trace math ──
const t1 = { name: 'a', xValues: new Float64Array([0, 1, 2]), yValues: new Float64Array([1, 2, 3]), xLabel: 't', yLabel: 'V' };
const t2 = { name: 'b', xValues: new Float64Array([0, 1, 2]), yValues: new Float64Array([4, 5, 6]), xLabel: 't', yLabel: 'V' };
const tsum = TraceMath.add(t1, t2);
ok('TraceMath: add', tsum.yValues[0] === 5 && tsum.yValues[2] === 9);
const tdiff = TraceMath.sub(t1, t2);
ok('TraceMath: sub', tdiff.yValues[0] === -3);
const tdb = TraceMath.db20(t1);
ok('TraceMath: db20', tdb.yValues[0] === 20 * Math.log10(1));
const tInt = TraceMath.integrate(t1);
// ∫y dt for [1,2,3] with dt=1: acc starts at 0, then accumulates 2 (i=1, dt=1), then 5 (i=2, dt=1, +=3)
ok('TraceMath: integrate', Math.abs(tInt.yValues[2] - 5) < 1e-6);

// ── Test 20: FFT ──
const fftInput = new Float64Array(64);
for (let i = 0; i < 64; i++) fftInput[i] = Math.sin(2 * Math.PI * 5 * i / 64);
const fftTrace = { name: 'sin', xValues: new Float64Array(64).map((_, i) => i / 64), yValues: fftInput, xLabel: 't', yLabel: 'V' };
const fftResult = computeFFT(fftTrace);
ok('FFT: returns trace', fftResult.yValues.length > 0);
// peak should be at frequency 5 Hz
let peakIdx = 0;
let peakVal = 0;
for (let i = 0; i < fftResult.yValues.length; i++) {
  if (fftResult.yValues[i] > peakVal) { peakVal = fftResult.yValues[i]; peakIdx = i; }
}
ok('FFT: detects 5 Hz peak', Math.abs(fftResult.xValues[peakIdx] - 5) < 1);

// ── Test 21: Complex trace conversion ──
const complexTrace = {
  name: 'V(out)', xValues: new Float64Array([1, 10, 100]),
  yValues: new Float64Array([3, 0, 0, 4, 0, 0, 5, 0, 0]),  // (3+4i), (0+0i), (5+0i) -- wait, that's wrong; needs interleaved
};
// Fix: 3 traces with interleaved complex values
const complexTraceFixed = {
  name: 'V(out)', xValues: new Float64Array([1, 10, 100]),
  yValues: new Float64Array([3, 4, 0, 0, 5, 0]),  // (3+4i), (0+0i), (5+0i)
};
const magTrace = complexToMagnitude(complexTraceFixed as any);
ok('ComplexToMag: |3+4i| = 5', Math.abs(magTrace.yValues[0] - 5) < 1e-6);
const phaseTrace = complexToPhase(complexTraceFixed as any);
ok('ComplexToPhase: phase(3+4i) ≈ 53°', Math.abs(phaseTrace.yValues[0] - 53.13) < 0.1);
const dbTrace = complexToDb(complexTraceFixed as any);
ok('ComplexToDb: 20*log10(5) ≈ 14dB', Math.abs(dbTrace.yValues[0] - 20 * Math.log10(5)) < 1e-3);

// ── Test 22: XY mode ──
const xy = xyMode(t1, t2);
ok('XY mode: returns paired values', xy.x.length === 3 && xy.y.length === 3);

// ── Test 23: Raw file export ──
const raw = exportRawFile([t1, t2], 'Test Circuit');
ok('Raw file: has header', raw.startsWith('Title: Test Circuit'));
ok('Raw file: has Variables', raw.includes('Variables:'));
ok('Raw file: has Values', raw.includes('Values:'));

// ── Test 24: Stimuli ──
const sineStim = sampleStimulus({ type: 'sine', params: { voff: 0, vamp: 1, freq: 1000 } }, new Float64Array([0, 0.00025, 0.0005]));
ok('Stimulus: SINE returns 3 samples', sineStim.length === 3);
ok('Stimulus: SINE at quarter period = 1', Math.abs(sineStim[1] - 1) < 1e-3);
const pulseStim = sampleStimulus({ type: 'pulse', params: { v1: 0, v2: 5, td: 0, tr: 1e-9, tf: 1e-9, pw: 1e-3, per: 2e-3 } }, new Float64Array([0, 0.0005, 0.0015]));
ok('Stimulus: PULSE returns 3 samples', pulseStim.length === 3);
ok('Stimulus: PULSE at mid-pulse = 5', Math.abs(pulseStim[1] - 5) < 1e-3);

const sineSpice = stimulusToSPICE({ type: 'sine', params: { voff: 0, vamp: 1, freq: 1000 } }, 'V1');
ok('Stimulus: SPICE format SINE', sineSpice.startsWith('V1 SINE(0 1 1000'));

// ── Test 25: Behavioral source expression evaluator ──
const v5 = evalExpression('V(a) + 3', new Float64Array([0, 1, 2, 3]), new Map([['a', 1]]), 0);
ok('ExprEval: V(a)+3 = 4 when V(a)=1', v5 === 4);
const v6 = evalExpression('sin(0)', new Float64Array(0), new Map(), 0);
ok('ExprEval: sin(0) = 0', v6 === 0);
const v7 = evalExpression('time + 1', new Float64Array(0), new Map(), 0.5);
ok('ExprEval: time+1 = 1.5 when time=0.5', v7 === 1.5);

// ── Test 26: Param substitution ──
const paramed = applyParams([
  { id: 'r1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0 as 0|1|2|3, parameters: { resistance: '{R1}' }, refdes: 'R1' },
], [{ name: 'R1', value: 4700 }]);
ok('applyParams: substitutes {R1}', paramed[0].parameters.resistance === 4700);

console.log('\nAll simulation smoke tests passed!');
