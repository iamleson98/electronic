# Worklog

---
Task ID: 1
Agent: main (Super Z)
Task: Clone repo, deep research on code/logic/physics, find and fix all bugs, push

Work Log:
- Cloned https://github.com/iamleson98/electronic.git; credentials saved permanently via `git credential store` (~/.git-credentials, mode 600).
- Established baseline: `bun install` + `bun run test` → 69 files / 1609 tests green; `tsc --noEmit` clean; `eslint` 0 errors.
- Deep research: personally reviewed solver.ts, engine.ts, passive.ts, sources.ts, semiconductors.ts, ac-analysis.ts, integration*.ts, analysis.ts (core physics chain), plus 4 parallel Explore agents covering (a) solver/numerics/convergence/MC, (b) worker/store/app wiring, (c) component model files, (d) analysis engine/measurement/fourier. Findings cross-verified by hand-derivation (MNA companion models, ideal-transformer power balance, Shockley JFET triode law) and numeric probe scripts.
- ~60 verified bugs fixed in 5 commits (see git log bb04c86..66d5ad5) with full write-ups in each commit message.
- Added tests/deep-fix-regressions.test.ts (31 physics-level regression tests).
- Two pre-existing tests updated where they encoded buggy behavior (worst-case >16 tolerance empty fallback; nothing else changed).
- Final state: 70 files / 1640 tests passing, tsc clean, eslint 0 errors, `next build` succeeds. Pushed to origin/main.

Stage Summary:
- Critical fixes: sparse-solver branch currents (asMnaSystem detached-copy bug — broke every ≥18-component circuit's transistors/ammeters), worker protocol (requestId never echoed → all promises hung; empty plugin registry → garbage results), RL time-constant law inverted, JFET triode signs, PMOS magnitude explosion, transformers creating energy from nothing, Schmitt NOT/NAND logic, comparator open-collector polarity, .four always returning zeros, QR eigenvalue bulge chase, runPZ crash.
- Notable design limitations left as-is (documented): transmission-line models are delay/buffer approximations; node-id-keyed sim state (npn_..., 7seg_...) can go stale after topology edits (would need a comp-id key refactor across many plugins); integration adapter (trap/gear) is mathematically correct but not yet wired into the live capacitor/inductor plugins.

---
Task ID: 2
Agent: main (Super Z)
Task: Implement the suggestions left from the deep-research pass (stale sim-state keys, transmission-line physics, nodeMap memoization, P1 accessibility)

Work Log:
- Sim-state comp-id refactor: new state-keys.ts helper; migrated ~55 key construction sites across 16 component files + bsim3/bsim4; updated all read-side consumers (engine.ts, analysis.ts, physics-validator.ts); fixed the 3 stamp() call sites missing the comp arg (subcircuit/analysis/convergence) with instance-id prefixing for subcircuit internals; generalized memory.ts cleanup (full prefix list, _J/_nodes suffixes, dotted sub-circuit ids, top-level namespace pass).
- Transmission-line rewrite: lossless → Bergeron/Dommel two-port (Y0 + history current sources, interpolated delay, full reflection physics); lossy → Π-section RLGC ladder with analytically-combined R+L companion, real shunt-C companions, virtual junction nodes via addExtra()+1; new ComponentPlugin.extraVars hint wired into engine/convergence/pz sizing; exact analytic 2-port Y-matrix in AC analysis.
- nodeMap memoization: registryVersion counter + identity-keyed single-entry cache keyed on (components, wires) refs.
- A11y P1: placementDraft state machine (start/nudge/rotate/confirm-repeat/cancel), palette click → placement mode, canvas ghost + click-to-place, Tab/Shift+Tab focusCycle reusing selection as focus target, dashed focus rings (components + wires), store.announcement → aria-live, shortcut registry entries.
- Tests: tests/transmission-line.test.ts (9 physics tests), tests/nodemap-memo.test.ts (3), tests/placement-focus-a11y.test.ts (8); one ammeter test updated to pass comp (matching real callers).

Stage Summary:
- 4 commits: 66ae668 (comp-id state keys), e19dd55 (tline physics), 2727b1c (nodeMap memo), latest (a11y).
- Final state: 73 files / 1660 tests passing, tsc clean, eslint 0 errors, next build succeeds.
- Key design decisions: stateKey() node-id fallback keeps legacy tests working; Bergeron history recorded in step() (fresh solution) not stamp(); extraVars() is the generic mechanism for plugins needing many unknowns; focusCycle reuses selection so all selection-based tooling works on the focused item.
