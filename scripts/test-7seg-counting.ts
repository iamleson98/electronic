// Test: verify the 7-segment counter advances through digits at a reasonable rate.
// Previously, the simulation advanced at dt=0.1ms per step, so a 500ms wait took
// 5000 steps (~80 seconds at 60Hz). The fix fast-forwards sim.time when the
// Arduino is in a wait state.

import { simulateStep } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { exampleSevenSeg } from '../src/lib/circuit/examples';
import type { ComponentPlugin } from '../src/lib/circuit/types';

async function main() {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/advanced');
  await import('../src/lib/circuit/components/advanced-devices');
  await import('../src/lib/circuit/components/arduino-real');
  await import('../src/lib/circuit/components/kicad-parity');
  await import('../src/lib/circuit/components/power-symbols');

  const doc = exampleSevenSeg;
  const plugins = new Map<string, ComponentPlugin>();
  for (const comp of doc.components) {
    const p = getPlugin(comp.type);
    if (p) plugins.set(comp.type, p);
  }

  for (const comp of doc.components) {
    if (!comp.simState) comp.simState = {};
  }

  // Simulate using the same parameters as the app: dt=1e-4, 1 sub-step per step.
  // Run 50 steps (≈ what the app does in ~1 second at 60Hz, since step() is
  // called every 16ms but each call only advances sim.time by dt=0.1ms).
  // With the fast-forward fix, 50 steps should be enough to cycle through
  // multiple digits (each wait 500ms completes in 1 step).
  let prev: any = undefined;
  let sim: any = null;
  const segmentHistory: { step: number; time: number; lit: string }[] = [];
  for (let i = 0; i < 50; i++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) { console.log('solve failed at step', i); break; }
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };

    // Record segment state every 5 steps
    if (i % 5 === 0 || i < 10) {
      const seg1 = doc.components.find(c => c.id === 'seg1')!;
      const segPlugin = plugins.get('sevenSegment')!;
      const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
      const terms = getTerminalsForComponent(seg1, segPlugin, nodeMap);
      let lit: string[] = [];
      for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const term = terms.find(t => t.terminalId === seg);
        if (!term) continue;
        const v = sim.nodeVoltage[term.nodeId];
        if (v > 2.0) lit.push(seg);
      }
      segmentHistory.push({ step: i, time: sim.time, lit: lit.join(',') });
    }
  }

  console.log('=== Segment state over 50 simulation steps (dt=1e-4) ===\n');
  for (const h of segmentHistory) {
    // Map lit segments to digit
    const digitMap: Record<string, string> = {
      'a,b,c,d,e,f': '0',
      'b,c': '1',
      'a,b,d,e,g': '2',
      'a,b,c,d,g': '3',
      'b,c,f,g': '4',
      'a,c,d,f,g': '5',
      'a,c,d,e,f,g': '6',
      'a,b,c': '7',
      'a,b,c,d,e,f,g': '8',
      'a,b,c,d,f,g': '9',
    };
    const digit = digitMap[h.lit] ?? '?';
    console.log(`  step ${String(h.step).padStart(2)}  t=${h.time.toFixed(4).padStart(8)}s  lit=[${h.lit}]  → digit ${digit}`);
  }

  // Count distinct digits seen
  const digits = new Set(segmentHistory.map(h => {
    const digitMap: Record<string, string> = {
      'a,b,c,d,e,f': '0', 'b,c': '1', 'a,b,d,e,g': '2', 'a,b,c,d,g': '3',
      'b,c,f,g': '4', 'a,c,d,f,g': '5', 'a,c,d,e,f,g': '6', 'a,b,c': '7',
      'a,b,c,d,e,f,g': '8', 'a,b,c,d,f,g': '9',
    };
    return digitMap[h.lit] ?? '?';
  }));
  console.log(`\nDistinct digits seen: ${digits.size} (${[...digits].sort().join(',')})`);

  if (digits.size >= 3) {
    console.log('✓ Counter is advancing through multiple digits — fast-forward works!');
  } else {
    console.log('✗ Counter stuck on few digits — fast-forward may not be working');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
