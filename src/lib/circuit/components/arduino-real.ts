// Real Arduino firmware emulator.
//
// Instead of a fixed set of "sketches" (blink / button / PWM), this lets the user
// write a tiny Arduino-like program with a small instruction set. We compile it
// into a simple bytecode and execute one cycle per simulation step.
//
// Supported syntax (very minimal, Arduino-flavored):
//
//   pin D2 output       // declare D2 as output
//   pin A0 input        // declare A0 as input (analog read)
//   D2 = HIGH           // set D2 high (or 1, or 5)
//   D2 = LOW            // set D2 low (or 0)
//   D3 = A0             // copy A0 voltage (digital threshold) to D3
//   wait 500ms          // delay 500ms
//   wait 1s             // delay 1 second
//   loop                // label: jump back here
//   if A0 > 2.5 goto triggered
//   goto loop
//   triggered:
//   D2 = HIGH
//   wait 100ms
//   goto loop
//
// The interpreter runs one "instruction" per simulation step (or skips wait
// instructions until the wait expires). Pin reads use the actual simulated node
// voltages; pin writes drive voltage sources in the next stamp pass.

import type { ComponentPlugin, SimContext, MnaSystem } from '../types';

export interface ArduinoPin {
  id: string;        // 'd2', 'a0', etc.
  label: string;     // 'D2', 'A0'
  kind: 'digital' | 'analog';
}

export interface ArduinoFirmwareState {
  pc: number;             // program counter
  waitUntil: number;      // sim time at which wait expires
  pinStates: Record<string, number>;  // pin id -> driven voltage (or -1 if input)
  outputs: Record<string, number>;    // pin id -> voltage to drive (set by firmware)
}

export interface ArduinoInstruction {
  op: 'setPin' | 'wait' | 'goto' | 'label' | 'ifGoto' | 'setPinFromPin' | 'nop';
  args: any[];
}

/** Parse a sketch source string into instructions. */
export function compileArduinoSketch(source: string): { instructions: ArduinoInstruction[]; labels: Record<string, number> } {
  const instructions: ArduinoInstruction[] = [];
  const labels: Record<string, number> = {};

  const lines = source
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, '').trim())
    .filter(l => l.length > 0);

  for (const line of lines) {
    // pin declaration: pin D2 output
    let m = line.match(/^pin\s+(\w+)\s+(output|input)$/i);
    if (m) {
      // declaration only - no instruction needed (we know pinout from plugin)
      continue;
    }
    // label: name
    m = line.match(/^([a-zA-Z_]\w*):$/);
    if (m) {
      labels[m[1].toLowerCase()] = instructions.length;
      continue;
    }
    // wait 500ms / wait 1s / wait 100us
    m = line.match(/^wait\s+([\d.]+)\s*(ms|s|us)$/i);
    if (m) {
      const val = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const sec = unit === 's' ? val : unit === 'ms' ? val / 1000 : val / 1e6;
      instructions.push({ op: 'wait', args: [sec] });
      continue;
    }
    // goto label
    m = line.match(/^goto\s+(\w+)$/i);
    if (m) {
      instructions.push({ op: 'goto', args: [m[1].toLowerCase()] });
      continue;
    }
    // if A0 > 2.5 goto label   (also: <, >=, <=, ==, !=)
    m = line.match(/^if\s+(\w+)\s*(>=|<=|>|<|==|!=)\s*([\d.]+)\s+goto\s+(\w+)$/i);
    if (m) {
      const pin = m[1].toLowerCase();
      const op = m[2];
      const val = parseFloat(m[3]);
      const label = m[4].toLowerCase();
      instructions.push({ op: 'ifGoto', args: [pin, op, val, label] });
      continue;
    }
    // D2 = HIGH / LOW / number
    m = line.match(/^(\w+)\s*=\s*(HIGH|LOW|[\d.]+)$/i);
    if (m) {
      const pin = m[1].toLowerCase();
      const valTok = m[2].toUpperCase();
      let v: number;
      if (valTok === 'HIGH') v = 5;
      else if (valTok === 'LOW') v = 0;
      else v = parseFloat(valTok);
      instructions.push({ op: 'setPin', args: [pin, v] });
      continue;
    }
    // D3 = A0  (copy pin)
    m = line.match(/^(\w+)\s*=\s*(\w+)$/i);
    if (m) {
      const dst = m[1].toLowerCase();
      const src = m[2].toLowerCase();
      instructions.push({ op: 'setPinFromPin', args: [dst, src] });
      continue;
    }
    // unknown line - skip silently
  }

  return { instructions, labels };
}

