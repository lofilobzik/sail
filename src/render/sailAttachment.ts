import * as THREE from 'three';
import construction from '../../data/sail-construction.json';

/** Small matte fittings in the boom frame; all GPU resources are owned by this boat. */
export function createSailAttachment(boomRadius: number): {
  object: THREE.Group;
  update(clew: readonly [number, number, number]): void;
} {
  const cfg = construction.attachment;
  const object = new THREE.Group();
  object.name = 'sail-clew-attachment';
  const eye = new THREE.Mesh(
    new THREE.TorusGeometry(cfg.eyeRadius, cfg.eyeTubeRadius, 5, 10),
    new THREE.MeshStandardMaterial({ color: cfg.eyeColour, roughness: 0.86, metalness: 0.12 }),
  );
  eye.name = 'clew-eye';
  eye.rotation.y = Math.PI / 2; // eye opening lies in the cloth's yz plane
  object.add(eye);

  // A ribbon webbing loop passes through the eye and wraps the boom, not a solid floating ring.
  const segments = 12;
  const points = new Float32Array((segments + 1) * 3);
  const positions = new Float32Array((segments + 1) * 6);
  const normals = new Float32Array(positions.length);
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const normal = new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setIndex(indices);
  const strap = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: cfg.strapColour, roughness: 0.98, side: THREE.DoubleSide,
  }));
  strap.name = 'clew-boom-tie-down';
  strap.frustumCulled = false;
  object.add(strap);

  return {
    object,
    update(clew) {
      eye.position.set(clew[0], clew[1] + cfg.eyeLift, clew[2] - cfg.eyeInset);
      const r = boomRadius + cfg.strapClearance;
      // The upper half climbs to the moving cloth eye; the lower half stays around the spar.
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const cos = Math.cos(angle);
        const upper = Math.max(0, cos);
        points[i * 3] = r * Math.sin(angle) + eye.position.x * upper;
        points[i * 3 + 1] = r * cos + (eye.position.y - r) * upper;
        points[i * 3 + 2] = clew[2] + (eye.position.z - clew[2]) * upper;
      }
      for (let i = 0; i <= segments; i++) {
        const prev = (i === 0 ? segments - 1 : i - 1) * 3;
        const next = (i === segments ? 1 : i + 1) * 3;
        const dx = points[next]! - points[prev]!;
        const dy = points[next + 1]! - points[prev + 1]!;
        const len = Math.hypot(dx, dy) || 1;
        const p = i * 3;
        const v = i * 6;
        for (let side = 0; side < 2; side++) {
          const o = v + side * 3;
          positions[o] = points[p]!;
          positions[o + 1] = points[p + 1]!;
          positions[o + 2] = points[p + 2]! + (side === 0 ? -1 : 1) * cfg.strapWidth / 2;
          normals[o] = -dy / len;
          normals[o + 1] = dx / len;
          normals[o + 2] = 0;
        }
      }
      position.needsUpdate = true;
      normal.needsUpdate = true;
    },
  };
}
