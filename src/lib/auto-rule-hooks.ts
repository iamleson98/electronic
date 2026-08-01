// Auto-run hooks for ERC and DRC.
//
// These subscribe to the relevant stores (circuit for ERC, PCB for DRC)
// and re-run the rule checks whenever the underlying state changes.
// A debounce prevents thrashing the engine on every drag tick.
//
// Why debounce: ERC/DRC can take 50-200ms on a large board. Running on
// every mousemove tick would make the canvas stutter. 300ms debounce feels
// "live" to the user (visible within ~1 frame after they stop moving).
//
// The hooks return nothing — they only trigger the debounced run on the
// store, and consumers read the result via their own store selector
// (`useEditor((s) => s.ercErrors)` / `usePCB((s) => s.drcErrors)`).
// This avoids holding a separate React state mirror and the associated
// setState-in-effect anti-pattern.

import { useEffect, useRef } from 'react';
import { useEditor } from '@/lib/circuit/store';
import { usePCB } from '@/lib/pcb/store';

const DEBOUNCE_MS = 300;

/**
 * Auto-run full ERC whenever components, wires, or no-connect markers change.
 * The result is published to `useEditor((s) => s.ercErrors)` — read that
 * selector in your component; don't read the return value of this hook.
 */
export function useAutoERC(enabled: boolean): void {
  const components = useEditor((s) => s.components);
  const wires = useEditor((s) => s.wires);
  const noConnects = useEditor((s) => s.noConnects);
  const runFullERCCheck = useEditor((s) => s.runFullERCCheck);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      runFullERCCheck();
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, components, wires, noConnects, runFullERCCheck]);
}

/**
 * Auto-run DRC whenever footprints, traces, vias, ratsnest, or board change.
 * The result is published to `usePCB((s) => s.drcErrors)` — read that
 * selector in your component; don't read the return value of this hook.
 */
export function useAutoDRC(enabled: boolean): void {
  const footprints = usePCB((s) => s.footprints);
  const traces = usePCB((s) => s.traces);
  const vias = usePCB((s) => s.vias);
  const ratsnest = usePCB((s) => s.ratsnest);
  const board = usePCB((s) => s.board);
  const runDRC = usePCB((s) => s.runDRC);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      runDRC();
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, footprints, traces, vias, ratsnest, board, runDRC]);
}
