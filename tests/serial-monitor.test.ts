// Tests for the Serial Monitor / Plotter firmware opcodes (print / println /
// plot) — compiler, interpreter, serial state caps, and a full-engine
// integration (arduinoReal stamp writing into sim.state).

import { describe, it, expect, beforeAll } from 'vitest';
import {
  compileArduinoSketch,
  executeFirmwareTick,
  createSerialState,
  serialWrite,
  serialPlot,
  SERIAL_MAX_LINES,
  SERIAL_MAX_POINTS,
  type ArduinoFirmwareState,
} from '../src/lib/circuit/components/arduino-real';
import type { SimContext } from '../src/lib/circuit/types';

function makeSim(time: number, voltages: number[]): SimContext {
  const nodeVoltage = new Float64Array(voltages.length + 1);
  voltages.forEach((v, i) => { nodeVoltage[i + 1] = v; });
  return {
    nodeVoltage,
    branchCurrent: new Float64Array(0),
    state: {},
    time,
    dt: 1e-4,
  } as unknown as SimContext;
}

function freshFwState(): ArduinoFirmwareState {
  return { pc: 0, waitUntil: 0, pinStates: {}, outputs: {} };
}

describe('Serial opcode compilation', () => {
  it('println with string + pin compiles to print args', () => {
    const { instructions } = compileArduinoSketch('println "A0=" A0');
    expect(instructions).toHaveLength(1);
    expect(instructions[0].op).toBe('println');
    const args = instructions[0].args[0] as any[];
    expect(args[0]).toEqual({ kind: 'str', text: 'A0=' });
    expect(args[1]).toEqual({ kind: 'pin', pin: 'a0' });
  });

  it('print (no newline) compiles as op print', () => {
    const { instructions } = compileArduinoSketch('print "V: " A0');
    expect(instructions[0].op).toBe('print');
  });

  it('numbers compile as literals', () => {
    const { instructions } = compileArduinoSketch('println 3.14');
    const args = instructions[0].args[0] as any[];
    expect(args[0]).toEqual({ kind: 'literal', text: '3.14' });
  });

  it('plot A0 → series defaults to the pin name', () => {
    const { instructions } = compileArduinoSketch('plot A0');
    expect(instructions[0].op).toBe('plot');
    expect(instructions[0].args).toEqual(['a0', 'a0']);
  });

  it('plot label pin → custom series name', () => {
    const { instructions } = compileArduinoSketch('plot pot A0');
    expect(instructions[0].args).toEqual(['pot', 'a0']);
  });

  it('mixed tokens: "x=" A0 y= 2.5', () => {
    const { instructions } = compileArduinoSketch('println "x=" A0 " y=" 2.5');
    const args = instructions[0].args[0] as any[];
    expect(args.map((a: any) => a.kind)).toEqual(['str', 'pin', 'str', 'literal']);
  });

  it('bare print with no args compiles to an empty arg list (prints newline only)', () => {
    const { instructions } = compileArduinoSketch('println ""');
    const args = instructions[0].args[0] as any[];
    expect(args).toHaveLength(0);
  });
});

describe('Serial state helpers', () => {
  it('println commits a line; print accumulates pending', () => {
    const st = createSerialState();
    serialWrite(st, 'a', false, 1);
    serialWrite(st, 'b', false, 2);
    expect(st.pending).toBe('ab');
    expect(st.pendingT).toBe(1);
    expect(st.lines).toHaveLength(0);
    serialWrite(st, 'c', true, 3);
    // line timestamp = commit (println) time, matching serial-monitor semantics
    expect(st.lines).toEqual([{ t: 3, text: 'abc' }]);
    expect(st.pending).toBe('');
  });

  it('line cap enforced', () => {
    const st = createSerialState();
    for (let i = 0; i < SERIAL_MAX_LINES + 100; i++) {
      serialWrite(st, `line${i}`, true, i * 0.001);
    }
    expect(st.lines.length).toBeLessThanOrEqual(SERIAL_MAX_LINES);
    // oldest dropped
    expect(st.lines[0].text).toBe(`line100`);
  });

  it('pending guard: runaway print without newlines capped at 2000 chars', () => {
    const st = createSerialState();
    for (let i = 0; i < 3000; i++) serialWrite(st, 'x', false, 0);
    expect(st.pending.length).toBeLessThanOrEqual(2000);
  });

  it('plot cap enforced', () => {
    const st = createSerialState();
    for (let i = 0; i < SERIAL_MAX_POINTS + 500; i++) {
      serialPlot(st, 's', i * 0.001, i);
    }
    expect(st.plots['s'].points.length).toBeLessThanOrEqual(SERIAL_MAX_POINTS);
  });

  it('version bumps on writes', () => {
    const st = createSerialState();
    const v0 = st.version;
    serialWrite(st, 'x', true, 0);
    expect(st.version).toBe(v0 + 1);
    serialPlot(st, 's', 0, 1);
    expect(st.version).toBe(v0 + 2);
  });
});

