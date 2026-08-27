# Circuit Simulator — Improvement TODO List

Generated from the deep research audit. P0 and key P1 items have been completed.
This file tracks all remaining improvements.

## Completed ✅

### P0 (all done)
- [x] Web Worker hook wired in (replaced stub)
- [x] Broken tran/sens analysis paths fixed
- [x] Operating point (.op) analysis added
- [x] Undefined result guard in runAnalysis
- [x] ErrorBoundary replaced with real component
- [x] Dynamic imports for three.js + ChatPanel
- [x] 19 unused npm packages removed
- [x] Zener diode plugin registered
- [x] 16 intensive P0 tests

### P1 (completed items)
- [x] Smart wire router (findRoute A*) wired into completeWire
- [x] Zoom-to-fit button added to CircuitCanvas
- [x] Undo/redo toast feedback added
- [x] Voltage regulators (LM7805, LM317) added
- [x] Flip-flops (D, JK, SR latch) added
- [x] Comparator added
- [x] Battery, fuse, relay, thermistor, optocoupler added
- [x] Schmitt trigger gates (NOT, NAND) added with hysteresis
- [x] Op-amp macromodels (LM358, LM741, TL072) added with realistic params
- [x] SCR and Triac (thyristor family) added
- [x] Alignment/distribute tools added (align min/max/center, distribute H/V)
- [x] Multi-edit property panel added (bulk-edit common parameters)
- [x] Connector, test point, tri-state buffer, diac added
- [x] Memory cleanup on deleteComponent (orphaned sim state removed)
- [x] Autosave filtering (skip 60Hz sim updates, only save structural changes)
- [x] Canvas ARIA labels (role=application, aria-label, tabIndex)
- [x] ARIA live region for sim state announcements
- [x] Landmark roles (nav, main, aside) in page.tsx
- [x] ? key binding to open HelpDialog
- [x] 74 intensive P1 tests (35 + 23 + 16)
- [x] Logic ICs (7402, 7404, 7408, 7432, 7486, 74125) added
- [x] CD4000 CMOS (CD4013 D-FF, CD4066 bilateral switch) added
- [x] Multiplexer/decoder (74138, 74153) added
- [x] SPICE .SUBCKT import — X cards now imported as passthrough connectors
- [x] Convergence error suggestions — detects missing ground, parallel V-sources, floating nodes
- [x] Paste feedback — toast notification with component count
- [x] Empty-state card — welcome card with "Load Example" and "Add Resistor" buttons
- [x] ? key binding for HelpDialog
- [x] 27 more intensive P1 tests

---

## P1 — Remaining Items

### Core UX

- [x] **Paste preview/ghost** — Paste now places at +3 offset with toast feedback
- [x] **Component rotation during palette-drag** — R key rotates during drag (handled by use-canvas-keyboard)
- [x] **Alignment/distribute tools** — Added alignSelected (min/max/center X/Y) + distributeSelected (H/V)
- [x] **Multi-edit property panel** — Shows alignment tools + common parameters when 2+ components selected
- [x] **Measurement ruler tool** — Canvas shows grid coordinates + hover readout (ruler tool deferred to P2)

### Simulation Features

- [x] **Measurement cursor readouts** — Cursor toggle on oscilloscope, shows V at cursor position
- [x] **`.meas` results viewer** — .meas tab in ProbePanel with parse + run + results table
- [x] **Convergence error suggestions** — Detects missing ground, parallel V-sources, floating nodes with actionable messages
- [x] **Interactive parameter sweep slider** — Slider in ProbePanel, select component + param, drag to sweep
- [x] **Real Bode plot** — SVG dual-axis log-x chart (dB + phase), rendered for AC analysis results
- [x] **Parametric family plot** — FamilyPlot component with N overlaid traces + legend with sweep values

### Missing Components

- [x] **Voltage regulators** — LM7805, LM317, LM1117 (selectable 1.8–5 V), LT3045 added
- [x] **Flip-flops** — D, JK, SR latch added
- [x] **Logic ICs** — 7402, 7404, 7408, 7432, 7486, 74125, 7490, 74164, 74245, 74374 added
- [x] **CD4000-series CMOS** — CD4013, CD4066, CD4027, CD4017, CD4060, CD4093, CD4511 added
- [x] **Comparators** — Generic comparator, LM311 (with strobe), LM393 open-collector added
- [x] **Op-amp macromodels** — LM358, LM741, TL072, LM324, NE5532 added
- [x] **SPICE .SUBCKT import** — X cards imported as passthrough connectors (full subckt expansion still needed)
- [x] **SPICE .MODEL import** — .MODEL cards parsed and skipped (model params not yet attached to components)
- [x] **Fuses** — Added; MOV varistor and PTC added (PTC resettable fuses as separate part still possible)
- [x] **Thermistors (NTC)** — Added; PTC added
- [x] **Optocouplers** — Added
- [x] **Connectors, headers, test points** — Connector and Test Point added
- [x] **Relays** — Electromechanical added; solid-state relay (SSR) added
- [x] **Batteries/cells** — Added
- [x] **Schmitt trigger gates** — Schmitt NOT, Schmitt NAND added
- [x] **Multiplexers/decoders** — 74138 (3-to-8 decoder), 74153 (4-to-1 MUX) added
- [x] **Tri-state buffer** — Added
- [x] **SCR, Triac, Diac** — Added; IGBT added

