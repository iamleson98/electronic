'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HelpCircle, Keyboard, BookOpen, Lightbulb, Code, Sparkles, GraduationCap, Search } from 'lucide-react';
import { exampleCategories, type ExampleEntry } from '@/lib/circuit/examples';
import { exportSchematicSVG } from '@/lib/circuit/schematic-plot';
import { useEditor } from '@/lib/circuit/store';
import {
  getShortcutsByCategory,
  getAllCategories,
  formatShortcut,
} from '@/lib/circuit/keyboard-shortcuts';
import {
  KB_ARTICLES,
  KB_CATEGORIES,
  getArticle,
  searchArticles,
  getArticlesByCategory,
  type KBArticle,
} from '@/lib/ai/knowledge/knowledge-base';

interface Props { open: boolean; onClose: () => void; }

const CATEGORY_LABELS: Record<string, string> = {
  editing: 'Editing',
  history: 'History',
  simulation: 'Simulation',
  tools: 'Tools',
  view: 'View',
  ai: 'AI Assistant',
};

const GETTING_STARTED = [
  { step: 1, title: 'Add components', desc: 'Click a component in the left palette, or drag it onto the canvas.' },
  { step: 2, title: 'Wire components', desc: 'Click on a terminal (green dot) to start a wire. Click another terminal to connect.' },
  { step: 3, title: 'Add ground', desc: 'Every circuit needs a ground reference. Drag a Ground component and wire it.' },
  { step: 4, title: 'Set parameters', desc: 'Click a component, then edit its parameters in the right panel.' },
  { step: 5, title: 'Run simulation', desc: 'Press Space or click Play. Yellow dots show current flow.' },
  { step: 6, title: 'Switch to PCB', desc: 'Click "PCB Layout" at top. Click "Import" to bring your schematic in.' },
  { step: 7, title: '3D view', desc: 'Click "3D View" to see your board in 3D.' },
  { step: 8, title: 'Export', desc: 'Click "Gerbers" to download manufacturing files.' },
];

// ─── Changelog ─────────────────────────────────────────────────────────────
// Append new entries at the top. Bump LAST_SEEN_VERSION when adding entries.
const LAST_SEEN_VERSION = '2026-08-17';
const CHANGELOG_SEEN_KEY = 'circuit-lab.changelog-seen';

interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  items: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '2026-08-17',
    date: 'Aug 17, 2026',
    title: 'Spectrum analysis, net coloring, onboarding',
    items: [
      'New "Spectrum" tab in ProbePanel — FFT bar chart with H1..H10 markers, THD%, SNR, SINAD, harmonic breakdown table.',
      'Wires now color-code by electrical role: ground=slate, power=red, signal=cyan. User-defined NetClass colors override the palette. Toggle in View → Color-Code Wires by Net.',
      'Help → Examples now shows live SVG thumbnails (auto-generated from each example doc), grouped by category.',
      'First-run tutorial: 6-step walkthrough with SVG mask cutouts highlighting the main UI. Skips on subsequent visits.',
      'Color-blind safe ERC icons: errors use ✕, warnings use ! (shape distinction independent of red/amber).',
      'NetClassesDialog gained a color picker column.',
    ],
  },
  {
    version: '2026-08-15',
    date: 'Aug 15, 2026',
    title: 'Reliability & schema migrations',
    items: [
      'Undo/redo preserves full document (drawings, sheets, groups, net classes) — was silently dropping them.',
      'Autosave now actually runs (was dead code) — marks dirty on every mutation, flushes on beforeunload, prompts crash recovery on next load.',
      'Broken sims auto-pause with a user-friendly error message instead of running silently with NaN voltages.',
      'Tab-hidden pause: sim pauses when the tab is backgrounded so it doesn\'t drift from real-time.',
      'Share URLs preserve the full circuit (drawings, sub-sheets, net classes, metadata).',
      'Drizzle schema migrations: versioned SQL in ./drizzle/, auto-applied on startup, idempotent across deploys.',
    ],
  },
  {
    version: '2026-08-12',
    date: 'Aug 12, 2026',
    title: 'SPICE import, AC analysis, Monte Carlo, BSIM3',
    items: [
      'SPICE netlist import — parses R/C/L/V/I/D/Q/M/S cards, engineering suffixes, SINE() sources, auto-creates ground.',
      'Real AC small-signal analysis — DC op point + complex admittance matrix per frequency, returns magnitude/phase/real/imag, finds -3dB cutoff.',
      'Monte Carlo analysis — LCG RNG, Gaussian/uniform distributions, tolerance perturbation, yield %, worst-case 2^N corner analysis.',
      'BSIM3v3 MOSFET model — full threshold, mobility degradation, velocity saturation, channel-length modulation, subthreshold.',
      'Sparse KLU-style solver — CSR + zero-skipping LU, 3-5x speedup on > 80 node circuits.',
      'AI provider selector — choose between Z.ai (always), OpenAI, Anthropic in the ChatPanel header.',
    ],
  },
];

