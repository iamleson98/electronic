// AI design-review tools — derating/SOA, DFM/DFT/SI/PI checklist, bring-up.
//
// Gives the AI systematic production-review capability: every part checked
// against its ratings (V/I/P), plus a KiCad/Altium-style review checklist
// (decoupling, grounding, testability, creepage) and a bring-up procedure.

import { buildNodeMap, getTerminalsForComponent, computeComponentCurrents } from '../../circuit/engine';
import type { Tool, ToolContext } from './types';
import { ensurePlugins } from './helpers';

interface DeratingRow {
  component: string;
  type: string;
  check: string;
  actual: string;
  rating: string;
  marginPct: number | null;
  status: 'pass' | 'warn' | 'fail';
  /** 'part' = rating came from the component's own parameter; 'generic' =
   *  a conservative default (the library has no datasheet ratings, so the
   *  row must not read as a verified part limit). */
  ratingSource: 'part' | 'generic';
}

/** Conservative generic ratings used when the part carries no explicit one. */
const GENERIC_RATINGS = {
  resistorPower: 0.25, // W (standard 0603/0805 film)
  capacitorVoltage: 50, // V (generic ceramic)
  diodeCurrent: 1, // A (1N400x class)
  ledCurrent: 0.02, // A
};

export const deratingCheckTool: Tool = {
  name: 'review.derating',
  category: 'Simulation & Analysis',
  description: 'Check every part against its voltage/current/power ratings (derating / safe-operating-area). Reports actual stress from the DC operating point vs rating with margin %. Use before calling a design production-ready. Non-mutating.',
  parameters: {
    type: 'object',
    properties: {
      powerDerate: {
        type: 'number',
        description: 'Max allowed power fraction, e.g. 0.5 = 50% derating rule (default 0.6).',
      },
      ambientTemp: {
        type: 'number',
        description: 'Ambient temperature in °C for the derating curves (resistor 70→155 °C, MLCC 85→125 °C, silicon 25→150 °C). Default 25.',
      },
      voltageDerate: {
        type: 'number',
        description: 'Max allowed voltage fraction (default 0.8).',
      },
      currentDerate: {
        type: 'number',
        description: 'Max allowed current fraction (default 0.8).',
      },
    },
    required: [],
  },
  execute(args: { powerDerate?: number; voltageDerate?: number; currentDerate?: number; ambientTemp?: number }, ctx: ToolContext) {
    try {
      ensurePlugins(ctx);
      const { doc, plugins, simContext } = ctx;
      if (!simContext) {
        return { ok: false, error: 'No simulation has run yet — run simulate.run or solveDC first.' };
      }
      const nodeMap = buildNodeMap(doc.components, doc.wires, plugins);
      const currents = computeComponentCurrents(doc.components, doc.wires, plugins, simContext);
      const pLim = args.powerDerate ?? 0.6;
      const vLim = args.voltageDerate ?? 0.8;
      const iLim = args.currentDerate ?? 0.8;
      // Ambient-temperature derating curves (standard manufacturer practice):
      //   resistors (thick film): 100% to 70 °C, linear to 0% at 155 °C.
      //   MLCC voltage: 100% to 85 °C, 60% at 125 °C (X7R-class rule).
      //   silicon current/power: 100% to 25 °C, linear to 0% at 150 °C (Tj).
      // Without this a 25 °C pass silently becomes a field failure at 85 °C.
      const tAmb = args.ambientTemp ?? 25;
      const resistorTempFactor = tAmb <= 70 ? 1 : Math.max(0, 1 - (tAmb - 70) / (155 - 70));
      const mlccTempFactor = tAmb <= 85 ? 1 : Math.max(0.5, 1 - 0.4 * (tAmb - 85) / (125 - 85));
      const siliconTempFactor = tAmb <= 25 ? 1 : Math.max(0, 1 - (tAmb - 25) / (150 - 25));
      const rows: DeratingRow[] = [];
      const push = (component: string, type: string, check: string, actual: number, rating: number, unit: string, lim: number, source: 'part' | 'generic') => {
        const frac = rating > 0 ? actual / rating : Infinity;
        rows.push({
          component, type, check,
          actual: `${actual.toFixed(4)} ${unit}`,
          rating: `${rating} ${unit}`,
          marginPct: Number.isFinite(frac) ? Math.round((1 - frac) * 100) : null,
          status: frac <= lim ? 'pass' : frac <= 1 ? 'warn' : 'fail',
          ratingSource: source,
        });
      };
      for (const comp of doc.components) {
        const plugin = plugins.get(comp.type);
        if (!plugin) continue;
        const terms = getTerminalsForComponent(comp, plugin, nodeMap);
        const vOf = (id: string) => simContext.nodeVoltage[terms.find((t) => t.terminalId === id)?.nodeId ?? 0] ?? 0;
        const i = Math.abs(currents.get(comp.id) ?? 0);
        const label = comp.refdes ?? comp.id;
        if (comp.type === 'resistor') {
          const v = Math.abs(vOf('a') - vOf('b'));
          const p = v * i;
          const partRating = comp.parameters.powerRating as number | undefined;
          const pRated = (partRating ?? GENERIC_RATINGS.resistorPower) * resistorTempFactor;
          push(label, comp.type, `power@${tAmb}°C`, p, pRated, 'W', pLim, partRating != null ? 'part' : 'generic');
        } else if (comp.type === 'capacitor') {
          const v = Math.abs(vOf('a') - vOf('b'));
          const partRating = comp.parameters.voltageRating as number | undefined;
          const vRated = (partRating ?? GENERIC_RATINGS.capacitorVoltage) * mlccTempFactor;
          push(label, comp.type, `voltage@${tAmb}°C`, v, vRated, 'V', vLim, partRating != null ? 'part' : 'generic');
        } else if (comp.type === 'led') {
          const partRating = comp.parameters.maxCurrent as number | undefined;
          push(label, comp.type, 'current', i, partRating ?? GENERIC_RATINGS.ledCurrent, 'A', iLim, partRating != null ? 'part' : 'generic');
        } else if (comp.type === 'diode' || comp.type === 'zener' || comp.type === 'schottky') {
          const partRating = comp.parameters.currentRating as number | undefined;
          push(label, comp.type, 'current', i, partRating ?? GENERIC_RATINGS.diodeCurrent, 'A', iLim, partRating != null ? 'part' : 'generic');
        } else if (comp.type === 'npn' || comp.type === 'pnp' || comp.type === 'nmos' || comp.type === 'pmos') {
          const cOrD = comp.type === 'npn' ? 'c' : comp.type === 'pnp' ? 'c' : 'd';
          const eOrS = comp.type === 'npn' ? 'e' : comp.type === 'pnp' ? 'e' : 's';
          const v = Math.abs(vOf(cOrD) - vOf(eOrS));
          const vPart = (comp.parameters.vceMax as number | undefined) ?? (comp.parameters.vdsMax as number | undefined);
          push(label, comp.type, 'voltage', v, vPart ?? 40, 'V', vLim, vPart != null ? 'part' : 'generic');
          const iPart = (comp.parameters.icMax as number | undefined) ?? (comp.parameters.idMax as number | undefined);
          push(label, comp.type, `current@${tAmb}°C`, i, (iPart ?? 0.5) * siliconTempFactor, 'A', iLim, iPart != null ? 'part' : 'generic');
          const pPart = comp.parameters.powerMax as number | undefined;
          push(label, comp.type, `power@${tAmb}°C`, v * i, (pPart ?? 0.5) * siliconTempFactor, 'W', pLim, pPart != null ? 'part' : 'generic');
        } else if (comp.type === 'fuse') {
          const iRated = (comp.parameters.current as number) ?? 1;
          push(label, comp.type, 'current', i, iRated, 'A', 1, 'part');
        }
      }
      const fails = rows.filter((r) => r.status === 'fail').length;
      const warns = rows.filter((r) => r.status === 'warn').length;
      const genericRated = rows.filter((r) => r.ratingSource === 'generic').length;
      const caveat = genericRated > 0
        ? ` — ${genericRated} check(s) used GENERIC default ratings (no part-specific rating in this library); verify against the datasheet before production`
        : '';
      return {
        ok: true,
        result: {
          rows,
          ambientTemp: tAmb,
          tempFactors: { resistor: +resistorTempFactor.toFixed(3), mlcc: +mlccTempFactor.toFixed(3), silicon: +siliconTempFactor.toFixed(3) },
          summary: (fails > 0 ? `${fails} over-stressed, ${warns} marginal` : warns > 0 ? `${warns} marginal, none over-stressed` : 'All parts within derating limits') + caveat,
          overall: fails > 0 ? 'fail' : warns > 0 ? 'warn' : 'pass',
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

interface ChecklistItem {
  id: string;
  area: 'power' | 'signal' | 'grounding' | 'testability' | 'safety' | 'pcb';
  check: string;
  status: 'pass' | 'warn' | 'fail' | 'na';
  detail: string;
}

export const designReviewTool: Tool = {
  name: 'review.checklist',
  category: 'Simulation & Analysis',
  description: 'Run a production design-review checklist (DFM/DFT/signal-integrity/power-integrity): decoupling caps per IC, bulk capacitance, LED current limiting, ground presence, test-point coverage, fuse on mains input, floating CMOS inputs. Returns pass/warn/fail per item. Non-mutating.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute(_args: Record<string, never>, ctx: ToolContext) {
    try {
      ensurePlugins(ctx);
      const { doc, plugins } = ctx;
      const items: ChecklistItem[] = [];
      const byType = (t: string) => doc.components.filter((c) => c.type === t);
      const ics = doc.components.filter((c) => ['timer555', 'opamp', 'opampRails', 'arduino', 'arduinoReal', 'raspberryPi', 'lm358', 'lm741', 'tl072', 'ne5532', 'lm324'].includes(c.type) || c.type.startsWith('ic74') || c.type.startsWith('cd40') || c.type.startsWith('7400_'));
      // 1. Decoupling per IC
      const caps = byType('capacitor');
      items.push({
        id: 'decoupling',
        area: 'power',
        check: 'Decoupling capacitor per IC',
        status: ics.length === 0 ? 'na' : caps.length >= ics.length ? 'pass' : caps.length > 0 ? 'warn' : 'fail',
        detail: `${ics.length} IC(s), ${caps.length} capacitor(s). Rule of thumb: one 100nF ceramic per IC power pin plus bulk electrolytic per rail.`,
      });
      // 2. Bulk capacitance on supplies
      const bulk = caps.filter((c) => (c.parameters.capacitance as number) >= 10e-6).length;
      items.push({
        id: 'bulk',
        area: 'power',
        check: 'Bulk capacitance on supply rails',
        status: bulk > 0 ? 'pass' : caps.length > 0 ? 'warn' : 'na',
        detail: bulk > 0 ? `${bulk} bulk cap(s) ≥ 10µF found.` : 'No bulk (≥10µF) capacitance found — add electrolytic on each supply rail.',
      });
      // 3. LED current limiting
      const leds = [...byType('led'), ...byType('rgbLed')];
      let ledsLimited = 0;
      for (const led of leds) {
        const ledPlugin = plugins.get(led.type);
        if (!ledPlugin) continue;
        const nm = buildNodeMap(doc.components, doc.wires, plugins);
        const ledNodes = new Set(getTerminalsForComponent(led, ledPlugin, nm).map((t) => t.nodeId));
        const hasSeriesR = doc.components.some((c) => {
          if (c.type !== 'resistor') return false;
          const rp = plugins.get(c.type);
          if (!rp) return false;
          return getTerminalsForComponent(c, rp, nm).some((t) => ledNodes.has(t.nodeId));
        });
        if (hasSeriesR) ledsLimited++;
      }
      items.push({
        id: 'led-limit',
        area: 'signal',
        check: 'LED current limiting resistors',
        status: leds.length === 0 ? 'na' : ledsLimited === leds.length ? 'pass' : 'fail',
        detail: leds.length === 0 ? 'No LEDs.' : `${ledsLimited}/${leds.length} LED(s) have a series resistor on their net.`,
      });
      // 4. Ground presence
      const hasGround = doc.components.some((c) => c.type === 'ground' || c.type === 'powerGND' || c.type === 'powerAGND');
      items.push({
        id: 'ground',
        area: 'grounding',
        check: 'Ground reference present',
        status: hasGround ? 'pass' : 'fail',
        detail: hasGround ? 'Ground reference found.' : 'No ground — simulation cannot run and the board has no return path.',
      });
      // 5. Test-point coverage
      const testPoints = doc.components.filter((c) => c.type === 'testPoint' || c.type === 'oscilloscope' || c.type === 'voltmeter').length;
      const nets = buildNodeMap(doc.components, doc.wires, plugins).numNodes - 1;
      items.push({
        id: 'testability',
        area: 'testability',
        check: 'Test-point coverage',
        status: testPoints > 0 ? 'pass' : 'warn',
        detail: `${testPoints} probe/test point(s) across ~${nets} net(s). Add test points on rails + key signals for bring-up.`,
      });
      // 6. Floating CMOS inputs (logic gates/ICs with unwired inputs)
      let floatingInputs = 0;
      for (const comp of doc.components) {
        const plugin = plugins.get(comp.type);
        if (!plugin) continue;
        if (plugin.category !== 'logic') continue;
        const nm = buildNodeMap(doc.components, doc.wires, plugins);
        const wired = new Set(doc.wires.flatMap((w) => [
          `${w.from.componentId}:${w.from.terminalId}`,
          `${w.to.componentId}:${w.to.terminalId}`,
        ]));
        for (const t of plugin.terminals) {
          if (t.electricalType !== 'input') continue;
          if (!wired.has(`${comp.id}:${t.id}`)) floatingInputs++;
        }
      }
      items.push({
        id: 'floating-inputs',
        area: 'signal',
        check: 'No floating CMOS inputs',
        status: floatingInputs === 0 ? 'pass' : 'fail',
        detail: floatingInputs === 0 ? 'All logic inputs are driven.' : `${floatingInputs} undriven logic input(s) — tie high/low, do not float.`,
      });
      // 7. Fuse on AC mains input
      const hasAc = byType('acVoltage').length > 0;
      const hasFuse = byType('fuse').length > 0;
      items.push({
        id: 'mains-fuse',
        area: 'safety',
        check: 'Mains input fused',
        status: !hasAc ? 'na' : hasFuse ? 'pass' : 'fail',
        detail: !hasAc ? 'No AC mains source.' : hasFuse ? 'Fuse present on mains path.' : 'AC mains source with no fuse — add one for safety.',
      });
      // 8. High-speed SI: crystal within 20mm of MCU + load caps present
      const hasCrystal = byType('crystal').length + byType('crystalOscillator').length > 0;
      items.push({
        id: 'crystal-layout',
        area: 'signal',
        check: 'Crystal close to MCU with load caps',
        status: !hasCrystal ? 'na' : caps.length >= 2 ? 'pass' : 'warn',
        detail: !hasCrystal ? 'No crystal.' : 'Keep the crystal < 20mm from the MCU, guard-ring ground, two matched load caps to ground.',
      });
      // 9. Return path: every IC power pin should see a nearby ground
      const hasGroundSym = doc.components.some((c) => c.type === 'powerGND' || c.type === 'ground');
      items.push({
        id: 'return-path',
        area: 'grounding',
        check: 'Continuous ground return path',
        status: hasGroundSym ? 'pass' : 'fail',
        detail: hasGroundSym
          ? 'Ground symbol present. On the PCB: unbroken ground pour under every high-speed / switching loop, no slots under crystal or SMPS inductor.'
          : 'No ground — add one and keep an unbroken pour under switching loops.',
      });
      // 10. ESD/creepage: mains nets need clearance + MOV/fuse note
      items.push({
        id: 'esd-creepage',
        area: 'safety',
        check: 'ESD + creepage for exposed/mains nets',
        status: !hasAc ? 'pass' : hasFuse ? 'warn' : 'fail',
        detail: !hasAc
          ? 'Low-voltage only. Still: TVS on exposed connectors, 8kV contact ESD per IEC 61000-4-2.'
          : 'Mains: ≥3mm creepage L–N/PE, MOV + fuse at inlet, Y-caps rated Y1/Y2. Verify in the PCB DRC.',
      });
      const fails = items.filter((i) => i.status === 'fail').length;
      const warns = items.filter((i) => i.status === 'warn').length;
      return {
        ok: true,
        result: {
          items,
          summary: fails > 0 ? `${fails} failing, ${warns} warnings` : warns > 0 ? `${warns} warnings, none failing` : 'All checks pass',
          overall: fails > 0 ? 'fail' : warns > 0 ? 'warn' : 'pass',
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const bringupChecklistTool: Tool = {
  name: 'review.bringup',
  category: 'Simulation & Analysis',
  description: 'Generate a board bring-up procedure: ordered smoke-test steps (visual, resistance, power ramp, rail checks, signal checks) derived from the actual components and rails in this circuit. Returns an ordered step list.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute(_args: Record<string, never>, ctx: ToolContext) {
    try {
      ensurePlugins(ctx);
      const { doc } = ctx;
      const steps: { order: number; title: string; detail: string }[] = [];
      const rails = [...new Set(doc.components
        .filter((c) => c.type.startsWith('power') || c.type === 'netLabel')
        .map((c) => String(c.parameters.net ?? c.type)))];
      steps.push({ order: 1, title: 'Visual inspection', detail: 'Check solder joints, polarity (diodes/LEDs/electrolytics), IC orientation, no bridges under magnification.' });
      steps.push({ order: 2, title: 'Unpowered resistance checks', detail: `With no power: rail-to-GND resistance should be kΩ+, not near 0Ω. Rails in design: ${rails.length > 0 ? rails.join(', ') : 'GND'}.` });
      steps.push({ order: 3, title: 'Current-limited power-up', detail: 'Power through a current-limited bench supply (e.g. 100mA limit). If it hits the limit immediately, power off and check for shorts.' });
      let n = 4;
      for (const r of rails.slice(0, 8)) {
        steps.push({ order: n++, title: `Verify rail ${r}`, detail: `Measure ${r} at its test point / decoupling cap. Must be within ±5% of nominal with no oscillation.` });
      }
      const hasMcu = doc.components.some((c) => ['arduino', 'arduinoReal', 'raspberryPi', 'esp32dev'].includes(c.type));
      if (hasMcu) steps.push({ order: n++, title: 'MCU signs of life', detail: 'Check clock/oscillator, reset line, then program a blink and verify GPIO toggles.' });
      const hasOpamp = doc.components.some((c) => c.type.includes('opamp') || ['lm358', 'lm741', 'tl072', 'ne5532', 'lm324'].includes(c.type));
      if (hasOpamp) steps.push({ order: n++, title: 'Analog stage bias', detail: 'Verify op-amp output sits mid-supply with inputs shorted/grounded, then apply signal and check gain.' });
      steps.push({ order: n++, title: 'Functional test', detail: 'Exercise each input (buttons/sensors) and confirm each output (LEDs/displays/motors) against the simulation waveforms.' });
      return { ok: true, result: { steps } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
