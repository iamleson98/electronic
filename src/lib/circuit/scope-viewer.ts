export interface ScopeSample { time: number; voltage: number; }
export interface ScopeChannel { id: string; label: string; color: string; samples: ScopeSample[]; visible: boolean; voltageScale: number; voltageOffset: number; coupling: 'DC' | 'AC'; }
export interface ScopeCursor { enabled: boolean; time: number; channel: number; }
export interface ScopeConfig { timebase: number; timeOffset: number; channels: ScopeChannel[]; cursorA: ScopeCursor; cursorB: ScopeCursor; trigger: any; maxSamples: number; showGrid: boolean; showMeasurements: boolean; }

export function computeMeasurements(samples: ScopeSample[]): any[] {
  if (samples.length < 1) return [];
  let vMax = -Infinity, vMin = Infinity, vSum = 0;
  for (const s of samples) { vMax = Math.max(vMax, s.voltage); vMin = Math.min(vMin, s.voltage); vSum += s.voltage; }
  const vAvg = vSum / samples.length;
  const vRms = Math.sqrt(vSum / samples.length - vAvg * vAvg);
  const vPp = vMax - vMin;
  return [
    { name: 'Vmax', value: vMax, unit: 'V', formatted: vMax.toFixed(3) + ' V' },
    { name: 'Vmin', value: vMin, unit: 'V', formatted: vMin.toFixed(3) + ' V' },
    { name: 'Vpp', value: vPp, unit: 'V', formatted: vPp.toFixed(3) + ' V' },
    { name: 'Vavg', value: vAvg, unit: 'V', formatted: vAvg.toFixed(3) + ' V' },
    { name: 'Vrms', value: vRms, unit: 'V', formatted: vRms.toFixed(3) + ' V' },
  ];
}

export function getVoltageAtTime(samples: ScopeSample[], time: number): number | null {
  if (samples.length === 0) return null;
  if (time <= samples[0].time) return samples[0].voltage;
  if (time >= samples[samples.length - 1].time) return samples[samples.length - 1].voltage;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].time >= time) {
      const prev = samples[i - 1], curr = samples[i];
      const frac = (time - prev.time) / (curr.time - prev.time);
      return prev.voltage + frac * (curr.voltage - prev.voltage);
    }
  }
  return null;
}

export function createDefaultScopeConfig(): ScopeConfig {
  return { timebase: 1e-3, timeOffset: 0, channels: [], cursorA: { enabled: false, time: 0, channel: -1 }, cursorB: { enabled: false, time: 0, channel: -1 }, trigger: { mode: 'auto', source: 0, edge: 'rising', level: 0, armed: true }, maxSamples: 5000, showGrid: true, showMeasurements: true };
}

export function formatTimebase(secondsPerDiv: number): string {
  if (secondsPerDiv >= 1e-3) return (secondsPerDiv * 1e3).toFixed(2) + ' ms/div';
  if (secondsPerDiv >= 1e-6) return (secondsPerDiv * 1e6).toFixed(2) + ' µs/div';
  return (secondsPerDiv * 1e9).toFixed(2) + ' ns/div';
}

export function formatVoltageScale(voltsPerDiv: number): string {
  if (voltsPerDiv >= 1) return voltsPerDiv.toFixed(2) + ' V/div';
  return (voltsPerDiv * 1e3).toFixed(2) + ' mV/div';
}

export const TIMEBASE_PRESETS: number[] = [1e-9, 2e-9, 5e-9, 1e-8, 2e-8, 5e-8, 1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 1e-1, 2e-1, 5e-1, 1, 2, 5];
export const VOLTAGE_SCALE_PRESETS: number[] = [1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 1e-1, 2e-1, 5e-1, 1, 2, 5, 10, 20, 50];
