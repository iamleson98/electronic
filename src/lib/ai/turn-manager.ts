// AI Turn Manager — resumable, connection-independent AI chat turns.
// ─────────────────────────────────────────────────────────────────────────────
// The AI agentic loop (model ↔ tools, up to 50 iterations) used to run inside
// the HTTP request handler of /api/ai/chat/stream. That couples the AI's work
// to the browser connection: one network hiccup, one proxy idle-timeout, or a
// dev-server reload killed the whole "thinking" process and the user lost
// everything ("AI failed because of network error").
//
// This module decouples them:
//   - A TURN is a server-side job that runs to completion regardless of how
//     many HTTP subscribers are attached (zero is fine — the browser can
//     disconnect, sleep, or reload and the AI keeps building).
//   - Every turn emits a sequence-numbered, replayable event log
//     (text_delta / tool_call / circuit_update / verify / status / done …).
//   - Subscribers (the SSE route) attach at any time: they receive the full
//     buffered replay first, then live events until the turn finalizes.
//     Reconnecting clients therefore lose NOTHING.
//   - Heartbeats (SSE `: ping` comments) flow to subscribers every 15s while
//     long tool calls / provider retries keep the stream otherwise silent, so
//     proxies don't reap the idle connection.
//   - Loop-level provider retries: a failed model call is retried with backoff
//     (provider-level fetch retries remain the first line of defense), with a
//     `status` event telling the client "Retrying…".
//   - Turns are cancellable (user Stop) and hard-capped at ~5 minutes; the
//     event log is GC'd 10 minutes after finalization.
//
// Event replay correctness: consecutive `text_delta` events are MERGED in the
// buffer (bounded memory) while live subscribers still receive each fragment
// individually. Because replay always starts from seq 0 and the client
// rebuilds its text by concatenation, merged and unmerged logs are equivalent.
//
// Concurrency: single-threaded Node — emit()/attach() are synchronous, so an
// attach can never miss an event (the snapshot + live subscription are atomic).

import { getProvider, AIProviderConfigError, RATE_LIMIT_ERROR_MARKER, type ChatMessage, type ProviderName } from './provider';
import { TOOLS_BY_NAME, getToolDefinitions, type ToolContext } from './tools';
import type { CircuitDocument } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';
import {
  buildSystemPrompt,
  MUTATING_TOOL_NAMES,
  runAutoVerify,
  autoVerifyNeedsAttention,
  buildAutoVerifyMessages,
} from './system-prompt';
import { buildContextPreamble } from './netlist-summary';
import { ensurePlugins } from './tools/helpers';

/** Mutating tools that manage the history stacks THEMSELVES (no auto-snapshot). */
const HISTORY_SELF_MANAGED = new Set(['schematic.undo', 'schematic.redo']);

/** Tools that mutate the server-side PCB state (ctx.pcb) — after these, a
 *  pcb_update event snapshots the full PCB so the client's PCB view follows. */
const PCB_MUTATING_TOOLS = new Set([
  'pcb.importFromSchematic',
  'pcb.autoRoute',
  'pcb.topoRoute',
  'pcb.setBoardSize',
]);

/** Serialize the server-side PCB state for the pcb_update event (client loads
 *  it into the PCB store). padNets (a Map) becomes an entries array — the same
 *  wire format the client's own serialize() uses. */
