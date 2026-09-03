'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { buildNodeMap, getTerminalsForComponent, computeComponentCurrents } from '@/lib/circuit/engine';
import { getPlugin } from '@/lib/circuit/registry';
import { DEFAULT_MODELS } from '@/lib/pcb/3d-models';
import { parseModel, modelToGeometry } from '@/lib/pcb/model-loader';
import { buildComponentModel, hasProceduralModel } from '@/lib/pcb/component-models-3d';
import type { Footprint } from '@/lib/pcb/types';
import {
  boardGeometry,
  buildSilkscreenTexture,
  flattenModel,
  mergeAll,
  netColor,
  padGeometry,
  solderFilletGeometry,
  traceGeometries,
  viaGeometries,
  voltageColor,
  fr4Material,
  goldMaterial,
  solderMaskMaterial,
  drillMaterial,
  solderMaterial,
} from '@/lib/pcb/board-geometry-3d';
import { FlowParticleField, computeNetFlow, padWorldPosition } from '@/lib/pcb/current-flow-3d';

const FAILED_SENTINEL = Symbol('FAILED');

// ─────────────────────────────────────────────────────────────────────────────
// Rendering-pipeline notes (why this file looks the way it does):
//
// • MSAA: `antialias:true` on WebGLRenderer does NOTHING once EffectComposer
//   renders into an offscreen target — every earlier build had jaggies on
//   board/component edges. The fix is a multisampled HalfFloat render target
//   (WebGL2 `samples: 4`) handed to the composer as its base buffer.
// • AO: GTAOPass gives grounded contact shadows between components and the
//   board — the single biggest "photo vs. dev-tool" separator. It costs one
//   extra scene pass, so an adaptive monitor disables it on slow GPUs.
// • Bloom: threshold raised to 0.85 & strength cut to 0.35 — the previous
//   0.55/0.72 washed the whole board white whenever an LED lit.
// • Plain WebGLRenderer (not WebGPURenderer) — synchronous render, stable
//   clipping-plane API, see git history for the failed experiment.
// ─────────────────────────────────────────────────────────────────────────────

const BOARD_THICKNESS = 1.6;
const MASK_T = 0.06;              // solder-mask slab thickness
// ── Layer stack (realistic sandwich, KiCad-style) ─────────────────────
// FR4 core spans y ∈ [−1.6, 0]; copper sits ON the substrate; the
// semi-transparent LPI mask covers the copper (traces ghost through);
// pads & via barrels pierce the mask as exposed ENIG gold; silk on top.
const COPPER_TOP_Y = 0.08;        // top face of top copper (mask bottom)
const COPPER_BOT_Y = -1.64;       // CENTER of bottom copper [−1.68, −1.6]
const BOT_COPPER_Y = -1.68;       // lower face of bottom copper / mask top
const SILK_Y = 0.148;             // just above the top mask slab
const PAD_TOP_Y = 0.16;           // pads pierce the mask — exposed gold
const PAD_BOT_Y = -1.68;          // bottom pads pierce down (spans to −1.76)
const MODEL_TOP_Y = 0.15;
const MODEL_BOT_Y = -1.74;

/** World Y for a copper layer — the CENTER of the copper slab (this is the
 *  convention traceGeometries expects; pads use their own pierce heights). */
function layerYOf(layer: string): number {
  switch (layer) {
    case 'top': return COPPER_TOP_Y - 0.04;
    case 'bottom': return COPPER_BOT_Y;
    case 'inner1': return -0.5;
    case 'inner2': return -0.85;
    case 'inner3': return -1.15;
    case 'inner4': return -1.45;
    default: return COPPER_TOP_Y - 0.04;
  }
}
/** Flow-particle height per layer — above the mask so dots stay visible.
 *  (FlowParticleField adds +0.12 to the value we hand it.) */
function flowLayerYOf(layer: string): number {
  return layer === 'bottom' ? -1.94 : 0.06;
}

// Cache 3D geometries across renders (model geometry cache — survives HMR).
function createModelGeometryCache(): Map<string, THREE.BufferGeometry | typeof FAILED_SENTINEL> {
  return new Map();
}

// Reusable material cache for STL fallback models.
function createMaterialCache() {
  const map = new Map<string, THREE.Material>();
  const get = (key: string, factory: () => THREE.Material): THREE.Material => {
    let m = map.get(key);
    if (!m) { m = factory(); map.set(key, m); }
    return m;
  };
  const dispose = () => { map.forEach((m) => m.dispose()); map.clear(); };
  return { get, dispose };
}

// ─── Studio backdrop ─────────────────────────────────────────────────────────

