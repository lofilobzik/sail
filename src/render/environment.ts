/** Minimal environment: gradient sky dome that follows the camera, and fixed buoys. */
import * as THREE from 'three';
import buoyData from '../data/buoys.json';

export const SKY_HORIZON = 0xcfe3f2; // visual estimate
const SKY_ZENITH = 0x5b93c9; // visual estimate
const SKY_RADIUS = 3000; // m, inside the camera far plane
const BUOY_SEGMENTS = 10;

/** Low-poly sphere coloured from horizon (and below) to zenith. Unlit, unfogged. */
export function createSky(): THREE.Mesh {
  const geom = new THREE.SphereGeometry(SKY_RADIUS, 16, 8);
  const pos = geom.getAttribute('position');
  const horizon = new THREE.Color(SKY_HORIZON);
  const zenith = new THREE.Color(SKY_ZENITH);
  const c = new THREE.Color();
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / SKY_RADIUS);
    c.copy(horizon).lerp(zenith, Math.sqrt(t));
    colors.push(c.r, c.g, c.b);
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const sky = new THREE.Mesh(geom, mat);
  sky.renderOrder = -1;
  return sky;
}

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
