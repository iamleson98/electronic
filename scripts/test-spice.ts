// Test the SPICE parser with various netlists
import { parseSpiceNetlist } from '../src/lib/circuit/spice';
import '../src/lib/circuit/components';

const tests = [
  {
    name: 'RC low-pass',
    netlist: `* RC low-pass filter
V1 in 0 SINE(0 5 100)
R1 in out 1k
C1 out 0 1u`,
  },
  {
    name: 'Voltage divider',
    netlist: `* Voltage divider
V1 in 0 DC 5
R1 in mid 1k
R2 mid 0 1k`,
  },
  {
    name: 'LED with resistor',
    netlist: `* LED circuit
V1 1 0 DC 5
R1 1 2 330
D1 2 0 DMOD
.model DMOD D(Is=10f N=1)`,
  },
  {
    name: 'NPN transistor switch',
    netlist: `* NPN switch
Vcc 1 0 DC 5
Vb 2 0 DC 5
Rb 2 3 10k
Rc 1 4 1k
Q1 4 3 0 QN
.model QN NPN(Is=10f Bf=100)`,
  },
  {
    name: 'Sub-circuit (full-wave rectifier)',
    netlist: `* Full-wave rectifier using sub-circuit
V1 in 0 SINE(0 5 50)
X1 in out RECT
C1 out 0 100u
.subckt RECT a b
D1 a b DMOD
D2 b a DMOD
.ends
.model DMOD D(Is=10f)`,
  },
  {
    name: 'Initial conditions',
    netlist: `* Cap with initial voltage
V1 in 0 DC 5
R1 in out 1k
C1 out 0 1u
.ic V(out)=2.5`,
  },
];

let passed = 0;
let failed = 0;
for (const test of tests) {
  try {
    const doc = parseSpiceNetlist(test.netlist);
    console.log(`✓ ${test.name}: ${doc.components.length} components, ${doc.wires.length} wires`);
    passed++;
  } catch (err) {
    console.error(`✗ ${test.name}: ${(err as Error).message}`);
    failed++;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
process.exit(failed > 0 ? 1 : 0);
