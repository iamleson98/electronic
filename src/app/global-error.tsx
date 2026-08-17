// Global error boundary — catches errors that escape route-level boundaries.
'use client';

import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <div style={{
          display: 'flex',
          height: '100vh',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
          backgroundColor: '#020617',
          color: '#f1f5f9',
          fontFamily: 'system-ui, sans-serif',
        }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>
            Application Error
          </h1>
          <p style={{ color: '#94a3b8', maxWidth: '400px', textAlign: 'center' }}>
            A critical error occurred that could not be recovered. Please reload
            the page.
          </p>
          <p style={{ fontSize: '12px', color: '#475569', fontFamily: 'monospace' }}>
            {error.message}
            {error.digest ? ` (ID: ${error.digest})` : ''}
          </p>
          <Button onClick={() => window.location.reload()} variant="default">
            Reload page
          </Button>
        </div>
      </body>
    </html>
  );
}
