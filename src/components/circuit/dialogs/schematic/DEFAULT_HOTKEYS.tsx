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

// ─────────────────────────────────────────────────────────────────────────────
// Find/Replace dialog — KiCad Ctrl+F
// ─────────────────────────────────────────────────────────────────────────────


export const DEFAULT_HOTKEYS: Record<string, string> = {
  'rotate': 'r',
  'rotate_free': 'Shift+R',
  'delete': 'Delete',
  'mirror_x': 'x',
  'mirror_y': 'y',
  'lock': 'l',
  'demorgan': 'm',
  'undo': 'Ctrl+Z',
  'redo': 'Ctrl+Y',
  'copy': 'Ctrl+C',
  'paste': 'Ctrl+V',
  'duplicate': 'Ctrl+D',
  'select_all': 'Ctrl+A',
  'run_pause': ' ',
  'find': 'Ctrl+F',
  'escape': 'Escape',
};
