// Tests for the AI diagnostic engine — diagnoseCircuit and its checks.

import { describe, it, expect, beforeEach } from 'vitest';
import { diagnoseCircuit } from '../src/lib/ai/tools/diagnostic-tools';
import { KB_ARTICLES, getArticle, searchArticles, getArticlesByCategory, getRelatedArticles, getAllTags } from '../src/lib/ai/knowledge/knowledge-base';
import '../src/lib/circuit/components';
import type { CircuitComponent, Wire, CircuitDocument } from '../src/lib/circuit/types';
import { getPlugin } from '../src/lib/circuit/registry';
import type { ToolContext } from '../src/lib/ai/tools/types';

function mkComp(type: string, id: string, params: Record<string, any> = {}, pos: [number, number] = [0, 0]): CircuitComponent {
  const p = getPlugin(type);
  return {
    id,
    type,
    position: { x: pos[0], y: pos[1] },
    rotation: 0,
    parameters: { ...(p?.parameters.reduce((a, p) => ({ ...a, [p.key]: p.default }), {}) || {}), ...params },
  };
}

function mkWire(id: string, fromC: string, fromT: string, toC: string, toT: string): Wire {
  return { id, from: { componentId: fromC, terminalId: fromT }, to: { componentId: toC, terminalId: toT } };
}

