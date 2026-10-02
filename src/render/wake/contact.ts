/** Render-only intersection of the lofted hull with the undisturbed local sea. No Three.js. */
import { createWaveSample, sampleWaves, type WaveConfig } from '../../sim/waves';
import type { BoatLayout } from '../boatLayout';

export interface ContactPose {
  x: number;
  z: number;
  heading: number;
  pitch: number;
  heel: number;
  t: number;
}

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

  constructor(layout: BoatLayout, private readonly stations: number) {
    const p = layout.model.cfg.visual.sectionPoints;
    this.row = 2 * p + 1;
    const count = (stations + 1) * this.row;
    this.body = new Float64Array(count * 3);
    this.transformed = new Float64Array(count * 3);
    this.gaps = new Float64Array(count);
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

  private clearance(f: number, r: number, y: number, pose: ContactPose, waves: WaveConfig): number {
    const x = pose.x + this.sinHeading * f + this.cosHeading * r;
    const z = pose.z - this.cosHeading * f + this.sinHeading * r;
    sampleWaves(waves, x, z, pose.t, 0, this.surface);
    return y - this.surface.y;
  }

  private consider(a: number, b: number, pose: ContactPose, waves: WaveConfig): void {
    const points = this.transformed;
    const ka = a * 3, kb = b * 3;
    const af = points[ka]!, ar = points[ka + 1]!, ay = points[ka + 2]!;
    const df = points[kb]! - af, dr = points[kb + 1]! - ar, dy = points[kb + 2]! - ay;
    let lo = 0, hi = 1;
    const aDry = this.gaps[a]! > 0;
    // Numerical root refinement, not a physics coefficient: 14 halvings of a sampled edge.
    for (let i = 0; i < 14; i++) {
      const t = (lo + hi) / 2;
      if ((this.clearance(af + df * t, ar + dr * t, ay + dy * t, pose, waves) > 0) === aDry) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2;
    const f = af + df * t;
    if (f > this.forward) {
      this.forward = f;
      this.starboard = ar + dr * t;
      this.height = ay + dy * t;
    }
  }

  /** Search bow to transom; false only when the sampled hull is entirely above the sea. */
  update(pose: ContactPose, waves: WaveConfig, hullY: number, pitch = pose.pitch): boolean {
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
        this.gaps[index] = this.clearance(f, side, y, pose, waves);
        wet ||= this.gaps[index]! <= 0;
      }
      if (!wet) continue;
      for (let j = 0; j < this.row; j++) {
        const index = i * this.row + j;
        if (i > 0 && this.gaps[index]! <= 0) this.consider(index - this.row, index, pose, waves);
        if (j > 0 && (this.gaps[index]! > 0) !== (this.gaps[index - 1]! > 0)) {
          this.consider(index - 1, index, pose, waves);
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
