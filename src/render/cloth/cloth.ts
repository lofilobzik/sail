/**
 * Visual-only Verlet cloth for the sail (no Three.js: testable under Node). It reads sim
 * outputs (luffAmount, apparent wind) and never feeds back into forces (DESIGN.md).
 *
 * Grid from a Planform: luff column, head row (the reinforced head, ~0.1 m wide) and clew
 * pinned (the Laser sail is loose-footed: only tack and clew attach to the boom).
 * Distance constraints (structural, shear,
 * bend) take their rest lengths from the cambered shape, so pressure from either side
 * billows the sail into that camber and the shape mirrors on each tack by itself.
 * Accelerations per particle, all in the boom frame:
 *   gravity  + x * leeward * fill * pressure * windScale        (billow to leeward)
 *            + x * luff * flutter * windScale * sin(w t - k s)  (wave running luff -> leech)
 *            + windDir * luff * flagDrag * windScale             (flagging downwind)
 * All gains are visual estimates (data/laser.json `visual.cloth`).
 */
import type { Planform } from './planform';

export interface ClothParams {
  /** Integration substep, s. */
  substep: number;
  iterations: number;
  /** Velocity retained per substep (1 = undamped). */
  damping: number;
  gravity: number;
  pressure: number;
  flutter: number;
  flutterHz: number;
  /** Flutter wave number along the chord, rad/m. */
  flutterWaveNumber: number;
  flagDrag: number;
  /** Stiffness (0..1) of the bend constraints. */
  bendStiffness: number;
  /** Largest frame step simulated; longer gaps are dropped. */
  maxStep: number;
}

export interface ClothInput {
  dt: number;
  /** -1..1: side the pressure pushes the cloth to, along boom-frame x. */
  leeward: number;
  /** 0..1 fraction of full pressure. */
  fill: number;
  /** 0..1 flutter amount (luffAmount). */
  luff: number;
  /** Unit apparent flow direction (where the air goes) in the boom frame. */
  windDir: readonly [number, number, number];
  /** Pressure scale, e.g. (AWS / reference AWS)^2. */
  windScale: number;
}

interface Constraint {
  a: number;
  b: number;
  rest: number;
  stiffness: number;
}

export class Cloth {
  readonly positions: Float32Array;
  private readonly prev: Float32Array;
  private readonly rest: Float32Array;
  private readonly pinned: Uint8Array;
  private readonly constraints: Constraint[] = [];
  /** Distance from the luff along the chord, per particle (for the flutter wave). */
  private readonly chordPos: Float32Array;
  private time = 0;
  private accumulator = 0;

  constructor(
    readonly planform: Planform,
    private readonly p: ClothParams,
  ) {
    const { cols, rows, flat, camber } = planform;
    const n = cols * rows;
    // Rest shape: cambered to +x (lengths are the same for either side).
    this.rest = new Float32Array(flat);
    for (let i = 0; i < n; i++) this.rest[i * 3] = camber[i]!;
    this.positions = new Float32Array(flat);
    this.prev = new Float32Array(flat);
    this.pinned = new Uint8Array(n);
    for (let k = 0; k < rows; k++) this.pinned[k * cols] = 1;
    for (let i = 0; i < cols; i++) this.pinned[(rows - 1) * cols + i] = 1; // head
    this.pinned[cols - 1] = 1; // clew
    this.chordPos = new Float32Array(n);
    for (let k = 0; k < rows; k++) {
      for (let i = 0; i < cols; i++) this.chordPos[k * cols + i] = this.dist(this.rest, k * cols, k * cols + i);
    }

    const add = (a: number, b: number, stiffness: number) =>
      this.constraints.push({ a, b, rest: this.dist(this.rest, a, b), stiffness });
    const id = (i: number, k: number) => k * cols + i;
    for (let k = 0; k < rows; k++) {
      for (let i = 0; i < cols; i++) {
        if (i + 1 < cols) add(id(i, k), id(i + 1, k), 1);
        if (k + 1 < rows) add(id(i, k), id(i, k + 1), 1);
        if (i + 1 < cols && k + 1 < rows) {
          add(id(i, k), id(i + 1, k + 1), 1);
          add(id(i + 1, k), id(i, k + 1), 1);
        }
        if (i + 2 < cols) add(id(i, k), id(i + 2, k), p.bendStiffness);
        if (k + 2 < rows) add(id(i, k), id(i, k + 2), p.bendStiffness);
      }
    }
  }

