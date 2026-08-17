'use client';

// Tip of the Day — shows a random tip toast on startup (once per session).

import { useEffect } from 'react';
import { toast } from 'sonner';

const TIPS = [
  'Press Space to start/pause the simulation.',
  'Press R to rotate a selected component.',
  'Press Delete to remove the selected component.',
  'Press Ctrl+Z to undo, Ctrl+Shift+Z to redo.',
  'Press Ctrl+K to open the Command Palette.',
  'Press Ctrl+J to toggle the AI Assistant.',
  'Press ? to see keyboard shortcuts.',
  'Double-click a component to rotate it.',
  'Hold Shift and click to select multiple components.',
  'Drag from a terminal to start a wire.',
  'Right-click is disabled — use the toolbar for component actions.',
  'Use the Auto/Review toggle to control AI circuit changes.',
  'Place an Oscilloscope component to see waveforms.',
  'The measurement cursor shows V at any point in time.',
  'Use the parameter sweep slider to explore circuit behavior.',
  'The .meas tab lets you run SPICE-style measurements.',
  'The Bode plot shows gain and phase for AC analysis.',
  'ERC checks for unconnected pins and missing ground.',
  'Net Inspector shows all nets and their connections.',
  'Export to SPICE netlist, KiCad netlist, or BOM.',
];

const TIP_KEY = 'circuit-lab.tip-seen';

export function TipOfTheDay() {
  useEffect(() => {
    try {
      const seen = sessionStorage.getItem(TIP_KEY);
      if (seen) return; // Only show once per session
      sessionStorage.setItem(TIP_KEY, '1');
      const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
      // Delay so it doesn't overlap with crash recovery prompt
      const timer = setTimeout(() => {
        toast.info('💡 Tip', { description: tip, duration: 5000 });
      }, 3000);
      return () => clearTimeout(timer);
    } catch { /* sessionStorage disabled */ }
  }, []);
  return null;
}
