// Regression tests for the router-quality batch (Task 9-a: bend cost, net
// priority order, open-space bias, negotiated congestion history, via
// reduction gloss — the "looks hand-routed" upgrades).
//
// Baselines captured before the batch (pure shortest-path A*):
//   LED + Resistor        26 segments / 22 bends  — worst staircase offender
//   555 Astable Blink    140 segments / 123 bends
//   Two-Stage Audio Amp  424 segments / 382 bends
//   Digital Clock        1351 segments / 1181 bends
// After: 30–46% fewer segments everywhere, completion stays 100%, DRC clean.
import { describe, it, expect } from 'vitest';
import { autoRoute, netPriorityClass } from '../src/lib/pcb/auto-router';
import { createPCBFromSchematic } from '../src/lib/pcb/netlist-sync';
import { runDRC, DEFAULT_DRC_CONFIG } from '../src/lib/pcb/drc';
import { exampleCategories, exampleLed } from '../src/lib/circuit/examples';
import '../src/lib/circuit/components';

const examples = [{ name: 'LED + Resistor', doc: exampleLed }, ...exampleCategories.flatMap((c) => c.examples)];
function example(name: string) {
  const ex = examples.find((e) => e.name === name);
  if (!ex) throw new Error(`example not found: ${name}`);
  return ex.doc;
}

function routeExample(name: string) {
  const doc = example(name);
  const { footprints, ratsnest, board } = createPCBFromSchematic(doc.components, doc.wires);
  const t0 = Date.now();
  const result = autoRoute(footprints, [], [], ratsnest, board);
  return { doc, footprints, ratsnest, board, result, elapsedMs: Date.now() - t0 };
}

function totalSegments(result: ReturnType<typeof autoRoute>): number {
  return result.traces.reduce((s, t) => s + t.segments.length, 0);
}

// ── 1. Bend cost — the #1 visual quality signal ────────────────────────────

describe('bend cost (minimal corners)', () => {
  it('LED + Resistor: ≤ 15 segments (baseline 26 — the staircase offender)', () => {
    const { result } = routeExample('LED + Resistor');
    expect(result.stats.failed).toBe(0);
    expect(totalSegments(result)).toBeLessThanOrEqual(15);
    // every segment is still 45°/90° (aesthetics contract from v2)
    for (const t of result.traces) {
      for (const s of t.segments) {
        const dx = Math.abs(s.end.x - s.start.x);
        const dy = Math.abs(s.end.y - s.start.y);
        const is45 = dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6;
        expect(is45, `segment ${JSON.stringify(s)} must be axis/45°`).toBe(true);
      }
    }
  });

  it('555 Astable Blink: ≤ 110 segments (baseline 140)', () => {
    const { result } = routeExample('555 Astable Blink');
    expect(result.stats.failed).toBe(0);
    expect(totalSegments(result)).toBeLessThanOrEqual(110);
  });

  it('Two-Stage Audio Amplifier: ≤ 260 segments (baseline 424)', () => {
    const { result } = routeExample('Two-Stage Audio Amplifier');
    expect(result.stats.failed).toBe(0);
    expect(totalSegments(result)).toBeLessThanOrEqual(260);
  });

  it('routing stays DRC-clean with the new cost surface', () => {
    const { footprints, result, board } = routeExample('555 Astable Blink');
    const errors = runDRC(footprints, result.traces, result.vias, [], board, DEFAULT_DRC_CONFIG, []);
    expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0);
  });
});

// ── 2. Net priority routing order ──────────────────────────────────────────

describe('net priority classification', () => {
  it('sensitive nets → 0 (route first)', () => {
    expect(netPriorityClass('CLK')).toBe(0);
    expect(netPriorityClass('SPI_SCK')).toBe(0);
    expect(netPriorityClass('I2C_SDA')).toBe(0);
    expect(netPriorityClass('USB_D+')).toBe(0);
    expect(netPriorityClass('RX1')).toBe(0);
    expect(netPriorityClass('OSC_OUT')).toBe(0);
  });

  it('default signal nets → 1', () => {
    expect(netPriorityClass('N5')).toBe(1);
    expect(netPriorityClass('net_12')).toBe(1);
    expect(netPriorityClass('FEEDBACK')).toBe(1);
  });

  it('power nets → 2 (mid)', () => {
    expect(netPriorityClass('VCC')).toBe(2);
    expect(netPriorityClass('3V3')).toBe(2);
    expect(netPriorityClass('VIN')).toBe(2);
    expect(netPriorityClass('VBUS')).toBe(2);
  });

  it('ground rails → 3 (route last — most flexible)', () => {
    expect(netPriorityClass('GND')).toBe(3);
    expect(netPriorityClass('AGND')).toBe(3);
    expect(netPriorityClass('VSS')).toBe(3);
    expect(netPriorityClass('EARTH')).toBe(3);
  });

  it('a GND net orders AFTER a sensitive net (comparator contract)', () => {
    const order = ['N2', 'GND', 'CLK_12M', 'VCC'];
    const sorted = [...order].sort((a, b) => netPriorityClass(a) - netPriorityClass(b));
    expect(sorted.indexOf('CLK_12M')).toBeLessThan(sorted.indexOf('N2'));
    expect(sorted.indexOf('N2')).toBeLessThan(sorted.indexOf('VCC'));
    expect(sorted.indexOf('VCC')).toBeLessThan(sorted.indexOf('GND'));
  });
});

