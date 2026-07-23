import { getPlugin, getAllPlugins } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components';

const all = getAllPlugins();
console.log('Total plugins:', all.length);
console.log('Types:', all.map(p => p.type).join(', '));
console.log('arduinoReal exists:', !!getPlugin('arduinoReal'));
console.log('sevenSegment exists:', !!getPlugin('sevenSegment'));
console.log('nmos exists:', !!getPlugin('nmos'));
console.log('pnp exists:', !!getPlugin('pnp'));
console.log('opampRails exists:', !!getPlugin('opampRails'));
console.log('vdiv (sub-circuit) exists:', !!getPlugin('vdiv'));