/** Vertical gradient background — dark studio sweep, not a flat dev color. */
function gradientBackground(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#101a2c');
  grad.addColorStop(0.55, '#0b1322');
  grad.addColorStop(1, '#060b14');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft radial-gradient floor: catches the board's shadow, fades to void. */
function studioFloor(radius: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(256, 256, 40, 256, 256, 256);
  grad.addColorStop(0, 'rgba(38,54,84,0.95)');
  grad.addColorStop(0.55, 'rgba(24,36,58,0.55)');
  grad.addColorStop(1, 'rgba(10,16,28,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshStandardMaterial({
      map: tex, transparent: true, roughness: 0.96, metalness: 0.0,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return mesh;
}

// ─── Camera tween ────────────────────────────────────────────────────────────

interface CamTween {
  p0: THREE.Vector3; p1: THREE.Vector3;
  t0v: THREE.Vector3; t1v: THREE.Vector3;
  start: number; dur: number;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// scratch vector for per-frame viewport resets (never allocate in the loop)
const _v2 = new THREE.Vector2();

// ─── Component param summary for the info card ───────────────────────────────

function paramSummary(fp: Footprint, comp: { parameters?: Record<string, unknown> } | undefined): string {
  const p = comp?.parameters ?? {};
  const entries: string[] = [];
  const fmt = (v: unknown): string => {
    if (typeof v === 'number') {
      if (Math.abs(v) >= 1000) return `${(v / 1000).toPrecision(3)}k`;
      if (Math.abs(v) < 1 && v !== 0) return v.toPrecision(2);
      return String(Math.round(v * 100) / 100);
    }
    return String(v);
  };
  const order = ['resistance', 'capacitance', 'inductance', 'voltage', 'current', 'forwardV', 'frequency', 'color', 'closed', 'pressed'];
  for (const k of order) {
    if (p[k] !== undefined && p[k] !== null && entries.length < 4) {
      const unit = k === 'resistance' ? 'Ω' : k === 'capacitance' ? 'F' : k === 'inductance' ? 'H' : k === 'voltage' ? 'V' : k === 'current' ? 'A' : '';
      entries.push(`${k}: ${fmt(p[k])}${unit}`);
    }
  }
  if (!entries.length && fp.componentType) entries.push(fp.componentType);
  return entries.join(' · ');
}

// ═════════════════════════════════════════════════════════════════════════════

export function PCB3DViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  const gtaoPassRef = useRef<GTAOPass | null>(null);
  const smaaPassRef = useRef<SMAAPass | null>(null);
  const pcbGroupRef = useRef<THREE.Group | null>(null);
  const modelsGroupRef = useRef<THREE.Group | null>(null);
  const flowFieldRef = useRef<FlowParticleField | null>(null);
  /** per-net copper materials — recolored live for heat/net-color modes */
  const netMatsRef = useRef<Map<string, THREE.MeshPhysicalMaterial[]>>(new Map());
  /** mask materials — opacity eased up in heat/net-color modes so the
   *  recolored copper underneath becomes clearly readable */
  const maskMatsRef = useRef<THREE.MeshPhysicalMaterial[]>([]);
  const clipPlaneRef = useRef<THREE.Plane | null>(null);
  const viewHelperRef = useRef<ViewHelper | null>(null);
  const modelCacheRef = useRef(createModelGeometryCache());
  const inFlightRef = useRef<Set<string>>(new Set());
  const materialCacheRef = useRef(createMaterialCache());
  const liveModelsRef = useRef(false);
  const pluginMapCacheRef = useRef<{ components: unknown; plugins: Map<string, NonNullable<ReturnType<typeof getPlugin>>> } | null>(null);
  const nodeMapCacheRef = useRef<{
    components: unknown; wires: unknown; nodeMap: ReturnType<typeof buildNodeMap>;
  } | null>(null);
  const probeLabelsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const probeLayerRef = useRef<HTMLDivElement | null>(null);
  const assemblyIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // interaction
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2(10, 10)); // offscreen initially
  const hoverFpIdRef = useRef<string | null>(null);
  const hoverRingRef = useRef<THREE.Mesh | null>(null);
  const selectRingRef = useRef<THREE.Mesh | null>(null);
  const camTweenRef = useRef<CamTween | null>(null);
  // frame counters for adaptive quality
  const frameStatsRef = useRef({ last: 0, avg: 16, tier: 2, slowFrames: 0, degraded: false });
  const aoEnabledRef = useRef(true);
  const applyQualityRef = useRef<((tier: number, dpr: number) => void) | null>(null);
  const screenshotRef = useRef<string | null>(null);
  // live info-card value spans (updated imperatively from the render loop)
  const infoVRef = useRef<HTMLSpanElement | null>(null);
  const infoIRef = useRef<HTMLSpanElement | null>(null);
  const infoPRef = useRef<HTMLSpanElement | null>(null);
  const infoNetRef = useRef<HTMLSpanElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qualityTier, setQualityTier] = useState(2); // 2 = full, 1 = fast, 0 = minimal

  // Visual options
  const [crossSection, setCrossSection] = useState(false);
  const [crossSectionX, setCrossSectionX] = useState(0.5); // 0..1 across board width
  const [aoEnabled, setAoEnabled] = useState(true);
  const [showCurrentFlow, setShowCurrentFlow] = useState(false);
  const [showVoltageHeat, setShowVoltageHeat] = useState(false);
  const [showNetColors, setShowNetColors] = useState(false);
  const [showVoltageProbes, setShowVoltageProbes] = useState(false);
  const [explosionFactor, setExplosionFactor] = useState(0);
  const [assemblyProgress, setAssemblyProgress] = useState(1);
  const [autoRotate, setAutoRotate] = useState(false);
  const [selectedFpId, setSelectedFpId] = useState<string | null>(null);
  const [perfMode, setPerfMode] = useState(false);

  // Use refs for animation-loop state (avoids re-render on every frame)
  const stateRef = useRef({
    crossSection: false,
    crossSectionX: 0.5,
    boardW: 80,
    showCurrentFlow: false,
    showVoltageHeat: false,
    showNetColors: false,
    explosion: 0,
    assembly: 1,
    showVoltageProbes: false,
    selectedFpId: null as string | null,
  });
  useEffect(() => { stateRef.current.crossSection = crossSection; }, [crossSection]);
  useEffect(() => { stateRef.current.crossSectionX = crossSectionX; }, [crossSectionX]);
  useEffect(() => { stateRef.current.showCurrentFlow = showCurrentFlow; }, [showCurrentFlow]);
  useEffect(() => { stateRef.current.showVoltageHeat = showVoltageHeat; }, [showVoltageHeat]);
  useEffect(() => { stateRef.current.showNetColors = showNetColors; }, [showNetColors]);
  useEffect(() => { stateRef.current.explosion = explosionFactor; }, [explosionFactor]);
  useEffect(() => { stateRef.current.assembly = assemblyProgress; }, [assemblyProgress]);
  useEffect(() => { stateRef.current.showVoltageProbes = showVoltageProbes; }, [showVoltageProbes]);
  useEffect(() => { stateRef.current.selectedFpId = selectedFpId; }, [selectedFpId]);

  // Clear the assembly-play interval if the viewer unmounts mid-animation
  useEffect(() => () => {
    if (assemblyIntervalRef.current) clearInterval(assemblyIntervalRef.current);
  }, []);

  // PCB data
  const running = useEditor((s) => s.running);
  const footprints = usePCB((s) => s.footprints);
  const traces = usePCB((s) => s.traces);
  const vias = usePCB((s) => s.vias);
  const board = usePCB((s) => s.board);
  const padNets = usePCB((s) => s.padNets);

  // ── Initialize scene ONCE (no re-init on data change) ──────────────────
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const container = containerRef.current;
    if (!container) return;

    try {
      const scene = new THREE.Scene();
      scene.background = gradientBackground();
      sceneRef.current = scene;

      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 4000);
      camera.position.set(board.width / 2, 50, board.height + 30);
      camera.lookAt(board.width / 2, 0, board.height / 2);
      cameraRef.current = camera;

      const renderer = new THREE.WebGLRenderer({
        antialias: false, // MSAA comes from the composer's multisampled target
        alpha: false,
        powerPreference: 'high-performance',
        stencil: false,
        // keep the drawing buffer valid after compositing: needed for the
        // in-app Screenshot button (toDataURL outside the render task) and
        // for stable captures on very slow GPUs (software GL at ~1 fps
        // used to present cleared frames between draws)
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.localClippingEnabled = true;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      // Neutral tone mapping (r167+): ACES hue-shifts saturated emissives —
      // an RGB LED's red/green/blue must stay truthful for sim readouts.
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.shadowMap.enabled = true;
      // r185 deprecated PCFSoftShadowMap (hard-edged fallback). VSM is the
      // supported soft-shadow path — radius + blurSamples give the soft
      // contact shadows that ground components on the mask surface.
      renderer.shadowMap.type = THREE.VSMShadowMap;
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;
      renderer.domElement.style.touchAction = 'none';

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 3;
      controls.maxDistance = 900;
      controls.maxPolarAngle = Math.PI * 0.92;
      controls.autoRotateSpeed = 1.1;
      controls.zoomToCursor = true;
      // keep controls.target in sync with the initial lookAt (OrbitControls
      // defaults to (0,0,0) and update() orbits around THAT, panning the
      // board off-center on mount)
      controls.target.set(board.width / 2, 0, board.height / 2);
      controls.update();
      controlsRef.current = controls;

      /** Apply a quality tier: post-FX pass toggles + pixel ratio.
       *  2 = full (GTAO+SMAA+MSAA, DPR≤2) · 1 = fast (bloom+MSAA, DPR 1.25)
       *  · 0 = minimal (raw renderer, DPR 1) */
      const applyQuality = (tier: number, dpr: number) => {
        const fs = frameStatsRef.current;
        fs.tier = tier;
        if (gtaoPassRef.current) gtaoPassRef.current.enabled = tier >= 2 && aoEnabledRef.current;
        if (smaaPassRef.current) smaaPassRef.current.enabled = tier >= 2;
        if (bloomPassRef.current) bloomPassRef.current.enabled = tier >= 1;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, dpr));
        const size = renderer.getSize(new THREE.Vector2());
        renderer.setSize(size.x, size.y);
        composerRef.current?.setSize(size.x, size.y);
        bloomPassRef.current?.setSize(size.x, size.y);
      };
      applyQualityRef.current = applyQuality;

      // ── Post-processing: MSAA HalfFloat target → GTAO → bloom → output ──
      const bufSize = renderer.getDrawingBufferSize(new THREE.Vector2());
      const msaaTarget = new THREE.WebGLRenderTarget(bufSize.x, bufSize.y, {
        type: THREE.HalfFloatType,
        samples: 4,
      });
      const composer = new EffectComposer(renderer, msaaTarget);
      // eslint-disable-next-line no-console
      console.info('[3D] WebGL2:', renderer.capabilities.isWebGL2, '· MSAA samples:', msaaTarget.samples);
      composer.addPass(new RenderPass(scene, camera));
      const gtao = new GTAOPass(scene, camera, width, height);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 1.0;
      // SCALE TUNING (critical): GTAO's default radius is 0.25 world units
      // = 0.25 mm on a PCB — invisible. 4 mm radius grounds components on
      // the mask with believable contact shadows at board scale.
      try {
        gtao.updateGtaoMaterial({ radius: 4, thickness: 3, distanceFallOff: 0.8, samples: 16 });
        gtao.updatePdMaterial({ radius: 8, lumaPhi: 10, depthPhi: 2, normalPhi: 3 });
      } catch { /* older three fallback: defaults */ }
      composer.addPass(gtao);
      gtaoPassRef.current = gtao;
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        0.35,  // strength — halo only on genuinely lit parts
        0.5,   // radius
        0.85,  // threshold — above ACES-white; emissive LEDs / hot copper only
      );
      composer.addPass(bloomPass);
      bloomPassRef.current = bloomPass;
      // SMAA: shape-based AA that catches thin 45° trace diagonals that
      // 4× MSAA alone still shimmers on (official three ordering: before Output).
      const smaa = new SMAAPass();
      composer.addPass(smaa);
      smaaPassRef.current = smaa;
      composer.addPass(new OutputPass());
      composerRef.current = composer;

      // Software GL (llvmpipe / SwiftShader — CI, VMs, remote sandboxes):
      // full post-processing runs at seconds-per-frame there. Start one
      // tier down instead of freezing the tab.
      try {
        const gl = renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const gpu = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
        if (/llvmpipe|swiftshader|software/i.test(gpu)) {
          applyQuality(1, 1);
          // eslint-disable-next-line no-console
          console.info('[3D] software GL detected (', gpu, ') → quality tier 1');
        }
      } catch { /* detection optional */ }

      // ── Studio lighting: contrasty three-point + IBL ─────────────────
      // Product-render look = one STRONG key with real falloff + everything
      // else subtle. The earlier even-lit setup read as a flat dev preview.
      scene.add(new THREE.AmbientLight(0xffffff, 0.12));
      const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a2233, 0.25);
      scene.add(hemi);
      const key = new THREE.DirectionalLight(0xfff6e8, 1.9);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.near = 10;
      key.shadow.camera.far = 500;
      key.shadow.bias = -0.0002;
      key.shadow.normalBias = 0.05;
      key.shadow.radius = 8;
      key.shadow.blurSamples = 16;
      scene.add(key);
      (scene as unknown as Record<string, unknown>).__keyLight = key;
      const fill = new THREE.DirectionalLight(0xbfd4ff, 0.25);
      scene.add(fill);
      (scene as unknown as Record<string, unknown>).__fillLight = fill;
      const rim = new THREE.DirectionalLight(0xffffff, 0.35);
      scene.add(rim);
      (scene as unknown as Record<string, unknown>).__rimLight = rim;

      // Image-based lighting (PMREM of the built-in RoomEnvironment — no fetch)
      import('three/examples/jsm/environments/RoomEnvironment.js')
        .then(({ RoomEnvironment }) => {
          if (cancelled || !rendererRef.current) return;
          try {
            const pmrem = new THREE.PMREMGenerator(rendererRef.current);
            const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
            sceneRef.current!.environment = env.texture;
            sceneRef.current!.environmentIntensity = 0.45;
            pmrem.dispose();
          } catch { /* environment optional */ }
        })
        .catch(() => { /* environment optional */ });

      // ── Studio floor (shadow catcher with radial fade) ──────────────────
      const floor = studioFloor(Math.max(300, Math.max(board.width, board.height) * 2.2));
      floor.position.set(board.width / 2, -2.6, board.height / 2);
      scene.add(floor);

      // Persistent clipping plane — wired to every material at build time
      // (see the cross-section comment above for orientation).
      const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
      clipPlaneRef.current = clipPlane;

      // CAD-style XYZ orientation gizmo (corner axes — red X / green Y /
      // blue Z). Clickable: tapping an axis animates the camera to it.
      const helper = new ViewHelper(camera, renderer.domElement);
      helper.center = new THREE.Vector3(board.width / 2, 0, board.height / 2);
      viewHelperRef.current = helper;
      const helperClick = (e: MouseEvent) => {
        if (!viewHelperRef.current || !controlsRef.current) return;
        viewHelperRef.current.center = controlsRef.current.target;
        viewHelperRef.current.handleClick(e);
      };
      renderer.domElement.addEventListener('pointerup', helperClick, true);

      const pcbGroup = new THREE.Group();
      scene.add(pcbGroup);
      pcbGroupRef.current = pcbGroup;

      const modelsGroup = new THREE.Group();
      scene.add(modelsGroup);
      modelsGroupRef.current = modelsGroup;

      // Probe label layer (DOM overlay)
      const probeLayer = document.createElement('div');
      probeLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
      container.appendChild(probeLayer);
      probeLayerRef.current = probeLayer;

      // ── Apply explosion / assembly to a whole group in-place ────────────
      const applyExplode = (group: THREE.Group | null, exp: number, asm: number) => {
        if (!group) return;
        const idle = exp === 0 && asm === 1;
        if (idle) {
          // one-time restore pass is handled below when leaving idle; in the
          // idle steady state everything is already at __baseY — skip work.
          return;
        }
        group.traverse((child) => {
          const c = child as unknown as { __baseY?: number; position?: THREE.Vector3; scale?: THREE.Vector3; visible?: boolean };
          if (c.__baseY === undefined || !c.position || !c.scale) return;
          const baseY = c.__baseY;
          // Proportional lift: higher layers rise further, so the exploded
          // view actually SEPARATES the stack (silk > pads > copper) instead
          // of moving everything up by the same amount; bottom sinks too.
          c.position.y = baseY + (baseY > 0
            ? exp * (1 + baseY * 30)
            : -exp * (1 + Math.abs(baseY) * 1.5));
          if (baseY > 0 && asm < 1) {
            c.position.y += (1 - asm) * 30;
            c.scale.setScalar(asm);
            c.visible = asm > 0.05;
          }
        });
      };
      const restoreExplode = (group: THREE.Group | null) => {
        if (!group) return;
        group.traverse((child) => {
          const c = child as unknown as { __baseY?: number; position?: THREE.Vector3; scale?: THREE.Vector3; visible?: boolean };
          if (c.__baseY === undefined || !c.position || !c.scale) return;
          c.position.y = c.__baseY;
          c.scale.setScalar(1);
          c.visible = true;
        });
      };
      let wasIdle = true;
      let lastStatsT = 0;

      // ── Animation loop ───────────────────────────────────────────────────
      const animate = () => {
        raf = requestAnimationFrame(animate);
        const now = performance.now();
        if (controlsRef.current) controlsRef.current.update();

        // camera tween (view presets / focus-component fly-to)
        const tween = camTweenRef.current;
        if (tween) {
          const t = Math.min(1, (now - tween.start) / tween.dur);
          const e = easeInOutCubic(t);
          camera.position.lerpVectors(tween.p0, tween.p1, e);
          controls.target.lerpVectors(tween.t0v, tween.t1v, e);
          if (t >= 1) camTweenRef.current = null;
        }

        // cross-section — set plane constant (materials hold the plane ref)
        if (stateRef.current.crossSection && clipPlaneRef.current) {
          clipPlaneRef.current.constant = stateRef.current.crossSectionX * stateRef.current.boardW;
          renderer.localClippingEnabled = true;
        } else {
          renderer.localClippingEnabled = false;
        }

        // explosion / assembly
        {
          const exp = stateRef.current.explosion;
          const asm = stateRef.current.assembly;
          const idle = exp === 0 && asm === 1;
          if (idle && !wasIdle) {
            restoreExplode(pcbGroupRef.current);
            restoreExplode(modelsGroupRef.current);
          }
          if (!idle) {
            applyExplode(pcbGroupRef.current, exp, asm);
            applyExplode(modelsGroupRef.current, exp, asm);
          }
          wasIdle = idle;
        }

        // ── Live electrical state (ONE compute per frame, shared by all) ──
        const es = useEditor.getState();
        const sim = es.simContext;
        let compCurrents: Map<string, number> | null = null;
        if (sim && es.components.length) {
          if (pluginMapCacheRef.current?.components !== es.components) {
            const plugins = new Map<string, NonNullable<ReturnType<typeof getPlugin>>>();
            for (const c of es.components) {
              const p = getPlugin(c.type);
              if (p) plugins.set(c.type, p);
            }
            pluginMapCacheRef.current = { components: es.components, plugins };
          }
          const plugins = pluginMapCacheRef.current!.plugins;
          try {
            compCurrents = computeComponentCurrents(es.components, es.wires, plugins, sim);
          } catch { compCurrents = null; }
        }

        // live component states: LED glow + 7-segment digits
        if (liveModelsRef.current && modelsGroupRef.current) {
          const st = (sim?.state as unknown as Record<string, unknown>)?.__global ?? {};
          for (const child of modelsGroupRef.current.children as unknown as Record<string, unknown>[]) {
            if (child.__updateEmissive) {
              (child.__updateEmissive as (a: number) => void)(compCurrents?.get(child.__componentId as string) ?? 0);
            } else if (child.__updateSegments) {
              const segStates = (st[`7seg_${child.__componentId}`] ?? {}) as Record<string, boolean>;
              let mask = 0;
              const segBits: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6 };
              for (const [seg, bit] of Object.entries(segBits)) {
                if (segStates[seg]) mask |= (1 << bit);
              }
              (child.__updateSegments as (m: number) => void)(mask);
            }
          }
          if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__3D_PROBE__) {
            (window as unknown as Record<string, (x: unknown) => void>).__3D_PROBE__({
              live: liveModelsRef.current,
              simTime: sim?.time,
              children: (modelsGroupRef.current!.children as unknown as Record<string, unknown>[]).map((c) => ({
                componentId: c.__componentId,
                hasEmissiveHook: !!c.__updateEmissive,
                current: compCurrents?.get(c.__componentId as string) ?? null,
              })),
            });
          }
        }

        // current-flow particles + voltage heat (share one net-flow compute)
        const flowOn = stateRef.current.showCurrentFlow;
        const heatOn = stateRef.current.showVoltageHeat;
        if ((flowOn || heatOn) && sim && es.components.length && pcbGroupRef.current) {
          let netFlow: Map<string, { current: number; anchor: { x: number; y: number } | null; voltage: number | null }> | null = null;
          try {
            netFlow = computeNetFlow(footprintsRef.current, es.components, es.wires, pluginMapCacheRef.current?.plugins ?? new Map(), sim);
          } catch { netFlow = null; }
          if (flowOn && flowFieldRef.current) {
            if (netFlow && es.running) {
              flowFieldRef.current.setNetFlow(netFlow);
              flowFieldRef.current.update(now / 1000);
            } else {
              flowFieldRef.current.points.visible = false;
            }
          }
          if (heatOn && netFlow) recolorByVoltage(netFlow);
        } else if (flowFieldRef.current && flowOn && !es.running) {
          flowFieldRef.current.points.visible = false;
        }

        // voltage probes — update DOM labels directly (no React re-render)
        if (stateRef.current.showVoltageProbes && probeLayerRef.current && cameraRef.current) {
          updateProbeLabels(compCurrents);
        } else if (probeLayerRef.current) {
          probeLabelsRef.current.forEach((el) => { el.style.display = 'none'; });
        }

        // selection / hover rings: pulse + follow
        updateRings(now);

        // live values in the info card
        if (stateRef.current.selectedFpId) updateInfoCard(compCurrents);

        // hover raycast (once per frame, using last pointer position)
        updateHover();

        // scene stats probe (debug/verification hook, refreshed ~1 Hz)
        if (typeof window !== 'undefined' && now - lastStatsT > 1000) {
          lastStatsT = now;
          // DEBUG: expose renderer/scene/camera for live introspection
          (window as unknown as Record<string, unknown>).__3D_DEBUG__ = {
            renderer, scene, camera, controls,
            get info() { return renderer.info.render; },
          };
          (window as unknown as Record<string, unknown>).__3D_VIEWHELPER__ = viewHelperRef.current;
          let pcbMeshes = 0;
          let modelMeshes = 0;
          pcbGroupRef.current?.traverse((c) => { if (c instanceof THREE.Mesh) pcbMeshes++; });
          modelsGroupRef.current?.traverse((c) => { if (c instanceof THREE.Mesh) modelMeshes++; });
          // DEBUG: expose group bounding boxes (audit tooling)
          const dbgB = (g: THREE.Group | null) => {
            if (!g) return null;
            const b = new THREE.Box3().expandByObject(g);
            return b.isEmpty() ? null : {
              min: [b.min.x, b.min.y, b.min.z].map((v) => Math.round(v * 10) / 10),
              max: [b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 10) / 10),
            };
          };
          (window as unknown as Record<string, unknown>).__3D_STATS__ = {
            pcbMeshes,
            modelMeshes,
            drawCalls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            fps: Math.round(1000 / Math.max(1, frameStatsRef.current.avg)),
            tier: frameStatsRef.current.tier,
            pcbBounds: dbgB(pcbGroupRef.current),
            modelBounds: dbgB(modelsGroupRef.current),
            flowBounds: dbgB(flowFieldRef.current ? (flowFieldRef.current.points as unknown as THREE.Group) : null),
          };
        }

        // adaptive quality: step down tiers when frames are consistently slow
        // (software GL or weak iGPUs). Tier 2 = GTAO+SMAA+MSAA+DPR≤2,
        // 1 = bloom+MSAA+DPR 1.25, 0 = raw renderer + DPR 1.
        {
          const fs = frameStatsRef.current;
          const dt = now - (fs.last || now);
          fs.last = now;
          fs.avg = fs.avg * 0.95 + dt * 0.05;
          if (fs.tier > 0 && dt > 40) {
            fs.slowFrames++;
            if (fs.slowFrames > 30 || (fs.slowFrames > 3 && dt > 400)) {
              applyQualityRef.current?.(fs.tier - 1, fs.tier === 2 ? 1.25 : 1);
              setQualityTier(fs.tier);
              setPerfMode(true);
              fs.slowFrames = 0;
            }
          } else if (dt < 20) {
            fs.slowFrames = Math.max(0, fs.slowFrames - 1);
          }
        }

        // render (tier 0 bypasses post-processing entirely)
        // ViewHelper.render() sets its own corner viewport (and restores it)
        // — but reset ours defensively anyway, editor.js-style, so a stale
        // scissor/viewport from ANY pass can never shrink the main render.
        {
          const sz = renderer.getSize(_v2);
          renderer.setViewport(0, 0, sz.x, sz.y);
          renderer.setScissorTest(false);
        }
        if (composerRef.current && frameStatsRef.current.tier > 0) {
          composerRef.current.render();
        } else {
          renderer.render(scene, camera);
        }
        // orientation gizmo on top (its own corner viewport, after the main
        // pass). CRITICAL: helper.render() calls renderer.render() with
        // autoClear on — without disabling it, the gizmo's implicit clear
        // WIPES THE WHOLE CANVAS (the clear is not clipped to the gizmo's
        // 128 px viewport — no scissor), erasing the scene every frame.
        try {
          const helper = viewHelperRef.current;
          if (helper) {
            if (helper.animating) {
              helper.update(1 / 60);
              camera.updateProjectionMatrix();
            } else {
              renderer.autoClear = false;
              helper.render(renderer);
              renderer.autoClear = true;
            }
          }
        } catch { /* gizmo optional */ }

        // screenshot capture (canvas is valid right after render)
        if (screenshotRef.current) {
          try {
            const url = renderer.domElement.toDataURL('image/png');
            const a = document.createElement('a');
            a.href = url;
            a.download = screenshotRef.current;
            a.click();
          } catch { /* capture failed */ }
          screenshotRef.current = null;
        }
      };
      raf = requestAnimationFrame(animate);

      // ── Interaction: hover raycast helpers ──────────────────────────────
      const updateHover = () => {
        if (!modelsGroupRef.current || !cameraRef.current) return;
        const canvas = renderer.domElement;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        raycasterRef.current.setFromCamera(pointerRef.current, cameraRef.current);
        const hits = raycasterRef.current.intersectObjects(modelsGroupRef.current.children, true);
        let fpId: string | null = null;
        if (hits.length) {
          let obj: THREE.Object3D | null = hits[0].object;
          while (obj && !(obj as unknown as { __footprintId?: string }).__footprintId) obj = obj.parent;
          fpId = (obj as unknown as { __footprintId?: string } | null)?.__footprintId ?? null;
        }
        if (typeof window !== 'undefined') {
          const models: { fpId: string | null; sx: number; sy: number }[] = [];
          for (const child of modelsGroupRef.current.children) {
            const box = new THREE.Box3().expandByObject(child);
            const c = box.getBoundingSphere(new THREE.Sphere()).center;
            c.project(cameraRef.current);
            models.push({
              fpId: (child as unknown as { __footprintId?: string }).__footprintId ?? null,
              sx: Math.round(((c.x + 1) / 2) * rect.width + rect.left),
              sy: Math.round(((1 - (c.y + 1) / 2)) * rect.height + rect.top),
            });
          }
          (window as unknown as Record<string, unknown>).__3D_HOVER__ = {
            pointer: { x: pointerRef.current.x, y: pointerRef.current.y },
            canvasRect: { w: Math.round(rect.width), h: Math.round(rect.height) },
            hits: hits.length,
            fpId,
            modelChildren: modelsGroupRef.current.children.length,
            modelScreenPos: models,
          };
        }
        if (fpId !== hoverFpIdRef.current) {
          hoverFpIdRef.current = fpId;
          canvas.style.cursor = fpId ? 'pointer' : 'grab';
        }
      };
      const setPointerFromEvent = (e: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointerRef.current.set(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
      };

      const onPointerMove = (e: PointerEvent) => setPointerFromEvent(e);
      const downScreenRef = { x: 0, y: 0 };
      const onPointerDown = (e: PointerEvent) => {
        setPointerFromEvent(e);
        downScreenRef.x = e.clientX;
        downScreenRef.y = e.clientY;
      };
      const onClick = (e: MouseEvent) => {
        // ignore orbit drags: only select when the pointer barely moved
        if (Math.hypot(e.clientX - downScreenRef.x, e.clientY - downScreenRef.y) > 5) return;
        if (!cameraRef.current) return;
        setPointerFromEvent(e as unknown as PointerEvent);
        raycasterRef.current.setFromCamera(pointerRef.current, cameraRef.current);
        if (!modelsGroupRef.current) return;
        const hits = raycasterRef.current.intersectObjects(modelsGroupRef.current.children, true);
        let fpId: string | null = null;
        if (hits.length) {
          let obj: THREE.Object3D | null = hits[0].object;
          while (obj && !(obj as unknown as { __footprintId?: string }).__footprintId) obj = obj.parent;
          fpId = (obj as unknown as { __footprintId?: string } | null)?.__footprintId ?? null;
        }
        setSelectedFpId(fpId);
      };
      const onDblClick = (e: MouseEvent) => {
        if (!cameraRef.current) return;
        setPointerFromEvent(e as unknown as PointerEvent);
        raycasterRef.current.setFromCamera(pointerRef.current, cameraRef.current);
        if (!modelsGroupRef.current) return;
        const hits = raycasterRef.current.intersectObjects(modelsGroupRef.current.children, true);
        if (!hits.length) return;
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj && !(obj as unknown as { __footprintId?: string }).__footprintId) obj = obj.parent;
        const fp = footprintsRef.current.find((f) => f.id === (obj as unknown as { __footprintId?: string })?.__footprintId);
        if (fp) focusFootprint(fp);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setSelectedFpId(null);
      };
      renderer.domElement.addEventListener('pointermove', onPointerMove);
      renderer.domElement.addEventListener('pointerdown', onPointerDown);
      renderer.domElement.addEventListener('click', onClick);
      renderer.domElement.addEventListener('dblclick', onDblClick);
      window.addEventListener('keydown', onKey);
      const removeInteraction = () => {
        renderer.domElement.removeEventListener('pointermove', onPointerMove);
        renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        renderer.domElement.removeEventListener('click', onClick);
        renderer.domElement.removeEventListener('dblclick', onDblClick);
        renderer.domElement.removeEventListener('pointerup', helperClick, true);
        window.removeEventListener('keydown', onKey);
      };

      // ResizeObserver — handles panel splits
      const resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
        const w = Math.max(1, containerRef.current.clientWidth);
        const h = Math.max(1, containerRef.current.clientHeight);
        rendererRef.current.setSize(w, h);
        if (composerRef.current) composerRef.current.setSize(w, h);
        if (bloomPassRef.current) bloomPassRef.current.setSize(w, h);
        cameraRef.current.aspect = w / h;
        cameraRef.current.updateProjectionMatrix();
      });
      resizeObserver.observe(container);

      if (!cancelled) setLoading(false);

      // Cleanup
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        removeInteraction();
        resizeObserver.disconnect();
        flowFieldRef.current?.dispose();
        flowFieldRef.current = null;
        scene.traverse((child) => {
          if (child instanceof THREE.Mesh) child.geometry?.dispose();
        });
        materialCacheRef.current.dispose();
        if (rendererRef.current) {
          rendererRef.current.dispose();
          if (rendererRef.current.domElement?.parentNode) {
            rendererRef.current.domElement.parentNode.removeChild(rendererRef.current.domElement);
          }
        }
        if (composerRef.current) composerRef.current.dispose?.();
        composerRef.current = null;
        bloomPassRef.current = null;
        gtaoPassRef.current = null;
        if (probeLayerRef.current && probeLayerRef.current.parentNode) {
          probeLayerRef.current.parentNode.removeChild(probeLayerRef.current);
        }
        probeLabelsRef.current.clear();
      };
    } catch (err) {
      if (!cancelled) setError(`3D init failed: ${(err as Error).message}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ONE-TIME init only

  // footprints mirror for the one-time animation loop (avoids stale closure)
  const footprintsRef = useRef(footprints);
  useEffect(() => { footprintsRef.current = footprints; }, [footprints]);

  // ── Auto-frame camera the first time footprints appear ───────────────────
  // StrictMode double-mounts in dev: the cleanup cancels the RAF, so the
  // "already framed" guard must live INSIDE the callback — a mount-time
  // guard made the second mount skip re-scheduling and the auto-frame
  // silently never ran (camera stayed wherever init left it).
  const hasAutoFramedRef = useRef(false);
  useEffect(() => {
    if (footprints.length === 0) return;
    if (!cameraRef.current || !controlsRef.current) return;
    const id = requestAnimationFrame(() => {
      if (hasAutoFramedRef.current) return;
      if (!cameraRef.current || !controlsRef.current) return;
      hasAutoFramedRef.current = true;
      frameBoard(true);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [footprints.length, board.width, board.height]);

  // ── Camera helpers: tween, presets, focus ────────────────────────────────
  function tweenTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 650) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    camTweenRef.current = {
      p0: camera.position.clone(), p1: pos.clone(),
      t0v: controls.target.clone(), t1v: target.clone(),
      start: performance.now(), dur,
    };
  }

  function sceneBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    if (pcbGroupRef.current) box.expandByObject(pcbGroupRef.current);
    if (modelsGroupRef.current) box.expandByObject(modelsGroupRef.current);
    return box;
  }

  function frameBoard(instant = false) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const box = sceneBounds();
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    // Frame against the SMALLER of the camera's horizontal/vertical FOV so
    // the board always fits regardless of aspect (framing against vertical
    // FOV alone over-zooms-out on wide viewports — the board shrank to a
    // ~190 px speck when the panel width was large).
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const dist = Math.max(10, (sphere.radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.06);
    const dir = new THREE.Vector3(0.55, 0.72, 0.55).normalize();
    const pos = sphere.center.clone().add(dir.multiplyScalar(dist));
    // eslint-disable-next-line no-console
    console.info('[3D] frameBoard: radius', sphere.radius.toFixed(1), '→ dist', dist.toFixed(1), 'aspect', camera.aspect.toFixed(2));
    if (instant) {
      camera.position.copy(pos);
      controls.target.copy(sphere.center);
      controls.update();
    } else {
      tweenTo(pos, sphere.center);
    }
  }

  const VIEW_DIRS: Record<string, THREE.Vector3> = {
    top: new THREE.Vector3(0.001, 1, 0.0012),
    iso: new THREE.Vector3(0.62, 0.62, 0.55),
    front: new THREE.Vector3(0, 0.28, 1),
  };
  function viewPreset(kind: 'top' | 'iso' | 'front') {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const box = sceneBounds();
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = (camera.fov * Math.PI) / 180;
    const dist = Math.max(10, (sphere.radius / Math.sin(fov / 2)) * 1.1);
    const pos = sphere.center.clone().add(VIEW_DIRS[kind].clone().normalize().multiplyScalar(dist));
    tweenTo(pos, sphere.center, 550);
  }

  function focusFootprint(fp: Footprint) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls || !modelsGroupRef.current) return;
    const model = modelsGroupRef.current.children.find(
      (c) => (c as unknown as { __footprintId?: string }).__footprintId === fp.id,
    );
    const box = new THREE.Box3();
    if (model) box.expandByObject(model);
    else box.set(new THREE.Vector3(fp.position.x - 4, 0, fp.position.y - 4), new THREE.Vector3(fp.position.x + 4, 6, fp.position.y + 4));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = (camera.fov * Math.PI) / 180;
    const dist = Math.max(9, (Math.max(sphere.radius, 4) / Math.sin(fov / 2)) * 0.95);
    const dir = new THREE.Vector3(0.5, 0.75, 0.65).normalize();
    tweenTo(sphere.center.clone().add(dir.multiplyScalar(dist)), sphere.center, 700);
  }

  // ── Selection / hover rings ──────────────────────────────────────────────
  function buildRingGeometry(fp: Footprint, thickness: number): THREE.BufferGeometry {
    const m = 0.8; // margin around the courtyard
    const w = Math.max(3, fp.bodySize.width) + m * 2;
    const h = Math.max(3, fp.bodySize.height) + m * 2;
    const r = Math.min(w, h) * 0.22;
    const outer = new THREE.Shape();
    // rounded rect (centered)
    outer.moveTo(-w / 2 + r, -h / 2);
    outer.lineTo(w / 2 - r, -h / 2);
    outer.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    outer.lineTo(w / 2, h / 2 - r);
    outer.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    outer.lineTo(-w / 2 + r, h / 2);
    outer.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    outer.lineTo(-w / 2, -h / 2 + r);
    outer.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    const iw = w - thickness * 2;
    const ih = h - thickness * 2;
    const ir = Math.max(0.01, r - thickness);
    const inner = new THREE.Path();
    inner.moveTo(-iw / 2 + ir, -ih / 2);
    inner.lineTo(iw / 2 - ir, -ih / 2);
    inner.quadraticCurveTo(iw / 2, -ih / 2, iw / 2, -ih / 2 + ir);
    inner.lineTo(iw / 2, ih / 2 - ir);
    inner.quadraticCurveTo(iw / 2, ih / 2, iw / 2 - ir, ih / 2);
    inner.lineTo(-iw / 2 + ir, ih / 2);
    inner.quadraticCurveTo(-iw / 2, ih / 2, -iw / 2, ih / 2 - ir);
    inner.lineTo(-iw / 2, -ih / 2 + ir);
    inner.quadraticCurveTo(-iw / 2, -ih / 2, -iw / 2 + ir, -ih / 2);
    outer.holes.push(inner);
    const geo = new THREE.ExtrudeGeometry(outer, { depth: 0.05, bevelEnabled: false, curveSegments: 5 });
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  function setRing(
    ringRef: MutableRefObject<THREE.Mesh | null>,
    fp: Footprint | null,
    color: number,
    thickness: number,
  ) {
    const old = ringRef.current;
    if (old) {
      old.geometry.dispose();
      (old.material as THREE.Material).dispose();
      old.parent?.remove(old);
      ringRef.current = null;
    }
    if (!fp || !sceneRef.current) return;
    const mesh = new THREE.Mesh(
      buildRingGeometry(fp, thickness),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    mesh.position.set(fp.position.x, 0.18, fp.position.y);
    mesh.rotation.y = -(fp.rotation * Math.PI) / 180;
    mesh.renderOrder = 20;
    sceneRef.current.add(mesh);
    ringRef.current = mesh;
  }

  const hoverRingFpRef = useRef<string | null>(null);
  function updateRings(now: number) {
    const sel = stateRef.current.selectedFpId;
    const selFp = footprintsRef.current.find((f) => f.id === sel) ?? null;
    if (selectRingRef.current ? selectRingRef.current.name !== `sel:${sel}` : sel) {
      setRing(selectRingRef, selFp, 0x22d3ee, 0.28);
      if (selectRingRef.current) selectRingRef.current.name = `sel:${sel}`;
    }
    const hover = hoverFpIdRef.current;
    if (hover !== hoverRingFpRef.current) {
      hoverRingFpRef.current = hover;
      const hoverFp = footprintsRef.current.find((f) => f.id === hover) ?? null;
      setRing(hoverRingRef, hoverFp, 0xfbbf24, 0.14);
    }
    // pulse the selection ring; gently breathe the hover ring
    if (selectRingRef.current) {
      const s = 1 + 0.02 * Math.sin(now * 0.005);
      selectRingRef.current.scale.set(s, 1, s);
    }
  }

  // rebuild rings when footprints change (geometry depends on bodySize)
  useEffect(() => {
    const sel = stateRef.current.selectedFpId;
    const selFp = footprints.find((f) => f.id === sel) ?? null;
    setRing(selectRingRef, selFp, 0x22d3ee, 0.28);
    if (selectRingRef.current) selectRingRef.current.name = `sel:${sel}`;
    hoverRingFpRef.current = null; // force hover rebuild
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [footprints]);

  // ── Recolor copper by live net voltage (heat mode) ────────────────────────
  const GOLD_BASE = 0xd9b96c;
  function recolorByVoltage(netFlow: Map<string, { voltage: number | null }>) {
    let vMin = 0;
    let vMax = 0;
    for (const d of netFlow.values()) {
      if (d.voltage == null) continue;
      vMin = Math.min(vMin, d.voltage);
      vMax = Math.max(vMax, d.voltage);
    }
    if (vMax - vMin < 1e-6) vMax = vMin + 1e-6;
    for (const [net, mats] of netMatsRef.current) {
      const v = netFlow.get(net)?.voltage;
      const c = v == null ? new THREE.Color(GOLD_BASE) : voltageColor(v, vMin, vMax);
      for (const m of mats) m.color.copy(c);
    }
  }

  // mode transitions for copper coloring (heat is driven per-frame above).
  // Heat/net-color modes ease the mask opacity up so the recolored copper
  // under the LPI reads clearly (KiCad x-ray-style data visualization).
  useEffect(() => {
    for (const m of maskMatsRef.current) m.opacity = showVoltageHeat || showNetColors ? 0.35 : 0.62;
    const netMats = netMatsRef.current;
    if (showNetColors && !showVoltageHeat) {
      for (const [net, list] of netMats) {
        const c = netColor(net);
        for (const m of list) m.color.copy(c);
      }
    } else if (!showVoltageHeat) {
      for (const [, list] of netMats) {
        for (const m of list) m.color.set(GOLD_BASE);
      }
    }
  }, [showNetColors, showVoltageHeat, footprints, traces]);

  // ── AO toggle ─────────────────────────────────────────────────────────────
  useEffect(() => { aoEnabledRef.current = aoEnabled; }, [aoEnabled]);
  useEffect(() => {
    if (gtaoPassRef.current) gtaoPassRef.current.enabled = aoEnabled && frameStatsRef.current.tier >= 2;
  }, [aoEnabled]);

  // ── Autorotate ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (controlsRef.current) controlsRef.current.autoRotate = autoRotate;
  }, [autoRotate]);

  // ── Rebuild PCB group (board, silkscreen, copper, vias, fillets) ─────────
  // Everything static is MERGED per net so a routed board costs a handful of
  // draw calls instead of hundreds (the old per-segment boxes were both slow
  // and visually "floating strips").
  useEffect(() => {
    if (!sceneRef.current || !pcbGroupRef.current) return;
    const group = pcbGroupRef.current;

    // dispose previous build (geometry + per-net materials + textures)
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        const mat = child.material as (THREE.Material & { map?: THREE.Texture }) | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else {
          mat.map?.dispose?.();
          mat.dispose();
        }
      }
    });
    while (group.children.length > 0) group.remove(group.children[0]);
    netMatsRef.current.clear();

    // dispose + detach the flow field (rebuilt below)
    if (flowFieldRef.current) {
      sceneRef.current.remove(flowFieldRef.current.points);
      flowFieldRef.current.dispose();
      flowFieldRef.current = null;
    }

    if (footprints.length === 0 && traces.length === 0 && vias.length === 0) {
      // EMPTY STATE GHOST: still render the bare board (FR4 + mask + silk
      // title) so the viewport is never a dead void — you can verify the
      // camera/lighting work and see the board you're about to populate.
      const gw = board.width;
      const gh = board.height;
      const gcorner = Math.min(2.5, gw / 8, gh / 8);
      const gFr4 = new THREE.Mesh(boardGeometry(gw, gh, BOARD_THICKNESS, gcorner), fr4Material());
      gFr4.receiveShadow = true;
      group.add(gFr4);
      const gMask = new THREE.Mesh(boardGeometry(gw, gh, MASK_T, gcorner), solderMaskMaterial());
      gMask.position.y = COPPER_TOP_Y + MASK_T;
      gMask.receiveShadow = true;
      group.add(gMask);
      try {
        const { texture } = buildSilkscreenTexture([], board);
        const ghostMat = new THREE.MeshStandardMaterial({
          map: texture, transparent: true, roughness: 0.75, metalness: 0.0,
          color: 0x8b93a0, envMapIntensity: 0.25, depthWrite: false,
        });
        const silk = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh), ghostMat);
        silk.rotation.x = -Math.PI / 2;
        silk.position.set(gw / 2, SILK_Y, gh / 2);
        group.add(silk);
      } catch { /* ghost silk optional */ }
      return;
    }

    const w = board.width;
    stateRef.current.boardW = w;
    const h = board.height;
    const corner = Math.min(2.5, w / 8, h / 8);
    const clip = clipPlaneRef.current;

    // 1. Substrate — the real sandwich: green mask slab / tan FR4 core /
    //    green mask slab. The FR4 edge is what makes a board read as a
    //    physical object instead of a green sticker.
    const fr4Mat = fr4Material();
    if (clip) { fr4Mat.clippingPlanes = [clip]; fr4Mat.clipShadows = true; }
    const fr4 = new THREE.Mesh(boardGeometry(w, h, BOARD_THICKNESS, corner), fr4Mat);
    fr4.receiveShadow = true;
    fr4.castShadow = true;
    group.add(fr4);

    const maskMat = solderMaskMaterial();
    if (clip) { maskMat.clippingPlanes = [clip]; maskMat.clipShadows = true; }
    maskMatsRef.current = [maskMat];
    // Real layer sandwich: FR4 [−1.6, 0] → copper [0, 0.08] → LPI mask
    // [0.08, 0.14] (semi-transparent — copper ghosts through like KiCad)
    // → silk at 0.148. Pads/vias pierce the mask as exposed gold.
    const topMask = new THREE.Mesh(boardGeometry(w, h, MASK_T, corner), maskMat);
    topMask.position.y = COPPER_TOP_Y + MASK_T;
    topMask.receiveShadow = true;
    group.add(topMask);
    const botMask = new THREE.Mesh(boardGeometry(w, h, MASK_T, corner), maskMat);
    botMask.position.y = BOT_COPPER_Y;
    botMask.receiveShadow = true;
    group.add(botMask);

    // 2. Photographic silkscreen (courtyards, refdes, pin-1, title block)
    try {
      const { texture } = buildSilkscreenTexture(footprints, board);
      const silkMat = new THREE.MeshStandardMaterial({
        map: texture, transparent: true, roughness: 0.75, metalness: 0.0,
        color: 0xbfc6cc, envMapIntensity: 0.3, depthWrite: false,
      });
      if (clip) silkMat.clippingPlanes = [clip];
      const silk = new THREE.Mesh(new THREE.PlaneGeometry(w, h), silkMat);
      silk.rotation.x = -Math.PI / 2;
      silk.position.set(w / 2, SILK_Y, h / 2);
      silk.receiveShadow = true;
      (silk as unknown as { __baseY: number }).__baseY = SILK_Y;
      group.add(silk);
    } catch { /* silkscreen optional */ }

    // 3. Copper per (net, layer): traces + pads + via barrels, merged
    const buckets = new Map<string, { geos: THREE.BufferGeometry[]; baseY?: number }>();
    const push = (key: string, geo: THREE.BufferGeometry | null, baseY?: number) => {
      if (!geo) return;
      const b = buckets.get(key) ?? { geos: [], baseY };
      b.geos.push(geo);
      if (b.baseY === undefined) b.baseY = baseY;
      buckets.set(key, b);
    };

    for (const trace of traces) {
      const y = layerYOf(trace.layer);
      for (const geo of traceGeometries(trace, y)) {
        push(`${trace.net}||${trace.layer}`, geo, y);
      }
    }

    const drillGeos: THREE.BufferGeometry[] = [];
    const filletGeos: THREE.BufferGeometry[] = [];

    for (const fp of footprints) {
      const hasModel = hasProceduralModel(fp.componentType) || !!fp.modelUrl;
      for (const pad of fp.pads) {
        const wp = padWorldPosition(fp, pad);
        const layer = (pad.layer ?? fp.side) || 'top';
        // pads PIERCE the mask: top pads span [0.08, 0.16], exposing their
        // gold tops above the LPI; bottom pads span [−1.76, −1.68].
        const padY = layer === 'bottom' ? PAD_BOT_Y : PAD_TOP_Y;
        push(`${pad.net ?? fp.id}||${layer}`, padGeometry(pad, wp.x, wp.y, padY, -(fp.rotation * Math.PI) / 180), padY);
        if (pad.drill && pad.drill > 0) {
          const drillR = Math.max(0.06, pad.drill / 2);
          // drill spans the full stack: pad top → past the bottom mask
          const drill = new THREE.CylinderGeometry(drillR, drillR, PAD_TOP_Y - (PAD_BOT_Y - 0.08) + 0.04, 12);
          drill.translate(wp.x, (PAD_TOP_Y + PAD_BOT_Y - 0.08) / 2, wp.y);
          drillGeos.push(drill);
        }
        // solder fillet on EVERY populated pad — THT meniscus or the smaller
        // SMD reflow fillet (real boards are never "glued flat")
        if (hasModel) {
          const fillet = solderFilletGeometry(pad, wp.x, wp.y, layer === 'bottom' ? PAD_BOT_Y - 0.08 : PAD_TOP_Y);
          if (fillet) filletGeos.push(fillet);
        }
      }
    }

    for (const via of vias) {
      const [gold, drill] = viaGeometries(via, PAD_TOP_Y, PAD_BOT_Y - 0.08);
      push(`${via.net}||via`, gold, undefined); // vias stay with the board
      drillGeos.push(drill);
    }

    const goldTemplate = goldMaterial();
    for (const [key, { geos, baseY }] of buckets) {
      if (!geos.length) continue;
      let merged: THREE.BufferGeometry;
      try {
        merged = mergeAll(geos);
        geos.forEach((g) => { if (g !== merged) g.dispose(); });
      } catch {
        merged = geos[0];
      }
      const net = key.split('||')[0];
      const mat = goldTemplate.clone();
      if (clip) { mat.clippingPlanes = [clip]; mat.clipShadows = true; }
      const list = netMatsRef.current.get(net) ?? [];
      list.push(mat);
      netMatsRef.current.set(net, list);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.receiveShadow = true;
      if (baseY !== undefined) (mesh as unknown as { __baseY: number }).__baseY = baseY;
      group.add(mesh);
    }
    goldTemplate.dispose();

    if (drillGeos.length) {
      try {
        const drillMat = drillMaterial();
        if (clip) drillMat.clippingPlanes = [clip];
        const merged = mergeAll(drillGeos);
        drillGeos.forEach((g) => { if (g !== merged) g.dispose(); });
        group.add(new THREE.Mesh(merged, drillMat));
      } catch { /* drills optional */ }
    }

    if (filletGeos.length) {
      try {
        const filletMat = solderMaterial();
        if (clip) { filletMat.clippingPlanes = [clip]; filletMat.clipShadows = true; }
        const merged = mergeAll(filletGeos);
        filletGeos.forEach((g) => { if (g !== merged) g.dispose(); });
        const mesh = new THREE.Mesh(merged, filletMat);
        (mesh as unknown as { __baseY: number }).__baseY = PAD_TOP_Y;
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        group.add(mesh);
      } catch { /* fillets optional */ }
    }

    // 4. Current-flow particle field for these traces
    try {
      const ff = new FlowParticleField(traces, flowLayerYOf);
      sceneRef.current.add(ff.points);
      flowFieldRef.current = ff;
    } catch { /* flow optional */ }

    // 5. Fit the key light + shadow frustum to the board
    const sceneAny = sceneRef.current as unknown as Record<string, unknown>;
    const key = sceneAny.__keyLight as THREE.DirectionalLight | undefined;
    const fill = sceneAny.__fillLight as THREE.DirectionalLight | undefined;
    const rim = sceneAny.__rimLight as THREE.DirectionalLight | undefined;
    const cx = w / 2;
    const cz = h / 2;
    const D = Math.hypot(w, h);
    if (key) {
      key.position.set(cx + 0.3 * D, D * 0.95 + 20, cz + 0.45 * D);
      key.target.position.set(cx, 0, cz);
      key.target.updateMatrixWorld();
      const half = Math.max(30, D * 0.8);
      key.shadow.camera.left = -half;
      key.shadow.camera.right = half;
      key.shadow.camera.top = half;
      key.shadow.camera.bottom = -half;
      key.shadow.camera.updateProjectionMatrix();
    }
    fill?.position.set(cx - 0.55 * D, D * 0.6, cz - 0.3 * D);
    rim?.position.set(cx - 0.15 * D, D * 0.5, cz - 0.85 * D);

    // restore copper coloring mode after rebuild
    if (showNetColors && !showVoltageHeat) {
      for (const [net, list] of netMatsRef.current) {
        const c = netColor(net);
        for (const m of list) m.color.copy(c);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [footprints, traces, vias, board, padNets]);

  // ── Async 3D model loading (separate from PCB group rebuild) ─────────────
  useEffect(() => {
    if (!modelsGroupRef.current) return;

    // Index currently attached root models by footprint id (roots live
    // directly under modelsGroup — traverse() would also visit children).
    const attached = new Map<string, THREE.Object3D>();
    for (const child of modelsGroupRef.current.children) {
      const id = (child as unknown as { __footprintId?: string }).__footprintId;
      if (id) attached.set(id, child);
    }

    const wantedIds = new Set<string>();
    for (const fp of footprints) wantedIds.add(fp.id);

    const toRemove: THREE.Object3D[] = [];
    for (const [id, obj] of attached) {
      if (!wantedIds.has(id)) toRemove.push(obj);
    }
    for (const obj of toRemove) {
      attached.delete((obj as unknown as { __footprintId: string }).__footprintId);
      modelsGroupRef.current.remove(obj);
      if (obj instanceof THREE.Mesh) obj.geometry?.dispose();
    }

    const cache = modelCacheRef.current;
    const inFlight = inFlightRef.current;
    const editorComps = useEditor.getState().components;
    const clip = clipPlaneRef.current;
    for (const fp of footprints) {
      const existing = attached.get(fp.id);
      if (existing) {
        // Sync pose: a model must FOLLOW its footprint — after a move,
        // rotate or side flip in PCB Layout the old code left it at its
        // original spot, hovering over stale coordinates.
        existing.position.set(fp.position.x, fp.side === 'bottom' ? MODEL_BOT_Y : MODEL_TOP_Y, fp.position.y);
        existing.rotation.y = -(fp.rotation * Math.PI) / 180;
        existing.scale.y = fp.side === 'bottom' ? -1 : 1;
        (existing as unknown as { __baseY: number }).__baseY = existing.position.y;
        continue;
      }

      const modelKey = fp.modelUrl || `default:${fp.componentType}`;

      const attachObject = (obj: THREE.Object3D) => {
        if (!modelsGroupRef.current) return;
        obj.position.set(fp.position.x, MODEL_TOP_Y, fp.position.y);
        if (fp.side === 'bottom') {
          obj.position.y = MODEL_BOT_Y;
          obj.scale.y = -1;
        }
        // ROTATION SIGN: three's rotateY(+θ) is opposite-handed to the 2D
        // board rotation (ctx.rotate / padWorldPosition) — models must use
        // −θ or their legs land on MIRRORED pads for non-180° rotations.
        obj.rotation.y = -(fp.rotation * Math.PI) / 180;
        (obj as unknown as { __baseY: number }).__baseY = obj.position.y;
        (obj as unknown as { __footprintId: string }).__footprintId = fp.id;
        (obj as unknown as { __componentId: string }).__componentId = fp.componentId;
        if (clip) {
          obj.traverse((c) => {
            if (c instanceof THREE.Mesh) {
              const mat = c.material as THREE.Material;
              mat.clippingPlanes = [clip];
            }
          });
        }
        modelsGroupRef.current.add(obj);
      };

      // 1) Procedural realistic model — flattened to ~5 draw calls, hooks kept
      if (!fp.modelUrl) {
        const comp = editorComps.find((c) => c.id === fp.componentId);
        const procedural = buildComponentModel({
          footprint: fp,
          params: (comp?.parameters as Record<string, unknown>) ?? {},
        });
        if (procedural) {
          const flat = flattenModel(procedural);
          // carry live-state hooks (LED emissive / 7-seg digits)
          const src = procedural as unknown as Record<string, unknown>;
          const dst = flat as unknown as Record<string, unknown>;
          for (const key of ['__updateEmissive', '__updateSegments']) {
            if (typeof src[key] === 'function') dst[key] = src[key];
          }
          procedural.traverse((c) => {
            if (c instanceof THREE.Mesh) c.geometry.dispose();
          });
          attachObject(flat);
          liveModelsRef.current = true;
          continue;
        }
      }

      const attachMesh = (geo: THREE.BufferGeometry) => {
        if (!modelsGroupRef.current) return;
        const mat = materialCacheRef.current.get(`model:${modelKey}`, () =>
          new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.4, metalness: 0.6 }));
        if (clip) mat.clippingPlanes = [clip];
        const mesh = new THREE.Mesh(geo, mat);
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (bb) {
          const cx = (bb.max.x + bb.min.x) / 2;
          const cy = bb.min.y;
          const cz = (bb.max.z + bb.min.z) / 2;
          mesh.position.set(fp.position.x - cx, MODEL_TOP_Y - cy, fp.position.y - cz);
        } else {
          mesh.position.set(fp.position.x, MODEL_TOP_Y, fp.position.y);
        }
        if (fp.side === 'bottom') {
          mesh.position.y = MODEL_BOT_Y;
          mesh.scale.y = -1;
        }
        mesh.rotation.y = -(fp.rotation * Math.PI) / 180;
        (mesh as unknown as { __baseY: number }).__baseY = mesh.position.y;
        (mesh as unknown as { __footprintId: string }).__footprintId = fp.id;
        (mesh as unknown as { __componentId: string }).__componentId = fp.componentId;
        mesh.castShadow = true;
        modelsGroupRef.current.add(mesh);
      };

      const cached = cache.get(modelKey);
      // The cache survives HMR, where a FAILED sentinel Symbol from the OLD
      // module version no longer === this module's sentinel — so gate on the
      // object actually having clone() (geometry) instead of symbol identity.
      if (cached && (cached as { clone?: unknown }).clone) {
        attachMesh((cached as THREE.BufferGeometry).clone());
        continue;
      }
      if (cached) continue; // FAILED sentinel (this module's or a stale one)

      inFlight.add(modelKey);
      (async () => {
        try {
          let model;
          if (fp.modelUrl) {
            const resp = await fetch(fp.modelUrl);
            const data = await resp.arrayBuffer();
            const filename = fp.modelUrl.split('/').pop() || 'model.stl';
            model = parseModel(filename, data);
          } else {
            const entry = DEFAULT_MODELS.get(fp.componentType);
            if (entry) model = parseModel('default.stl', entry.stlAscii);
            else model = null;
          }
          if (model) {
            const geo = modelToGeometry(model);
            cache.set(modelKey, geo);
            for (const fpInner of footprints) {
              const innerKey = fpInner.modelUrl || `default:${fpInner.componentType}`;
              if (innerKey === modelKey) attachMesh(geo.clone());
            }
          } else {
            cache.set(modelKey, FAILED_SENTINEL);
          }
        } catch {
          cache.set(modelKey, FAILED_SENTINEL);
        } finally {
          inFlight.delete(modelKey);
        }
      })();
    }
  }, [footprints]);

  // ── Update voltage probe labels (DOM, not React state) ───────────────────
  function updateProbeLabels(compCurrents: Map<string, number> | null) {
    if (!probeLayerRef.current || !cameraRef.current) return;
    const layer = probeLayerRef.current;
    const camera = cameraRef.current;
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    const seen = new Set<string>();

    const editorState = useEditor.getState();
    if (!nodeMapCacheRef.current ||
        nodeMapCacheRef.current.components !== editorState.components ||
        nodeMapCacheRef.current.wires !== editorState.wires) {
      const plugins = new Map<string, NonNullable<ReturnType<typeof getPlugin>>>();
      for (const c of editorState.components) {
        const p = getPlugin(c.type);
        if (p) plugins.set(c.type, p);
      }
      nodeMapCacheRef.current = {
        components: editorState.components,
        wires: editorState.wires,
        nodeMap: buildNodeMap(editorState.components, editorState.wires, plugins),
      };
    }
    const nodeMap = nodeMapCacheRef.current.nodeMap;
    const sim = editorState.simContext;

    for (const fp of footprintsRef.current) {
      const pos = new THREE.Vector3(fp.position.x, 2, fp.position.y);
      pos.project(camera);
      if (pos.z > 1) continue; // behind camera

      const screenX = ((pos.x + 1) / 2) * w;
      const screenY = ((1 - (pos.y + 1) / 2)) * h;

      let label = `${fp.refdes || fp.id}: —`;
      if (sim) {
        const comp = editorState.components.find((c) => c.id === fp.componentId);
        if (comp) {
          const plugin = getPlugin(comp.type);
          if (plugin) {
            try {
              const terms = getTerminalsForComponent(comp, plugin, nodeMap);
              const firstTerm = terms[0];
              if (firstTerm) {
                const v = sim.nodeVoltage[firstTerm.nodeId];
                const i = compCurrents?.get(comp.id) ?? 0;
                const iText = ` · ${(i * 1000).toFixed(2)}mA`;
                const pText = ` · ${(v != null ? v * i * 1000 : 0).toFixed(2)}mW`;
                label = `${fp.refdes || fp.id}: ${v != null ? v.toFixed(2) : '—'}V${iText}${pText}`;
              }
            } catch {
              // ignore
            }
          }
        }
      }

      seen.add(fp.id);
      let el = probeLabelsRef.current.get(fp.id);
      if (!el) {
        el = document.createElement('div');
        el.style.cssText =
          'position:absolute;transform:translate(-50%,-150%);padding:2px 6px;' +
          'border-radius:4px;background:rgba(8,20,40,0.88);color:#a5f3fc;' +
          'border:1px solid rgba(34,211,238,0.45);font:10px ui-monospace,monospace;' +
          'white-space:nowrap;backdrop-filter:blur(2px);';
        layer.appendChild(el);
        probeLabelsRef.current.set(fp.id, el);
      }
      el.style.display = 'block';
      el.style.left = `${screenX}px`;
      el.style.top = `${screenY}px`;
      el.textContent = label;
    }

    probeLabelsRef.current.forEach((el, id) => {
      if (!seen.has(id)) el.style.display = 'none';
    });
  }

  // ── Live info card values (imperative spans — no re-render per frame) ─────
  function updateInfoCard(compCurrents: Map<string, number> | null) {
    const es = useEditor.getState();
    const sim = es.simContext;
    const fp = footprintsRef.current.find((f) => f.id === stateRef.current.selectedFpId);
    if (!fp) return;
    const comp = es.components.find((c) => c.id === fp.componentId);
    let v: number | null = null;
    let i = 0;
    if (sim && comp) {
      const plugin = getPlugin(comp.type);
      if (plugin) {
        try {
          if (!nodeMapCacheRef.current ||
              nodeMapCacheRef.current.components !== es.components ||
              nodeMapCacheRef.current.wires !== es.wires) {
            const plugins = new Map<string, NonNullable<ReturnType<typeof getPlugin>>>();
            for (const c of es.components) {
              const p = getPlugin(c.type);
              if (p) plugins.set(c.type, p);
            }
            nodeMapCacheRef.current = {
              components: es.components, wires: es.wires,
              nodeMap: buildNodeMap(es.components, es.wires, plugins),
            };
          }
          const terms = getTerminalsForComponent(comp, plugin, nodeMapCacheRef.current.nodeMap);
          const t0 = terms[0];
          if (t0) v = sim.nodeVoltage[t0.nodeId] ?? null;
          i = compCurrents?.get(comp.id) ?? 0;
        } catch { /* values optional */ }
      }
    }
    if (infoVRef.current) infoVRef.current.textContent = v != null ? `${v.toFixed(2)} V` : '—';
    if (infoIRef.current) infoIRef.current.textContent = `${(i * 1000).toFixed(2)} mA`;
    if (infoPRef.current) infoPRef.current.textContent = v != null ? `${(v * i * 1000).toFixed(1)} mW` : '—';
    if (infoNetRef.current) {
      const nets = [...new Set(fp.pads.map((p) => p.net).filter(Boolean))].join(', ');
      infoNetRef.current.textContent = nets || '—';
    }
  }

  const selectedFp = footprints.find((f) => f.id === selectedFpId) ?? null;
  const selectedComp = selectedFp
    ? useEditor.getState().components.find((c) => c.id === selectedFp.componentId)
    : undefined;

  const btn = (active: boolean) =>
    `rounded px-2 py-1 text-left transition-colors ${active ? 'bg-cyan-600/90 text-white' : 'text-slate-300 hover:bg-slate-800'}`;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0b1322]"
      onContextMenu={(e) => e.preventDefault()}>
      <div ref={containerRef} className="absolute inset-0" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-sm text-slate-400">Loading 3D viewer...</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-sm text-rose-400">{error}</div>
        </div>
      )}
      {footprints.length === 0 && !loading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div className="rounded-lg border border-slate-700/60 bg-slate-950/80 px-6 py-4 text-center shadow-xl backdrop-blur-sm">
            <div className="text-lg font-semibold text-slate-200">3D PCB Preview</div>
            <div className="mt-1 text-sm text-slate-400">
              Import a schematic in PCB Layout mode first, then switch to 3D View.
            </div>
          </div>
        </div>
      )}
      {!loading && !error && footprints.length > 0 && (
        <>
          {/* right-side control panel */}
          <div className="absolute right-2 top-2 flex w-40 flex-col gap-0.5 rounded-md border border-slate-700/60 bg-slate-900/90 p-2 text-xs shadow-xl">
            <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Camera</div>
            <div className="grid grid-cols-2 gap-1">
              <button onClick={() => frameBoard()} className={btn(false)}>⤢ Fit</button>
              <button onClick={() => setAutoRotate(!autoRotate)} className={btn(autoRotate)}>⟳ Spin</button>
              <button onClick={() => viewPreset('top')} className={btn(false)}>Top</button>
              <button onClick={() => viewPreset('iso')} className={btn(false)}>ISO</button>
            </div>

            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Simulation</div>
            <button onClick={() => setShowCurrentFlow(!showCurrentFlow)} className={btn(showCurrentFlow)}
              title="Animated current along every trace — speed and brightness follow the live simulation">
              ⚡ Current flow
            </button>
            <button onClick={() => setShowVoltageHeat(!showVoltageHeat)} className={btn(showVoltageHeat)}
              title="Recolor copper by live net voltage">
              🌡 Voltage heat
            </button>
            <button onClick={() => setShowNetColors(!showNetColors)} className={btn(showNetColors)}
              title="Distinct color per net">
              🎨 Net colors
            </button>
            <button onClick={() => setShowVoltageProbes(!showVoltageProbes)} className={btn(showVoltageProbes)}>
              🔵 Probes
            </button>

            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Inspect</div>
            <button onClick={() => setCrossSection(!crossSection)} className={btn(crossSection)}>✂ Cross-section</button>
            {crossSection && (
              <input type="range" min={0} max={1} step={0.02} value={crossSectionX}
                onChange={(e) => setCrossSectionX(parseFloat(e.target.value))}
                className="w-36 px-1" aria-label="Cross-section position" />
            )}
            <div className="flex items-center gap-1 px-2 py-0.5">
              <span className="text-slate-500">Explode</span>
              <input type="range" min={0} max={1} step={0.05} value={explosionFactor}
                onChange={(e) => setExplosionFactor(parseFloat(e.target.value))}
                className="w-24" aria-label="Explode layers" />
            </div>
            <button onClick={() => {
                setAssemblyProgress(0);
                if (assemblyIntervalRef.current) clearInterval(assemblyIntervalRef.current);
                let p = 0;
                assemblyIntervalRef.current = setInterval(() => {
                  p += 0.02;
                  if (p >= 1) { p = 1; if (assemblyIntervalRef.current) clearInterval(assemblyIntervalRef.current); assemblyIntervalRef.current = null; }
                  setAssemblyProgress(p);
                }, 30);
              }}
              className="rounded px-2 py-1 text-left text-purple-300 transition-colors hover:bg-slate-800">
              ▶ Play assembly
            </button>

            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Render</div>
            <button onClick={() => setAoEnabled(!aoEnabled)} className={btn(aoEnabled)}
              title="Ground-truth ambient occlusion — disables automatically on slow GPUs">
              ◐ Ambient occl.
            </button>
            <button onClick={() => { screenshotRef.current = `pcb-3d-${Date.now()}.png`; }}
              className="rounded px-2 py-1 text-left text-slate-300 transition-colors hover:bg-slate-800">
              📷 Screenshot
            </button>
            {perfMode && (
              <div className="px-2 pt-1 text-[10px] text-amber-400/80">
                Performance mode (tier {qualityTier}/2)
              </div>
            )}
          </div>

          {/* selected component info card */}
          {selectedFp && (
            <div className="absolute bottom-10 left-2 w-64 rounded-lg border border-cyan-500/40 bg-slate-950/85 p-3 text-xs shadow-xl backdrop-blur">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-bold text-cyan-300">{selectedFp.refdes || selectedFp.id}</span>
                <span className="truncate text-slate-500">{selectedFp.componentType}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-slate-400">
                {paramSummary(selectedFp, selectedComp)}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div className="rounded bg-slate-900/70 px-2 py-1">
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">Voltage</div>
                  <span ref={infoVRef} className="font-mono text-cyan-200">—</span>
                </div>
                <div className="rounded bg-slate-900/70 px-2 py-1">
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">Current</div>
                  <span ref={infoIRef} className="font-mono text-emerald-200">—</span>
                </div>
                <div className="rounded bg-slate-900/70 px-2 py-1">
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">Power</div>
                  <span ref={infoPRef} className="font-mono text-amber-200">—</span>
                </div>
              </div>
              <div className="mt-2 text-[10px] text-slate-500">
                Nets: <span ref={infoNetRef} className="font-mono text-slate-400">—</span>
              </div>
              <div className="mt-1 text-[10px] text-slate-600">
                Click: select · Double-click: focus · Esc: deselect
              </div>
            </div>
          )}

          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md border border-slate-700/50 bg-[#0b1322]/80 px-3 py-1.5 text-xs font-mono text-slate-400">
            Left-drag: rotate · Right-drag: pan · Scroll: zoom
            {showCurrentFlow && running && <span className="ml-2 text-emerald-300">· ⚡ current flowing</span>}
            {showVoltageHeat && <span className="ml-2 text-orange-300">· 🌡 heat map on</span>}
          </div>
        </>
      )}
    </div>
  );
}
