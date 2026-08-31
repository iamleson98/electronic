'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPluginsByCategory, getPlugin } from '@/lib/circuit/registry';
import type { ComponentPlugin, PinElecType, TerminalDef } from '@/lib/circuit/types';
import { useEditor } from '@/lib/circuit/store';
import {
  Search,
  Cpu,
  Zap,
  Radio,
  Lightbulb,
  CircuitBoard,
  Gauge,
  Microchip,
  Layers,
  Radar,
  X,
  ChevronDown,
  History,
  Pin,
  Pause,
  MousePointerClick,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { ComponentIcon } from './ComponentIcon';

// ─────────────────────────────────────────────────────────────────────────────
// Category metadata
// ─────────────────────────────────────────────────────────────────────────────

const categoryLabels: Record<string, string> = {
  io: 'Inputs / Outputs',
  source: 'Power Sources',
  passive: 'Passive Components',
  semiconductor: 'Semiconductors',
  ic: 'Integrated Circuits',
  logic: 'Logic Gates',
  meter: 'Meters & Probes',
  mcu: 'Microcontrollers',
  sensor: 'Sensors & Modules',
};

const categoryIcons: Record<string, LucideIcon> = {
  io: Lightbulb,
  source: Zap,
  passive: Radio,
  semiconductor: CircuitBoard,
  ic: Microchip,
  logic: Layers,
  meter: Gauge,
  mcu: Cpu,
  sensor: Radar,
};

// ─────────────────────────────────────────────────────────────────────────────
// Pin electrical-type → colour coding (inputs cyan · outputs emerald ·
// power amber · bidirectional violet · passive/other slate)
// ─────────────────────────────────────────────────────────────────────────────

const PIN_ELEC_COLORS: Record<PinElecType, string> = {
  input: '#22d3ee', // cyan-400
  tri_state: '#a78bfa', // violet-400
  output: '#34d399', // emerald-400
  open_collector: '#34d399',
  open_emitter: '#34d399',
  bidirectional: '#a78bfa', // violet-400
  power_in: '#fbbf24', // amber-400
  power_out: '#fbbf24',
  passive: '#94a3b8', // slate-400
  unconnected: '#64748b',
  nc: '#64748b',
  free: '#94a3b8',
  unspecified: '#94a3b8',
};

const PIN_ELEC_LABELS: Record<PinElecType, string> = {
  input: 'Input',
  output: 'Output',
  bidirectional: 'Bidirectional',
  tri_state: 'Tri-state',
  passive: 'Passive',
  power_in: 'Power In',
  power_out: 'Power Out',
  open_collector: 'Open Collector',
  open_emitter: 'Open Emitter',
  unconnected: 'Unconnected',
  nc: 'No Connect',
  free: 'Free',
  unspecified: 'Unspecified',
};

function pinColor(type: PinElecType | undefined): string {
  return PIN_ELEC_COLORS[type ?? 'passive'] ?? '#94a3b8';
}

function pinLabel(type: PinElecType | undefined): string {
  return PIN_ELEC_LABELS[type ?? 'passive'] ?? 'Passive';
}

/** Colored dot marking a terminal's electrical type. */
function PinDot({ type, className = '' }: { type: PinElecType | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full border border-black/40 ${className}`}
      style={{ backgroundColor: pinColor(type) }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recently-used components (localStorage)
// ─────────────────────────────────────────────────────────────────────────────

const RECENT_KEY = 'circuit-lab.recent-components';
const RECENT_MAX = 8;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string').slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function recordRecent(type: string): string[] {
  const next = [type, ...loadRecent().filter((t) => t !== type)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode etc.) — recents are best-effort
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette
// ─────────────────────────────────────────────────────────────────────────────

export function ComponentPalette() {
  const [query, setQuery] = useState('');
  const startPlacement = useEditor((s) => s.startPlacement);
  const running = useEditor((s) => s.running);
  // Re-fetch the plugin list when a new plugin is registered at runtime
  // (e.g. from the Symbol Editor or Sub-Circuit dialog). Without this the
  // palette memoizes an empty-deps snapshot and never sees the new entry.
  const [registryVersion, setRegistryVersion] = useState(0);
  const groups = useMemo(
    () => getPluginsByCategory(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registryVersion],
  );

  const searching = query.trim().length > 0;

  // Collapsible categories — first category open by default, others collapsed.
  const [openCats, setOpenCats] = useState<ReadonlySet<string>>(() => {
    const first = getPluginsByCategory()[0]?.category;
    return new Set(first ? [first] : []);
  });
  const seenCatsRef = useRef<ReadonlySet<string>>(openCats);
  useEffect(() => {
    const handler = () => setRegistryVersion((v) => v + 1);
    window.addEventListener('circuitlab:plugin-registered', handler);
    return () => window.removeEventListener('circuitlab:plugin-registered', handler);
  }, []);
  // Auto-reveal brand-new categories registered at runtime (Symbol Editor /
  // Sub-Circuit flows) so the user immediately sees what they just created.
  useEffect(() => {
    if (registryVersion === 0) return;
    const fresh = groups
      .map((g) => g.category)
      .filter((c) => !seenCatsRef.current.has(c));
    if (fresh.length === 0) return;
    seenCatsRef.current = new Set([...seenCatsRef.current, ...fresh]);
    setOpenCats((prev) => new Set([...prev, ...fresh]));
  }, [registryVersion, groups]);

  // Recently placed components (click-to-place starts).
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  const recentPlugins = useMemo(
    () =>
      recent
        .map((type) => getPlugin(type))
        .filter((p): p is ComponentPlugin => p !== undefined),
    [recent],
  );

  /** Record a component use (click-to-place OR drag-to-insert) in recents. */
  const handleUse = useCallback((type: string) => {
    setRecent(recordRecent(type));
  }, []);

  /** Click-to-place: enter keyboard placement mode and focus the canvas. */
  const handlePlace = useCallback(
    (type: string) => {
      if (running) return;
      // Enter keyboard placement mode: the ghost appears on the canvas,
      // arrows move it, Enter places, Esc cancels. (Also mouse-friendly:
      // clicking the canvas places there.)
      startPlacement(type, { x: 8, y: 8 });
      handleUse(type);
      // Focus the canvas so arrow keys/Enter land on it — keeps the flow
      // fully keyboard-operable.
      requestAnimationFrame(() => {
        const canvas = document.querySelector('[role="application"]') as HTMLElement | null;
        canvas?.focus();
      });
    },
    [running, startPlacement, handleUse],
  );

  const toggleCategory = useCallback((category: string) => {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    if (!searching) return groups;
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        plugins: g.plugins.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.type.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.symbol.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.plugins.length > 0);
  }, [groups, query, searching]);

  const totalCount = useMemo(() => groups.reduce((n, g) => n + g.plugins.length, 0), [groups]);
  const shownCount = useMemo(
    () => filtered.reduce((n, g) => n + g.plugins.length, 0),
    [filtered],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-900">
      {/* Smooth expand/collapse animation for category sections.
          Radix exposes the measured height as a CSS custom property. */}
      <style>{`
        @keyframes palette-collapse-down {
          from { height: 0; opacity: 0 }
          to { height: var(--radix-collapsible-content-height); opacity: 1 }
        }
        @keyframes palette-collapse-up {
          from { height: var(--radix-collapsible-content-height); opacity: 1 }
          to { height: 0; opacity: 0 }
        }
      `}</style>

      {/* Header */}
      <div className="shrink-0 border-b border-slate-800 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Components
          </h2>
          <span
            className="rounded-full border border-slate-700/70 bg-slate-800/60 px-1.5 py-px font-mono text-[9px] text-slate-400"
            aria-label={`${searching ? `${shownCount} of ${totalCount}` : totalCount} components available`}
          >
            {searching ? `${shownCount}/${totalCount}` : totalCount}
          </span>
        </div>
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <Input
            placeholder="Search components…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search components by name, type, description or symbol"
            className="h-8 border-slate-700/80 bg-slate-800/60 pl-8 pr-7 text-xs text-slate-200 transition-colors duration-150 placeholder:text-slate-500 focus-visible:border-cyan-500/60"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              title="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-slate-500 transition-colors duration-150 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/60"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* List — scrollable. The @container wrapper lets cards collapse to a
          single column when the palette is resized very narrow. */}
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="p-2">
          {filtered.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 p-6 text-center">
              <Search size={16} className="text-slate-600" />
              <p className="text-xs text-slate-500">No components found</p>
              {searching && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="rounded text-[10px] text-cyan-400 transition-colors hover:text-cyan-300 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/60"
                >
                  Clear search
                </button>
              )}
            </div>
          )}

          {/* Recently used — quick re-placement of the last components */}
          {!searching && recentPlugins.length > 0 && (
            <div className="mb-3">
              <div className="mb-1.5 flex items-center gap-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                <History size={11} />
                Recently Used
              </div>
              <div className="flex flex-wrap gap-1">
                {recentPlugins.map((plugin) => (
                  <button
                    key={plugin.type}
                    type="button"
                    onClick={() => handlePlace(plugin.type)}
                    disabled={running}
                    title={running ? 'Pause simulation to add components' : `${plugin.name} — ${plugin.description}`}
                    aria-label={`Place ${plugin.name}`}
                    className="group flex max-w-full items-center gap-1.5 rounded-full border border-slate-700/70 bg-slate-800/50 py-0.5 pl-0.5 pr-2 transition-all duration-150 hover:border-cyan-500/60 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/60"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-700/60 bg-slate-950 text-[9px] leading-none text-cyan-300 transition-colors duration-150 group-hover:border-cyan-500/50">
                      {plugin.symbol}
                    </span>
                    <span className="max-w-[76px] truncate text-[10px] leading-none text-slate-300 transition-colors duration-150 group-hover:text-cyan-100">
                      {plugin.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {filtered.map((group) => {
            const Icon = categoryIcons[group.category] ?? CircuitBoard;
            const label = categoryLabels[group.category] ?? group.category;
            // While searching, matched categories are always expanded.
            const open = searching || openCats.has(group.category);
            return (
              <Collapsible
                key={group.category}
                open={open}
                onOpenChange={(next) => {
                  if (!searching && next !== open) toggleCategory(group.category);
                }}
              >
                <div className="mb-1.5 overflow-hidden rounded-lg border border-slate-800/70 bg-slate-800/25 transition-colors duration-150">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Toggle ${label} category`}
                      className="group flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan-500/60"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-900/80 text-cyan-300/80 transition-colors duration-150 group-hover:text-cyan-300">
                        <Icon size={11} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-slate-400 transition-colors duration-150 group-hover:text-slate-200">
                        {label}
                      </span>
                      <span className="shrink-0 rounded-full border border-slate-700/60 bg-slate-900/60 px-1.5 font-mono text-[9px] leading-4 text-slate-500">
                        {group.plugins.length}
                      </span>
                      <ChevronDown
                        size={12}
                        className={`shrink-0 text-slate-500 transition-transform duration-150 ${open ? '' : '-rotate-90'}`}
                      />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="overflow-hidden px-1.5 pb-1.5 pt-0.5 data-[state=open]:[animation:palette-collapse-down_150ms_ease-out] data-[state=closed]:[animation:palette-collapse-up_100ms_ease-in]">
                    <div className="grid grid-cols-2 gap-1.5 @max-[176px]:grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-2">
                      {group.plugins.map((plugin) => (
                        <PaletteCard
                          key={plugin.type}
                          plugin={plugin}
                          running={running}
                          onPlace={handlePlace}
                          onUse={handleUse}
                        />
                      ))}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
        </div>
      </div>

      {/* Footer hint */}
      <div className="shrink-0 border-t border-slate-800 p-2">
        {running ? (
          <div className="flex items-center justify-center gap-1.5 rounded-md border border-amber-700/40 bg-amber-950/20 px-2 py-1 text-[10px] text-amber-300/90">
            <Pause size={10} />
            Pause simulation to edit
          </div>
        ) : (
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-slate-500">
            <MousePointerClick size={10} />
            Click to place · drag to insert · hover for pins
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component card with rich pin-information hover card
// ─────────────────────────────────────────────────────────────────────────────

function PaletteCard({
  plugin,
  running,
  onPlace,
  onUse,
}: {
  plugin: ComponentPlugin;
  running: boolean;
  onPlace: (type: string) => void;
  /** Fires for both placement paths — click-to-place AND drag-to-insert —
   *  so the Recently Used row always reflects actual usage. */
  onUse: (type: string) => void;
}) {
  const pinCount = plugin.terminals.length;
  const pinWord = pinCount === 1 ? 'pin' : 'pins';
  return (
    <HoverCard openDelay={300} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          draggable={!running}
          onDragStart={(e) => {
            if (running) return;
            e.dataTransfer.setData('application/x-circuit-type', plugin.type);
            e.dataTransfer.effectAllowed = 'copy';
            onUse(plugin.type);
          }}
          onClick={() => onPlace(plugin.type)}
          disabled={running}
          aria-label={`${plugin.name}: ${plugin.description}. ${pinCount} ${pinWord}.`}
          title={running ? 'Pause simulation to add components' : `${plugin.name} — ${plugin.description}`}
          className="group flex flex-col rounded-lg border border-slate-800/80 bg-slate-800/40 p-1.5 text-center transition-all duration-150 hover:-translate-y-0.5 hover:border-cyan-500/60 hover:bg-slate-800/80 hover:shadow-lg hover:shadow-cyan-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-slate-800/80 disabled:hover:bg-slate-800/40 disabled:hover:shadow-none"
        >
          {/* Symbol preview on a subtle gradient (slate-950 → slate-900) */}
          <div className="relative mb-1 flex h-11 items-center justify-center overflow-hidden rounded-md border border-slate-900 bg-gradient-to-b from-slate-950 to-slate-900 transition-colors duration-150 group-hover:border-cyan-500/30">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(34,211,238,0.14),transparent_65%)] opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            <ComponentIcon type={plugin.type} size={38} />
            {/* Pin-count badge — slides in on hover */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-1 top-1 inline-flex translate-y-1 items-center gap-0.5 rounded-sm border border-cyan-500/40 bg-slate-950/90 px-1 font-mono text-[8px] font-medium leading-4 text-cyan-300 opacity-0 shadow-sm shadow-black/50 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100"
            >
              <Pin size={7} className="-ml-px" />
              {pinCount} {pinWord}
            </span>
          </div>
          <span className="block truncate text-[10px] font-medium leading-tight text-slate-300 transition-colors duration-150 group-hover:text-cyan-100">
            {plugin.name}
          </span>
        </button>
      </HoverCardTrigger>

      {/* Rich tooltip: description + full pin list with electrical types */}
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-60 border-slate-700/90 bg-slate-900 p-0 shadow-xl shadow-black/40"
      >
        <div className="border-b border-slate-800 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-cyan-500/30 bg-gradient-to-br from-cyan-500/15 to-transparent text-[11px] font-bold text-cyan-300">
              {plugin.symbol}
            </span>
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-slate-100">{plugin.name}</div>
              <code className="block truncate font-mono text-[9px] text-slate-500">{plugin.type}</code>
            </div>
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-slate-400">{plugin.description}</p>
        </div>

        <div className="max-h-52 overflow-y-auto px-2 py-2">
          {plugin.terminals.map((t) => (
            <PinRow key={t.id} terminal={t} />
          ))}
        </div>

        <div className="border-t border-slate-800 bg-slate-950/60 px-3 py-1.5 text-center text-[10px] text-slate-500">
          {pinCount} {pinWord} · Click to place · Drag to insert
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** One terminal row inside a hover card: dot, label, type, id + pin number. */
function PinRow({ terminal }: { terminal: TerminalDef }) {
  return (
    <div className="rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-slate-800/70">
      <div className="flex items-center gap-1.5">
        <PinDot type={terminal.electricalType} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-100">
          {terminal.label || terminal.id}
        </span>
        <span
          className="shrink-0 text-[9px] font-medium uppercase tracking-wide"
          style={{ color: pinColor(terminal.electricalType) }}
          title={pinLabel(terminal.electricalType)}
        >
          {pinLabel(terminal.electricalType)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-3.5">
        <code className="min-w-0 truncate font-mono text-[9px] text-slate-500">{terminal.id}</code>
        {terminal.number != null && terminal.number !== '' && (
          <span className="shrink-0 rounded bg-slate-800/80 px-1 font-mono text-[9px] leading-4 text-slate-400">
            #{terminal.number}
          </span>
        )}
      </div>
    </div>
  );
}
