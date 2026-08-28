// Custom hook: extracts the simulation RAF loop from CircuitCanvas.
// Manages the requestAnimationFrame loop that drives both the simulation
// step() calls and the flow-dot phase advancement.
//
// NOTE: this hook no longer triggers React re-renders. The canvas is drawn by
// useCanvasRenderer's own RAF loop, which reads flowPhaseRef directly — so
// there is no animTick/setAnimTick here anymore. This removes a full React
// re-render per animation frame (the #1 hot-path cost while simulating).

import { useEffect, useRef } from 'react';
import { useEditor } from '@/lib/circuit/store';

export function useSimulationLoop(running: boolean, step: () => void) {
  const flowPhaseRef = useRef(0);

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
          // NaN/Infinity detection — if the solver produced non-finite node
          // voltages, pause the sim and surface an error so the user knows
          // their circuit is broken instead of letting it run silently forever.
          const sim = useEditor.getState().simContext;
          if (sim) {
            for (let i = 0; i < sim.nodeVoltage.length; i++) {
              if (!isFinite(sim.nodeVoltage[i])) {
                useEditor.getState().setSimError(
                  `Simulation diverged (node ${i} = ${sim.nodeVoltage[i]}). ` +
                  `Check for short circuits, floating nodes, or conflicting sources.`,
                );
                useEditor.getState().setRunning(false);
                return;
              }
            }
          }
        } catch (err) {
          console.error('[Simulation] step() threw:', err);
          useEditor.getState().setSimError(`Simulation error: ${(err as Error).message}`);
          useEditor.getState().setRunning(false);
        }
        lastSimTime = now;
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, step]);

  // Pause the simulation when the tab is hidden — browsers throttle RAF to
  // ~1Hz when backgrounded, which would cause the sim to drift wildly from
  // real-time and make cross-tab experiments impossible to reproduce.
  // The user can resume by clicking Play again after returning to the tab.
  useEffect(() => {
    if (!running) return;
    const onVisibilityChange = () => {
      if (document.hidden) {
        useEditor.getState().setRunning(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [running]);

  return { flowPhaseRef };
}
