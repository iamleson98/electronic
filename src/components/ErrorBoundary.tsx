'use client';

import React, { Component, ErrorInfo } from 'react';
import { reportError as reportErrorToMonitor } from '@/lib/error-monitoring';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

interface ErrorBoundaryProps {
  name?: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error(`[ErrorBoundary${this.props.name ? `: ${this.props.name}` : ''}]`, error, errorInfo);

    // Wire to the real error monitoring module (previously was a no-op).
    try {
      reportErrorToMonitor(error, errorInfo);
    } catch {
      // error-monitoring may not be initialized — ignore.
    }
  }

  reset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  copyError = () => {
    const { error, errorInfo } = this.state;
    const text = `Error: ${error?.message}\nStack: ${error?.stack}\nComponentStack: ${errorInfo?.componentStack}`;
    navigator.clipboard.writeText(text).then(() => {
      // Simple feedback — no toast dependency here.
    });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    const { error, errorInfo } = this.state;
    const name = this.props.name ?? 'Component';

    return (
      <div className="flex min-h-50 flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-lg font-semibold text-rose-400">{name} crashed</div>
        <div className="max-w-lg rounded-lg border border-rose-900/50 bg-rose-950/20 p-3 text-left text-xs">
          <div className="mb-1 font-mono text-rose-300">{error?.message ?? 'Unknown error'}</div>
          {error?.stack && (
            <details className="mt-2">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200">Stack trace</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-slate-500">{error.stack}</pre>
            </details>
          )}
          {errorInfo?.componentStack && (
            <details className="mt-2">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200">Component stack</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-slate-500">{errorInfo.componentStack}</pre>
            </details>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={this.reset}
            className="cursor-pointer rounded-md bg-slate-700 px-4 py-2 text-sm text-slate-100 hover:bg-slate-600"
          >
            Try again
          </button>
          <button
            onClick={this.copyError}
            className="cursor-pointer rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            Copy error
          </button>
          <button
            onClick={() => window.location.reload()}
            className="cursor-pointer rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}

export function withErrorBoundary<P extends object>(Component: React.ComponentType<P>, options: { name?: string }) {
  const Wrapped = (props: P) => (
    <ErrorBoundary name={options.name}>
      <Component {...props} />
    </ErrorBoundary>
  );
  Wrapped.displayName = `withErrorBoundary(${Component.displayName || Component.name || 'Component'})`;
  return Wrapped;
}

/**
 * Report an error to the error monitoring system.
 * Previously this was a no-op — now it calls the real error-monitoring module.
 */
export function reportError(error: Error, errorInfo?: unknown): void {
  console.error('[ErrorBoundary] Reported error:', error, errorInfo);
  try {
    reportErrorToMonitor(error, errorInfo);
  } catch {
    // error-monitoring may not be initialized — ignore.
  }
}
