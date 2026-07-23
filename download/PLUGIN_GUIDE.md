# CircuitLab — Plugin & Feature Guide

CircuitLab is a web-based circuit simulator with a real MNA solver, plugin architecture,
database persistence, SPICE import, sub-circuit support, and a programmable Arduino emulator.

## Table of Contents

1. [Built-in Components](#built-in-components)
2. [Adding a New Component Plugin](#adding-a-new-component-plugin)
3. [MNA Stamping Helpers](#mna-stamping-helpers)
4. [Database Persistence (My Circuits)](#database-persistence)
5. [SPICE Netlist Import](#spice-netlist-import)
6. [Sub-Circuit Support](#sub-circuit-support)
7. [Programmable Arduino Firmware](#programmable-arduino-firmware)
8. [Save / Load JSON Format](#save--load-json-format)

---

## Built-in Components

40+ components across 8 categories:

| Category | Components |
|----------|-----------|
| **Inputs / Outputs** | LED, Push Button, Switch (SPST), 7-Segment Display, Speaker |
| **Power Sources** | DC Voltage, AC Voltage, Pulse, DC Current, Ground |
| **Passive** | Resistor, Capacitor, Inductor, Potentiometer, Junction, Transformer, Photoresistor |
| **Semiconductors** | Diode, NPN, PNP, NMOS, PMOS |
| **Integrated Circuits** | 555 Timer, Op-Amp (ideal), Op-Amp (real, with rails), VCO, Crystal Osc, Diode AND (sub-circuit), Voltage Divider (sub-circuit) |
| **Logic Gates** | AND, OR, NAND, NOR, XOR, NOT |
| **Meters & Probes** | Voltmeter, Ammeter, Oscilloscope |
| **Microcontrollers** | Arduino (programmable), Arduino Uno (stub), Raspberry Pi (stub) |

---

## Adding a New Component Plugin

Every component is a plugin registered via `registerPlugin(...)`. To add a new part:

```ts
// src/lib/circuit/components/myComponent.ts
import type { ComponentPlugin } from '../types';
import { registerPlugin } from '../registry';

const myComponent: ComponentPlugin = {
  type: 'myComponent',
  name: 'My Component',
  category: 'ic',  // io | source | passive | semiconductor | ic | logic | meter | mcu
  description: 'What this part does.',
  symbol: 'MY',
  boundingBox: { width: 4, height: 2 },  // in grid cells (1 cell = 24px)
  terminals: [
    { id: 'a', label: 'A', position: { x: 0, y: 1 } },
    { id: 'b', label: 'B', position: { x: 4, y: 1 } },
  ],
  parameters: [
    { key: 'resistance', label: 'Resistance', type: 'number', default: 1000, unit: 'Ω', min: 0.01, max: 1e9, step: 1 },
  ],
  render(ctx, params, cellSize) { /* draw the part on canvas */ },
  stamp(params, terminals, sys, sim) { /* MNA contribution */ },
  measure(params, terminals, sim) { /* return readings for probe panel */ },
  step(params, terminals, sim, instance) { /* per-step stateful logic (optional) */ },
};

registerPlugin(myComponent);
```

Then import your file from `src/lib/circuit/components/index.ts`:

```ts
import './myComponent';
```

### Parameter types

| `type`     | UI control |
|------------|------------|
| `number`   | Slider + numeric input |
| `string`   | Text input (or code editor if value contains newlines) |
| `select`   | Dropdown (provide `options: [{label, value}]`) |
| `boolean`  | Toggle switch |
| `color`    | Color picker |

---

## MNA Stamping Helpers

The `MnaSystem` object passed to `stamp()` provides:

| Method | What it does |
|--------|--------------|
| `sys.stampConductance(n1, n2, g)` | Resistor of conductance `g` between n1 and n2 |
| `sys.stampCurrentSource(n1, n2, I)` | Current source pushing `I` externally from n1 to n2 |
| `sys.stampVoltageSource(n1, n2, V)` | V(n1) − V(n2) = V; returns branch-current index |
| `sys.stampVCVS(a, b, c, d, μ)` | V(a) − V(b) = μ·(V(c) − V(d)); returns branch index |
| `sys.stampVCCS(n1, n2, c, d, g)` | Current from n1 to n2 = g·(V(c) − V(d)) |
| `sys.stampCCCS(n1, n2, extra, β)` | Current from n1 to n2 = β · I_branch(extra) |
| `sys.stampCCVS(a, b, extra, r)` | V(a) − V(b) = r · I_branch(extra); returns new branch index |

Node 0 is always ground.

### Persistent state

For components that need memory (capacitors, inductors, 555, MCU):

```ts
const st = sim.state.__global ?? (sim.state.__global = {});
const key = `myComp_${a}_${b}`;
const prev = st[key] ?? initialValue;
// ...use prev...
st[key] = newValue;  // persists across simulation steps
```

`sim.state.__global` survives across steps within a session. Reset on "Reset" or load.

---

## Database Persistence

Circuits can be saved to a SQLite database (via Prisma) for cross-session persistence.

**Schema** (`prisma/schema.prisma`):
```prisma
model SavedCircuit {
  id          String   @id @default(cuid())
  name        String
  description String   @default("")
  document    String   // JSON-serialized CircuitDocument
  tags        String   @default("") // comma-separated
  isExample   Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

**API routes**:
- `GET /api/circuits` — list all saved circuits (without document body)
- `POST /api/circuits` — create a new saved circuit (body: `{name, description, document, tags}`)
- `GET /api/circuits/[id]` — get one circuit (with document)
- `PUT /api/circuits/[id]` — update circuit
- `DELETE /api/circuits/[id]` — delete circuit

**UI**: Click "My Circuits" in the toolbar to open the library dialog. Save the current circuit, load a previously saved one, or delete.

---

## SPICE Netlist Import

Import SPICE-style netlists (.cir / .net files) directly into the editor.

**Supported SPICE syntax**:

```
* comment
R<name> n+ n- <value>           ; resistor
C<name> n+ n- <value>           ; capacitor
L<name> n+ n- <value>           ; inductor
V<name> n+ n- DC <value>        ; DC voltage source
V<name> n+ n- SINE(<offset> <amp> <freq> [<phase>])
V<name> n+ n- PULSE(<v1> <v2> <td> <tr> <tf> <pw> <period>)
I<name> n+ n- DC <value>        ; DC current source
D<name> n+ n- <model>           ; diode
Q<name> nc nb ne [<model>]      ; BJT (auto-detect NPN/PNP from .model)
M<name> nd ng ns [<model>]      ; MOSFET (auto-detect NMOS/PMOS)
X<name> <pins...> <subckt>      ; sub-circuit call (flattened)
.subckt <name> <pins...>        ; sub-circuit definition
.ends [<name>]
.model <name> <type> <params>   ; e.g. .model QN NPN(Is=10f Bf=100)
.ic v(node)=value               ; initial condition
.tran <tstep> <tstop>           ; ignored (use simulator's own dt)
.end
```

**Value suffixes**: T/G/Meg/Meg/k/m/u/µ/n/p/f — case-insensitive except `Meg` (mega) vs `m` (milli).

**UI**: Click "SPICE" in the toolbar. Paste a netlist or drop a `.cir` file. Click "Import Netlist". The parser auto-layouts components and wires them based on shared SPICE nodes.

**API**: `POST /api/spice/import` with body `{ netlist: string }` returns `{ document: CircuitDocument }`.

**Programmatic use**:
```ts
import { parseSpiceNetlist } from '@/lib/circuit/spice';
const doc = parseSpiceNetlist(netlistString);
useEditor.getState().loadDocument(doc);
```

---

## Sub-Circuit Support

Convert any circuit into a reusable component. Sub-circuits appear in the palette under the "IC" category.

**Built-in sub-circuits** (registered at startup):
- **Diode AND** (`dland`) — Diode-resistor AND gate
- **Voltage Divider** (`vdiv`) — Configurable R1/R2 voltage divider

**Creating a sub-circuit via UI**:
1. Build a circuit on the canvas
2. Click "Sub-Circuit" in the toolbar
3. Enter a name and unique type id (e.g. `myAmp`)
4. Check the terminals you want to expose as pins
5. Click "Register Sub-Circuit"
6. The new component appears in the palette under "IC"

**Programmatic API**:
```ts
import { registerSubCircuit, type SubCircuitDefinition } from '@/lib/circuit/subcircuit';

const def: SubCircuitDefinition = {
  type: 'myAmp',
  name: 'My Amplifier',
  description: 'Custom amp',
  pins: [
    { id: 'in', label: 'IN', position: { x: 0, y: 1 } },
    { id: 'out', label: 'OUT', position: { x: 4, y: 1 } },
    { id: 'gnd', label: 'GND', position: { x: 2, y: 4 } },
  ],
  document: { version: 1, components: [...], wires: [...] },
  pinMap: [
    { pinId: 'in', componentId: 'r1', terminalId: 'a' },
    { pinId: 'out', componentId: 'op1', terminalId: 'out' },
    { pinId: 'gnd', componentId: 'gnd1', terminalId: 'g' },
  ],
  boundingBox: { width: 5, height: 4 },
  parameters: [
    { key: 'gain', label: 'Gain', default: 10, componentId: 'rf', paramKey: 'resistance' },
  ],
};
registerSubCircuit(def);
```

The sub-circuit's `stamp()` method expands the internal components into the parent MNA system, with pin nodes shared with the parent.

---

## Programmable Arduino Firmware

The `arduinoReal` plugin runs a tiny Arduino-like sketch language. The sketch is edited in the Properties panel when the Arduino is selected.

**Supported commands**:

```
// Comments start with //
pin D2 output          // declare pin (optional)
D2 = HIGH              // set D2 to VCC (5V)
D2 = LOW               // set D2 to 0V
D2 = 3.3               // set D2 to arbitrary voltage
D3 = A0                // copy A0 voltage to D3
wait 500ms             // delay 500ms (also: 1s, 100us)
wait 0.5s              // decimal values OK
loop:                  // label
if A0 > 2.5 goto on    // conditional jump (also: <, >=, <=, ==, !=)
goto loop              // unconditional jump
```

**Available pins**: D2, D3, D4, D5 (digital out), A0, A1 (analog in), 5V, GND.

**Sample sketches** (loadable from the Properties panel dropdown):
- `blink` — Classic 1Hz blink on D2
- `button` — Mirror A0 (threshold 2.5V) to D3
- `pwm_50` — Software PWM 50% on D3 at ~1kHz
- `counter` — 4-bit binary counter on D2-D5

**Programmatic API**:
```ts
import { compileArduinoSketch, executeFirmwareTick, sampleSketches } from '@/lib/circuit/components/arduino-real';

const { instructions, labels } = compileArduinoSketch(sourceCode);
// State persists in sim.state[key]
```

---

## Save / Load JSON Format

```json
{
  "version": 1,
  "components": [
    {
      "id": "comp_...",
      "type": "resistor",
      "position": {"x": 10, "y": 5},
      "rotation": 0,
      "parameters": {"resistance": 1000}
    }
  ],
  "wires": [
    {
      "id": "wire_...",
      "from": {"componentId": "comp_1", "terminalId": "a"},
      "to": {"componentId": "comp_2", "terminalId": "b"}
    }
  ]
}
```

- **Save**: Toolbar "Save" button downloads as `.json` file
- **Load**: Toolbar "Load" button uploads a `.json` file
- **Database**: "My Circuits" button persists to SQLite for cross-session storage
