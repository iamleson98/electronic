'use client';

// ConfirmDialogHost — the single mounted instance that renders the shared
// confirm dialog (state in lib/confirm.ts). Never import this per-call-site;
// call-sites only use confirmDialog().

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { useConfirmStore } from '@/lib/confirm';
import { cn } from '@/lib/utils';

export function ConfirmDialogHost() {
  const open = useConfirmStore((s) => s.open);
  const title = useConfirmStore((s) => s.title);
  const description = useConfirmStore((s) => s.description);
  const confirmLabel = useConfirmStore((s) => s.confirmLabel);
  const cancelLabel = useConfirmStore((s) => s.cancelLabel);
  const danger = useConfirmStore((s) => s.danger);
  const answer = useConfirmStore((s) => s.answer);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        // Esc key / programmatic close = dismiss = cancel.
        if (!o) answer(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription className="whitespace-pre-line">
              {description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(false)}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(danger && buttonVariants({ variant: 'destructive' }))}
            onClick={() => answer(true)}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