export function HelpDialog({ open, onClose }: Props) {
  // "What's New" badge — shown when there are unseen changelog entries.
  // Marked seen when the user opens the dialog and the changelog tab is viewed
  // (or after 5s of the dialog being open, whichever comes first).
  const [hasUnseen, setHasUnseen] = useState(false);
  useEffect(() => {
    try {
      const seen = localStorage.getItem(CHANGELOG_SEEN_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasUnseen(seen !== LAST_SEEN_VERSION);
    } catch { /* localStorage disabled */ }
  }, []);

  const markSeen = () => {
    try {
      localStorage.setItem(CHANGELOG_SEEN_KEY, LAST_SEEN_VERSION);
      setHasUnseen(false);
    } catch { /* ignore */ }
  };

  // Auto-mark seen after 5s of the dialog being open
  useEffect(() => {
    if (!open || !hasUnseen) return;
    const t = setTimeout(markSeen, 5000);
    return () => clearTimeout(t);
  }, [open, hasUnseen]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden bg-slate-900 border-slate-700">
        <DialogHeader>
          <DialogTitle className="text-slate-100 flex items-center gap-2">
            <HelpCircle size={18} /> Help & Documentation
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue={hasUnseen ? 'whatsnew' : 'shortcuts'} className="w-full">
          <TabsList className="grid w-full grid-cols-6 bg-slate-950">
            <TabsTrigger value="whatsnew" className="data-[state=active]:bg-slate-700 text-xs">
              <Sparkles size={12} className="mr-1" /> What's New
              {hasUnseen && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[9px] bg-amber-500 text-slate-900">new</Badge>}
            </TabsTrigger>
            <TabsTrigger value="shortcuts" className="data-[state=active]:bg-slate-700 text-xs"><Keyboard size={12} className="mr-1" /> Shortcuts</TabsTrigger>
            <TabsTrigger value="guide" className="data-[state=active]:bg-slate-700 text-xs"><BookOpen size={12} className="mr-1" /> Guide</TabsTrigger>
            <TabsTrigger value="examples" className="data-[state=active]:bg-slate-700 text-xs"><Lightbulb size={12} className="mr-1" /> Examples</TabsTrigger>
            <TabsTrigger value="knowledge" className="data-[state=active]:bg-slate-700 text-xs"><GraduationCap size={12} className="mr-1" /> Learn</TabsTrigger>
            <TabsTrigger value="api" className="data-[state=active]:bg-slate-700 text-xs"><Code size={12} className="mr-1" /> API</TabsTrigger>
          </TabsList>
          <TabsContent value="whatsnew" className="mt-4">
            <ScrollArea className="h-[60vh]">
              <div className="space-y-4" onClick={markSeen}>
                {CHANGELOG.map(entry => (
                  <div key={entry.version} className="rounded-md border border-slate-800 bg-slate-950 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-cyan-300">{entry.title}</h3>
                      <span className="font-mono text-[10px] text-slate-500">{entry.date} · v{entry.version}</span>
                    </div>
                    <ul className="space-y-1">
                      {entry.items.map((item, i) => (
                        <li key={i} className="text-xs text-slate-300 leading-relaxed">
                          <span className="mr-2 text-cyan-500">•</span>{item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="shortcuts" className="mt-4">
            <ScrollArea className="h-[60vh]">
              <div className="space-y-4">
                {getAllCategories().map(cat => (
                  <div key={cat}>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">{CATEGORY_LABELS[cat] ?? cat}</h3>
                    <div className="space-y-1">
                      {getShortcutsByCategory(cat).map(s => (
                        <div key={s.key} className="flex items-center justify-between py-1 px-2 rounded hover:bg-slate-800">
                          <span className="text-sm text-slate-300">{s.description}</span>
                          <kbd className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-xs font-mono text-cyan-300">{formatShortcut(s.key)}</kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="guide" className="mt-4">
            <ScrollArea className="h-[60vh]">
              <div className="space-y-4">
                {GETTING_STARTED.map(step => (
                  <div key={step.step} className="flex gap-3 p-3 rounded-md bg-slate-950 border border-slate-800">
                    <div className="shrink-0 w-8 h-8 rounded-full bg-cyan-500 text-slate-900 flex items-center justify-center font-bold text-sm">{step.step}</div>
                    <div><h4 className="text-sm font-medium text-slate-200">{step.title}</h4><p className="text-xs text-slate-400 mt-1">{step.desc}</p></div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="examples" className="mt-4">
            <ExamplesGallery />
          </TabsContent>
          <TabsContent value="knowledge" className="mt-4">
            <KnowledgeBaseBrowser />
          </TabsContent>
          <TabsContent value="api" className="mt-4">
            <ScrollArea className="h-[60vh]">
              <div className="space-y-4 text-xs">
                <div className="p-3 rounded-md bg-slate-950 border border-slate-800">
                  <h4 className="text-sm font-medium text-cyan-300 mb-2">Quick Start</h4>
                  <pre className="bg-slate-900 p-2 rounded text-xs text-slate-300 overflow-x-auto">{`circuitlab.listComponents()
circuitlab.addComponent('resistor', {x: 5, y: 5})
circuitlab.run()
circuitlab.getVoltage('r1:a')`}</pre>
                </div>
                <div className="p-3 rounded-md bg-slate-950 border border-slate-800">
                  <h4 className="text-sm font-medium text-cyan-300 mb-2">Schematic</h4>
                  <ul className="space-y-1 text-slate-400">
                    <li><code className="text-cyan-400">getSchematic()</code> → {`{components, wires}`}</li>
                    <li><code className="text-cyan-400">addComponent(type, pos, params?)</code> → id</li>
                    <li><code className="text-cyan-400">removeComponent(id)</code></li>
                    <li><code className="text-cyan-400">moveComponent(id, pos)</code></li>
                    <li><code className="text-cyan-400">setParameter(id, key, value)</code></li>
                    <li><code className="text-cyan-400">addWire(from, to)</code></li>
                    <li><code className="text-cyan-400">clear()</code></li>
                  </ul>
                </div>
                <div className="p-3 rounded-md bg-slate-950 border border-slate-800">
                  <h4 className="text-sm font-medium text-cyan-300 mb-2">Simulation</h4>
                  <ul className="space-y-1 text-slate-400">
                    <li><code className="text-cyan-400">run() / pause() / step() / reset()</code></li>
                    <li><code className="text-cyan-400">getVoltage('compId:termId')</code> → volts</li>
                    <li><code className="text-cyan-400">getCurrent('compId')</code> → amps</li>
                    <li><code className="text-cyan-400">getNodeVoltages()</code> → number[]</li>
                    <li><code className="text-cyan-400">getTime()</code> → seconds</li>
                  </ul>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ─── Examples gallery with live SVG thumbnails ───────────────────────────────

function ExamplesGallery() {
  const loadDocument = useEditor((s) => s.loadDocument);
  const clear = useEditor((s) => s.clear);

  // Pre-compute SVG thumbnails once per category (deterministic from examples.ts)
  const thumbnails = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of exampleCategories) {
      for (const ex of cat.examples) {
        try {
          const svg = exportSchematicSVG(ex.doc);
          // Strip the XML declaration so it can be inlined as data: URL or HTML
          const cleaned = svg.replace(/^<\?xml[^>]*\?>\s*/, '');
          map.set(`${cat.label}::${ex.name}`, cleaned);
        } catch {
          map.set(`${cat.label}::${ex.name}`, '');
        }
      }
    }
    return map;
  }, []);

  const handleLoad = (ex: ExampleEntry) => {
    clear();
    loadDocument(ex.doc);
  };

  return (
    <ScrollArea className="h-[60vh]">
      <div className="space-y-4">
        {exampleCategories.map((cat) => (
          <div key={cat.label}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{cat.label}</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {cat.examples.map((ex) => {
                const thumb = thumbnails.get(`${cat.label}::${ex.name}`);
                return (
                  <button
                    key={ex.name}
                    onClick={() => handleLoad(ex)}
                    className="cursor-pointer group overflow-hidden rounded-md border border-slate-800 bg-slate-950 text-left transition-colors hover:border-cyan-700 hover:bg-slate-900"
                    title={`Load example: ${ex.name}`}
                  >
                    {/* Thumbnail */}
                    <div
                      className="h-28 w-full overflow-hidden border-b border-slate-800 bg-[#fafafa]"
                      // Inline SVG is safe here — we generate it ourselves from the example docs
                      dangerouslySetInnerHTML={{ __html: thumb || '<div class="flex h-full items-center justify-center text-slate-400 text-xs">No preview</div>' }}
                    />
                    {/* Title + description */}
                    <div className="p-2">
                      <h4 className="text-xs font-medium text-cyan-300 group-hover:text-cyan-200">{ex.name}</h4>
                      <p className="mt-0.5 text-[10px] leading-tight text-slate-500">{ex.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// ─── Knowledge Base Browser ──────────────────────────────────────────────────

function KnowledgeBaseBrowser() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const searchResults = useMemo(() => {
    if (searchQuery.trim()) {
      return searchArticles(searchQuery, 20);
    }
    if (activeCategory) {
      return getArticlesByCategory(activeCategory as KBArticle['category']);
    }
    return KB_ARTICLES;
  }, [searchQuery, activeCategory]);

  const selectedArticle = selectedId ? getArticle(selectedId) : null;

  if (selectedArticle) {
    return <ArticleReader article={selectedArticle} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="flex h-[60vh] gap-3">
      {/* Sidebar: search + categories */}
      <div className="w-56 shrink-0 space-y-3">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setActiveCategory(null); }}
            placeholder="Search articles..."
            className="w-full rounded border border-slate-700 bg-slate-900 py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <div className="space-y-0.5">
          <button
            className={`w-full cursor-pointer rounded px-2 py-1 text-left text-xs ${!activeCategory && !searchQuery ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:bg-slate-800'}`}
            onClick={() => { setActiveCategory(null); setSearchQuery(''); }}
          >
            All Articles ({KB_ARTICLES.length})
          </button>
          {KB_CATEGORIES.map(cat => {
            const count = getArticlesByCategory(cat.id).length;
            return (
              <button
                key={cat.id}
                className={`w-full cursor-pointer rounded px-2 py-1 text-left text-xs ${activeCategory === cat.id ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:bg-slate-800'}`}
                onClick={() => { setActiveCategory(cat.id); setSearchQuery(''); }}
              >
                {cat.icon} {cat.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Main: article list */}
      <div className="min-w-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-2">
            {searchResults.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                No articles found for &quot;{searchQuery}&quot;
              </div>
            ) : (
              searchResults.map(article => (
                <button
                  key={article.id}
                  onClick={() => setSelectedId(article.id)}
                  className="block w-full cursor-pointer rounded-md border border-slate-800 bg-slate-950 p-3 text-left transition-colors hover:border-cyan-700 hover:bg-slate-900"
                >
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-cyan-300">{article.title}</h4>
                    <span className="text-[10px] text-slate-500">{article.category}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{article.summary}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {article.tags.slice(0, 4).map(tag => (
                      <span key={tag} className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-400">{tag}</span>
                    ))}
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function ArticleReader({ article, onBack }: { article: KBArticle; onBack: () => void }) {
  return (
    <div className="flex h-[60vh] flex-col">
      <button
        onClick={onBack}
        className="mb-3 flex cursor-pointer items-center gap-1 text-xs text-slate-400 hover:text-cyan-300"
      >
        ← Back to Knowledge Base
      </button>
      <ScrollArea className="flex-1">
        <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-cyan-300">{article.title}</h3>
            <span className="text-[10px] uppercase tracking-wider text-slate-500">{article.category}</span>
          </div>
          <p className="mb-4 text-sm text-slate-400">{article.summary}</p>
          <div className="mb-4 flex flex-wrap gap-1">
            {article.tags.map(tag => (
              <span key={tag} className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">{tag}</span>
            ))}
          </div>
          <div className="prose prose-invert max-w-none">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-300">{article.body}</pre>
          </div>
          {article.related && article.related.length > 0 && (
            <div className="mt-6 border-t border-slate-800 pt-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Related Articles</h4>
              <div className="flex flex-wrap gap-2">
                {article.related.map(rid => {
                  const r = getArticle(rid);
                  if (!r) return null;
                  return (
                    <button
                      key={rid}
                      onClick={() => { /* navigation handled by parent state */ }}
                      className="cursor-pointer rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 hover:border-cyan-700"
                    >
                      {r.title}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
