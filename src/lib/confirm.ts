import { create } from 'zustand';

// Non-blocking confirm dialog state.
//
// WHY THIS EXISTS: the app previously used native window.confirm / alert /
// prompt in several places. Native dialogs are main-thread-blocking,
// browser-chrome-rendered modals. In embedded contexts (preview iframes,
// sandboxed frames) they misbehave in the worst possible ways:
//
//   - Without the `allow-modals` sandbox flag, confirm() is SUPPRESSED but
//     the page can still stall, or the call silently returns `false` —
//     buttons guarded by a confirm ("Clear circuit?", "Delete circuit?")
//     appear completely dead: the user clicks, nothing happens.
//   - With modals allowed in a cross-origin iframe, the dialog may render
//     detached from the visible window — the whole page freezes with no
//     visible prompt: "I can not click anything, nothing responds."
//
// The store below backs an in-app AlertDialog (see
// components/ui/ConfirmDialogHost.tsx) that is always visible, always
// dismissible (Esc / Cancel / click) and never blocks the event loop.
//
// Usage:
//   import { confirmDialog } from '@/lib/confirm';
//   const ok = await confirmDialog({ title: 'Clear circuit?', danger: true });
//   if (ok) clear();
//
// Mount <ConfirmDialogHost /> once at the page root (page.tsx).

export interface ConfirmOptions {
  /** Bold heading, e.g. "Clear the entire circuit?" */
  title: string;
  /** Supporting text shown under the title. */
  description?: string;
  /** Label for the affirmative button. Default: "Confirm". */
  confirmLabel?: string;
  /** Label for the dismissive button. Default: "Cancel". */
  cancelLabel?: string;
  /** Render the affirmative button in the destructive (red) style. */
  danger?: boolean;
}

interface ConfirmState extends Required<Omit<ConfirmOptions, 'description'>> {
  open: boolean;
  description: string | undefined;
  /** Resolves the pending confirmDialog() promise. */
  resolve: ((ok: boolean) => void) | null;
  /** Called by the host when the dialog is answered or dismissed. */
  answer: (ok: boolean) => void;
}

const emptyOptions: Required<Omit<ConfirmOptions, 'description'>> = {
  title: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  danger: false,
};

export const useConfirmStore = create<ConfirmState>(() => ({
  ...emptyOptions,
  open: false,
  description: undefined,
  resolve: null,
  answer: (ok: boolean) => {
    const { resolve } = useConfirmStore.getState();
    if (resolve) {
      useConfirmStore.setState({ open: false, resolve: null });
      resolve(ok);
    } else {
      useConfirmStore.setState({ open: false });
    }
  },
}));

/**
 * Open the shared confirm dialog and resolve when the user answers.
 * Never blocks; safe to call from event handlers and effects.
 * If a dialog is already open, the pending one resolves with `false`.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // Supersede any pending dialog so no promise dangles forever.
    const pending = useConfirmStore.getState().resolve;
    if (pending) {
      useConfirmStore.setState({ open: false, resolve: null });
      pending(false);
    }
    useConfirmStore.setState({
      ...emptyOptions,
      ...opts,
      description: opts.description,
      confirmLabel: opts.confirmLabel ?? emptyOptions.confirmLabel,
      cancelLabel: opts.cancelLabel ?? emptyOptions.cancelLabel,
      danger: opts.danger ?? false,
      open: true,
      resolve,
    });
  });
}
