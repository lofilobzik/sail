/**
 * World-anchored wake history (no Three.js: testable under Node). Stores the stem's
 * logical world position, speed and source amplitude every `spacing` metres travelled.
 * Positions stay in logical-world doubles; `pack` subtracts the render origin only when
 * filling GPU buffers (DESIGN.md floating-origin contract).
 */

export interface TrailPoint {
  x: number;
  z: number;
  /** Speed through the water when this point was laid, m/s. */
  speed: number;
  /** Wake source amplitude at that speed, m. */
  amplitude: number;
  /** Simulation time, s. */
  time: number;
}

export interface TrailParams {
  trailSpacing: number;
  /** Total points packed, including the live head. */
  trailPoints: number;
  maxAge: number;
  teleportDistance: number;
}

export class WakeTrail {
  /** Recorded points, newest first. The live head is kept separately. */
  private readonly points: TrailPoint[] = [];
  private head: TrailPoint | null = null;

  constructor(private readonly p: TrailParams) {}

  get recorded(): number {
    return this.points.length;
  }

  clear(): void {
    this.points.length = 0;
    this.head = null;
  }

  update(head: TrailPoint): void {
    const newest = this.points[0];
    if (newest) {
      const jump = Math.hypot(head.x - newest.x, head.z - newest.z);
      // A reset moves the boat or rewinds time: an old trail would no longer belong to it.
      if (head.time < newest.time || jump > this.p.teleportDistance) this.points.length = 0;
    }
    const last = this.points[0];
    if (!last || Math.hypot(head.x - last.x, head.z - last.z) >= this.p.trailSpacing) this.points.unshift({ ...head });
    while (this.points.length > this.p.trailPoints - 1) this.points.pop();
    while (this.points.length > 0 && head.time - this.points[this.points.length - 1]!.time > this.p.maxAge) this.points.pop();
    this.head = { ...head };
  }

  /**
   * Fills `a` with (x - origin.x, z - origin.z, arc length from the head, speed) and `b` with
   * (amplitude, age, 0, 0) per point, head first. Returns the number of points written.
   */
  pack(origin: { x: number; z: number }, a: Float32Array, b: Float32Array): number {
    const h = this.head;
    if (!h) return 0;
    let count = 0;
    let s = 0;
    let px = h.x;
    let pz = h.z;
    const write = (q: TrailPoint) => {
      s += Math.hypot(q.x - px, q.z - pz);
      px = q.x;
      pz = q.z;
      const o = count * 4;
      a[o] = q.x - origin.x;
      a[o + 1] = q.z - origin.z;
      a[o + 2] = s;
      a[o + 3] = q.speed;
      b[o] = q.amplitude;
      b[o + 1] = h.time - q.time;
      b[o + 2] = 0;
      b[o + 3] = 0;
      count++;
    };
    write(h);
    for (const q of this.points) {
      if (count * 4 >= a.length) break;
      write(q);
    }
    return count;
  }
}
