import { describe, it, expect } from 'vitest';
import { KEYBOARD_SHORTCUTS, getShortcutsByCategory, formatShortcut } from '../src/lib/circuit/keyboard-shortcuts';
describe('Keyboard shortcuts', () => {
  it('has shortcuts in all categories', () => { expect(getShortcutsByCategory('editing').length).toBeGreaterThan(0);expect(getShortcutsByCategory('history').length).toBeGreaterThan(0);expect(getShortcutsByCategory('simulation').length).toBeGreaterThan(0);});
  it('formatShortcut: Mac symbols', () => { expect(formatShortcut('Ctrl+Z',true)).toContain('⌘');});
  it('formatShortcut: Windows unchanged', () => { expect(formatShortcut('Ctrl+Z',false)).toBe('Ctrl+Z');});
});
