'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { buildNodeMap, getTerminalsForComponent, computeComponentCurrents } from '@/lib/circuit/engine';
import { getPlugin } from '@/lib/circuit/registry';
import { DEFAULT_MODELS } from '@/lib/pcb/3d-models';
import { parseModel, modelToGeometry } from '@/lib/pcb/model-loader';
import { buildComponentModel } from '@/lib/pcb/component-models-3d';
import type { Footprint } from '@/lib/pcb/types';

const FAILED_SENTINEL = Symbol('FAILED');

// ─────────────────────────────────────────────────────────────────────────────
// Why this file uses WebGLRenderer, not WebGPURenderer:
//
// The previous version tried `three/webgpu`'s `WebGPURenderer` first and
// fell back to `WebGLRenderer`. That sounds progressive but in practice:
//   • `WebGPURenderer.renderAsync()` is asynchronous — when React state
//     updates trigger a re-render between frames, the pending render can
//     race with scene mutations, causing flicker.
//   • The WebGPU renderer does not support `localClippingEnabled` the same
//     way — the cross-section tool flipped geometry on and off.
//   • Browsers without WebGPU support silently fell back, but the fallback
//     path didn't initialize the renderer the same way (different
//     `setPixelRatio` semantics, different `domElement`).
//
// Plain `WebGLRenderer` is rock-solid, synchronous, and the clipping plane
// API works exactly as documented. For a PCB 3D viewer the visual quality
// difference is negligible, and stability wins.
// ─────────────────────────────────────────────────────────────────────────────

// Cache 3D geometries across renders. Once a model is loaded, we never re-fetch
// it — even if the entire PCB group is rebuilt, this cache is preserved.
// This is critical: without it, every state change would re-trigger fetches.
function createModelGeometryCache(): Map<string, THREE.BufferGeometry | typeof FAILED_SENTINEL> {
  return new Map();
}

// Reusable material cache — avoids creating 1000s of identical materials
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