function snapshotPcb(pcb: NonNullable<ToolContext['pcb']>): any {
  return JSON.parse(JSON.stringify({
    version: 1 as const,
    board: pcb.board,
    footprints: pcb.footprints,
    traces: pcb.traces,
    vias: pcb.vias,
    ratsnest: pcb.ratsnest,
    padNets: Array.from(pcb.padNets.entries()),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Everything needed to (re)run a turn — mirrors the client's POST body. */
export interface TurnParams {
  messages: ChatMessage[];
  circuit?: { components: any[]; wires: any[] } | null;
  simContext?: {
    nodeVoltage: number[];
    branchCurrent: number[];
    time: number;
    dt: number;
  } | null;
  simError?: string | null;
  simRunning?: boolean;
  selectedComponentId?: string | null;
  provider?: ProviderName;
  model?: string;
  /** Identifies the browser tab — starting a new turn cancels this client's
   *  other running turns (prevents zombie duplicates after auto-restart). */
  clientId?: string | null;
}

export type TurnEventType =
  | 'turn'          // { turnId } — always the first event
  | 'status'        // { phase, attempt?, delayMs?, reason? } — progress info
  | 'text_delta'    // { text }
  | 'text_reset'    // { reason } — the model call is restarting (retry);
                     //   any text streamed by the aborted attempt is stale
                     //   and must be dropped (prevents duplicate narration)
  | 'tool_call'     // { name, args, result?, error?, ok }
  | 'verify'        // { attempt, health, issueCount, dcConverged }
  | 'circuit_update'// { components, wires }
  | 'pcb_update'    // { version, board, footprints, traces, vias, ratsnest, padNets } — server-side PCB snapshot
  | 'missing_component' // { type } — AI requested a component type not in the library
  | 'done'          // { response, toolCalls, circuit, pcb?, missingComponents?, usage?, warning? }
  | 'error'         // { message, code? }
  | 'cancelled';    // { reason }

export interface TurnEvent {
  seq: number;
  type: TurnEventType;
  data: any;
}

export type TurnStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface TurnSubscriber {
  onEvent: (e: TurnEvent) => void;
  /** Called every heartbeat interval while the turn is running (write SSE
   *  keep-alive comments so proxies don't close an idle stream). */
  onHeartbeat?: () => void;
}

export interface AttachResult {
  /** Full buffered event log — replay these to the subscriber first. */
  replay: TurnEvent[];
  /** False when the turn already finalized (replay ends with done/error/cancelled). */
  running: boolean;
}

interface Turn {
  id: string;
  clientId: string | null;
  params: TurnParams;
  events: TurnEvent[];
  nextSeq: number;
  status: TurnStatus;
  subscribers: Set<TurnSubscriber>;
  abort: AbortController;
  startedAt: number;
  finalizedAt: number | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** Set when the hard time limit fired — the loop finalizes as done+warning. */
  timedOut: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ─────────────────────────────────────────────────────────────────────────────

const TURN_TTL_MS = 10 * 60_000;        // finalized turns GC'd after 10 min
const TURN_HARD_CAP_MS = 290_000;       // abort running turns after ~5 min
const TURN_MAX_EVENTS = 4000;           // buffer safety valve
const HEARTBEAT_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_TURNS = 100;                  // total buffered turns (evict oldest finalized)
const MAX_ITERATIONS = 50;              // model ↔ tool loop rounds
const LOOP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]; // loop-level provider retries

/** Rate-limit exhaustion is TERMINAL for a turn: the provider layer already
 * waited patiently (30s + 60s) and confirmed the account quota is throttled —
 * re-running the model call just hammers the limiter, sustains the 429 storm,
 * and delays the user's clear "press Retry later" error. Loop retries stay
 * reserved for genuinely transient failures (5xx blips, provider restarts). */
function isRateLimitExhaustion(e: unknown): boolean {
  return String((e as Error)?.message || e).includes(RATE_LIMIT_ERROR_MARKER)
    || /429|rate.?limit|too many requests/i.test(String((e as Error)?.message || e));
}

function sleepRespectingAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) { clearTimeout(timer); resolve(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Auth/config failures must not be retried — they need human action. */
function isAuthOrConfigError(e: unknown): boolean {
  if (e instanceof AIProviderConfigError) return true;
  const msg = String((e as Error)?.message || e);
  return /API key|API_KEY|credentials|HTTP 401|HTTP 403|not configured/i.test(msg);
}

function abortError(): Error {
  const e = new Error('turn aborted');
  (e as any).isTurnAbort = true;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// TurnManager
// ─────────────────────────────────────────────────────────────────────────────

export class TurnManager {
  private turns = new Map<string, Turn>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private counter = 0;

  /** Start a new turn. The agentic loop runs detached — the returned id can be
   *  subscribed to immediately, later, or never. */
  startTurn(params: TurnParams): string {
    const id = `t_${Date.now().toString(36)}_${(++this.counter).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const turn: Turn = {
      id,
      clientId: typeof params.clientId === 'string' ? params.clientId : null,
      params,
      events: [],
      nextSeq: 1,
      status: 'running',
      subscribers: new Set(),
      abort: new AbortController(),
      startedAt: Date.now(),
      finalizedAt: null,
      timeoutTimer: null,
      timedOut: false,
    };
    this.turns.set(id, turn);

    // Hard time cap — aborts the provider call and any retry sleep.
    turn.timeoutTimer = setTimeout(() => {
      if (turn.status === 'running') {
        turn.timedOut = true;
        turn.abort.abort(new Error('turn time limit'));
      }
    }, TURN_HARD_CAP_MS);
    turn.timeoutTimer.unref?.();

    this.ensureTimers();
    this.emit(turn, 'turn', { turnId: id });
    // Detached: errors are captured inside runLoop and finalized as events.
    void this.runLoop(turn).catch((e) => {
      // Should never happen (runLoop catches), but never leave a stuck turn.
      console.error('[turn-manager] runLoop escaped:', e);
      this.finalize(turn, 'error', { message: `AI turn failed: ${(e as Error).message}` });
    });
    return id;
  }

  /** Atomically attach a subscriber: returns the full replay buffer; events
   *  emitted after this call go ONLY to onEvent (nothing is missed or duplicated). */
  attach(id: string, sub: TurnSubscriber): AttachResult | null {
    const turn = this.turns.get(id);
    if (!turn) return null;
    turn.subscribers.add(sub);
    return { replay: turn.events, running: turn.status === 'running' };
  }

  detach(id: string, sub: TurnSubscriber): void {
    const turn = this.turns.get(id);
    if (turn) turn.subscribers.delete(sub);
  }

  /** User pressed Stop. Idempotent; unknown/finalized turns are a no-op. */
  cancelTurn(id: string): boolean {
    const turn = this.turns.get(id);
    if (!turn || turn.status !== 'running') return false;
    turn.abort.abort(new Error('cancelled by user'));
    return true;
  }

  /** Cancel every RUNNING turn belonging to this client (dedupe
   *  zombies left behind by a client-side auto-restart). Returns true when at
   *  least one turn was still running (and is now being cancelled). Also used
   *  by the cancel route for clientId-only Stop requests — the turn id hasn't
   *  reached the client yet, but the turn is already running server-side. */
  cancelClientTurns(clientId: string, exceptTurnId?: string): boolean {
    let cancelledAny = false;
    for (const turn of this.turns.values()) {
      if (
        turn.status === 'running' &&
        turn.clientId === clientId &&
        turn.id !== exceptTurnId
      ) {
        turn.abort.abort(new Error('superseded by a newer request'));
        cancelledAny = true;
      }
    }
    return cancelledAny;
  }

  getTurnStatus(id: string): TurnStatus | undefined {
    return this.turns.get(id)?.status;
  }

  getRunningTurnCount(): number {
    let n = 0;
    for (const t of this.turns.values()) if (t.status === 'running') n++;
    return n;
  }

  /** Drop all state (tests only). */
  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.ticker) clearInterval(this.ticker);
    this.sweeper = null;
    this.ticker = null;
    for (const t of this.turns.values()) {
      if (t.timeoutTimer) clearTimeout(t.timeoutTimer);
      t.abort.abort(new Error('disposed'));
    }
    this.turns.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private emit(turn: Turn, type: TurnEventType, data: any): void {
    if (turn.events.length >= TURN_MAX_EVENTS) {
      // Safety valve — unreachable in practice (50 iterations ≪ 4000 events),
      // but guarantees bounded memory even against a pathological loop.
      turn.events.splice(0, turn.events.length - TURN_MAX_EVENTS + 1);
    }
    const seq = turn.nextSeq++;
    if (type === 'text_delta') {
      const lastIdx = turn.events.length - 1;
      const last = turn.events[lastIdx];
      if (last && last.type === 'text_delta') {
        // Merge into the buffer for replay (bounded memory) while live
        // subscribers still get just the new fragment. The buffer entry is
        // REPLACED, never mutated — objects already handed to live
        // subscribers must not change retroactively.
        turn.events[lastIdx] = {
          seq,
          type: 'text_delta',
          data: { text: (last.data.text || '') + (data.text || '') },
        };
        for (const s of turn.subscribers) s.onEvent({ seq, type, data });
        return;
      }
    }
    const ev: TurnEvent = { seq, type, data };
    turn.events.push(ev);
    for (const s of turn.subscribers) s.onEvent(ev);
  }

  /** Finalize with exactly one terminal event. Idempotent. */
  private finalize(turn: Turn, type: 'done' | 'error' | 'cancelled', data: any): void {
    if (turn.status !== 'running') return;
    turn.status = type;
    turn.finalizedAt = Date.now();
    if (turn.timeoutTimer) {
      clearTimeout(turn.timeoutTimer);
      turn.timeoutTimer = null;
    }
    this.emit(turn, type, data);
  }

  private ensureTimers(): void {
    if (!this.ticker) {
      this.ticker = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
      this.ticker.unref?.();
    }
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.sweeper.unref?.();
    }
  }

  private tick(): void {
    for (const turn of this.turns.values()) {
      if (turn.status !== 'running') continue;
      for (const s of turn.subscribers) {
        try { s.onHeartbeat?.(); } catch { /* subscriber stream died — detach happens route-side */ }
      }
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, turn] of this.turns) {
      if (turn.status !== 'running' && turn.finalizedAt && now - turn.finalizedAt > TURN_TTL_MS) {
        this.turns.delete(id);
      } else if (turn.status === 'running' && now - turn.startedAt > TURN_HARD_CAP_MS * 2) {
        // Safety net (the timeout timer should have caught it already).
        turn.abort.abort(new Error('turn janitor'));
      }
    }
    // Bound total buffered turns — evict the oldest FINALIZED ones.
    if (this.turns.size > MAX_TURNS) {
      const finalized = [...this.turns.values()]
        .filter(t => t.status !== 'running')
        .sort((a, b) => (a.finalizedAt ?? 0) - (b.finalizedAt ?? 0));
      for (const t of finalized) {
        if (this.turns.size <= MAX_TURNS) break;
        this.turns.delete(t.id);
      }
    }
  }

  // ── the agentic loop (ported from the old stream route) ──────────────────

  private async runLoop(turn: Turn): Promise<void> {
    // Kept outside the try so the abort path can still deliver the circuit's
    // latest state (partial results beat lost results).
    let ctxRef: ToolContext | null = null;
    /** Diagnostics for the catch path (must live outside the try scope). */
    const executedToolCalls: any[] = [];
    let lastProviderError: unknown = null;
    let producedAnyOutput = false;
    try {
      const body = turn.params;

      // Tool context from the circuit snapshot
      const doc: CircuitDocument = {
        version: 1,
        components: body.circuit?.components ? JSON.parse(JSON.stringify(body.circuit.components)) : [],
        wires: body.circuit?.wires ? JSON.parse(JSON.stringify(body.circuit.wires)) : [],
      };
      const plugins = new Map<string, any>();
      for (const c of doc.components) {
        const p = getPlugin(c.type);
        if (p) plugins.set(c.type, p);
      }
      const ctx: ToolContext = {
        doc,
        plugins,
        simContext: body.simContext ? {
          nodeVoltage: Float64Array.from(body.simContext.nodeVoltage),
          branchCurrent: Float64Array.from(body.simContext.branchCurrent),
          state: {},
          time: body.simContext.time,
          dt: body.simContext.dt,
        } : null,
        // Turn-scoped undo history for schematic.undo/redo: a doc snapshot is
        // pushed before every mutating tool call (undo/redo excepted).
        history: { undoStack: [], redoStack: [] },
        // Server-side PCB state — created by pcb.importFromSchematic, then
        // mutated by the routing tools. Snapshotted into pcb_update events.
        pcb: undefined,
        // Component types the AI requested but that don't exist in the library.
        missingComponents: new Set<string>(),
      };
      ctxRef = ctx;

      let provider;
      try {
        provider = getProvider(body.provider, body.model);
      } catch (e) {
        if (e instanceof AIProviderConfigError) {
          this.finalize(turn, 'error', { code: 'AI_NOT_CONFIGURED', message: e.message });
          return;
        }
        throw e;
      }

      const toolDefs = getToolDefinitions();

      const contextPreamble = buildContextPreamble({
        doc,
        simContext: body.simContext ?? null,
        simError: body.simError ?? null,
        simRunning: body.simRunning,
        selectedComponentId: body.selectedComponentId ?? null,
      });

      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt() },
        ...(contextPreamble ? [{ role: 'system' as const, content: contextPreamble }] : []),
        ...body.messages.slice(-60),
      ];

      let circuitModified = false;
      let pcbModified = false;
      let autoVerifyCount = 0;
      /** Missing component types already announced via events (dedupe). */
      const announcedMissing = new Set<string>();

      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        if (turn.abort.signal.aborted) throw abortError();

        /** Did the CURRENT model-call attempt stream any text? Emitted text
         * from a failed attempt is stale — the retry restarts the model call
         * from scratch, so a text_reset event drops it client-side and the
         * narration never duplicates. Fresh flag per loop iteration. */
        let rtTextEmitted = false;

        // Model call with loop-level retry — the provider already retries
        // 429/5xx/network errors internally (attempt-capped AND time-budgeted);
        // this second layer catches everything else (provider restarts, exotic
        // SDK failures) so a blip never kills the user's turn. Provider-level
        // retries are surfaced live via the onRetry → status event hook.
        // EXCEPT rate-limit exhaustion: the provider layer's patient 30s/60s
        // waits already proved the quota is down — looping would re-hammer.
        let result: Awaited<ReturnType<typeof provider.chatStream>> | null = null;
        lastProviderError = null;
        for (let attempt = 0; attempt <= LOOP_RETRY_DELAYS_MS.length; attempt++) {
          try {
            result = await provider.chatStream(
              messages,
              toolDefs,
              {
                temperature: 0.4,
                max_tokens: 8192,
                signal: turn.abort.signal,
                onRetry: (info) => {
                  // Provider-level retry about to sleep — tell the client NOW
                  // so the status pill shows "rate-limited — retrying in Ns"
                  // instead of a silent spinner. Also drop any partial text
                  // the aborted attempt streamed: the retry restarts the
                  // model call from scratch, so keeping it would duplicate
                  // the narration once the new stream replays it.
                  if (rtTextEmitted) {
                    rtTextEmitted = false;
                    this.emit(turn, 'text_reset', { reason: info.rateLimited ? 'rate-limited retry' : 'provider retry' });
                  }
                  this.emit(turn, 'status', {
                    phase: 'provider-retry',
                    attempt: info.attempt,
                    delayMs: info.waitMs,
                    reason: info.rateLimited ? 'rate limited (429)' : info.reason,
                  });
                },
              },
              (delta) => {
                rtTextEmitted = true;
                this.emit(turn, 'text_delta', { text: delta });
              },
            );
            break;
          } catch (e) {
            if (turn.abort.signal.aborted || (e as any)?.isTurnAbort) throw abortError();
            lastProviderError = e;
            if (isAuthOrConfigError(e)) throw e; // needs human action — no retry
            if (isRateLimitExhaustion(e)) throw e; // quota down — do NOT re-hammer
            if (rtTextEmitted) {
              rtTextEmitted = false;
              this.emit(turn, 'text_reset', { reason: 'loop retry' });
            }
            if (attempt >= LOOP_RETRY_DELAYS_MS.length) break;
            const delayMs = LOOP_RETRY_DELAYS_MS[attempt];
            this.emit(turn, 'status', {
              phase: 'provider-retry',
              attempt: attempt + 1,
              delayMs,
              reason: String((e as Error).message || e).slice(0, 200),
            });
            await sleepRespectingAbort(delayMs, turn.abort.signal);
            if (turn.abort.signal.aborted) throw abortError();
          }
        }
        if (result) producedAnyOutput = true;
        if (!result) throw lastProviderError ?? new Error('model call failed');

        // ── tool calls ────────────────────────────────────────────────────
        if (result.tool_calls && result.tool_calls.length > 0) {
          messages.push({
            role: 'assistant',
            content: result.content,
            tool_calls: result.tool_calls,
          });

          for (const tc of result.tool_calls) {
            if (turn.abort.signal.aborted) throw abortError();
            const tool = TOOLS_BY_NAME.get(tc.function.name);
            if (!tool) {
              const errMsg = `Unknown tool: ${tc.function.name}`;
              executedToolCalls.push({ name: tc.function.name, args: tc.function.arguments, error: errMsg, ok: false });
              this.emit(turn, 'tool_call', { name: tc.function.name, args: tc.function.arguments, error: errMsg, ok: false });
              messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ ok: false, error: errMsg }) });
              continue;
            }

            let args: any;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) {
              const errMsg = `Invalid JSON arguments: ${(e as Error).message}`;
              executedToolCalls.push({ name: tc.function.name, args: tc.function.arguments, error: errMsg, ok: false });
              this.emit(turn, 'tool_call', { name: tc.function.name, args: tc.function.arguments, error: errMsg, ok: false });
              messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ ok: false, error: errMsg }) });
              continue;
            }

            try {
              const mutating = MUTATING_TOOL_NAMES.has(tc.function.name);
              if (mutating && !HISTORY_SELF_MANAGED.has(tc.function.name) && ctx.history) {
                // Snapshot BEFORE the mutation so schematic.undo can restore it.
                ctx.history.undoStack.push(
                  JSON.stringify({ components: ctx.doc.components, wires: ctx.doc.wires }),
                );
                ctx.history.redoStack.length = 0; // new mutation invalidates redo
              }
              const toolResult = await tool.execute(args, ctx);
              executedToolCalls.push({ name: tc.function.name, args, result: toolResult.result, error: toolResult.error, ok: toolResult.ok });
              this.emit(turn, 'tool_call', { name: tc.function.name, args, result: toolResult.result, error: toolResult.error, ok: toolResult.ok });
              if (mutating) {
                circuitModified = true;
                ensurePlugins(ctx);
              }
              // Server-side PCB mutated → snapshot for the client's PCB view.
              if (PCB_MUTATING_TOOLS.has(tc.function.name) && ctx.pcb) {
                pcbModified = true;
                this.emit(turn, 'pcb_update', snapshotPcb(ctx.pcb));
              }
              // Newly-detected missing component types → announce immediately
              // so the user knows what to add to the library.
              if (ctx.missingComponents) {
                for (const missing of ctx.missingComponents) {
                  if (!announcedMissing.has(missing)) {
                    announcedMissing.add(missing);
                    this.emit(turn, 'missing_component', { type: missing });
                  }
                }
              }
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.function.name,
                content: JSON.stringify(toolResult.ok ? toolResult.result : { error: toolResult.error }),
              });
            } catch (e) {
              const errMsg = `Tool execution error: ${(e as Error).message}`;
              executedToolCalls.push({ name: tc.function.name, args, error: errMsg, ok: false });
              this.emit(turn, 'tool_call', { name: tc.function.name, args, error: errMsg, ok: false });
              messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ ok: false, error: errMsg }) });
            }
          }

          if (circuitModified) {
            // Snapshot (deep copy) — later tool calls mutate ctx.doc in place;
            // buffered replay events must keep the state they were emitted
            // with so the event log stays deterministic.
            this.emit(turn, 'circuit_update', {
              components: JSON.parse(JSON.stringify(ctx.doc.components)),
              wires: JSON.parse(JSON.stringify(ctx.doc.wires)),
            });
          }
          continue;
        }

        // ── no tool calls — final response (unless auto-verify objects) ───
        if (circuitModified && autoVerifyCount < 2) {
          const report = runAutoVerify(ctx);
          if (autoVerifyNeedsAttention(report)) {
            autoVerifyCount++;
            this.emit(turn, 'verify', {
              attempt: autoVerifyCount,
              health: report.health,
              issueCount: report.issues.length,
              dcConverged: report.dcConverged,
            });
            messages.push(...(buildAutoVerifyMessages(report, autoVerifyCount) as ChatMessage[]));
            continue;
          }
        }

        this.finalize(turn, 'done', {
          response: result.content,
          toolCalls: executedToolCalls,
          circuit: JSON.parse(JSON.stringify({ components: ctx.doc.components, wires: ctx.doc.wires })),
          pcb: pcbModified && ctx.pcb ? snapshotPcb(ctx.pcb) : undefined,
          missingComponents: announcedMissing.size > 0 ? Array.from(announcedMissing) : undefined,
          provider: provider.name,
          model: provider.model,
          usage: result.usage,
          warning: turn.timedOut ? 'Turn exceeded the maximum duration' : undefined,
        });
        return;
      }

      // Max iterations — deliver partial results gracefully.
      this.finalize(turn, 'done', {
        response: 'I reached the maximum number of tool-call iterations. Here is what I managed to do so far. Please continue with a follow-up message if you need more.',
        toolCalls: executedToolCalls,
        circuit: JSON.parse(JSON.stringify({ components: ctx.doc.components, wires: ctx.doc.wires })),
        pcb: pcbModified && ctx.pcb ? snapshotPcb(ctx.pcb) : undefined,
        missingComponents: announcedMissing.size > 0 ? Array.from(announcedMissing) : undefined,
        warning: 'Max iterations reached',
      });
    } catch (e) {
      if ((e as any)?.isTurnAbort || turn.abort.signal.aborted) {
        if (turn.timedOut) {
          // Hard time cap — emit whatever doc state we have so the client
          // keeps the partial circuit instead of losing it. If the turn
          // produced literally NOTHING (e.g. it spent its whole life waiting
          // out rate-limit backoffs), a cheerful "I ran out of time — send a
          // follow-up" done message would be misleading: surface the real
          // cause as an error so the client shows the Retry guidance.
          const nothingProduced = !producedAnyOutput && executedToolCalls.length === 0;
          const rlMsg = lastProviderError ? String((lastProviderError as Error).message) : '';
          if (nothingProduced && isRateLimitExhaustion(lastProviderError)) {
            this.finalize(turn, 'error', {
              code: 'AI_RATE_LIMITED',
              message: `AI chat failed: ${rlMsg}`,
            });
            return;
          }
          this.finalize(turn, 'done', {
            response: nothingProduced
              ? 'I could not reach the AI service before the turn time limit. ' + (rlMsg ? `Last error: ${rlMsg}` : 'No response was received — press Retry to try again.')
              : 'I ran out of time on this request. The circuit has whatever I completed so far — send a follow-up message to continue.',
            toolCalls: [],
            circuit: ctxRef
              ? JSON.parse(JSON.stringify({ components: ctxRef.doc.components, wires: ctxRef.doc.wires }))
              : { components: turn.params.circuit?.components ?? [], wires: turn.params.circuit?.wires ?? [] },
            missingComponents: ctxRef?.missingComponents && ctxRef.missingComponents.size > 0 ? Array.from(ctxRef.missingComponents) : undefined,
            warning: 'Turn exceeded the maximum duration',
          });
        } else {
          this.finalize(turn, 'cancelled', { reason: 'user' });
        }
      } else {
        console.error('[turn-manager] AI turn error:', e);
        const msg = String((e as Error).message || e);
        this.finalize(turn, 'error', {
          code: isRateLimitExhaustion(e) ? 'AI_RATE_LIMITED' : undefined,
          message: `AI chat failed: ${msg}`,
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton (survives HMR / route module reloads)
// ─────────────────────────────────────────────────────────────────────────────

const globalForTurns = globalThis as unknown as { __aiTurnManager?: TurnManager };

export function getTurnManager(): TurnManager {
  if (!globalForTurns.__aiTurnManager) {
    globalForTurns.__aiTurnManager = new TurnManager();
  }
  return globalForTurns.__aiTurnManager;
}
