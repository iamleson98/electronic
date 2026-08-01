// Quick check: are all plugins registered?
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

  for (const t of ['dcVoltage', 'resistor', 'led', 'npn', 'pnp', 'nmos', 'pushButton', 'ground']) {
    const p = getPlugin(t);
    console.log(t, p ? 'LOADED' : 'MISSING', p ? `stamp=${typeof p.stamp} step=${typeof p.step}` : '');
  }
}
main();
