/**
 * Visual-only cloth for the sail (no Three.js: testable under Node). It reads sim
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
 *
 * Solver: small-step XPBD (Macklin et al. 2019, "Small Steps in Physics Simulation"): many short
 * substeps with one constraint pass each, explicit velocities and compliant bend constraints. Each
 * frame is split into equal substeps near `substep` long, so the substep length follows the frame
 * time; the explicit velocities keep that integration correct for a varying step.
 */
import type { Planform } from './planform';

export interface ClothParams {
  /** Target integration substep, s; each frame runs round(dt / substep) equal substeps. */
  substep: number;
  /** Most substeps in one frame (long frames get longer substeps). */
  maxSubsteps: number;
  /** Constraint passes per substep. */
  iterations: number;
  /** Fraction of velocity kept after one second (1 = undamped). */
  velocityRetainedPerSecond: number;
  gravity: number;
  pressure: number;
  flutter: number;
  flutterHz: number;
  /** Flutter wave number along the chord, rad/m. */
  flutterWaveNumber: number;
  flagDrag: number;
  /** XPBD compliance of the bend constraints, m/N (0 = rigid). */
  bendCompliance: number;
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

export class Cloth {
  readonly positions: Float32Array;
  /** Vertex normals (cols x rows x 3), from central differences across the grid. */
  readonly normals: Float32Array;
  /** Positions at the start of the current substep. */
  private readonly prevSubstep: Float32Array;
  private readonly velocity: Float32Array;
  /** 0 for pinned particles, 1 for free ones. */
  private readonly invMass: Float32Array;
  private readonly conA: Int32Array;
  private readonly conB: Int32Array;
  private readonly conRest: Float32Array;
  private readonly conCompliance: Float32Array;
  private readonly lambda: Float32Array;
  /** Distance from the luff along the chord, per particle (for the flutter wave). */
  private readonly chordPos: Float32Array;
  private time = 0;

  constructor(
    readonly planform: Planform,
    private readonly p: ClothParams,
  ) {
    const { cols, rows, flat, camber } = planform;
    const n = cols * rows;
    // Rest shape: cambered to +x (lengths are the same for either side).
    const rest = new Float32Array(flat);
    for (let i = 0; i < n; i++) rest[i * 3] = camber[i]!;
    this.positions = new Float32Array(flat);
    this.prevSubstep = new Float32Array(flat);
    this.velocity = new Float32Array(n * 3);
    this.normals = new Float32Array(n * 3);
    this.invMass = new Float32Array(n).fill(1);
    for (let k = 0; k < rows; k++) this.invMass[k * cols] = 0;
    for (let i = 0; i < cols; i++) this.invMass[(rows - 1) * cols + i] = 0; // head
    this.invMass[cols - 1] = 0; // clew
    this.chordPos = new Float32Array(n);
    for (let k = 0; k < rows; k++) {
      for (let i = 0; i < cols; i++) this.chordPos[k * cols + i] = Cloth.dist(rest, k * cols, k * cols + i);
    }

    const a: number[] = [];
    const b: number[] = [];
    const compliance: number[] = [];
    const add = (i: number, j: number, c: number) => {
      a.push(i);
      b.push(j);
      compliance.push(c);
    };
    const id = (i: number, k: number) => k * cols + i;
    for (let k = 0; k < rows; k++) {
      for (let i = 0; i < cols; i++) {
        if (i + 1 < cols) add(id(i, k), id(i + 1, k), 0);
        if (k + 1 < rows) add(id(i, k), id(i, k + 1), 0);
        if (i + 1 < cols && k + 1 < rows) {
          add(id(i, k), id(i + 1, k + 1), 0);
          add(id(i + 1, k), id(i, k + 1), 0);
        }
        if (i + 2 < cols) add(id(i, k), id(i + 2, k), p.bendCompliance);
        if (k + 2 < rows) add(id(i, k), id(i, k + 2), p.bendCompliance);
      }
    }
    this.conA = Int32Array.from(a);
    this.conB = Int32Array.from(b);
    this.conCompliance = Float32Array.from(compliance);
    this.conRest = Float32Array.from(a, (ai, c) => Cloth.dist(rest, ai, b[c]!));
    this.lambda = new Float32Array(a.length);
    this.computeNormals();
  }