export function PCB3DViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  const pcbGroupRef = useRef<THREE.Group | null>(null);
  const modelsGroupRef = useRef<THREE.Group | null>(null); // Separate group for 3D models so we can update them without rebuilding everything else
  const modelCacheRef = useRef(createModelGeometryCache());
  const inFlightRef = useRef<Set<string>>(new Set());
  const pendingModelFootprintsRef = useRef<Set<string>>(new Set()); // footprint IDs waiting for their model
  const materialCacheRef = useRef(createMaterialCache());
  /** true once any procedural model with live hooks (LED/7-seg) is attached */
  const liveModelsRef = useRef(false);
  /** plugin map memoized on the components array identity (live-state loop) */
  const pluginMapCacheRef = useRef<{ components: unknown; plugins: Map<string, NonNullable<ReturnType<typeof getPlugin>>> } | null>(null);
  const probeLabelsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const probeLayerRef = useRef<HTMLDivElement | null>(null);
  // Cache the (expensive) nodeMap used by voltage-probe labels, keyed on the
  // components/wires array identities — it only changes on topology edits,
  // but updateProbeLabels runs EVERY FRAME while probes are enabled.
  const nodeMapCacheRef = useRef<{
    components: unknown; wires: unknown; nodeMap: ReturnType<typeof buildNodeMap>;
  } | null>(null);
  // Assembly-play animation interval (cleared on unmount)
  const assemblyIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Visual options
  const [crossSection, setCrossSection] = useState(false);
  const [crossSectionY, setCrossSectionY] = useState(0);
  const [highQuality, setHighQuality] = useState(false);
  const [showCurrentFlow, setShowCurrentFlow] = useState(false);
  const [showVoltageProbes, setShowVoltageProbes] = useState(false);
  const [explosionFactor, setExplosionFactor] = useState(0);
  const [assemblyProgress, setAssemblyProgress] = useState(1);

  // Use refs for animation-loop state (avoids re-render on every frame)
  const stateRef = useRef({
    crossSection: false,
    crossSectionY: 0,
    showCurrentFlow: false,
    explosion: 0,
    assembly: 1,
    showVoltageProbes: false,
    highQuality: false,
  });
  useEffect(() => { stateRef.current.crossSection = crossSection; }, [crossSection]);
  useEffect(() => { stateRef.current.crossSectionY = crossSectionY; }, [crossSectionY]);
  useEffect(() => { stateRef.current.showCurrentFlow = showCurrentFlow; }, [showCurrentFlow]);
  useEffect(() => { stateRef.current.explosion = explosionFactor; }, [explosionFactor]);
  useEffect(() => { stateRef.current.assembly = assemblyProgress; }, [assemblyProgress]);
  useEffect(() => { stateRef.current.showVoltageProbes = showVoltageProbes; }, [showVoltageProbes]);
  useEffect(() => { stateRef.current.highQuality = highQuality; }, [highQuality]);

  // Clear the assembly-play interval if the viewer unmounts mid-animation
  // (previously the interval kept firing setState on an unmounted component).
  useEffect(() => () => {
    if (assemblyIntervalRef.current) clearInterval(assemblyIntervalRef.current);
  }, []);

  // PCB data
  const simContext = useEditor((s) => s.simContext);
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
      scene.background = new THREE.Color(0x0a1628);
      sceneRef.current = scene;

      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
      // Initial camera — will be auto-framed once footprints exist
      camera.position.set(board.width / 2, 50, board.height + 30);
      camera.lookAt(board.width / 2, 0, board.height / 2);
      cameraRef.current = camera;

      // Plain WebGLRenderer — synchronous, stable, no async render piles
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.localClippingEnabled = true;
      // Physically-based output: sRGB color space + filmic tone mapping —
      // metals and colored plastics only look real with ACES.
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 5;
      controls.maxDistance = 500;
      controls.maxPolarAngle = Math.PI * 0.85;
      controlsRef.current = controls;

      // Post-processing chain: render → bloom → output. The bloom pass is
      // what makes emissive parts (lit LEDs, glowing traces, 7-seg digits)
      // read as ACTUALLY lit — the halo is the visual cue for "powered".
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        0.55, // strength — subtle halo, not a fog
        0.45, // radius
        0.72, // threshold — above ~0.72 only emissive/bright metal blooms
      );
      composer.addPass(bloomPass);
      composer.addPass(new OutputPass());
      composerRef.current = composer;
      bloomPassRef.current = bloomPass;

      // Lights — studio three-point setup + environment reflections.
      // The environment map is what makes MeshStandardMaterial metal look
      // like real metal (screen-space reflections come free with PMREM).
      scene.add(new THREE.AmbientLight(0xffffff, 0.35));
      const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a3140, 0.45);
      scene.add(hemi);
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(25, 55, 30);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -80; key.shadow.camera.right = 80;
      key.shadow.camera.top = 80; key.shadow.camera.bottom = -80;
      key.shadow.camera.far = 200;
      key.shadow.bias = -0.0004;
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x93c5fd, 0.5);
      fill.position.set(-30, 35, -12); scene.add(fill);
      const back = new THREE.DirectionalLight(0xfbbf24, 0.25);
      back.position.set(0, -18, -35); scene.add(back);
      // Image-based lighting from three's built-in RoomEnvironment — no
      // network fetch, generated once via PMREM. Async import keeps the
      // init effect synchronous (the cleanup contract below stays intact).
      import('three/examples/jsm/environments/RoomEnvironment.js')
        .then(({ RoomEnvironment }) => {
          if (cancelled || !rendererRef.current) return;
          try {
            const pmrem = new THREE.PMREMGenerator(rendererRef.current);
            const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
            sceneRef.current!.environment = env.texture;
            pmrem.dispose();
          } catch {
            // Environment optional — lights alone still shade correctly
          }
        })
        .catch(() => { /* environment optional */ });

      // Grid — sized to board with margin
      const gridSize = Math.max(board.width, board.height) + 40;
      const grid = new THREE.GridHelper(gridSize, gridSize / 2, 0x334155, 0x1e293b);
      grid.position.y = -2;
      scene.add(grid);

      // Persistent clipping plane — toggled on/off via stateRef, never recreated
      const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);

      // PCB groups
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

      // Animation loop — synchronous render, no frame piling
      const animate = () => {
        raf = requestAnimationFrame(animate);
        if (controlsRef.current) controlsRef.current.update();

        // Cross-section — set plane constant directly (cheap)
        if (stateRef.current.crossSection) {
          clipPlane.constant = stateRef.current.crossSectionY;
          renderer.localClippingEnabled = true;
        } else {
          renderer.localClippingEnabled = false;
        }

        // Explosion + assembly — modify in-place, no recreation
        if (pcbGroupRef.current) {
          const exp = stateRef.current.explosion;
          const asm = stateRef.current.assembly;
          pcbGroupRef.current.traverse((child: any) => {
            if (child.__baseY !== undefined) {
              const baseY = child.__baseY;
              child.position.y = baseY + (baseY > 0 ? exp * 5 : -exp * 2);
              if (baseY > 0 && asm < 1) {
                child.position.y += (1 - asm) * 30;
                child.scale.setScalar(asm);
                child.visible = asm > 0.05;
              }
            }
          });
        }

        // Current flow animation
        if (stateRef.current.showCurrentFlow && running && pcbGroupRef.current) {
          const t = performance.now() * 0.003;
          pcbGroupRef.current.traverse((child: any) => {
            if (child.__isTrace && child.material?.emissive) {
              child.material.emissive.setRGB(0, 0.5 + 0.5 * Math.sin(t), 0.2);
              child.material.emissiveIntensity = 0.8;
            }
          });
        } else if (pcbGroupRef.current) {
          pcbGroupRef.current.traverse((child: any) => {
            if (child.__isTrace && child.material?.emissiveIntensity > 0) {
              child.material.emissive.setRGB(0, 0, 0);
              child.material.emissiveIntensity = 0;
            }
          });
        }

        // ── Live component states: LED glow + 7-segment digits ────────────
        // Procedural models expose hooks (__updateEmissive / __updateSegments);
        // feed them the CURRENT simulation currents/state so the 3D view
        // physically lights up with the circuit.
        if (liveModelsRef.current && modelsGroupRef.current) {
          const es = useEditor.getState();
          const sim = es.simContext;
          if (sim && es.components.length) {
            // plugin map memoized on the components array identity
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
              const currents = computeComponentCurrents(es.components, es.wires, plugins, sim);
              const st = (sim.state as any)?.__global ?? {};
              for (const child of modelsGroupRef.current.children as any[]) {
                if (child.__updateEmissive) {
                  child.__updateEmissive(currents.get(child.__componentId) ?? 0);
                } else if (child.__updateSegments) {
                  // 7-seg display: segStates live in sim.state.__global keyed
                  // by the component id (see physics engine's 7seg stamp)
                  const segStates = (st[`7seg_${child.__componentId}`] ?? {}) as Record<string, boolean>;
                  let mask = 0;
                  const segBits: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6 };
                  for (const [seg, bit] of Object.entries(segBits)) {
                    if (segStates[seg]) mask |= (1 << bit);
                  }
                  child.__updateSegments(mask);
                }
              }
              if (typeof window !== 'undefined' && (window as any).__3D_PROBE__) {
                (window as any).__3D_PROBE__({
                  live: liveModelsRef.current,
                  simTime: sim.time,
                  children: (modelsGroupRef.current!.children as any[]).map((c) => ({
                    componentId: c.__componentId,
                    hasEmissiveHook: !!c.__updateEmissive,
                    current: currents.get(c.__componentId) ?? null,
                  })),
                });
              }
            } catch { /* ignore */ }
          }
        }

        // Voltage probes — update DOM labels directly (no React re-render)
        if (stateRef.current.showVoltageProbes && probeLayerRef.current && cameraRef.current) {
          updateProbeLabels();
        } else if (probeLayerRef.current) {
          // Hide all labels when disabled
          probeLabelsRef.current.forEach((el) => { el.style.display = 'none'; });
        }

        // Post-processed render: bloom for lit LEDs / glowing traces.
        if (composerRef.current) {
          composerRef.current.render();
        } else {
          renderer.render(scene, camera);
        }
      };
      raf = requestAnimationFrame(animate);

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
        resizeObserver.disconnect();
        scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry?.dispose();
          }
        });
        materialCacheRef.current.dispose();
        // Don't dispose model cache here — preserve across hot reloads
        // It'll be GC'd when the component unmounts fully.
        if (rendererRef.current) {
          rendererRef.current.dispose();
          if (rendererRef.current.domElement?.parentNode) {
            rendererRef.current.domElement.parentNode.removeChild(rendererRef.current.domElement);
          }
        }
        if (composerRef.current) composerRef.current.dispose?.();
        composerRef.current = null;
        bloomPassRef.current = null;
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

  // ── Auto-frame camera the first time footprints appear ───────────────────
  // (NOT on every model load — that was the previous flicker bug)
  const hasAutoFramedRef = useRef(false);
  useEffect(() => {
    if (hasAutoFramedRef.current) return;
    if (footprints.length === 0) return;
    if (!cameraRef.current || !controlsRef.current) return;
    hasAutoFramedRef.current = true;

    const centerX = board.width / 2;
    const centerZ = board.height / 2;
    const maxDim = Math.max(board.width, board.height, 30);
    const dist = maxDim * 1.5;
    cameraRef.current.position.set(centerX + dist * 0.5, dist * 0.8, centerZ + dist * 0.5);
    controlsRef.current.target.set(centerX, 0, centerZ);
    controlsRef.current.update();
  }, [footprints.length, board.width, board.height]);

  // ── Rebuild PCB group (board, traces, vias, pads) ───────────────────────
  // This DOES rebuild on data change — but it's cheap (a few hundred meshes)
  // and DOES NOT touch the 3D models group, so async model loads don't trigger it.
  useEffect(() => {
    if (!sceneRef.current) return;
    if (footprints.length === 0 && traces.length === 0 && vias.length === 0) {
      // Nothing to render — clear existing group
      if (pcbGroupRef.current) {
        disposeGroup(pcbGroupRef.current);
        while (pcbGroupRef.current.children.length > 0) {
          pcbGroupRef.current.remove(pcbGroupRef.current.children[0]);
        }
      }
      return;
    }

    // Dispose old meshes in the pcb group, but keep the group itself
    if (pcbGroupRef.current) {
      disposeGroup(pcbGroupRef.current);
      while (pcbGroupRef.current.children.length > 0) {
        pcbGroupRef.current.remove(pcbGroupRef.current.children[0]);
      }
    } else {
      const g = new THREE.Group();
      sceneRef.current.add(g);
      pcbGroupRef.current = g;
    }

    const group = pcbGroupRef.current;
    const BOARD_THICKNESS = 1.6;

    // Board substrate — rounded-rect extrusion (real PCB outline look)
    // + FR4 core between copper layers: lighter fiberglass visible on the
    // board's side / in cross-section.
    // NOTE: the shape's Y is NEGATED before rotateX(−π/2) so board-Y maps
    // to world +Z unmirrored, and the front cap (normal +Y) ends up as the
    // TOP face at y=0 — with rotateX(+π/2) instead, the top cap's normal
    // faced DOWN, got backface-culled, and the camera saw the raw FR4 core
    // through the hole (the "cream board" bug).
    const boardLayerGeometry = (bw: number, bh: number, depth: number, corner: number): THREE.ExtrudeGeometry => {
      const shape = new THREE.Shape();
      shape.moveTo(corner, 0);
      shape.lineTo(bw - corner, 0);
      shape.quadraticCurveTo(bw, 0, bw, -corner);
      shape.lineTo(bw, -(bh - corner));
      shape.quadraticCurveTo(bw, -bh, bw - corner, -bh);
      shape.lineTo(corner, -bh);
      shape.quadraticCurveTo(0, -bh, 0, -(bh - corner));
      shape.lineTo(0, -corner);
      shape.quadraticCurveTo(0, 0, corner, 0);
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, -depth, 0);
      return geo;
    };
    const corner = Math.min(2, board.width / 8, board.height / 8);
    const w = board.width, h = board.height;
    const boardGeo = boardLayerGeometry(w, h, BOARD_THICKNESS, corner);
    const boardMat = materialCacheRef.current.get('board', () =>
      new THREE.MeshStandardMaterial({ color: 0x0a5c30, roughness: 0.55, metalness: 0.15 }));
    const boardMesh = new THREE.Mesh(boardGeo, boardMat);
    boardMesh.position.set(0, 0, 0);
    boardMesh.receiveShadow = true;
    boardMesh.castShadow = true;
    // __baseY must EQUAL position.y — the explosion/assembly loop re-pins
    // every child to its __baseY each frame (a stale −0.8 here sank the
    // board 0.8 mm under the FR4 core: the "cream board top" bug).
    (boardMesh as any).__baseY = 0;
    group.add(boardMesh);

    // FR4 core edge (lighter fiberglass ring visible on the board's side)
    const coreGeo = boardLayerGeometry(w, h, BOARD_THICKNESS * 0.5, corner);
    const coreMesh = new THREE.Mesh(coreGeo, materialCacheRef.current.get('fr4core', () =>
      new THREE.MeshStandardMaterial({ color: 0x9c8f5a, roughness: 0.8, metalness: 0.0 })));
    coreMesh.scale.set(0.999, 1, 0.999);
    coreMesh.position.set(0, -BOARD_THICKNESS * 0.25, 0);
    (coreMesh as any).__baseY = -BOARD_THICKNESS * 0.25;
    group.add(coreMesh);

    // Silkscreen — a CanvasTexture plane above the board: refdes labels
    // drawn at the footprint positions (what real boards have).
    {
      const silkCanvas = document.createElement('canvas');
      const S = 8; // texels per mm
      silkCanvas.width = Math.max(64, Math.round(w * S));
      silkCanvas.height = Math.max(64, Math.round(h * S));
      const sctx = silkCanvas.getContext('2d')!;
      sctx.clearRect(0, 0, silkCanvas.width, silkCanvas.height);
      sctx.fillStyle = '#e8eaec';
      sctx.font = `bold ${Math.max(10, Math.round(S * 1.3))}px ui-monospace, monospace`;
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      for (const fp of footprints) {
        const label = fp.refdes || fp.id;
        sctx.fillText(label, fp.position.x * S, fp.position.y * S);
        // small pin-1 dot
        const p1 = fp.pads[0];
        if (p1) {
          sctx.beginPath();
          sctx.arc((fp.position.x + p1.position.x) * S, (fp.position.y + p1.position.y) * S, S * 0.35, 0, Math.PI * 2);
          sctx.fill();
        }
      }
      const silkTex = new THREE.CanvasTexture(silkCanvas);
      silkTex.anisotropy = 4;
      const silkPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: silkTex, transparent: true, depthWrite: false }),
      );
      silkPlane.rotation.x = -Math.PI / 2;
      silkPlane.position.set(w / 2, 0.015, h / 2);
      (silkPlane as any).__baseY = 0.015;
      group.add(silkPlane);
    }

    const PAD_HEIGHT = 0.05;
    const TRACE_HEIGHT = 0.05;

    // Traces
    const traceMat = materialCacheRef.current.get('trace', () =>
      new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 0.3, metalness: 0.9 }));
    for (const trace of traces) {
      for (const seg of trace.segments) {
        const dx = seg.end.x - seg.start.x;
        const dy = seg.end.y - seg.start.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.01) continue;
        const traceGeo = new THREE.BoxGeometry(length, TRACE_HEIGHT, trace.width);
        const traceMesh = new THREE.Mesh(traceGeo, traceMat);
        traceMesh.position.set(
          (seg.start.x + seg.end.x) / 2,
          trace.layer === 'top' ? PAD_HEIGHT : -BOARD_THICKNESS - PAD_HEIGHT,
          (seg.start.y + seg.end.y) / 2,
        );
        if (Math.abs(dy) > 0.01) traceMesh.rotation.y = Math.atan2(dy, dx);
        (traceMesh as any).__baseY = traceMesh.position.y;
        (traceMesh as any).__isTrace = true;
        group.add(traceMesh);
      }
    }

    // Vias
    const viaMat = materialCacheRef.current.get('via', () =>
      new THREE.MeshStandardMaterial({ color: 0xcc8844, roughness: 0.3, metalness: 0.8 }));
    const drillMat = materialCacheRef.current.get('drill', () =>
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }));
    for (const via of vias) {
      const viaR = Math.max(0.05, via.drill / 2 + 0.15);
      const viaGeo = new THREE.CylinderGeometry(viaR, viaR, BOARD_THICKNESS + 0.1, 16);
      const viaMesh = new THREE.Mesh(viaGeo, viaMat);
      viaMesh.position.set(via.position.x, 0, via.position.y);
      (viaMesh as any).__baseY = 0;
      group.add(viaMesh);
      // Drill hole
      const drillR = Math.max(0.025, via.drill / 2);
      const drillGeo = new THREE.CylinderGeometry(drillR, drillR, BOARD_THICKNESS + 0.2, 16);
      const drillMesh = new THREE.Mesh(drillGeo, drillMat);
      drillMesh.position.set(via.position.x, 0, via.position.y);
      group.add(drillMesh);
    }

    // Footprints + pads (NO 3D model loading here — that's in a separate effect)
    // Gold ENIG finish — what real boards' exposed copper looks like after
    // surface finishing (the old silver was raw unfinished copper).
    const padMat = materialCacheRef.current.get('pad', () =>
      new THREE.MeshStandardMaterial({ color: 0xd4b96a, roughness: 0.3, metalness: 0.85 }));
    for (const fp of footprints) {
      // Pads
      for (const pad of fp.pads) {
        // Copper size comes from pad.size (the drill hole is drawn separately
        // below) — using pad.drill here shrank every THT pad to its hole size.
        const padW = pad.size?.width || 0.6;
        const padH = pad.size?.height || 0.6;
        const padY = fp.side === 'bottom' ? -BOARD_THICKNESS - PAD_HEIGHT : PAD_HEIGHT;
        let padMesh: THREE.Mesh;
        if (pad.shape === 'circle') {
          padMesh = new THREE.Mesh(
            new THREE.CylinderGeometry(Math.max(padW, padH) / 2, Math.max(padW, padH) / 2, PAD_HEIGHT * 2, 20),
            padMat,
          );
        } else {
          padMesh = new THREE.Mesh(new THREE.BoxGeometry(padW, PAD_HEIGHT * 2, padH), padMat);
        }
        padMesh.position.set(
          fp.position.x + pad.position.x,
          padY,
          fp.position.y + pad.position.y,
        );
        padMesh.receiveShadow = true;
        (padMesh as any).__baseY = padY;
        group.add(padMesh);
        if (pad.drill && pad.drill > 0) {
          const drillR = Math.max(0.05, (pad.drill || 0.3) / 2);
          const drillGeo = new THREE.CylinderGeometry(drillR, drillR, BOARD_THICKNESS + 0.2, 12);
          const drillMesh = new THREE.Mesh(drillGeo, drillMat);
          drillMesh.position.set(
            fp.position.x + pad.position.x,
            0,
            fp.position.y + pad.position.y,
          );
          (drillMesh as any).__baseY = 0;
          group.add(drillMesh);
        }
      }
    }
  }, [footprints, traces, vias, board, padNets]);

  // ── Async 3D model loading (separate from PCB group rebuild) ─────────────
  // This is the critical fix: when models load, we add them to modelsGroup
  // WITHOUT rebuilding the rest of the PCB. No flicker, no camera reset.
  useEffect(() => {
    if (!modelsGroupRef.current) return;

    // Track which footprint IDs currently have a model mesh attached
    const attachedIds = new Set<string>();
    modelsGroupRef.current.traverse((child: any) => {
      if (child.__footprintId) attachedIds.add(child.__footprintId);
    });

    // Track which footprints should have a model
    const wantedIds = new Set<string>();
    for (const fp of footprints) wantedIds.add(fp.id);

    // Remove meshes for footprints that no longer exist
    const toRemove: THREE.Object3D[] = [];
    modelsGroupRef.current.traverse((child: any) => {
      if (child.__footprintId && !wantedIds.has(child.__footprintId)) {
        toRemove.push(child);
      }
    });
    for (const obj of toRemove) {
      modelsGroupRef.current.remove(obj);
      if (obj instanceof THREE.Mesh) obj.geometry?.dispose();
    }

    // For each footprint that doesn't have a model yet, attach one.
    // Procedural factories FIRST (realistic multi-material models that read
    // the component's parameters — resistor color bands, LED lens color,
    // TO-92/DIP/TO-220 shapes); custom modelUrl / default-STL only as
    // fallback for types without a factory.
    const cache = modelCacheRef.current;
    const inFlight = inFlightRef.current;
    const editorComps = useEditor.getState().components;
    for (const fp of footprints) {
      // Skip if already attached or already loading
      if (attachedIds.has(fp.id)) continue;

      const modelKey = fp.modelUrl || `default:${fp.componentType}`;

      const attachObject = (obj: THREE.Object3D) => {
        if (!modelsGroupRef.current) return;
        const BOARD_THICKNESS = 1.6;
        const PAD_HEIGHT = 0.05;
        obj.position.set(fp.position.x, PAD_HEIGHT, fp.position.y);
        if (fp.side === 'bottom') {
          obj.position.y = -BOARD_THICKNESS - PAD_HEIGHT;
          obj.scale.y = -1;
        }
        obj.rotation.y = (fp.rotation * Math.PI) / 180;
        (obj as any).__baseY = obj.position.y;
        (obj as any).__footprintId = fp.id;
        (obj as any).__componentId = fp.componentId;
        modelsGroupRef.current.add(obj);
      };

      // 1) Procedural realistic model (synchronous, parameter-aware)
      if (!fp.modelUrl) {
        const comp = editorComps.find((c) => c.id === fp.componentId);
        const procedural = buildComponentModel({
          footprint: fp,
          params: (comp?.parameters as Record<string, any>) ?? {},
        });
        if (procedural) {
          attachObject(procedural);
          liveModelsRef.current = true; // has __updateEmissive/__updateSegments hooks
          continue;
        }
      }

      const attachMesh = (geo: THREE.BufferGeometry) => {
        if (!modelsGroupRef.current) return;
        const mat = materialCacheRef.current.get(`model:${modelKey}`, () =>
          new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.4, metalness: 0.6 }));
        const mesh = new THREE.Mesh(geo, mat);
        // Center the model on the footprint
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        const BOARD_THICKNESS = 1.6;
        const PAD_HEIGHT = 0.05;
        if (bb) {
          const cx = (bb.max.x + bb.min.x) / 2;
          const cy = bb.min.y;
          const cz = (bb.max.z + bb.min.z) / 2;
          mesh.position.set(fp.position.x - cx, PAD_HEIGHT - cy, fp.position.y - cz);
        } else {
          mesh.position.set(fp.position.x, PAD_HEIGHT, fp.position.y);
        }
        if (fp.side === 'bottom') {
          mesh.position.y = -BOARD_THICKNESS - PAD_HEIGHT;
          mesh.scale.y = -1;
        }
        mesh.rotation.y = (fp.rotation * Math.PI) / 180;
        (mesh as any).__baseY = mesh.position.y;
        (mesh as any).__footprintId = fp.id;
        modelsGroupRef.current.add(mesh);
      };

      const cached = cache.get(modelKey);
      if (cached === FAILED_SENTINEL) continue; // skip known failures
      if (cached) {
        attachMesh(cached.clone());
        continue;
      }
      if (inFlight.has(modelKey)) {
        pendingModelFootprintsRef.current.add(fp.id);
        continue;
      }

      // Kick off async load
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
            // Look up default STL by component type
            const entry = DEFAULT_MODELS.get(fp.componentType);
            if (entry) {
              model = parseModel('default.stl', entry.stlAscii);
            } else {
              model = null;
            }
          }
          if (model) {
            const geo = modelToGeometry(model);
            cache.set(modelKey, geo);
            // Attach to all footprints waiting on this modelKey
            for (const fpInner of footprints) {
              const innerKey = fpInner.modelUrl || `default:${fpInner.componentType}`;
              if (innerKey === modelKey) {
                attachMesh(geo.clone());
              }
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

  // ── High-quality rendering toggle ────────────────────────────────────────
  // ACES tone mapping + sRGB are now ALWAYS on (they make the PBR materials
  // read as real); HQ adds a hard spotlight + rim light instead of toggling
  // the (already correct) tone pipeline.
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!scene || !renderer) return;
    // Remove any existing HQ lights
    const existingSpot = (scene as any).__hqSpot;
    const existingRim = (scene as any).__hqRim;
    if (existingSpot) { scene.remove(existingSpot); existingSpot.dispose?.(); delete (scene as any).__hqSpot; }
    if (existingRim) { scene.remove(existingRim); existingRim.dispose(); delete (scene as any).__hqRim; }
    if (highQuality) {
      const spot = new THREE.SpotLight(0xffffff, 400, 400, Math.PI / 6, 0.45, 1.9);
      spot.position.set(35, 90, 45);
      spot.castShadow = true;
      spot.shadow.mapSize.set(2048, 2048);
      spot.shadow.bias = -0.0003;
      scene.add(spot);
      (scene as any).__hqSpot = spot;
      const rim = new THREE.DirectionalLight(0x3b82f6, 0.4);
      rim.position.set(-40, 25, -40);
      scene.add(rim);
      (scene as any).__hqRim = rim;
      renderer.toneMappingExposure = 1.1;
    } else {
      renderer.toneMappingExposure = 1.0;
    }
  }, [highQuality]);

  // ── Update voltage probe labels (DOM, not React state) ───────────────────
  function updateProbeLabels() {
    if (!probeLayerRef.current || !cameraRef.current) return;
    const layer = probeLayerRef.current;
    const camera = cameraRef.current;
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    const seen = new Set<string>();

    // buildNodeMap is O(components + wires) — compute it ONCE per frame (it
    // used to run once PER FOOTPRINT, i.e. O(F·(V+E)) every animation frame).
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

    for (const fp of footprints) {
      const pos = new THREE.Vector3(fp.position.x, 2, fp.position.y);
      pos.project(camera);
      if (pos.z > 1) continue; // behind camera

      const screenX = (pos.x + 1) / 2 * w;
      const screenY = (1 - (pos.y + 1) / 2) * h;

      // Compute voltage/current/power label — full measurement readout
      let label = `${fp.refdes || fp.id}: —`;
      if (simContext) {
        const comp = editorState.components.find((c) => c.id === fp.componentId);
        if (comp) {
          const plugin = getPlugin(comp.type);
          if (plugin) {
            try {
              const terms = getTerminalsForComponent(comp, plugin, nodeMap);
              const firstTerm = terms[0];
              if (firstTerm) {
                const v = simContext.nodeVoltage[firstTerm.nodeId];
                // Current through the component (mA) + power (mW) — the
                // same source of truth as the schematic's probe panel.
                let iText = '';
                let pText = '';
                try {
                  const plugins = new Map<string, NonNullable<ReturnType<typeof getPlugin>>>();
                  for (const c of editorState.components) {
                    const p = getPlugin(c.type);
                    if (p) plugins.set(c.type, p);
                  }
                  const i = computeComponentCurrents(editorState.components, editorState.wires, plugins, simContext).get(comp.id) ?? 0;
                  iText = ` · ${(i * 1000).toFixed(2)}mA`;
                  pText = ` · ${(v != null ? v * i * 1000 : 0).toFixed(2)}mW`;
                } catch { /* current optional */ }
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
          'position:absolute;transform:translate(-50%,-150%);padding:1px 4px;' +
          'border-radius:2px;background:rgba(30,58,138,0.92);color:#bfdbfe;' +
          'border:1px solid #1d4ed8;font:10px ui-monospace,monospace;white-space:nowrap;';
        layer.appendChild(el);
        probeLabelsRef.current.set(fp.id, el);
      }
      el.style.display = 'block';
      el.style.left = `${screenX}px`;
      el.style.top = `${screenY}px`;
      el.textContent = label;
    }

    // Hide labels for footprints not in the current set
    probeLabelsRef.current.forEach((el, id) => {
      if (!seen.has(id)) el.style.display = 'none';
    });
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0a1628]"
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
          <div className="text-lg font-semibold text-slate-300">3D PCB Preview</div>
          <div className="text-sm text-slate-500">
            Import a schematic in PCB Layout mode first, then switch to 3D View.
          </div>
        </div>
      )}
      {!loading && !error && footprints.length > 0 && (
        <>
          <div className="absolute right-2 top-2 flex flex-col gap-1 rounded-md bg-slate-900/90 p-2 text-xs">
            <button onClick={() => setCrossSection(!crossSection)}
              className={`rounded px-2 py-1 ${crossSection ? 'bg-cyan-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>
              ✂ Cross-section
            </button>
            {crossSection && (
              <input type="range" min={-2} max={2} step={0.1} value={crossSectionY}
                onChange={(e) => setCrossSectionY(parseFloat(e.target.value))}
                className="w-28" />
            )}
            <button onClick={() => setShowCurrentFlow(!showCurrentFlow)}
              className={`rounded px-2 py-1 ${showCurrentFlow ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>
              ⚡ Current flow
            </button>
            <button onClick={() => setShowVoltageProbes(!showVoltageProbes)}
              className={`rounded px-2 py-1 ${showVoltageProbes ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>
                🔵 Voltage probes
            </button>
            <button onClick={() => setHighQuality(!highQuality)}
              className={`rounded px-2 py-1 ${highQuality ? 'bg-purple-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>
              ✨ High quality
            </button>
            <div className="flex items-center gap-1 px-2">
              <span className="text-slate-500">Explode</span>
              <input type="range" min={0} max={1} step={0.05} value={explosionFactor}
                onChange={(e) => setExplosionFactor(parseFloat(e.target.value))}
                className="w-20" />
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
              className="flex items-center gap-1 rounded px-2 py-1 text-purple-300 hover:bg-slate-800">
              ▶ Play assembly
            </button>
          </div>

          <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-[#0a1628]/80 px-3 py-1.5 text-xs font-mono text-slate-400">
            Left-drag: rotate · Right-drag: pan · Scroll: zoom
            {showCurrentFlow && running && <span className="ml-2 text-emerald-300">· ⚡ current flowing</span>}
          </div>
        </>
      )}
    </div>
  );
}

// Helper: dispose all meshes inside a group (but keep the group)
function disposeGroup(group: THREE.Group) {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      // Don't dispose cached materials — they're shared
      if (child.geometry) child.geometry.dispose();
    }
  });
}
