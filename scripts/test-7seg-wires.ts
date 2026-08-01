// Test: verify all wires in the 7-segment example connect to existing terminals.
// Previously, wires we1/wf1/wg1 referenced ard1.d6/d7/d8 which didn't exist.

import { exampleSevenSeg } from '../src/lib/circuit/examples';
import { getPlugin } from '../src/lib/circuit/registry';

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

  const doc = exampleSevenSeg;
  const compMap = new Map(doc.components.map(c => [c.id, c]));

  let allOk = true;
  console.log('Checking all wires connect to existing terminals...\n');
  for (const wire of doc.wires) {
    const fromComp = compMap.get(wire.from.componentId);
    const toComp = compMap.get(wire.to.componentId);
    if (!fromComp) {
      console.log(`✗ ${wire.id}: from component '${wire.from.componentId}' not found`);
      allOk = false;
      continue;
    }
    if (!toComp) {
      console.log(`✗ ${wire.id}: to component '${wire.to.componentId}' not found`);
      allOk = false;
      continue;
    }
    const fromPlugin = getPlugin(fromComp.type);
    const toPlugin = getPlugin(toComp.type);
    if (!fromPlugin) {
      console.log(`✗ ${wire.id}: from plugin '${fromComp.type}' not found`);
      allOk = false;
      continue;
    }
    if (!toPlugin) {
      console.log(`✗ ${wire.id}: to plugin '${toComp.type}' not found`);
      allOk = false;
      continue;
    }
    const fromTerm = fromPlugin.terminals.find(t => t.id === wire.from.terminalId);
    const toTerm = toPlugin.terminals.find(t => t.id === wire.to.terminalId);
    if (!fromTerm) {
      console.log(`✗ ${wire.id}: ${fromComp.id}.${wire.from.terminalId} — terminal '${wire.from.terminalId}' does not exist on ${fromComp.type} (available: ${fromPlugin.terminals.map(t => t.id).join(', ')})`);
      allOk = false;
      continue;
    }
    if (!toTerm) {
      console.log(`✗ ${wire.id}: ${toComp.id}.${wire.to.terminalId} — terminal '${wire.to.terminalId}' does not exist on ${toComp.type} (available: ${toPlugin.terminals.map(t => t.id).join(', ')})`);
      allOk = false;
      continue;
    }
    // Compute world positions
    const fromX = fromComp.position.x + fromTerm.position.x;
    const fromY = fromComp.position.y + fromTerm.position.y;
    const toX = toComp.position.x + toTerm.position.x;
    const toY = toComp.position.y + toTerm.position.y;
    console.log(`✓ ${wire.id}: ${fromComp.id}.${wire.from.terminalId} (${fromX},${fromY}) → ${toComp.id}.${wire.to.terminalId} (${toX},${toY})`);
  }

  console.log('\n=== Summary ===');
  if (allOk) {
    console.log('✓ All wires connect to existing terminals.');
  } else {
    console.log('✗ Some wires have missing terminals!');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
