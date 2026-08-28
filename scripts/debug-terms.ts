import '../src/lib/circuit/components';
import { getPlugin } from '../src/lib/circuit/registry';
for (const t of ['dcMotor', 'stepperMotor', 'ssr', 'timer555', 'led', 'diode']) {
  console.log(t, '→', getPlugin(t)?.terminals.map((x: any) => x.id).join(','));
}
