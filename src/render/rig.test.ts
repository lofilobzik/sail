import * as THREE from 'three';
import { expect, it } from 'vitest';
import details from '../../data/rig-details.json';
import { buildBoat } from '../sim/boat';
import { BoatLayout } from './boatLayout';
import { createHull } from './hull';
import { createRig } from './rig';

it('keeps both loose control tails above the actual deck and raised cockpit rim', () => {
  const layout = new BoatLayout(buildBoat());
  const root = new THREE.Group();
  const hull = createHull(layout);
  root.add(hull);
  const rig = createRig(layout, root, hull);
  rig.update(0.9);
  root.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  const centre = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
  const ray = new THREE.Raycaster();
  try {
    for (const name of ['cunningham-rope', 'vang-purchase']) {
      const rope = root.getObjectByName(name) as THREE.InstancedMesh;
      // The last two spans are the free tail leaving its cleat, not the loaded purchase.
      for (let span = rope.count - 2; span < rope.count; span++) {
        rope.getMatrixAt(span, matrix);
        for (let sample = 0; sample <= 16; sample++) {
          centre.set(0, sample / 16 - 0.5, 0).applyMatrix4(matrix).applyMatrix4(rope.matrixWorld);
          origin.copy(centre).addScaledVector(down, -1);
          ray.set(origin, down);
          const surface = ray.intersectObject(hull, true)[0];
          expect(surface, `${name} tail leaves the hull`).toBeDefined();
          expect(centre.y - details.rope.controlRadius, `${name} intersects deck/coaming`).toBeGreaterThanOrEqual(surface!.point.y - 1e-6);
        }
      }
    }
  } finally {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  }
});