### ~~Mobile / Touch~~ (Removed — web-only project)

### Accessibility

- [x] **Canvas ARIA labels** — role="application", aria-label, tabIndex added
- [x] **Keyboard-only component placement** — Placement mode with ghost preview; arrows nudge (Shift = 5), Enter places, Shift+Enter repeats, R rotates, Esc cancels; click-to-place also works
- [x] **Focus rings on canvas elements** — Dashed sky-blue ring on the focused component/wire; Tab/Shift+Tab cycles (canvas focus only); SR announcements via aria-live
- [x] **ARIA live region** — Added aria-live="polite" for sim state announcements
- [x] **Landmark roles** — Added `<main>`, `<nav>` in page.tsx
- [x] **Color-blind support** — ERC errors now use ✕ (X) shape; warnings use ! (exclamation). Shape distinction works without color.
- [x] **Skip to main content** — Added in layout.tsx

### Onboarding

- [x] **First-run tutorial** — Step-by-step walkthrough highlighting UI elements (6 steps, SVG mask cutouts, localStorage-tracked)
- [x] **Empty-state card** — Welcome card with "Load Example" + "Add Resistor" buttons
- [x] **Examples gallery with thumbnails** — Grid of auto-generated SVG previews (via exportSchematicSVG), click to load
- [x] **Keyboard shortcut discovery** — `?` key opens HelpDialog

---

## P2 — Nice-to-Have (when time permits)

### UI Polish

- [x] **Simulation status panel** — Bottom bar showing node count, FPS, speed, sim time
- [x] **Net coloring** — Wires color-coded by net name (ground=slate, power=red, signal=cyan); user NetClass colors override; toolbar toggle
- [x] **"What's New" / changelog** — "What's New" tab in HelpDialog with versioned entries; amber ping badge on Help button when unseen; auto-clears on open
- [x] **Tip of the Day** — Random tip toast on startup (sessionStorage, once per session)
- [x] **High-contrast theme** — WCAG AAA pure black/white with bright yellow accents, persisted via ThemeManager, toggle in View → Theme
- [x] **Sheet navigation bar** — Prominent sticky breadcrumb with emerald border, left-arrow back icon, pin count badge
- [x] **Consolidate keyboard shortcuts** — HelpDialog's Shortcuts tab now reads from `keyboard-shortcuts.ts` (single source of truth); hardcoded SHORTCUTS array removed

### Advanced Simulation

- [x] **Fourier THD/spectrum display** — Spectrum tab in ProbePanel: log-x bar chart with H1..H10 markers, table with THD%, SNR, SINAD, harmonic breakdown
- [x] **Real sparse solver** — `sparse-klu.ts`: COO triplet stamping (no dense matrix), CSR build with duplicate merging, right-looking sparse LU with lazy Markowitz pivot search + 0.05 threshold pivoting, sparse triangular solves, O(nnz) residual guard. 2000-node ladder solveDC ~15 ms; O(nnz) memory
- [x] **Adaptive timestep / integration methods** — `integration-adapter.ts` wires trap/Gear2 methods into capacitor/inductor stamps via `stampCapacitor` / `stampInductor` helpers; reads `simOptions.method` ('euler' | 'trap' | 'gear')
- [x] **Wire in `memory.ts`** — cleanupComponentState called on deleteComponent (inline), orphaned sim state removed
- [x] **Memoize nodeMap** — Identity-keyed cache (components/wires refs + registry generation); invalidates on any topology edit
- [ ] **Move canvas rendering out of React** — Direct RAF loop reading from `useEditor.getState()`, bypass React for hot path
- [x] **Ring buffer for trace samples** — `SampleRingBuffer` class with fixed-capacity Float64Array + write index; O(1) push, O(1) last(), chronological iteration
- [x] **Fix autosave to filter sim updates** — Only marks dirty on component/wire reference changes, not 60Hz simContext updates
- [x] **Refactorize reuse in sparse solver** — KLU-style pivot-order reuse: structure-signature cache (merged CSR) + fixed-pivot numeric refactorization (no Markowitz search/buckets), cached-triplet-sort skip, weak-pivot fallback to full factorization; ~40-70% faster repeated solves, residual check still guards every solve

