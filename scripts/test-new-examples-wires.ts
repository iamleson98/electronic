// Test: verify all wires connect to existing terminals for the new examples.
import { getPlugin } from '../src/lib/circuit/registry';
import {
  exampleRLHighPass, exampleDiodeRectifier, exampleVoltageDivider,
  examplePnpSwitch, exampleCurrentSource, exampleSpeaker,
  examplePhotoresistor, exampleLogicGates, exampleOpampNonInverting, exampleVCO,
} from '../src/lib/circuit/examples';

async function main() {
  await import('../src/lib/circuit/components/sources');
  await import('../src/lib/circuit/components/semiconductors');
  await import('../src/lib/circuit/components/extra');
  await import('../src/lib/circuit/components/advanced-semi');
  await import('../src/lib/circuit/components/passive');
  await import('../src/lib/circuit/components/advanced');
  await import('../src/lib/circuit/components/advanced-devices');
  await import('../src/lib/circuit/components/arduino-real');
  await import('../src/lib/circuit/components/kicad-parity');
  await import('../src/lib/circuit/components/power-symbols');

  const examples = [
    { name: 'RL High-pass Filter', doc: exampleRLHighPass },
    { name: 'Diode Rectifier', doc: exampleDiodeRectifier },
    { name: 'Voltage Divider', doc: exampleVoltageDivider },
    { name: 'PNP Switch', doc: examplePnpSwitch },
    { name: 'Current Source', doc: exampleCurrentSource },
    { name: 'Speaker Driver', doc: exampleSpeaker },
    { name: 'Photoresistor Light Sensor', doc: examplePhotoresistor },
    { name: 'AND Gate', doc: exampleLogicGates },
    { name: 'Op-Amp Non-inverting', doc: exampleOpampNonInverting },
    { name: 'VCO Frequency Sweep', doc: exampleVCO },
  ];

  let allOk = true;
  console.log('=== Wire Connectivity Test ===\n');
  for (const ex of examples) {
    let ok = true;
    for (const wire of ex.doc.wires) {
      const fromComp = ex.doc.components.find(c => c.id === wire.from.componentId);
      const toComp = ex.doc.components.find(c => c.id === wire.to.componentId);
      if (!fromComp || !toComp) { ok = false; continue; }
      const fromPlugin = getPlugin(fromComp.type);
      const toPlugin = getPlugin(toComp.type);
      if (!fromPlugin || !toPlugin) { ok = false; continue; }
      const fromTerm = fromPlugin.terminals.find(t => t.id === wire.from.terminalId);
      const toTerm = toPlugin.terminals.find(t => t.id === wire.to.terminalId);
      if (!fromTerm || !toTerm) {
        console.log(`  ✗ ${ex.name}: ${wire.id} — missing terminal`);
        ok = false;
      }
    }
    console.log(`  ${ok ? '✓' : '✗'} ${ex.name} — ${ex.doc.wires.length} wires`);
    if (!ok) allOk = false;
  }
  console.log(`\n${allOk ? '✓ All wires connected' : '✗ Some wires missing'}`);
  if (!allOk) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