describe('Serial execution in the firmware interpreter', () => {
  it('println evaluates pins to live voltages (2 decimals)', () => {
    const { instructions, labels } = compileArduinoSketch('println "V=" A0');
    const st = freshFwState();
    const serial = createSerialState();
    const sim = makeSim(0.5, [2.5]);
    executeFirmwareTick(st, instructions, labels, sim as any, { a0: 1 }, 5, serial);
    expect(serial.lines).toHaveLength(1);
    expect(serial.lines[0].text).toBe('V=2.50');
    expect(serial.lines[0].t).toBe(0.5);
  });

  it('unknown identifier in print falls back to literal text', () => {
    const { instructions, labels } = compileArduinoSketch('println hello');
    const serial = createSerialState();
    executeFirmwareTick(freshFwState(), instructions, labels, makeSim(0, []) as any, {}, 5, serial);
    expect(serial.lines[0].text).toBe('hello');
  });

  it('print followed by println concatenates into one line', () => {
    const { instructions, labels } = compileArduinoSketch('print "a"\nprint "b"\nprintln "c"');
    const serial = createSerialState();
    executeFirmwareTick(freshFwState(), instructions, labels, makeSim(1, []) as any, {}, 5, serial);
    expect(serial.lines).toEqual([{ t: 1, text: 'abc' }]);
  });

  it('plot records (t, voltage) into the named series', () => {
    const { instructions, labels } = compileArduinoSketch('plot pot A0');
    const serial = createSerialState();
    executeFirmwareTick(freshFwState(), instructions, labels, makeSim(0.25, [1.2]) as any, { a0: 1 }, 5, serial);
    expect(serial.plots['pot'].points).toEqual([{ t: 0.25, v: 1.2 }]);
  });

  it('no serial object → opcodes still advance pc (no crash)', () => {
    const { instructions, labels } = compileArduinoSketch('println "x"\nD2 = HIGH');
    const st = freshFwState();
    executeFirmwareTick(st, instructions, labels, makeSim(0, []) as any, { d2: 2 }, 5);
    expect(st.outputs['d2']).toBe(5);
  });

  it('a wait-loop sketch emits one line per iteration', () => {
    const src = 'loop:\nprintln "t" A0\nplot A0\nwait 10ms\ngoto loop';
    const { instructions, labels } = compileArduinoSketch(src);
    const st = freshFwState();
    const serial = createSerialState();
    const pinToNode = { a0: 1 };
    let t = 0;
    for (let i = 0; i < 5; i++) {
      const sim = makeSim(t, [3.3]);
      executeFirmwareTick(st, instructions, labels, sim as any, pinToNode, 5, serial);
      // fast-forward the wait like the plugin does
      t = st.waitUntil + 0.001;
    }
    expect(serial.lines.length).toBeGreaterThanOrEqual(5);
    expect(serial.plots['a0'].points.length).toBeGreaterThanOrEqual(5);
    expect(serial.lines[0].text).toBe('t3.30');
  });
});

describe('Full-engine integration: arduinoReal serial output', () => {
  it('simulateStep writes serial state under arduinoReal_<id>_serial', async () => {
    const { simulateStep, buildNodeMap, getTerminalsForComponent } = await import('../src/lib/circuit/engine');
    const { getPlugin } = await import('../src/lib/circuit/registry');
    await import('../src/lib/circuit/components/arduino-real');
    await import('../src/lib/circuit/components/passive');

    const arduino = {
      id: 'mcu1',
      type: 'arduinoReal',
      position: { x: 0, y: 0 },
      rotation: 0,
      parameters: {
        sketch: 'loop:\nprintln "V=" A0\nwait 5ms\ngoto loop',
        vcc: 5,
        clockMode: false,
      },
    };
    // wire a0 to the MCU's own 5v rail → A0 reads 5.00 V
    const w = { id: 'w1', from: { componentId: 'mcu1', terminalId: '5v' }, to: { componentId: 'mcu1', terminalId: 'a0' } };
    const plugins = new Map([[ 'arduinoReal', getPlugin('arduinoReal')! ]]);
    const nodeMap = buildNodeMap([arduino as any], [w as any], plugins);
    const terminals = getTerminalsForComponent(arduino as any, plugins.get('arduinoReal')!, nodeMap);

    let prev: any = undefined;
    for (let i = 0; i < 8; i++) {
      const result = simulateStep([arduino as any], [w as any], plugins, prev, 1e-4);
      expect(result).not.toBeNull();
      prev = {
        nodeVoltage: result.sim.nodeVoltage,
        branchCurrent: result.sim.branchCurrent,
        time: result.sim.time,
        state: result.sim.state,
      };
    }
    // The stamp runs BEFORE the solve of the first step, so the very first
    // line reads the pre-solve voltage (0). Subsequent lines read the solved
    // 5 V rail — assert that at least one committed line does.
    const serialKey = `arduinoReal_${arduino.id}_serial`;
    const serial = prev.state[serialKey];
    expect(serial).toBeDefined();
    expect(serial.lines.length).toBeGreaterThan(0);
    expect(serial.lines.some((l: any) => l.text === 'V=5.00')).toBe(true);
    void terminals;
  });
});
