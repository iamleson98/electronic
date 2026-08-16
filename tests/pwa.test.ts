import { describe, it, expect } from 'vitest';
import { registerServiceWorker, useOfflineStatus, canInstall, isStandalone } from '../src/lib/pwa';
describe('PWA', () => {
  it('registerServiceWorker: returns promise', () => { expect(registerServiceWorker()).toBeInstanceOf(Promise);});
  it('useOfflineStatus: returns object', () => { const r=useOfflineStatus();expect(r).toHaveProperty('isOnline');});
  it('canInstall: returns false in Node', () => { expect(canInstall()).toBe(false);});
  it('isStandalone: returns false in Node', () => { expect(isStandalone()).toBe(false);});
});
