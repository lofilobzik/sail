/** Minimal environment: fixed buoys. The sky lives in sky.ts. */
import * as THREE from 'three';
import buoyData from '../data/buoys.json';

const BUOY_SEGMENTS = 10;

/** Spar buoys (cylinder + cone top) at fixed world positions from data/buoys.json. */
export function createBuoys(): THREE.Group {
  const g = new THREE.Group();
  const { radius, height } = buoyData;
  const body = new THREE.CylinderGeometry(radius * 0.8, radius, height * 0.6, BUOY_SEGMENTS);
  const top = new THREE.ConeGeometry(radius * 0.8, height * 0.4, BUOY_SEGMENTS);
  for (const b of buoyData.buoys) {
    const mat = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.6 });
    const base = new THREE.Mesh(body, mat);
    base.position.set(b.x, height * 0.3, b.z);
    const cone = new THREE.Mesh(top, mat);
    cone.position.set(b.x, height * 0.8, b.z);
    g.add(base, cone);
  }
  return g;
}
