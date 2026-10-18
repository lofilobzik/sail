/** Render-only intersection of the lofted hull with the undisturbed local sea. No Three.js. */
import { createWaveSample, sampleWavesNear } from '../../sim/waves';
import type { WaveConfig } from '../../physics/types';
import type { BoatLayout } from '../boatLayout';

export interface ContactPose {
  x: number;
  z: number;
  heading: number;
  pitch: number;
  heel: number;
  t: number;
}

/** Numerical root refinement, not a physics coefficient: 14 halvings of a sampled edge. */
const HALVINGS = 14;
/** A warm bracket of +-2^-8 around last frame's root needs 7 halvings for the same resolution. */
const WARM_HALF_WIDTH = 2 ** -8;
const WARM_HALVINGS = 7;
/**
 * Beyond these frame-to-frame changes (a reset, respawn, snap or paused tab) last frame's hull
 * points say nothing about this one: start cold. Numerical choices, not physics.
 */
const WARM_MAX_DT = 0.25; // s
const WARM_MAX_MOVE = 2; // m
const WARM_MAX_TURN = 0.35; // rad, about 20 degrees

export class BowContact {
  /** Contact in horizontal heading coordinates, relative to the boat reference point. */
  forward = 0;
  starboard = 0;
  height = 0;
  private readonly body: Float64Array;
  private readonly transformed: Float64Array;
  private readonly gaps: Float64Array;
  private readonly row: number;
  private readonly surface = createWaveSample();
  private sinHeading = 0;
  private cosHeading = 1;
  /** Last wave displacement found at each hull point (2 per point), the inversion's warm start. */
  private readonly pointOffsets: Float64Array;
  /** The same for the bisection along each edge (2 edges per point: from the station ahead, from the point beside). */
  private readonly edgeOffsets: Float64Array;
  /** Last root along each edge, 0..1, and the update it was found in. */
  private readonly edgeRoots: Float64Array;
  private readonly edgeFrames: Int32Array;
  private frame = 0;
  private warm = false;
  private lastX = 0;
  private lastZ = 0;
  private lastT = 0;
  private lastHeading = 0;
  private lastComponents: unknown = null;

  constructor(layout: BoatLayout, private readonly stations: number) {
    const p = layout.model.cfg.visual.sectionPoints;
    this.row = 2 * p + 1;
    const count = (stations + 1) * this.row;
    this.body = new Float64Array(count * 3);
    this.transformed = new Float64Array(count * 3);
    this.gaps = new Float64Array(count);
    this.pointOffsets = new Float64Array(count * 2);
    this.edgeOffsets = new Float64Array(count * 4);
    this.edgeRoots = new Float64Array(count * 2);
    this.edgeFrames = new Int32Array(count * 2).fill(-2);
    // Cache the loft once: no sectionPoint objects or geometry allocations per frame.
    for (let i = 0; i <= stations; i++) {
      const x = layout.bowX - layout.loa * i / stations;
      for (let j = -p; j <= p; j++) {
        const point = layout.sectionPoint(x, Math.abs(j) / p);
        const k = (i * this.row + j + p) * 3;
        this.body[k] = x;
        this.body[k + 1] = Math.sign(j) * point.y;
        this.body[k + 2] = point.z;
      }
    }
  }

  private clearance(f: number, r: number, y: number, pose: ContactPose, waves: WaveConfig, offsets: Float64Array, slot: number): number {
    const x = pose.x + this.sinHeading * f + this.cosHeading * r;
    const z = pose.z - this.cosHeading * f + this.sinHeading * r;
    sampleWavesNear(waves, x, z, pose.t, 0, this.surface, offsets, slot);
    return y - this.surface.y;
  }

  /** Whether the point at fraction t from point a to point b is above the sea. */
  private dryAt(a: number, b: number, t: number, edge: number, pose: ContactPose, waves: WaveConfig): boolean {
    const p = this.transformed, ka = a * 3, kb = b * 3;
    const f = p[ka]! + (p[kb]! - p[ka]!) * t;
    const r = p[ka + 1]! + (p[kb + 1]! - p[ka + 1]!) * t;
    const y = p[ka + 2]! + (p[kb + 2]! - p[ka + 2]!) * t;
    return this.clearance(f, r, y, pose, waves, this.edgeOffsets, edge) > 0;
  }