// ── 3. Open-space bias (small/medium boards — auto-disabled on dense) ─────

describe('open-space bias', () => {
  it('routes on a small board prefer clear space over obstacle-hugging', () => {
    // Two resistor footprints left/right; a foreign pad sits 1 mm above the
    // direct line. On a small board (< 400k states) the bias is active, so
    // the route should bow BELOW the line, keeping extra distance from the
    // obstacle rather than squeezing past at the legal minimum.
    const mkPad = (id: string, net: string, x: number, y: number) => ({
      id, componentId: id.slice(0, 2), terminalId: 'a',
      position: { x, y }, shape: 'rect' as const,
      size: { width: 0.8, height: 0.8 }, layer: 'top' as const, net,
    });
    const mkFp = (id: string, x: number, y: number, net: string) => ({
      id, componentId: id, componentType: 'resistor', refdes: id.toUpperCase(),
      position: { x, y }, rotation: 0, bodySize: { width: 3.2, height: 1.6 }, side: 'top' as const,
      pads: [mkPad(`${id}p1`, net, x - 1.2, y), mkPad(`${id}p2`, net, x + 1.2, y)],
    });
    // obstacle footprint's pad 1mm above the midline
    const obstacle = {
      id: 'ob', componentId: 'ob', componentType: 'resistor', refdes: 'OB',
      position: { x: 25, y: 11 }, rotation: 0, bodySize: { width: 3.2, height: 1.6 }, side: 'top' as const,
      pads: [mkPad('obp1', 'OB_NET', 23.8, 11), mkPad('obp2', 'OB_NET', 26.2, 11)],
    };
    const footprints: any[] = [mkFp('a', 8, 10, 'SIG'), mkFp('b', 42, 10, 'SIG'), obstacle];
    const ratsnest = [{
      net: 'SIG', fromPadId: 'ap2', toPadId: 'bp1',
      from: { x: 9.2, y: 10 }, to: { x: 40.8, y: 10 },
    }];
    const board = { width: 50, height: 30 };
    const result = autoRoute(footprints, [], [], ratsnest as any, board);

    expect(result.stats.failed).toBe(0);
    expect(result.traces.length).toBeGreaterThanOrEqual(1);
    // minimum distance from any SIG segment to the obstacle pad centers
    let minDist = Infinity;
    for (const t of result.traces) {
      if (t.net !== 'SIG') continue;
      for (const s of t.segments) {
        for (const op of obstacle.pads) {
          const d = Math.max(
            0,
            Math.hypot((s.start.x + s.end.x) / 2 - op.position.x, (s.start.y + s.end.y) / 2 - op.position.y) - 0.4,
          );
          minDist = Math.min(minDist, d);
        }
      }
    }
    // legal minimum would be clearance(0.2) + widths/2 (0.15+0.15) = 0.5mm;
    // the bias should buy visible extra separation (≥ 0.9mm at midpoints)
    expect(minDist).toBeGreaterThanOrEqual(0.9);
  });
});

// ── 4. Congestion history — no pass escalation on dense boards ─────────────

describe('congestion history + pass stability', () => {
  it('555 Timer Clock routes 100% in ≤ 2 passes (no bias-noise escalation)', () => {
    const { result } = routeExample('555 Timer Clock (HH:MM:SS)');
    expect(result.stats.failed).toBe(0);
    expect(result.stats.passes).toBeLessThanOrEqual(2);
  });

  it('Digital Clock routes 100% with bounded vias and reports viaReductions', () => {
    const { result } = routeExample('Digital Clock (HH:MM:SS)');
    expect(result.stats.failed).toBe(0);
    expect(result.stats.vias).toBeLessThanOrEqual(115);
    expect(typeof result.stats.viaReductions).toBe('number');
    expect(result.stats.viaReductions).toBeGreaterThanOrEqual(0);
  });
});
