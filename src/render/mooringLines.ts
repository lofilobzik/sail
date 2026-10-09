import * as THREE from 'three';
import { createRope, type RopeView } from './rope';

// VISUAL ESTIMATE: dock ROPE colour (land/floatingDocks.ts), a dinghy dock line's radius, m, and its sag
// as a fraction of the span.
const COLOUR = 0x625649;
const RADIUS = 0.006;
const SAG = 0.06;
const POINTS = 7;

/** Cosmetic slack lines from boat anchors to shore anchors (world positions via getWorldPosition); no rope physics. */
export class MooringLines {
  readonly group = new THREE.Group();
  private readonly ropes: RopeView[];
  private readonly points = Array.from({ length: POINTS }, () => new THREE.Vector3());
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private used = 0;

  /** The group must stay at the scene root with an identity transform: lines are drawn in world space. */
  constructor(capacity: number) {
    this.group.name = 'mooring-lines';
    this.ropes = Array.from({ length: capacity }, () => {
      const rope = createRope(POINTS, COLOUR, RADIUS);
      rope.mesh.name = 'mooring-line';
      rope.mesh.visible = false;
      this.group.add(rope.mesh);
      return rope;
    });
  }

  /** Starts a frame: lines not added again before end() are hidden. */
  begin(): void {
    this.used = 0;
  }

  /** Draws the next line from `boat` to `shore`; beyond capacity it is skipped. */
  add(boat: THREE.Object3D, shore: THREE.Object3D): void {
    const rope = this.ropes[this.used];
    if (!rope) return;
    this.used++;
    // getWorldPosition refreshes each anchor's ancestor chain, so this frame's transforms are used.
    boat.getWorldPosition(this.from);
    shore.getWorldPosition(this.to);
    const sag = SAG * this.from.distanceTo(this.to);
    for (let k = 0; k < POINTS; k++) {
      const t = k / (POINTS - 1);
      const p = this.points[k]!.lerpVectors(this.from, this.to, t);
      p.y -= sag * 4 * t * (1 - t);
    }
    rope.update(this.points);
    rope.mesh.visible = true;
  }

  end(): void {
    for (let i = this.used; i < this.ropes.length; i++) this.ropes[i]!.mesh.visible = false;
  }
}
