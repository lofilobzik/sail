/**
 * PLACEHOLDER SAIL (milestone 3). Replaced by the cloth sail in milestone 4: keep the
 * `SailView` interface and swap `createSail`.
 *
 * A static cambered surface in the boom-pivot frame (local +z aft along the boom, +y up,
 * +x to the pivot's starboard). Planform from the ILCA 7 MKI sail (rules p36): luff,
 * foot and leech lengths fix the triangle (and the mast rake, see BoatLayout), and the
 * luff-to-leech widths at 1/4, 1/2 and 3/4 leech add the roach. Camber depth and
 * position are visual estimates. The camber flips with the side the boom is on.
 */
import * as THREE from 'three';
import type { BoatLayout } from './boatLayout';

const SAIL_COLOR = 0xfbfbf6; // visual estimate: white Dacron
const SAIL_OPACITY = 0.88; // visual estimate

export interface SailView {
  object: THREE.Object3D;
  /** camber: -1 (belly to pivot -x) .. 1 (belly to pivot +x); 0 = flat. luffAmount 0..1 (unused by the placeholder). */
  update(camber: number, luffAmount: number): void;
}

/** Mean-line shape, 1 at chord fraction `pos`, 0 at both ends (NACA 4-digit style). */
function camberLine(c: number, pos: number): number {
  return c < pos ? (2 * pos * c - c * c) / (pos * pos) : (1 - 2 * pos + 2 * pos * c - c * c) / ((1 - pos) * (1 - pos));
}

function interp(xs: readonly number[], ys: readonly number[], x: number): number {
  let i = 0;
  while (i < xs.length - 2 && x > xs[i + 1]!) i++;
  const t = (x - xs[i]!) / (xs[i + 1]! - xs[i]!);
  return ys[i]! + t * (ys[i + 1]! - ys[i]!);
}

export function createSail(layout: BoatLayout): SailView {
  const { rig, visual } = layout.model.cfg;
  const s = visual.sail;
  const r = layout.mastRake;
  // Pivot-local 2D (aft, up): luff direction and the three corners.
  const luffDir = new THREE.Vector2(Math.sin(r), Math.cos(r));
  const head = luffDir.clone().multiplyScalar(rig.luff);
  const clew = new THREE.Vector2(rig.foot, 0);

  // Rows by leech fraction f (0 = clew, 1 = head): luff parameter and luff-to-leech width.
  const fKnots = [0, ...s.leechFracs, 1];
  const luffAt: number[] = [0];
  const width: number[] = [rig.foot];
  const dirs: THREE.Vector2[] = [new THREE.Vector2(1, 0)];
  s.leechFracs.forEach((f, i) => {
    const p = clew.clone().lerp(head, f);
    const t = p.dot(luffDir);
    luffAt.push(t);
    width.push(s.widths[i]!);
    dirs.push(p.clone().sub(luffDir.clone().multiplyScalar(t)).normalize());
  });
  luffAt.push(rig.luff);
  width.push(s.headWidth);
  dirs.push(new THREE.Vector2(Math.cos(r), -Math.sin(r)));

  const C = s.chordSegments;
  const H = s.heightSegments;
  const base: number[] = []; // flat positions (x = 0 plane)
  const amp: number[] = []; // camber amplitude per vertex
  for (let k = 0; k <= H; k++) {
    const f = k / H;
    const t = interp(fKnots, luffAt, f);
    const w = interp(fKnots, width, f);
    const seg = Math.min(Math.floor(f * (fKnots.length - 1)), fKnots.length - 2);
    const local = (f - fKnots[seg]!) / (fKnots[seg + 1]! - fKnots[seg]!);
    const dir = dirs[seg]!.clone().lerp(dirs[seg + 1]!, local).normalize();
    const luffPt = luffDir.clone().multiplyScalar(t);
    for (let i = 0; i <= C; i++) {
      const c = i / C;
      const p = luffPt.clone().add(dir.clone().multiplyScalar(c * w));
      base.push(0, p.y, p.x); // (x across, y up, z aft)
      amp.push(s.camberDepthFrac * w * camberLine(c, s.camberPosFrac));
    }
  }
  const idx: number[] = [];
  for (let k = 0; k < H; k++) {
    for (let i = 0; i < C; i++) {
      const a = k * (C + 1) + i;
      const b = a + C + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geom = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(base.slice(), 3);
  geom.setAttribute('position', position);
  geom.setIndex(idx);
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({ color: SAIL_COLOR, side: THREE.DoubleSide, transparent: true, opacity: SAIL_OPACITY, roughness: 0.9 }),
  );

  let last = Number.NaN;
  return {
    object: mesh,
    update(camber) {
      if (camber === last) return;
      last = camber;
      for (let i = 0; i < amp.length; i++) position.setX(i, camber * amp[i]!);
      position.needsUpdate = true;
      geom.computeVertexNormals();
      geom.computeBoundingSphere();
    },
  };
}
