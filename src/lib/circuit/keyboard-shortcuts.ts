// Consolidated keyboard shortcuts — single source of truth.
// Used by use-canvas-keyboard.ts (the real handler) and HelpDialog (display).
//
// Previously there were 3 separate sources:
// 1. keyboard-shortcuts.ts (incomplete, never imported)
// 2. use-canvas-keyboard.ts (real handler, ~25 shortcuts)
// 3. HelpDialog.tsx (hardcoded display list, 12 entries)
//
// This file replaces #1 with a complete, accurate list matching #2.

export interface KeyboardShortcut {
  key: string;
  description: string;
  category: 'editing' | 'history' | 'simulation' | 'tools' | 'view' | 'ai';
  implemented: boolean;
}

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  // Editing
  { key: 'Delete', description: 'Delete selected component or wire', category: 'editing', implemented: true },
  { key: 'R', description: 'Rotate selected component 90°', category: 'editing', implemented: true },
  { key: 'M', description: 'Mirror selected component', category: 'editing', implemented: true },
  { key: 'Ctrl+C', description: 'Copy selection', category: 'editing', implemented: true },
  { key: 'Ctrl+V', description: 'Paste', category: 'editing', implemented: true },
  { key: 'Ctrl+D', description: 'Duplicate selection', category: 'editing', implemented: true },
  { key: 'Ctrl+A', description: 'Select all', category: 'editing', implemented: true },
  { key: 'Esc', description: 'Cancel wire / deselect', category: 'editing', implemented: true },
  { key: 'Double-click', description: 'Rotate component on double-click', category: 'editing', implemented: true },

  // Accessibility (keyboard-only operation)
  { key: 'Tab / Shift+Tab', description: 'Cycle keyboard focus between components and wires', category: 'editing', implemented: true },
  { key: 'Arrows (placing)', description: 'Move placement ghost (Shift = 5 cells)', category: 'editing', implemented: true },
  { key: 'Enter (placing)', description: 'Place component at ghost position (Shift+Enter = place and repeat)', category: 'editing', implemented: true },
  { key: 'R (placing)', description: 'Rotate placement ghost', category: 'editing', implemented: true },
  { key: 'Esc (placing)', description: 'Cancel placement', category: 'editing', implemented: true },

  // History
  { key: 'Ctrl+Z', description: 'Undo', category: 'history', implemented: true },
  { key: 'Ctrl+Shift+Z', description: 'Redo', category: 'history', implemented: true },
  { key: 'Ctrl+Y', description: 'Redo (alternative)', category: 'history', implemented: true },

  // Simulation
  { key: 'Space', description: 'Play/Pause simulation', category: 'simulation', implemented: true },
  { key: 'S', description: 'Step simulation once', category: 'simulation', implemented: true },
  { key: 'Ctrl+R', description: 'Reset simulation', category: 'simulation', implemented: true },

  // Tools
  { key: 'W', description: 'Wire mode (start drawing wires)', category: 'tools', implemented: true },
  { key: 'Shift', description: 'Hold for multi-select', category: 'tools', implemented: true },

  // View
  { key: 'Ctrl+K', description: 'Open Command Palette', category: 'view', implemented: true },
  { key: '?', description: 'Open Help dialog', category: 'view', implemented: true },
  { key: 'Ctrl++', description: 'Zoom in', category: 'view', implemented: true },
  { key: 'Ctrl+-', description: 'Zoom out', category: 'view', implemented: true },
  { key: '0', description: 'Reset zoom', category: 'view', implemented: true },

  // AI
  { key: 'Ctrl+J', description: 'Toggle AI Assistant panel', category: 'ai', implemented: true },
];

export function getShortcutsByCategory(category: string): KeyboardShortcut[] {
  return KEYBOARD_SHORTCUTS.filter(s => s.category === category);
}

export function formatShortcut(key: string, mac: boolean = false): string {
  if (mac) return key.replace(/Ctrl/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥');
  return key;
}

export function getAllCategories(): string[] {
  return ['editing', 'history', 'simulation', 'tools', 'view', 'ai'];
}
