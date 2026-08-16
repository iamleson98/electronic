// End-to-end reliability check: simulate every example circuit for 200 steps
// and report any that produce NaN, crash, or have physics violations.
// This is a diagnostic script — run with: bun scripts/check-reliability.ts

import { exampleCategories } from '../src/lib/circuit/examples';
import { simulateStep, buildNodeMap, solveDC } from '../src/lib/circuit/engine';
import { validatePhysics } from '../src/lib/circuit/physics-validator';
import { getPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent, Wire, ComponentPlugin, SimContext } from '../src/lib/circuit/types';

async function main() {
  await import('../src/lib/circuit/components');

  type Issue = {
    example: string;
    category: string;
    phase: 'DC' | 'transient' | 'physics';
    issue: string;
    details?: string;
  };

  const issues: Issue[] = [];
  let totalExamples = 0;
  let okCount = 0;

  for (const cat of exampleCategories) {
    for (const ex of cat.examples) {
      totalExamples++;
      const name = ex.name;
      const catName = cat.name;
      const components = ex.doc.components;
      const wires = ex.doc.wires;

      // Build plugins map
      const plugins = new Map<string, ComponentPlugin>();
      for (const c of components) {
        const p = getPlugin(c.type);
        if (p) plugins.set(c.type, p);
      }

      // Ensure simState
      for (const c of components) if (!c.simState) c.simState = {};

      // 1. DC operating point
      let dc: SimContext | null = null;
      try {
        dc = solveDC(components, wires, plugins);
      } catch (e) {
        issues.push({ example: name, category: catName, phase: 'DC', issue: 'solveDC crashed', details: (e as Error).message });
        continue;
      }
      if (!dc) {
        issues.push({ example: name, category: catName, phase: 'DC', issue: 'solveDC returned null (singular matrix)' });
        continue;
      }
      // Check for NaN
      for (let i = 0; i < dc.nodeVoltage.length; i++) {
        if (!isFinite(dc.nodeVoltage[i])) {
          issues.push({ example: name, category: catName, phase: 'DC', issue: `NaN/Infinity at node ${i}: ${dc.nodeVoltage[i]}` });
          break;
        }
      }

      // 2. Transient simulation — 200 steps
      let prev: any = { nodeVoltage: dc.nodeVoltage, branchCurrent: dc.branchCurrent, time: dc.time, state: dc.state };
      let lastSim: SimContext | null = dc;
      let crashed = false;
      try {
        for (let i = 0; i < 200; i++) {
          const r = simulateStep(components, wires, plugins, prev, 1e-4);
          if (!r) {
            issues.push({ example: name, category: catName, phase: 'transient', issue: `simulateStep returned null at step ${i}` });
            crashed = true;
            break;
          }
          lastSim = r.sim;
          // Check for NaN
          for (let j = 0; j < r.sim.nodeVoltage.length; j++) {
            if (!isFinite(r.sim.nodeVoltage[j])) {
              issues.push({ example: name, category: catName, phase: 'transient', issue: `NaN at step ${i}, node ${j}: ${r.sim.nodeVoltage[j]}` });
              crashed = true;
              break;
            }
          }
          if (crashed) break;
          prev = { nodeVoltage: r.sim.nodeVoltage, branchCurrent: r.sim.branchCurrent, time: r.sim.time, state: r.sim.state };
        }
      } catch (e) {
        issues.push({ example: name, category: catName, phase: 'transient', issue: 'simulateStep crashed', details: (e as Error).message });
        crashed = true;
      }
      if (crashed) continue;

      // 3. Physics validation
      try {
        const result = validatePhysics(components, wires, plugins, lastSim!);
        const errors = result.violations.filter(v => v.severity === 'error');
        if (errors.length > 0) {
          issues.push({
            example: name, category: catName, phase: 'physics',
            issue: `${errors.length} physics violations`,
            details: errors.slice(0, 3).map(e => `${e.law}: ${e.message}`).join('; '),
          });
        }
      } catch (e) {
        issues.push({ example: name, category: catName, phase: 'physics', issue: 'validatePhysics crashed', details: (e as Error).message });
        continue;
      }

      okCount++;
    }
  }

  console.log(`\n=== RELIABILITY REPORT ===`);
  console.log(`Total examples: ${totalExamples}`);
  console.log(`OK: ${okCount}/${totalExamples}`);
  console.log(`Issues: ${issues.length}`);
  if (issues.length > 0) {
    console.log(`\n--- ISSUES ---`);
    for (const i of issues) {
      console.log(`[${i.category}] ${i.example} (${i.phase}): ${i.issue}`);
      if (i.details) console.log(`    ${i.details}`);
    }
  }
}

main().catch(console.error);
