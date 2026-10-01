/**
 * Sail planform as a regular grid in the boom frame (no Three.js: testable under Node).
 * Boom frame: x across the sail (+x = boom frame starboard), y up, z aft along the boom,
 * origin at the tack. Planform from the ILCA 7 MKI sail (rules p36): luff, foot and leech
 * close the triangle (luff raked by `rake`), the luff-to-leech widths at 1/4, 1/2 and 3/4
 * leech add the roach. The camber (visual estimate) is built into the rest shape so the
 * cloth billows to it under pressure on either side.
 */

export interface PlanformSpec {
  luff: number;
  foot: number;
  /** Mast rake from vertical, rad. */
  rake: number;
  /** Leech fractions from the clew where `widths` are measured. */
  leechFracs: readonly number[];
  widths: readonly number[];
  headWidth: number;
  camberDepthFrac: number;
  camberPosFrac: number;
  /** Points along the chord (luff to leech) and up the sail (foot to head). */
  cols: number;
  rows: number;
}

export interface Planform {
  cols: number;
  rows: number;
  /** Flat rest positions (x = 0), xyz per point, index = row * cols + col. */
  flat: Float32Array;
  /** Camber offset magnitude along x per point (>= 0). */
  camber: Float32Array;
}

/** Mean line, 1 at chord fraction `pos`, 0 at both ends (NACA 4-digit style). */
export function camberLine(c: number, pos: number): number {
  return c < pos ? (2 * pos * c - c * c) / (pos * pos) : (1 - 2 * pos + 2 * pos * c - c * c) / ((1 - pos) * (1 - pos));
}

function interp(xs: readonly number[], ys: readonly number[], x: number): number {
  let i = 0;
  while (i < xs.length - 2 && x > xs[i + 1]!) i++;
  const t = (x - xs[i]!) / (xs[i + 1]! - xs[i]!);
  return ys[i]! + t * (ys[i + 1]! - ys[i]!);
}

export function buildPlanform(s: PlanformSpec): Planform {
  // 2D (aft, up) in the sail plane.
  const luffDir = [Math.sin(s.rake), Math.cos(s.rake)] as const;
  const head = [luffDir[0] * s.luff, luffDir[1] * s.luff] as const;
  const clew = [s.foot, 0] as const;

  // Knots by leech fraction f (0 = clew, 1 = head): luff parameter, width and chord direction.
  const fKnots = [0, ...s.leechFracs, 1];
  const luffAt = [0];
  const width = [s.foot];
  const dirs: [number, number][] = [[1, 0]];
  s.leechFracs.forEach((f, i) => {
    const p = [clew[0] + (head[0] - clew[0]) * f, clew[1] + (head[1] - clew[1]) * f];
    const t = p[0]! * luffDir[0] + p[1]! * luffDir[1];
    const d = [p[0]! - luffDir[0] * t, p[1]! - luffDir[1] * t];
    const len = Math.hypot(d[0]!, d[1]!);
    luffAt.push(t);
    width.push(s.widths[i]!);
    dirs.push([d[0]! / len, d[1]! / len]);
  });
  luffAt.push(s.luff);
  width.push(s.headWidth);
  dirs.push([Math.cos(s.rake), -Math.sin(s.rake)]);

  const n = s.cols * s.rows;
  const flat = new Float32Array(n * 3);
  const camber = new Float32Array(n);
  for (let k = 0; k < s.rows; k++) {
    const f = k / (s.rows - 1);
    const t = interp(fKnots, luffAt, f);
    const w = interp(fKnots, width, f);
    const seg = Math.min(Math.floor(f * (fKnots.length - 1)), fKnots.length - 2);
    const u = (f - fKnots[seg]!) / (fKnots[seg + 1]! - fKnots[seg]!);
    const a = dirs[seg]!;
    const b = dirs[seg + 1]!;
    let dx = a[0] + (b[0] - a[0]) * u;
    let dy = a[1] + (b[1] - a[1]) * u;
    const dl = Math.hypot(dx, dy);
    dx /= dl;
    dy /= dl;
    for (let i = 0; i < s.cols; i++) {
      const c = i / (s.cols - 1);
      const idx = k * s.cols + i;
      flat[idx * 3] = 0;
      flat[idx * 3 + 1] = luffDir[1] * t + dy * c * w;
      flat[idx * 3 + 2] = luffDir[0] * t + dx * c * w;
      camber[idx] = s.camberDepthFrac * w * camberLine(c, s.camberPosFrac);
    }
  }
  return { cols: s.cols, rows: s.rows, flat, camber };
}
