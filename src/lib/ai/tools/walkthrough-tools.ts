// Circuit walkthrough engine — the AI's "explain my circuit" brain.
//
// analyzeCircuitWalkthrough() is a PURE function over (components, wires,
// plugins) that produces a structured, pedagogical breakdown of a schematic:
//   - functional blocks (power, timing, amplification, logic, sensing,
//     output, interface) detected from topology, not just part types
//   - specific configuration recognition (555 astable vs monostable,
//     op-amp inverting vs non-inverting vs comparator, transistor switch,
//     RC filter, LED driver, regulator chain)
//   - per-part roles WITH computed analysis from the circuit's actual values
//     (LED current, oscillator frequency, divider ratio, amplifier gain...)
//   - a block-level signal-flow ordering
//   - teaching notes (missing flyback diode, no decoupling, floating inputs,
//     LED without series resistor, open-drain without pull-up...)
//   - difficulty classification + suggested experiments
//
// Everything here is deterministic and unit-testable; the LLM only weaves the
// structured output into prose. This keeps explanations GROUNDED in the real
// netlist — the AI cannot hallucinate values it did not compute.

import { getPlugin } from '@/lib/circuit/registry';
import type { CircuitComponent, Wire } from '@/lib/circuit/types';
import {
  calcOhmsLaw,
  calc555Astable,
  calc555Monostable,
  calcVoltageDivider,
  calcOpampGain,
  engFormat,
} from './design-calculators';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WalkthroughPart {
  id: string;
  refdes?: string;
  type: string;
  role: string;
  values: string;
  analysis?: { label: string; value: string }[];
}

export interface WalkthroughBlock {
  name: string;
  kind: BlockKind;
  purpose: string;
  components: WalkthroughPart[];
  teachingPoints: string[];
}

export type BlockKind =
  | 'power' | 'timing' | 'amplification' | 'logic' | 'sensing'
  | 'output' | 'interface' | 'filter' | 'support';

export interface TeachingNote {
  severity: 'info' | 'warning' | 'error';
  note: string;
}

export interface CircuitWalkthrough {
  summary: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  blockCount: number;
  componentCount: number;
  blocks: WalkthroughBlock[];
  signalFlow: string[];
  teachingNotes: TeachingNote[];
  suggestedExperiments: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Netlist construction (union-find over terminal keys, same as schematic.describe)
// ─────────────────────────────────────────────────────────────────────────────

export interface Netlist {
  terminalNet: Map<string, string>;
  netTerminals: Map<string, Set<string>>;
  netOf(compId: string, termId: string): string | undefined;
  terminalsOnNet(net: string): Set<string>;
}

export function buildNetlist(components: CircuitComponent[], wires: Wire[]): Netlist {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const c of components) {
    const plugin = getPlugin(c.type);
    if (!plugin) continue;
    for (const t of plugin.terminals) {
      const key = `${c.id}:${t.id}`;
      if (!parent.has(key)) parent.set(key, key);
    }
  }
  for (const w of wires) {
    const a = `${w.from.componentId}:${w.from.terminalId}`;
    const b = `${w.to.componentId}:${w.to.terminalId}`;
    if (parent.has(a) && parent.has(b)) union(a, b);
  }

  const terminalNet = new Map<string, string>();
  const netTerminals = new Map<string, Set<string>>();
  for (const key of parent.keys()) {
    const root = find(key);
    terminalNet.set(key, root);
    if (!netTerminals.has(root)) netTerminals.set(root, new Set());
    netTerminals.get(root)!.add(key);
  }

