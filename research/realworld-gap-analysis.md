# Research Round 3 — Real-World Software Gap Analysis

**Goal**: identify features that useful, shipping, real-world products have that this product lacks, to guide it toward "world class and bug free".
**Method**: (1) full feature inventory of our codebase via three deep code-audit passes (simulation/analysis engine, editor/UX/export, AI/education/persistence); (2) 18 web searches + domain research across 19 real-world products; (3) every "we lack X" claim below was verified by direct source inspection (grep + file reads), not assumed.

**Products studied**: Tinkercad Circuits, Wokwi, Falstad/CircuitJS1, CircuitVerse, EveryCircuit, iCircuit, CircuitLab, DCACLab, CRUMB, Fritzing, NI Multisim, Proteus VSM, LTspice, ngspice, KiCad 8/9, EasyEDA (Std/Pro), Flux.ai, SimulIDE, TINA-TI.

---

## 1. Where we already beat the field (do not lose these)

These are verified strengths; several are unique among browser tools. Every roadmap decision must preserve them.

- **AI assistant with 70+ live circuit tools** (build/edit/simulate/diagnose/teach/PCB) — no competitor has anything close. Flux.ai's Copilot is chat-over-PCB; ours executes the engine.
- **3D PCB viewer with live current-flow particles, voltage heat coloring, cross-section, explode, solder-mask modes, STEP export** — CRUMB is breadboard-only; Tinkercad 3D is non-electrical; nothing browser-based matches this.
- **Analysis depth**: DC sweep (nested), AC (dec/oct/lin), transient (BE/trap/Gear-2 + trap-ringing guard), TF, pole-zero, noise (thermal/shot/channel + NF), distortion (THD/HD2/HD3 sweep), Fourier, .meas with TRIG/TARG clauses, sensitivity, Monte Carlo + worst-case, temperature multi-run, parameter stepping — Falstad/CircuitLab/EveryCircuit have none of PZ/noise/disto/MC.
- **SPICE-grade convergence machinery**: gmin stepping, source stepping, pseudo-transient, damped Newton, strict reltol/vntol/abstol exit tests. CircuitJS1/CircuitLab are far shallower.
- **Scope quality**: triggers (auto/normal/single), dual cursors with Δt/1/Δt, XY Lissajous, spectrum + THD/SNR/SINAD, real probe loading models (1×/10× with bandwidth/DC-error calculators) — better than most web scopes.
- **Real-time animated current dots** in 2D and 3D, net coloring, speed control (Falstad/EveryCircuit parity, plus 3D).
- **PCB pipeline in-browser**: A* auto-router with clearance geometry + rip-up/reroute, copper pour with thermal reliefs, 17-rule DRC with waivers, length tuning, diff pairs, blind/micro vias, teardrops, panelization, manufacturer presets, Gerber X1+X2, Excellon, P&P, IPC-2581, ODB++, DXF, VRML, STEP.
- **136 component types** incl. BSIM3/BSIM4, Gummel-Poon, t-lines, CD4000/74xx behavioral ICs, sensors, motors, displays.
- **Scripting API** (`window.circuitlab`), accessibility (ARIA, keyboard placement mode), autosave + crash recovery, FTS5 circuit search, resumable AI turns, multimodal image input.

---

## 2. Gap catalog — Tier 1: strategic (category-defining)

### G1. Breadboard view — Tinkercad / Fritzing / CRUMB / DCACLab
- **What they offer**: a realistic breadboard where components drop in with legs in holes; beginners learn the *physical* skill (hole pitch, rails, jumpers). Fritzing auto-translates schematic↔breadboard↔PCB. CRUMB does it fully in 3D. DCACLab's whole product is "lifelike lab" visuals.
- **Us**: zero matches for "breadboard" in `src/`. Nothing.
- **Why it matters**: THE onboarding paradigm of every education tool. A beginner cannot translate our schematic into a real prototype on their desk.
- **Leverage we already have**: our 3D pipeline (procedural component models, legs-to-pads routing with solder cones, current-flow particles) is exactly the hard tech needed. A breadboard is a regular hole grid + rail nets + per-component leg span solver (assign holes for N legs given pitch = schematic-connectivity constraints). Render with the existing 3D engine.
- **Effort**: XL but the single highest-leverage feature. Start with: breadboard primitive + manual placement + electrical connection via hole occupancy (M), then schematic→breadboard auto-suggest (L).

