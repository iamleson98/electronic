// Route-level error boundary — catches unhandled errors in React render.
'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Error Boundary]', error);
  }, [error]);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-950 text-slate-100">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="text-slate-400 max-w-md text-center">
        An unexpected error occurred in the circuit simulator. Your work has been
        preserved in the browser state.
      </p>
      <p className="text-xs text-slate-600 font-mono">
        {error.message}
        {error.digest ? ` (ID: ${error.digest})` : ''}
      </p>
      <div className="flex gap-2">
        <Button onClick={reset} variant="default">
          Try again
        </Button>
        <Button
          onClick={() => window.location.reload()}
          variant="ghost"
        >
          Reload page
        </Button>
      </div>
    </div>
  );
}
