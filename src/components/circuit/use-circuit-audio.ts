'use client';

// Circuit audio poller — drives buzzer/speaker WebAudio voices from the live
// sim state. Mounted once per page (main app + embed).
//
// The poll interval (100 ms) is decoupled from the 60 Hz sim loop: audio
// parameters ramp smoothly (setTargetAtTime), so a coarse poll is inaudible
// while keeping the main loop free of audio work.

import { useEffect } from 'react';
import { circuitAudio } from '@/lib/circuit/audio';

export function useCircuitAudio(): void {
  useEffect(() => {
    const id = window.setInterval(() => {
      try {
        circuitAudio.tickFromEditor();
      } catch {
        // audio must never break the app
      }
    }, 100);
    return () => {
      window.clearInterval(id);
      circuitAudio.stopAll();
    };
  }, []);
}
