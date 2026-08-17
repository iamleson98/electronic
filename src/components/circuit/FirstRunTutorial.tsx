'use client';

// First-Run Tutorial — a step-by-step walkthrough that highlights the main UI
// elements on the first visit. Uses localStorage to track completion so it
// only shows once per browser.
//
// Each step targets a CSS selector (or aria-label) on the page; we draw an
// overlay highlight around the matched element + a tooltip pointing to it.
// Users can skip (X), Next, or Back.

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, X, GraduationCap } from 'lucide-react';

interface TutorialStep {
  title: string;
  body: string;
  /** CSS selector for the element to highlight. If null, just shows centered. */
  selector: string | null;
  /** where to place the tooltip relative to the highlighted element */
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

const STEPS: TutorialStep[] = [
  {
    title: 'Welcome to Circuit Lab',
    body: 'A complete circuit simulator with schematic capture, PCB layout, 3D view, and AI assistance. This quick tour shows the main features in 6 steps.',
    selector: null,
    position: 'center',
  },
  {
    title: 'Component Palette',
    body: 'Click any component here, or drag it onto the canvas. Categories: passive (R/C/L), sources, semiconductors, ICs, logic, meters, MCUs (Arduino/RPi), I/O.',
    selector: '[aria-label="Component palette"], aside:first-of-type, [class*="w-64"][class*="border-r"]',
    position: 'right',
  },
  {
    title: 'Canvas',
    body: 'Click on a component terminal (green dot) to start a wire. Click another terminal to connect. Use the mouse wheel to zoom, middle/right-drag to pan.',
    selector: 'canvas',
    position: 'top',
  },
  {
    title: 'Probe & Oscilloscope',
    body: 'Place an Oscilloscope component to capture waveforms. This panel shows live voltage traces, the measurement cursor, .meas commands, and the FFT/THD spectrum.',
    selector: '[aria-label="Probe and oscilloscope panel"], [role="complementary"]',
    position: 'left',
  },
  {
    title: 'Run the Simulation',
    body: 'Press Space (or click the Play button) to start the simulation. Yellow dots show current flow direction. Press again to pause.',
    selector: '[aria-label*="Run"], [aria-label*="Play"], button[aria-label*="imulation"]',
    position: 'bottom',
  },
  {
    title: 'Need More Help?',
    body: 'Press ? to see all keyboard shortcuts. Press Ctrl+K for the command palette. Press Ctrl+J to open the AI Assistant — describe a circuit and it will build it for you.',
    selector: null,
    position: 'center',
  },
];

const STORAGE_KEY = 'circuit-lab.tutorial-completed';
const SKIP_KEY = 'circuit-lab.tutorial-skipped';

export function FirstRunTutorial() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [highlightRect, setHighlightRect] = useState<DOMRect | null>(null);

  // Show on first visit (no completed flag in localStorage)
  useEffect(() => {
    try {
      const completed = localStorage.getItem(STORAGE_KEY);
      const skipped = localStorage.getItem(SKIP_KEY);
      if (!completed && !skipped) {
        // Delay so the page has rendered
        const t = setTimeout(() => setOpen(true), 1200);
        return () => clearTimeout(t);
      }
    } catch { /* localStorage disabled */ }
  }, []);

  // Update highlight rect when step changes
  const updateHighlight = useCallback(() => {
    const stepDef = STEPS[step];
    if (!stepDef || !stepDef.selector) {
      setHighlightRect(null);
      return;
    }
    try {
      const el = document.querySelector(stepDef.selector);
      if (el) {
        setHighlightRect(el.getBoundingClientRect());
      } else {
        setHighlightRect(null);
      }
    } catch {
      setHighlightRect(null);
    }
  }, [step]);

  useEffect(() => {
    if (!open) return;
    updateHighlight();
    // Re-position on resize / scroll
    const onResize = () => updateHighlight();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, step, updateHighlight]);

  const close = useCallback(() => {
    setOpen(false);
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
  }, []);