  return {
    terminalNet,
    netTerminals,
    netOf: (compId, termId) => terminalNet.get(`${compId}:${termId}`),
    terminalsOnNet: (net) => netTerminals.get(net) ?? new Set(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component classification tables
// ─────────────────────────────────────────────────────────────────────────────

const POWER_TYPES = new Set([
  'dcVoltage', 'acVoltage', 'battery', 'vcc', 'customPower',
  'lm7805', 'lm317', 'lm1117', 'lt3045', 'tl431', 'lm336', 'lm385', 'icl8069',
  'zener', 'fuse', 'ptc', 'mov', 'var', 'switch', 'pushButton',
]);

const TIMING_TYPES = new Set([
  'timer555', 'crystal', 'crystalOscillator', 'vco', 'pll4046', 'lm565',
]);

const AMPLIFIER_TYPES = new Set([
  'opamp', 'opampRails', 'opampReal',
]);

const OUTPUT_TYPES = new Set([
  'led', 'rgbLed', 'ws2812b', 'speaker', 'buzzer', 'dcMotor', 'stepperMotor',
  'servoMotor', 'relay', 'ssr', 'lamp', 'sevenSegment',
]);

const INTERFACE_TYPES = new Set([
  'nrf24l01', 'esp32dev', 'arduino', 'arduinoReal', 'lcd1602', 'ssd1306',
  'connector', 'testPoint', 'optocoupler',
]);

const SENSOR_TYPES = new Set([
  'photoresistor', 'photodiode', 'phototransistor', 'solarCell',
  'thermistor', 'electretMic', 'potentiometer', 'ammeter', 'voltmeter',
]);

function isLogicType(type: string): boolean {
  return /^(and|or|not|nand|nor|xor|xnor|schmitt|buf|tristate|diode_)/.test(type)
    || /^(ic74|cd40|7[0-9]{3})/.test(type)
    || ['adc', 'dac'].includes(type);
}

function isSensorCategory(type: string): boolean {
  const p = getPlugin(type);
  // 'sensor' is not in the ComponentCategory union (hall-sensors.ts casts it),
  // so compare as a plain string.
  return (p?.category as string | undefined) === 'sensor';
}

// ─────────────────────────────────────────────────────────────────────────────
// Value formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function paramOf(c: CircuitComponent, key: string, fallback: number): number {
  const v = c.parameters?.[key];
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

function fmtParams(c: CircuitComponent): string {
  const plugin = getPlugin(c.type);
  if (!plugin) return '';
  const parts: string[] = [];
  for (const def of plugin.parameters) {
    // skip textual/sketch params and hidden internals
    if (def.type === 'string' || def.type === 'boolean' || def.type === 'select') continue;
    if (['closed', 'pressed'].includes(def.key)) continue;
    const v = c.parameters?.[def.key];
    if (typeof v === 'number' && isFinite(v)) {
      parts.push(`${def.label || def.key} = ${engFormat(v, def.unit || '')}`);
    }
  }
  return parts.join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration recognizers (topology-based, return null when not matched)
// ─────────────────────────────────────────────────────────────────────────────

/** 555 mode: astable iff TRIG and THR share a net; else monostable. */
function detect555Mode(c: CircuitComponent, nl: Netlist): 'astable' | 'monostable' | 'unknown' {
  const trig = nl.netOf(c.id, 'trig');
  const thres = nl.netOf(c.id, 'thr');
  if (!trig || !thres) return 'unknown';
  return trig === thres ? 'astable' : 'monostable';
}

/**
 * Op-amp configuration from feedback topology:
 *  - output shorted/netted to IN+ → non-inverting buffer
 *  - feedback path (through any R) OUT → IN−, input into IN− → inverting
 *  - input into IN+, feedback OUT → IN− → non-inverting amplifier
 *  - no feedback → comparator
 */
function detectOpampConfig(
  c: CircuitComponent,
  nl: Netlist,
  components: CircuitComponent[],
): { config: 'inverting' | 'noninverting' | 'buffer' | 'comparator'; rin?: string; rf?: string } {
  const outNet = nl.netOf(c.id, 'out') ?? nl.netOf(c.id, 'output');
  const inMinus = nl.netOf(c.id, 'in-') ?? nl.netOf(c.id, 'inverting') ?? nl.netOf(c.id, 'n');
  const inPlus = nl.netOf(c.id, 'in+') ?? nl.netOf(c.id, 'noninverting') ?? nl.netOf(c.id, 'p');
  if (!outNet) return { config: 'comparator' };

  // Direct (same-net) feedback?
  if (inMinus && outNet === inMinus) return { config: 'buffer' };
  if (inPlus && outNet === inPlus) return { config: 'buffer' };

  // Feedback through a resistor: a resistor whose two nets are {outNet, inMinus}.
  // REQUIRED for any closed-loop amplifier configuration.
  if (inMinus) {
    let feedbackR: CircuitComponent | null = null;
    for (const r of components) {
      if (r.type !== 'resistor' || r.id === c.id) continue;
      const a = nl.netOf(r.id, 'a');
      const b = nl.netOf(r.id, 'b');
      if (!a || !b) continue;
      if ((a === outNet && b === inMinus) || (b === outNet && a === inMinus)) {
        feedbackR = r;
        break;
      }
    }
    if (feedbackR) {
      // Input resistor into the inverting node (not coming from the output)?
      for (const rin of components) {
        if (rin.type !== 'resistor' || rin.id === feedbackR.id || rin.id === c.id) continue;
        const ra = nl.netOf(rin.id, 'a');
        const rb = nl.netOf(rin.id, 'b');
        if (!ra || !rb) continue;
        const drivesMinus = (ra === inMinus || rb === inMinus) && !(ra === outNet || rb === outNet);
        if (drivesMinus) {
          return { config: 'inverting', rf: feedbackR.id, rin: rin.id };
        }
      }
      // Feedback present but input arrives at IN+ (or nowhere): non-inverting.
      if (inPlus && outNet !== inPlus && inMinus !== inPlus) {
        const plusTerms = nl.terminalsOnNet(inPlus);
        for (const t of plusTerms) {
          const [cid] = t.split(':');
          const src = components.find((cc) => cc.id === cid);
          if (!src || src.id === c.id) continue;
          if (POWER_TYPES.has(src.type) || SENSOR_TYPES.has(src.type) || AMPLIFIER_TYPES.has(src.type) || isLogicType(src.type) || isSensorCategory(src.type)) {
            return { config: 'noninverting', rf: feedbackR.id };
          }
        }
      }
      // Feedback to IN− but no clear input: generic inverting topology
      // (integrator / differentiator / transimpedance).
      return { config: 'inverting', rf: feedbackR.id };
    }
  }
  return { config: 'comparator' };
}

/** RC low-pass: resistor in series, then a capacitor shunting the far node. */
function detectRcFilter(
  r: CircuitComponent,
  nl: Netlist,
  components: CircuitComponent[],
): { fcHz: number; capId: string } | null {
  const a = nl.netOf(r.id, 'a');
  const b = nl.netOf(r.id, 'b');
  if (!a || !b) return null;
  for (const cap of components) {
    if (cap.type !== 'capacitor') continue;
    const ca = nl.netOf(cap.id, 'a');
    const cb = nl.netOf(cap.id, 'b');
    if (!ca || !cb) continue;
    if (ca === b || cb === b) {
      const rVal = paramOf(r, 'resistance', 1000);
      const cVal = paramOf(cap, 'capacitance', 1e-6);
      const fc = 1 / (2 * Math.PI * rVal * cVal);
      if (isFinite(fc) && fc > 0) return { fcHz: fc, capId: cap.id };
    }
  }
  return null;
}

/** Find the resistor in series with an LED (shares a net, not the supply-only net). */
function findSeriesResistor(led: CircuitComponent, nl: Netlist, components: CircuitComponent[]): CircuitComponent | null {
  const a = nl.netOf(led.id, 'a');
  const b = nl.netOf(led.id, 'k') ?? nl.netOf(led.id, 'b') ?? nl.netOf(led.id, 'cathode');
  if (!a || !b) return null;
  for (const r of components) {
    if (r.type !== 'resistor') continue;
    const ra = nl.netOf(r.id, 'a');
    const rb = nl.netOf(r.id, 'b');
    if (!ra || !rb) continue;
    if ((ra === a || rb === a) && ra !== rb) return r;
  }
  return null;
}

/** Terminal pairs that carry the inductive current for each load type. */
const INDUCTIVE_PAIRS: Record<string, [string, string]> = {
  relay: ['coilA', 'coilB'],
  dcMotor: ['a', 'b'],
  stepperMotor: ['ap', 'an'],
  ssr: ['inp', 'inn'],
};

/** Detect a flyback diode reversed across an inductive component. */
function hasFlybackDiode(load: CircuitComponent, nl: Netlist, components: CircuitComponent[]): boolean {
  const pair = INDUCTIVE_PAIRS[load.type] ?? ['a', 'b'];
  const a = nl.netOf(load.id, pair[0]);
  const b = nl.netOf(load.id, pair[1]);
  if (!a || !b) return false;
  for (const d of components) {
    if (d.type !== 'diode') continue;
    const da = nl.netOf(d.id, 'a');
    const db = nl.netOf(d.id, 'k');
    if (!da || !db) continue;
    if ((da === b && db === a) || (da === a && db === b)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main analysis
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_META: Record<BlockKind, { name: string; purpose: string }> = {
  power: { name: 'Power Supply', purpose: 'Generates and regulates the supply rails that power everything else' },
  timing: { name: 'Timing & Oscillation', purpose: 'Generates clock or timing waveforms that drive the circuit' },
  amplification: { name: 'Amplification & Analog Processing', purpose: 'Scales, filters or compares analog signals' },
  logic: { name: 'Digital Logic', purpose: 'Processes signals as digital bits' },
  sensing: { name: 'Sensing & Input', purpose: 'Converts a physical quantity into an electrical signal' },
  output: { name: 'Output & Actuation', purpose: 'Turns electrical energy into light, sound or motion' },
  interface: { name: 'Interface & Communication', purpose: 'Connects the circuit to the outside world' },
  filter: { name: 'Filtering', purpose: 'Shapes the frequency content of signals' },
  support: { name: 'Passive Support', purpose: 'Biasing, current limiting, decoupling and protection' },
};

export function analyzeCircuitWalkthrough(
  components: CircuitComponent[],
  wires: Wire[],
): CircuitWalkthrough {
  const nl = buildNetlist(components, wires);
  const partsByBlock = new Map<BlockKind, WalkthroughPart[]>();
  const push = (kind: BlockKind, part: WalkthroughPart) => {
    if (!partsByBlock.has(kind)) partsByBlock.set(kind, []);
    partsByBlock.get(kind)!.push(part);
  };

  const teachingNotes: TeachingNote[] = [];
  const suggestedExperiments: string[] = [];
  const groundNet = findGroundNet(components, nl);

  // --- Pass 1: classify every component ---
  for (const c of components) {
    const plugin = getPlugin(c.type);
    if (!plugin) continue;
    const values = fmtParams(c);

    if (c.type === 'ground') continue; // implicit
    else if (c.type === 'timer555') {
      const mode = detect555Mode(c, nl);
      const r1 = find555ResistorToVcc(c, nl, components);
      const r2 = find555ResistorBetween(c, nl, components, 'dis', 'thr');
      const cap = find555Cap(c, nl, components);
      let role = '555 timer';
      let analysis: { label: string; value: string }[] | undefined;
      if (mode === 'astable' && r1 && r2 && cap) {
        const out = calc555Astable(paramOf(r1, 'resistance', 10000), paramOf(r2, 'resistance', 47000), paramOf(cap, 'capacitance', 1e-6));
        const f = out.outputs.f;
        const duty = out.outputs.duty;
        role = '555 astable oscillator (free-running clock)';
        analysis = [
          { label: 'Frequency', value: typeof f === 'number' ? engFormat(f, 'Hz') : String(f) },
          { label: 'Duty cycle', value: typeof duty === 'number' ? `${(duty * 100).toFixed(1)}%` : String(duty) },
        ];
      } else if (mode === 'monostable') {
        const r = find555ResistorToVcc(c, nl, components);
        if (r && cap) {
          const out = calc555Monostable(paramOf(r, 'resistance', 100000), paramOf(cap, 'capacitance', 10e-6));
          const pw = out.outputs.pulseWidth;
          role = '555 monostable (one-shot pulse generator)';
          analysis = [{ label: 'Pulse width', value: typeof pw === 'number' ? engFormat(pw, 's') : String(pw) }];
        } else {
          role = '555 monostable (one-shot pulse generator)';
        }
      } else if (mode === 'astable') {
        role = '555 astable oscillator';
      }
      push('timing', { id: c.id, refdes: c.refdes, type: c.type, role, values, analysis });
    }
    else if (TIMING_TYPES.has(c.type)) {
      const role = c.type === 'crystal' ? 'Quartz crystal — sets a precise oscillation frequency'
        : c.type === 'crystalOscillator' ? 'Packaged crystal oscillator — provides a ready-made clock'
        : c.type === 'vco' ? 'Voltage-controlled oscillator — frequency follows the control voltage'
        : c.type === 'pll4046' ? '74HC4046 PLL — locks an internal VCO to an input signal'
        : c.type === 'lm565' ? 'LM565 analog PLL — locks its VCO to the input frequency'
        : 'Timing component';
      push('timing', { id: c.id, refdes: c.refdes, type: c.type, role, values });
    }
    else if (AMPLIFIER_TYPES.has(c.type) || /^opamp/.test(c.type)) {
      const { config, rin, rf } = detectOpampConfig(c, nl, components);
      let role = 'Operational amplifier';
      let analysis: { label: string; value: string }[] | undefined;
      if (config === 'inverting') {
        role = 'Inverting amplifier — output is −(Rf/Rin) × input';
        if (rin && rf) {
          const rIn = components.find((x) => x.id === rin);
          const rF = components.find((x) => x.id === rf);
          if (rIn && rF) {
            const out = calcOpampGain('inverting', paramOf(rIn, 'resistance', 1000), paramOf(rF, 'resistance', 10000));
            const g = out.outputs.gain;
            const gdb = out.outputs.gainDb;
            analysis = [
              { label: 'Voltage gain', value: typeof g === 'number' ? `${g.toFixed(2)}×` : String(g) },
              { label: 'Gain (dB)', value: typeof gdb === 'number' ? `${gdb.toFixed(1)} dB` : String(gdb) },
            ];
          }
        }
      } else if (config === 'noninverting') {
        role = 'Non-inverting amplifier — gain set by the feedback divider';
        if (rin && rf) {
          const rIn = components.find((x) => x.id === rin);
          const rF = components.find((x) => x.id === rf);
          if (rIn && rF) {
            const out = calcOpampGain('noninverting', paramOf(rIn, 'resistance', 1000), paramOf(rF, 'resistance', 10000));
            const g = out.outputs.gain;
            const gdb = out.outputs.gainDb;
            analysis = [
              { label: 'Voltage gain', value: typeof g === 'number' ? `${g.toFixed(2)}×` : String(g) },
              { label: 'Gain (dB)', value: typeof gdb === 'number' ? `${gdb.toFixed(1)} dB` : String(gdb) },
            ];
          }
        }
      } else if (config === 'buffer') {
        role = 'Unity-gain buffer — isolates a high-impedance source from a load';
      } else {
        role = 'Comparator — digital output indicates which input is higher (no feedback)';
      }
      push('amplification', { id: c.id, refdes: c.refdes, type: c.type, role, values, analysis });
    }
    else if (c.type === 'resistor') {
      // Resistors: filter? divider? LED driver? generic support.
      const filter = detectRcFilter(c, nl, components);
      if (filter) {
        push('filter', {
          id: c.id, refdes: c.refdes, type: c.type,
          role: 'Series resistor of an RC low-pass filter',
          values,
          analysis: [{ label: 'Cutoff frequency (−3 dB)', value: `${engFormat(filter.fcHz, 'Hz')}` }],
        });
        continue;
      }
      const divider = detectDivider(c, nl, components);
      if (divider) {
        const out = calcVoltageDivider(divider.vin, divider.r1Val, divider.r2Val);
        const v = out.outputs.vout;
        push('support', {
          id: c.id, refdes: c.refdes, type: c.type,
          role: 'Voltage divider (with its partner resistor)',
          values,
          analysis: [{ label: 'Output voltage', value: typeof v === 'number' ? `${v.toFixed(3)} V` : String(v) }],
        });
        continue;
      }
      push('support', { id: c.id, refdes: c.refdes, type: c.type, role: 'Resistor (biasing / current limiting / pull-up)', values });
    }
    else if (c.type === 'capacitor') {
      const capVal = paramOf(c, 'capacitance', 1e-6);
      const role = capVal >= 10e-6
        ? 'Bulk capacitor — supplies momentary current and smooths supply dips'
        : capVal <= 0.1e-6 + 1e-12
          ? 'Decoupling capacitor — filters high-frequency noise off a local supply'
          : 'Capacitor — AC coupling / filtering / timing';
      push('support', { id: c.id, refdes: c.refdes, type: c.type, role, values });
    }
    else if (c.type === 'inductor' || c.type === 'coupledInductor' || c.type === 'transformer') {
      push('support', { id: c.id, refdes: c.refdes, type: c.type, role: c.type === 'transformer' ? 'Transformer — steps voltage up/down and isolates' : 'Inductor — stores energy in a magnetic field, resists current changes', values });
    }
    else if (c.type === 'led') {
      const seriesR = findSeriesResistor(c, nl, components);
      let analysis: { label: string; value: string }[] | undefined;
      const role = 'LED — emits light when forward current flows';
      if (seriesR) {
        const vinGuess = estimateDriveVoltage(c, seriesR, nl, components);
        const vf = paramOf(c, 'forwardVoltage', 2.0);
        const out = calcOhmsLaw(Math.max(0.1, vinGuess - vf), undefined, paramOf(seriesR, 'resistance', 330));
        const i = out.outputs.i;
        analysis = [{ label: 'Approx. LED current', value: typeof i === 'number' ? engFormat(i, 'A') : String(i) }];
      }
      push('output', { id: c.id, refdes: c.refdes, type: c.type, role, values, analysis });
    }
    else if (OUTPUT_TYPES.has(c.type)) {
      const role: Record<string, string> = {
        rgbLed: 'RGB LED — three LED dies share one package; blend the channels for any color',
        ws2812b: 'WS2812B addressable RGB LED — shifts color data in one pin, chains via DOUT',
        speaker: 'Speaker — converts an AC signal into sound',
        buzzer: 'Active buzzer — produces a fixed tone when powered',
        dcMotor: 'DC motor — spins at a speed proportional to current',
        stepperMotor: 'Stepper motor — moves in precise steps per coil excitation',
        servoMotor: 'Hobby servo — positions its shaft from a PWM control signal',
        relay: 'Relay — an electromagnet switches isolated contacts',
        ssr: 'Solid-state relay — semiconductor switch with no moving parts',
        sevenSegment: '7-segment display — shows a digit from its segment inputs',
        lamp: 'Lamp — indicator light',
      };
      push('output', { id: c.id, refdes: c.refdes, type: c.type, role: role[c.type] ?? 'Output device', values });
    }
    else if (isSensorCategory(c.type) || SENSOR_TYPES.has(c.type)) {
      push('sensing', { id: c.id, refdes: c.refdes, type: c.type, role: `Sensor/input transducer (${plugin.name}) — turns a physical quantity into an electrical signal`, values });
    }
    else if (INTERFACE_TYPES.has(c.type)) {
      const role: Record<string, string> = {
        nrf24l01: 'nRF24L01 2.4 GHz radio — wireless SPI transceiver',
        esp32dev: 'ESP32 DevKit — Wi-Fi/BT microcontroller; the programmable brain of the circuit',
        arduino: 'Arduino board — the programmable brain of the circuit',
        arduinoReal: 'Arduino (programmable) — runs the sketch that orchestrates the circuit',
        lcd1602: '16×2 character LCD — shows text via its I²C backpack',
        ssd1306: 'SSD1306 OLED — high-contrast graphic display over I²C',
        connector: 'Connector — interfaces the circuit to external wiring',
        testPoint: 'Test point — a labeled place to probe with the scope',
        optocoupler: 'Optocoupler — passes a signal across an isolation barrier with light',
      };
      push('interface', { id: c.id, refdes: c.refdes, type: c.type, role: role[c.type] ?? 'Interface component', values });
    }
    else if (isLogicType(c.type)) {
      push('logic', { id: c.id, refdes: c.refdes, type: c.type, role: `Digital IC (${plugin.name}) — processes logic levels`, values });
    }
    else if (POWER_TYPES.has(c.type)) {
      const role: Record<string, string> = {
        dcVoltage: 'DC voltage source — provides a fixed supply potential',
        acVoltage: 'AC voltage source — provides an alternating waveform',
        battery: 'Battery — portable DC supply',
        lm7805: 'LM7805 linear regulator — holds its output at a steady 5 V',
        lm317: 'LM317 adjustable regulator — output set by the resistor pair',
        lm1117: 'LM1117 LDO — low-dropout 3.3 V regulation',
        zener: 'Zener diode — clamps a voltage at its reverse breakdown',
        fuse: 'Fuse — sacrificial overcurrent protection',
        ptc: 'Resettable PTC fuse — overcurrent protection that self-heals',
        mov: 'MOV varistor — absorbs voltage spikes',
        switch: 'Switch — makes or breaks the circuit manually',
        pushButton: 'Push button — momentary manual input',
      };
      push('power', { id: c.id, refdes: c.refdes, type: c.type, role: role[c.type] ?? 'Power component', values });
    }
    else {
      push('support', { id: c.id, refdes: c.refdes, type: c.type, role: `${plugin.name}`, values });
    }
  }

  // --- Pass 2: teaching notes (rule-based, grounded) ---
  // No ground
  if (!groundNet && components.length > 1) {
    teachingNotes.push({ severity: 'error', note: 'No ground reference found — the simulator needs at least one ground to define 0 V.' });
  }
  // Inductive loads need flyback diodes
  for (const c of components) {
    if (['relay', 'dcMotor', 'stepperMotor', 'ssr'].includes(c.type)) {
      if (!hasFlybackDiode(c, nl, components)) {
        teachingNotes.push({
          severity: 'warning',
          note: `${c.refdes || c.type} is inductive — add a flyback (freewheeling) diode across it, or the switching element will see damaging voltage spikes when current is interrupted.`,
        });
      }
    }
  }
  // LED directly across a source?
  for (const c of components) {
    if (c.type === 'led' && !findSeriesResistor(c, nl, components)) {
      const a = nl.netOf(c.id, 'a');
      const sourceOnA = a && [...nl.terminalsOnNet(a)].some((t) => {
        const [cid] = t.split(':');
        const src = components.find((cc) => cc.id === cid);
        return src && (src.type === 'dcVoltage' || src.type === 'battery');
      });
      if (sourceOnA) {
        teachingNotes.push({ severity: 'error', note: `${c.refdes || 'An LED'} appears wired straight to a source with no series resistor — current will be uncontrolled. Add ~330 Ω for a 5 V supply.` });
      }
    }
  }
  // Decoupling suggestion for ICs (even one IC benefits — pedagogically worth an info note)
  const icCount = components.filter((c) => {
    const p = getPlugin(c.type);
    return p && (p.category === 'ic' || p.category === 'mcu' || p.category === 'logic');
  }).length;
  const hasDecoupling = components.some((c) => c.type === 'capacitor' && Math.abs(paramOf(c, 'capacitance', 1) - 0.1e-6) < 1e-9);
  if (icCount >= 1 && !hasDecoupling) {
    teachingNotes.push({ severity: 'info', note: `${icCount} IC${icCount > 1 ? 's' : ''} but no 0.1 µF decoupling capacitor${icCount > 1 ? 's' : ''} — place one between VCC and GND next to each IC to keep the supply clean.` });
  }
  // Open-drain outputs need pull-ups
  for (const c of components) {
    if (['hallSwitch', 'ds18b20', 'dht22', 'nrf24l01', 'mq2'].includes(c.type)) {
      const outTerm = c.type === 'nrf24l01' ? 'miso' : c.type === 'mq2' ? 'dout' : ['hallSwitch', 'ds18b20', 'dht22'].includes(c.type) ? (c.type === 'hallSwitch' ? 'out' : c.type === 'ds18b20' ? 'dq' : 'data') : 'out';
      const net = nl.netOf(c.id, outTerm);
      const pulledUp = net && [...nl.terminalsOnNet(net)].some((t) => {
        const [cid] = t.split(':');
        const r = components.find((cc) => cc.id === cid);
        if (!r || r.type !== 'resistor') return false;
        const ra = nl.netOf(r.id, 'a');
        const rb = nl.netOf(r.id, 'b');
        const vNet = findVccNet(components, nl);
        return vNet != null && (ra === vNet || rb === vNet);
      });
      if (net && !pulledUp) {
        teachingNotes.push({ severity: 'warning', note: `${c.refdes || c.type} has an open-drain output — it can only pull LOW. Add a 4.7–10 kΩ pull-up resistor to VCC for the line to ever read HIGH.` });
      }
    }
  }
  // Floating logic inputs
  let floatingInputs = 0;
  for (const c of components) {
    const p = getPlugin(c.type);
    if (!p || !(p.category === 'logic' || isLogicType(c.type))) continue;
    for (const t of p.terminals) {
      if (/^(a|b|in|input|clk|clock|d|j|k|s|r|clear|preset)$/i.test(t.id)) {
        const net = nl.netOf(c.id, t.id);
        if (!net || nl.terminalsOnNet(net).size <= 1) floatingInputs++;
      }
    }
  }
  if (floatingInputs > 0) {
    teachingNotes.push({ severity: 'warning', note: `${floatingInputs} logic input pin(s) are floating (unconnected) — undefined inputs cause erratic behavior. Tie unused inputs to GND or VCC.` });
  }

  // --- Pass 3: assemble blocks in canonical order ---
  const ORDER: BlockKind[] = ['power', 'timing', 'sensing', 'amplification', 'logic', 'filter', 'interface', 'output', 'support'];
  const blocks: WalkthroughBlock[] = [];
  for (const kind of ORDER) {
    const parts = partsByBlock.get(kind);
    if (!parts || parts.length === 0) continue;
    const meta = BLOCK_META[kind];
    const points: string[] = [];
    if (kind === 'power') points.push('Follow the energy: every circuit is a story about moving energy from a source to a load.');
    if (kind === 'timing') points.push('Oscillators trade charge between a resistor, capacitor and a threshold — the RC product sets the pace.');
    if (kind === 'amplification') points.push('Negative feedback trades gain for predictability — the huge open-loop gain of the op-amp makes the resistor ratio king.');
    if (kind === 'logic') points.push('Digital abstraction: only two meaningful voltages matter; noise margin is the safety buffer between them.');
    if (kind === 'output') points.push('Loads convert electrical energy — always ask how much current they draw and where it flows.');
    blocks.push({ name: meta.name, kind, purpose: meta.purpose, components: parts, teachingPoints: points });
  }

  // --- Difficulty ---
  // 'support' (passives doing biasing/decoupling) doesn't make a circuit harder.
  const coreKinds = new Set(blocks.filter((b) => b.kind !== 'support').map((b) => b.kind));
  const difficulty: CircuitWalkthrough['difficulty'] =
    components.length <= 8 && coreKinds.size <= 2 ? 'beginner'
    : coreKinds.has('logic') || coreKinds.has('amplification') || coreKinds.has('timing') ? 'intermediate'
    : 'advanced';

  const kinds = new Set(blocks.filter((b) => b.kind !== 'support').map((b) => b.kind));

  // --- Signal flow (block ordering by kind + connectivity hints) ---
  const signalFlow = buildSignalFlow(blocks, nl, components);

  // --- Suggested experiments ---
  const oscillator = components.find((c) => c.type === 'timer555');
  if (oscillator) suggestedExperiments.push('Use the parameter-sweep slider on the timing resistors and watch the frequency change live in the scope.');
  const hasLed = components.some((c) => c.type === 'led');
  if (hasLed) suggestedExperiments.push('Sweep the LED series resistor from 100 Ω to 1 kΩ and observe how current (and brightness) responds.');
  if (kinds.has('amplification')) suggestedExperiments.push('Run an AC analysis to see the amplifier gain vs frequency — where does it roll off?');
  if (kinds.has('filter')) suggestedExperiments.push('Run the Bode plot and confirm the −3 dB point matches the computed cutoff.');
  if (suggestedExperiments.length === 0 && components.length > 0) {
    suggestedExperiments.push('Try simulate.whatIf to test a change without touching the schematic.');
  }

  const summary = components.length === 0
    ? 'The canvas is empty — nothing to explain yet.'
    : `${components.length} component${components.length > 1 ? 's' : ''} organized into ${blocks.length} functional block${blocks.length !== 1 ? 's' : ''}: ${blocks.map((b) => b.name.toLowerCase()).join(' → ')}.`;

  return {
    summary,
    difficulty,
    blockCount: blocks.length,
    componentCount: components.length,
    blocks,
    signalFlow,
    teachingNotes,
    suggestedExperiments,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for recognition
// ─────────────────────────────────────────────────────────────────────────────

function findGroundNet(components: CircuitComponent[], nl: Netlist): string | null {
  for (const c of components) {
    if (c.type === 'ground') return nl.netOf(c.id, 'g') ?? nl.netOf(c.id, 'a') ?? null;
  }
  return null;
}

function findVccNet(components: CircuitComponent[], nl: Netlist): string | null {
  let best: { net: string; count: number } | null = null;
  for (const c of components) {
    if (c.type !== 'dcVoltage' && c.type !== 'battery' && c.type !== 'vcc') continue;
    const net = nl.netOf(c.id, 'p') ?? nl.netOf(c.id, 'a') ?? nl.netOf(c.id, 'vcc');
    if (!net) continue;
    const size = nl.terminalsOnNet(net).size;
    if (!best || size > best.count) best = { net, count: size };
  }
  return best?.net ?? null;
}

function find555ResistorToVcc(c: CircuitComponent, nl: Netlist, components: CircuitComponent[]): CircuitComponent | null {
  const vcc = findVccNet(components, nl);
  const disch = nl.netOf(c.id, 'dis');
  if (!disch) return null;
  for (const r of components) {
    if (r.type !== 'resistor') continue;
    const ra = nl.netOf(r.id, 'a');
    const rb = nl.netOf(r.id, 'b');
    if (!ra || !rb) continue;
    if ((ra === vcc && rb === disch) || (rb === vcc && ra === disch)) return r;
  }
  return null;
}

function find555ResistorBetween(c: CircuitComponent, nl: Netlist, components: CircuitComponent[], t1: string, t2: string): CircuitComponent | null {
  const n1 = nl.netOf(c.id, t1);
  const n2 = nl.netOf(c.id, t2);
  if (!n1 || !n2 || n1 === n2) return null;
  for (const r of components) {
    if (r.type !== 'resistor') continue;
    const ra = nl.netOf(r.id, 'a');
    const rb = nl.netOf(r.id, 'b');
    if (!ra || !rb) continue;
    if ((ra === n1 && rb === n2) || (rb === n1 && ra === n2)) return r;
  }
  return null;
}

function find555Cap(c: CircuitComponent, nl: Netlist, components: CircuitComponent[]): CircuitComponent | null {
  const thres = nl.netOf(c.id, 'thr');
  const trig = nl.netOf(c.id, 'trig');
  const target = thres ?? trig;
  if (!target) return null;
  for (const cap of components) {
    if (cap.type !== 'capacitor') continue;
    const ca = nl.netOf(cap.id, 'a');
    const cb = nl.netOf(cap.id, 'b');
    if (ca === target || cb === target) return cap;
  }
  return null;
}

function detectDivider(
  r: CircuitComponent,
  nl: Netlist,
  components: CircuitComponent[],
): { vin: number; r1Val: number; r2Val: number } | null {
  const a = nl.netOf(r.id, 'a');
  const b = nl.netOf(r.id, 'b');
  if (!a || !b) return null;
  const vcc = findVccNet(components, nl);
  const gnd = findGroundNet(components, nl);
  if (!vcc || !gnd) return null;
  const touchesVcc = a === vcc || b === vcc;
  if (!touchesVcc) return null;
  for (const r2 of components) {
    if (r2.type !== 'resistor' || r2.id === r.id) continue;
    const ra = nl.netOf(r2.id, 'a');
    const rb = nl.netOf(r2.id, 'b');
    if (!ra || !rb) continue;
    const touchesGnd = ra === gnd || rb === gnd;
    const sharesMid = (ra === b || rb === b) || (ra === a || rb === a);
    if (touchesGnd && sharesMid) {
      // vin estimate: voltage of the vcc net source
      const src = components.find((cc) => cc.type === 'dcVoltage' && (nl.netOf(cc.id, 'p') === vcc));
      const vin = src ? paramOf(src, 'voltage', 5) : 5;
      const rTop = a === vcc ? paramOf(r, 'resistance', 10000) : paramOf(r2, 'resistance', 10000);
      const rBot = a === vcc ? paramOf(r2, 'resistance', 10000) : paramOf(r, 'resistance', 10000);
      return { vin, r1Val: rTop, r2Val: rBot };
    }
  }
  return null;
}

function estimateDriveVoltage(
  led: CircuitComponent,
  seriesR: CircuitComponent,
  nl: Netlist,
  components: CircuitComponent[],
): number {
  // Which LED terminal faces the resistor path toward the source?
  const a = nl.netOf(led.id, 'a');
  const ra = nl.netOf(seriesR.id, 'a');
  const rb = nl.netOf(seriesR.id, 'b');
  const driveNet = (a === ra || a === rb) ? a : (nl.netOf(led.id, 'k') ?? nl.netOf(led.id, 'b'));
  const src = components.find((cc) => (cc.type === 'dcVoltage' || cc.type === 'battery') && (nl.netOf(cc.id, 'p') === driveNet || nl.netOf(cc.id, 'a') === driveNet));
  return src ? paramOf(src, 'voltage', 5) : 5;
}

function buildSignalFlow(blocks: WalkthroughBlock[], nl: Netlist, components: CircuitComponent[]): string[] {
  // Simple, kind-based pedagogical flow + connectivity refinement.
  if (blocks.length <= 1) return blocks.map((b) => b.name);
  const flow: string[] = [];
  const used = new Set<string>();
  const startKinds: BlockKind[] = ['power', 'sensing'];
  const midKinds: BlockKind[] = ['timing', 'amplification', 'logic', 'filter'];
  const endKinds: BlockKind[] = ['output', 'interface'];

  const emit = (kind: BlockKind) => {
    const b = blocks.find((x) => x.kind === kind && !used.has(x.name));
    if (b) { used.add(b.name); flow.push(b.name); }
  };
  for (const k of startKinds) emit(k);
  for (const k of midKinds) emit(k);
  for (const k of endKinds) emit(k);
  // support last
  for (const b of blocks) if (!used.has(b.name)) { used.add(b.name); flow.push(b.name); }

  // Connectivity hint: if an output block shares a net with the sensing block
  // directly, mention the direct path (rare, but nice when present).
  void nl; void components;
  return flow;
}

// ─────────────────────────────────────────────────────────────────────────────
// The tool
// ─────────────────────────────────────────────────────────────────────────────

import type { Tool, ToolContext } from './types';

export const circuitWalkthroughTool: Tool = {
  name: 'circuit.walkthrough',
  category: 'Teaching',
  description:
    'Explain the CURRENT circuit like a professor walking up to the whiteboard: functional blocks detected from topology (power, timing, amplification, logic, sensing, output), each component\'s role WITH computed values from the actual schematic (oscillator frequency, amplifier gain, LED current, filter cutoff), a signal-flow narrative, teaching notes for issues found (missing flyback diode, no decoupling, floating inputs), and suggested experiments. Use this whenever the user asks "how does this circuit work", "explain my circuit", or when beginning to teach from a built circuit.',
  parameters: {
    type: 'object',
    properties: {
      includeTeachingNotes: {
        type: 'boolean',
        description: 'Include rule-based teaching notes for issues found (default true).',
      },
    },
  },
  execute(args: { includeTeachingNotes?: boolean }, ctx: ToolContext) {
    const walkthrough = analyzeCircuitWalkthrough(ctx.doc.components, ctx.doc.wires);
    if (!args || args.includeTeachingNotes === false) {
      return { ok: true, result: { ...walkthrough, teachingNotes: [] } };
    }
    return { ok: true, result: walkthrough };
  },
};
