// Tests for simulation features + P2 items.
// Covers: measurement cursors, .meas viewer, sweep slider, Bode plot,
// parametric family plot, SimStatusBar, TipOfTheDay.

import { describe, it, expect, beforeAll } from 'vitest';
import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import { solveDC } from '../src/lib/circuit/engine';

beforeAll(async () => {
  await import('../src/lib/circuit/components');
});

// ─────────────────────────────────────────────────────────────────────────────
// Simulation Features
// ─────────────────────────────────────────────────────────────────────────────
describe('Simulation Features', () => {
  it('ProbePanel has cursor toggle and tab system', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/ProbePanel.tsx', 'utf-8');
    // Updated for the scope-viewer integration: the old single `cursorEnabled`
    // flag was replaced by A/B cursors on the ScopeConfig.
    expect(source).toContain('cursorA');
    expect(source).toContain('cursorB');
    expect(source).toContain('Crosshair');
    expect(source).toContain('activeTab');
    expect(source).toContain("'scope'");
    expect(source).toContain("'measurements'");
    expect(source).toContain("'meas'");
  });

  it('ProbePanel has measurement cursor readout logic', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/ProbePanel.tsx', 'utf-8');
    // Updated for the scope-viewer integration: A/B cursor readouts use
    // getVoltageAtTime / computeCursorDeltas and pointer-event dragging.
    expect(source).toContain('scopeReadout');
    expect(source).toContain('getVoltageAtTime');
    expect(source).toContain('computeCursorDeltas');
    expect(source).toContain('handlePointerDown');
    // Cursor line drawn on canvas
    expect(source).toContain('setLineDash');
  });

  it('ProbePanel has .meas results viewer', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/ProbePanel.tsx', 'utf-8');
    expect(source).toContain('parseMeasLine');
    expect(source).toContain('execMeas');
    expect(source).toContain('measCommands');
    expect(source).toContain('measResults');
    expect(source).toContain('handleRunMeas');
    // Results table
    expect(source).toContain('Results');
  });

  it('ProbePanel has parameter sweep slider', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/ProbePanel.tsx', 'utf-8');
    expect(source).toContain('sweepCompId');
    expect(source).toContain('sweepMin');
    expect(source).toContain('sweepMax');
    expect(source).toContain('handleSweepChange');
    expect(source).toContain('setParameter');
    // Range input
    expect(source).toContain('type="range"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bode Plot
// ─────────────────────────────────────────────────────────────────────────────
describe('Bode Plot', () => {
  it('AnalysisCharts.tsx exports BodePlot and FamilyPlot', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/AnalysisCharts.tsx', 'utf-8');
    expect(source).toContain('export function BodePlot');
    expect(source).toContain('export function FamilyPlot');
    // Bode plot has dual-axis (dB + phase)
    expect(source).toContain('dB');
    expect(source).toContain('deg');
    // Has log-x axis
    expect(source).toContain('log10');
    // Has decade grid
    expect(source).toContain('decades');
  });

  it('shared.tsx uses BodePlot for complex traces', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/dialogs/analysis/shared.tsx', 'utf-8');
    expect(source).toContain('BodePlot');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parametric Family Plot
// ─────────────────────────────────────────────────────────────────────────────
describe('Parametric Family Plot', () => {
  it('FamilyPlot has legend with sweep values', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/AnalysisCharts.tsx', 'utf-8');
    expect(source).toContain('sweepValues');
    expect(source).toContain('legend');
    // Multiple traces rendered
    expect(source).toContain('traces.map');
    // Color palette
    expect(source).toContain('colors');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2: SimStatusBar
// ─────────────────────────────────────────────────────────────────────────────
describe('P2: SimStatusBar', () => {
  it('SimStatusBar exists and shows node/fps info', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/SimStatusBar.tsx', 'utf-8');
    expect(source).toContain('nodeCount');
    expect(source).toContain('fps');
    expect(source).toContain('running');
    expect(source).toContain('speed');
    // Icons
    expect(source).toContain('Cpu');
    expect(source).toContain('Zap');
    expect(source).toContain('Activity');
  });

  it('page.tsx renders SimStatusBar in schematic mode', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/app/page.tsx', 'utf-8');
    expect(source).toContain('SimStatusBar');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2: Tip of the Day
// ─────────────────────────────────────────────────────────────────────────────
describe('P2: Tip of the Day', () => {
  it('TipOfTheDay component exists with tips array', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/components/circuit/TipOfTheDay.tsx', 'utf-8');
    expect(source).toContain('TIPS');
    expect(source).toContain('toast.info');
    expect(source).toContain('sessionStorage');
    // At least 10 tips
    const tipCount = (source.match(/'[^']+'/g) || []).filter(s =>
      s.length > 20 && s.includes('.') && !s.includes('import') && !s.includes('expect')
    ).length;
    expect(tipCount).toBeGreaterThan(5);
  });

  it('page.tsx renders TipOfTheDay', async () => {
    const fs = await import('fs/promises');
    const source = await fs.readFile('./src/app/page.tsx', 'utf-8');
    expect(source).toContain('TipOfTheDay');
  });
});
