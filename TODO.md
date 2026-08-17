# Circuit Simulator — Improvement TODO List

Generated from the deep research audit. P0 items have been completed.
This file tracks all remaining P1 and P2 improvements.

## P1 — Should-Have (implement in next sprints)

### Core UX

- [ ] **Undo/redo toast feedback** — Show "Undid: moved R1" toast on each undo/redo, with a "Redo" action button
- [ ] **Paste preview/ghost** — After paste, show translucent ghost that follows cursor; click to place (currently pastes immediately at +2,+2 offset)
- [ ] **Component rotation during palette-drag** — Press R while dragging from palette to rotate the ghost before placing
- [ ] **Alignment/distribute tools** — Add "Align Left/Right/Center", "Distribute H/V" for multi-selected components
- [ ] **Multi-edit property panel** — When 2+ components selected, show common parameters and allow bulk-edit
- [ ] **Zoom-to-fit button** — Compute bbox of all components + wires, set pan/zoom to fit (shortcut: Z)
- [ ] **Measurement ruler tool** — Wire in `drawMeasurementRuler` from `pcb-overlays.ts`; add a "Measure" tool to the Tools dropdown

### Simulation Features

- [ ] **Measurement cursor readouts** — Drag cursor on scope/plot to read "V at t=2.3ms" or "ΔV/Δt between two points"
- [ ] **`.meas` results viewer** — Persistent table showing all `.meas` results with name/value/at columns
- [ ] **Convergence error suggestions** — When singular matrix, identify which components cause it (voltage-source loops, floating nodes)
- [ ] **Interactive parameter sweep slider** — Drag R1 value → live V(out) curve update without modal
- [ ] **Real Bode plot** — Replace `TraceSparkline` with Recharts dual-axis log-x chart (gain dB left, phase deg right, cursors, gain/phase margin markers)
- [ ] **Parametric family plot** — `.step` overlay: N traces with legend showing swept parameter values, click-to-toggle visibility

### Missing Components

