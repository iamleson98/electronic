import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

const types = ['resistor', 'capacitor', 'inductor', 'led', 'diode', 'dcVoltage', 'switch', 'pushButton', 'npn', 'nmos', 'pmos', 'pnp'];
for (const t of types) {
  const p = getPlugin(t);
  console.log(t, 'getFlowPath:', typeof p?.getFlowPath);
}
