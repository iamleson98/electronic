// Smooth limiting primitives for behavioral Newton stamps (op-amp output
// swing / slew / current limit, regulator pass elements).

/** C¹ clamp of u into [lo, hi] with an exponential knee of width k. */
export function softClamp(u: number, lo: number, hi: number, k: number): { y: number; dy: number } {
  if (hi - lo < 2 * k) k = Math.max(1e-9, (hi - lo) / 2);
  if (u > hi - k) {
    const e = Math.exp(-(u - (hi - k)) / k);
    return { y: hi - k * e, dy: e };
  }
  if (u < lo + k) {
    const e = Math.exp((u - (lo + k)) / k);
    return { y: lo + k * e, dy: e };
  }
  return { y: u, dy: 1 };
}

/**
 * Newton step limiting across a narrow linear window [lo, hi] (the analog of
 * junction limiting). From saturation the limiter's slope is ~0, so a raw
 * Newton step jumps straight to the opposite limit:
 *   - positive feedback (Schmitt triggers, oscillators): the jump is right —
 *     the opposite rail is self-consistent and the loop converges there;
 *   - negative feedback: the iterate jumps BACK and flips forever.
 * So the first crossing is accepted; a crossing back re-linearizes just
 * inside the edge it came from, where the slope is the full gain and Newton
 * sees the feedback. (Always re-linearizing at the edge instead lets
 * positive-feedback loops settle on their UNSTABLE in-between equilibrium.)
 */
export function limitAcross(
  uRaw: number, lo: number, hi: number, knee: number,
  mem: Record<string, number> | undefined, memKey: string,
): number {
  const uPrev = mem?.[memKey];
  let u = uRaw;
  if (uPrev !== undefined && mem) {
    const crossedDown = uPrev > hi && uRaw < lo;
    const crossedUp = uPrev < lo && uRaw > hi;
    if (crossedDown || crossedUp) {
      const n = (mem[memKey + '_n'] ?? 0) + 1;
      mem[memKey + '_n'] = n;
      if (n >= 2) u = crossedDown ? hi - knee : lo + knee;
    }
  }
  if (mem) {
    mem[memKey] = u;
    if (u !== uRaw) mem.__limited = (mem.__limited ?? 0) + 1;
  }
  return u;
}
