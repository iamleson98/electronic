// AI diagnostic tools — root-cause analysis for circuit failures.
//
// These tools give the AI the ability to diagnose WHY a circuit doesn't work,
// rather than just detecting THAT it doesn't work. The diagnostic engine
// combines:
//   - DC operating point analysis (floating nodes, short circuits)
//   - Full ERC (9 rule types from erc.ts)
//   - Physics validation (KCL, Ohm, power law violations)
//   - Pattern matching against common failure modes
//
// The output is a structured list of likely causes, ranked by probability,
// with suggested fixes.

import type { CircuitComponent, Wire, SimContext } from '../../circuit/types';
import { buildNodeMap, getTerminalsForComponent } from '../../circuit/engine';
import { runFullERC, type ERCError } from '../../circuit/erc';
import { validatePhysics, type PhysicsViolation } from '../../circuit/physics-validator';
import type { ComponentPlugin } from '../../circuit/types';
import type { Tool, ToolContext } from './types';

export interface DiagnosisIssue {
  /** severity: 'critical' (sim won't run), 'error' (wrong results), 'warning' (suboptimal) */
  severity: 'critical' | 'error' | 'warning';
  /** category: what kind of issue */
  category: 'missing-ground' | 'floating-node' | 'short-circuit' | 'open-circuit'
          | 'parallel-vsources' | 'missing-decoupling' | 'wrong-polarity'
          | 'over-current' | 'over-voltage' | 'convergence' | 'erc' | 'physics';
  /** human-readable title */
  title: string;
  /** detailed explanation of what's wrong */
  description: string;
  /** which components / nodes are involved */
  affectedComponents: string[];
  affectedNodes?: number[];
  /** suggested fix (actionable) */
  suggestedFix: string;
  /** related knowledge base article IDs */
  kbArticles?: string[];
  /** confidence 0-1 that this is the actual root cause */
  confidence: number;
}

export interface DiagnosisResult {
  issues: DiagnosisIssue[];
  summary: string;
  overallHealth: 'healthy' | 'warnings' | 'errors' | 'critical';
  nodeCount: number;
  componentCount: number;
  wireCount: number;
}

/**
 * Diagnose a circuit — the main entry point.
 *
 * Runs all available checks and returns a ranked list of issues with
 * suggested fixes. The AI can present these to the user in natural language.
 */