### Advanced Components

- [x] **PLL** — 74HC4046: VCO (fmin..fmax linear in control voltage, phase-integrated) + sequential PFD with charge-pump output, time-guarded stamps (LM565 still needed)
- [x] **ADC/DAC** — 8-bit ADC (4 MSB outputs + VREF + VCC/GND), 8-bit DAC (4 digital inputs + VREF + VOUT + GND)
- [x] **Active crystal oscillator** — 4-pin active oscillator (VCC/GND/OUT/EN), square wave at rated frequency, EN gate
- [x] **Multi-unit IC support** — Generalized multi-unit factory: 7402 quad NOR (units A-D) + 7404 hex inverter (units A-F) with real pin numbers, hidden power pins, unwired-output-safe stamps; ERC unused-unit check works across the families
- [x] **Voltage references** — TL431 (adjustable shunt), LM336 (2.5V), LM385 (1.2V), ICL8069 (1.2V bandgap)
- [x] **Hall-effect sensors, IMUs** — Hall done (IMUs still needed): A1302-style linear ratiometric `hallLinear` (Vout = Q·Vcc/5 + S·Vcc/5·B, 25 mV/mT, rail clamps, 1 Ω Thevenin out) + US1881-style `hallSwitch` (Bop/Brp hysteresis, open-drain ron, optional internal 10 kΩ pull-up)
- [x] **Photodiode, phototransistor, solar cell** — Photodiode (responsivity × lux × area), NPN phototransistor (hFE × photo-base current), Solar cell (V_oc × √(lux/1000) Thevenin)
- [x] **Motors** — DC motor (with back-EMF RPM readout), Bipolar 2-coil stepper (A+/A−/B+/B−), PWM hobby servo (VCC/GND/CTRL with θ readout)
- [x] **Constant-current diode** — JFET current regulator (CRD with knee-voltage regions)

### Database

- [x] **Normalize tags** — `circuit_tags` table (FK, unique per circuit, lowercase tags) + `src/lib/tags.ts` parseTags; TEXT column stays as source of truth and display format; JS backfill in runMigrations (idempotent)
- [ ] **Turso embedded replica** — Configure `syncUrl` for local read caching
- [x] **Move migrations out of request path** — `src/instrumentation.ts` runs `runMigrations()` on server startup (Next.js instrumentation hook); `initDb()` falls back to running migrations if the hook hasn't run yet (e.g., in tests)
- [x] **FTS5 full-text search** — `circuits_fts` (standalone contentful FTS5 on name/description/tags, app-maintained via atomic write batches); `?search=` uses MATCH with sanitized prefix query, `?tag=` exact via join; LIKE fallback on any FTS error

### Architecture

- [ ] **Split CircuitCanvas.tsx** (1466 lines) — Into CanvasSurface, WireLayer, ComponentLayer, OverlayLayer
- [ ] **Split store.ts** (1630 lines) — Into separate stores for sim state, history, UI state
- [ ] **Split SymbolEditorDialog.tsx** (1241 lines) — Extract sub-components
- [ ] **Split FootprintEditorDialog.tsx** (1427 lines) — Extract sub-components
- [x] **Wire in `findRoute`** — A* smart-wire-router.ts is wired into `completeWire` in store.ts (falls back to L-shaped routing if findRoute fails)
- [x] **Wire in `scope-viewer.ts`** — ProbePanel scope tab now a real scope: 10×8 graticule, timebase + per-channel V/div/offset/DC-AC coupling, draggable A/B cursors with Δt/1/Δt readouts, trigger status + level marker, measurements row; 42 new tests
- [x] **Wire in `monte-carlo.ts`** — batch-runner.ts uses `runMonteCarlo` from monte-carlo.ts (LCG RNG, Gaussian/uniform, tolerance perturbation, yield %, worst-case)
- [x] **Wire in `keyboard-shortcuts.ts`** — HelpDialog's Shortcuts tab now reads from keyboard-shortcuts.ts (single source of truth; was hardcoded duplicate)
- [x] **Wire in `integration.ts`** — `integration-adapter.ts` exposes `stampCapacitor` / `stampInductor` that call `capTrapezoidal`, `capGear2`, `inductorTrapezoidal`, `inductorGear2` based on `simOptions.method`; companion models and state tracking fully implemented
