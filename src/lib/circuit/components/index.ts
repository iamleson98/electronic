// Import this module once to register all built-in plugins.
// To add a new component, either add it here or call `registerPlugin` yourself.

import './passive';
import './sources';
import './semiconductors';
import './advanced';

export { registerPlugin, getPlugin, getAllPlugins, getPluginsByCategory, hasPlugin } from '../registry';
export type { ComponentPlugin } from '../types';
