export function trackSimulationStep(success: boolean, stepTimeMs: number, components: any[], wires: any[], nodeCount: number, errorMessage?: string): void { if (!_enabled) return; _stats.totalSteps++; if (success) _stats.successfulSteps++; else { _stats.failedSteps++; } }
export function trackFeature(feature: string): void { if (!_enabled) return; (_features as any)[feature] = ((_features as any)[feature] ?? 0) + 1; }
export function getSimulationStats(): any { return { ..._stats, errorCounts: { ..._stats.errorCounts } }; }
export function getSessionDuration(): number { return Math.floor((Date.now() - _start) / 1000); }
export function getSuccessRate(): number { return _stats.totalSteps === 0 ? 0 : _stats.successfulSteps / _stats.totalSteps; }
export function getAverageStepTime(): number { return _stats.totalSteps === 0 ? 0 : _stats.totalStepTimeMs / _stats.totalSteps; }
export function clearAnalytics(): void { _stats = { totalSteps: 0, successfulSteps: 0, failedSteps: 0, totalStepTimeMs: 0, circuitCount: 0, totalComponents: 0, totalWires: 0, totalNodes: 0, errorCounts: {} }; _features = { acAnalysis: 0, gerberExport: 0, bomExport: 0, drcCheck: 0, aiMessages: 0, exampleLoaded: 0, manualSave: 0, undoCount: 0, redoCount: 0, spiceExport: 0 }; }
export function setAnalyticsEnabled(enabled: boolean): void { _enabled = enabled; }
export function isAnalyticsEnabled(): boolean { return _enabled; }
let _enabled = true;
const _start = Date.now();
let _stats = { totalSteps: 0, successfulSteps: 0, failedSteps: 0, totalStepTimeMs: 0, circuitCount: 0, totalComponents: 0, totalWires: 0, totalNodes: 0, errorCounts: {} as Record<string, number> };
let _features = { acAnalysis: 0, gerberExport: 0, bomExport: 0, drcCheck: 0, aiMessages: 0, exampleLoaded: 0, manualSave: 0, undoCount: 0, redoCount: 0, spiceExport: 0 };
