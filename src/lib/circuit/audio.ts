// ─── Circuit audio engine (WebAudio) ─────────────────────────────────────────
// Buzzers and speakers now actually make sound, like Tinkercad's piezo.
//
// Design:
//  - Singleton `circuitAudio` owns one AudioContext (created lazily — browsers
//    require a user gesture, so the enable button lives in the status bar).
//  - One oscillator voice per sounding component id, updated by a lightweight
//    poll (`tickFromEditor`) from a 100 ms interval hook — smooth gain ramps
//    (setTargetAtTime) avoid clicks.
//  - The buzzer plugin publishes `__buzzer = { v }` and the speaker plugin
//    publishes `__speaker = { freq, vpp }` in their per-component simState
//    (the persistent `sim.state[compId]` map). This module only READS those —
//    no engine coupling.
//  - Pure helpers (clampVoiceFrequency, buzzVolumeFromVoltage,
//    speakerVolumeFromVpp) are exported for unit tests.

import { useEditor } from '@/lib/circuit/store';

/** Audible range clamps for the synth voices. */
export const MIN_AUDIBLE_HZ = 40;
export const MAX_AUDIBLE_HZ = 12000;

/** Clamp a frequency estimate into the audible band (0/NaN → 0 = silent). */
export function clampVoiceFrequency(hz: number): number {
  if (!isFinite(hz) || hz <= 0) return 0;
  return Math.min(MAX_AUDIBLE_HZ, Math.max(MIN_AUDIBLE_HZ, hz));
}

/**
 * Buzzer volume from its terminal voltage: active once |v| reaches 80% of the
 * rated voltage (matching the plugin's historical "activity" threshold), then
 * scaled up to full at 100%+. 0.0–0.6 keeps it audible but not obnoxious.
 */
export function buzzVolumeFromVoltage(v: number, ratedVoltage: number): number {
  const rated = ratedVoltage > 0 ? ratedVoltage : 5;
  const ratio = Math.abs(v) / rated;
  if (ratio < 0.8) return 0;
  return Math.min(0.6, (ratio - 0.4) * 0.6);
}

/** Speaker volume from the waveform's peak-to-peak amplitude (0..1 gain). */
export function speakerVolumeFromVpp(vpp: number): number {
  if (!isFinite(vpp) || vpp <= 0) return 0;
  // ~1 Vpp is comfortably audible; larger signals compress toward the cap.
  return Math.min(0.7, vpp / 2);
}

const AUDIO_PREF_KEY = 'circuitlab-audio-enabled';

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  /** last requested frequency (for restart on big jumps) */
  freq: number;
}

class CircuitAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<string, Voice>();
  private enabledPref: boolean;

  constructor() {
    this.enabledPref = false;
    try {
      if (typeof window !== 'undefined') {
        this.enabledPref = window.localStorage.getItem(AUDIO_PREF_KEY) === '1';
      }
    } catch { /* storage blocked — defaults to off */ }
  }

  isEnabled(): boolean {
    return this.enabledPref;
  }

  /** Enable/disable sound. Enabling creates (or resumes) the AudioContext —
   *  MUST be called from a user gesture handler. */
  async setEnabled(on: boolean): Promise<boolean> {
    this.enabledPref = on;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(AUDIO_PREF_KEY, on ? '1' : '0');
      }
    } catch { /* storage blocked — preference not persisted */ }
    if (!on) {
      this.stopAll();
      return true;
    }
    if (typeof window === 'undefined' || !('AudioContext' in window)) return false;
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      this.ctx = null;
      this.master = null;
      return false;
    }
  }

  /** Stop every voice (sim stopped / reset / disabled). */
  stopAll(): void {
    for (const [, v] of this.voices) {
      try { v.osc.stop(); } catch { /* already stopped */ }
    }
    this.voices.clear();
  }

  /** Create or update a voice. freq=0 or volume=0 stops it. */
  private setVoice(id: string, freq: number, volume: number, type: OscillatorType): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const f = clampVoiceFrequency(freq);
    const vol = Math.max(0, Math.min(1, volume));
    const existing = this.voices.get(id);

    if (f <= 0 || vol <= 0) {
      if (existing) {
        try { existing.osc.stop(); } catch { /* already stopped */ }
        this.voices.delete(id);
      }
      return;
    }

    if (existing) {
      // Restart the oscillator when the frequency jumps dramatically (sweeping
      // osc.frequency is fine for small changes; big jumps sweep audibly).
      if (Math.abs(f - existing.freq) > existing.freq * 3 + 200) {
        try { existing.osc.stop(); } catch { /* already stopped */ }
        this.voices.delete(id);
      } else {
        existing.freq = f;
        existing.osc.frequency.setTargetAtTime(f, ctx.currentTime, 0.02);
        existing.gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.03);
        return;
      }
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = f;
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(master);
    osc.start();
    gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.03);
    this.voices.set(id, { osc, gain, freq: f });
  }

  /**
   * One poll tick: read every buzzer/speaker simState from the live editor
   * state and drive the voices. Called from an interval hook (~100 ms).
   *
   * Reads the sim-state map directly (state entries are keyed by component id
   * — possibly hierarchy-prefixed) so it works both for root and sub-sheet
   * circuits: any state object carrying `__buzzer` / `__speaker` is a sound
   * source. When the sim is not running everything falls silent.
   */
  tickFromEditor(): void {
    if (!this.enabledPref || !this.ctx) return;
    const s = useEditor.getState();
    // sim.state is the persistent per-component map (Record<string, unknown>);
    // sound plugins publish __buzzer / __speaker objects inside their entries.
    const stateMap: Record<string, unknown> | undefined = s.simContext?.state;
    if (!s.running || !stateMap) {
      if (this.voices.size > 0) this.stopAll();
      return;
    }

    const activeIds = new Set<string>();
    for (const [compId, stRaw] of Object.entries(stateMap)) {
      const st = stRaw as Record<string, unknown> | null | undefined;
      if (!st || typeof st !== 'object') continue;
      const buzz = st.__buzzer as { v?: number; rated?: number; freq?: number } | undefined;
      if (buzz && typeof buzz === 'object' && typeof buzz.v === 'number') {
        activeIds.add(compId);
        const freq = typeof buzz.freq === 'number' ? buzz.freq : 2300;
        const rated = typeof buzz.rated === 'number' ? buzz.rated : 5;
        this.setVoice(`buzz:${compId}`, freq, buzzVolumeFromVoltage(buzz.v, rated), 'square');
      }
      const spk = st.__speaker as { freq?: number; vpp?: number } | undefined;
      if (spk && typeof spk === 'object' && typeof spk.freq === 'number' && typeof spk.vpp === 'number') {
        activeIds.add(compId);
        this.setVoice(`spk:${compId}`, spk.freq, speakerVolumeFromVpp(spk.vpp), 'triangle');
      }
    }
    // Stop voices whose components disappeared mid-run
    for (const [id] of this.voices) {
      const compId = id.startsWith('buzz:') ? id.slice(5) : id.slice(4);
      if (!activeIds.has(compId)) {
        const v = this.voices.get(id);
        if (v) {
          try { v.osc.stop(); } catch { /* already stopped */ }
          this.voices.delete(id);
        }
      }
    }
  }
}

export const circuitAudio = new CircuitAudio();
