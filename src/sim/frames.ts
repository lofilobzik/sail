/**
 * Frame conventions. The single place where compass angles map to world axes.
 *
 * World: right-handed, Three.js-compatible, y up. Horizontal plane is x-z.
 *   North = -z, East = +x.
 *   A compass bearing theta (radians, clockwise from north) points along
 *   (sin theta, 0, -cos theta).
 *
 * Body (horizontal plane, heel ignored):
 *   +x forward (surge u), +y to starboard (sway v), +z up.
 *   Yaw rate r > 0 turns the bow to starboard (clockwise seen from above).
 *   Heel phi > 0 puts the starboard rail down.
 *
 * Angles relative to the bow (e.g. apparent wind angle) are measured from the
 * bow, positive to starboard, in (-pi, pi].
 */

export const DEG = Math.PI / 180;
export const KNOT = 1852 / 3600; // m/s per knot
export const G = 9.81; // m/s^2, standard gravity

export interface Vec2 {
  x: number;
  z: number;
}

/** Unit vector in the world x-z plane for a compass bearing (radians). */
export function bearingToWorld(bearing: number): Vec2 {
  return { x: Math.sin(bearing), z: -Math.cos(bearing) };
}

/** Compass bearing (radians, [0, 2pi)) of a world x-z vector. */
export function worldToBearing(x: number, z: number): number {
  return wrap2Pi(Math.atan2(x, -z));
}

/** Body starboard unit vector in world coordinates (the forward vector is bearingToWorld(heading)). */
export function starboardWorld(heading: number): Vec2 {
  return { x: Math.cos(heading), z: Math.sin(heading) };
}

/** World x-z vector -> body (forward, starboard) components. */
export function worldToBody(heading: number, x: number, z: number): { u: number; v: number } {
  const f = bearingToWorld(heading);
  const s = starboardWorld(heading);
  return { u: x * f.x + z * f.z, v: x * s.x + z * s.z };
}

/** Body (forward, starboard) components -> world x-z vector. */
export function bodyToWorld(heading: number, u: number, v: number): Vec2 {
  const f = bearingToWorld(heading);
  const s = starboardWorld(heading);
  return { x: u * f.x + v * s.x, z: u * f.z + v * s.z };
}

export function wrapPi(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}

export function wrap2Pi(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