/** Execute one firmware "tick" against the current sim state. Updates `state` in place. */
export function executeFirmwareTick(
  state: ArduinoFirmwareState,
  instructions: ArduinoInstruction[],
  labels: Record<string, number>,
  sim: SimContext,
  pinToNode: Record<string, number>,
  vccV: number,
): void {
  if (state.waitUntil > sim.time) return; // still waiting
  if (state.pc >= instructions.length) return; // program ended

  // Run up to N instructions per tick to make progress through waits quickly
  const maxInstrPerTick = 50;
  for (let n = 0; n < maxInstrPerTick; n++) {
    if (state.pc >= instructions.length) return;
    const instr = instructions[state.pc];
    switch (instr.op) {
      case 'setPin': {
        const [pin, v] = instr.args as [string, number];
        state.outputs[pin] = v === 5 ? vccV : v; // HIGH -> VCC
        state.pc++;
        break;
      }
      case 'setPinFromPin': {
        const [dst, src] = instr.args as [string, string];
        const srcNode = pinToNode[src];
        if (srcNode !== undefined) {
          const v = sim.nodeVoltage[srcNode] || 0;
          state.outputs[dst] = v;
        }
        state.pc++;
        break;
      }
      case 'wait': {
        const [sec] = instr.args as [number];
        state.waitUntil = sim.time + sec;
        state.pc++;
        return; // stop this tick
      }
      case 'goto': {
        const [label] = instr.args as [string];
        if (labels[label] !== undefined) state.pc = labels[label];
        else state.pc++;
        break;
      }
      case 'ifGoto': {
        const [pin, op, val, label] = instr.args as [string, string, number, string];
        const node = pinToNode[pin];
        const actual = node !== undefined ? (sim.nodeVoltage[node] || 0) : 0;
        let cond = false;
        switch (op) {
          case '>': cond = actual > val; break;
          case '<': cond = actual < val; break;
          case '>=': cond = actual >= val; break;
          case '<=': cond = actual <= val; break;
          case '==': cond = Math.abs(actual - val) < 0.05; break;
          case '!=': cond = Math.abs(actual - val) >= 0.05; break;
        }
        if (cond && labels[label] !== undefined) state.pc = labels[label];
        else state.pc++;
        break;
      }
      case 'label':
      case 'nop':
      default:
        state.pc++;
        break;
    }
  }
}

// Pre-built sketches as examples
export const sampleSketches: Record<string, string> = {
  blink: `// Classic blink
loop:
D2 = HIGH
wait 500ms
D2 = LOW
wait 500ms
goto loop`,
  button: `// Read A0, mirror to D3
loop:
if A0 > 2.5 goto on
D3 = LOW
wait 10ms
goto loop
on:
D3 = HIGH
wait 10ms
goto loop`,
  pwm_50: `// Software PWM 50% on D3 at ~1kHz
loop:
D3 = HIGH
wait 0.5ms
D3 = LOW
wait 0.5ms
goto loop`,
  counter: `// 4-bit binary counter on D2-D5
loop:
D2 = HIGH
wait 100ms
D2 = LOW
D3 = HIGH
wait 100ms
D3 = LOW
D4 = HIGH
wait 100ms
D4 = LOW
D5 = HIGH
wait 100ms
D5 = LOW
goto loop`,
};