  private static dist(arr: Float32Array, a: number, b: number): number {
    const dx = arr[a * 3]! - arr[b * 3]!;
    const dy = arr[a * 3 + 1]! - arr[b * 3 + 1]!;
    const dz = arr[a * 3 + 2]! - arr[b * 3 + 2]!;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Largest relative stretch of structural/shear constraints at least `minRest` long (for tests and checks). */
  maxStretch(minRest = 0): number {
    let worst = 0;
    for (let c = 0; c < this.conA.length; c++) {
      const rest = this.conRest[c]!;
      if (this.conCompliance[c] !== 0 || rest < minRest) continue;
      worst = Math.max(worst, Math.abs(Cloth.dist(this.positions, this.conA[c]!, this.conB[c]!) / rest - 1));
    }
    return worst;
  }

  /** Advances by input.dt (capped at maxStep) in equal substeps; false if no time passed. */
  update(input: ClothInput): boolean {
    const p = this.p;
    const dt = Math.min(Math.max(input.dt, 0), p.maxStep);
    if (dt === 0) return false;
    const n = Math.min(p.maxSubsteps, Math.max(1, Math.round(dt / p.substep)));
    const h = dt / n;
    for (let s = 0; s < n; s++) this.substep(input, h);
    this.computeNormals();
    return true;
  }

  private substep(input: ClothInput, h: number): void {
    const p = this.p;
    this.time += h;
    const pos = this.positions;
    const prev = this.prevSubstep;
    const vel = this.velocity;
    const invMass = this.invMass;
    const n = invMass.length;
    const press = input.leeward * input.fill * p.pressure * input.windScale;
    const flut = input.luff * p.flutter * input.windScale;
    const omega = 2 * Math.PI * p.flutterHz * this.time;
    const flag = input.luff * p.flagDrag * input.windScale;
    const [wx, wy, wz] = input.windDir;
    const retain = p.velocityRetainedPerSecond ** h;
    const ay = -p.gravity + wy * flag;
    const az = wz * flag;
    for (let i = 0; i < n; i++) {
      if (invMass[i] === 0) continue;
      const ax = press + flut * Math.sin(omega - p.flutterWaveNumber * this.chordPos[i]!) + wx * flag;
      const j = i * 3;
      vel[j] = (vel[j]! + ax * h) * retain;
      vel[j + 1] = (vel[j + 1]! + ay * h) * retain;
      vel[j + 2] = (vel[j + 2]! + az * h) * retain;
      prev[j] = pos[j]!;
      prev[j + 1] = pos[j + 1]!;
      prev[j + 2] = pos[j + 2]!;
      pos[j] = pos[j]! + vel[j]! * h;
      pos[j + 1] = pos[j + 1]! + vel[j + 1]! * h;
      pos[j + 2] = pos[j + 2]! + vel[j + 2]! * h;
    }

    const { conA, conB, conRest, conCompliance, lambda } = this;
    lambda.fill(0);
    const h2 = h * h;
    for (let it = 0; it < p.iterations; it++) {
      for (let c = 0; c < conA.length; c++) {
        const ia = conA[c]!;
        const ib = conB[c]!;
        const wa = invMass[ia]!;
        const wb = invMass[ib]!;
        const w = wa + wb;
        if (w === 0) continue;
        const a = ia * 3;
        const b = ib * 3;
        const dx = pos[b]! - pos[a]!;
        const dy = pos[b + 1]! - pos[a + 1]!;
        const dz = pos[b + 2]! - pos[a + 2]!;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-9) continue;
        const alphaT = conCompliance[c]! / h2;
        const dl = (-(d - conRest[c]!) - alphaT * lambda[c]!) / (w + alphaT);
        lambda[c] = lambda[c]! + dl;
        const s = dl / d;
        pos[a] = pos[a]! - dx * s * wa;
        pos[a + 1] = pos[a + 1]! - dy * s * wa;
        pos[a + 2] = pos[a + 2]! - dz * s * wa;
        pos[b] = pos[b]! + dx * s * wb;
        pos[b + 1] = pos[b + 1]! + dy * s * wb;
        pos[b + 2] = pos[b + 2]! + dz * s * wb;
      }
    }

    const flat = this.planform.flat;
    const invH = 1 / h;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      if (invMass[i] === 0) {
        for (let d = 0; d < 3; d++) {
          pos[j + d] = flat[j + d]!;
          vel[j + d] = 0;
        }
      } else {
        for (let d = 0; d < 3; d++) vel[j + d] = (pos[j + d]! - prev[j + d]!) * invH;
      }
    }
  }

  /**
   * Normal per vertex: du x dv from central differences across the grid (one-sided at the edges),
   * oriented like the mesh's triangles (a, a + 1, a + cols).
   */
  private computeNormals(): void {
    const { cols, rows } = this.planform;
    const pos = this.positions;
    const out = this.normals;
    for (let k = 0; k < rows; k++) {
      const kd = Math.max(k - 1, 0) * cols;
      const ku = Math.min(k + 1, rows - 1) * cols;
      for (let i = 0; i < cols; i++) {
        const l = (k * cols + Math.max(i - 1, 0)) * 3;
        const r = (k * cols + Math.min(i + 1, cols - 1)) * 3;
        const dn = (kd + i) * 3;
        const up = (ku + i) * 3;
        const ux = pos[r]! - pos[l]!;
        const uy = pos[r + 1]! - pos[l + 1]!;
        const uz = pos[r + 2]! - pos[l + 2]!;
        const vx = pos[up]! - pos[dn]!;
        const vy = pos[up + 1]! - pos[dn + 1]!;
        const vz = pos[up + 2]! - pos[dn + 2]!;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const inv = len > 0 ? 1 / len : 0;
        const j = (k * cols + i) * 3;
        out[j] = nx * inv;
        out[j + 1] = ny * inv;
        out[j + 2] = nz * inv;
      }
    }
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
