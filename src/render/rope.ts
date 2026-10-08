import * as THREE from 'three';
import details from '../../data/rig-details.json';
import { faceted } from './land/parts';

export interface RopeView {
  mesh: THREE.InstancedMesh;
  /** Supply the fixed number of boat-local control points declared at construction. */
  update(points: readonly THREE.Vector3[]): void;
}

/**
 * One capped six-sided cylinder per adjacent pair, submitted in one draw call.
 * Each rope owns its geometry, material and instance buffer for boat disposal.
 * Control points determine the path; this view supplies no rope dynamics or sag.
 */
export function createRope(points: number, colour: THREE.ColorRepresentation, radius: number): RopeView {
  const segments = points - 1;
  // VISUAL ESTIMATE: tessellation comes from rig-details; matte rope finish is not measured.
  const cylinder = new THREE.CylinderGeometry(radius, radius, 1, details.rope.radialSegments, 1);
  const geometry = cylinder.toNonIndexed();
  cylinder.dispose();
  geometry.deleteAttribute('uv');
  faceted(geometry);
  const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geometry, material, segments);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Identity instance matrices would otherwise show unit-height cylinders before the first update.
  mesh.count = 0;
  const bounds = new THREE.Sphere(new THREE.Vector3(), 0);
  mesh.boundingSphere = bounds;

  const up = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();

  function update(path: readonly THREE.Vector3[]): void {
    const first = path[0]!;
    let minX = first.x;
    let minY = first.y;
    let minZ = first.z;
    let maxX = first.x;
    let maxY = first.y;
    let maxZ = first.z;
    for (let i = 0; i < segments; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      direction.subVectors(b, a);
      const length = direction.length();
      position.copy(a).addScaledVector(direction, 0.5);
      if (length > 0) {
        rotation.setFromUnitVectors(up, direction.divideScalar(length));
        // Radius is baked into the geometry: only its unit-height axis is stretched.
        scale.set(1, length, 1);
      } else {
        // Collapse caps as well as sides; retain neither a visible disc nor stale rotation.
        rotation.identity();
        scale.set(0, 0, 0);
      }
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(i, matrix);

      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      minZ = Math.min(minZ, b.z);
      maxX = Math.max(maxX, b.x);
      maxY = Math.max(maxY, b.y);
      maxZ = Math.max(maxZ, b.z);
    }
    // Every segment lies inside the endpoint box, expanded by the fixed rope radius.
    // Keep this in mesh-local coordinates: Three applies the boat's world transform for culling.
    bounds.center.set(minX + (maxX - minX) * 0.5, minY + (maxY - minY) * 0.5, minZ + (maxZ - minZ) * 0.5);
    bounds.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 + radius;
    mesh.count = segments;
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { mesh, update };
}
