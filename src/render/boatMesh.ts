/**
 * Placeholder boat: box hull, mast, boom, triangle sail, board and rudder.
 *
 * Body -> Three.js local mapping (used everywhere in render/):
 *   body +x (forward)   -> local -z
 *   body +y (starboard) -> local +x
 *   body +z (up)        -> local +y
 * With this mapping, `yaw.rotation.y = -heading` points the bow along the
 * compass heading (north = -z, east = +x), and `heel.rotation.z = -heel`
 * puts the starboard rail (+x) down for heel > 0.
 */
import * as THREE from 'three';
import type { BoatModel } from '../sim';

/** Body-frame point/vector -> Three.js boat-local vector. */
export function bodyToLocal(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(y, z, -x);
}

const FOIL_THICKNESS = 0.03; // TUNING GUESS: visual thickness of board/rudder boxes, m
const MAST_RADIUS = 0.035; // TUNING GUESS: visual mast radius, m
const BOOM_SIZE = 0.06; // TUNING GUESS: visual boom cross-section, m

export interface BoatMesh {
  /** Positioned at the boat in world x/z, rotation.y = -heading. */
  yaw: THREE.Group;
  /** Child of yaw, rotation.z = -heel. Everything heeling with the boat hangs here. */
  heel: THREE.Group;
  /** Boom pivot at the mast, rotation.y = +boom (boom points along local +z, aft; + swings it to +x, starboard). */
  boomPivot: THREE.Group;
}

export function createBoatMesh(boat: BoatModel): BoatMesh {
  const { hull, rig } = boat.cfg;
  const yaw = new THREE.Group();
  const heel = new THREE.Group();
  yaw.add(heel);

  const transomX = boat.xMast - rig.mastXFromTransom;
  const bowX = transomX + hull.loa;
  const hullHeight = boat.freeboard + boat.tc;

  const hullMesh = new THREE.Mesh(
    new THREE.BoxGeometry(hull.beam, hullHeight, hull.loa),
    new THREE.MeshStandardMaterial({ color: 0xf2f2ee }),
  );
  bodyToLocal((bowX + transomX) / 2, 0, (boat.freeboard - boat.tc) / 2, hullMesh.position);
  heel.add(hullMesh);

  const mastTop = boat.zBoom + rig.luff;
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(MAST_RADIUS, MAST_RADIUS, mastTop - boat.freeboard),
    new THREE.MeshStandardMaterial({ color: 0xb0b4b8 }),
  );
  bodyToLocal(boat.xMast, 0, (mastTop + boat.freeboard) / 2, mast.position);
  heel.add(mast);

  const boomPivot = new THREE.Group();
  bodyToLocal(boat.xMast, 0, boat.zBoom, boomPivot.position);
  heel.add(boomPivot);

  const boom = new THREE.Mesh(
    new THREE.BoxGeometry(BOOM_SIZE, BOOM_SIZE, rig.foot),
    new THREE.MeshStandardMaterial({ color: 0x9a9da0 }),
  );
  bodyToLocal(-rig.foot / 2, 0, 0, boom.position);
  boomPivot.add(boom);

  // Triangle sail in the boom pivot frame: tack at the mast, head up the mast, clew at the boom end.
  const sailGeom = new THREE.BufferGeometry();
  const tack = bodyToLocal(0, 0, 0);
  const head = bodyToLocal(0, 0, rig.luff);
  const clew = bodyToLocal(-rig.foot, 0, 0);
  sailGeom.setAttribute('position', new THREE.Float32BufferAttribute([...tack.toArray(), ...head.toArray(), ...clew.toArray()], 3));
  sailGeom.computeVertexNormals();
  const sail = new THREE.Mesh(
    sailGeom,
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
  );
  boomPivot.add(sail);

  const foilMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  for (const foil of [boat.board, boat.rudder]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(FOIL_THICKNESS, foil.span, foil.chord), foilMat);
    // Foil hangs from the hull bottom; its CP z is mid-span-ish, so centre the box at the CP.
    bodyToLocal(foil.x, 0, foil.z, mesh.position);
    heel.add(mesh);
  }

  return { yaw, heel, boomPivot };
}
