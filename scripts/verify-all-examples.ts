// Comprehensive verification of ALL examples — checks simulation, currents, voltages.
import { simulateStep, computeComponentCurrents, computeWireCurrents, buildNodeMap, getTerminalsForComponent } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import { exampleCategories } from '../src/lib/circuit/examples';
import type { ComponentPlugin, SimContext, CircuitDocument } from '../src/lib/circuit/types';

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

  const allExamples = exampleCategories.flatMap(c => c.examples.map(e => ({ ...e, category: c.label })));
  let totalIssues = 0;

  console.log('=== Comprehensive Example Verification ===\n');

  for (const ex of allExamples) {
    const issues: string[] = [];
    const doc = ex.doc;

    // 1. Check all wires connect
    const plugins = new Map<string, ComponentPlugin>();
    for (const c of doc.components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    for (const w of doc.wires) {
      const fromComp = doc.components.find(c => c.id === w.from.componentId);
      const toComp = doc.components.find(c => c.id === w.to.componentId);
      if (!fromComp) { issues.push(`Wire ${w.id}: from component '${w.from.componentId}' missing`); continue; }
      if (!toComp) { issues.push(`Wire ${w.id}: to component '${w.to.componentId}' missing`); continue; }
      const fromPlugin = plugins.get(fromComp.type);
      const toPlugin = plugins.get(toComp.type);
      if (!fromPlugin) { issues.push(`Wire ${w.id}: plugin '${fromComp.type}' missing`); continue; }
      if (!toPlugin) { issues.push(`Wire ${w.id}: plugin '${toComp.type}' missing`); continue; }
      const fromTerm = fromPlugin.terminals.find(t => t.id === w.from.terminalId);
      const toTerm = toPlugin.terminals.find(t => t.id === w.to.terminalId);
      if (!fromTerm) { issues.push(`Wire ${w.id}: terminal '${w.from.terminalId}' missing on ${fromComp.type}`); continue; }
      if (!toTerm) { issues.push(`Wire ${w.id}: terminal '${w.to.terminalId}' missing on ${toComp.type}`); continue; }
    }

    // 2. Check for unconnected component terminals
    for (const comp of doc.components) {
      const plugin = plugins.get(comp.type);
      if (!plugin) continue;
      for (const term of plugin.terminals) {
        const wired = doc.wires.some(w =>
          (w.from.componentId === comp.id && w.from.terminalId === term.id) ||
          (w.to.componentId === comp.id && w.to.terminalId === term.id)
        );
        if (!wired && term.electricalType !== 'power_in' && comp.type !== 'ground' && comp.type !== 'junction') {
          // Arduino/MCU pins are often left unconnected (only used pins are wired)
          // Also skip optional terminals on other ICs
          const isMcu = comp.type === 'arduino' || comp.type === 'arduinoReal' || comp.type === 'raspberryPi';
          const optional = ['vcc', 'gnd', '5v', 'ctrl', 'rst', 'co'].includes(term.id);
          if (!optional && !isMcu) {
            issues.push(`Component ${comp.id} (${comp.type}): terminal '${term.id}' is not connected`);
          }
        }
      }
    }

    // 3. Simulate through store (saves/restores simContext)
    let simContext: SimContext | null = null;
    const dt = 1e-4;
    for (const comp of doc.components) {
      if (!comp.simState) comp.simState = {};
    }

    // Determine if fast-forward applies
    const hasPulse = doc.components.some(c => c.type === 'pulseSource');
    const hasArduino = doc.components.some(c => c.type === 'arduinoReal' || c.type === 'arduino');
    const hasAstable555 = doc.components.some(c => c.type === 'timer555' && (c.parameters.astable as boolean));
    const hasCapacitor = doc.components.some(c => c.type === 'capacitor' || c.type === 'inductor');

    let simHadCurrent = false;

    for (let frame = 0; frame < 100; frame++) {
      const persistentState = simContext?.state ?? {};
      const prev = simContext
        ? { nodeVoltage: simContext.nodeVoltage, branchCurrent: simContext.branchCurrent, time: simContext.time, state: persistentState }
        : { nodeVoltage: new Float64Array(0), branchCurrent: new Float64Array(0), time: 0, state: persistentState };

      const result = simulateStep(doc.components, doc.wires, plugins, prev, dt);
      if (!result) {
        issues.push(`Simulation failed (singular matrix) at frame ${frame}`);
        break;
      }
      simContext = result.sim;

      // Check for current flow across ALL steps
      if (!simHadCurrent) {
        const wc = computeWireCurrents(doc.components, doc.wires, plugins, simContext);
        for (const [, i] of wc) {
          if (Math.abs(i) > 1e-9) { simHadCurrent = true; break; }
        }
      }

      // Fast-forward
      if (hasPulse && !hasCapacitor && !hasArduino) {
        let minFreq = Infinity;
        for (const c of doc.components) {
          if (c.type === 'pulseSource') {
            const f = c.parameters.frequency as number;
            if (f > 0 && f < minFreq) minFreq = f;
          }
        }
        if (minFreq !== Infinity) {
          const phase = (simContext.time * minFreq) % 1;
          const timeToRisingEdge = (1.0 - phase) / minFreq;
          const advance = Math.min(0.016, timeToRisingEdge + 0.001);
          if (advance > dt) simContext.time = simContext.time + advance;
        }
      }
      if (hasAstable555) {
        let minFreq = Infinity;
        for (const c of doc.components) {
          if (c.type === 'timer555' && (c.parameters.astable as boolean)) {
            const r1 = (c.parameters.r1 as number) || 47000;
            const r2 = (c.parameters.r2 as number) || 47000;
            const cap = (c.parameters.c as number) || 1e-5;
            const period = 0.693 * (r1 + 2 * r2) * cap;
            const f = 1 / period;
            if (f > 0 && f < minFreq) minFreq = f;
          }
        }
        if (minFreq !== Infinity) {
          const phase = (simContext.time * minFreq) % 1;
          const timeToRisingEdge = (1.0 - phase) / minFreq;
          const advance = Math.min(0.016, timeToRisingEdge + 0.001);
          if (advance > dt) simContext.time = simContext.time + advance;
        }
      }
    }

    if (!simContext) {
      issues.push('Simulation returned null');
    } else {
      // 4. Check for NaN/Infinity in node voltages
      for (let i = 0; i < simContext.nodeVoltage.length; i++) {
        const v = simContext.nodeVoltage[i];
        if (isNaN(v) || !isFinite(v)) {
          issues.push(`Node ${i} has ${isNaN(v) ? 'NaN' : 'Infinity'} voltage`);
        }
        if (Math.abs(v) > 1e6) {
          issues.push(`Node ${i} has absurd voltage: ${v.toFixed(1)}V`);
        }
      }

      // 5. Check wire currents
      const wireCurrents = computeWireCurrents(doc.components, doc.wires, plugins, simContext);
      const compCurrents = computeComponentCurrents(doc.components, doc.wires, plugins, simContext);

      let hasCurrentFlow = false;
      for (const [id, i] of wireCurrents) {
        if (Math.abs(i) > 1e-9) hasCurrentFlow = true;
        if (isNaN(i) || !isFinite(i)) {
          issues.push(`Wire ${id} has ${isNaN(i) ? 'NaN' : 'Infinity'} current`);
        }
      }

      // 6. Check for expected current flow — check across ALL steps, not just the last
      const hasVoltageSource = doc.components.some(c =>
        c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'pulseSource' ||
        c.type === 'currentSource' || c.type === 'timer555' || c.type === 'cd4026' ||
        c.type === 'arduinoReal' || c.type === 'arduino' || c.type === 'vco');
      if (hasVoltageSource && !simHadCurrent && doc.wires.length > 3) {
        issues.push('No current flow detected in any wire across all 100 steps (should have some)');
      }

      // 7. Check for zero-current wires that should have current
      for (const w of doc.wires) {
        const i = Math.abs(wireCurrents.get(w.id) ?? 0);
        if (i > 1e-4) continue; // has current, OK

        // Check if this wire SHOULD have current
        const fromComp = doc.components.find(c => c.id === w.from.componentId);
        const toComp = doc.components.find(c => c.id === w.to.componentId);
        if (!fromComp || !toComp) continue;

        // Wires from voltage sources to loads should have current
        const isSource = fromComp.type === 'dcVoltage' || fromComp.type === 'acVoltage' || fromComp.type === 'pulseSource';
        const isLoad = toComp.type === 'resistor' || toComp.type === 'led' || toComp.type === 'lamp' ||
                       toComp.type === 'speaker' || toComp.type === 'dcMotor' || toComp.type === 'diode';
        if (isSource && isLoad && i < 1e-9) {
          issues.push(`Wire ${w.id} (${fromComp.id}.${w.from.terminalId} → ${toComp.id}.${w.to.terminalId}): source→load but 0 current`);
        }
      }
    }

    // Report
    const status = issues.length === 0 ? '✓ OK' : `✗ ${issues.length} issue(s)`;
    console.log(`[${ex.category}] ${ex.name}: ${status}`);
    for (const issue of issues) {
      console.log(`    ⚠ ${issue}`);
      totalIssues++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total examples: ${allExamples.length}`);
  console.log(`Total issues: ${totalIssues}`);
  if (totalIssues === 0) {
    console.log('✓ All examples verified successfully!');
  } else {
    console.log('✗ Issues found — needs fixing.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
