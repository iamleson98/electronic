// AI Tool helper utilities — shared across all tool category files.

import type { CircuitDocument, CircuitComponent } from '@/lib/circuit/types';

export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function findComponent(doc: CircuitDocument, id: string): CircuitComponent | undefined {
  return doc.components.find(c => c.id === id);
}