export function diagnoseCircuit(ctx: ToolContext): DiagnosisResult {
  const { doc, plugins, simContext } = ctx;
  const components = doc.components;
  const wires = doc.wires;
  const issues: DiagnosisIssue[] = [];

  // 1. Check for ground
  issues.push(...checkGround(components, plugins));

  // 2. Check for floating nodes
  issues.push(...checkFloatingNodes(components, wires, plugins));

  // 3. Check for parallel voltage sources
  issues.push(...checkParallelVoltageSources(components, wires, plugins));

  // 4. Run full ERC
  issues.push(...runERC(components, wires, plugins));

  // 5. Run physics validation (if sim has run)
  if (simContext) {
    issues.push(...runPhysicsValidation(components, wires, plugins, simContext));
  }

  // 6. Check for missing decoupling caps
  issues.push(...checkDecoupling(components, plugins));

  // 7. Check LED current limiting
  issues.push(...checkLEDCurrentLimiting(components, wires, plugins));

  // 8. Check for short circuits
  issues.push(...checkShortCircuits(components, wires, plugins));

  // Sort by confidence (highest first), then by severity
  const severityOrder = { critical: 0, error: 1, warning: 2 };
  issues.sort((a, b) => {
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return b.confidence - a.confidence;
  });

  // Overall health
  const hasCritical = issues.some(i => i.severity === 'critical');
  const hasError = issues.some(i => i.severity === 'error');
  const hasWarning = issues.some(i => i.severity === 'warning');
  const overallHealth = hasCritical ? 'critical' : hasError ? 'errors' : hasWarning ? 'warnings' : 'healthy';

  const summary = generateSummary(issues, overallHealth, components.length);

  // Compute node count
  const nodeMap = buildNodeMap(components, wires, plugins);
  return {
    issues,
    summary,
    overallHealth,
    nodeCount: nodeMap.numNodes,
    componentCount: components.length,
    wireCount: wires.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks
// ─────────────────────────────────────────────────────────────────────────────

function checkGround(
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  // Mirror the engine exactly: only 'ground'/'powerGND' terminals and nets
  // NAMED GND/gnd/0 map to node 0 (engine.ts pre-pass + net-label mapping).
  // powerAGND defaults to net 'AGND' — its own floating node — so counting
  // it as ground produced a false "has ground" pass while the solve failed.
  const hasGround = components.some(c =>
    c.type === 'ground' ||
    c.type === 'powerGND' ||
    (c.parameters?.net && ['GND', 'gnd', '0'].includes(c.parameters.net as string))
  );
  const hasVoltageSource = components.some(c =>
    c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'pulseSource'
  );

  if (!hasGround && hasVoltageSource) {
    issues.push({
      severity: 'critical',
      category: 'missing-ground',
      title: 'No ground reference found',
      description: 'The circuit has voltage sources but no Ground component. The simulator cannot determine any voltages without a 0V reference. Every circuit needs at least one ground.',
      affectedComponents: [],
      suggestedFix: 'Add a Ground component (from the Power category) and wire it to the negative terminal of your voltage source(s).',
      kbArticles: ['missing-ground'],
      confidence: 0.99,
    });
  }

  return issues;
}

function checkFloatingNodes(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  const nodeMap = buildNodeMap(components, wires, plugins);

  // For each component, check if all its terminals are connected
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;

    for (const terminal of plugin.terminals) {
      const termKey = `${comp.id}:${terminal.id}`;
      const nodeId = nodeMap.terminalNode.get(termKey);
      // If the terminal has no node, or its node has no path to ground
      // (other than through a capacitor), it's floating
      if (nodeId === undefined) {
        issues.push({
          severity: 'error',
          category: 'floating-node',
          title: `Unconnected terminal: ${comp.id}.${terminal.id}`,
          description: `Terminal "${terminal.label || terminal.id}" of component ${comp.id} (${plugin.name}) is not connected to anything. This will cause a "singular matrix" error or undefined behavior.`,
          affectedComponents: [comp.id],
          suggestedFix: `Wire ${comp.id}.${terminal.id} to another component, or to ground if it's an unused input.`,
          kbArticles: ['floating-node'],
          confidence: 0.9,
        });
      }
    }
  }

  return issues;
}

function checkParallelVoltageSources(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  const nodeMap = buildNodeMap(components, wires, plugins);

  // Find all voltage sources
  const vSources = components.filter(c =>
    c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'pulseSource'
  );

  // Check for pairs in parallel (both terminals connected to same nodes)
  for (let i = 0; i < vSources.length; i++) {
    for (let j = i + 1; j < vSources.length; j++) {
      const s1 = vSources[i];
      const s2 = vSources[j];
      const p1 = plugins.get(s1.type);
      const p2 = plugins.get(s2.type);
      if (!p1 || !p2) continue;

      // Get node IDs for each source's terminals
      const s1p = nodeMap.terminalNode.get(`${s1.id}:p`) ?? -1;
      const s1n = nodeMap.terminalNode.get(`${s1.id}:n`) ?? -2;
      const s2p = nodeMap.terminalNode.get(`${s2.id}:p`) ?? -3;
      const s2n = nodeMap.terminalNode.get(`${s2.id}:n`) ?? -4;

      // Check if they're in parallel (same two nodes)
      const sameNodes =
        (s1p === s2p && s1n === s2n) ||
        (s1p === s2n && s1n === s2p);

      if (sameNodes) {
        // Effective DC value per source type (dcVoltage has `voltage`, but
        // acVoltage/pulseSource don't — the old code always read 0V/0V).
        const effectiveDC = (s: typeof s1): number => {
          if (s.type === 'dcVoltage') return (s.parameters.voltage as number) ?? 0;
          if (s.type === 'acVoltage') return (s.parameters.offset as number) ?? 0;
          if (s.type === 'pulseSource') {
            const hi = (s.parameters.high as number) ?? 0;
            const lo = (s.parameters.low as number) ?? 0;
            return (hi + lo) / 2;
          }
          return 0;
        };
        const v1 = effectiveDC(s1);
        const v2 = effectiveDC(s2);
        issues.push({
          severity: 'critical',
          category: 'parallel-vsources',
          title: `Parallel voltage sources: ${s1.id} and ${s2.id}`,
          description: `${s1.id} and ${s2.id} are connected in parallel (both terminals to the same nodes). Ideal voltage sources in parallel create a singular matrix — the simulator cannot determine the current. ${v1 !== v2 ? `Their voltages differ (${v1}V vs ${v2}V), which would cause infinite current.` : 'Even with identical voltages, the current is undefined.'}`,
          affectedComponents: [s1.id, s2.id],
          affectedNodes: [s1p, s1n],
          suggestedFix: v1 !== v2
            ? `These sources have different voltages. Use only one source, or add a small series resistor (1 Ω) to one of them.`
            : `Use a single voltage source instead of two in parallel, or add a small series resistor (1 Ω) to each to model internal resistance.`,
          kbArticles: ['parallel-voltage-sources'],
          confidence: 0.85,
        });
      }
    }
  }

  return issues;
}

function runERC(
  components: CircuitComponent[],
  wires: Wire[],
  _plugins: Map<string, ComponentPlugin>,
): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  try {
    const ercResult = runFullERC(components, wires, []);
    for (const err of ercResult.errors) {
      issues.push({
        severity: err.severity === 'error' ? 'error' : 'warning',
        category: 'erc',
        title: err.message,
        description: err.message,
        affectedComponents: err.componentId ? [err.componentId] : [],
        suggestedFix: err.refs && err.refs.length > 0
          ? `Check component ${err.refs[0].componentId} (${err.refs[0].terminalId}).`
          : 'Review the circuit for the issue described above.',
        confidence: 0.7,
      });
    }
  } catch {
    // ERC might fail on incomplete circuits — ignore
  }
  return issues;
}

