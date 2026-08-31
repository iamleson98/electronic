// AI Chat Session — client-side store + resilient streaming engine.
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the per-component chat state that used to live inside ChatPanel:
//
//  • Zustand store holding the whole conversation (survives panel close —
//    the AI keeps building in the background and the panel reopens mid-turn).
//  • A module-level turn engine that talks to the resumable server turns
//    (/api/ai/chat/stream with `resume.turnId`):
//      - auto-reconnects with exponential backoff when the network drops;
//        the server-side turn never stopped, so the client replays the event
//        log and continues exactly where it left off;
//      - suppresses side effects for already-applied replayed events via a
//        seq watermark (no double circuit loads, no duplicate undo entries);
//      - auto-restarts the request once if the server lost the turn
//        (restart/deploy mid-conversation);
//      - resumes an interrupted turn after a full page reload (sessionStorage).
//  • Auto-apply by default: AI circuit changes land on the canvas LIVE, one
//    history checkpoint per turn (one Ctrl+Z reverts the whole AI change).
//  • User controls: Stop (out-of-band cancel), Retry (re-send last message),
//    per-turn Undo.

import { create } from 'zustand';
import { useEditor } from '@/lib/circuit/store';
import { usePCB } from '@/lib/pcb/store';
import { parseSseStream } from './sse';
import { toast } from 'sonner';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCallEntry {
  name: string;
  args: any;
  result?: any;
  error?: string;
  ok: boolean;
  /** True while this call is in flight (last call of the ACTIVE turn only). */
  pending?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallEntry[];
  timestamp: number;
  loading?: boolean;
  error?: string;
  /** 'config' = the AI backend isn't configured (deployment missing API keys) — renders a setup card. */
  errorKind?: 'config';
  /** True when a Retry button should be offered (transient failures). */
  retryable?: boolean;
  /** The user stopped this turn mid-flight. */
  stopped?: boolean;
  pendingDiff?: {
    components: any[];
    wires: any[];
    summary: string;
  };
  /** Changes from this turn were applied to the canvas (auto mode). */
  applied?: boolean;
  appliedSummary?: string;
  /** The circuit doc as applied — drives the BOM / wire-connections card. */
  appliedDoc?: { components: any[]; wires: any[] };
  /**
   * Component types the AI asked for but that are missing from the library.
   * Rendered as a prominent amber "Missing components" card so the user knows
   * exactly what to add (Symbol Editor / Sub-Circuit) to unblock the AI.
   */
  missingComponents?: string[];
  /** True when this turn updated the PCB (server-side) — shows a PCB chip. */
  pcbUpdated?: boolean;
  /** Live working-progress narration (the raw streamed text). Shown inside the
   *  collapsible progress accordion — it no longer grows the message bubble. */
  progressText?: string;
  /** Wall-clock duration of the finished turn (for the "Worked for Xs" title). */
  durationMs?: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type ActivePhase =
  | 'connecting'     // initial fetch
  | 'streaming'      // receiving events
  | 'reconnecting'   // network drop — retrying with backoff
  | 'restarting'     // server lost the turn — fresh restart
  | 'stopping';      // user pressed Stop

export interface ActiveTurn {
  turnId: string | null;
  assistantMsgId: string;
  phase: ActivePhase;
  /** Human-readable live activity ("Building circuit…", "Reconnecting (2)…"). */
  statusText: string;
  reconnectAttempt: number;
  startedAt: number;
}

interface ProviderInfo {
  name: 'zai' | 'openai' | 'anthropic';
  label: string;
  available: boolean;
  requiresKey: string | null;
  model: string;
  models: { id: string; label: string; description: string; free: boolean }[];
  mode?: 'api-key' | 'sandbox' | 'unconfigured';
}

interface ChatSessionState {
  messages: ChatMessage[];
  active: ActiveTurn | null;
  /** Auto-apply AI circuit changes to the canvas (default ON). Persisted. */
  autoApply: boolean;
  /** Cumulative token usage across the session. */
  totalTokens: { prompt: number; completion: number; total: number };
  // Provider / model selection (persisted to localStorage)
  providers: ProviderInfo[];
  selectedProvider: 'zai' | 'openai' | 'anthropic';
  selectedModel: string;
  providersLoading: boolean;

  initProviders(): Promise<void>;
  setProvider(name: 'zai' | 'openai' | 'anthropic'): void;
  setModel(model: string): void;
  setAutoApply(v: boolean): void;
  resetTokens(): void;

  send(text: string): void;
  stop(): void;
  retryLast(): void;
  applyPendingDiff(msgId: string): void;
  dismissPendingDiff(msgId: string): void;
  /** Re-attach to a turn that was in flight when the page reloaded. */
  resumeAfterReload(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants / persistence helpers
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_STORAGE_KEY = 'circuit-lab.ai-provider';
const MODEL_STORAGE_KEY = 'circuit-lab.ai-model';
const AUTO_APPLY_STORAGE_KEY = 'circuit-lab.ai-auto-apply';
const ACTIVE_TURN_STORAGE_KEY = 'circuit-lab.ai.active-turn';
const CLIENT_ID_STORAGE_KEY = 'circuit-lab.ai.client-id';

const MAX_RECONNECTS = 10;
const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 20_000, 20_000, 20_000, 30_000, 30_000];
const MAX_HISTORY_MESSAGES = 40;   // sent to the API per request
const RELOAD_RESUME_MAX_AGE_MS = 9 * 60_000;

/** Live status label per tool — what the user sees while the AI works. */
const TOOL_STATUS_LABELS: Record<string, string> = {
  'design.calculate': 'Calculating component values…',
  'design.buildPattern': 'Building circuit…',
  'schematic.addComponent': 'Adding components…',
  'schematic.addWire': 'Wiring components…',
  'schematic.removeComponent': 'Removing components…',
  'schematic.removeWire': 'Removing wires…',
  'schematic.moveComponent': 'Moving components…',
  'schematic.rotateComponent': 'Rotating components…',
  'schematic.setParameter': 'Adjusting values…',
  'schematic.clear': 'Clearing the schematic…',
  'schematic.loadDocument': 'Loading circuit…',
  'schematic.reannotate': 'Renumbering references…',
  'schematic.undo': 'Undoing your last change…',
  'schematic.redo': 'Redoing…',
  'schematic.runERC': 'Running ERC…',
  'examples.load': 'Loading example…',
  'simulate.run': 'Running simulation…',
  'simulate.solveDC': 'Solving DC operating point…',
  'simulate.validatePhysics': 'Validating physics…',
  'simulate.start': 'Starting simulation…',
  'simulate.acAnalysis': 'Sweeping frequency response…',
  'simulate.fourier': 'Analyzing harmonics…',
  'simulate.sweep': 'Sweeping parameters…',
  'simulate.whatIf': 'Testing what-if…',
  'ai.diagnose': 'Diagnosing circuit…',
  'verify.autoCheck': 'Verifying circuit…',
  'circuit.walkthrough': 'Analyzing circuit…',
  'kb.search': 'Searching knowledge base…',
  'kb.lookup': 'Looking up theory…',
  'concept.explain': 'Preparing explanation…',
  'pcb.importFromSchematic': 'Importing to PCB…',
  'pcb.autoRoute': 'Routing PCB…',
  'pcb.topoRoute': 'Routing PCB…',
  'pcb.runDRC': 'Running DRC…',
  'pcb.verifyNetlist': 'Verifying PCB netlist…',
  'pcb.addCopperPour': 'Pouring copper…',
  'export.spiceNetlist': 'Exporting netlist…',
  'export.bomCSV': 'Building BOM…',
};

/** Past-tense step labels for the Steps accordion — null = derive from the name. */
const TOOL_STEP_LABELS: Record<string, string> = {
  'design.calculate': 'Calculated component values',
  'design.buildPattern': 'Built circuit',
  'schematic.addComponent': 'Added components',
  'schematic.addWire': 'Wired components',
  'schematic.removeComponent': 'Removed components',
  'schematic.removeWire': 'Removed wires',
  'schematic.moveComponent': 'Moved components',
  'schematic.rotateComponent': 'Rotated components',
  'schematic.setParameter': 'Adjusted values',
  'schematic.clear': 'Cleared the schematic',
  'schematic.loadDocument': 'Loaded circuit',
  'schematic.reannotate': 'Renumbered references',
  'schematic.undo': 'Undid your last change',
  'schematic.redo': 'Redid a change',
  'schematic.runERC': 'Ran ERC',
  'examples.load': 'Loaded example',
  'simulate.run': 'Ran simulation',
  'simulate.solveDC': 'Solved DC operating point',
  'simulate.validatePhysics': 'Validated physics',
  'simulate.start': 'Started live simulation',
  'simulate.pause': 'Paused simulation',
  'simulate.reset': 'Reset simulation',
  'simulate.acAnalysis': 'Swept frequency response',
  'simulate.fourier': 'Analyzed harmonics (THD)',
  'simulate.sweep': 'Swept parameters',
  'simulate.whatIf': 'Tested what-if scenario',
  'ai.diagnose': 'Diagnosed circuit',
  'verify.autoCheck': 'Verified circuit',
  'circuit.walkthrough': 'Analyzed circuit topology',
  'kb.search': 'Searched knowledge base',
  'kb.lookup': 'Looked up theory',
  'concept.explain': 'Prepared explanation',
  'pcb.importFromSchematic': 'Imported to PCB',
  'pcb.autoRoute': 'Auto-routed PCB',
  'pcb.topoRoute': 'Routed PCB',
  'pcb.runDRC': 'Ran DRC',
  'pcb.verifyNetlist': 'Verified PCB netlist',
  'pcb.addCopperPour': 'Poured copper',
  'export.spiceNetlist': 'Exported SPICE netlist',
  'export.bomCSV': 'Built BOM',
};

/** Friendly label for a tool call in the Steps list ("Ran simulation"). */
export function stepLabelFor(toolName: string): string {
  if (TOOL_STEP_LABELS[toolName]) return TOOL_STEP_LABELS[toolName];
  if (TOOL_STATUS_LABELS[toolName]) return TOOL_STATUS_LABELS[toolName].replace(/…$/, '');
  // Derive from the name: "schematic.addComponent" → "addComponent"
  const tail = toolName.includes('.') ? toolName.split('.').slice(1).join('.') : toolName;
  return tail.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Live status for a tool while it runs ("Running simulation…"). */
export function statusLabelFor(toolName: string): string {
  return TOOL_STATUS_LABELS[toolName] ?? `Running ${toolName}…`;
}

function localStorageGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, value); } catch { /* disabled */ }
}