  const skip = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
      localStorage.setItem(SKIP_KEY, '1');
    } catch { /* ignore */ }
  }, []);

  const next = useCallback(() => {
    if (step >= STEPS.length - 1) {
      close();
    } else {
      setStep(s => s + 1);
    }
  }, [step, close]);

  const back = useCallback(() => {
    setStep(s => Math.max(0, s - 1));
  }, []);

  if (!open) return null;

  const stepDef = STEPS[step];
  const position = stepDef.position ?? 'center';

  // Compute tooltip position based on highlight rect
  let tooltipStyle: React.CSSProperties = {};
  if (highlightRect) {
    const rect = highlightRect;
    const PAD = 12;
    const TOOLTIP_W = 320;
    const TOOLTIP_H = 180;
    if (position === 'right') {
      tooltipStyle = {
        left: Math.min(rect.right + PAD, window.innerWidth - TOOLTIP_W - PAD),
        top: Math.max(PAD, Math.min(rect.top + rect.height / 2 - TOOLTIP_H / 2, window.innerHeight - TOOLTIP_H - PAD)),
      };
    } else if (position === 'left') {
      tooltipStyle = {
        left: Math.max(PAD, rect.left - TOOLTIP_W - PAD),
        top: Math.max(PAD, Math.min(rect.top + rect.height / 2 - TOOLTIP_H / 2, window.innerHeight - TOOLTIP_H - PAD)),
      };
    } else if (position === 'bottom') {
      tooltipStyle = {
        left: Math.max(PAD, Math.min(rect.left + rect.width / 2 - TOOLTIP_W / 2, window.innerWidth - TOOLTIP_W - PAD)),
        top: rect.bottom + PAD,
      };
    } else if (position === 'top') {
      tooltipStyle = {
        left: Math.max(PAD, Math.min(rect.left + rect.width / 2 - TOOLTIP_W / 2, window.innerWidth - TOOLTIP_W - PAD)),
        top: Math.max(PAD, rect.top - TOOLTIP_H - PAD),
      };
    } else {
      tooltipStyle = {
        left: window.innerWidth / 2 - TOOLTIP_W / 2,
        top: window.innerHeight / 2 - TOOLTIP_H / 2,
      };
    }
  } else {
    // No highlight — center
    tooltipStyle = {
      left: window.innerWidth / 2 - 320 / 2,
      top: window.innerHeight / 2 - 90,
    };
  }

  return (
    <div className="fixed inset-0 z-[9999]" role="dialog" aria-label="Tutorial walkthrough">
      {/* Dimmed backdrop with a "hole" cut around the highlight */}
      <div className="absolute inset-0 bg-slate-950/80" onClick={(e) => { e.stopPropagation(); }} />
      {highlightRect && (
        // SVG cutout that re-shows the highlighted element
        <svg
          className="absolute inset-0 h-full w-full"
          style={{ pointerEvents: 'none' }}
        >
          <defs>
            <mask id="tutorial-hole">
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={highlightRect.left - 6}
                y={highlightRect.top - 6}
                width={highlightRect.width + 12}
                height={highlightRect.height + 12}
                rx={8}
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="rgba(2, 6, 23, 0.85)"
            mask="url(#tutorial-hole)"
          />
          {/* amber outline around the highlight */}
          <rect
            x={highlightRect.left - 6}
            y={highlightRect.top - 6}
            width={highlightRect.width + 12}
            height={highlightRect.height + 12}
            rx={8}
            fill="none"
            stroke="#fbbf24"
            strokeWidth={2}
            strokeDasharray="6 3"
          />
        </svg>
      )}

      {/* Tooltip */}
      <div
        className="absolute w-80 rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-2xl"
        style={tooltipStyle}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-amber-400">
            <GraduationCap size={14} />
            <span className="text-[10px] font-semibold uppercase tracking-wider">
              Tour · {step + 1}/{STEPS.length}
            </span>
          </div>
          <button
            onClick={skip}
            className="cursor-pointer text-slate-500 hover:text-slate-300"
            aria-label="Skip tutorial"
          >
            <X size={14} />
          </button>
        </div>
        <h3 className="mb-1 text-sm font-semibold text-slate-100">{stepDef.title}</h3>
        <p className="mb-3 text-xs leading-relaxed text-slate-400">{stepDef.body}</p>
        <div className="flex items-center justify-between">
          <button
            onClick={skip}
            className="cursor-pointer text-[10px] text-slate-500 hover:text-slate-300"
          >
            Skip tour
          </button>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={back}
              disabled={step === 0}
              className="cursor-pointer h-7 px-2 text-xs"
            >
              <ChevronLeft size={12} className="mr-1" /> Back
            </Button>
            <Button
              size="sm"
              onClick={next}
              className="cursor-pointer h-7 px-2 text-xs"
            >
              {step === STEPS.length - 1 ? 'Finish' : 'Next'}
              {step < STEPS.length - 1 && <ChevronRight size={12} className="ml-1" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
