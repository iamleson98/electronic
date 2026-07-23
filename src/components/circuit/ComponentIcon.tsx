'use client';

import { useEffect, useRef } from 'react';
import type { ComponentPlugin } from '@/lib/circuit/types';
import { getPlugin } from '@/lib/circuit/registry';

interface ComponentIconProps {
  type: string;
  size?: number;
}

/**
 * Renders a miniature preview of a component using its actual render function.
 * This gives users a visual icon that matches what they'll see on the canvas.
 */
export function ComponentIcon({ type, size = 40 }: ComponentIconProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const plugin = getPlugin(type) as ComponentPlugin | undefined;
    if (!plugin) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    // transparent background
    ctx.clearRect(0, 0, size, size);
    // Compute scale to fit the component bounding box into the icon
    const bb = plugin.boundingBox;
    const bbW = bb.width;
    const bbH = bb.height;
    const margin = 4;
    const availW = size - margin * 2;
    const availH = size - margin * 2;
    // We use a fixed small cellSize so the component renders at icon scale
    const cellSize = Math.min(availW / bbW, availH / bbH);
    // Center the component
    const offsetX = (size - bbW * cellSize) / 2;
    const offsetY = (size - bbH * cellSize) / 2;
    ctx.translate(offsetX, offsetY);
    // Set drawing styles
    ctx.strokeStyle = '#67e8f9';  // cyan-300
    ctx.fillStyle = '#67e8f9';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    try {
      // Render with default parameters
      const defaults: Record<string, any> = {};
      for (const p of plugin.parameters) defaults[p.key] = p.default;
      plugin.render(ctx, defaults, cellSize, undefined, undefined);
    } catch (e) {
      // Fallback: draw the symbol text
      ctx.fillStyle = '#67e8f9';
      ctx.font = `bold ${size * 0.4}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(plugin.symbol, size / 2, size / 2);
    }
    ctx.restore();
  }, [type, size]);

  return <canvas ref={canvasRef} className="pointer-events-none" />;
}
