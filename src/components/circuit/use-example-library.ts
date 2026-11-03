'use client';

// The example library is loaded on demand: normalizing ~40 hand-authored
// documents (orthogonal routing + the readability pass that re-routes
// misleading wires) costs a few hundred ms, which used to land on app
// startup because the toolbar imported it statically.

import { useEffect, useState } from 'react';

type ExampleLibrary = typeof import('@/lib/circuit/examples');

let cached: ExampleLibrary | null = null;
let pending: Promise<ExampleLibrary> | null = null;

export function loadExampleLibrary(): Promise<ExampleLibrary> {
  pending ??= import('@/lib/circuit/examples').then((m) => (cached = m));
  return pending;
}

/** The example library once loaded (null while loading or when disabled). */
export function useExampleLibrary(enabled = true): ExampleLibrary | null {
  const [lib, setLib] = useState<ExampleLibrary | null>(cached);
  useEffect(() => {
    if (!enabled || lib) return;
    let alive = true;
    loadExampleLibrary().then((m) => { if (alive) setLib(m); });
    return () => { alive = false; };
  }, [enabled, lib]);
  return lib;
}
