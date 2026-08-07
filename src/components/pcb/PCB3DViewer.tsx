'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { usePCB } from '@/lib/pcb/store';
import { useEditor } from '@/lib/circuit/store';
import { buildNodeMap, getTerminalsForComponent } from '@/lib/circuit/engine';
import { getPlugin } from '@/lib/circuit/registry';
import { getDefault3DModel, MODEL_TYPES } from '@/lib/pcb/3d-models';
import { parseModel, modelToGeometry } from '@/lib/pcb/model-loader';

const FAILED_SENTINEL = Symbol('FAILED');

export function PCB3DViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<any>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pcbGroupRef = useRef<THREE.Group | null>(null);
  const modelCacheRef = useRef<Map<string, THREE.BufferGeometry | typeof FAILED_SENTINEL>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const probeUpdateRef = useRef<(() => void) | null>(null);

  const [modelVersion, setModelVersion] = useState(0);
  const bumpModelVersion = useCallback(() => setModelVersion((v) => v + 1), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Enhanced 3D viewer state
  const [crossSection, setCrossSection] = useState(false);
  const [crossSectionY, setCrossSectionY] = useState(0);
  const [highQuality, setHighQuality] = useState(false);
  const [showCurrentFlow, setShowCurrentFlow] = useState(false);
  const [showVoltageProbes, setShowVoltageProbes] = useState(false);
  const [explosionFactor, setExplosionFactor] = useState(0);
  const [assemblyProgress, setAssemblyProgress] = useState(1);
  const [probeData, setProbeData] = useState<{ x: number; y: number; label: string }[]>([]);

  // Use refs for animation-loop state (avoids re-render on every frame)
  const stateRef = useRef({
    crossSection: false, crossSectionY: 0, showCurrentFlow: false,
    explosion: 0, assembly: 1,
  });
  useEffect(() => { stateRef.current.crossSection = crossSection; }, [crossSection]);
  useEffect(() => { stateRef.current.crossSectionY = crossSectionY; }, [crossSectionY]);
  useEffect(() => { stateRef.current.showCurrentFlow = showCurrentFlow; }, [showCurrentFlow]);
  useEffect(() => { stateRef.current.explosion = explosionFactor; }, [explosionFactor]);
  useEffect(() => { stateRef.current.assembly = assemblyProgress; }, [assemblyProgress]);

  const simContext = useEditor((s) => s.simContext);
  const running = useEditor((s) => s.running);
  const footprints = usePCB((s) => s.footprints);
  const traces = usePCB((s) => s.traces);
  const vias = usePCB((s) => s.vias);
  const board = usePCB((s) => s.board);
  const padNets = usePCB((s) => s.padNets);

  // ── High-quality rendering toggle ──────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!scene || !renderer) return;
    if (highQuality) {
      const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
      scene.add(hemi);
      (scene as any).__hemiLight = hemi;
      const rim = new THREE.DirectionalLight(0x3b82f6, 0.3);
      rim.position.set(-30, 20, -30);
      scene.add(rim);
      (scene as any).__rimLight = rim;
      renderer.toneMapping = 4; // ACESFilmic
    } else {
      const hemi = (scene as any).__hemiLight;
      const rim = (scene as any).__rimLight;
      if (hemi) { scene.remove(hemi); hemi.dispose?.(); delete (scene as any).__hemiLight; }
      if (rim) { scene.remove(rim); rim.dispose?.(); delete (scene as any).__rimLight; }
      renderer.toneMapping = 0;
    }
  }, [highQuality]);

  // ── Initialize scene (runs once) ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let rendererCreated: any = null;

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

        let renderer: any;
        try {
          renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
          await renderer.init();
        } catch {
          // Fallback to WebGL renderer
          const { WebGLRenderer } = await import('three');
          renderer = new WebGLRenderer({ antialias: true, alpha: true });
          renderer.setSize(width, height);
        }
        rendererCreated = renderer;
        if (cancelled) { renderer.dispose(); return; }

        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 10;
        controls.maxDistance = 200;
        controls.maxPolarAngle = Math.PI * 0.85;
        controlsRef.current = controls;

        // Lights
        scene.add(new THREE.AmbientLight(0xffffff, 0.35));
        const key = new THREE.DirectionalLight(0xffffff, 0.8);
        key.position.set(20, 40, 20); scene.add(key);
        const fill = new THREE.DirectionalLight(0x93c5fd, 0.3);
        fill.position.set(-20, 30, -10); scene.add(fill);
        const back = new THREE.DirectionalLight(0xfbbf24, 0.2);
        back.position.set(0, -20, -30); scene.add(back);

        // Grid
        const grid = new THREE.GridHelper(100, 50, 0x334155, 0x1e293b);
        grid.position.y = -2;
        scene.add(grid);

        // Clipping plane (for cross-section)
        const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
        renderer.localClippingEnabled = true;

        let raf = 0;
        let isRendering = false;
        const animate = () => {
          raf = requestAnimationFrame(animate);
          if (controlsRef.current) controlsRef.current.update();

          // Cross-section
          if (stateRef.current.crossSection) {
            clipPlane.constant = stateRef.current.crossSectionY;
            renderer.localClippingEnabled = true;
          } else {
            renderer.localClippingEnabled = false;
          }

          // Explosion + assembly
          if (pcbGroupRef.current) {
            const exp = stateRef.current.explosion;
            const asm = stateRef.current.assembly;
            pcbGroupRef.current.traverse((child: any) => {
              if (child.__baseY !== undefined) {
                child.position.y = child.__baseY + (child.__baseY > 0 ? exp * 5 : -exp * 2);
                if (child.__baseY > 0 && asm < 1) {
                  child.position.y += (1 - asm) * 30;
                  child.scale.setScalar(asm);
                  child.visible = asm > 0.05;
                }
              }
            });
          }

          // Current flow
          if (stateRef.current.showCurrentFlow && running && simContext && pcbGroupRef.current) {
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

          // Voltage probes — update positions in RAF loop (not React render)
          if (probeUpdateRef.current) probeUpdateRef.current();

          // Render (await for WebGPU to prevent frame piling)
          if (rendererRef.current && sceneRef.current && cameraRef.current) {
            const r = rendererRef.current;
            if (typeof r.renderAsync === 'function') {
              if (!isRendering) {
                isRendering = true;
                r.renderAsync(sceneRef.current, cameraRef.current).then(() => { isRendering = false; });
              }
            } else {
              r.render(sceneRef.current, cameraRef.current);
            }
          }
        };
        raf = requestAnimationFrame(animate);

        // ResizeObserver (not window event — handles panel splits)
        const resizeObserver = new ResizeObserver(() => {
          if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
          const w = containerRef.current.clientWidth;
          const h = containerRef.current.clientHeight;
          rendererRef.current.setSize(w, h);
          cameraRef.current.aspect = w / h;
          cameraRef.current.updateProjectionMatrix();
        });
        resizeObserver.observe(container);

        if (!cancelled) setLoading(false);

        return () => {
          cancelAnimationFrame(raf);
          resizeObserver.disconnect();
          // Dispose all scene resources
          scene.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry?.dispose();
              if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
              else child.material?.dispose?.();
            }
          });
          // Dispose model cache
          modelCacheRef.current.forEach((geo) => {
            if (geo !== FAILED_SENTINEL && geo instanceof THREE.BufferGeometry) geo.dispose();
          });
          modelCacheRef.current.clear();
          // Dispose renderer
          if (rendererRef.current) {
            rendererRef.current.dispose();
            if (rendererRef.current.domElement?.parentNode) {
              rendererRef.current.domElement.parentNode.removeChild(rendererRef.current.domElement);
            }
          }
        };
      } catch (err) {
        if (!cancelled) setError(`3D init failed: ${(err as Error).message}`);
      }
    };

    initScene().then((cleanup) => {
      if (cancelled && typeof cleanup === 'function') cleanup();
    });

    return () => {
      cancelled = true;
      // If renderer was created but cleanup not yet assigned, dispose it directly
      if (rendererCreated) {
        try { rendererCreated.dispose(); } catch {}
      }
    };
  }, []);

  // ── Rebuild PCB group when data changes ─────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current || footprints.length === 0) return;

    // Dispose old group
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
    const BOARD_THICKNESS = 1.6;

    // Board substrate
    const boardGeo = new THREE.BoxGeometry(board.width, BOARD_THICKNESS, board.height);
    const boardMat = new THREE.MeshStandardMaterial({ color: 0x0d4a0d, roughness: 0.85, metalness: 0.05 });
    const boardMesh = new THREE.Mesh(boardGeo, boardMat);
    boardMesh.position.set(board.width / 2, -BOARD_THICKNESS / 2, board.height / 2);
    (boardMesh as any).__baseY = -BOARD_THICKNESS / 2;
    group.add(boardMesh);

    // Silkscreen
    const silkGeo = new THREE.BoxGeometry(board.width - 2, 0.02, board.height - 2);
    const silkMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.9, metalness: 0.0 });
    const silkMesh = new THREE.Mesh(silkGeo, silkMat);
    silkMesh.position.set(board.width / 2, 0.01, board.height / 2);
    (silkMesh as any).__baseY = 0.01;
    group.add(silkMesh);

    const PAD_HEIGHT = 0.05;
    const TRACE_HEIGHT = 0.05;

    // Traces
    for (const trace of traces) {
      for (let si = 0; si < trace.segments.length; si++) {
        const seg = trace.segments[si];
        const dx = seg.end.x - seg.start.x;
        const dy = seg.end.y - seg.start.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.01) continue;
        const traceGeo = new THREE.BoxGeometry(length, TRACE_HEIGHT, trace.width);
        const traceMat = new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 0.3, metalness: 0.9 });
        const traceMesh = new THREE.Mesh(traceGeo, traceMat);
        traceMesh.position.set((seg.start.x + seg.end.x) / 2, trace.layer === 'top' ? PAD_HEIGHT : -BOARD_THICKNESS - PAD_HEIGHT, (seg.start.y + seg.end.y) / 2);
        if (Math.abs(dy) > 0.01) traceMesh.rotation.y = Math.atan2(dy, dx);
        (traceMesh as any).__baseY = traceMesh.position.y;
        (traceMesh as any).__isTrace = true;
        group.add(traceMesh);
      }
    }

    // Vias
    for (const via of vias) {
      const viaGeo = new THREE.CylinderGeometry(via.drill / 2 + 0.15, via.drill / 2 + 0.15, BOARD_THICKNESS + 0.1, 16);
      const viaMat = new THREE.MeshStandardMaterial({ color: 0xcc8844, roughness: 0.3, metalness: 0.8 });
      const viaMesh = new THREE.Mesh(viaGeo, viaMat);
      viaMesh.position.set(via.position.x, 0, via.position.y);
      (viaMesh as any).__baseY = 0;
      group.add(viaMesh);
      // Drill hole
      const drillGeo = new THREE.CylinderGeometry(via.drill / 2, via.drill / 2, BOARD_THICKNESS + 0.2, 16);
      const drillMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
      const drillMesh = new THREE.Mesh(drillGeo, drillMat);
      drillMesh.position.set(via.position.x, 0, via.position.y);
      group.add(drillMesh);
    }

    // Footprints + pads
    for (const fp of footprints) {
      // 3D model (async, cached)
      const modelKey = fp.modelUrl || `default:${fp.shape}`;
      const cache = modelCacheRef.current;
      const inFlight = inFlightRef.current;
      const cached = cache.get(modelKey);
      if (cached === undefined && !inFlight.has(modelKey)) {
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
              const defaultModel = getDefault3DModel(fp.shape);
              model = defaultModel ? { format: MODEL_TYPES.VRML, vertices: defaultModel.vertices, normals: defaultModel.normals, indices: defaultModel.indices } : null;
            }
            if (model) {
              const geo = modelToGeometry(model);
              cache.set(modelKey, geo);
            } else {
              cache.set(modelKey, FAILED_SENTINEL);
            }
          } catch {
            cache.set(modelKey, FAILED_SENTINEL);
          } finally {
            inFlight.delete(modelKey);
          }
          // Delay bump to avoid triggering rebuild for each model
          setTimeout(() => bumpModelVersion(), 100);
        })();
      }

      if (cached && cached !== FAILED_SENTINEL) {
        const mat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.4, metalness: 0.6 });
        const mesh = new THREE.Mesh(cached as THREE.BufferGeometry, mat);
        // Center the model on the footprint
        cached.computeBoundingBox();
        const bb = cached.boundingBox;
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
        group.add(mesh);
      }

      // Pads
      for (const pad of fp.pads) {
        const padW = pad.shape === 'circle' ? pad.drill || 0.6 : (pad as any).width || 0.6;
        const padH = pad.shape === 'circle' ? pad.drill || 0.6 : (pad as any).height || 0.6;
        const padGeo = new THREE.BoxGeometry(padW, PAD_HEIGHT, padH);
        const padMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.2, metalness: 0.9 });
        const padMesh = new THREE.Mesh(padGeo, padMat);
        const padY = fp.side === 'bottom' ? -BOARD_THICKNESS - PAD_HEIGHT : PAD_HEIGHT;
        padMesh.position.set(fp.position.x + pad.position.x, padY, fp.position.y + pad.position.y);
        (padMesh as any).__baseY = padY;
        group.add(padMesh);
        if (pad.shape === 'tht') {
          const drillGeo = new THREE.CylinderGeometry((pad.drill || 0.3) / 2, (pad.drill || 0.3) / 2, BOARD_THICKNESS + 0.2, 12);
          const drillMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
          const drillMesh = new THREE.Mesh(drillGeo, drillMat);
          drillMesh.position.set(fp.position.x + pad.position.x, 0, fp.position.y + pad.position.y);
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
  }, [footprints, traces, vias, board, padNets, modelVersion]);

  // ── Voltage probes — update positions in RAF loop ───────────────────────
  useEffect(() => {
    if (!showVoltageProbes || !cameraRef.current || !rendererRef.current) {
      probeUpdateRef.current = null;
      setProbeData([]);
      return;
    }
    probeUpdateRef.current = () => {
      if (!cameraRef.current || !rendererRef.current) return;
      const probes: { x: number; y: number; label: string }[] = [];
      for (const fp of footprints) {
        const pos = new THREE.Vector3(fp.position.x, 2, fp.position.y);
        pos.project(cameraRef.current);
        const w = rendererRef.current.domElement.clientWidth;
        const h = rendererRef.current.domElement.clientHeight;
        const x = (pos.x + 1) / 2 * w;
        const y = (1 - (pos.y + 1) / 2) * h;
        if (pos.z > 1) continue; // behind camera
        // Look up actual voltage from simContext
        let voltage = '—';
        if (simContext) {
          const comp = useEditor.getState().components.find((c) => c.id === fp.componentId);
          if (comp) {
            const plugin = getPlugin(comp.type);
            if (plugin) {
              const nodeMap = buildNodeMap(useEditor.getState().components, useEditor.getState().wires, new Map(
                Array.from(getAllPluginEntries()).map(([k, v]) => [k, v])
              ));
              const terms = getTerminalsForComponent(comp, plugin, nodeMap);
              const firstTerm = terms[0];
              if (firstTerm) {
                voltage = `${simContext.nodeVoltage[firstTerm.nodeId]?.toFixed(2) ?? '—'}V`;
              }
            }
          }
        }
        probes.push({ x, y, label: `${fp.refdes || fp.id}: ${voltage}` });
      }
      setProbeData(probes);
    };
  }, [showVoltageProbes, simContext, footprints]);

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
          {/* Control panel */}
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
                let p = 0;
                const interval = setInterval(() => {
                  p += 0.02;
                  if (p >= 1) { p = 1; clearInterval(interval); }
                  setAssemblyProgress(p);
                }, 30);
              }}
              className="flex items-center gap-1 rounded px-2 py-1 text-purple-300 hover:bg-slate-800">
              ▶ Play assembly
            </button>
          </div>

          {/* Voltage probe labels */}
          {probeData.map((p, i) => (
            <div key={i}
              className="pointer-events-none absolute z-10 rounded bg-blue-900/90 px-1.5 py-0.5 text-[10px] font-mono text-blue-200 border border-blue-700"
              style={{ left: `${p.x}px`, top: `${p.y}px`, transform: 'translate(-50%, -150%)' }}>
              {p.label}
            </div>
          ))}

          {/* Bottom overlay */}
          <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-[#0a1628]/80 px-3 py-1.5 text-xs font-mono text-slate-400">
            Left-drag: rotate · Right-drag: pan · Scroll: zoom
            {showCurrentFlow && running && <span className="ml-2 text-emerald-300">· ⚡ current flowing</span>}
          </div>
        </>
      )}
    </div>
  );
}

// Helper to iterate registry entries
function getAllPluginEntries() {
  const entries: [string, any][] = [];
  // This is a simplified version — in production we'd import the registry
  return entries;
}
