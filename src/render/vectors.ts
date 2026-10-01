/** Debug arrows for wind and forces (THREE.ArrowHelper). Reads diagnostics only. */
import * as THREE from 'three';
import type { BoatModel, Diagnostics } from '../sim';
import { bodyToLocal } from './bodyFrame';

const METERS_PER_NEWTON = 1 / 50; // TUNING GUESS: force arrow length, 1 m per 50 N
const METERS_PER_MPS = 1 / 2; // TUNING GUESS: wind arrow length, 1 m per 2 m/s
const MIN_ARROW = 0.02; // TUNING GUESS: hide arrows shorter than this, m

/** Overlay groups that own arrows. */
export interface ArrowVisibility {
  L1: boolean;
  L2: boolean;
  L3: boolean;
  L4: boolean;
}

function arrow(color: number): THREE.ArrowHelper {
  const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, color);
  a.visible = false;
  return a;
}

export class ForceVectors {
  private readonly trueWind = arrow(0x00c8ff);
  private readonly apparent = arrow(0xffff00);
  private readonly sail = arrow(0xff3030);
  private readonly board = arrow(0x30ff30);
  private readonly rudder = arrow(0x30ffb0);
  private readonly hull = arrow(0xff9900);
  private readonly dir = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly mastTop: number;

  constructor(
    private readonly model: BoatModel,
    scene: THREE.Scene,
    boatYaw: THREE.Object3D,
    boatHeel: THREE.Object3D,
  ) {
    this.mastTop = model.zBoom + model.cfg.rig.luff;
    scene.add(this.trueWind);
    // Apparent wind is horizontal in the body frame, so it hangs on the unheeled yaw group.
    boatYaw.add(this.apparent);
    boatHeel.add(this.sail, this.board, this.rudder, this.hull);
  }

  hideAll(): void {
    for (const a of [this.trueWind, this.apparent, this.sail, this.board, this.rudder, this.hull]) a.visible = false;
  }

  /** Boat position is render-local; diagnostics and wind directions remain logical-world. */
  update(d: Diagnostics, boatPosition: Readonly<THREE.Vector3>, show: ArrowVisibility): void {
    const m = this.model;
    this.origin.set(boatPosition.x, boatPosition.y + this.mastTop, boatPosition.z);
    this.place(this.trueWind, show.L1, this.dir.set(d.trueWind.x, 0, d.trueWind.z), METERS_PER_MPS);

    bodyToLocal(m.xMast, 0, this.mastTop, this.origin);
    this.place(this.apparent, show.L1, bodyToLocal(d.apparent.u, d.apparent.v, 0, this.dir), METERS_PER_MPS);

    const s = d.sail;
    if (s) bodyToLocal(s.ce.x, s.ce.y, s.ce.z, this.origin);
    this.place(this.sail, show.L2 && s !== null, s && bodyToLocal(s.fx, s.fy, 0, this.dir), METERS_PER_NEWTON);

    const f = d.foils;
    bodyToLocal(m.board.x, 0, m.board.z, this.origin);
    this.place(this.board, show.L3 && f !== null, f && bodyToLocal(f.board.fx, f.board.fy, 0, this.dir), METERS_PER_NEWTON);
    bodyToLocal(m.rudder.x, 0, m.rudder.z, this.origin);
    this.place(this.rudder, show.L3 && f !== null, f && bodyToLocal(f.rudder.fx, f.rudder.fy, 0, this.dir), METERS_PER_NEWTON);

    const h = d.hull;
    this.origin.set(0, 0, 0);
    this.place(this.hull, show.L4 && h !== null, h && bodyToLocal(h.fx, h.fy, 0, this.dir), METERS_PER_NEWTON);
  }

  /** Sets an arrow from `this.origin` along `vec` (length scaled); hides it if off or too short. */
  private place(a: THREE.ArrowHelper, on: boolean, vec: THREE.Vector3 | null, scale: number): void {
    const len = vec ? vec.length() * scale : 0;
    a.visible = on && len >= MIN_ARROW;
    if (!a.visible || !vec) return;
    a.position.copy(this.origin);
    a.setDirection(vec.normalize());
    a.setLength(len, Math.min(0.3, len * 0.3), Math.min(0.15, len * 0.15)); // TUNING GUESS head sizes
  }
}
