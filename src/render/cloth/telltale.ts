/**
 * Telltale (wool tuft) shape, no Three.js. A telltale is a short chain of segments from its
 * attachment point. With attached flow it streams along the sail surface toward the leech;
 * as `lift` (0..1) grows it leaves the surface, wanders and droops, as a tuft does in
 * separated flow. Visual model only; gains are visual estimates.
 */

export type V3 = [number, number, number];

export interface TelltaleShape {
  /** Unit vector along the surface toward the leech. */
  stream: V3;
  /** Unit vector away from the sail surface on the telltale's side. */
  away: V3;
  /** 0 = attached flow, 1 = fully separated. */
  lift: number;
  time: number;
  /** Per-telltale phase so they do not move in lockstep. */
  phase: number;
  segmentLength: number;
}

const WANDER_HZ = 3.1; // visual estimate: separated-flow flicker
const SHIMMER = 0.06; // visual estimate: sideways shimmer of an attached tuft
const DROOP = 0.7; // visual estimate: weight of gravity in a separated tuft

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Fills `out` with segments + 1 points (xyz) starting at `base`. */
export function telltalePoints(base: V3, s: TelltaleShape, segments: number, out: Float32Array): Float32Array {
  let [x, y, z] = base;
  out[0] = x;
  out[1] = y;
  out[2] = z;
  const lift = Math.min(Math.max(s.lift, 0), 1);
  for (let i = 1; i <= segments; i++) {
    const w = 2 * Math.PI * WANDER_HZ * s.time + s.phase + i * 0.9;
    const wander = Math.sin(w) * (0.6 + 0.4 * Math.sin(1.7 * w));
    const shimmer = SHIMMER * Math.sin(3 * w);
    const awayGain = shimmer * (1 - lift) + lift * (0.4 + 0.9 * wander);
    const streamGain = (1 - lift) + lift * 0.4 * Math.cos(w);
    const d = normalize([
      s.stream[0] * streamGain + s.away[0] * awayGain,
      s.stream[1] * streamGain + s.away[1] * awayGain - lift * DROOP,
      s.stream[2] * streamGain + s.away[2] * awayGain,
    ]);
    x += d[0] * s.segmentLength;
    y += d[1] * s.segmentLength;
    z += d[2] * s.segmentLength;
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}
