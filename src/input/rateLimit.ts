/** Moves `current` toward `target` by at most `maxRatePerSecond * dt`, never overshooting. */
export function rateLimit(current: number, target: number, maxRatePerSecond: number, dt: number): number {
  const maxStep = Math.max(0, maxRatePerSecond * dt);
  const delta = target - current;
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}
