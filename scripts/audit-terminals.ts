// Quick audit: print terminal positions for each component type used in examples
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

const types = [
  'dcVoltage', 'acVoltage', 'pulseSource', 'currentSource',
  'resistor', 'capacitor', 'inductor', 'ground',
  'led', 'diode', 'pushButton', 'switch',
  'npn', 'nmos', 'opamp', 'timer555',
  'oscilloscope', 'voltmeter', 'ammeter',
  'arduino', 'arduinoReal', 'sevenSegment',
];

for (const t of types) {
  const p = getPlugin(t);
  if (!p) { console.log(t, 'NOT FOUND'); continue; }
  const terms = p.terminals.map(t => `${t.id}@(${t.position.x},${t.position.y})`).join(', ');
  console.log(`${t}: bb=${p.boundingBox.width}x${p.boundingBox.height}  terminals: ${terms}`);
}
