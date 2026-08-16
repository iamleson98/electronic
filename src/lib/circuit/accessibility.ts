export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const c = hex.replace('#', '');
  if (c.length === 3) return { r: parseInt(c[0]+c[0],16), g: parseInt(c[1]+c[1],16), b: parseInt(c[2]+c[2],16) };
  return { r: parseInt(c.slice(0,2),16), g: parseInt(c.slice(2,4),16), b: parseInt(c.slice(4,6),16) };
}
export function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const toLinear = (cs: number) => { const c = cs / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}
export function contrastRatio(c1: { r: number; g: number; b: number }, c2: { r: number; g: number; b: number }): number {
  const l1 = relativeLuminance(c1), l2 = relativeLuminance(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
export function checkContrast(fg: string | { r: number; g: number; b: number }, bg: string | { r: number; g: number; b: number }): { ratio: number; passes: { aaNormal: boolean; aaLarge: boolean; aaaNormal: boolean; aaaLarge: boolean } } {
  const f = typeof fg === 'string' ? hexToRgb(fg) : fg;
  const b = typeof bg === 'string' ? hexToRgb(bg) : bg;
  const ratio = contrastRatio(f, b);
  return { ratio, passes: { aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5 } };
}
