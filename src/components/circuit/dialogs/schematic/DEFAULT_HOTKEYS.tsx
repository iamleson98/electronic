'use client';

// KiCad-parity schematic dialogs:
//   - FindReplaceDialog
//   - ViolationsBrowserDialog
//   - NetInspectorDialog
//   - SymbolEditorDialog (basic)
//   - PageSetupDialog
//   - SavedViewsDialog
//   - HierarchicalSheetsDialog



// ─────────────────────────────────────────────────────────────────────────────
// Find/Replace dialog — KiCad Ctrl+F
// ─────────────────────────────────────────────────────────────────────────────


export const DEFAULT_HOTKEYS: Record<string, string> = {
  'rotate': 'r',
  'rotate_free': 'Shift+R',
  'delete': 'Delete',
  'mirror_x': 'x',
  'mirror_y': 'y',
  'lock': 'l',
  'demorgan': 'm',
  'undo': 'Ctrl+Z',
  'redo': 'Ctrl+Y',
  'copy': 'Ctrl+C',
  'paste': 'Ctrl+V',
  'duplicate': 'Ctrl+D',
  'select_all': 'Ctrl+A',
  'run_pause': ' ',
  'find': 'Ctrl+F',
  'escape': 'Escape',
};
