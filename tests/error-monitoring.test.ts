import { describe, it, expect, beforeEach } from 'vitest';
import { initErrorMonitoring, captureError, captureMessage, addBreadcrumb, isMonitoringEnabled, shutdownErrorMonitoring } from '../src/lib/error-monitoring';
beforeEach(() => { shutdownErrorMonitoring(); });
describe('Error monitoring', () => {
  it('init: does not crash without DSN', async () => { await expect(initErrorMonitoring({})).resolves.not.toThrow();});
  it('captureError: returns event ID', async () => { await initErrorMonitoring({});const id=captureError(new Error('Test'));expect(typeof id).toBe('string');});
  it('captureMessage: returns event ID', async () => { await initErrorMonitoring({});const id=captureMessage('Test','info');expect(typeof id).toBe('string');});
  it('addBreadcrumb: does not crash', () => { addBreadcrumb({type:'click',level:'info',message:'test'});});
  it('isMonitoringEnabled: false without DSN', async () => { await initErrorMonitoring({});expect(isMonitoringEnabled()).toBe(false);});
});