### G2. Real MCU firmware workflow + Serial Monitor/Plotter — Tinkercad / Wokwi / Proteus
- **What they offer**: write real Arduino C++ (Tinkercad, Wokwi: ESP32/STM32/Pico, real toolchain) or visual Blocks (Tinkercad), run on the virtual MCU, and debug via **Serial Monitor and Serial Plotter** (Tinkercad's #1 used feature). Wokwi adds WiFi/IoC, external libs, and `wokwi-cli` for CI. Proteus co-simulates firmware with full debugging.
- **Us**: `arduinoReal` uses a custom mini-language (pin decl / `D2=HIGH` / `wait` / `goto` / conditional jumps) compiled to bytecode — not C++; **no serial monitor, no plotter, no I2C/SPI/UART APIs, no interrupts**; Uno/RPi/ESP32 are fixed-sketch stubs.
- **Effort staged**:
  - (a) **Serial Monitor + Plotter** for the existing mini-language — S. Add `print`/`println`/`plot` opcodes; monitor panel; plotter feeds our scope ring buffers (already have multi-channel scope!).
  - (b) **Blocks → mini-language compiler** (Tinkercad-style) — M, high educational value.
  - (c) **Real C++ (AVR) via wasm toolchain** — XL (Wokwi's moat; consider later or integrate a wasm gcc/binavr).
- **Why it matters**: Arduino learners expect C++ and the serial monitor is their debug reflex. Without it we cannot own the education segment.

### G3. Touch/mobile support — EveryCircuit / iCircuit / Tinkercad-on-iPad / CRUMB mobile
- **What they offer**: pinch-zoom, drag-place, long-press context menus. EveryCircuit built a paying business on mobile.
- **Us**: `use-touch-gestures.ts` is a **no-op stub** (hook body empty; `detectGesture`/`computePinchZoomFactor` helpers exist but are never wired). Mobile users get nothing.
- **Effort**: M (wire pinch to our zoom transform, pan, long-press → context menu; canvas events already centralized).

### G4. Offline PWA — (beats Tinkercad, which requires internet)
- **What real products do**: installable app, offline editing.
- **Us**: manifest exists but `public/sw.js` is **18 bytes (empty)** and `src/lib/pwa.ts` is **all no-op stubs** (`registerServiceWorker` resolves null, `canInstall` → false). Claimed capability, zero function.
- **Effort**: S-M (app-shell + static asset cache; sim is client-side already; block API/AI when offline with queue).
- **Why it matters**: a *real* differentiator: Tinkercad can't work offline; we can, since the whole engine is client-side.

### G5. Accounts, community gallery, embeds — EveryCircuit (3M community circuits) / CircuitVerse / Tinkercad gallery / EasyEDA teams
- **Us**: anonymous global `saved_circuits` table (**no auth on any `/api/circuits` route — anyone can overwrite anyone's circuit**); share = base64 URL hash; no gallery/fork/like/comment; no embeddable iframe.
- **Effort**: auth+gallery M-L; **embed route S** (`/embed#circuit=` read-only render — the hash loader already exists).

---

## 3. Gap catalog — Tier 2: pro engineering depth (Multisim/LTspice/Proteus class)

### G6. Virtual instrument bench (Multisim's identity)
- **Have**: oscilloscope (excellent), voltmeter, ammeter.
- **Lack**: **function generator instrument UI** (our stimuli editor is SPICE text — beginners can't use it), **Bode plotter instrument** (AC dialog is analysis-grade, not an instrument), **logic analyzer** (no digital timing view exists at all), frequency counter, distortion analyzer, wattmeter, word/pattern generator.
- **Effort**: S-M each; scope/plot infra is reusable (function gen = parameterized source + knob panel; Bode instrument = AC analysis on a small dialog; logic analyzer = sampling digital node states into our ring buffers + timing diagram view).

### G7. SPICE ecosystem interop (LTspice/ngspice users' bread and butter)
- **Lack**: `.include` / `.lib` (vendor model files — the LTspice world runs on these), `.func`, `.alter`, `.control`; **E/F/G/H card import/export in netlists** (we HAVE all four controlled-source plugins in-app, but the SPICE importer/exporter don't map them); `.model LEVEL=` routing to the BSIM3/BSIM4 models that exist.
- **Effort**: M. Impact: instantly unlocks thousands of published circuits and vendor models for import.

### G8. Adaptive timestep (every pro transient engine)
- **Us**: the adaptive controllers **exist as library code** (`integration.ts` error estimator + controller, `adaptive-timestep.ts`) but are **not wired** — live sim and `runTran` both use fixed dt.
- **Why it matters**: stiff circuits (SMPS, 555, rectifiers with fast diodes) waste 95% of steps or miss events. This is THE classic SPICE feature.
- **Effort**: M (wire into `simulateStep`/`runTran` with min/max dt clamp + event detection; controllers already tested in the test suite).

### G9. Op-amp dynamics (LTspice macromodels, Multisim)
- **Us**: `opampReal` exposes **GBW / slew rate / CMRR / input bias parameters in the property panel that are NOT simulated** (stamp implements gain/offset/rout only). This is a credibility/honesty problem, not just a gap.
- **Effort**: S-M (single-pole rolloff from GBW via feedback capacitor; slew limiter as nonlinear clamp; CMRR as controlled source).

### G10. Event-driven digital simulation (Multisim/Proteus/TINA)
- **Us**: gates/ICs are analog region-switching stamps in the Newton loop — correct but slow; a 100-gate circuit pays full analog cost every step.
- **Effort**: L (event queue / delta-cycle abstraction for digital-partitioned subgraphs; also unlocks the logic analyzer G6).

### G11. RF / S-parameters (Qucs / AWR / ADS)
- **Us**: nothing — no Touchstone `.s2p` import, no S-param analysis, no Smith chart. Even LTspice models S-param blocks via equivalent circuits.
- **Effort**: L (frequency-domain stamping of S blocks + Smith chart plot); strong differentiator among *browser* tools.

### G12. Noise & distortion depth
- **Us**: thermal/shot/channel + NF50 + integrated Vrms; but **no flicker 1/f (KF/AF)**, `.disto` is a transient+FFT approximation (self-documented), no two-tone intermodulation/IM3.
- **Effort**: S for 1/f noise; M for true two-tone IM analysis.

### G13. Sensitivity / MC depth
- **Us**: sensitivity is forward finite-difference (documented); MC core measures DC only (AC/tran MC via batch wrapper); no per-run waveform ensemble overlay (Multisim-style Monte Carlo trace fan).
- **Effort**: M for adjoint sensitivity; S for MC trace fan overlay (we already store per-run traces).

### G14. Thermal analysis (Altium/Flux territory)
- **Us**: 3D "heat map" is **voltage**-colored copper, not thermal. Per-part power dissipation is already computed by the engine.
- **Effort**: M (P → θ spreading model → 3D recolor; electrical-to-thermal co-visualization is genuinely rare and pairs with our unique 3D).

### G15. PCB fab calculators (KiCad calculator suite / Saturn PCB — every PCB tool)
- **Us**: none — no IPC-2152 trace-width/current, no differential impedance, no via current/annular ring, no thermal relief resistance. (AI design calculators cover circuit math, not fab constraints.)
- **Effort**: S (pure closed-form math; public formulas).

---

## 4. Gap catalog — Tier 3: ecosystem (EasyEDA/KiCad world)

### G16. Parts catalog scale + live data
- **Real world**: EasyEDA **1M+ parts with live pricing**, one-click JLC/LCSC ordering; Flux connects live parts data + lifecycle; KiCad ships thousands of symbols/footprints/3D models.
- **Us**: **~42 curated parts** (static, no stock/price/lifecycle).
- **Leverage**: we ALREADY parse `.kicad_sch`, `.kicad_mod`, and `.kicad_pcb`. **Bulk-importing KiCad's open library** jumps us to thousands of symbols+footprints in one feature. LCSC public catalog data can add live MPN data.
- **Effort**: M — highest parts-ROI move available.

### G17. BOM-to-cart & live pricing
- **Us**: BOM CSV/HTML/XML + DigiKey/Mouser/LCSC links; no cart handoff, no live pricing/EOL risk.
- **Effort**: S-M (DigiKey/Mouser cart APIs are public).

### G18. Import breadth
- **Us**: KiCad (sch/pcb/footprint), SPICE netlists, legacy Eagle `.sch`. Real tools also import Altium/OrCAD/DipTrace/Eagle-boards. Effort: per-format M-L; low priority while G16 exists.

### G19. Embeddable simulator (Falstad/CircuitVerse/Tinkercad embeds everywhere in courses/blogs)
- **Us**: none. **Effort: S** — an `/embed` route rendering the hash-shared circuit read-only with the live sim. The loader already exists.

### G20. Print/PDF quality
- **Us**: single-page **rasterized** PDF; no multi-sheet pagination; **title-block setting exists (PageSetupDialog) but no drawing code consumes it**.
- **Effort**: S-M (vector multi-sheet + title block; schematic-plot already does vector SVG).

### G21. Headless CI / scenario runner (Wokwi's `wokwi-cli` is a genuine moat)
- **Us**: scripting API + batch runner exist but no headless entry point. A `circuitlab test scenarios.json` CLI (place → wire → run → assert node voltages/waveform invariants) would be unique among browser sims and enables auto-graded coursework.
- **Effort**: S-M (node entry reusing the engine; engine is already worker-isolated).

### G22. Classroom/teacher workflow (Tinkercad Classrooms)
- **Us**: AI quizzes exist; no assignments/roster/grading. Depends on G5 auth. Effort: L.

---

## 5. Tier 4: polish & delight

| # | Feature | Real-world proof | Us | Effort |
|---|---|---|---|---|
| G23 | **Audio feedback** — Tinkercad plays piezo/buzzer sounds | Tinkercad | **No audio subsystem anywhere** (no `AudioContext` in repo). Buzzer's plugin description *falsely claims* "sound plays"; `__buzzer` simState is written but consumed by nothing (dead). Speaker honestly says "future". | S — WebAudio oscillator keyed to simState frequency; fixes B1 too |
| G24 | Scope math channels (A+B, A−B, A×B), per-view FFT window choice | iCircuit, LTspice expression traces | None; spectrum tab uses fixed Hann in the scope path (analysis dialog has 5 windows) | S |
| G25 | Live drag-to-tune knobs during simulation | EveryCircuit's signature interaction | PropertyPanel sliders exist for ranged params (verified) — partial; no on-canvas knob drag | S |
| G26 | Arbitrary-waveform / file-based stimuli | LTspice PWL files, Proteus AWG | PWL text only; no file import | S |
| G27 | Version history UI | EasyEDA/Flux/KiCad+git | **Dead code already exists** (`project-manager.ts` snapshot functions, unwired) | S-M |
| G28 | Serial-powered data plotting (ties to G2a) | Tinkercad plotter | — | (covered by G2a) |

---

## 6. Honesty / bug issues found during this research ("bug free" goal)

These are not feature wishes — they are claims our UI/docs make that the code does not honor, plus dead wiring:

1. **Buzzer claims sound plays** (`io-display.ts:524`) — no audio subsystem exists; `__buzzer` state is dead. Fix: implement G23 or correct the description.
2. **opampReal exposes GBW/slew/CMRR/ibias as editable properties** but the stamp ignores them (G9) — misleading parameter panels.
3. **PWA claims** — manifest + `sw.js` + `pwa.ts` imply installable/offline; all stubs (G4).
4. **Touch gestures** — hook is a no-op (G3): the file even documents pan/long-press/double-tap gestures that cannot fire.
5. **Title-block setting** — settable in PageSetupDialog, consumed by no renderer (G20).
6. **`runTran` ignores `tstart`/`tmax`** despite `SimOptions` fields existing.
7. **Temperature analysis has no UI entry** (programmatic/AI-only; dialog covers 9 of 11 analysis types).
8. **No auth on `/api/circuits`** — the shared circuits table is globally writable; also in-memory rate limiting is per-instance and ineffective on serverless.
9. **Dead code**: version-history functions (G27), `mini-services/` empty placeholder, `/api` root is a hello-world stub.
10. **`transient-methods.ts`** is closed-form test oracles, not integrators — misleading filename only; minor.

---

## 7. Recommended roadmap (impact-ordered)

**Phase 1 — Quick wins, days, huge perceived polish** (fix honesty issues while shipping delight):
G23 audio (+B1) · G24 scope math channels/FFT windows · B6 tstart/tmax · B7 temperature UI entry · B5 title-block rendering · G19 embed route · G15 PCB fab calculators · G6 function-generator instrument UI · B2/G9 op-amp dynamics.

**Phase 2 — Own the MCU/education workflow**: G2a serial monitor+plotter · G2b blocks compiler · G6 Bode instrument + logic analyzer (with G10 groundwork).

**Phase 3 — The moat features**: G1 breadboard view (in 3D, using our unique engine) · G16 KiCad-library bulk import (thousands of parts) · G8 adaptive timestep · G5 auth+gallery · G4 offline PWA · G3 touch.

**Phase 4 — Pro depth**: G11 S-parameters/Smith · G14 thermal co-visualization · G10 event-driven digital · G12/G13 noise/sensitivity depth · G21 CI runner · G17 BOM-to-cart.

**Strategy note**: our unique assets are (a) the AI tool fleet, (b) the 3D electrical visualization engine, (c) SPICE-grade numerics. The three moat moves — **breadboard-in-3D, serial-monitor MCU workflow, KiCad-library import** — each convert an existing strength into a market-defining capability no browser competitor combines.

---

## 8. Verification appendix (evidence for every LACK claim)

- Breadboard absent: `grep -ri breadboard src/` → 0 matches.
- Serial monitor absent: `grep -ri serialMonitor|Serial.begin src/` → 0 matches.
- Audio absent: `grep -rl AudioContext|new Audio|\.mp3|\.wav src/ public/` → only a text mention in design-calculators.
- Touch stub: `use-touch-gestures.ts` hook body is `{}`; helpers unwired.
- PWA stub: `public/sw.js` = 18 bytes; `pwa.ts` = no-op functions.
- Version history dead: `grep -rn createVersionSnapshot|listVersions src/components/` → 0.
- No auth: `grep -n auth|session|middleware src/app/api/circuits/route.ts` → 0.
- S-params absent: `grep -ri sparam|s2p|touchstone src/` → 1 doc-text match only.
- No impedance/fab calculator: `grep -ri "impedance calc|traceWidth" src/` → only net-class/DRC mentions.
- Adaptive timestep unwired: controllers exist in `integration.ts`/`adaptive-timestep.ts`; `engine.ts simulateStep` + `runTran` use fixed dt (inventory agent verified).
- opampReal params not stamped: `advanced-devices.ts:1122–1208` (stamp = gain/offset/rout only).
- Scope math channels absent: `grep -i mathCh|A+B src/lib/circuit/scope-viewer.ts` → 0.
- Parts count ~42: `part-database.ts` inventory (editor agent).