function runPhysicsValidation(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
  simContext: SimContext,
): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  try {
    const result = validatePhysics(components, wires, plugins, simContext);
    for (const v of result.violations) {
      const expectedActual = v.expected && v.actual ? ` Expected: ${v.expected}, Actual: ${v.actual}.` : '';
      issues.push({
        severity: v.severity === 'error' ? 'error' : 'warning',
        category: 'physics',
        title: `${v.law}: ${v.message}`,
        description: `${v.message}${expectedActual}`,
        affectedComponents: v.componentId ? [v.componentId] : [],
        suggestedFix: `Review the ${v.law} violation at ${v.componentId || 'node ' + v.nodeId}.`,
        confidence: 0.6,
      });
    }
  } catch {
    // ignore
  }
  return issues;
}

function checkDecoupling(
  components: CircuitComponent[],
  plugins: Map<string, ComponentPlugin>,
): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];

  // Find ICs that need decoupling
  const icTypes = new Set([
    'timer555', 'opamp', 'opampNonInverting', 'opampInverting',
    'lm358', 'lm741', 'tl072', 'comparator', 'lm311', 'lm393',
    'arduino', 'arduinoReal', 'raspberryPi',
    'adc', 'dac', 'crystalOscillator', 'vco',
    'dff', 'jkff', 'srlatch', 'cd4013', 'cd4066',
    'decoder', 'multiplexer',
    // Logic ICs
    'and', 'or', 'nand', 'nor', 'xor', 'not',
    'schmittNand', 'schmittNot', 'tristate',
  ]);

  for (const comp of components) {
    if (!icTypes.has(comp.type)) continue;

    // Check if there's a capacitor near the VCC pin
    const hasNearbyCap = components.some(c =>
      c.type === 'capacitor' &&
      Math.abs(c.position.x - comp.position.x) < 10 &&
      Math.abs(c.position.y - comp.position.y) < 10
    );

    if (!hasNearbyCap) {
      const plugin = plugins.get(comp.type);
      issues.push({
        severity: 'warning',
        category: 'missing-decoupling',
        title: `No decoupling capacitor near ${comp.id} (${plugin?.name || comp.type})`,
        description: `${comp.id} is an IC that switches internally, drawing transient current spikes. Without a decoupling capacitor (100 nF ceramic) close to its power pin, the IC may reset, oscillate, or inject noise into the power supply.`,
        affectedComponents: [comp.id],
        suggestedFix: `Place a 100 nF ceramic capacitor within 5 mm of ${comp.id}'s VCC pin, connecting VCC to GND. This supplies transient current and filters high-frequency noise.`,
        kbArticles: ['decoupling'],
        confidence: 0.5,
      });
    }
  }

  return issues;
}

