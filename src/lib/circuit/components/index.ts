// Import this module once to register all built-in plugins.
// To add a new component, either add it here or call `registerPlugin` yourself.

import './passive';
import './sources';
import './semiconductors';
import './advanced';
import './extra';
import './arduino-real';
import './power-symbols';
import './kicad-parity';
import { registerBuiltinSubCircuits } from '../subcircuit';

// Register built-in sub-circuits (voltage divider, diode-DL AND gate, etc.)
registerBuiltinSubCircuits();

export { registerPlugin, getPlugin, getAllPlugins, getPluginsByCategory, hasPlugin } from '../registry';
export type { ComponentPlugin } from '../types';
