// File operations — extracted from Toolbar.tsx.
// Contains Save, Load, Clear, Undo, Redo.

import { useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { Save, Upload, Trash2, Undo2, Redo2 } from 'lucide-react';
import type { CircuitDocument } from '@/lib/circuit/types';

export function FileOperations({
  running,
  past,
  future,
  serialize,
  loadDocument,
  clear,
  undo,
  redo,
}: {
  running: boolean;
  past: number;
  future: number;
  serialize: () => string;
  loadDocument: (doc: CircuitDocument) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSave = useCallback(() => {
    const json = serialize();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `circuit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Circuit saved');
  }, [serialize]);

  const handleLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = JSON.parse(reader.result as string);
        if (doc && doc.version === 1 && Array.isArray(doc.components) && Array.isArray(doc.wires)) {
          loadDocument(doc);
          toast.success(`Loaded circuit: ${file.name}`);
        } else {
          toast.error('Invalid circuit file: missing version, components, or wires array');
        }
      } catch (err) {
        toast.error('Failed to parse file: ' + (err as Error).message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [loadDocument]);

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleLoad}
        className="hidden"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" onClick={handleSave} disabled={running}>
            <Save size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Save circuit (JSON)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={running}>
            <Upload size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Load circuit (JSON)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" onClick={undo} disabled={running || past === 0}>
            <Undo2 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" onClick={redo} disabled={running || future === 0}>
            <Redo2 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Redo (Ctrl+Y)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="ghost" onClick={clear} disabled={running}>
            <Trash2 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Clear canvas</TooltipContent>
      </Tooltip>
    </>
  );
}
