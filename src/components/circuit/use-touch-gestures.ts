import type { RefObject } from 'react';

export interface TouchPoint {
  x: number;
  y: number;
}

export type TouchGestureKind = 'pan' | 'long-press' | 'double-tap' | 'tap';

export type TouchGestureCallback = (gesture: TouchGestureKind) => void;

export function useTouchGestures(_ref: RefObject<HTMLElement | null>, _cb: TouchGestureCallback): void {}

export function detectGesture(st: number, et: number, sp: TouchPoint, ep: TouchPoint, lt?: number): TouchGestureKind {
  const d = et - st;
  const m = Math.hypot(ep.x - sp.x, ep.y - sp.y);
  if (m > 10) return 'pan';
  if (d >= 500) return 'long-press';
  if (lt && lt > 0 && st - lt < 300) return 'double-tap';
  return 'tap';
}

export function computePinchZoomFactor(sd: number, cd: number, sz: number): number {
  if (sd <= 0) return sz;
  const f = cd / sd;
  return Math.max(0.1, Math.min(10, sz * f));
}

export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}
