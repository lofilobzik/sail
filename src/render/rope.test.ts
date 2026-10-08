import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createRope } from './rope';

function segmentVertices(mesh: THREE.InstancedMesh, index: number): THREE.Vector3[] {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const positions = mesh.geometry.getAttribute('position');
  return Array.from({ length: positions.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(matrix));
}

describe('round rigging ropes', () => {
  it('keeps its diameter and endpoints when a span is stretched, reversed or tilted', () => {
    const radius = 0.01;
    const rope = createRope(2, '#ffffff', radius);
    const a = new THREE.Vector3(2, 1, -3);
    try {
      for (const b of [new THREE.Vector3(2, 4, -3), new THREE.Vector3(2, -4, -3), new THREE.Vector3(-3, 2, 1)]) {
        rope.update([a, b]);
        const direction = b.clone().sub(a).normalize();
        const length = a.distanceTo(b);
        const vertices = segmentVertices(rope.mesh, 0);
        const along = vertices.map((v) => v.clone().sub(a).dot(direction));
        const radii = vertices.map((v, i) => v.distanceTo(a.clone().addScaledVector(direction, along[i]!)));
        expect(Math.min(...along)).toBeCloseTo(0, 5);
        expect(Math.max(...along)).toBeCloseTo(length, 5);
        expect(Math.max(...radii)).toBeCloseTo(radius, 5);
        for (const v of vertices) expect(v.distanceTo(rope.mesh.boundingSphere!.center)).toBeLessThanOrEqual(rope.mesh.boundingSphere!.radius + 1e-6);
      }
    } finally {
      rope.mesh.geometry.dispose();
      (rope.mesh.material as THREE.Material).dispose();
    }
  });

  it('collapses coincident spans completely, then restores them when their ends separate', () => {
    const rope = createRope(3, '#ffffff', 0.01);
    const a = new THREE.Vector3(1, 2, 3), b = a.clone(), c = new THREE.Vector3(5, 2, 3);
    try {
      rope.update([a, b, c]);
      for (const v of segmentVertices(rope.mesh, 0)) expect(v.distanceTo(a)).toBeCloseTo(0, 6);
      b.set(3, 2, 3);
      rope.update([a, b, c]);
      const vertices = segmentVertices(rope.mesh, 0);
      expect(Math.min(...vertices.map((v) => v.x))).toBeCloseTo(a.x, 6);
      expect(Math.max(...vertices.map((v) => v.x))).toBeCloseTo(b.x, 6);
      expect(Math.max(...vertices.map((v) => Math.hypot(v.y - a.y, v.z - a.z)))).toBeCloseTo(0.01, 6);
    } finally {
      rope.mesh.geometry.dispose();
      (rope.mesh.material as THREE.Material).dispose();
    }
  });
});
