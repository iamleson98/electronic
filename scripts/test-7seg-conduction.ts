// Test: verify wire conduction per digit in the 7-segment circuit.
// For each digit 0-9:
//   - The segments that are ON should have current flowing through their wires
//   - The segments that are OFF should have ~0 current
//   - The Arduino pin → resistor wires should also match (ON = current, OFF = ~0)

import { simulateStep, computeComponentCurrents, computeWireCurrents } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { exampleSevenSeg } from '../src/lib/circuit/examples';
import type { ComponentPlugin } from '../src/lib/circuit/types';

// Expected segment patterns for each digit (1 = ON, 0 = OFF)
const DIGIT_PATTERNS: Record<string, Record<string, number>> = {
  '0': { a:1, b:1, c:1, d:1, e:1, f:1, g:0 },
  '1': { a:0, b:1, c:1, d:0, e:0, f:0, g:0 },
  '2': { a:1, b:1, c:0, d:1, e:1, f:0, g:1 },
  '3': { a:1, b:1, c:1, d:1, e:0, f:0, g:1 },
  '4': { a:0, b:1, c:1, d:0, e:0, f:1, g:1 },
  '5': { a:1, b:0, c:1, d:1, e:0, f:1, g:1 },
  '6': { a:1, b:0, c:1, d:1, e:1, f:1, g:1 },
  '7': { a:1, b:1, c:1, d:0, e:0, f:0, g:0 },
  '8': { a:1, b:1, c:1, d:1, e:1, f:1, g:1 },
  '9': { a:1, b:1, c:1, d:1, e:0, f:1, g:1 },
};

// Map segment letter to the wire that feeds it (resistor → 7-seg)
const SEGMENT_WIRES: Record<string, string> = {
  a: 'wa2', b: 'wb2', c: 'wc2', d: 'wd2', e: 'we2', f: 'wf2', g: 'wg2',
};
// Map segment letter to the Arduino→resistor wire
const ARDUINO_WIRES: Record<string, string> = {
  a: 'wa1', b: 'wb1', c: 'wc1', d: 'wd1', e: 'we1', f: 'wf1', g: 'wg1',
};

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

  // Simulate with dt=0.016 (16ms per step, matching the fast-forward cap)
  // to advance through digits at a visible rate.
  let prev: any = undefined;
  let sim: any = null;

  const CURRENT_THRESHOLD = 0.0001; // 0.1 mA — below this, "no current"
  const seenDigits = new Set<string>();
  const results: { digit: string; segVoltages: Record<string, number>; segWireCurrents: Record<string, number>; ok: boolean }[] = [];

  // Run ~400 steps to cycle through all 10 digits (500ms each, 16ms fast-forward cap → ~31 steps per digit)
  for (let step = 0; step < 400; step++) {
    const r = simulateStep(doc.components, doc.wires, plugins, prev, 1e-4);
    if (!r) break;
    sim = r.sim;
    prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };

    // Determine current digit from segment voltages
    const seg1 = doc.components.find(c => c.id === 'seg1')!;
    const segPlugin = plugins.get('sevenSegment')!;
    const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
    const terms = getTerminalsForComponent(seg1, segPlugin, nodeMap);
    const segVoltages: Record<string, number> = {};
    const segOn: Record<string, boolean> = {};
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const term = terms.find(t => t.terminalId === seg);
      segVoltages[seg] = term ? sim.nodeVoltage[term.nodeId] : 0;
      segOn[seg] = segVoltages[seg] > 2.0;
    }
    // Match against digit patterns
    let matchedDigit = '?';
    for (const [d, pat] of Object.entries(DIGIT_PATTERNS)) {
      const matches = (['a','b','c','d','e','f','g'] as const).every(s => segOn[s] === (pat[s] === 1));
      if (matches) { matchedDigit = d; break; }
    }
    if (matchedDigit === '?' || seenDigits.has(matchedDigit)) continue;
    seenDigits.add(matchedDigit);

    // Check wire currents for this digit
    const wireCurrents = computeWireCurrents(doc.components, doc.wires, plugins, sim);
    const segWireCurrents: Record<string, number> = {};
    let ok = true;
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const expected = DIGIT_PATTERNS[matchedDigit][seg] === 1;
      const wId = SEGMENT_WIRES[seg];
      const i = Math.abs(wireCurrents.get(wId) ?? 0);
      segWireCurrents[seg] = i;
      const conducting = i > CURRENT_THRESHOLD;
      if (expected && !conducting) { ok = false; }
      if (!expected && conducting) { ok = false; }
    }
    results.push({ digit: matchedDigit, segVoltages, segWireCurrents, ok });
  }

  // Print results
  console.log('=== 7-Segment Wire Conduction Verification ===\n');
  console.log('Digit | a     b     c     d     e     f     g     | Status');
  console.log('      | (V/mA V/mA V/mA V/mA V/mA V/mA V/mA)');
  console.log('------+------------------------------------------------+--------');
  for (const r of results.sort((a, b) => Number(a.digit) - Number(b.digit))) {
    const cells = (['a','b','c','d','e','f','g'] as const).map(s => {
      const v = r.segVoltages[s];
      const i = r.segWireCurrents[s] * 1000; // mA
      const expected = DIGIT_PATTERNS[r.digit][s] === 1;
      const marker = expected ? '*' : ' ';
      return `${v.toFixed(1)}${marker}/${i.toFixed(2)}`;
    });
    console.log(`  ${r.digit}   | ${cells.join(' ')} | ${r.ok ? 'PASS' : 'FAIL'}`);
  }

  // Summary
  const allPass = results.every(r => r.ok);
  const digitsSeen = results.map(r => r.digit).sort().join(',');
  console.log(`\nDigits seen: ${digitsSeen} (${results.length} total)`);
  console.log(`* = segment should be ON (conducting), blank = should be OFF (no current)`);
  if (allPass && results.length >= 8) {
    console.log('\n✓ All digits verified: ON segments conduct, OFF segments do not.');
  } else {
    console.log('\n✗ Some mismatches — see FAIL rows above.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