  /** Edge `edge` runs from point a (gap known) to point b; the waterline crosses it somewhere. */
  private consider(a: number, b: number, edge: number, pose: ContactPose, waves: WaveConfig): void {
    const aDry = this.gaps[a]! > 0;
    let lo = 0, hi = 1, halvings = HALVINGS;
    if (this.edgeFrames[edge] === this.frame - 1) {
      // Bracket last frame's root; keep it only if the waterline still crosses inside.
      const root = this.edgeRoots[edge]!;
      const wlo = Math.max(0, root - WARM_HALF_WIDTH), whi = Math.min(1, root + WARM_HALF_WIDTH);
      if (this.dryAt(a, b, wlo, edge, pose, waves) === aDry && this.dryAt(a, b, whi, edge, pose, waves) !== aDry) {
        lo = wlo;
        hi = whi;
        halvings = WARM_HALVINGS;
      }
    } else {
      this.edgeOffsets[2 * edge] = this.pointOffsets[2 * a]!;
      this.edgeOffsets[2 * edge + 1] = this.pointOffsets[2 * a + 1]!;
    }
    for (let i = 0; i < halvings; i++) {
      const t = (lo + hi) / 2;
      if (this.dryAt(a, b, t, edge, pose, waves) === aDry) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2;
    this.edgeRoots[edge] = t;
    this.edgeFrames[edge] = this.frame;
    const p = this.transformed, ka = a * 3, kb = b * 3;
    const f = p[ka]! + (p[kb]! - p[ka]!) * t;
    if (f > this.forward) {
      this.forward = f;
      this.starboard = p[ka + 1]! + (p[kb + 1]! - p[ka + 1]!) * t;
      this.height = p[ka + 2]! + (p[kb + 2]! - p[ka + 2]!) * t;
    }
  }

  /** Last frame's results seed this one unless the pose or sea jumped. */
  private startFrame(pose: ContactPose, waves: WaveConfig): void {
    const dt = pose.t - this.lastT;
    const warm = this.warm && waves.components === this.lastComponents
      && dt >= 0 && dt <= WARM_MAX_DT
      && Math.hypot(pose.x - this.lastX, pose.z - this.lastZ) <= WARM_MAX_MOVE
      && Math.abs(Math.atan2(Math.sin(pose.heading - this.lastHeading), Math.cos(pose.heading - this.lastHeading))) <= WARM_MAX_TURN;
    if (!warm) {
      this.pointOffsets.fill(0);
      // No edge was solved "last frame" any more.
      this.frame++;
    }
    this.frame++;
    this.warm = true;
    this.lastX = pose.x;
    this.lastZ = pose.z;
    this.lastT = pose.t;
    this.lastHeading = pose.heading;
    this.lastComponents = waves.components;
  }

  /** Search bow to transom; false only when the sampled hull is entirely above the sea. */
  update(pose: ContactPose, waves: WaveConfig, hullY: number, pitch = pose.pitch): boolean {
    this.startFrame(pose, waves);
    this.sinHeading = Math.sin(pose.heading);
    this.cosHeading = Math.cos(pose.heading);
    const sp = Math.sin(pitch), cp = Math.cos(pitch);
    const sh = Math.sin(pose.heel), ch = Math.cos(pose.heel);
    this.forward = -Infinity;
    for (let i = 0; i <= this.stations; i++) {
      let wet = false;
      for (let j = 0; j < this.row; j++) {
        const index = i * this.row + j;
        const k = index * 3;
        const x = this.body[k]!, r = this.body[k + 1]!, z = this.body[k + 2]!;
        // Same order as boatMesh: heel, then pitch, then yaw. Pitch changes horizontal positions too.
        const up = ch * z - sh * r;
        const f = cp * x - sp * up;
        const side = ch * r + sh * z;
        const y = hullY + sp * x + cp * up;
        this.transformed[k] = f;
        this.transformed[k + 1] = side;
        this.transformed[k + 2] = y;
        this.gaps[index] = this.clearance(f, side, y, pose, waves, this.pointOffsets, index);
        wet ||= this.gaps[index]! <= 0;
      }
      if (!wet) continue;
      for (let j = 0; j < this.row; j++) {
        const index = i * this.row + j;
        if (i > 0 && this.gaps[index]! <= 0) this.consider(index - this.row, index, 2 * index, pose, waves);
        if (j > 0 && (this.gaps[index]! > 0) !== (this.gaps[index - 1]! > 0)) {
          this.consider(index - 1, index, 2 * index + 1, pose, waves);
        }
      }
      if (this.forward === -Infinity) {
        // The whole stem is submerged: it still displaces water at its leading horizontal position.
        const k = (i * this.row + (this.row - 1) / 2) * 3;
        this.forward = this.transformed[k]!;
        this.starboard = this.transformed[k + 1]!;
        this.height = this.transformed[k + 2]!;
      }
      return true;
    }
    return false;
  }
}
