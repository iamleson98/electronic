# CircuitLab — Plugin Development Guide

CircuitLab is built around a **plugin registry**. Every electronic component
(resistor, capacitor, 555 timer, Arduino, ...) is a plugin that registers itself
at module load time. Adding a new component is as simple as writing one plugin
object and calling `registerPlugin(...)`.

## Quick start: a new component

```ts
// src/lib/circuit/components/myComponent.ts
import type { ComponentPlugin } from '../types';
import { registerPlugin } from '../registry';

const myComponent: ComponentPlugin = {
  type: 'myComponent',           // unique id
  name: 'My Component',          // display name
  category: 'ic',                // io | source | passive | semiconductor | ic | logic | meter | mcu
  description: 'What this part does.',
  symbol: 'MY',                  // short text shown in palette
  // grid-size of the bounding box (in cells; 1 cell = 24px)
  boundingBox: { width: 4, height: 2 },
  // terminal positions are relative to the component origin (top-left)
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  // user-editable parameters (shown in the Properties panel)
  parameters: [
    { key: 'resistance', label: 'Resistance', type: 'number', default: 1000, unit: 'Ω', min: 0.01, max: 1e9, step: 1 },
  ],

  // Draw the component. The context is already translated to the component
  // origin and rotated by `rotation * 90°`. Draw along the X axis.
  render(ctx, params, cellSize) {
    const len = 4 * cellSize;
    ctx.beginPath();
    ctx.moveTo(0, cellSize);
    ctx.lineTo(cellSize, cellSize);
    ctx.moveTo(3 * cellSize, cellSize);
    ctx.lineTo(4 * cellSize, cellSize);
    ctx.stroke();
    // ...draw the body...
  },

  // Stamp the component's contribution to the MNA system.
  // `terminals` is the resolved list of {terminalId, nodeId} for this instance.
  stamp(params, terminals, sys, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const r = params.resistance as number;
    sys.stampConductance(a, b, 1 / r);
  },

  // Optional: read live measurements for the Probe panel
  measure(params, terminals, sim) {
    const a = terminals.find(t => t.terminalId === 'a')!.nodeId;
    const b = terminals.find(t => t.terminalId === 'b')!.nodeId;
    const v = sim.nodeVoltage[a] - sim.nodeVoltage[b];
    return [{ label: 'V', value: v.toFixed(3), unit: 'V' }];
  },

  // Optional: per-step stateful logic (for ICs, MCUs, etc.)
  step(params, terminals, sim, instance) {
    // Read node voltages from sim.nodeVoltage[...]
    // Update instance.simState (persists across steps)
  },
};

registerPlugin(myComponent);
```

Then import your file from `src/lib/circuit/components/index.ts`:

```ts
import './myComponent';
```

That's it — your component now appears in the palette, supports drag-and-drop,
parameter editing, simulation, and measurement.

## MNA stamping helpers

The `MnaSystem` object passed to `stamp()` provides these helpers:

| Method | What it does |
|--------|--------------|
| `sys.stampConductance(n1, n2, g)` | Resistor of conductance `g` between n1 and n2 |
| `sys.stampCurrentSource(n1, n2, I)` | Current source pushing `I` externally from n1 to n2 |
| `sys.stampVoltageSource(n1, n2, V)` | Voltage source with V(n1) − V(n2) = V; returns branch-current index |
| `sys.stampVCVS(a, b, c, d, μ)` | V(a) − V(b) = μ·(V(c) − V(d)); returns branch index |
| `sys.stampVCCS(n1, n2, c, d, g)` | Current from n1 to n2 = g·(V(c) − V(d)) |
| `sys.stampCCCS(n1, n2, extra, β)` | Current from n1 to n2 = β · I_branch(extra) |
| `sys.stampCCVS(a, b, extra, r)` | V(a) − V(b) = r · I_branch(extra); returns new branch index |

Node 0 is always ground.

## Persistent state

For components that need memory (capacitors, inductors, 555, MCU), use:

```ts
const st = sim.state.__global ?? (sim.state.__global = {});
const key = `myComp_${a}_${b}`;
const prev = st[key] ?? initialValue;
// ...use prev...
st[key] = newValue;  // persists across simulation steps
```

`sim.state.__global` is a single object that survives across simulation steps
within one session. It is reset when the user clicks "Reset" or loads a new
circuit.

## Parameter types

| `type`     | UI control |
|------------|------------|
| `number`   | Slider + numeric input |
| `string`   | Text input |
| `select`   | Dropdown (provide `options: [{label, value}]`) |
| `boolean`  | Toggle switch |
| `color`    | Color picker |

## Adding a new example circuit

Edit `src/lib/circuit/examples.ts`:

```ts
export const myExample: CircuitDocument = {
  version: 1,
  components: [
    comp('resistor', 'r1', [10, 5], 0, { resistance: 470 }),
    // ...
  ],
  wires: [
    wire('w1', 'r1', 'a', 'r2', 'b'),
    // ...
  ],
};

export const examples = [
  // ...existing...
  { name: 'My Example', description: '...', doc: myExample },
];
```

## Save / load

Circuits serialize to JSON via `useEditor.getState().serialize()`. The format is:

```json
{
  "version": 1,
  "components": [
    { "id": "comp_...", "type": "resistor", "position": {"x": 10, "y": 5}, "rotation": 0, "parameters": {"resistance": 1000} }
  ],
  "wires": [
    { "id": "wire_...", "from": {"componentId": "comp_1", "terminalId": "a"}, "to": {"componentId": "comp_2", "terminalId": "b"} }
  ]
}
```

The "Save" button downloads this as a `.json` file. "Load" re-imports it.

## Future extensibility

- **Database persistence**: the JSON format above can be stored in Prisma
  (already configured) — just add a `Circuit` model and call `db.circuit.create()`.
- **Sub-circuits / custom ICs**: a plugin can internally expand to a sub-circuit
  by stamping multiple components in its `stamp()` method.
- **Real firmware emulation**: replace the Arduino/RPi stub's `stamp()` with a
  JS interpreter for `.hex`/`.elf` files; the plugin interface already supports
  per-step stateful logic.
- **SPICE import**: write a parser that converts SPICE netlists into
  `CircuitDocument` objects.
