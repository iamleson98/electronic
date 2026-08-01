'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { usePCB } from '@/lib/pcb/store';
import { parseSTL, parseVRML, parseOBJ, modelToGeometry } from '@/lib/pcb/model-loader';
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
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

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
      const animate = () => {
        raf = requestAnimationFrame(animate);
        if (controlsRef.current) controlsRef.current.update();
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

    // Board substrate — positioned so bottom-left is at world origin
    const BOARD_THICKNESS = 1.6;
    const boardGeo = new THREE.BoxGeometry(board.width, BOARD_THICKNESS, board.height);
    const boardMat = new THREE.MeshStandardMaterial({ color: 0x1a5d1a, roughness: 0.8, metalness: 0.1 });
    const boardMesh = new THREE.Mesh(boardGeo, boardMat);
    boardMesh.position.set(board.width / 2, -BOARD_THICKNESS / 2, board.height / 2);
    group.add(boardMesh);

    const PAD_HEIGHT = 0.05;
    const TRACE_HEIGHT = 0.03;

    // Traces
    for (const trace of traces) {
      for (const seg of trace.segments) {
        const dx = seg.end.x - seg.start.x;
        const dy = seg.end.y - seg.start.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.01) continue;
        const geo = new THREE.BoxGeometry(length, TRACE_HEIGHT, seg.width);
        const mat = new THREE.MeshStandardMaterial({ color: 0xcc6633, roughness: 0.4, metalness: 0.7 });
        const mesh = new THREE.Mesh(geo, mat);
        const midX = (seg.start.x + seg.end.x) / 2;
        const midZ = (seg.start.y + seg.end.y) / 2;
        const y = trace.layer === 'top' ? TRACE_HEIGHT / 2 : -BOARD_THICKNESS - TRACE_HEIGHT / 2;
        mesh.position.set(midX, y, midZ);
        mesh.rotation.y = -Math.atan2(dy, dx);
        group.add(mesh);
      }
    }

    // Vias
    for (const via of vias) {
      const r = via.diameter / 2;
      const geo = new THREE.CylinderGeometry(r, r, BOARD_THICKNESS + 0.02, 16);
      const mat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.3, metalness: 0.9 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(via.position.x, 0, via.position.y);
      mesh.rotation.x = Math.PI / 2;
      group.add(mesh);
    }

    // Footprints (components + pads)
    const componentColors: Record<string, number> = {
      resistor: 0x1a1a2e, capacitor: 0x0a0a0a, led: 0xff3333, diode: 0x1a1a1a,
      timer555: 0x1e3a5f, opamp: 0x1e3a5f, npn: 0x1a1a1a, pnp: 0x1a1a1a,
      arduino: 0x006633, arduinoReal: 0x006633, raspberryPi: 0x7c2d12,
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
        group.add(mesh);
      }

      // Pads
      for (const pad of fp.pads) {
        const r = Math.max(pad.size.width, pad.size.height) / 2;
        const padGeo = new THREE.CylinderGeometry(r, r, PAD_HEIGHT, 16);
        const padMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.2, metalness: 0.95 });
        const padMesh = new THREE.Mesh(padGeo, padMat);
        const padY = fp.side === 'top' ? PAD_HEIGHT / 2 : -BOARD_THICKNESS - PAD_HEIGHT / 2;
        padMesh.position.set(pad.position.x, padY, pad.position.y);
        padMesh.rotation.x = Math.PI / 2;
        group.add(padMesh);
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
        <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-[#0a1628]/80 px-3 py-1.5 text-xs font-mono text-slate-400">
          Left-drag: rotate · Right-drag: pan · Scroll: zoom
        </div>
      )}
    </div>
  );
}
