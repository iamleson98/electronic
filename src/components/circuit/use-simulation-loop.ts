// Custom hook: extracts the simulation/animation RAF loop from CircuitCanvas.
// Manages the requestAnimationFrame loop that drives both the simulation
// step() calls and the flow-dot phase advancement.

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';

export function useSimulationLoop(running: boolean, step: () => void) {
  const flowPhaseRef = useRef(0);
  const [animTick, setAnimTick] = useState(0);
  void animTick; // referenced to force re-render

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let lastSimTime = performance.now();
    const SIM_INTERVAL = 16; // ms between simulation steps (~60Hz)

    const loop = (now: number) => {
      // Advance flow phase continuously — never wraps with % 1.
      const simSpeed = useEditor.getState().speed;
      flowPhaseRef.current += 0.012 * Math.max(0.5, Math.min(4, simSpeed));

      // Run simulation step at fixed interval
      if (now - lastSimTime >= SIM_INTERVAL) {
        try {
          step();
        } catch (err) {
          console.error('[Simulation] step() threw:', err);
          useEditor.getState().setRunning(false);
        }
        lastSimTime = now;
      }

      // Single re-render per frame
      setAnimTick((t) => (t + 1) % 1000000);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, step]);

  return { flowPhaseRef, animTick };
}
