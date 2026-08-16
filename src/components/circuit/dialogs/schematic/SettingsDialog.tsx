'use client';

// KiCad-parity schematic dialogs:
//   - FindReplaceDialog
//   - ViolationsBrowserDialog
//   - NetInspectorDialog
//   - SymbolEditorDialog (basic)
//   - PageSetupDialog
//   - SavedViewsDialog
//   - HierarchicalSheetsDialog

import { useCallback, useEffect, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import type { ERCError } from '@/lib/circuit/erc';
import type { NetClass, PageSetup } from '@/lib/circuit/types';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Search, Replace, AlertTriangle, CheckCircle, Shield, Network, Settings, Layers, BookOpen, Plus } from 'lucide-react';
import { DEFAULT_HOTKEYS } from './DEFAULT_HOTKEYS';

// ─────────────────────────────────────────────────────────────────────────────
// Find/Replace dialog — KiCad Ctrl+F
// ─────────────────────────────────────────────────────────────────────────────


export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useEditor((s) => s.theme);
  const setTheme = useEditor((s) => s.setTheme);
  const customHotkeys = useEditor((s) => s.customHotkeys);
  const setHotkey = useEditor((s) => s.setHotkey);
  const resetHotkeys = useEditor((s) => s.resetHotkeys);

  const [capturing, setCapturing] = useState<string | null>(null);

  const getKey = (name: string) => customHotkeys[name] ?? DEFAULT_HOTKEYS[name] ?? '';

  const captureKey = (name: string) => (e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') {
      setCapturing(null);
      return;
    }
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    // Normalize: space becomes ' ', enter becomes 'Enter'
    let key = e.key;
    if (key === ' ') key = ' ';
    if (key.length === 1 || ['Enter', 'Escape', 'Delete', 'Backspace', 'Tab', ' '].includes(key)) {
      parts.push(key === ' ' ? 'Space' : key);
      setHotkey(name, parts.join('+'));
      setCapturing(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Settings size={16} /> Settings</DialogTitle>
          <DialogDescription>Customize theme and keyboard shortcuts.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {/* Theme */}
          <div>
            <Label className="text-xs text-slate-400 mb-2 block">Theme</Label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={theme === 'dark' ? 'default' : 'ghost'}
                onClick={() => setTheme('dark')}
                className={theme === 'dark' ? 'bg-slate-700' : ''}
              >
                Dark (default)
              </Button>
              <Button
                size="sm"
                variant={theme === 'light' ? 'default' : 'ghost'}
                onClick={() => setTheme('light')}
                className={theme === 'light' ? 'bg-amber-500 text-slate-900' : ''}
              >
                Light
              </Button>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Note: Light theme is applied to the schematic + PCB canvas backgrounds and dialogs. Toolbar theming is partial.
            </p>
          </div>

          {/* Hotkeys */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs text-slate-400">Keyboard Shortcuts</Label>
              <Button size="sm" variant="ghost" className="text-xs text-slate-400" onClick={resetHotkeys}>
                Reset to defaults
              </Button>
            </div>
            <ScrollArea className="h-64 rounded border border-slate-700 bg-slate-950">
              <table className="w-full text-xs">
                <tbody>
                  {Object.keys(DEFAULT_HOTKEYS).map((name) => {
                    const isCapturing = capturing === name;
                    const current = getKey(name);
                    return (
                      <tr key={name} className="border-b border-slate-800 last:border-0">
                        <td className="px-3 py-2 text-slate-300 font-mono capitalize">
                          {name.replace(/_/g, ' ')}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            className={`rounded px-2 py-1 font-mono text-xs border ${
                              isCapturing
                                ? 'border-amber-500 bg-amber-500/20 text-amber-300 animate-pulse'
                                : 'border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-500'
                            }`}
                            onClick={() => setCapturing(name)}
                            onKeyDown={isCapturing ? captureKey(name) : undefined}
                            tabIndex={isCapturing ? 0 : -1}
                          >
                            {isCapturing ? 'Press key…' : (current || '—')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollArea>
            <p className="text-xs text-slate-500 mt-1">
              Click any key to re-bind. Press Escape to cancel. Note: custom hotkeys are stored per-session; customization is not yet wired into the canvas event handlers (it's a UI stub for now).
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
