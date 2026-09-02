'use client';

import { useCallback, useEffect, useState } from 'react';
import { useEditor } from '@/lib/circuit/store';
import type { CircuitDocument } from '@/lib/circuit/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Save, Trash2, FolderOpen, Database, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog } from '@/lib/confirm';

interface SavedCircuit {
  id: string;
  name: string;
  description: string;
  tags: string;
  /** Parsed tags from the server (added field; falls back to `tags` if absent). */
  tagList?: string[];
  isExample: boolean;
  createdAt: string;
  updatedAt: string;
  document?: string;
}

export function MyCircuitsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [circuits, setCircuits] = useState<SavedCircuit[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const serialize = useEditor((s) => s.serialize);
  const loadDocument = useEditor((s) => s.loadDocument);

  const fetchCircuits = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/circuits');
      const data = await res.json();
      setCircuits(data.circuits || []);
    } catch (err) {
      toast.error('Failed to load circuits: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchCircuits();
  }, [open, fetchCircuits]);

  const handleSaveNew = async () => {
    if (!name.trim()) {
      toast.error('Please enter a name');
      return;
    }
    try {
      const doc = serialize();
      const res = await fetch('/api/circuits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, tags, document: doc }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      toast.success(`Saved "${name}"`);
      setName('');
      setDescription('');
      setTags('');
      setShowSaveForm(false);
      fetchCircuits();
    } catch (err) {
      toast.error('Save failed: ' + (err as Error).message);
    }
  };

  const handleUpdate = async (id: string, currentName: string) => {
    try {
      const doc = serialize();
      const res = await fetch(`/api/circuits/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: currentName, document: doc }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Update failed');
      toast.success(`Updated "${currentName}"`);
      fetchCircuits();
    } catch (err) {
      toast.error('Update failed: ' + (err as Error).message);
    }
  };

  const handleLoad = async (id: string, name: string) => {
    try {
      setSavingId(id);
      const res = await fetch(`/api/circuits/${id}`);
      if (!res.ok) throw new Error('Load failed');
      const data = await res.json();
      const doc: CircuitDocument = typeof data.circuit.document === 'string'
        ? JSON.parse(data.circuit.document)
        : data.circuit.document;
      loadDocument(doc);
      toast.success(`Loaded "${name}"`);
      onClose();
    } catch (err) {
      toast.error('Load failed: ' + (err as Error).message);
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: `Delete circuit "${name}"?`,
      description: 'This permanently removes the saved circuit.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/circuits/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast.success(`Deleted "${name}"`);
      fetchCircuits();
    } catch (err) {
      toast.error('Delete failed: ' + (err as Error).message);
    }
  };

  const filtered = circuits.filter(
    (c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      c.description.toLowerCase().includes(query.toLowerCase()) ||
      c.tags.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl bg-slate-900 border-slate-700 text-slate-100 max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database size={18} className="text-cyan-400" />
            My Circuits
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Save the current circuit to the database, or load a previously saved one. Circuits persist across sessions.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-500" />
            <Input
              placeholder="Search circuits..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8 bg-slate-800 border-slate-700 text-sm"
            />
          </div>
          <Button
            size="sm"
            className="bg-emerald-500 text-slate-900 hover:bg-emerald-400"
            onClick={() => setShowSaveForm(!showSaveForm)}
          >
            <Plus size={14} className="mr-1" />
            Save Current
          </Button>
          <Button size="sm" variant="outline" onClick={fetchCircuits} disabled={loading}>
            Refresh
          </Button>
        </div>

        {showSaveForm && (
          <div className="rounded-md border border-slate-700 bg-slate-800/50 p-3 space-y-2 mb-2">
            <div>
              <Label className="text-xs text-slate-400">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My LED blinker"
                className="bg-slate-800 border-slate-700 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs text-slate-400">Description (optional)</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of what this circuit does"
                className="bg-slate-800 border-slate-700 text-sm min-h-[60px]"
              />
            </div>
            <div>
              <Label className="text-xs text-slate-400">Tags (comma-separated)</Label>
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="led, blinker, beginner"
                className="bg-slate-800 border-slate-700 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setShowSaveForm(false)}>Cancel</Button>
              <Button size="sm" className="bg-emerald-500 text-slate-900 hover:bg-emerald-400" onClick={handleSaveNew}>
                <Save size={12} className="mr-1" />
                Save
              </Button>
            </div>
          </div>
        )}

        <ScrollArea className="h-[400px] rounded-md border border-slate-800">
          <div className="p-2">
            {loading && <div className="text-center py-8 text-sm text-slate-500">Loading...</div>}
            {!loading && filtered.length === 0 && (
              <div className="text-center py-8 text-sm text-slate-500">
                No saved circuits yet. Click "Save Current" to save your work.
              </div>
            )}
            <div className="space-y-2">
              {filtered.map((c) => (
                <div
                  key={c.id}
                  className="rounded-md border border-slate-800 bg-slate-800/40 p-3 hover:border-cyan-500/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-100 truncate">{c.name}</span>
                        {c.isExample && <Badge variant="outline" className="border-cyan-700 text-cyan-300 text-[10px]">example</Badge>}
                      </div>
                      {c.description && (
                        <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{c.description}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-[10px] text-slate-500">
                        <span>{new Date(c.updatedAt).toLocaleDateString()} {new Date(c.updatedAt).toLocaleTimeString()}</span>
                        {c.tagList && c.tagList.length > 0 ? (
                          c.tagList.map((t) => (
                            <Badge
                              key={t}
                              variant="outline"
                              className="h-4 px-1.5 text-[9px] leading-none border-slate-700 bg-slate-800/60 text-slate-400"
                            >
                              {t}
                            </Badge>
                          ))
                        ) : (
                          c.tags && <span>• {c.tags}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-slate-700 bg-slate-800 text-cyan-300 hover:bg-slate-700"
                        onClick={() => handleLoad(c.id, c.name)}
                        disabled={savingId === c.id}
                      >
                        <FolderOpen size={12} className="mr-1" />
                        Load
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
                        onClick={() => handleUpdate(c.id, c.name)}
                      >
                        <Save size={12} className="mr-1" />
                        Update
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-rose-900 bg-rose-950/50 text-rose-300 hover:bg-rose-900/50"
                        onClick={() => handleDelete(c.id, c.name)}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
