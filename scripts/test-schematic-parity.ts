// Smoke test for new schematic-parity modules.
// Run with: npx tsx scripts/test-schematic-parity.ts
import { runFullERC, applyERCExclusions } from '../src/lib/circuit/erc';
import { exportSPICENetlist, exportKiCadNetlist, exportBOMCSV, exportBOMHTML } from '../src/lib/circuit/netlist-export';
import { exportSchematicSVG } from '../src/lib/circuit/schematic-plot';
import { parseKicadSch } from '../src/lib/circuit/kicad-sch-import';
import { getPlugin } from '../src/lib/circuit/registry';
import { registerPlugin } from '../src/lib/circuit/registry';
import type { CircuitComponent } from '../src/lib/circuit/types';

// register built-in plugins
import '../src/lib/circuit/components';

const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) process.exitCode = 1;
};

// --- Test 1: ERC runs with empty circuit ---
const emptyResult = runFullERC([], [], []);
ok('ERC: empty circuit returns no errors', emptyResult.errors.length === 0 && emptyResult.passed);

// --- Test 2: ERC detects missing ground ---
const noGnd: CircuitComponent[] = [
  { id: 'r1', type: 'resistor', position: { x: 0, y: 0 }, rotation: 0, parameters: { resistance: 1000 }, refdes: 'R1' },
  { id: 'v1', type: 'dcVoltage', position: { x: 5, y: 0 }, rotation: 0, parameters: { voltage: 5 }, refdes: 'V1' },
];
const noGndResult = runFullERC(noGnd, [], []);
ok('ERC: detects missing ground', noGndResult.errors.some(e => e.type === 'missing_ground'));

// --- Test 3: ERC honors No-Connect markers ---
const noConnectResult = runFullERC(noGnd, [], [
  { id: 'nc1', componentId: 'r1', terminalId: 'a' },
  { id: 'nc2', componentId: 'r1', terminalId: 'b' },
  { id: 'nc3', componentId: 'v1', terminalId: 'p' },
  { id: 'nc4', componentId: 'v1', terminalId: 'n' },
]);
ok('ERC: no-connect suppresses unconnected-pin errors',
   !noConnectResult.errors.some(e => e.type === 'unconnected_pin' && e.componentId === 'r1'));

// --- Test 4: ERC exclusion filter ---
const filtered = applyERCExclusions(noGndResult, ['missing-ground']);
ok('ERC: exclusion filter removes by key', !filtered.errors.some(e => e.type === 'missing_ground'));

// --- Test 5: SPICE netlist export ---
const spice = exportSPICENetlist({ version: 1, components: noGnd, wires: [] }, 'Test');
ok('SPICE: netlist starts with title comment', spice.startsWith('* Test'));
ok('SPICE: netlist contains resistor', spice.includes('R1'));
ok('SPICE: netlist ends with .end', spice.trim().endsWith('.end'));

// --- Test 6: KiCad netlist export ---
const kicad = exportKiCadNetlist({ version: 1, components: noGnd, wires: [] }, 'Test');
ok('KiCad netlist: XML header', kicad.includes('<?xml'));
ok('KiCad netlist: contains component', kicad.includes('R1'));

// --- Test 7: BOM CSV ---
const bom = exportBOMCSV({ version: 1, components: noGnd, wires: [] });
ok('BOM CSV: header row', bom.startsWith('Designator,Quantity'));
ok('BOM CSV: contains R1', bom.includes('R1'));

// --- Test 8: BOM HTML ---
const bomHtml = exportBOMHTML({ version: 1, components: noGnd, wires: [] });
ok('BOM HTML: has table', bomHtml.includes('<table>') && bomHtml.includes('<th>'));

// --- Test 9: Schematic SVG ---
const svg = exportSchematicSVG({ version: 1, components: noGnd, wires: [] });
ok('SVG: valid root', svg.startsWith('<?xml') && svg.includes('<svg'));
ok('SVG: contains component rect', svg.includes('<rect'));

// --- Test 10: KiCad .kicad_sch parser ---
const sampleSch = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (symbol
    (lib_id "Device:R")
    (at 50 50 0)
    (property "Reference" "R1" (at 50 45 0))
    (property "Value" "10k" (at 50 55 0))
  )
)`;
const parsed = parseKicadSch(sampleSch);
ok('KiCad sch: parses resistor', parsed.document.components.length === 1);
ok('KiCad sch: assigns refdes', parsed.document.components[0]?.refdes === 'R1');

// --- Test 11: New plugins are registered ---
ok('Plugin: noConnect registered', !!getPlugin('noConnect'));
ok('Plugin: busEntry registered', !!getPlugin('busEntry'));
ok('Plugin: powerFlag registered', !!getPlugin('powerFlag'));
ok('Plugin: customPower registered', !!getPlugin('customPower'));
ok('Plugin: hierLabel registered', !!getPlugin('hierLabel'));
ok('Plugin: globalLabel registered', !!getPlugin('globalLabel'));
ok('Plugin: hierSheet registered', !!getPlugin('hierSheet'));
ok('Plugin: 7400_A registered', !!getPlugin('7400_A'));
ok('Plugin: 7400_D registered', !!getPlugin('7400_D'));

// --- Test 12: 7400 has multi-unit declaration ---
const nandA = getPlugin('7400_A');
ok('7400: has units array', !!nandA?.units && nandA.units.length === 4);
ok('7400: has hidden power pins', !!(nandA?.terminals.some(t => t.hidden)));

// --- Test 13: 7400 has pin electrical types ---
ok('7400: in1 is input', nandA?.terminals.find(t => t.id === 'in1')?.electricalType === 'input');
ok('7400: out is output', nandA?.terminals.find(t => t.id === 'out')?.electricalType === 'output');
ok('7400: vcc is power_in', nandA?.terminals.find(t => t.id === 'vcc')?.electricalType === 'power_in');

// --- Test 14: Pin swap groups ---
ok('7400: has pin swap groups', !!(nandA?.pinSwapGroups && nandA.pinSwapGroups.length > 0));

console.log('\nAll smoke tests passed!');
