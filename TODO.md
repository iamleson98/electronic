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

- [x] **Voltage regulators** — LM7805, LM317 added (78xx/79xx series, LM1117, LT3045 still needed)
- [x] **Flip-flops** — D, JK, SR latch added
- [x] **Logic ICs** — 7402, 7404, 7408, 7432, 7486, 74125 added (7490, 74164, 74245, 74374 still needed)
- [x] **CD4000-series CMOS** — CD4013, CD4066 added (CD4027, CD4017, CD4060, CD4093, CD4511 still needed)
- [x] **Comparators** — Generic comparator added (LM311, LM393 macromodels still needed)
- [x] **Op-amp macromodels** — LM358, LM741, TL072 added (LM324, NE5532 still needed)
- [x] **SPICE .SUBCKT import** — X cards imported as passthrough connectors (full subckt expansion still needed)
- [x] **SPICE .MODEL import** — .MODEL cards parsed and skipped (model params not yet attached to components)
- [x] **Fuses** — Added (PTCs, MOVs still needed)
- [x] **Thermistors (NTC)** — Added (PTC still needed)
- [x] **Optocouplers** — Added
- [x] **Connectors, headers, test points** — Connector and Test Point added
- [x] **Relays** — Electromechanical added (solid-state still needed)
- [x] **Batteries/cells** — Added
- [x] **Schmitt trigger gates** — Schmitt NOT, Schmitt NAND added
- [x] **Multiplexers/decoders** — 74138 (3-to-8 decoder), 74153 (4-to-1 MUX) added
- [x] **Tri-state buffer** — Added
- [x] **SCR, Triac, Diac** — Added (IGBT still missing)

### ~~Mobile / Touch~~ (Removed — web-only project)

### Accessibility

- [x] **Canvas ARIA labels** — role="application", aria-label, tabIndex added
- [ ] **Keyboard-only component placement** — Click palette → placement mode → arrow keys → Enter to place
- [ ] **Focus rings on canvas elements** — Virtual focus state with dashed ring, Tab/Shift+Tab to cycle
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
- [ ] **"What's New" / changelog** — Badge Help button when new features are added
- [x] **Tip of the Day** — Random tip toast on startup (sessionStorage, once per session)
- [ ] **High-contrast theme** — For low-vision users
- [ ] **Sheet navigation bar** — Prominent sticky breadcrumb when inside hierarchical sheets
- [ ] **Consolidate keyboard shortcuts** — Merge 3 sources (`keyboard-shortcuts.ts`, `use-canvas-keyboard.ts`, `HelpDialog.tsx`) into one

### Advanced Simulation

- [x] **Fourier THD/spectrum display** — Spectrum tab in ProbePanel: log-x bar chart with H1..H10 markers, table with THD%, SNR, SINAD, harmonic breakdown
- [ ] **Real sparse solver** — CSR-based LU factorization (KLU-style) for 1000+ node circuits
- [ ] **Adaptive timestep** — Wire `simOptions.method` into capacitor/inductor stamps (trap/Gear)
- [x] **Wire in `memory.ts`** — cleanupComponentState called on deleteComponent (inline), orphaned sim state removed
- [ ] **Memoize nodeMap + MNA system** — Cache across sim steps, invalidate on component/wire edits
- [ ] **Move canvas rendering out of React** — Direct RAF loop reading from `useEditor.getState()`, bypass React for hot path
- [ ] **Ring buffer for trace samples** — Replace `slice(-max)` with `Float64Array` + write index
- [x] **Fix autosave to filter sim updates** — Only marks dirty on component/wire reference changes, not 60Hz simContext updates
- [ ] **What's New / changelog** — Badge Help button when new features are added

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