function mkCtx(components: CircuitComponent[], wires: Wire[], simContext?: any): ToolContext {
  const plugins = new Map<string, any>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }
  return {
    doc: { version: 1, components, wires },
    plugins,
    simContext: simContext || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnose Circuit
// ─────────────────────────────────────────────────────────────────────────────

describe('diagnoseCircuit', () => {
  it('reports "missing ground" when a voltage source has no ground', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 });
    const r1 = mkComp('resistor', 'r1', { resistance: 330 });
    const led1 = mkComp('led', 'led1', {});
    const components = [v1, r1, led1];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'led1', 'a'),
      // LED.k not connected to ground!
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const missingGround = result.issues.find(i => i.category === 'missing-ground');
    expect(missingGround).toBeDefined();
    expect(missingGround!.severity).toBe('critical');
  });

  it('detects an LED without a current-limiting resistor', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 });
    const led1 = mkComp('led', 'led1', {});
    const gnd = mkComp('ground', 'gnd1', {});
    const components = [v1, led1, gnd];
    const wires = [
      mkWire('w1', 'v1', 'p', 'led1', 'a'),  // LED anode directly to V+
      mkWire('w2', 'led1', 'k', 'gnd1', 'g'),
      mkWire('w3', 'v1', 'n', 'gnd1', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const ledIssue = result.issues.find(i => i.category === 'over-current' && i.affectedComponents.includes('led1'));
    expect(ledIssue).toBeDefined();
    expect(ledIssue!.severity).toBe('error');
    expect(ledIssue!.kbArticles).toContain('led-current-limiting');
  });

  it('does not flag an LED that has a series resistor', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 });
    const r1 = mkComp('resistor', 'r1', { resistance: 330 });
    const led1 = mkComp('led', 'led1', {});
    const gnd = mkComp('ground', 'gnd1', {});
    const components = [v1, r1, led1, gnd];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'led1', 'a'),
      mkWire('w3', 'led1', 'k', 'gnd1', 'g'),
      mkWire('w4', 'v1', 'n', 'gnd1', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const ledIssue = result.issues.find(i => i.category === 'over-current' && i.affectedComponents.includes('led1'));
    expect(ledIssue).toBeUndefined();
  });

  it('detects parallel voltage sources', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 }, [4, 4]);
    const v2 = mkComp('dcVoltage', 'v2', { voltage: 5 }, [10, 4]);
    const gnd = mkComp('ground', 'gnd1', {});
    const components = [v1, v2, gnd];
    // Wire both sources in parallel (V1.p → V2.p, V1.n → V2.n → GND)
    const wires = [
      mkWire('w1', 'v1', 'p', 'v2', 'p'),
      mkWire('w2', 'v1', 'n', 'v2', 'n'),
      mkWire('w3', 'v2', 'n', 'gnd1', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const parallelIssue = result.issues.find(i => i.category === 'parallel-vsources');
    expect(parallelIssue).toBeDefined();
    expect(parallelIssue!.severity).toBe('critical');
    expect(parallelIssue!.kbArticles).toContain('parallel-voltage-sources');
  });

  it('flags missing decoupling capacitor near ICs', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 });
    const ic1 = mkComp('timer555', 'ic1', {}, [10, 4]);
    const gnd = mkComp('ground', 'gnd1', {});
    const r1 = mkComp('resistor', 'r1', { resistance: 10000 }, [14, 2]);
    const components = [v1, ic1, gnd, r1];
    const wires = [
      mkWire('w1', 'v1', 'p', 'ic1', 'vcc'),
      mkWire('w2', 'v1', 'n', 'gnd1', 'g'),
      mkWire('w3', 'ic1', 'gnd', 'gnd1', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const decouplingIssue = result.issues.find(i => i.category === 'missing-decoupling' && i.affectedComponents.includes('ic1'));
    expect(decouplingIssue).toBeDefined();
    expect(decouplingIssue!.severity).toBe('warning');
    expect(decouplingIssue!.kbArticles).toContain('decoupling');
  });

  it('does not flag decoupling when a cap is near the IC', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 });
    const ic1 = mkComp('timer555', 'ic1', {}, [10, 4]);
    const c1 = mkComp('capacitor', 'c1', { capacitance: 1e-7 }, [11, 4]); // 100nF, close to IC
    const gnd = mkComp('ground', 'gnd1', {});
    const components = [v1, ic1, c1, gnd];
    const wires = [
      mkWire('w1', 'v1', 'p', 'ic1', 'vcc'),
      mkWire('w2', 'v1', 'n', 'gnd1', 'g'),
      mkWire('w3', 'ic1', 'gnd', 'gnd1', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const decouplingIssue = result.issues.find(i => i.category === 'missing-decoupling' && i.affectedComponents.includes('ic1'));
    expect(decouplingIssue).toBeUndefined();
  });

  it('returns "healthy" overall health for a correct circuit', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 });
    const r1 = mkComp('resistor', 'r1', { resistance: 330 });
    const led1 = mkComp('led', 'led1', {});
    const gnd = mkComp('ground', 'gnd1', {});
    const components = [v1, r1, led1, gnd];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'led1', 'a'),
      mkWire('w3', 'led1', 'k', 'gnd1', 'g'),
      mkWire('w4', 'v1', 'n', 'gnd1', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    expect(result.overallHealth).toBe('healthy');
    expect(result.componentCount).toBe(4);
    expect(result.wireCount).toBe(4);
  });

  it('sorts issues by severity (critical first)', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 });
    const led1 = mkComp('led', 'led1', {});
    // No ground, no resistor — should have critical + error
    const components = [v1, led1];
    const wires: Wire[] = [];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    const criticalIdx = result.issues.findIndex(i => i.severity === 'critical');
    const errorIdx = result.issues.findIndex(i => i.severity === 'error');
    const warningIdx = result.issues.findIndex(i => i.severity === 'warning');
    if (criticalIdx >= 0 && errorIdx >= 0) expect(criticalIdx).toBeLessThan(errorIdx);
    if (errorIdx >= 0 && warningIdx >= 0) expect(errorIdx).toBeLessThan(warningIdx);
  });

  it('includes component/wire counts in the result', () => {
    const v1 = mkComp('dcVoltage', 'v1', { voltage: 5 });
    const r1 = mkComp('resistor', 'r1', { resistance: 1000 });
    const gnd = mkComp('ground', 'gnd1', {});
    const components = [v1, r1, gnd];
    const wires = [
      mkWire('w1', 'v1', 'p', 'r1', 'a'),
      mkWire('w2', 'r1', 'b', 'gnd1', 'g'),
      mkWire('w3', 'v1', 'n', 'gnd1', 'g'),
    ];
    const ctx = mkCtx(components, wires);
    const result = diagnoseCircuit(ctx);
    expect(result.componentCount).toBe(3);
    expect(result.wireCount).toBe(3);
    expect(result.nodeCount).toBeGreaterThan(0);
  });

  it('generates a human-readable summary', () => {
    const ctx = mkCtx([], []);
    const result = diagnoseCircuit(ctx);
    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base
// ─────────────────────────────────────────────────────────────────────────────

describe('Knowledge Base', () => {
  it('has at least 20 articles', () => {
    expect(KB_ARTICLES.length).toBeGreaterThanOrEqual(20);
  });

  it('every article has required fields', () => {
    for (const article of KB_ARTICLES) {
      expect(article.id).toBeDefined();
      expect(article.title).toBeDefined();
      expect(article.category).toBeDefined();
      expect(article.tags).toBeInstanceOf(Array);
      expect(article.tags.length).toBeGreaterThan(0);
      expect(article.summary).toBeDefined();
      expect(article.body).toBeDefined();
      expect(article.body.length).toBeGreaterThan(100);
    }
  });

  it('every article ID is unique', () => {
    const ids = KB_ARTICLES.map(a => a.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('getArticle returns the article by ID', () => {
    const article = getArticle('ohms-law');
    expect(article).toBeDefined();
    expect(article!.title).toContain("Ohm's Law");
  });

  it('getArticle returns undefined for unknown ID', () => {
    const article = getArticle('nonexistent-article');
    expect(article).toBeUndefined();
  });

  it('searchArticles finds articles by query', () => {
    const results = searchArticles('LED resistor');
    expect(results.length).toBeGreaterThan(0);
    const ledArticle = results.find(a => a.id === 'led-current-limiting');
    expect(ledArticle).toBeDefined();
  });

  it('searchArticles returns empty for no matches', () => {
    const results = searchArticles('quantum entanglement');
    expect(results.length).toBe(0);
  });

  it('searchArticles ranks title matches highest', () => {
    const results = searchArticles('capacitor');
    expect(results.length).toBeGreaterThan(0);
    // The capacitor-basics article should be in the top results
    expect(results[0].id).toBe('capacitor-basics');
  });

  it('getArticlesByCategory returns articles in the category', () => {
    const concepts = getArticlesByCategory('concepts');
    expect(concepts.length).toBeGreaterThan(0);
    for (const a of concepts) {
      expect(a.category).toBe('concepts');
    }
  });

  it('every category has at least one article', () => {
    const categories = ['concepts', 'passives', 'semiconductors', 'ic', 'analysis', 'troubleshooting', 'design-patterns', 'pcb'];
    for (const cat of categories) {
      const articles = getArticlesByCategory(cat as any);
      expect(articles.length).toBeGreaterThan(0);
    }
  });

  it('getRelatedArticles returns related articles', () => {
    const related = getRelatedArticles('ohms-law');
    expect(related.length).toBeGreaterThan(0);
    // ohms-law should be related to voltage-divider
    const hasDivider = related.some(a => a.id === 'voltage-divider');
    expect(hasDivider).toBe(true);
  });

  it('getAllTags returns a sorted list of unique tags', () => {
    const tags = getAllTags();
    expect(tags.length).toBeGreaterThan(10);
    // Check sorting
    for (let i = 1; i < tags.length; i++) {
      expect(tags[i] >= tags[i - 1]).toBe(true);
    }
  });

  it('articles cover key beginner topics', () => {
    const expected = ['ohms-law', 'kvl-kcl', 'voltage-divider', 'capacitor-basics', 'inductor-basics', 'diode-basics', 'transistor-basics', 'opamp-basics', '555-timer'];
    for (const id of expected) {
      expect(getArticle(id)).toBeDefined();
    }
  });

  it('articles cover troubleshooting topics', () => {
    const expected = ['floating-node', 'missing-ground', 'convergence-issues', 'parallel-voltage-sources'];
    for (const id of expected) {
      expect(getArticle(id)).toBeDefined();
    }
  });

  it('articles cover PCB topics', () => {
    const pcbArticles = getArticlesByCategory('pcb');
    expect(pcbArticles.length).toBeGreaterThanOrEqual(2);
  });

  it('articles cover analysis topics', () => {
    const analysisArticles = getArticlesByCategory('analysis');
    expect(analysisArticles.length).toBeGreaterThanOrEqual(3);
  });
});
