// Share circuits via URL — encode/decode circuit in URL hash.

import type { CircuitDocument } from './types';

export function createShareURL(doc: CircuitDocument): string {
  const clean: CircuitDocument = {
    version: 1,
    components: doc.components.map(c => ({ ...c, simState: undefined, parameters: { ...c.parameters } })),
    wires: doc.wires.map(w => ({ ...w })),
  };
  const json = JSON.stringify(clean);
  const base64 = typeof btoa !== 'undefined'
    ? btoa(unescape(encodeURIComponent(json)))
    : Buffer.from(json, 'utf-8').toString('base64');
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const base = typeof window !== 'undefined' ? window.location.href.split('#')[0] : '';
  return `${base}#circuit=${base64url}`;
}

export function loadFromShareURL(hash: string): CircuitDocument | null {
  if (!hash || !hash.startsWith('#circuit=')) return null;
  const base64url = hash.slice('#circuit='.length);
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  try {
    const json = typeof atob !== 'undefined'
      ? decodeURIComponent(escape(atob(base64)))
      : Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json) as CircuitDocument;
  } catch { return null; }
}

export function hasSharedCircuit(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hash.startsWith('#circuit=');
}
