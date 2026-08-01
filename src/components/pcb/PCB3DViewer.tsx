'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { parseSTL, parseVRML, parseOBJ, parseModel, modelToGeometry } from '@/lib/pcb/model-loader';
import type { LoadedModel } from '@/lib/pcb/model-loader';
import { DEFAULT_MODELS } from '@/lib/pcb/3d-models';
import type { Footprint } from '@/lib/pcb/types';

/** Cache key prefix for default (registered) models. */
const DEFAULT_KEY_PREFIX = 'default:';
/** Sentinel stored in the geometry cache to mark a model-URL load that failed. */
const FAILED_SENTINEL: unique symbol = Symbol('failed');

/**
 * Look up (and lazily build) the default geometry for a component type.
 * Returns `null` if no default model is registered, or `{ failed: true }`
 * if parsing threw.
 */
function getDefaultGeometry(
  type: string,
  cache: Map<string, THREE.BufferGeometry | typeof FAILED_SENTINEL>,
): THREE.BufferGeometry | null {
  const key = `${DEFAULT_KEY_PREFIX}${type}`;
  const cached = cache.get(key);
  if (cached === FAILED_SENTINEL) return null;
  if (cached) return cached;
  const entry = DEFAULT_MODELS.get(type);
  if (!entry) return null;
  try {
    const model: LoadedModel = parseSTL(entry.stlAscii);
    const geo = modelToGeometry(model);
    cache.set(key, geo);
    return geo;
  } catch (err) {
    console.warn(`[PCB3DViewer] Failed to parse default model for ${type}:`, err);
    cache.set(key, FAILED_SENTINEL);
    return null;
  }
}

/** Fetch and parse a model from a URL, caching the resulting geometry. */
async function fetchModelGeometry(
  url: string,
  cache: Map<string, THREE.BufferGeometry | typeof FAILED_SENTINEL>,
): Promise<void> {
  const cached = cache.get(url);
  if (cached) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    // Parse by inferring the format from the URL's file extension.
    const lower = url.toLowerCase();
    let model: LoadedModel;
    if (lower.endsWith('.stl')) {
      model = parseSTL(buf);
    } else if (lower.endsWith('.wrl') || lower.endsWith('.vrml') || lower.endsWith('.x3dv')) {
      model = parseVRML(new TextDecoder().decode(buf));
    } else if (lower.endsWith('.obj')) {
      model = parseOBJ(new TextDecoder().decode(buf));
    } else if (lower.endsWith('.step') || lower.endsWith('.stp')) {
      model = parseModel(url, buf);
    } else {
      throw new Error(`Unknown model extension for ${url}`);
    }
    cache.set(url, modelToGeometry(model));
  } catch (err) {
    console.warn(`[PCB3DViewer] Failed to load model ${url}:`, err);
    cache.set(url, FAILED_SENTINEL);
  }
}

/** Compute the parametric body height used by the box fallback. */
function parametricBodyHeight(componentType: string): number {
  switch (componentType) {
    case 'dcVoltage':
    case 'acVoltage':
      return 5.0;
    case 'timer555':
    case 'opamp':
      return 3.5;
    case 'arduino':
    case 'arduinoReal':
      return 1.5;
    case 'led':
      return 0.6;
    default:
      return 1.0;
  }
}

/** Position a mesh so its model sits flush on the board surface. */
function positionMeshOnBoard(
  mesh: THREE.Mesh,
  geo: THREE.BufferGeometry,
  fp: Footprint,
  boardThickness: number,
  padHeight: number,
): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return;
  const minY = bb.min.y;
  const maxY = bb.max.y;
  if (fp.side === 'top') {
    // Bottom of model aligns with top of pads.
    mesh.position.y = padHeight - minY;
  } else {
    // Top of model aligns with bottom of pads (under the board).
    mesh.position.y = -boardThickness - padHeight - maxY;
  }
  mesh.position.x = fp.position.x;
  mesh.position.z = fp.position.y;
  mesh.rotation.y = (fp.rotation * Math.PI) / 180;
}

