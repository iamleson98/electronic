// Single-stroke vector font for silkscreen text (reference designators).
// Gerber has no text primitive, so text is drawn as strokes with the
// silkscreen line aperture. Glyphs live on a 4 × 6 cell (y down), advance 5.

const GLYPHS: Record<string, string> = {
  '0': '0,0 4,0 4,6 0,6 0,0',
  '1': '1,1 2,0 2,6; 1,6 3,6',
  '2': '0,1 1,0 3,0 4,1 4,2 0,6 4,6',
  '3': '0,0 4,0 2,2 4,3 4,5 3,6 1,6 0,5',
  '4': '3,6 3,0 0,4 4,4',
  '5': '4,0 0,0 0,3 3,3 4,4 4,5 3,6 0,6',
  '6': '4,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 0,3',
  '7': '0,0 4,0 1,6',
  '8': '1,0 3,0 4,1 4,2 3,3 1,3 0,2 0,1 1,0; 1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3',
  '9': '4,3 1,3 0,2 0,1 1,0 3,0 4,1 4,5 3,6 0,6',
  A: '0,6 0,2 2,0 4,2 4,6; 0,3 4,3',
  B: '0,0 3,0 4,1 4,2 3,3 0,3; 3,3 4,4 4,5 3,6 0,6 0,0',
  C: '4,0 1,0 0,1 0,5 1,6 4,6',
  D: '0,0 3,0 4,1 4,5 3,6 0,6 0,0',
  E: '4,0 0,0 0,6 4,6; 0,3 3,3',
  F: '4,0 0,0 0,6; 0,3 3,3',
  G: '4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3',
  H: '0,0 0,6; 4,0 4,6; 0,3 4,3',
  I: '1,0 3,0; 2,0 2,6; 1,6 3,6',
  J: '4,0 4,5 3,6 1,6 0,5',
  K: '0,0 0,6; 4,0 0,3 4,6',
  L: '0,0 0,6 4,6',
  M: '0,6 0,0 2,3 4,0 4,6',
  N: '0,6 0,0 4,6 4,0',
  O: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
  P: '0,6 0,0 3,0 4,1 4,2 3,3 0,3',
  Q: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0; 2,4 4,6',
  R: '0,6 0,0 3,0 4,1 4,2 3,3 0,3; 2,3 4,6',
  S: '4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5',
  T: '0,0 4,0; 2,0 2,6',
  U: '0,0 0,5 1,6 3,6 4,5 4,0',
  V: '0,0 2,6 4,0',
  W: '0,0 1,6 2,3 3,6 4,0',
  X: '0,0 4,6; 4,0 0,6',
  Y: '0,0 2,3 4,0; 2,3 2,6',
  Z: '0,0 4,0 0,6 4,6',
  '-': '1,3 3,3',
  '_': '0,6 4,6',
  '+': '2,1 2,5; 0,3 4,3',
  '.': '2,5.4 2,6',
};
const UNKNOWN = '0,0 4,0 4,6 0,6 0,0';

const parsed = new Map<string, { x: number; y: number }[][]>();
function glyph(ch: string): { x: number; y: number }[][] {
  const key = GLYPHS[ch] !== undefined ? ch : '?';
  let g = parsed.get(key);
  if (!g) {
    g = (GLYPHS[key] ?? UNKNOWN).split(';').map((stroke) => stroke.trim().split(/\s+/).map((pt) => {
      const [x, y] = pt.split(',').map(Number);
      return { x, y };
    }));
    parsed.set(key, g);
  }
  return g;
}

/** Text width in mm for a given cap height. */
export function strokeTextWidth(text: string, heightMm: number): number {
  const u = heightMm / 6;
  return text.length > 0 ? (text.length * 5 - 1) * u : 0;
}

/**
 * Polylines (board space, y down) drawing `text` centred at (cx, cy) with
 * the given cap height. Spaces advance without drawing.
 */
export function strokeText(text: string, cx: number, cy: number, heightMm: number): { x: number; y: number }[][] {
  const u = heightMm / 6;
  const x0 = cx - strokeTextWidth(text, heightMm) / 2;
  const y0 = cy - heightMm / 2;
  const out: { x: number; y: number }[][] = [];
  [...text.toUpperCase()].forEach((ch, i) => {
    if (ch === ' ') return;
    for (const stroke of glyph(ch)) {
      out.push(stroke.map((p) => ({ x: x0 + (i * 5 + p.x) * u, y: y0 + p.y * u })));
    }
  });
  return out;
}
