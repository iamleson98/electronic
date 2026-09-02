// Native-dialog removal — regression tests.
//
// User report: "the app is now unusable, I can not click mouse on anything,
// nothing responds."
//
// Root cause class: native window.confirm / window.prompt / window.alert are
// main-thread-blocking browser modals. In embedded preview iframes they are
// either suppressed-but-blocking (page frozen, no visible dialog — clicks do
// nothing) or silently return false (buttons guarded by a confirm appear
// dead). The crash-recovery prompt on page load was the worst offender: a
// previous session that didn't shut down cleanly froze the whole app before
// the user could do anything.
//
// These tests pin the fix: every confirm goes through the in-app
// confirmDialog() store, and no native blocking dialogs remain in src/.

import { describe, it, expect } from 'vitest';
import { useConfirmStore, confirmDialog } from '../src/lib/confirm';

// ─────────────────────────────────────────────────────────────────────────────
// confirmDialog store behavior
// ─────────────────────────────────────────────────────────────────────────────
describe('confirmDialog store', () => {
  it('opens the dialog with sensible defaults and resolves true on answer(true)', async () => {
    const p = confirmDialog({ title: 'Test?' });
    const s = useConfirmStore.getState();
    expect(s.open).toBe(true);
    expect(s.title).toBe('Test?');
    expect(s.confirmLabel).toBe('Confirm');
    expect(s.cancelLabel).toBe('Cancel');
    expect(s.danger).toBe(false);
    s.answer(true);
    await expect(p).resolves.toBe(true);
    expect(useConfirmStore.getState().open).toBe(false);
    expect(useConfirmStore.getState().resolve).toBeNull();
  });

  it('resolves false when dismissed (answer(false))', async () => {
    const p = confirmDialog({ title: 'Cancel me' });
    useConfirmStore.getState().answer(false);
    await expect(p).resolves.toBe(false);
    expect(useConfirmStore.getState().open).toBe(false);
  });

  it('honors custom labels and the danger flag', async () => {
    const p = confirmDialog({
      title: 'Delete?',
      description: 'Permanent.',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep it',
      danger: true,
    });
    const s = useConfirmStore.getState();
    expect(s.confirmLabel).toBe('Delete');
    expect(s.cancelLabel).toBe('Keep it');
    expect(s.danger).toBe(true);
    expect(s.description).toBe('Permanent.');
    s.answer(false);
    await expect(p).resolves.toBe(false);
  });

  it('superseding a pending dialog resolves it with false (no dangling promise)', async () => {
    const first = confirmDialog({ title: 'First' });
    const second = confirmDialog({ title: 'Second' });
    await expect(first).resolves.toBe(false);
    expect(useConfirmStore.getState().title).toBe('Second');
    useConfirmStore.getState().answer(true);
    await expect(second).resolves.toBe(true);
  });

  it('answer after resolution is a no-op (double click / Esc race)', async () => {
    const p = confirmDialog({ title: 'Race' });
    useConfirmStore.getState().answer(true);
    await expect(p).resolves.toBe(true);
    // Simulate Radix firing onOpenChange(false) after the Action click.
    useConfirmStore.getState().answer(false);
    expect(useConfirmStore.getState().open).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source guards — no native blocking dialogs anywhere in src/
// ─────────────────────────────────────────────────────────────────────────────
describe('native dialog removal (source scan)', () => {
  const read = async (path: string) => {
    const fs = await import('fs/promises');
    return fs.readFile(path, 'utf-8');
  };

  const FILES_TO_SCAN = [
    './src/app/page.tsx',
    './src/components/circuit/Toolbar.tsx',
    './src/components/circuit/MyCircuitsDialog.tsx',
    './src/components/pcb/FootprintEditorDialog.tsx',
    './src/components/circuit/SymbolEditorDialog.tsx',
    './src/components/ai/ChatPanel.tsx',
    './src/components/circuit/CircuitCanvas.tsx',
    './src/components/pcb/PCBCanvas.tsx',
  ];

  it('no window.confirm / window.alert / window.prompt calls remain', async () => {
    for (const f of FILES_TO_SCAN) {
      const src = await read(f);
      expect(src, `${f} must not call native blocking dialogs`).not.toMatch(
        /window\.(confirm|alert|prompt)\s*\(/,
      );
    }
  });

  it('no bare confirm()/alert()/prompt() calls remain in converted files', async () => {
    for (const f of ['./src/components/circuit/Toolbar.tsx', './src/components/circuit/MyCircuitsDialog.tsx', './src/components/pcb/FootprintEditorDialog.tsx', './src/components/circuit/SymbolEditorDialog.tsx']) {
      const src = await read(f);
      expect(src, `${f} must use confirmDialog()`).not.toMatch(
        /(^|[^A-Za-z_.])(confirm|alert|prompt)\s*\(/,
      );
    }
  });

  it('page.tsx mounts the ConfirmDialogHost and uses confirmDialog for recovery', async () => {
    const src = await read('./src/app/page.tsx');
    expect(src).toContain('<ConfirmDialogHost />');
    expect(src).toContain('confirmDialog({');
    // Share fallback must degrade to a toast, never a native prompt.
    expect(src).toContain('toast.info(\'Share URL\'');
  });

  it('all five call sites route through the shared dialog', async () => {
    const checks: Array<[string, string]> = [
      ['./src/app/page.tsx', 'Recover unsaved work?'],
      ['./src/components/circuit/Toolbar.tsx', 'Clear the entire circuit?'],
      ['./src/components/circuit/MyCircuitsDialog.tsx', 'Delete circuit'],
      ['./src/components/pcb/FootprintEditorDialog.tsx', 'Discard current footprint?'],
      ['./src/components/circuit/SymbolEditorDialog.tsx', 'Discard current symbol?'],
    ];
    for (const [f, needle] of checks) {
      const src = await read(f);
      expect(src, `${f} should keep its prompt copy: ${needle}`).toContain(needle);
    }
  });
});
