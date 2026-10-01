/**
 * Body frame -> Three.js boat-local mapping, used everywhere in render/:
 *   body +x (forward)   -> local -z
 *   body +y (starboard) -> local +x
 *   body +z (up)        -> local +y
 * With it, `yaw.rotation.y = -heading` points the bow along the compass heading
 * (north = -z, east = +x) and `heel.rotation.z = -heel` puts the starboard rail
 * (+x) down for heel > 0. The body frame (fwd, stbd, up) is left-handed, so this
 * mapping is a reflection: geometry built through it uses double-sided materials.
 */
import * as THREE from 'three';

/** Body-frame point/vector -> Three.js boat-local vector. */
export function bodyToLocal(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(y, z, -x);
}

const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

/** Places a unit cylinder (height 1 along +y, centred) between local points a and b. */
export function placeBetween(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  tmp.subVectors(b, a);
  const len = tmp.length();
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.scale.set(1, Math.max(len, 1e-6), 1);
  if (len > 1e-9) mesh.quaternion.setFromUnitVectors(UP, tmp.divideScalar(len));
}

/** Unit-height cylinder for placeBetween; radius in metres. */
export function rod(radius: number, material: THREE.Material, radialSegments = 6): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, radialSegments, 1), material);
}

/**
 * Maps every vertex of a geometry built in a convenient 2D/3D frame into boat-local
 * coordinates via `toBody` (returns body x, y, z), then recomputes normals.
 */
export function mapToBody(
  geom: THREE.BufferGeometry,
  toBody: (x: number, y: number, z: number) => [number, number, number],
): THREE.BufferGeometry {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const [bx, by, bz] = toBody(pos.getX(i), pos.getY(i), pos.getZ(i));
    bodyToLocal(bx, by, bz, v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}