// Plugin definition
const arduinoReal: ComponentPlugin = {
  type: 'arduinoReal',
  name: 'Arduino (programmable)',
  category: 'mcu',
  description: 'Arduino-compatible MCU with user-programmable firmware. Write a tiny sketch with pin/wait/goto/if.',
  symbol: 'ARD',
  boundingBox: { width: 8, height: 13 },
  terminals: [
    { id: '5v', label: '5V', position: { x: 0, y: 1 } },
    { id: 'gnd', label: 'GND', position: { x: 0, y: 2 } },
    { id: 'a0', label: 'A0', position: { x: 0, y: 5 } },
    { id: 'a1', label: 'A1', position: { x: 0, y: 6 } },
    { id: 'a2', label: 'A2', position: { x: 0, y: 7 } },
    { id: 'd2', label: 'D2', position: { x: 8, y: 1 } },
    { id: 'd3', label: 'D3', position: { x: 8, y: 2 } },
    { id: 'd4', label: 'D4', position: { x: 8, y: 3 } },
    { id: 'd5', label: 'D5', position: { x: 8, y: 4 } },
    { id: 'd6', label: 'D6', position: { x: 8, y: 5 } },
    { id: 'd7', label: 'D7', position: { x: 8, y: 6 } },
    { id: 'd8', label: 'D8', position: { x: 8, y: 7 } },
    { id: 'd9', label: 'D9', position: { x: 8, y: 8 } },
    { id: 'd10', label: 'D10', position: { x: 8, y: 9 } },
    { id: 'd11', label: 'D11', position: { x: 8, y: 10 } },
    { id: 'd12', label: 'D12', position: { x: 8, y: 11 } },
    { id: 'd13', label: 'D13', position: { x: 8, y: 12 } },
  ],
  parameters: [
    { key: 'sketch', label: 'Sketch Source', type: 'string', default: sampleSketches.blink },
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 1, max: 12, step: 0.1 },
    { key: 'clockMode', label: 'Clock Mode (HH:MM:SS)', type: 'boolean', default: false },
  ],
  render(ctx, params, cellSize) {
    const w = 8 * cellSize;
    const h = 13 * cellSize;
    ctx.fillStyle = '#16a34a';
    ctx.strokeStyle = '#064e3b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cellSize * 0.2, cellSize * 0.2, w - cellSize * 0.4, h - cellSize * 0.4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#dcfce7';
    ctx.font = `bold ${Math.floor(cellSize * 1)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ARDUINO', 4 * cellSize, 3 * cellSize);
    ctx.font = `${Math.floor(cellSize * 0.55)}px ui-monospace, monospace`;
    ctx.fillText('programmable', 4 * cellSize, 4 * cellSize);
    // pin labels — left side (power + analog)
    ctx.textAlign = 'left';
    ctx.font = `${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
    ['5V', 'GND', 'A0', 'A1', 'A2'].forEach((p, i) => {
      const y = [1, 2, 5, 6, 7][i];
      ctx.fillText(p, cellSize * 0.3, y * cellSize);
    });
    // pin labels — right side (digital D2-D13)
    ctx.textAlign = 'right';
    ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13'].forEach((p, i) => {
      const y = i + 1;
      ctx.fillText(p, w - cellSize * 0.3, y * cellSize);
    });
    // status indicator
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(4 * cellSize, 10 * cellSize, 3, 0, Math.PI * 2);
    ctx.fill();
  },
  stamp(params, terminals, sys, sim) {
    const vccV = params.vcc as number;
    const sketchSrc = params.sketch as string;
    const clockMode = (params.clockMode as boolean) ?? false;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const five = terminals.find((t) => t.terminalId === '5v')!.nodeId;
    if (five !== gnd) sys.stampVoltageSource(five, gnd, vccV);

    // Build pin->node map
    const pinToNode: Record<string, number> = {};
    for (const t of terminals) pinToNode[t.terminalId] = t.nodeId;

    // ── Clock Mode: drive 6 multiplexed 7-segment displays ───────────────
    // Pin mapping:
    //   D2-D8: 7 shared segment lines (a-g) — via 220Ω resistors
    //   D9-D13, A0: 6 digit-select lines (drive each display's `com` terminal)
    //
    // The Arduino computes hours:minutes:seconds from sim.time, then
    // activates ONE display per step (drives its `com` LOW, others HIGH)
    // and sets the 7 segment lines for that display's digit. The 7-seg
    // displays LATCH their state (see extra.ts), so all 6 displays show
    // their correct values even though only one is refreshed per step.
    if (clockMode) {
      const segPins = ['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];
      const digitSelectPins = ['d9', 'd10', 'd11', 'd12', 'd13', 'a0'];

      // Compute time from sim.time
      const totalSec = Math.floor(sim.time);
      const hours = Math.floor(totalSec / 3600) % 24;
      const minutes = Math.floor(totalSec / 60) % 60;
      const seconds = totalSec % 60;
      const digits = [
        Math.floor(hours / 10), hours % 10,
        Math.floor(minutes / 10), minutes % 10,
        Math.floor(seconds / 10), seconds % 10,
      ];

      // 7-segment patterns (a, b, c, d, e, f, g)
      const SEG_PATTERNS: Record<number, number[]> = {
        0: [1,1,1,1,1,1,0], 1: [0,1,1,0,0,0,0], 2: [1,1,0,1,1,0,1],
        3: [1,1,1,1,0,0,1], 4: [0,1,1,0,0,1,1], 5: [1,0,1,1,0,1,1],
        6: [1,0,1,1,1,1,1], 7: [1,1,1,0,0,0,0], 8: [1,1,1,1,1,1,1],
        9: [1,1,1,1,0,1,1],
      };

      // Cycle through 6 displays, one per step
      const activeDigit = Math.floor(sim.time * 60) % 6; // change display every ~16ms

      // Drive all digit-select pins: active=LOW (0V), inactive=HIGH (VCC)
      for (let i = 0; i < 6; i++) {
        const pin = digitSelectPins[i];
        const node = pinToNode[pin];
        if (node && node !== gnd) {
          sys.stampVoltageSource(node, gnd, i === activeDigit ? 0 : vccV);
        }
      }

      // Drive segment lines for the active display's digit
      const digitValue = digits[activeDigit];
      const pattern = SEG_PATTERNS[digitValue] ?? [0,0,0,0,0,0,0];
      for (let i = 0; i < 7; i++) {
        const pin = segPins[i];
        const node = pinToNode[pin];
        if (node && node !== gnd) {
          sys.stampVoltageSource(node, gnd, pattern[i] ? vccV : 0);
        }
      }

      // Fast-forward: advance sim.time by 16ms so the clock ticks at real-time
      if (sim.dt < 0.016) {
        sim.time = sim.time + 0.016 - sim.dt;
      }

      // Inputs (A1, A2): high-Z with weak pull-down
      ['a1', 'a2'].forEach((tid) => {
        const t = terminals.find((tt) => tt.terminalId === tid);
        if (t && t.nodeId !== gnd) sys.stampConductance(t.nodeId, gnd, 1e-6);
      });
      return;
    }

    // ── Normal sketch mode ──────────────────────────────────────────────
    const key = `arduinoReal_${terminals.map(t => `${t.terminalId}=${t.nodeId}`).join('_')}`;
    let st = sim.state[key] as ArduinoFirmwareState | undefined;
    if (!st) {
      st = {
        pc: 0,
        waitUntil: 0,
        pinStates: {},
        outputs: {},
      };
      sim.state[key] = st;
    }
    // Compile sketch once and cache
    if (!(sim.state as any)[`${key}_compiled`]) {
      const compiled = compileArduinoSketch(sketchSrc);
      (sim.state as any)[`${key}_compiled`] = compiled;
    }
    const compiled = (sim.state as any)[`${key}_compiled`];

    // Fast-forward: if the firmware is in a wait state, advance sim.time by
    // a bounded amount so the wait completes in roughly real-time (at speed=1)
    // instead of 5000 steps. Without this, a 500ms wait would take 80 seconds
    // of real time at 60Hz (dt=0.1ms per step).
    //
    // Cap: advance by at most 16ms per simulateStep call. Since step() in the
    // store runs `speed` sub-steps per RAF frame (16ms), sim.time advances by
    // ~speed*16ms per frame = ~speed seconds per real second. At speed=1, a
    // 500ms wait takes ~31 steps = ~517ms real time — close to actual real-time,
    // so each digit is clearly visible.
    //
    // This is safe because during a wait, the firmware isn't doing anything —
    // pin outputs are unchanged. Other components (capacitors, inductors) see a
    // small time discontinuity (16ms) which is negligible for digital circuits.
    if (st.waitUntil > sim.time) {
      const maxAdvance = Math.max(sim.dt, 0.016); // at least dt, at most 16ms
      const target = Math.min(st.waitUntil, sim.time + maxAdvance);
      sim.time = target;
    }

    // Execute firmware
    executeFirmwareTick(st, compiled.instructions, compiled.labels, sim, pinToNode, vccV);

    // Stamp outputs: drive each pin mentioned in st.outputs as a voltage source
    for (const [pin, v] of Object.entries(st.outputs)) {
      const term = terminals.find((t) => t.terminalId === pin);
      if (!term) continue;
      if (term.nodeId !== gnd) {
        sys.stampVoltageSource(term.nodeId, gnd, v as number);
      }
    }
    // Inputs (A0, A1, A2): high-Z with weak pull-down
    ['a0', 'a1', 'a2'].forEach((tid) => {
      const t = terminals.find((tt) => tt.terminalId === tid);
      if (t && t.nodeId !== gnd) sys.stampConductance(t.nodeId, gnd, 1e-6);
    });
  },
  measure(params, terminals, sim) {
    const d2 = terminals.find((t) => t.terminalId === 'd2')?.nodeId ?? 0;
    const d3 = terminals.find((t) => t.terminalId === 'd3')?.nodeId ?? 0;
    const d4 = terminals.find((t) => t.terminalId === 'd4')?.nodeId ?? 0;
    const d5 = terminals.find((t) => t.terminalId === 'd5')?.nodeId ?? 0;
    const d6 = terminals.find((t) => t.terminalId === 'd6')?.nodeId ?? 0;
    const d7 = terminals.find((t) => t.terminalId === 'd7')?.nodeId ?? 0;
    const d8 = terminals.find((t) => t.terminalId === 'd8')?.nodeId ?? 0;
    const a0 = terminals.find((t) => t.terminalId === 'a0')?.nodeId ?? 0;
    return [
      { label: 'D2', value: sim.nodeVoltage[d2].toFixed(2), unit: 'V' },
      { label: 'D3', value: sim.nodeVoltage[d3].toFixed(2), unit: 'V' },
      { label: 'D4', value: sim.nodeVoltage[d4].toFixed(2), unit: 'V' },
      { label: 'D5', value: sim.nodeVoltage[d5].toFixed(2), unit: 'V' },
      { label: 'D6', value: sim.nodeVoltage[d6].toFixed(2), unit: 'V' },
      { label: 'D7', value: sim.nodeVoltage[d7].toFixed(2), unit: 'V' },
      { label: 'D8', value: sim.nodeVoltage[d8].toFixed(2), unit: 'V' },
      { label: 'A0', value: sim.nodeVoltage[a0].toFixed(2), unit: 'V' },
    ];
  },
};

// Import registerPlugin lazily to avoid circular dependency
import { registerPlugin } from '../registry';

// Register the programmable Arduino plugin
registerPlugin(arduinoReal);

export { arduinoReal };
