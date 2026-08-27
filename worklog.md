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