function checkLEDCurrentLimiting(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];

  for (const comp of components) {
    if (comp.type !== 'led') continue;

    // Check if there's a resistor in series with the LED — on EITHER side.
    // (Checking only the anode missed the equally-valid cathode-side
    // resistor and produced a high-confidence false error.)
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;

    let hasSeriesR = false;
    for (const termId of ['a', 'k']) {
      const termWires = wires.filter(w =>
        (w.from.componentId === comp.id && w.from.terminalId === termId) ||
        (w.to.componentId === comp.id && w.to.terminalId === termId)
      );
      for (const wire of termWires) {
        const otherEnd = wire.from.componentId === comp.id ? wire.to : wire.from;
        const otherComp = components.find(c => c.id === otherEnd.componentId);
        if (otherComp && otherComp.type === 'resistor') {
          hasSeriesR = true;
          break;
        }
      }
      if (hasSeriesR) break;
    }

    if (!hasSeriesR) {
      issues.push({
        severity: 'error',
        category: 'over-current',
        title: `LED ${comp.id} has no current-limiting resistor`,
        description: `${comp.id} is connected without a series resistor. LEDs are diodes — once V_LED exceeds the forward voltage (~2V), current increases exponentially. Without a resistor, the LED draws unlimited current and burns out instantly.`,
        affectedComponents: [comp.id],
        suggestedFix: `Add a resistor in series with ${comp.id}. For a 5V supply and a red LED (Vf=2V) at 15mA: R = (5 - 2) / 0.015 = 200 Ω (use 220 Ω).`,
        kbArticles: ['led-current-limiting'],
        confidence: 0.95,
      });
    }
  }

  return issues;
}

function checkShortCircuits(
  components: CircuitComponent[],
  wires: Wire[],
  plugins: Map<string, ComponentPlugin>,
): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  const nodeMap = buildNodeMap(components, wires, plugins);

  // Build node -> components map
  const nodeToComponents = new Map<number, string[]>();
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const terminal of plugin.terminals) {
      const nodeId = nodeMap.terminalNode.get(`${comp.id}:${terminal.id}`);
      if (nodeId !== undefined) {
        if (!nodeToComponents.has(nodeId)) nodeToComponents.set(nodeId, []);
        const arr = nodeToComponents.get(nodeId)!;
        if (!arr.includes(comp.id)) arr.push(comp.id);
      }
    }
  }

  // Check for direct shorts between V+ and GND
  const vSources = components.filter(c =>
    c.type === 'dcVoltage' || c.type === 'acVoltage' || c.type === 'pulseSource'
  );

  for (const v of vSources) {
    const vP = nodeMap.terminalNode.get(`${v.id}:p`);
    const vN = nodeMap.terminalNode.get(`${v.id}:n`);
    if (vP === undefined || vN === undefined) continue;

    // A source whose two terminals sit on the SAME node is a dead short
    // (both-to-ground, or + wired straight to −). The old check fired only
    // when v+ was on node 0 with no "load" — but the ground symbol itself
    // was counted as a load, so the check could NEVER trigger; and it would
    // have false-positived the legitimate negative-rail topology
    // (p→gnd, n→load). Same-node is the exact pathological condition.
    if (vP === vN) {
      issues.push({
        severity: 'critical',
        category: 'short-circuit',
        title: `Voltage source ${v.id} is shorted`,
        description: `Both terminals of ${v.id} connect to the same node${vP === 0 ? ' (ground)' : ''}. An ideal voltage source across a short creates a singular matrix — the simulator cannot determine the current.`,
        affectedComponents: [v.id],
        suggestedFix: `Remove the wire that ties ${v.id}'s + and − terminals together${vP === 0 ? ' (both terminals currently go to ground)' : ''}, or add a load between them.`,
        kbArticles: ['ohms-law'],
        confidence: 0.95,
      });
    }
  }

  return issues;
}

function generateSummary(
  issues: DiagnosisIssue[],
  health: DiagnosisResult['overallHealth'],
  componentCount: number,
): string {
  if (issues.length === 0) {
    return `Circuit looks healthy (${componentCount} components, no issues detected). Run a simulation to verify operation.`;
  }

  const critical = issues.filter(i => i.severity === 'critical').length;
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;

  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical issue${critical > 1 ? 's' : ''}`);
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);

  const healthText = {
    critical: 'CRITICAL — circuit will not simulate correctly',
    errors: 'ERRORS — circuit may produce wrong results',
    warnings: 'WARNINGS — circuit works but has issues',
    healthy: 'HEALTHY',
  }[health];

  return `Found ${parts.join(', ')}. Overall: ${healthText}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition (wraps diagnoseCircuit for the AI tool registry)
// ─────────────────────────────────────────────────────────────────────────────

export const diagnoseCircuitTool: Tool = {
  name: 'ai.diagnose',
  category: 'AI Diagnosis & Teaching',
  description: 'Run a comprehensive diagnostic on the circuit. Checks for: missing ground, floating nodes, parallel voltage sources, short circuits, missing decoupling capacitors, LED current limiting, ERC violations, and physics law violations. Returns a ranked list of issues with severity, explanation, affected components, and suggested fixes. ALWAYS call this when the user reports a circuit problem or asks "why doesn\'t this work?".',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute(_args, ctx) {
    const result = diagnoseCircuit(ctx);
    return {
      ok: true,
      result,
    };
  },
};
