# World-Class Web 3D PCB Viewer — Deep Research Report

Compiled from ~30 web searches, primary sources (three.js r185 source verified locally in `node_modules`, KiCad blogs/forums, physicallybased.info, PCB fab spec sheets), and an audit of this repo's current implementation (`PCB3DViewer.tsx` 1707 lines, `component-models-3d.ts` 790 lines, `board-geometry-3d.ts`, `current-flow-3d.ts`).

Confidence: ⬤⬤⬤ = verified primary source · ⬤⬤○ = strong secondary consensus · ⬤○○ = derived/extrapolated.

---

## 1. How professional EDA tools render 3D PCBs

### KiCad 3D Viewer (kicad.org blog, GitLab issues, forums) ⬤⬤⬤
- **Copper lives UNDER a semi-transparent solder mask, not on top of it.** KiCad's realistic mode renders copper first, then the mask slab over it with adjustable opacity. Real boards are exactly this: LPI mask is a ~10–20 µm translucent epoxy layer over buried 35 µm copper. Users tune **mask opacity ≈ 0.85–0.9** so traces ghost through; 100% opacity hides copper entirely (frequent Reddit/forum complaint). Black mask needs *higher* opacity than green (GitLab #11597: black at default opacity shows too much copper).
- **Plated vs non-plated copper rendered differently since v6** (MR #405, Mario Luzeiro): exposed copper on pads/holes is rendered **gold (ENIG)** while raw traces read "light orange or salmon" (forum thread "allow different color for plated and unplated copper"). This plated-vs-raw distinction is a huge realism cue.
- Raytracing mode: fixed→**configurable light sources**, camera animation speed slider, floor plane that no longer casts shadow onto board bottom, model-opacity slider for mechanical preview, 8× perf improvements over time. KiCad raytracer is CPU-based (slow, seconds/frame) — WebGL rasterization + GTAO is the web-native equivalent.
- KiCad 9: 3D model export (glTF/STEP); the viewer inherits board's mask/silkscreen colors from PCBNew properties (MR #63).

### Altium Designer / Altium 365 Viewer ⬤⬤○
- Altium renders **copper visible through semi-transparent mask** by default (their default 3D mask is a translucent turquoise-green; eevblog 2014 thread documents adjusting transparency to taste). Reddit thread "copper seems to be on top of solder mask" = a bug report — proof that top-of-mask copper reads as *wrong* to engineers.
- Altium 365 browser viewer: schematic + 2D + 3D in one no-install share link; compelling because it's the *whole design context*, not just geometry.
- **PDN Analyzer (by CST)** and **Power Analyzer (by Keysight)** paint **IR-drop (voltage) and current-density heatmaps directly onto the copper layer**, with color legends. This is the gold standard of EDA measurement viz: continuous color field over traces, not floating numbers.

### EasyEDA / JLCEDA (prodocs.easyeda.com) ⬤⬤⬤
- Web-based (their own WebGL engine). 3D preview panel with board-color editing, imports VRML/OBJ component models, model manager for batch model assignment. Presentation is utilitarian — it's a checking tool, not a marketing render. This is the gap a "world-class" viewer can own: EDA-grade accuracy with product-viz lighting.

### Flux.ai ⬤⬤○
- Fully browser-based full ECAD (WebGL required); AI copilot, live parts data, collaborative. Its 3D is secondary to the 2D flow; the *compelling* part is the integrated simulation→visualization loop, not raw render quality.

### interactive-html-bom (openscopeproject) ⬤⬤⬤ (source-verified)
- **It is a 2D canvas renderer, NOT 3D** (verified in `web/render.js`: Path2D footprints, CSS-variable highlight colors). UX worth stealing:
  - Click BOM row → component highlighted **red on board, green in BOM table** (element14 walkthrough).
  - Highlight colors are **CSS variables** (`--pad-color-highlight-both`, `--pin1-outline-color-highlight-both`) → themeable.
  - **Pin-1 marking** outline option ("all" or "selected-only") — critical for hand-assembly UX.
  - Layer filtering (front/back/both), board rotation, zoom-to-footprint, extra-fields/dedupe/reorder in BOM table.

**Answer to the core question:** every serious tool renders **traces UNDER the mask** (copper embedded in/on FR4, mask over it, semi-transparent). Nobody renders traces floating on top of an opaque mask except as an optional debug/X-ray mode. Exposed pads get the surface-finish color (ENIG gold / HASL silver) and are *proud of or embedded in mask openings*.

---

## 2. Three.js production-quality rendering (r160–r185, verified against local r0.185.1 source)

### Pipeline (current repo already does most of this — keep it)
`MSAA HalfFloat WebGLRenderTarget (samples:4) → RenderPass → GTAOPass → UnrealBloomPass → SMAAPass → OutputPass` ⬤⬤⬤
- **OutputPass applies renderer.toneMapping (ACES) + sRGB transfer at the END** (verified in OutputPass.js: reads `renderer.outputColorSpace`/`toneMapping` per-frame). All bloom thresholds therefore operate in **linear HDR** space.
- **UnrealBloomPass defaults** (r185 source): `strength=1, radius (0–1), threshold`. Official doc example: `new UnrealBloomPass(res, 1.5, 0.4, 0.85)`. For emissive LEDs: **threshold 0.7–0.9, strength 0.3–0.6, radius 0.3–0.5**, and drive `emissiveIntensity` 2–10× above threshold (three.js forum: "emissive values around 2–10× higher than the threshold"). Repo's current 0.85/0.35 is well-chosen ⬤⬤○.
- **SMAAPass r185 takes NO constructor args** (verified: `constructor()`); SMAA beats FXAA on thin 45° diagonals (forum "Geometric Specular Antialiasing" thread: "SMAA targets the edges a bit better, leaving the rest sharper"). For traces (thin high-contrast lines) SMAA is correct; keep MSAA+SMAA, skip FXAA. ⬤⬤⬤
- **GTAOPass (r185, verified defaults)**: `radius=0.25 (world units), distanceExponent=1, thickness=1, distanceFallOff=1, scale=1, samples=16`; Poisson-denoise: `lumaPhi=10, depthPhi=2, normalPhi=3, radius(px)=4, radiusExponent=1, rings=2, samples=16`; `blendIntensity=1`; `setSceneClipBox(box)` exists to clip AO to the board bounds. **⚠ KEY FINDING: this repo creates GTAOPass but never calls `updateGtaoMaterial()`** — radius stays 0.25 **world units = 0.25 mm**, far too small for component-to-board contact AO at 1 unit = 1 mm. Recommended for PCB scale: `radius: 3–6 (mm), thickness: 2–4, distanceExponent: 1, distanceFallOff: 0.6–1, scale: 1, samples: 16, screenSpaceRadius: false` + denoise `radius: 6–10`. Tune with `GTAOPass.OUTPUT.Denoise` for visual debugging. ⬤⬤⬤ API / ⬤○○ values
- **VSM shadows**: `renderer.shadowMap.type = THREE.VSMShadowMap`; `light.shadow.radius` (blur) + `light.shadow.blurSamples`. sbcode.net tutorial: 256×256 map works with VSM; discourse recommends `radius≈0.2, blurSamples≈2` for cheap; repo uses mapSize 2048, radius 8, blurSamples 16, bias −0.0002, normalBias 0.05, camera fitted to board — good. **Watch VSM light-bleeding** on thin traces; if seen, drop radius or add `shadow.bias` positive small. ⬤⬤⬤
- **Environment lighting**: `PMREMGenerator.fromScene(new RoomEnvironment(), 0.04)` → `scene.environment` — zero-fetch IBL, gives PBR metals real reflections. Keep hemi light ≤0.3 as fill. `environmentIntensity` (scene-level, r163+) ≈ 0.7–1.0. ⬤⬤⬤
- **Tone mapping**: `ACESFilmicToneMapping, exposure 1.0` (repo current). Note ACES hue-shifts saturated colors (three.js "Tone Mapping Overview" discourse) — for LED color fidelity either accept it or use `NeutralToneMapping` (r167+, less shift). ⬤⬤⬤
- **Perf/draw calls**: aim **<100–300 draw calls/frame** (threejsroadmap: "<100 smooth; 500+ optimize"). Merge static geometry (`BufferGeometryUtils.mergeGeometries`) per material; use `InstancedMesh` for repeated pads/bands/vias; shared materials (repo already caches MAT.*); texture atlas for silkscreen. ⬤⬤○

---

## 3. Realistic component appearance specs (concrete numbers)

Verified against fab specs, datasheets, and the PBR database (physicallybased.info — colors are sRGB base-color values in the metalness workflow; metals use base color = F0):

### Board stack
| Element | Value | Confidence |
|---|---|---|
| Standard FR4 board | 1.6 mm (repo: 1.6 ✓) | ⬤⬤⬤ |
| Copper 1 oz | 35 µm (repo `COPPER_THICKNESS=0.08` — 2× real; visible = intentional exaggeration, fine at board zoom) | ⬤⬤⬤ |
| Solder mask thickness | 0.8 mil ≈ 20 µm nominal, ~7.6 µm over trace corners (repo MASK_T=0.06 — visible-scale OK) | ⬤⬤⬤ |
| LPI green mask | **#008C4A** (acceleratedassemblies "PCB color code for green"); alt #0b5e33; matte/semi-gloss/satin finishes exist (Taiyo LPI, NCAB) — repo 0x0b5e33 + clearcoat 0.75/sheen is in-family. Slightly deepen for realism: #0a6b3c–#008C4A | ⬤⬤○ |
| Blue mask | #4990E2 | ⬤⬤○ |
| FR4 edge/core | yellowish-tan; reddit/eevblog: "white tending translucent → yellow-brown"; repo 0xa89a5e ✓; **weave pitch ~60 mil (1.5 mm) for 7628 glass** — a 1.5 mm cross-hatch normal/bump map at zoom is the tell | ⬤⬤○ |
| ENIG pads | gold base color F0: sRGB ≈ #FFC54E → practical slightly darker **#d9b96c–#d4b96a** (repo 0xd9b96c ✓), metalness 1.0, roughness 0.2–0.3 | ⬤⬤⬤ |
| HASL | silver-tin: #c8ccd0, metalness 1.0, roughness 0.3–0.45 (slightly grainy/duller than ENIG; meniscus-y uneven surface) | ⬤⬤○ |
| OSP/bare copper | copper F0 sRGB ≈ #EE9F85 (physicallybased: 0.932/0.623/0.522) but visually #B87333→#c57a4a with roughness 0.35–0.5 (oxidizes matte) | ⬤⬤⬤ |
| Solder joints | shiny convex meniscus: #d9dde2, metalness 0.95, roughness **0.12–0.18**, clearcoat 0.5 (repo solder ✓) | ⬤⬤○ |

### Axial resistor ⬤⬤⬤ (repo has it — polish values)
- Body: beige/tan **#d9c58f** (repo 0xc8b088 slightly dark; 0xd2bd8f sweet spot), roughness 0.5–0.6, clearcoat 0.2–0.3 (lacquer). 1/4 W: Ø2.3–2.5 mm × 6.3 mm body; **lead Ø 0.5–0.6 mm tinned copper** (repo lead r=0.25 ⇒ Ø0.5 ✓); lead pitch 9–10 mm, body sits ~1 mm above board on formed leads.
- 4–6 bands (IEC 60062): band colors — brown #6b3a1e/#8b4513, red #d0021b, orange #d97706, yellow #d4b106, green #16a34a, blue #2563eb, violet #7c3aed, gray #9ca3af, white #f5f5f4, black #1a1a1a, gold #c9a227 (tolerance), silver #c0c0c0. Width ≈ 6% body length, first band offset from end. Real 4-band starts ~15% from one end (repo: 16% ✓).

### Electrolytic capacitor ⬤⬤⬤
- Can colors: **black (#101418) or navy (#1a2440 ✓)** sleeve (PVC, slight gloss: roughness 0.4, clearcoat 0.5 ✓).
- **Polarity stripe = NEGATIVE lead side** (all sources unanimous): light gray **#bfc9d9** with repeated "−" marks — repo has stripe; add minus glyphs (small CanvasTexture decal, 2 px/mm min).
- **Vent score: cross or K stamped in the aluminum top** (zbotic: "scored cross or K-shape... ruptures safely"). Repo has cross ✓ — keep, it reads as real.
- Sleeve wraps with **slight overhang** past the can bottom (~0.5 mm), top shows bare brushed aluminum disc (#9aa0a6, roughness 0.35, metalness 0.9 ✓).
- Crimped ring at can base (subtle torus, r ≈ canR×0.98) — cheap realism win.

### 5 mm LED ⬤⬤⬤
- **Water-clear** lens: near-transparent epoxy with visible internals, narrow beam; **diffused/tinted**: colored translucent (roughness 0.4–0.6, transmission tinted). Repo: opacity 0.9 + transmission 0.25 — better for tinted; for "water clear" use transmission 0.6–0.9, roughness 0.05, ior 1.54.
- **Epoxy IOR ≈ 1.54** (physicallybased plastic PC 1.585 / generic 1.5); `thickness` ≈ dome height (2–3), `attenuationColor` = LED color, `attenuationDistance` 2–5 (unlit tint), `dispersion` 0–0.3 (r185 API) for a subtle chromatic edge.
- **Inner structure visible through clear epoxy**: anvil (post, cathode side) + smaller post + **reflector cup** with die — the cr2s.com 5mm LED drawing labels "Die Cup Cathode (−) Clear Epoxy Body Anode (+) (smaller metal piece) (longest leg)". Repo has emissive core ✓ — add the cup (tiny metallic cone/cylinder Ø1.2 mm, metalness 1, roughness 0.3) and post for water-clear look.
- **Flange flat spot marks the CATHODE side** on 5 mm domes. Flange Ø ≈ 5.8–6.0 vs dome Ø5.0, flange height 0.7 (repo 1.12× & 0.7 ✓) — add the flat: cut a small chord plane on the flange.
- Legs: anode 25–27 mm, cathode 22–24 mm (trimmed on board to ~3–4 mm above pads ✓).

### 7-segment display ⬤⬤○
- Black epoxy DIP-ish body (#141416, roughness 0.6, clearcoat 0.3 ✓); **face = dark red/gray diffuser** (on: bright red/white segments; off: faint dark segments visible behind the diffuser).
- Segment inset ~0.5–1 mm behind face window (recess reads as depth); decimal point pin; 10-pin header (DIP-10 common, per Wikipedia Segment display photo).
- Off-state: segments #3a2020 diffuse; on: emissive #ff2a1a intensity 2–3 + slight bloom (repo sevenSegment ✓).

### DIP IC ⬤⬤⬤
- Matte black epoxy **#141416** roughness 0.6 (repo dipBody ✓ — real DIP is quite matte, almost no clearcoat: drop clearcoat to 0.15–0.3).
- **Notch (half-moon) at pin-1 end** + **pin-1 dot** (molded, Ø 0.8–1 mm, slightly darker/depressed). Repo dipIC has notch; ensure dot.
- Pins: tinned steel #b8bcc2 metalness 1 roughness 0.28 ✓ with **shoulder bend** (pins exit body horizontally then bend down 90° — the "slight bend" is what makes DIPs read real). Pin pitch 2.54 mm, Ø 0.46 mm, shoulder ~1 mm.
- Laser-etched part number: white/silver microtext on top (CanvasTexture, 4 px/mm, only if zoomed — else skip).

### SMD passives ⬤⬤○
- MLCC: tan/brown body **#c9a876** (repo ✓) roughness 0.65 + bright metallic end caps (tin, #d4b96a-ish bright, metalness 1, roughness 0.3) — end cap length ≈ 15–20% of body each end.
- Thick-film resistor: **black body + white value text** (e.g. "103") — 3-digit code, tiny CanvasTexture decal on top face.
- SMD LED: white/clear body + light pipe.

### Copper & mask interplay (the #1 realism lever) ⬤⬤⬤
- Traces: copper base under **semi-transparent mask**: implement either (a) mask slab with `transparent: true, opacity 0.85–0.9` over copper geometry (KiCad approach — current repo approach: opaque mask + separate copper at y=0.075 embedded/slightly proud — visually equivalent at board zoom, but consider a true translucent-mask "X-ray" toggle showing buried traces dimmed), or (b) bake "trace-through-mask" darkening into the mask's diffuse texture (cheaper, no sorting issues).
- Exposed pads (mask openings): gold ENIG, roughness 0.22 — contrast vs matte mask sells the layer stack.

---

## 4. Measurement/visualization UX in 3D EDA tools

- **Falstad/CircuitJS** ⬤⬤⬤ (source-of-truth UX): **moving dots = current, speed ∝ current magnitude**, "Current Speed" slider, **voltage as color on nodes** (grey=0 → red=+ / blue=−), hover any component shows V/I/W, switchable scope waveforms. The repo's 3D particle field mirrors this (same solver currents → 3D dots) — keep and add: speed slider + net-voltage node coloring.
- **Altium PDN/Keysight Power Analyzer** ⬤⬤⬤: heatmap overlays of **IR drop and current density painted on the copper layer** with legend; per-net max/min readouts. Implementation for three.js: build a per-trace color attribute (vertex colors or per-instance color) driven by per-net current/voltage; color ramp: dark blue → cyan → green → yellow → red (jet-like) or perceptually uniform viridis.
- **iBOM UX** ⬤⬤⬤: red/green dual highlight, pin-1 outlines, layer filter, filter-by-value textbox, click-to-zoom, "extra fields" columns, 2D↔3D pairing. In 3D: highlight = emissive pulse + slight scale-up + others dimmed to 40% opacity.
- **Exploded view** ⬤⬤○: components translate along +Y by height-proportional offsets (UW/Princeton "interactive exploded views" research: separate along assembly axes with draggable explosion factor slider 0→1; CAD-intop: rotation/zoom + isolate + step-through states). Trivial with a per-component `userData.explodeOffset = componentHeight × (1 + k)`.
- **Cross-section** ⬤⬤○: KiCad/Fusion do clipping planes — three.js `renderer.localClippingEnabled + material.clippingPlanes` (repo already wires clipping for FR4/mask!). Keep as "X-ray/cutaway" toggle.
- **Probes**: floating HTML labels (CSS2DRenderer or manual projection) showing V/A at hovered pads; only on hover to avoid clutter (KiCad probe dialogs + Falstad hover hybrid).

---

## 5. Notable web-based 3D electronics tools

| Tool | What makes it compelling |
|---|---|
| **Flux.ai** ⬤⬤○ | Full browser ECAD + AI copilot + live parts/price data + collaboration; 3D is functional, presentation is "integration," not render quality |
| **Altium 365 Viewer** ⬤⬤⬤ | Zero-install share links with schematic+2D+3D+STEP; CAD-format upload (Eagle/Altium/KiCad) |
| **JLCEDA/EasyEDA Pro** ⬤⬤⬤ | Instant 3D preview with board color editing, huge vendor 3D model library (JLC parts) — the library breadth is the moat |
| **Tinkercad Circuits** ⬤⬤○ | Friendly breadboard sim + "Circuit Assemblies" bridge into 3D design; compelling via approachability, not fidelity |
| **interactive-html-bom** ⬤⬤⬤ | Single-file offline HTML; the assembly workflow (highlight/dim/filter) is best-in-class |
| **EveryCircuit** | animated charge dots (2D) — the "alive" feeling is the product |

**Takeaway:** nobody has combined EDA-accurate 3D + live sim-driven visualization (glowing LEDs, 7-seg digits, current particles, voltage heatmaps) + product-render lighting. That combination is the differentiator this repo is already positioned for.

---

## 6. three.js r160–r185 specifics (all verified in local `node_modules/three@0.185.1`)

- `GTAOPass(scene, camera, w, h, parameters?, aoParameters?, pdParameters?)`; `.output` enum `{Off:-1, Default:0, Diffuse:1, Depth:2, Normal:3, AO:4, Denoise:5}`; `updateGtaoMaterial({radius, distanceExponent, thickness, distanceFallOff, scale, samples, screenSpaceRadius})`; `updatePdMaterial({lumaPhi, depthPhi, normalPhi, radius, radiusExponent, rings, samples})`; `blendIntensity`; `setSceneClipBox(box3)`.
- `MeshPhysicalMaterial`: `ior=1.5`, `thickness=0`, `attenuationDistance=Infinity` defaults; sheen (`sheen/sheenColor/sheenRoughness`), clearcoat (`clearcoat/clearcoatRoughness`), transmission, **`dispersion`** (chromatic), iridescence, `specularIntensity` — all present in r185.
- LED dome recipe (final): `color: tint, metalness: 0, roughness: 0.06–0.15, transmission: 0.5–0.9 (water clear) / 0.2–0.35 (tinted), ior: 1.54, thickness: 2.5, attenuationColor: tint, attenuationDistance: 3, clearcoat: 1.0, clearcoatRoughness: 0.06, dispersion: 0.25`, plus inner anvil/cup meshes. Lit: `emissiveIntensity` 2–3 on a core mesh + PointLight (repo ✓ at 8 cd).
- `UnrealBloomPass(resolution, strength=1, radius, threshold)` — threshold in linear luminance; keep >0.7 so ACES-white highlights don't bloom.
- `SMAAPass()` no-arg; `FXAAPass` exists as fallback for tier-1.
- `EffectComposer` default r185 render target is already `HalfFloatType`; pass `{samples: 4}` to keep MSAA (repo ✓).
- VSM: `renderer.shadowMap.type=THREE.VSMShadowMap`, `light.shadow.radius`, `light.shadow.blurSamples`.
- CanvasTexture silkscreen: **resolution ≈ 4 px/mm** (e.g. 100×80 mm board ⇒ 400–800 px texture at 4–8 px/mm; text min 1.2 mm stroke), `texture.anisotropy = min(8, renderer.capabilities.getMaxAnisotropy())`, `colorSpace = THREE.SRGBColorSpace`, `magFilter/minFilter` default trilinear. (StackOverflow/sbcode: "hardly better than trilinear + 16× aniso" — 8 is the sweet spot.) ⬤⬤○
- RoomEnvironment: `pmrem.fromScene(new RoomEnvironment(), 0.04)`, dispose generator after; `scene.environment` only, no `scene.background` (keep gradient bg).

---

## 7. Action list for THIS codebase (priority order)

1. **Fix GTAOPass scale** (high impact, 2 lines): call `gtao.updateGtaoMaterial({ radius: 4, thickness: 3, distanceFallOff: 0.8 })` + `updatePdMaterial({ radius: 8 })`; optionally `setSceneClipBox(boardBox)`. Current default radius 0.25 mm ≈ invisible AO. ⬤⬤⬤
2. **LED dome upgrade**: transmission water-clear mode, `ior 1.54`, `attenuationColor/Distance`, `dispersion 0.25`, flange flat (cathode), reflector cup + anvil visible inside. ⬤⬤⬤
3. **Voltage heatmap mode**: per-net/per-trace vertex-color overlay (jet ramp) + legend — the single most-requested pro feature (Altium PDN parity). ⬤⬤⬤
4. **iBOM-style highlight UX**: red board highlight + green BOM row, pin-1 outlines, dim-others. ⬤⬤⬤
5. **Exploded view slider**: `y += userData.explodeOffset * t` per component. ⬤⬤○
6. Resistor body color → #d9c58f; gold band tolerance ring (4th band gold/silver); electrolytic "−" glyphs on stripe. ⬤⬤⬤
7. HASL finish option (silver, rougher) next to ENIG; solder meniscus fillets on THT pads (repo has solder material — add small dome geometry at each pad: sphere scaled to pad Ø×1.2, height 0.3). ⬤⬤○
8. FR4 weave normal map (1.5 mm cross-hatch, normalScale 0.05) on edge material + board top at close zoom. ⬤⬤○
9. Silkscreen CanvasTexture: 4–8 px/mm, anisotropy 8, SRGB colorSpace. ⬤⬤○
10. Perf guard: merge per-material geometry, target <300 draw calls; InstancedMesh for vias/bands. ⬤⬤○
