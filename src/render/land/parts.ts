/** Vertex-coloured geometry parts merged into one draw call (trees, landmarks). */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Non-indexed copy of `geometry` with a uniform vertex colour (sRGB), transformed by `matrix`. */
export function paint(geometry: THREE.BufferGeometry, colour: THREE.ColorRepresentation, matrix?: THREE.Matrix4): THREE.BufferGeometry {
  const part = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  geometry.dispose();
  part.deleteAttribute('uv');
  if (matrix) part.applyMatrix4(matrix);
  const rgb = new THREE.Color(colour);
  const count = part.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colours.set([rgb.r, rgb.g, rgb.b], i * 3);
  part.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return part;
}

/** Merge painted parts into one geometry. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('land: incompatible geometry parts');
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}
