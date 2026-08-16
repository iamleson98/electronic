let _config: any = { dsn: undefined, environment: 'development', maxBreadcrumbs: 50 };
let _breadcrumbs: any[] = [];
let _initialized = false;
let _sentry: any = null;

export async function initErrorMonitoring(userConfig: any = {}): Promise<void> {
  if (_initialized) return;
  _initialized = true;
  _config = { ..._config, ...userConfig };
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e: ErrorEvent) => { captureError((e as any).error ?? new Error((e as any).message)); });
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => { const r = e.reason; captureError(r instanceof Error ? r : new Error(String(r))); });
  }
  if (_config.dsn) { try { _sentry = await import('@sentry/browser').catch(() => null); if (_sentry) _sentry.init({ dsn: _config.dsn }); } catch {} }
}
export function shutdownErrorMonitoring(): void {
  if (typeof window !== 'undefined') { /* remove listeners would go here */ }
  _breadcrumbs = []; _sentry = null; _initialized = false;
  _config = { dsn: undefined, environment: 'development', maxBreadcrumbs: 50 };
}
export function captureError(error: Error | string, context?: any): string {
  const msg = error instanceof Error ? error.message : String(error);
  addBreadcrumb({ type: 'error', level: 'error', message: msg });
  if (_sentry) { try { _sentry.captureException(error instanceof Error ? error : new Error(String(error))); } catch {} }
  if (_config.dsn) { try { _sentry.captureException(error instanceof Error ? error : new Error(String(error))); } catch {} }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return id;
}
export function captureMessage(message: string, level: string = 'info'): string {
  if (_sentry) { try { _sentry.captureMessage(message, level); } catch {} }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
export function addBreadcrumb(crumb: any): void { _breadcrumbs.push({ ...crumb, timestamp: Date.now() }); if (_breadcrumbs.length > (_config.maxBreadcrumbs ?? 50)) _breadcrumbs = _breadcrumbs.slice(-(_config.maxBreadcrumbs ?? 50)); }
export function getBreadcrumbs(): any[] { return [..._breadcrumbs]; }
export function clearBreadcrumbs(): void { _breadcrumbs = []; }
export function setTag(key: string, value: string): void { /* no-op */ }
export function setExtra(key: string, value: any): void { /* no-op */ }
export function isMonitoringEnabled(): boolean { return _initialized && _sentry !== null; }
export function getMonitoringConfig(): any { return { ..._config }; }
export function reportError(error: Error, errorInfo: any): void { captureError(error); }
