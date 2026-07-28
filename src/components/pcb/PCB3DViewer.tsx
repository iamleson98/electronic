'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { usePCB } from '@/lib/pcb/store';

export function PCB3DViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<any>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pcbGroupRef = useRef<THREE.Group | null>(null);
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

    for (const fp of footprints) {
      // Component body
      const bodyH = fp.componentType === 'dcVoltage' || fp.componentType === 'acVoltage' ? 5.0
                  : fp.componentType === 'timer555' || fp.componentType === 'opamp' ? 3.5
                  : fp.componentType === 'arduino' || fp.componentType === 'arduinoReal' ? 1.5
                  : fp.componentType === 'led' ? 0.6 : 1.0;
      const color = componentColors[fp.componentType] ?? 0x111111;
      const geo = new THREE.BoxGeometry(fp.bodySize.width, bodyH, fp.bodySize.height);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 });
      const mesh = new THREE.Mesh(geo, mat);
      const y = fp.side === 'top' ? PAD_HEIGHT + bodyH / 2 : -BOARD_THICKNESS - PAD_HEIGHT - bodyH / 2;
      mesh.position.set(fp.position.x, y, fp.position.y);
      mesh.rotation.y = (fp.rotation * Math.PI) / 180;
      group.add(mesh);

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
  }, [footprints, traces, vias, board, padNets]);

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