function getClientId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    let id = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (!id) {
      id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
    }
    return id;
  } catch { return 'unknown'; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJsonParse(s: any): any {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

/** Marker thrown when the server lost the turn (restart / GC). */
class TurnLostError extends Error {
  constructor() { super('turn lost'); this.name = 'TurnLostError'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn runtime (module-level — outlives React component lifecycles)
// ─────────────────────────────────────────────────────────────────────────────

interface CircuitSnapshot { components: any[]; wires: any[]; }

interface TurnRuntime {
  assistantMsgId: string;
  /** Server-side turn id (null until the `turn` event arrives). */
  turnId: string | null;
  /** Watermark: server events with seq <= this have already had their side
   *  effects applied (circuit loads, client actions). Replayed events at or
   *  below it only update derived state. */
  appliedSeq: number;
  text: string;
  toolCalls: ToolCallEntry[];
  /** The circuit snapshot captured when the request was sent (diff baseline). */
  originalCircuit: CircuitSnapshot;
  /** JSON of the last circuit doc actually loaded into the editor (dedupe). */
  lastAppliedDocJson: string | null;
  /** The last circuit doc seen (circuit_update or done). */
  finalDoc: CircuitSnapshot | null;
  /** History checkpoint pushed for this turn already (one Ctrl+Z per turn). */
  historyPushed: boolean;
  finalized: boolean;
  /** The original POST body (persisted so a page reload can resume). */
  requestBody?: any;
}

let runtime: TurnRuntime | null = null;
let abortCtrl: AbortController | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Side-effect helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Load a circuit doc into the editor. The undo checkpoint is pushed ONCE per
 *  turn (before the first mutation), so a single Ctrl+Z reverts the whole AI
 *  change instead of stepping through every intermediate state. keepHistory
 *  stops loadDocument from wiping that checkpoint (its default), and
 *  preserveUserState keeps every other document field (drawings, sheets,
 *  no-connects, net classes, page setup, metadata, a running sim) that the
 *  AI's components+wires-only event never describes. */
function applyCircuitUpdate(rt: TurnRuntime, doc: CircuitSnapshot, seq: number): void {
  const editor = useEditor.getState();
  if (!rt.historyPushed) {
    editor.pushHistory();
    rt.historyPushed = true;
  }
  editor.loadDocument(
    { version: 1, components: doc.components, wires: doc.wires },
    { keepHistory: true, preserveUserState: true },
  );
  rt.lastAppliedDocJson = JSON.stringify(doc);
  rt.appliedSeq = Math.max(rt.appliedSeq, seq);
}

/**
 * Load a server-side PCB snapshot (pcb_update / done.pcb payload) into the PCB
 * store so the user sees the AI's layout work live. Full-doc load — idempotent
 * and safe to re-apply on event replay after a reconnect.
 */
function applyPcbUpdate(doc: any): void {
  try {
    const pcb = usePCB.getState();
    const activeLayer = pcb.activeLayer;
    const defaultTraceWidth = pcb.defaultTraceWidth;
    pcb.loadDocument({
      version: 1,
      board: doc.board ?? { width: 80, height: 60 },
      footprints: doc.footprints ?? [],
      traces: doc.traces ?? [],
      vias: doc.vias ?? [],
      activeLayer,
      defaultTraceWidth,
      padNets: Array.isArray(doc.padNets) ? doc.padNets : [],
    } as any);
    // loadDocument resets the ratsnest — restore the server's copy (drives
    // the unrouted-connection rendering + further routing runs).
    if (Array.isArray(doc.ratsnest) && doc.ratsnest.length > 0) {
      usePCB.setState({ ratsnest: doc.ratsnest });
    }
  } catch (e) {
    console.warn('[chat-session] pcb_update apply failed:', e);
  }
}

/**
 * Tools that act on the client stores. Called for tool_call events whose
 * RESULT carries an `action` field (the client-queued convention) — the
 * server-executed PCB tools (import/autoRoute/topoRoute/DRC/verifyNetlist)
 * return real results without an action field and sync via pcb_update events
 * instead, so they must NOT be double-executed here.
 */
function runClientSideAction(name: string, args: any, result?: any): void {
  try {
    const editor = useEditor.getState();
    const pcb = usePCB.getState();
    if (name === 'simulate.start') {
      editor.setRunning(true);
    } else if (name === 'simulate.pause') {
      editor.setRunning(false);
    } else if (name === 'simulate.reset') {
      editor.reset();
    } else if (name === 'simulate.setSpeed') {
      editor.setSpeed(args?.speed);
    } else if (name === 'pcb.setBoardSize') {
      if (result?.applied === 'server') return; // already applied via pcb_update
      pcb.setBoardSize(args?.width, args?.height);
    } else if (name === 'pcb.setDefaultTraceWidth') {
      pcb.setDefaultTraceWidth(args?.width);
    } else if (name === 'pcb.setActiveLayer') {
      pcb.setActiveLayer(args?.layer);
    } else if (name === 'pcb.addCopperPour') {
      pcb.addCopperPour(args?.layer, args?.net);
    } else if (name === 'pcb.generateTeardrops') {
      pcb.generateTeardrops();
    }
  } catch (e) {
    console.warn(`[chat-session] client action ${name} failed:`, e);
  }
}

function summarizeDiff(doc: CircuitSnapshot, original: CircuitSnapshot): string {
  const dc = doc.components.length - original.components.length;
  const dw = doc.wires.length - original.wires.length;
  return `${dc >= 0 ? '+' : ''}${dc} component${Math.abs(dc) === 1 ? '' : 's'}, ${dw >= 0 ? '+' : ''}${dw} wire${Math.abs(dw) === 1 ? '' : 's'}`;
}

function circuitDiffers(doc: CircuitSnapshot, original: CircuitSnapshot): boolean {
  return (
    doc.components.length !== original.components.length ||
    doc.wires.length !== original.wires.length ||
    JSON.stringify(doc.components) !== JSON.stringify(original.components)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Store-state helpers
// ─────────────────────────────────────────────────────────────────────────────

function patchAssistantMessage(msgId: string, patch: Partial<ChatMessage>): void {
  useChatSession.setState(s => ({
    messages: s.messages.map(m => (m.id === msgId ? { ...m, ...patch } : m)),
  }));
}

function updateAssistantFromRuntime(rt: TurnRuntime): void {
  // While the turn is ACTIVE the streamed narration lives in `progressText`
  // (rendered inside the collapsible progress accordion) — the message bubble
  // itself no longer grows line by line. `content` is filled once by the
  // finalizer with the final answer.
  patchAssistantMessage(rt.assistantMsgId, {
    content: '',
    progressText: rt.text,
    toolCalls: [...rt.toolCalls],
    loading: true,
  });
}

function setPhase(phase: ActivePhase, statusText: string, reconnectAttempt = 0): void {
  useChatSession.setState(s => (s.active ? { active: { ...s.active, phase, statusText, reconnectAttempt } } : {}));
}

function setStatusText(statusText: string): void {
  useChatSession.setState(s => {
    if (!s.active) return {};
    const phase: ActivePhase =
      s.active.phase === 'stopping' ? 'stopping'
      : s.active.phase === 'reconnecting' || s.active.phase === 'restarting' ? 'streaming'
      : s.active.phase;
    return { active: { ...s.active, phase, statusText } };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// sessionStorage persistence (page-reload resume)
// ─────────────────────────────────────────────────────────────────────────────

interface PersistedActiveTurn {
  turnId: string;
  assistantMsgId: string;
  userText: string;
  requestBody: any;
  startedAt: number;
  /** Conversation as of the last persist (active assistant message content
   *  may lag — the event replay rebuilds it). */
  messages: ChatMessage[];
}

function persistActiveTurn(): void {
  if (typeof window === 'undefined') return;
  const rt = runtime;
  const s = useChatSession.getState();
  if (!rt || !rt.turnId || !s.active) return;
  const userText = [...s.messages].reverse().find(m => m.role === 'user')?.content ?? '';
  const rec: PersistedActiveTurn = {
    turnId: rt.turnId,
    assistantMsgId: rt.assistantMsgId,
    userText,
    requestBody: rt.requestBody,
    startedAt: s.active.startedAt,
    messages: s.messages.slice(-MAX_HISTORY_MESSAGES),
  };
  try { window.sessionStorage.setItem(ACTIVE_TURN_STORAGE_KEY, JSON.stringify(rec)); } catch { /* full */ }
}

function readPersistedTurn(): PersistedActiveTurn | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_TURN_STORAGE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as PersistedActiveTurn;
    if (!rec?.turnId || !rec?.requestBody) return null;
    return rec;
  } catch { return null; }
}

function clearPersistedTurn(): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(ACTIVE_TURN_STORAGE_KEY); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalizers
// ─────────────────────────────────────────────────────────────────────────────

function cleanupRuntime(): void {
  runtime = null;
  abortCtrl = null;
  clearPersistedTurn();
  useChatSession.setState({ active: null });
}

/**
 * Last-resort teardown for when a finalizer itself blows up mid-work: force
 * the assistant message into a visible error state. If even THIS patch fails,
 * the finalizer's finally-block still clears `active`/`runtime` — the only
 * hard invariant is that send() can never stay permanently blocked.
 */
function forceTeardown(rt: TurnRuntime, fallbackMessage: string): void {
  try {
    patchAssistantMessage(rt.assistantMsgId, {
      content: fallbackMessage,
      progressText: rt.text || undefined,
      loading: false,
      error: 'true',
      retryable: false,
      toolCalls: [...rt.toolCalls],
    });
  } catch (e) {
    console.error('[chat-session] fallback teardown failed:', e);
  }
}

function finalizeError(rt: TurnRuntime, message: string, retryable: boolean, errorKind?: 'config'): void {
  if (rt.finalized) return;
  try {
    const isConfig = errorKind === 'config' || /not configured|ZAI_API_KEY|set the .*API_KEY/i.test(message);
    const isRateLimit = /429|rate.?limit|too many requests/i.test(message);
    const durationMs = Date.now() - (useChatSession.getState().active?.startedAt ?? Date.now());
    let friendly = `Sorry, I encountered an error: ${message}`;
    if (isRateLimit) {
      friendly = 'The AI service quota is temporarily exhausted (429 — every request is being rejected right now). ' +
        'This is a server-side limit that clears on its own — usually within a few minutes. Press Retry after a short wait — your message and circuit are preserved.';
    }
    patchAssistantMessage(rt.assistantMsgId, {
      content: isConfig ? 'AI backend not configured on this server.' : friendly,
      progressText: rt.text || undefined,
      durationMs,
      loading: false,
      error: 'true',
      errorKind: isConfig ? 'config' : undefined,
      retryable: (retryable || isRateLimit) && !isConfig,
      toolCalls: [...rt.toolCalls],
    });
    toast.error(isConfig ? 'AI backend not configured — see setup instructions' : isRateLimit ? 'AI provider rate-limited — wait a moment and press Retry' : 'AI request failed');
  } catch (e) {
    console.error('[chat-session] finalizeError failed:', e);
    forceTeardown(rt, 'Sorry — an internal error occurred while finishing this AI response.');
  } finally {
    // Flip the flag only AFTER the work. The old order (flag first, work
    // second) let a mid-finalize exception escape with finalized already
    // set: runTurnEngine then returned silently, `active` stayed set,
    // message.loading stayed true forever and send() was permanently blocked.
    rt.finalized = true;
    cleanupRuntime();
  }
}

function finalizeStopped(rt: TurnRuntime): void {
  if (rt.finalized) return;
  try {
    const durationMs = Date.now() - (useChatSession.getState().active?.startedAt ?? Date.now());
    patchAssistantMessage(rt.assistantMsgId, {
      content: rt.text,
      // content === progressText here (partial answer IS the whole stream) —
      // the UI hides the progress accordion when they match, so no duplication.
      progressText: rt.text || undefined,
      durationMs,
      loading: false,
      stopped: true,
      toolCalls: [...rt.toolCalls],
    });
  } catch (e) {
    console.error('[chat-session] finalizeStopped failed:', e);
    forceTeardown(rt, 'Stopped — but the partial response could not be finalized.');
  } finally {
    rt.finalized = true;
    cleanupRuntime();
  }
}

function finalizeDone(rt: TurnRuntime, data: any): void {
  if (rt.finalized) return;
  try {
    const state = useChatSession.getState();
    const response: string = data.response ?? rt.text;
    const finalDoc: CircuitSnapshot | null = data.circuit ?? rt.finalDoc ?? null;
    const durationMs = Date.now() - (state.active?.startedAt ?? Date.now());

    // The streamed narration may end with the final answer (the model streams
    // its reply as the last chunk of the same turn) — trim that suffix so the
    // progress accordion shows only the working narration, never a duplicate.
    let progressText = rt.text;
    if (response && progressText.endsWith(response)) {
      progressText = progressText.slice(0, progressText.length - response.length).trimEnd();
    }

    let applied = false;
    let appliedSummary = '';
    let appliedDoc: CircuitSnapshot | undefined;

    if (state.autoApply && finalDoc) {
      // Only claim "applied" when the circuit actually changed — a pure
      // explanation turn or a timeout-before-any-work turn must NOT show a
      // misleading "+0 components" bar.
      const changed = circuitDiffers(finalDoc, rt.originalCircuit);
      const docJson = JSON.stringify(finalDoc);
      if (changed && docJson !== rt.lastAppliedDocJson) {
        // Final doc differs from the last applied intermediate (or nothing was
        // applied yet — e.g. reload resume): load it now.
        applyCircuitUpdate(rt, finalDoc, Number.MAX_SAFE_INTEGER);
        toast.success('Circuit updated by AI — press Ctrl+Z to undo');
      }
      if (changed) {
        applied = true;
        appliedSummary = summarizeDiff(finalDoc, rt.originalCircuit);
        appliedDoc = finalDoc;
      }
    } else if (!state.autoApply && finalDoc && circuitDiffers(finalDoc, rt.originalCircuit)) {
      // Review mode — leave as a pending diff for the user to accept.
      patchAssistantMessage(rt.assistantMsgId, {
        pendingDiff: {
          components: finalDoc.components,
          wires: finalDoc.wires,
          summary: summarizeDiff(finalDoc, rt.originalCircuit),
        },
      });
    }

    // Server-side PCB snapshot in the done payload — normally already applied
    // via a live pcb_update event, but a page-reload resume or review-mode flow
    // may only see it here. Apply unconditionally (idempotent full-doc load).
    let pcbUpdated = false;
    if (data.pcb && Array.isArray(data.pcb.footprints)) {
      applyPcbUpdate(data.pcb);
      pcbUpdated = true;
    }

    // Missing components (done payload) — merge with any live-detected ones.
    const missingList = Array.isArray(data.missingComponents)
      ? Array.from(new Set([...(useChatSession.getState().messages.find(m => m.id === rt.assistantMsgId)?.missingComponents ?? []), ...data.missingComponents]))
      : undefined;

    const usage = data.usage;
    if (usage) {
      useChatSession.setState(s => ({
        totalTokens: {
          prompt: s.totalTokens.prompt + (usage.prompt_tokens || 0),
          completion: s.totalTokens.completion + (usage.completion_tokens || 0),
          total: s.totalTokens.total + (usage.total_tokens || 0),
        },
      }));
    }

    patchAssistantMessage(rt.assistantMsgId, {
      content: response,
      progressText: progressText || undefined,
      durationMs,
      loading: false,
      toolCalls: [...rt.toolCalls],
      applied,
      appliedSummary,
      ...(appliedDoc ? { appliedDoc } : {}),
      ...(missingList && missingList.length > 0 ? { missingComponents: missingList } : {}),
      ...(pcbUpdated ? { pcbUpdated: true } : {}),
      usage,
    });
  } catch (e) {
    // The final circuit apply (loadDocument/pushHistory on a possibly
    // inconsistent store) is the realistic thrower — never let it wedge the
    // session: the user still gets a message they can act on.
    console.error('[chat-session] finalizeDone failed (final apply threw):', e);
    forceTeardown(rt, 'Sorry — I finished the work but an internal error occurred while applying the final result to your circuit.');
  } finally {
    rt.finalized = true;
    cleanupRuntime();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The streaming engine
// ─────────────────────────────────────────────────────────────────────────────

interface EngineOptions {
  requestBody: any;
  assistantMsgId: string;
}

/**
 * Run one AI turn to completion, surviving network drops. Reconnects resume
 * the SAME server-side turn (full event replay + side-effect suppression via
 * the seq watermark); if the server lost the turn, restarts the request once.
 */
async function runTurnEngine(opts: EngineOptions): Promise<void> {
  let resume: { turnId: string } | null = null;
  let reconnectAttempt = 0;
  let turnLostRestarts = 0;

  for (;;) {
    const rt = runtime;
    if (!rt || rt.finalized) return;

    try {
      await streamOnce(opts, resume);
      return; // finalized (done / error / cancelled handled inside streamOnce)
    } catch (e: any) {
      const cur = runtime;
      if (!cur || cur.finalized) return;
      if (e?.name === 'AbortError' || abortCtrl?.signal.aborted) return; // user Stop
      if (e instanceof TurnLostError) {
        // Server restarted / turn GC'd. Restart the request ONCE — the AI
        // redoes the work from the original snapshot (circuit updates are
        // full-document loads, so the canvas converges).
        if (turnLostRestarts < 1) {
          turnLostRestarts++;
          setPhase('restarting', 'AI session was interrupted — restarting your request…');
          await sleep(1_500);
          const rt2 = runtime;
          if (!rt2 || rt2.finalized || abortCtrl?.signal.aborted) return;
          rt2.turnId = null;
          rt2.appliedSeq = 0;
          rt2.text = '';
          rt2.toolCalls = [];
          updateAssistantFromRuntime(rt2);
          resume = null;
          reconnectAttempt = 0;
          continue;
        }
        finalizeError(cur, 'The AI session was lost (server restarted) and could not be restarted.', true);
        return;
      }

      // Network failure — reconnect (resume the turn) with backoff.
      if (reconnectAttempt >= MAX_RECONNECTS) {
        finalizeError(cur, `Connection lost after ${reconnectAttempt} attempts: ${e?.message || e}`, true);
        return;
      }
      const delay = RECONNECT_BACKOFFS_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1)];
      reconnectAttempt++;
      setPhase('reconnecting', `Connection lost — retrying in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}/${MAX_RECONNECTS})…`, reconnectAttempt);
      await sleep(delay);
      const rt3 = runtime;
      if (!rt3 || rt3.finalized || abortCtrl?.signal.aborted) return;

      if (rt3.turnId) {
        // Resume the same server-side turn. The replay rebuilds derived state;
        // the appliedSeq watermark suppresses already-applied side effects.
        resume = { turnId: rt3.turnId };
        // Reset derived state — the replay re-sends every event from seq 0.
        rt3.text = '';
        rt3.toolCalls = [];
        updateAssistantFromRuntime(rt3);
      } else {
        // The server never told us the turn id (died at connect) — plain retry.
        resume = null;
      }
    }
  }
}

/** One SSE connection attempt. Returns when the turn finalizes; throws on
 *  network failure / TURN_LOST so the engine can retry. */
async function streamOnce(opts: EngineOptions, resume: { turnId: string } | null): Promise<void> {
  const rt = runtime;
  if (!rt) return;

  const body = resume ? { ...opts.requestBody, resume: { turnId: resume.turnId } } : opts.requestBody;
  const res = await fetch('/api/ai/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortCtrl?.signal,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}: ${res.statusText}`;
    let code: string | undefined;
    try {
      const j = await res.json();
      if (j?.error) detail = j.error;
      if (j?.code) code = j.code;
    } catch { /* body wasn't JSON */ }
    if ((res.status >= 500 || res.status === 429) && !code) {
      // Transient server trouble — throw so the engine retries.
      throw new Error(detail);
    }
    finalizeError(rt, detail, res.status === 429, code === 'AI_NOT_CONFIGURED' || /not configured/i.test(detail) ? 'config' : undefined);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response stream');

  // A resumed connection replays the FULL event log first. Derived state was
  // reset by the engine; the watermark decides which events still owe side
  // effects. A fresh connection receives live events only.
  const isResume = !!resume;
  let sawFinal = false;
  let announcedLive = false;

  for await (const ev of parseSseStream(reader)) {
    const cur = runtime;
    if (!cur || cur.finalized) return; // engine reset elsewhere (Stop)
    if (!ev.json) continue;
    try {
      // ── event dispatch ──────────────────────────────────────────────────
      // Everything in this block is local turn bookkeeping + side effects
      // (circuit loads, client actions, message patches). An exception here
      // is an INTERNAL failure, NOT a network drop — it must not be retried
      // (a reconnect would replay the same event into the same crashing
      // handler up to 10 times and end in a misleading "Connection lost").
      // The catch below distinguishes the two cases.
      const data = ev.json;
      const type = ev.event || 'message';
      const seq = typeof data.seq === 'number' ? data.seq : 0;
      /** Events that still owe their side effects on THIS connection. */
      const owesSideEffects = !isResume || seq > cur.appliedSeq;

      // First event past the watermark = the replay is over and we're live
      // again — flip the status pill back from "Reconnecting…".
      if (isResume && !announcedLive && owesSideEffects) {
        announcedLive = true;
        setPhase('streaming', 'Reconnected — continuing…');
      }

      if (type === 'turn') {
        cur.turnId = data.turnId;
        // Mirror into the store so the UI (and Stop) can see the turn id.
        useChatSession.setState(s =>
          s.active && s.active.assistantMsgId === cur.assistantMsgId
            ? { active: { ...s.active, turnId: data.turnId } }
            : {},
        );
        if (!isResume) setPhase('streaming', 'Thinking…');
        persistActiveTurn();
      } else if (type === 'status') {
        if (owesSideEffects && data.phase === 'provider-retry') {
          const reason = String(data.reason || '');
          const isRateLimit = /429|rate.?limit|too many requests/i.test(reason);
          setStatusText(
            isRateLimit
              ? `AI provider rate-limited — retrying in ${Math.round((data.delayMs || 0) / 1000)}s (attempt ${data.attempt})…`
              : `AI provider hiccup — retrying in ${Math.round((data.delayMs || 0) / 1000)}s (attempt ${data.attempt})…`,
          );
        }
      } else if (type === 'text_delta') {
        cur.text += data.text || '';
        updateAssistantFromRuntime(cur);
      } else if (type === 'text_reset') {
        // The model call restarted (provider/loop retry) — text streamed by the
        // aborted attempt is stale (the retry re-narrates from scratch); drop
        // it so the message never shows duplicated narration. Like text_delta,
        // this is pure display state: apply on replay AND live.
        cur.text = '';
        updateAssistantFromRuntime(cur);
      } else if (type === 'tool_call') {
        cur.toolCalls.push({
          name: data.name,
          args: safeJsonParse(data.args),
          result: data.result,
          error: data.error,
          ok: data.ok !== false,
        });
        updateAssistantFromRuntime(cur);
        if (owesSideEffects) {
          runClientSideAction(data.name, safeJsonParse(data.args), data.result);
          cur.appliedSeq = Math.max(cur.appliedSeq, seq);
          setStatusText(TOOL_STATUS_LABELS[data.name] || `Running ${data.name}…`);
        }
        persistActiveTurn();
      } else if (type === 'verify') {
        cur.toolCalls.push({
          name: 'verify.autoCheck',
          args: { attempt: data.attempt },
          result: { health: data.health, issueCount: data.issueCount, dcConverged: data.dcConverged },
          ok: data.health !== 'critical',
        });
        updateAssistantFromRuntime(cur);
      } else if (type === 'circuit_update') {
        const doc: CircuitSnapshot = { components: data.components || [], wires: data.wires || [] };
        cur.finalDoc = doc;
        if (useChatSession.getState().autoApply) {
          if (owesSideEffects) {
            applyCircuitUpdate(cur, doc, seq);
            setStatusText('Updating schematic…');
          }
          // Replayed (already applied before the disconnect) — skip.
        } else {
          // Review mode: pending diff is derived state — idempotent to re-set.
          patchAssistantMessage(cur.assistantMsgId, {
            pendingDiff: {
              components: doc.components,
              wires: doc.wires,
              summary: summarizeDiff(doc, cur.originalCircuit),
            },
          });
        }
        persistActiveTurn();
      } else if (type === 'pcb_update') {
        // Server-side PCB snapshot — load it into the PCB store so the user can
        // watch the AI's layout work live on the PCB tab. Idempotent (full-doc
        // load), so replayed events are safe to re-apply.
        if (owesSideEffects && data && Array.isArray(data.footprints)) {
          applyPcbUpdate(data);
          patchAssistantMessage(cur.assistantMsgId, { pcbUpdated: true });
          setStatusText('Updating PCB layout…');
          cur.appliedSeq = Math.max(cur.appliedSeq, seq);
        }
        persistActiveTurn();
      } else if (type === 'missing_component') {
        // The AI asked for a component type that doesn't exist — surface it on
        // the message immediately (deduped) so the user knows what to add.
        const missingType = typeof data.type === 'string' ? data.type : null;
        if (missingType) {
          const existing = useChatSession.getState().messages.find(m => m.id === cur.assistantMsgId);
          const list = new Set(existing?.missingComponents ?? []);
          list.add(missingType);
          patchAssistantMessage(cur.assistantMsgId, { missingComponents: Array.from(list) });
        }
      } else if (type === 'done') {
        sawFinal = true;
        finalizeDone(cur, data);
        return;
      } else if (type === 'error') {
        sawFinal = true;
        if (data.code === 'TURN_LOST') throw new TurnLostError();
        finalizeError(
          cur,
          data.message || 'AI request failed',
          true,
          data.code === 'AI_NOT_CONFIGURED' ? 'config' : undefined,
        );
        return;
      } else if (type === 'cancelled') {
        sawFinal = true;
        finalizeStopped(cur);
        return;
      }
    } catch (e) {
      if (e instanceof TurnLostError) throw e; // control-flow, not a failure
      // A handler/side-effect exception (e.g. applyCircuitUpdate blowing up on
      // inconsistent store state) — an INTERNAL failure, NOT a transport drop.
      // The old code let this escape into the engine's generic catch, which
      // misclassified it as a network failure and reconnect-hammered the
      // endpoint (each replay re-crashing on the same event) until it gave up
      // with a misleading retryable "Connection lost after 10 attempts". Instead:
      // log the REAL exception (dev.log), surface a clear non-retryable error,
      // and stop the turn without reconnecting.
      console.error('[chat-session] AI turn event handler failed — aborting turn:', e);
      finalizeError(
        cur,
        `AI_ERROR: internal error while applying an AI update: ${(e as Error)?.message || String(e)}`,
        false,
      );
      // Release the connection (we will not read any further events).
      reader.cancel().catch(() => { /* already closed */ });
      return;
    }
  }

  // The stream closed without a terminal event — the connection died
  // mid-turn (server restart, proxy timeout, network drop). Reconnect.
  if (!sawFinal) throw new Error('Stream ended unexpectedly');
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

export const useChatSession = create<ChatSessionState>((set, get) => ({
  messages: [],
  active: null,
  autoApply: ((): boolean => {
    // Auto-apply is the DEFAULT — the AI builds directly on the canvas.
    const v = localStorageGet(AUTO_APPLY_STORAGE_KEY);
    return v === null ? true : v === 'true';
  })(),
  totalTokens: { prompt: 0, completion: 0, total: 0 },
  providers: [],
  selectedProvider: 'zai',
  selectedModel: 'glm-4.6',
  providersLoading: true,

  initProviders: async () => {
    try {
      const res = await fetch('/api/ai/providers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const providers: ProviderInfo[] = data.providers || [];
      const stored = localStorageGet(PROVIDER_STORAGE_KEY);
      const serverDefault = data.default as 'zai' | 'openai' | 'anthropic' | undefined;
      const initial = (stored === 'zai' || stored === 'openai' || stored === 'anthropic' ? stored : null) || serverDefault || 'zai';
      const info = providers.find(p => p.name === initial);
      const providerName = info && info.available ? initial : 'zai';
      const providerInfo = providers.find(p => p.name === providerName);
      const storedModel = localStorageGet(MODEL_STORAGE_KEY);
      const modelToUse = providerInfo && storedModel && providerInfo.models.some(m => m.id === storedModel)
        ? storedModel
        : providerInfo?.model ?? 'glm-4.6';
      set({ providers, selectedProvider: providerName, selectedModel: modelToUse, providersLoading: false });
    } catch {
      set({
        providers: [
          { name: 'zai', label: 'Z.ai (GLM)', available: true, requiresKey: null, model: 'glm-4.6', mode: 'sandbox', models: [
            { id: 'glm-4.6', label: 'GLM-4.6 (Default, Free)', description: 'Z.ai built-in model.', free: true },
          ] },
        ],
        selectedProvider: 'zai',
        selectedModel: 'glm-4.6',
        providersLoading: false,
      });
    }
  },

  setProvider: (name) => {
    localStorageSet(PROVIDER_STORAGE_KEY, name);
    const info = get().providers.find(p => p.name === name);
    set({ selectedProvider: name, selectedModel: info?.model ?? get().selectedModel });
    if (info) {
      localStorageSet(MODEL_STORAGE_KEY, info.model);
      toast.success(`AI provider: ${info.label}`);
    }
  },

  setModel: (model) => {
    localStorageSet(MODEL_STORAGE_KEY, model);
    const provider = get().providers.find(p => p.name === get().selectedProvider);
    const m = provider?.models.find(mm => mm.id === model);
    set({ selectedModel: model });
    if (m) toast.success(`Model: ${m.label}`);
  },

  setAutoApply: (v) => {
    localStorageSet(AUTO_APPLY_STORAGE_KEY, String(v));
    set({ autoApply: v });
  },

  resetTokens: () => set({ totalTokens: { prompt: 0, completion: 0, total: 0 } }),

  send: (text) => {
    if (!text.trim() || get().active || runtime) return;

    const editorState = useEditor.getState();
    const circuitSnapshot: CircuitSnapshot = {
      components: JSON.parse(JSON.stringify(editorState.components)),
      wires: JSON.parse(JSON.stringify(editorState.wires)),
    };
    const simContext = editorState.simContext ? {
      nodeVoltage: Array.from(editorState.simContext.nodeVoltage),
      branchCurrent: Array.from(editorState.simContext.branchCurrent),
      time: editorState.simContext.time,
      dt: editorState.simContext.dt,
    } : null;

    const apiMessages = [
      ...get().messages.filter(m => !m.loading && !m.error).slice(-MAX_HISTORY_MESSAGES).map(m => ({
        role: m.role,
        content: m.content,
      })),
      { role: 'user' as const, content: text },
    ];

    const assistantMsgId = `a_${Date.now()}`;
    const userMsg: ChatMessage = { id: `u_${Date.now()}`, role: 'user', content: text, timestamp: Date.now() };
    const assistantMsg: ChatMessage = { id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now(), loading: true, toolCalls: [] };

    const requestBody = {
      messages: apiMessages,
      circuit: circuitSnapshot,
      simContext,
      simError: editorState.simError || null,
      simRunning: editorState.running,
      selectedComponentId: editorState.selection?.type === 'component' ? editorState.selection.id : null,
      provider: get().selectedProvider,
      model: get().selectedModel,
      clientId: getClientId(),
    };

    runtime = {
      assistantMsgId,
      turnId: null,
      appliedSeq: 0,
      text: '',
      toolCalls: [],
      originalCircuit: circuitSnapshot,
      lastAppliedDocJson: null,
      finalDoc: null,
      historyPushed: false,
      finalized: false,
    };
    runtime.requestBody = requestBody;

    abortCtrl = new AbortController();

    set({
      messages: [...get().messages, userMsg, assistantMsg],
      active: {
        turnId: null,
        assistantMsgId,
        phase: 'connecting',
        statusText: 'Connecting…',
        reconnectAttempt: 0,
        startedAt: Date.now(),
      },
    });

    void runTurnEngine({ requestBody, assistantMsgId });
  },

  stop: () => {
    const rt = runtime;
    if (!rt) return;
    setPhase('stopping', 'Stopping…');
    // Out-of-band cancel: the turn runs server-side now, so aborting the
    // fetch alone wouldn't stop the AI. keepalive so the request survives
    // even if the panel/tab goes away right after the click.
    //
    // When the turn id hasn't arrived yet (the fetch is in flight but the
    // first `turn` SSE event hasn't completed the round-trip — also true for
    // the whole reconnect-sleep window after a TURN_LOST restart, which
    // resets turnId to null), the server-side turn is ALREADY running. Key
    // the cancel by clientId instead: the server cancels that client's
    // running turns, so no zombie keeps burning provider quota until the
    // 290s hard cap.
    const cancelBody = rt.turnId
      ? { turnId: rt.turnId }
      : { clientId: (typeof rt.requestBody?.clientId === 'string' && rt.requestBody.clientId) || getClientId() };
    try {
      void fetch('/api/ai/chat/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cancelBody),
        keepalive: true,
      }).catch(() => {});
    } catch { /* ignore */ }
    abortCtrl?.abort(new DOMException('Stopped by user', 'AbortError'));
    finalizeStopped(rt);
  },

  retryLast: () => {
    const { messages, active } = get();
    if (active || runtime) return;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const text = messages[lastUserIdx].content;
    // Drop everything from the failed attempt (including the old user
    // message — send() re-adds it).
    set({ messages: messages.slice(0, lastUserIdx) });
    get().send(text);
  },

  applyPendingDiff: (msgId) => {
    const msg = get().messages.find(m => m.id === msgId);
    if (!msg?.pendingDiff) return;
    const rt: TurnRuntime = {
      assistantMsgId: msgId,
      turnId: null,
      appliedSeq: 0,
      text: msg.content,
      toolCalls: msg.toolCalls ?? [],
      originalCircuit: msg.pendingDiff, // baseline irrelevant here — only the checkpoint flag matters
      lastAppliedDocJson: null,
      finalDoc: null,
      historyPushed: false,
      finalized: true,
    };
    applyCircuitUpdate(rt, { components: msg.pendingDiff.components, wires: msg.pendingDiff.wires }, 0);
    toast.success('Circuit updated — press Ctrl+Z to undo');
    set(s => ({ messages: s.messages.map(m => (
      m.id === msgId
        ? { ...m, pendingDiff: undefined, applied: true, appliedSummary: msg.pendingDiff!.summary }
        : m
    )) }));
  },

  dismissPendingDiff: (msgId) => {
    set(s => ({ messages: s.messages.map(m => (m.id === msgId ? { ...m, pendingDiff: undefined } : m)) }));
  },

  resumeAfterReload: () => {
    if (get().active || runtime) return;
    const rec = readPersistedTurn();
    if (!rec) return;
    if (Date.now() - rec.startedAt > RELOAD_RESUME_MAX_AGE_MS) {
      clearPersistedTurn();
      return;
    }
    // Restore the conversation (the active assistant message content may be
    // stale — the event replay rebuilds it).
    const assistantMsg: ChatMessage = {
      id: rec.assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      loading: true,
      toolCalls: [],
    };
    const hadMessages = get().messages.length === 0;
    if (hadMessages) {
      set({ messages: [...rec.messages.filter(m => m.id !== rec.assistantMsgId).slice(-MAX_HISTORY_MESSAGES), assistantMsg] });
    } else {
      set({ messages: [...get().messages, assistantMsg] });
    }

    runtime = {
      assistantMsgId: rec.assistantMsgId,
      turnId: rec.turnId,
      // 0 = the canvas is fresh after reload → every replayed circuit update
      // must re-apply (with a single history checkpoint).
      appliedSeq: 0,
      text: '',
      toolCalls: [],
      originalCircuit: rec.requestBody?.circuit ?? { components: [], wires: [] },
      lastAppliedDocJson: null,
      finalDoc: null,
      historyPushed: false,
      finalized: false,
    };
    runtime.requestBody = rec.requestBody;

    abortCtrl = new AbortController();
    set({
      active: {
        turnId: rec.turnId,
        assistantMsgId: rec.assistantMsgId,
        phase: 'reconnecting',
        statusText: 'Reconnecting to your AI session…',
        reconnectAttempt: 0,
        startedAt: rec.startedAt,
      },
    });

    void runTurnEngine({ requestBody: rec.requestBody, assistantMsgId: rec.assistantMsgId });
  },
}));