- [ ] **Voltage regulators** — LM317, LM7805, 78xx/79xx series, LM1117, LT3045
- [ ] **Flip-flops** — D, JK, T, SR latches as primitives
- [ ] **Logic ICs** — 7402, 7404, 7408, 7432, 7486, 7490, 74138, 74153, 74164, 74245, 74374
- [ ] **CD4000-series CMOS** — CD4013, CD4027, CD4017, CD4060, CD4066, CD4093, CD4511
- [ ] **Comparators** — LM311, LM339, LM393 (open-collector output, distinct from op-amps)
- [ ] **Op-amp macromodels** — LM358, LM324, LM741, TL072, NE5532
- [ ] **SPICE .SUBCKT import** — Parse `.lib`/`.sub` files and register as plugins (LTspice's killer feature)
- [ ] **SPICE .MODEL import** — Parse model files, attach to components
- [ ] **Fuses, PTCs, MOVs** — Overcurrent/overvoltage protection
- [ ] **Thermistors (NTC/PTC)** — Temperature sensing
- [ ] **Optocouplers** — 4N35, PC817
- [ ] **Connectors, headers, test points** — For real schematics
- [ ] **Relays** — Electromechanical + solid-state
- [ ] **Batteries/cells** — Portable designs
- [ ] **Schmitt trigger gates** — Debouncing, oscillators
- [ ] **Multiplexers/decoders** — 74138, 74153
- [ ] **Tri-state buffer** — Digital buffer with enable
- [ ] **SCR, Triac, Diac** — Thyristor family (partially done — diac/IGBT still missing)

### Mobile / Touch

- [ ] **Implement Pointer Events** — Replace `onMouse*` with `onPointer*` in CircuitCanvas (unifies mouse + touch + pen)
- [ ] **Pinch-to-zoom** — Multi-touch gesture support
- [ ] **Long-press context menu** — Touch equivalent of right-click
- [ ] **Mobile layout** — Collapsed palette drawer, bottom sheet for properties, floating action buttons

### Accessibility

- [ ] **Canvas ARIA labels** — Wrap canvas in `<div role="application" aria-label="Circuit schematic editor" tabIndex={0}>`
- [ ] **Keyboard-only component placement** — Click palette → placement mode → arrow keys → Enter to place
- [ ] **Focus rings on canvas elements** — Virtual focus state with dashed ring, Tab/Shift+Tab to cycle
- [ ] **ARIA live region** — Announce "Component R1 selected", "Simulation paused" for screen readers
- [ ] **Landmark roles** — Add `<main>`, `<nav>`, `<aside>` in layout.tsx
- [ ] **Color-blind support** — Add icons (⚠/✓) alongside color-coded states
- [ ] **Skip to main content** link as first body child

### Onboarding

- [ ] **First-run tutorial** — Step-by-step walkthrough highlighting UI elements
- [ ] **Empty-state card** — Centered "Welcome to CircuitLab" with 3 quick-start buttons
- [ ] **Examples gallery with thumbnails** — Grid of auto-generated SVG previews, click to load
- [ ] **Keyboard shortcut discovery** — Bind `?` to open HelpDialog

---

## P2 — Nice-to-Have (when time permits)

### UI Polish

- [ ] **Simulation status panel** — Bottom bar showing node count, FPS, solver iterations, last delta
- [ ] **Net coloring** — Color-code nets (power=red, ground=black, signal=blue) via NetClasses
- [ ] **"What's New" / changelog** — Badge Help button when new features are added
- [ ] **Tip of the Day** — Random tip toast on startup
- [ ] **High-contrast theme** — For low-vision users
- [ ] **Sheet navigation bar** — Prominent sticky breadcrumb when inside hierarchical sheets
- [ ] **Consolidate keyboard shortcuts** — Merge 3 sources (`keyboard-shortcuts.ts`, `use-canvas-keyboard.ts`, `HelpDialog.tsx`) into one

### Advanced Simulation

- [ ] **Fourier THD/spectrum display** — Bar chart of harmonics + table with THD%, fundamental, SNR
- [ ] **Real sparse solver** — CSR-based LU factorization (KLU-style) for 1000+ node circuits
- [ ] **Adaptive timestep** — Wire `simOptions.method` into capacitor/inductor stamps (trap/Gear)
- [ ] **Wire in `memory.ts`** — Call `cleanupComponentState` on `deleteComponent`, use `compactTraces`, instantiate `MemoryMonitor`
- [ ] **Memoize nodeMap + MNA system** — Cache across sim steps, invalidate on component/wire edits
- [ ] **Move canvas rendering out of React** — Direct RAF loop reading from `useEditor.getState()`, bypass React for hot path
- [ ] **Ring buffer for trace samples** — Replace `slice(-max)` with `Float64Array` + write index
- [ ] **Fix autosave to filter sim updates** — Use selector overload, skip while `running === true`

### Advanced Components

- [ ] **PLL** — 74HC4046, LM565
- [ ] **ADC/DAC** — ADC0804, MCP3208, DAC0808, MCP4921
- [ ] **Active crystal oscillator** — 4-pin active oscillator (passive crystal exists)
- [ ] **Multi-unit IC support** — Extend beyond 7400 sample (7402, 7404, etc. as multi-unit)
- [ ] **Voltage references** — TL431, LM336, LM385, ICL8069
- [ ] **Hall-effect sensors, IMUs** — For embedded/robotics
- [ ] **Photodiode, phototransistor, solar cell** — Optical components
- [ ] **Motors** — DC, stepper, servo
- [ ] **Constant-current diode** — JFET current regulator

### Database

- [ ] **Normalize tags** — Separate `circuit_tags` table with FK for indexed tag lookup
- [ ] **Turso embedded replica** — Configure `syncUrl` for local read caching
- [ ] **Move migrations out of request path** — Use Next.js instrumentation hook or startup script
- [ ] **FTS5 full-text search** — On `name` and `tags` for fast searching

### Architecture

- [ ] **Split CircuitCanvas.tsx** (1466 lines) — Into CanvasSurface, WireLayer, ComponentLayer, OverlayLayer
- [ ] **Split store.ts** (1630 lines) — Into separate stores for sim state, history, UI state
- [ ] **Split SymbolEditorDialog.tsx** (1241 lines) — Extract sub-components
- [ ] **Split FootprintEditorDialog.tsx** (1427 lines) — Extract sub-components
- [ ] **Wire in `findRoute`** — Connect smart-wire-router.ts A* to wire completion (568 lines of dead code)
- [ ] **Wire in `scope-viewer.ts`** — Connect to ProbePanel (full scope with cursors/trigger)
- [ ] **Wire in `monte-carlo.ts`** — Replace inline MC in batch-runner with real implementation
- [ ] **Delete or implement `keyboard-shortcuts.ts`** — Currently dead code
- [ ] **Delete or implement `integration.ts`** — Trap/Gear methods, currently dead code