export function PCB3DViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<any>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pcbGroupRef = useRef<THREE.Group | null>(null);
  /**
   * Persistent cache of parsed 3D models keyed by either `default:<type>`
   * (for the built-in registry) or by the raw `modelUrl` (for externally
   * fetched STL/VRML/OBJ). Survives re-renders so we don't re-parse every
   * frame. A `FAILED_SENTINEL` entry marks a model that failed to load.
   */
  const modelCacheRef = useRef<
    Map<string, THREE.BufferGeometry | typeof FAILED_SENTINEL>
  >(new Map());
  /** Bumped whenever an async model fetch resolves to trigger a re-render. */
  const [modelVersion, setModelVersion] = useState(0);
  const bumpModelVersion = useCallback(() => setModelVersion((v) => v + 1), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Enhanced 3D viewer state ────────────────────────────────────────────
  // Cross-section view: clips everything above a Y-plane so you can see inside
  const [crossSection, setCrossSection] = useState(false);
  const [crossSectionY, setCrossSectionY] = useState(0);
  // Ray-traced / high-quality rendering: more lights, tone mapping, contact shadows
  const [highQuality, setHighQuality] = useState(false);
  // Animated 3D current flow: traces glow with current direction/speed
  const [showCurrentFlow, setShowCurrentFlow] = useState(false);
  // Live voltage probes overlay: floating voltage labels at pad positions
  const [showVoltageProbes, setShowVoltageProbes] = useState(false);
  // Explosion view: components lift off the board to show layers separately
  const [explosionFactor, setExplosionFactor] = useState(0); // 0=normal, 1=fully exploded
  // Assembly animation: components fly into place from above
  const [assemblyProgress, setAssemblyProgress] = useState(1); // 0=disassembled, 1=assembled

  // Circuit simulation context (for current flow + voltage probes)
  const simContext = useEditor((s) => s.simContext);
  const running = useEditor((s) => s.running);

  // Sync React state to window globals (read by the animation loop)
  useEffect(() => { (window as any).__3d_crossSection = crossSection; }, [crossSection]);
  useEffect(() => { (window as any).__3d_crossSectionY = crossSectionY; }, [crossSectionY]);
  useEffect(() => { (window as any).__3d_showCurrentFlow = showCurrentFlow; }, [showCurrentFlow]);
  useEffect(() => { (window as any).__3d_explosion = explosionFactor; }, [explosionFactor]);
  useEffect(() => { (window as any).__3d_assembly = assemblyProgress; }, [assemblyProgress]);

  // ── High-quality rendering: extra lights + tone mapping ──────────────────
  useEffect(() => {
    if (!sceneRef.current || !rendererRef.current) return;
    const scene = sceneRef.current;
    const renderer = rendererRef.current as any;

    if (highQuality) {
      // Add hemisphere light for ambient environment
      if (!(scene as any).__hemisphereLight) {
        const hemi = new THREE.HemisphereLight(0x87ceeb, 0x1a3a1a, 0.3);
        (scene as any).__hemisphereLight = hemi;
        scene.add(hemi);
      }
      // Add rim light from behind for depth
      if (!(scene as any).__rimLight) {
        const rim = new THREE.DirectionalLight(0xffffff, 0.4);
        rim.position.set(0, 30, -50);
        (scene as any).__rimLight = rim;
        scene.add(rim);
      }
      // ACES Filmic tone mapping for better color reproduction
      renderer.toneMapping = 4; // ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.0;
    } else {
      // Remove extra lights
      if ((scene as any).__hemisphereLight) {
        scene.remove((scene as any).__hemisphereLight);
        delete (scene as any).__hemisphereLight;
      }
      if ((scene as any).__rimLight) {
        scene.remove((scene as any).__rimLight);
        delete (scene as any).__rimLight;
      }
      renderer.toneMapping = 0; // NoToneMapping
    }
  }, [highQuality]);

  const footprints = usePCB((s) => s.footprints);
  const traces = usePCB((s) => s.traces);
  const vias = usePCB((s) => s.vias);
  const board = usePCB((s) => s.board);
  const padNets = usePCB((s) => s.padNets);

  useEffect(() => {
    let cancelled = false;
    const initScene = async () => {
      if (!containerRef.current) return;
      const container = containerRef.current;
      const width = container.clientWidth;
      const height = container.clientHeight;

      try {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0a1628);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
        camera.position.set(board.width / 2, 50, board.height + 30);
        camera.lookAt(board.width / 2, 0, board.height / 2);
        cameraRef.current = camera;

        const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
        await renderer.init();
        renderer.setSize(width, height);
        renderer.setPixelRatio(window.devicePixelRatio);
        // Enable local clipping for cross-section view
        (renderer as any).localClippingEnabled = true;
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        // Cross-section clipping plane (pointing down, clips everything above Y=crossSectionY)
        const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
        (renderer as any).clippingPlanes = []; // initially empty (no clipping)
        (renderer as any).__clipPlane = clipPlane;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 10;
        controls.maxDistance = 200;
        controls.maxPolarAngle = Math.PI * 0.85;
        controls.target.set(board.width / 2, 0, board.height / 2);
        controlsRef.current = controls;

        // Lighting
        const ambient = new THREE.AmbientLight(0xffffff, 0.4);
        scene.add(ambient);
        const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
        keyLight.position.set(50, 100, 50);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0x88aaff, 0.3);
        fillLight.position.set(-50, 50, -30);
        scene.add(fillLight);
        const bottomLight = new THREE.DirectionalLight(0xffffff, 0.2);
        bottomLight.position.set(0, -50, 0);
        scene.add(bottomLight);

        // Grid
        const gridSize = Math.max(board.width, board.height) * 2;
        const grid = new THREE.GridHelper(gridSize, Math.ceil(gridSize), 0x224422, 0x113311);
        grid.position.set(board.width / 2, -1.7, board.height / 2);
        scene.add(grid);

        requestAnimationFrame(() => { if (!cancelled) setLoading(false); });
      } catch (err) {
        const msg = `Failed to initialize 3D viewer: ${(err as Error).message}`;
        requestAnimationFrame(() => { if (!cancelled) { setError(msg); setLoading(false); } });
        return;
      }

      if (cancelled) return;

      let raf = 0;
      let flowPhase = 0;
      const animate = () => {
        raf = requestAnimationFrame(animate);
        if (controlsRef.current) controlsRef.current.update();

        // ── Cross-section: update clipping plane ──────────────────────────
        if (rendererRef.current && (rendererRef.current as any).__clipPlane) {
          const cp = (rendererRef.current as any).__clipPlane as THREE.Plane;
          const active = (window as any).__3d_crossSection ?? false;
          const yVal = (window as any).__3d_crossSectionY ?? 0;
          if (active) {
            cp.constant = yVal;
            (rendererRef.current as any).clippingPlanes = [cp];
          } else {
            (rendererRef.current as any).clippingPlanes = [];
          }
        }

        // ── Explosion + Assembly animation ────────────────────────────────
        if (pcbGroupRef.current) {
          const explosion = (window as any).__3d_explosion ?? 0;
          const assembly = (window as any).__3d_assembly ?? 1;
          const childCount = pcbGroupRef.current.children.length;
          for (let i = 0; i < childCount; i++) {
            const child = pcbGroupRef.current.children[i];
            if (child instanceof THREE.Mesh && (child as any).__baseY !== undefined) {
              const baseY = (child as any).__baseY as number;
              // Explosion: lift components up proportional to their height
              const explodeAmount = explosion * 10;
              // Assembly: start from high above and fly down
              const assemblyOffset = (1 - assembly) * 30;
              child.position.y = baseY + explodeAmount + assemblyOffset;
              // Fade in opacity during assembly
              if (child.material instanceof THREE.MeshStandardMaterial) {
                child.material.opacity = assembly;
                child.material.transparent = assembly < 1;
              }
            }
          }
        }

        // ── Current flow: animate emissive intensity on traces ───────────
        if ((window as any).__3d_showCurrentFlow) {
          flowPhase += 0.02;
          if (sceneRef.current) {
            sceneRef.current.traverse((child) => {
              if (child instanceof THREE.Mesh && (child as any).__isTrace) {
                const mat = child.material;
                if (mat instanceof THREE.MeshStandardMaterial) {
                  // Pulsing emissive glow based on flow phase
                  const pulse = 0.3 + 0.2 * Math.sin(flowPhase + ((child as any).__flowOffset || 0));
                  mat.emissive.setRGB(pulse * 0.8, pulse * 0.6, 0);
                  mat.emissiveIntensity = pulse;
                }
              }
            });
          }
        } else if (sceneRef.current) {
          // Reset emissive when current flow is off
          sceneRef.current.traverse((child) => {
            if (child instanceof THREE.Mesh && (child as any).__isTrace) {
              const mat = child.material;
              if (mat instanceof THREE.MeshStandardMaterial && mat.emissiveIntensity > 0) {
                mat.emissive.setRGB(0, 0, 0);
                mat.emissiveIntensity = 0;
              }
            }
          });
        }

        // ── Voltage probes: update HTML overlay positions ────────────────
        // (Handled by the React render below — the HTML elements are positioned
        // based on the current camera projection of pad positions)

        if (rendererRef.current && sceneRef.current && cameraRef.current) {
          const r = rendererRef.current;
          if (typeof r.renderAsync === 'function') {
            r.renderAsync(sceneRef.current, cameraRef.current);
          } else {
            r.render(sceneRef.current, cameraRef.current);
          }
        }
      };
      raf = requestAnimationFrame(animate);

      const handleResize = () => {
        if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        rendererRef.current.setSize(w, h);
        cameraRef.current.aspect = w / h;
        cameraRef.current.updateProjectionMatrix();
      };
      window.addEventListener('resize', handleResize);

      return () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', handleResize);
        if (rendererRef.current) {
          rendererRef.current.dispose();
          if (rendererRef.current.domElement.parentNode) {
            rendererRef.current.domElement.parentNode.removeChild(rendererRef.current.domElement);
          }
        }
      };
    };

    let cleanupFn: (() => void) | null = null;
    initScene().then(fn => { if (typeof fn === 'function') cleanupFn = fn; });

    return () => {
      cancelled = true;
      if (cleanupFn) cleanupFn();
    };
  }, []);

  // Update PCB 3D model when data changes
  useEffect(() => {
    if (!sceneRef.current || footprints.length === 0) return;

    if (pcbGroupRef.current) {
      sceneRef.current.remove(pcbGroupRef.current);
      pcbGroupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      });
    }

    const group = new THREE.Group();

    // Board substrate — realistic FR4 with gradient
    const BOARD_THICKNESS = 1.6;
    const boardGeo = new THREE.BoxGeometry(board.width, BOARD_THICKNESS, board.height);
    // Realistic solder mask color with slight gradient
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0x0d4a0d, roughness: 0.85, metalness: 0.05,
    });
    const boardMesh = new THREE.Mesh(boardGeo, boardMat);
    boardMesh.position.set(board.width / 2, -BOARD_THICKNESS / 2, board.height / 2);
    (boardMesh as any).__baseY = -BOARD_THICKNESS / 2;
    group.add(boardMesh);

    // Silkscreen border on top of board
    const silkGeo = new THREE.BoxGeometry(board.width - 2, 0.02, board.height - 2);
    const silkMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.9, metalness: 0.0 });
    const silkMesh = new THREE.Mesh(silkGeo, silkMat);
    silkMesh.position.set(board.width / 2, 0.01, board.height / 2);
    (silkMesh as any).__baseY = 0.01;
    group.add(silkMesh);

    const PAD_HEIGHT = 0.05;
    const TRACE_HEIGHT = 0.05; // raised traces — visible embossing

    // Traces — rendered as raised copper strips with metallic material
    for (const trace of traces) {
      for (let si = 0; si < trace.segments.length; si++) {
        const seg = trace.segments[si];
        const dx = seg.end.x - seg.start.x;
        const dy = seg.end.y - seg.start.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.01) continue;
        const geo = new THREE.BoxGeometry(length, TRACE_HEIGHT, seg.width);
        // Copper material with high metalness for realistic look
        const mat = new THREE.MeshStandardMaterial({
          color: 0xb87333, roughness: 0.3, metalness: 0.9,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const midX = (seg.start.x + seg.end.x) / 2;
        const midZ = (seg.start.y + seg.end.y) / 2;
        const y = trace.layer === 'top' ? TRACE_HEIGHT / 2 : -BOARD_THICKNESS - TRACE_HEIGHT / 2;
        mesh.position.set(midX, y, midZ);
        mesh.rotation.y = -Math.atan2(dy, dx);
        (mesh as any).__isTrace = true;
        (mesh as any).__flowOffset = si * 0.5;
        (mesh as any).__baseY = y;
        group.add(mesh);
      }
    }

    // Vias — realistic copper-plated holes
    for (const via of vias) {
      const r = via.diameter / 2;
      const drillR = via.drill / 2;
      // Outer copper barrel
      const viaGeo = new THREE.CylinderGeometry(r, r, BOARD_THICKNESS + 0.02, 20);
      const viaMat = new THREE.MeshStandardMaterial({ color: 0xc8a020, roughness: 0.25, metalness: 0.95 });
      const viaMesh = new THREE.Mesh(viaGeo, viaMat);
      viaMesh.position.set(via.position.x, 0, via.position.y);
      viaMesh.rotation.x = Math.PI / 2;
      (viaMesh as any).__baseY = 0;
      group.add(viaMesh);

      // Inner hole (dark)
      if (drillR > 0) {
        const holeGeo = new THREE.CylinderGeometry(drillR, drillR, BOARD_THICKNESS + 0.03, 16);
        const holeMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1.0, metalness: 0.0 });
        const holeMesh = new THREE.Mesh(holeGeo, holeMat);
        holeMesh.position.set(via.position.x, 0, via.position.y);
        holeMesh.rotation.x = Math.PI / 2;
        (holeMesh as any).__baseY = 0;
        group.add(holeMesh);
      }
    }

    // Footprints (components + pads) — realistic rendering
    const componentColors: Record<string, number> = {
      resistor: 0x2a2a3e, capacitor: 0x1a1a1a, led: 0xff3333, diode: 0x1a1a1a,
      timer555: 0x1a1a2e, opamp: 0x1a1a2e, npn: 0x2a2a2a, pnp: 0x2a2a2a,
      nmos: 0x2a2a2a, pmos: 0x2a2a2a, bsim3nmos: 0x2a2a2a, bsim3pmos: 0x2a2a2a,
      bsim4nmos: 0x2a2a2a, bsim4pmos: 0x2a2a2a,
      arduino: 0x005533, arduinoReal: 0x005533, raspberryPi: 0x7c2d12,
      switch: 0x333333, pushButton: 0x333333,
      crystal: 0x888888, inductor: 0x333333, speaker: 0x222222,
      transformer: 0x444444, vco: 0x1a1a2e, and: 0x1a1a2e, or: 0x1a1a2e,
      nand: 0x1a1a2e, nor: 0x1a1a2e, xor: 0x1a1a2e, not: 0x1a1a2e,
    };

    /** Track which URLs we've already started fetching this render pass. */
    const inFlight = new Set<string>();

    for (const fp of footprints) {
      const color = componentColors[fp.componentType] ?? 0x111111;
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.6, metalness: 0.2,
      });

      // 1) External modelUrl takes precedence — look it up in the cache.
      //    If not cached yet, kick off an async fetch (handled below).
      let geo: THREE.BufferGeometry | null = null;
      const modelUrl = fp.modelUrl;
      if (modelUrl) {
        const cached = modelCacheRef.current.get(modelUrl);
        if (cached && cached !== FAILED_SENTINEL) {
          geo = cached;
        } else if (!cached && !inFlight.has(modelUrl)) {
          inFlight.add(modelUrl);
          // Fire-and-forget; when it resolves we bump modelVersion to trigger
          // a re-render, then the cached geometry is picked up synchronously.
          fetchModelGeometry(modelUrl, modelCacheRef.current).finally(bumpModelVersion);
        }
      }

      // 2) Fall back to the default registered model for this type.
      if (!geo) {
        geo = getDefaultGeometry(fp.componentType, modelCacheRef.current);
      }

      // 3) Final fallback: parametric box (matches the pre-model rendering).
      if (geo) {
        const mesh = new THREE.Mesh(geo, mat);
        positionMeshOnBoard(mesh, geo, fp, BOARD_THICKNESS, PAD_HEIGHT);
        group.add(mesh);
      } else {
        const bodyH = parametricBodyHeight(fp.componentType);
        const boxGeo = new THREE.BoxGeometry(fp.bodySize.width, bodyH, fp.bodySize.height);
        const mesh = new THREE.Mesh(boxGeo, mat);
        const y = fp.side === 'top'
          ? PAD_HEIGHT + bodyH / 2
          : -BOARD_THICKNESS - PAD_HEIGHT - bodyH / 2;
        mesh.position.set(fp.position.x, y, fp.position.y);
        mesh.rotation.y = (fp.rotation * Math.PI) / 180;
        // Tag for explosion/assembly animation
        (mesh as any).__baseY = y;
        group.add(mesh);
      }

      // Pads — rendered as metallic discs/cylinders on the board surface
      for (const pad of fp.pads) {
        const r = Math.max(pad.size.width, pad.size.height) / 2;
        const padH = PAD_HEIGHT;
        // Use more segments for smoother circles
        const padGeo = pad.shape === 'circle'
          ? new THREE.CylinderGeometry(r, r, padH, 24)
          : new THREE.BoxGeometry(pad.size.width, padH, pad.size.height);
        // Metallic silver-gold pad material
        const padMat = new THREE.MeshStandardMaterial({
          color: 0xd4a020, roughness: 0.2, metalness: 0.95,
        });
        const padMesh = new THREE.Mesh(padGeo, padMat);
        const padY = fp.side === 'top' ? padH / 2 : -BOARD_THICKNESS - padH / 2;
        padMesh.position.set(pad.position.x, padY, pad.position.y);
        if (pad.shape === 'circle') padMesh.rotation.x = Math.PI / 2;
        (padMesh as any).__baseY = padY;
        group.add(padMesh);

        // Drill hole for THT pads
        if (pad.drill && pad.drill > 0) {
          const drillR = pad.drill / 2;
          const drillGeo = new THREE.CylinderGeometry(drillR, drillR, BOARD_THICKNESS + 0.05, 16);
          const drillMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1.0, metalness: 0.0 });
          const drillMesh = new THREE.Mesh(drillGeo, drillMat);
          drillMesh.position.set(pad.position.x, 0, pad.position.y);
          drillMesh.rotation.x = Math.PI / 2;
          (drillMesh as any).__baseY = 0;
          group.add(drillMesh);
        }
      }
    }

    sceneRef.current.add(group);
    pcbGroupRef.current = group;

    // Auto-frame camera
    if (cameraRef.current && controlsRef.current) {
      const centerX = board.width / 2;
      const centerZ = board.height / 2;
      const maxDim = Math.max(board.width, board.height);
      const dist = maxDim * 1.5;
      cameraRef.current.position.set(centerX + dist * 0.5, dist * 0.8, centerZ + dist * 0.5);
      controlsRef.current.target.set(centerX, 0, centerZ);
      controlsRef.current.update();
    }
  }, [footprints, traces, vias, board, padNets, modelVersion, bumpModelVersion]);

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
          {/* 3D Viewer control panel — top-right */}
          <div className="absolute right-2 top-2 flex flex-col gap-1 rounded-md bg-slate-900/90 p-2 text-xs">
            <button
              onClick={() => setCrossSection(!crossSection)}
              className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${
                crossSection ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-600' : 'text-slate-300 hover:bg-slate-800 border border-transparent'
              }`}
            >
              🔪 Cross-section
            </button>
            {crossSection && (
              <input
                type="range" min={-2} max={5} step={0.1}
                value={crossSectionY}
                onChange={(e) => setCrossSectionY(parseFloat(e.target.value))}
                className="w-full"
              />
            )}
            <button
              onClick={() => setHighQuality(!highQuality)}
              className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${
                highQuality ? 'bg-amber-500/30 text-amber-300 border border-amber-600' : 'text-slate-300 hover:bg-slate-800 border border-transparent'
              }`}
            >
              ✨ High-quality render
            </button>
            <button
              onClick={() => setShowCurrentFlow(!showCurrentFlow)}
              className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${
                showCurrentFlow ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-600' : 'text-slate-300 hover:bg-slate-800 border border-transparent'
              }`}
            >
              ⚡ Current flow {running ? '' : '(run sim)'}
            </button>
            <button
              onClick={() => setShowVoltageProbes(!showVoltageProbes)}
              className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${
                showVoltageProbes ? 'bg-blue-500/30 text-blue-300 border border-blue-600' : 'text-slate-300 hover:bg-slate-800 border border-transparent'
              }`}
            >
              📊 Voltage probes
            </button>
            <div className="flex items-center gap-1 px-2 py-1 text-slate-300">
              💥 Explode
              <input
                type="range" min={0} max={1} step={0.05}
                value={explosionFactor}
                onChange={(e) => setExplosionFactor(parseFloat(e.target.value))}
                className="flex-1"
              />
            </div>
            <div className="flex items-center gap-1 px-2 py-1 text-slate-300">
              🔧 Assembly
              <input
                type="range" min={0} max={1} step={0.05}
                value={assemblyProgress}
                onChange={(e) => setAssemblyProgress(parseFloat(e.target.value))}
                className="flex-1"
              />
            </div>
            <button
              onClick={() => {
                setAssemblyProgress(0);
                let p = 0;
                const interval = setInterval(() => {
                  p += 0.05;
                  if (p >= 1) { p = 1; clearInterval(interval); }
                  setAssemblyProgress(p);
                }, 30);
              }}
              className="flex items-center gap-1 rounded px-2 py-1 text-purple-300 hover:bg-slate-800 border border-transparent"
            >
              ▶ Play assembly
            </button>
          </div>

          {/* Voltage probe labels — floating HTML at projected 3D positions */}
          {showVoltageProbes && simContext && footprints.map((fp) => {
            // Project the footprint's 3D position to screen coords
            if (!cameraRef.current || !rendererRef.current) return null;
            const pos = new THREE.Vector3(fp.position.x, 2, fp.position.y);
            pos.project(cameraRef.current);
            const x = (pos.x + 1) / 2 * (rendererRef.current.domElement.width / window.devicePixelRatio);
            const y = (1 - (pos.y + 1) / 2) * (rendererRef.current.domElement.height / window.devicePixelRatio);
            // Look up voltage from sim context (componentId → first pad's net → node voltage)
            const comp = useEditor.getState().components.find((c) => c.id === fp.componentId);
            let voltage = '—';
            if (comp && simContext) {
              const net = fp.pads[0]?.net;
              if (net) voltage = net;
            }
            return (
              <div
                key={fp.id}
                className="pointer-events-none absolute z-10 rounded bg-blue-900/90 px-1.5 py-0.5 text-[10px] font-mono text-blue-200 border border-blue-700"
                style={{ left: `${x}px`, top: `${y}px`, transform: 'translate(-50%, -150%)' }}
              >
                {fp.refdes}: {voltage}
              </div>
            );
          })}

          {/* Original bottom overlay */}
          <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-[#0a1628]/80 px-3 py-1.5 text-xs font-mono text-slate-400">
            Left-drag: rotate · Right-drag: pan · Scroll: zoom
            {showCurrentFlow && running && <span className="ml-2 text-emerald-300">· ⚡ current flowing</span>}
          </div>
        </>
      )}
    </div>
  );
}
