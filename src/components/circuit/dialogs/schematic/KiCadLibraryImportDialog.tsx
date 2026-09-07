'use client';

// KiCad symbol-library import dialog — bulk-imports .kicad_sym libraries (or
// the embedded lib_symbols of a .kicad_sch) into the persistent user library.
// Imported symbols register as live palette plugins (category "IC") with their
// real pin geometry, exactly like symbols drawn in the Symbol Editor.

import { useState, useRef, useMemo } from 'react';
import {
  parseKicadSymbolLibrary,
  type KicadLibImportResult,
} from '@/lib/circuit/kicad-lib-import';
import { symbolDesignToPlugin } from '@/lib/circuit/symbol-editor-types';
import {
  listUserDesigns,
  saveUserDesign,
  removeUserDesign,
  USER_LIBRARY_MAX_SYMBOLS,
} from '@/lib/circuit/user-library';
import { registerPlugin } from '@/lib/circuit/registry';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, Library, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

interface PreviewState {
  fileName: string;
  result: KicadLibImportResult;
}

export function KiCadLibraryImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Bumped after mutations so the listing (a localStorage read) is re-derived
  // in a memo instead of a setState-in-effect.
  const [libraryVersion, setLibraryVersion] = useState(0);

  const entries = useMemo(() => {
    // Re-list on every dialog re-open and after every import/remove. Reading
    // localStorage synchronously inside a memo is a pure read of external
    // state (same pattern as the scope-config initializer).
    void open;
    void libraryVersion;
    return listUserDesigns();
  }, [open, libraryVersion]);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const result = parseKicadSymbolLibrary(text);
        setPreview({ fileName: file.name, result });
      } catch (err) {
        toast.error('Parse failed: ' + (err as Error).message);
        setPreview(null);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = () => {
    if (!preview) return;
    const { result, fileName } = preview;
    let imported = 0;
    let rejected = 0;
    try {
      for (const design of result.designs) {
        const ok = saveUserDesign(design, 'kicad-import');
        if (!ok) { rejected++; continue; }
        // Register immediately so the palette shows it this session
        try {
          registerPlugin(symbolDesignToPlugin(design));
        } catch { /* registration failure should not abort the batch */ }
        imported++;
      }
      window.dispatchEvent(new CustomEvent('circuitlab:plugin-registered'));
      setLibraryVersion((v) => v + 1);
      if (imported > 0) {
        toast.success(`Imported ${imported} symbol${imported === 1 ? '' : 's'} from ${fileName}`, {
          description: `Find them in the component palette under "IC" (${entries.length}/${USER_LIBRARY_MAX_SYMBOLS} library slots used)`,
        });
      }
      if (rejected > 0) {
        toast.warning(`${rejected} symbol(s) skipped — user library is full (${USER_LIBRARY_MAX_SYMBOLS})`);
      }
      setPreview(null);
    } catch (err) {
      toast.error('Import failed: ' + (err as Error).message);
    }
  };

  const handleRemove = (name: string) => {
    const entry = entries.find((e) => e.design.name === name);
    if (entry) {
      removeUserDesign(entry.design.type);
      setLibraryVersion((v) => v + 1);
      toast.success(`Removed "${name}" (takes effect after reload)`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setPreview(null); onClose(); } }}>
      <DialogContent className="max-w-2xl bg-slate-900 border-slate-700 text-slate-100 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library size={16} className="text-cyan-400" />
            Import KiCad Symbol Library
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Import a <span className="font-mono text-slate-300">.kicad_sym</span> library (KiCad 6+) or a{' '}
            <span className="font-mono text-slate-300">.kicad_sch</span> schematic — its embedded library
            symbols are extracted. Symbols become palette parts with real pin geometry.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Drop zone */}
          <div
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-700 p-6 text-center transition-colors hover:border-cyan-500/60"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
          >
            <Upload size={20} className="text-slate-500" />
            <div className="text-sm text-slate-400">
              Drop a <span className="font-mono">.kicad_sym</span> / <span className="font-mono">.kicad_sch</span> file here, or click to browse
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".kicad_sym,.kicad_sch,.txt"
              className="hidden"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
            />
          </div>

          {/* Parse preview */}
          {preview && (
            <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="font-mono text-xs text-slate-300">{preview.fileName}</div>
                <div className="flex gap-3 text-xs">
                  <span className="flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 size={12} /> {preview.result.designs.length} symbols
                  </span>
                  {preview.result.skipped.length > 0 && (
                    <span className="flex items-center gap-1 text-amber-400">
                      <AlertTriangle size={12} /> {preview.result.skipped.length} skipped
                    </span>
                  )}
                </div>
              </div>
              <div className="mb-2 max-h-28 overflow-y-auto font-mono text-[11px] text-slate-400">
                {preview.result.designs.slice(0, 40).map((d) => (
                  <div key={d.type}>
                    {d.name} <span className="text-slate-600">({d.pins.length} pins)</span>
                  </div>
                ))}
                {preview.result.designs.length > 40 && (
                  <div className="text-slate-600">… and {preview.result.designs.length - 40} more</div>
                )}
              </div>
              {preview.result.warnings.length > 0 && (
                <div className="mb-2 max-h-20 overflow-y-auto text-[11px] text-amber-400/80">
                  {preview.result.warnings.slice(0, 8).map((w, i) => <div key={i}>{w}</div>)}
                  {preview.result.warnings.length > 8 && (
                    <div>… and {preview.result.warnings.length - 8} more warnings</div>
                  )}
                </div>
              )}
              <Button
                size="sm"
                className="w-full cursor-pointer bg-cyan-600 hover:bg-cyan-500"
                disabled={preview.result.designs.length === 0}
                onClick={handleImport}
              >
                Import {preview.result.designs.length} symbol{preview.result.designs.length === 1 ? '' : 's'}
              </Button>
            </div>
          )}

          {/* Current user library */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
              User Library — {entries.length}/{USER_LIBRARY_MAX_SYMBOLS}
            </div>
            {entries.length === 0 ? (
              <div className="rounded-lg border border-slate-800 p-3 text-center text-xs text-slate-500">
                No imported symbols yet. Symbols you create in the Symbol Editor are saved here too.
              </div>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {entries.map((e) => (
                  <div key={e.design.type} className="flex items-center justify-between rounded border border-slate-800 px-2 py-1 text-xs">
                    <span className="font-mono text-slate-300">{e.design.name}</span>
                    <button
                      onClick={() => handleRemove(e.design.name)}
                      className="cursor-pointer text-slate-500 hover:text-rose-400"
                      title="Remove from library"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
