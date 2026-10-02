/** Minimal environment: fixed buoys. The sky lives in sky.ts. */
import * as THREE from 'three';
import buoyData from '../data/buoys.json';

const BUOY_SEGMENTS = 10;

/** Distinct sandbox buoys with physical painted IDs and matching chart topmarks. */
export function createBuoys(): THREE.Group {
  const g = new THREE.Group();
  const { radius, height } = buoyData;
  const body = new THREE.CylinderGeometry(radius * 0.8, radius, height * 0.6, BUOY_SEGMENTS);
  for (const b of buoyData.buoys) {
    const buoy = new THREE.Group();
    buoy.name = b.name;
    buoy.position.set(b.x, 0, b.z);
    const mat = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.6 });
    const base = new THREE.Mesh(body, mat);
    base.position.y = height * 0.3;
    buoy.add(base);
    // All proportions and typography below are VISUAL ESTIMATE, not class/IALA dimensions.
    const mark = new THREE.Group();
    mark.position.y = height * 0.8;
    const cone = () => new THREE.Mesh(new THREE.ConeGeometry(radius * 0.7, height * 0.4, BUOY_SEGMENTS), mat);
    if (b.topmark === 'sphere') mark.add(new THREE.Mesh(new THREE.SphereGeometry(radius * 0.6, BUOY_SEGMENTS, 8), mat));
    else if (b.topmark === 'cylinder') mark.add(new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, height * 0.4, BUOY_SEGMENTS), mat));
    else if (b.topmark === 'cross') {
      const vertical = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.3, height * 0.5, radius * 0.3), mat);
      const horizontal = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.1, height * 0.12, radius * 0.3), mat);
      const across = horizontal.clone(); across.rotation.y = Math.PI / 2;
      mark.add(vertical, horizontal, across);
    } else if (b.topmark === 'doubleCone') {
      const top = cone(), bottom = cone();
      top.scale.y = bottom.scale.y = 0.6;
      top.position.y = height * 0.12;
      bottom.position.y = -height * 0.12;
      bottom.rotation.z = Math.PI;
      mark.add(top, bottom);
    } else mark.add(cone());
    buoy.add(mark);

    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f0ead9'; ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#253633'; ctx.font = 'bold 90px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) ctx.fillText(b.name, i * 128 + 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Follow the tapered body, with a tiny outward offset so the paint never disappears inside it.
    const bandTop = radius * (1 - 0.2 * 0.52 / 0.6) + 0.002;
    const bandBottom = radius * (1 - 0.2 * 0.34 / 0.6) + 0.002;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(bandTop, bandBottom, height * 0.18, BUOY_SEGMENTS, 1, true), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7 }));
    band.position.y = height * 0.43;
    buoy.add(band);
    g.add(buoy);
  }
  return g;
}
