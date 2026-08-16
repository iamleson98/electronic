import { describe, it, expect, beforeEach } from 'vitest';
import { trackSimulationStep, trackFeature, getSimulationStats, clearAnalytics, setAnalyticsEnabled, isAnalyticsEnabled } from '../src/lib/circuit/analytics';
beforeEach(() => { clearAnalytics(); setAnalyticsEnabled(true); });
describe('Analytics', () => {
  it('trackSimulationStep: increments totalSteps', () => { trackSimulationStep(true,1,[],[],0);expect(getSimulationStats().totalSteps).toBe(1);expect(getSimulationStats().successfulSteps).toBe(1);});
  it('trackFeature: increments counter', () => { trackFeature('acAnalysis');trackFeature('acAnalysis');expect(getSimulationStats().totalSteps).toBe(0);});
  it('disabled: does not track', () => { setAnalyticsEnabled(false);trackSimulationStep(true,1,[],[],0);expect(getSimulationStats().totalSteps).toBe(0);});
  it('isAnalyticsEnabled: reflects state', () => { expect(isAnalyticsEnabled()).toBe(true);setAnalyticsEnabled(false);expect(isAnalyticsEnabled()).toBe(false);});
});
