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
  boundingBox: { width: 8, height: 6 },
  terminals: [
    { id: '5v', label: '5V', position: { x: 0, y: 1 } },
    { id: 'gnd', label: 'GND', position: { x: 0, y: 2 } },
    { id: 'd2', label: 'D2', position: { x: 8, y: 1 } },
    { id: 'd3', label: 'D3', position: { x: 8, y: 2 } },
    { id: 'd4', label: 'D4', position: { x: 8, y: 3 } },
    { id: 'd5', label: 'D5', position: { x: 8, y: 4 } },
    { id: 'a0', label: 'A0', position: { x: 0, y: 4 } },
    { id: 'a1', label: 'A1', position: { x: 0, y: 5 } },
  ],
  parameters: [
    { key: 'sketch', label: 'Sketch Source', type: 'string', default: sampleSketches.blink },
    { key: 'vcc', label: 'VCC', type: 'number', default: 5, unit: 'V', min: 1, max: 12, step: 0.1 },
  ],
  render(ctx, params, cellSize) {
    const w = 8 * cellSize;
    const h = 6 * cellSize;
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
    ctx.fillText('ARDUINO', 4 * cellSize, 2.4 * cellSize);
    ctx.font = `${Math.floor(cellSize * 0.55)}px ui-monospace, monospace`;
    ctx.fillText('programmable', 4 * cellSize, 3.2 * cellSize);
    // pin labels
    ctx.textAlign = 'left';
    ctx.font = `${Math.floor(cellSize * 0.5)}px ui-monospace, monospace`;
    ['5V', 'GND', 'A0', 'A1'].forEach((p, i) => {
      const y = [1, 2, 4, 5][i];
      ctx.fillText(p, cellSize * 0.3, y * cellSize);
    });
    ctx.textAlign = 'right';
    ['D2', 'D3', 'D4', 'D5'].forEach((p, i) => {
      const y = [1, 2, 3, 4][i];
      ctx.fillText(p, w - cellSize * 0.3, y * cellSize);
    });
    // status indicator
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(4 * cellSize, 4.5 * cellSize, 3, 0, Math.PI * 2);
    ctx.fill();
  },
  stamp(params, terminals, sys, sim) {
    const vccV = params.vcc as number;
    const sketchSrc = params.sketch as string;
    const gnd = terminals.find((t) => t.terminalId === 'gnd')!.nodeId;
    const five = terminals.find((t) => t.terminalId === '5v')!.nodeId;
    if (five !== gnd) sys.stampVoltageSource(five, gnd, vccV);

    // Build pin->node map
    const pinToNode: Record<string, number> = {};
    for (const t of terminals) pinToNode[t.terminalId] = t.nodeId;

    // Get or initialize firmware state (per-instance, keyed by component position hash)
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
    // Inputs (A0, A1): high-Z with weak pull-down
    ['a0', 'a1'].forEach((tid) => {
      const t = terminals.find((tt) => tt.terminalId === tid);
      if (t && t.nodeId !== gnd) sys.stampConductance(t.nodeId, gnd, 1e-9);
    });
  },
  measure(params, terminals, sim) {
    const d2 = terminals.find((t) => t.terminalId === 'd2')!.nodeId;
    const d3 = terminals.find((t) => t.terminalId === 'd3')!.nodeId;
    const d4 = terminals.find((t) => t.terminalId === 'd4')!.nodeId;
    const d5 = terminals.find((t) => t.terminalId === 'd5')!.nodeId;
    const a0 = terminals.find((t) => t.terminalId === 'a0')!.nodeId;
    return [
      { label: 'D2', value: sim.nodeVoltage[d2].toFixed(2), unit: 'V' },
      { label: 'D3', value: sim.nodeVoltage[d3].toFixed(2), unit: 'V' },
      { label: 'D4', value: sim.nodeVoltage[d4].toFixed(2), unit: 'V' },
      { label: 'D5', value: sim.nodeVoltage[d5].toFixed(2), unit: 'V' },
      { label: 'A0', value: sim.nodeVoltage[a0].toFixed(2), unit: 'V' },
    ];
  },
};

// Import registerPlugin lazily to avoid circular dependency
import { registerPlugin } from '../registry';

// Register the programmable Arduino plugin
registerPlugin(arduinoReal);

export { arduinoReal };