  private dist(arr: Float32Array, a: number, b: number): number {
    return Math.hypot(arr[a * 3]! - arr[b * 3]!, arr[a * 3 + 1]! - arr[b * 3 + 1]!, arr[a * 3 + 2]! - arr[b * 3 + 2]!);
  }

  /** Largest relative stretch of structural/shear constraints at least `minRest` long (for tests and checks). */
  maxStretch(minRest = 0): number {
    let worst = 0;
    for (const c of this.constraints) {
      if (c.stiffness < 1 || c.rest < minRest) continue;
      worst = Math.max(worst, Math.abs(this.dist(this.positions, c.a, c.b) / c.rest - 1));
    }
    return worst;
  }

  /** Advances by input.dt using fixed substeps. */
  update(input: ClothInput): void {
    this.accumulator += Math.min(Math.max(input.dt, 0), this.p.maxStep);
    while (this.accumulator >= this.p.substep) {
      this.accumulator -= this.p.substep;
      this.substep(input);
    }
  }

  private substep(input: ClothInput): void {
    const p = this.p;
    const h = p.substep;
    this.time += h;
    const pos = this.positions;
    const prev = this.prev;
    const n = pos.length / 3;
    const press = input.leeward * input.fill * p.pressure * input.windScale;
    const flut = input.luff * p.flutter * input.windScale;
    const omega = 2 * Math.PI * p.flutterHz * this.time;
    const flag = input.luff * p.flagDrag * input.windScale;
    const [wx, wy, wz] = input.windDir;
    const h2 = h * h;
    for (let i = 0; i < n; i++) {
      if (this.pinned[i]) continue;
      const ax = press + flut * Math.sin(omega - p.flutterWaveNumber * this.chordPos[i]!) + wx * flag;
      const ay = -p.gravity + wy * flag;
      const az = wz * flag;
      for (let d = 0; d < 3; d++) {
        const j = i * 3 + d;
        const cur = pos[j]!;
        const a = d === 0 ? ax : d === 1 ? ay : az;
        pos[j] = cur + (cur - prev[j]!) * p.damping + a * h2;
        prev[j] = cur;
      }
    }
    for (let it = 0; it < p.iterations; it++) {
      for (const c of this.constraints) this.solve(c);
    }
    for (let i = 0; i < n; i++) {
      if (!this.pinned[i]) continue;
      for (let d = 0; d < 3; d++) pos[i * 3 + d] = prev[i * 3 + d] = this.planform.flat[i * 3 + d]!;
    }
  }

  private solve(c: Constraint): void {
    const pos = this.positions;
    const a = c.a * 3;
    const b = c.b * 3;
    const dx = pos[b]! - pos[a]!;
    const dy = pos[b + 1]! - pos[a + 1]!;
    const dz = pos[b + 2]! - pos[a + 2]!;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-9) return;
    const pa = this.pinned[c.a]!;
    const pb = this.pinned[c.b]!;
    if (pa && pb) return;
    const diff = ((d - c.rest) / d) * c.stiffness;
    const wa = pa ? 0 : pb ? 1 : 0.5;
    const wb = pb ? 0 : pa ? 1 : 0.5;
    pos[a] = pos[a]! + dx * diff * wa;
    pos[a + 1] = pos[a + 1]! + dy * diff * wa;
    pos[a + 2] = pos[a + 2]! + dz * diff * wa;
    pos[b] = pos[b]! - dx * diff * wb;
    pos[b + 1] = pos[b + 1]! - dy * diff * wb;
    pos[b + 2] = pos[b + 2]! - dz * diff * wb;
  }

  /** Bilinear point on the cloth at chord fraction c and height fraction h. */
  sample(c: number, h: number, out: [number, number, number]): [number, number, number] {
    const { cols, rows } = this.planform;
    const fx = Math.min(Math.max(c, 0), 1) * (cols - 1);
    const fy = Math.min(Math.max(h, 0), 1) * (rows - 1);
    const i = Math.min(Math.floor(fx), cols - 2);
    const k = Math.min(Math.floor(fy), rows - 2);
    const u = fx - i;
    const v = fy - k;
    const pos = this.positions;
    for (let d = 0; d < 3; d++) {
      const p00 = pos[(k * cols + i) * 3 + d]!;
      const p10 = pos[(k * cols + i + 1) * 3 + d]!;
      const p01 = pos[((k + 1) * cols + i) * 3 + d]!;
      const p11 = pos[((k + 1) * cols + i + 1) * 3 + d]!;
      out[d] = (p00 * (1 - u) + p10 * u) * (1 - v) + (p01 * (1 - u) + p11 * u) * v;
    }
    return out;
  }
}
