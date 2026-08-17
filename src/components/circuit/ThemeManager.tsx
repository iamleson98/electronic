'use client';

// ThemeManager — applies the editor store's `theme` value to the document.
// Sets the `data-theme` attribute on <html> so CSS can react accordingly.
// Also persists the user's theme choice to localStorage so it survives reloads.

import { useEffect } from 'react';
import { useEditor } from '@/lib/circuit/store';

const THEME_STORAGE_KEY = 'circuit-lab.theme';

export function ThemeManager() {
  const theme = useEditor((s) => s.theme);
  const setTheme = useEditor((s) => s.setTheme);

  // On mount: read persisted theme (if any) and apply it.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY) as
        | 'dark' | 'light' | 'high-contrast' | null;
      if (stored && stored !== theme) {
        setTheme(stored);
      }
    } catch { /* localStorage disabled */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply theme to <html> + persist whenever it changes.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  return null;
}
