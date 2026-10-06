/**
 * Other players' boats: one BoatMesh per remote boat, created on its first appearance and disposed
 * when it leaves. Each is placed at its interpolated logical position through the floating origin,
 * heaved by the water drawn this frame, and driven like the own boat: heel, pitch, boom, rudder,
 * crew, and cloth from its apparent wind and luff. No wake in v1. Reads state only.
 *
 * The cloth simulation is most of a boat's per-frame cost, so only the nearest few remote sails
 * move every frame; the others take turns (one per frame) and otherwise keep their shape, still
 * swung by the boom.
 */
import * as THREE from 'three';
import { DEG, type BoatModel, type Vec2 } from '../sim';
import { createWaveSample, sampleWaves, waveAmplitude, type WaveConfig } from '../sim/waves';
import type { RemotePose } from '../net/remote';
import { createBoatMesh, type BoatMesh, type BoatPose } from './boatMesh';

/** Remote sails simulated per frame, nearest first. */
const CLOTH_BOATS = 4; // TUNING GUESS: about 0.6 ms of cloth each on a laptop
/** Beyond this the sail is a few dozen pixels tall and its cloth is not simulated, m. */
const CLOTH_RANGE = 150; // VISUAL ESTIMATE

interface RemoteBoatView {
  mesh: BoatMesh;
  /** Squared distance from the own boat this frame, m². */
  distanceSq: number;
  cloth: boolean;
}

const byDistance = (a: RemoteBoatView, b: RemoteBoatView): number => a.distanceSq - b.distanceSq;

export class RemoteBoatsView {
  readonly group = new THREE.Group();
  private readonly boats = new Map<number, RemoteBoatView>();
  /** Scratch list for the nearest-sail choice, reused every frame. */
  private readonly nearest: RemoteBoatView[] = [];
  /** Which of the farther sails moves this frame. */
  private turn = 0;
  private readonly surface = createWaveSample();
  private readonly pose: BoatPose = {
    heel: 0, pitch: 0, boom: 0, rudderAngle: 0, sheet: 0, crewY: 0,
    apparentU: 0, apparentV: 0, luffAmount: 0, stallAmount: 0, dt: 0,
  };

  constructor(private readonly model: BoatModel) {}

  /** Boats drawn. */
  get count(): number {
    return this.boats.size;
  }

  /**
   * Draws `remotes` for one frame: render-local around `origin` (the own boat), on the water at
   * time `t` (the time the water is drawn at), near sails advanced by `dt`. Boats missing from
   * `remotes` are removed.
   */
  update(remotes: ReadonlyMap<number, RemotePose>, origin: Readonly<Vec2>, waves: WaveConfig, t: number, dt: number): void {
    for (const [id, boat] of this.boats) {
      if (remotes.has(id)) continue;
      this.group.remove(boat.mesh.yaw);
      dispose(boat.mesh.yaw);
      this.boats.delete(id);
    }

    const nearest = this.nearest;
    nearest.length = 0;
    for (const [id, r] of remotes) {
      let boat = this.boats.get(id);
      if (!boat) {
        const mesh = createBoatMesh(this.model);
        // The first-person forearms and hands have no body: from outside they would float.
        mesh.sailor.setArmsVisible(false);
        boat = { mesh, distanceSq: 0, cloth: false };
        this.boats.set(id, boat);
        this.group.add(mesh.yaw);
      }
      boat.distanceSq = (r.x - origin.x) ** 2 + (r.z - origin.z) ** 2;
      boat.cloth = false;
      nearest.push(boat);
    }
    nearest.sort(byDistance);
    const near = Math.min(CLOTH_BOATS, nearest.length);
    for (let i = 0; i < near; i++) nearest[i]!.cloth = nearest[i]!.distanceSq <= CLOTH_RANGE * CLOTH_RANGE;
    // The rest take turns, one per frame, so a far sail still settles into its shape, only slowly.
    if (nearest.length > near) nearest[near + (this.turn++ % (nearest.length - near))]!.cloth = true;

    const wavesActive = waveAmplitude(waves) !== 0;
    const maxRudder = this.model.cfg.rudder.maxAngleDeg * DEG;
    const p = this.pose;
    for (const [id, r] of remotes) {
      const boat = this.boats.get(id)!;
      const mesh = boat.mesh;
      sampleWaves(waves, r.x, r.z, t, 0, this.surface);
      mesh.yaw.position.set(r.x - origin.x, this.surface.y, r.z - origin.z);
      mesh.yaw.rotation.y = -r.heading;
      p.heel = r.heel;
      p.pitch = wavesActive ? r.pitch : 0;
      p.boom = r.boom;
      p.rudderAngle = r.tiller * maxRudder;
      p.sheet = r.sheet;
      p.crewY = r.crewY;
      p.apparentU = r.apparentU;
      p.apparentV = r.apparentV;
      p.luffAmount = r.luffAmount;
      p.stallAmount = r.stallAmount;
      p.dt = boat.cloth ? dt : 0; // a zero step leaves the cloth as it is
      mesh.update(p);
    }
  }
}

/** Frees the GPU side of a boat that left: geometries, materials and their textures (the sail paint). */
function dispose(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points)) return;
    (o.geometry as THREE.BufferGeometry).dispose();
    const materials: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
      m.dispose();
    }
  });
}
