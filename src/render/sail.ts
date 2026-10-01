/**
 * Sail view (milestone 4): Verlet cloth plus telltales, visual only. The cloth and
 * telltale math lives in ./cloth (no Three.js, unit-tested); this file turns it into
 * meshes in the boom frame (x across, y up, z aft along the boom, origin at the tack).
 *
 * Telltales: luff pairs on both sides (green = boom-frame +x side, red = -x side) and
 * leech ribbons. The windward luff telltale lifts with luffAmount, the leeward one with
 * stallAmount, the leech ribbons with whichever is larger.
 */
import * as THREE from 'three';
import { Cloth } from './cloth/cloth';
import { buildPlanform } from './cloth/planform';
import { telltalePoints, type V3 } from './cloth/telltale';
import type { BoatLayout } from './boatLayout';

const SAIL_COLOR = 0xfbfbf6; // visual estimate: white Dacron
const SAIL_OPACITY = 0.72; // visual estimate: translucent enough to see the leeward telltales through the cloth
const GREEN = new THREE.Color(0x19c43c); // visual estimate: starboard-side telltale
const RED = new THREE.Color(0xe0262a); // visual estimate: port-side telltale
const LEECH = new THREE.Color(0xff8a00); // visual estimate: leech ribbon
const LEEWARD_GAIN = 5; // wind x-component that counts as fully on one side

export interface SailInput {
  dt: number;
  luffAmount: number;
  stallAmount: number;
  /** Unit apparent flow direction in the boom frame. */
  windDir: THREE.Vector3;
  apparentSpeed: number;
}

export interface SailView {
  object: THREE.Object3D;
  update(input: SailInput): void;
}

interface Telltale {
  c: number;
  h: number;
  /** +1 / -1: side of the sail (boom-frame x); 0: leech ribbon. */
  side: number;
  phase: number;
}

export function createSail(layout: BoatLayout): SailView {
  const { rig, visual } = layout.model.cfg;
  const s = visual.sail;
  const planform = buildPlanform({
    luff: rig.luff,
    foot: rig.foot,
    rake: layout.mastRake,
    leechFracs: s.leechFracs,
    widths: s.widths,
    headWidth: s.headWidth,
    camberDepthFrac: s.camberDepthFrac,
    camberPosFrac: s.camberPosFrac,
    cols: s.chordPoints,
    rows: s.heightPoints,
  });
  const cloth = new Cloth(planform, visual.cloth);
  const group = new THREE.Group();

  // Cloth mesh shares the cloth's position buffer layout.
  const { cols, rows } = planform;
  const geom = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(cloth.positions, 3);
  position.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', position);
  const idx: number[] = [];
  for (let k = 0; k < rows - 1; k++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = k * cols + i;
      const b = a + cols;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  geom.setIndex(idx);
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({ color: SAIL_COLOR, side: THREE.DoubleSide, transparent: true, opacity: SAIL_OPACITY, roughness: 0.9 }),
  );
  mesh.frustumCulled = false; // bounds change every frame
  group.add(mesh);

  // Telltales: one ribbon mesh for all of them (single draw call).
  const tt = visual.telltales;
  const tells: Telltale[] = [];
  tt.luff.forEach(([c, h], i) => {
    tells.push({ c: c!, h: h!, side: 1, phase: i * 1.7 }, { c: c!, h: h!, side: -1, phase: i * 1.7 + 2.3 });
  });
  tt.leech.forEach(([c, h], i) => tells.push({ c: c!, h: h!, side: 0, phase: i * 2.9 + 0.5 }));
  const seg = tt.segments;
  const perTell = (seg + 1) * 2;
  const ribbonPos = new Float32Array(tells.length * perTell * 3);
  const ribbonCol = new Float32Array(tells.length * perTell * 3);
  const ribbonIdx: number[] = [];
  tells.forEach((t, n) => {
    const color = t.side > 0 ? GREEN : t.side < 0 ? RED : LEECH;
    for (let j = 0; j < perTell; j++) color.toArray(ribbonCol, (n * perTell + j) * 3);
    for (let j = 0; j < seg; j++) {
      const a = n * perTell + j * 2;
      ribbonIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const ribbonGeom = new THREE.BufferGeometry();
  const ribbonAttr = new THREE.BufferAttribute(ribbonPos, 3).setUsage(THREE.DynamicDrawUsage);
  ribbonGeom.setAttribute('position', ribbonAttr);
  ribbonGeom.setAttribute('color', new THREE.BufferAttribute(ribbonCol, 3));
  ribbonGeom.setIndex(ribbonIdx);
  const ribbons = new THREE.Mesh(ribbonGeom, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  ribbons.frustumCulled = false;
  group.add(ribbons);

  const chain = new Float32Array((seg + 1) * 3);
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  let time = 0;
  const windDir: [number, number, number] = [0, 0, 1];
  const cv = visual.cloth;

  return {
    object: group,
    update(input) {
      time += input.dt;
      const leeward = Math.max(-1, Math.min(1, input.windDir.x * LEEWARD_GAIN));
      windDir[0] = input.windDir.x;
      windDir[1] = input.windDir.y;
      windDir[2] = input.windDir.z;
      const windScale = Math.min((input.apparentSpeed / cv.referenceAws) ** 2, cv.maxWindScale);
      cloth.update({ dt: input.dt, leeward, fill: 1 - input.luffAmount, luff: input.luffAmount, windDir, windScale });
      position.needsUpdate = true;
      geom.computeVertexNormals();

      tells.forEach((t, n) => {
        // Surface tangent toward the leech at the attachment point.
        const back = t.c > 0.9 ? 0.08 : 0;
        cloth.sample(t.c - back, t.h, a);
        cloth.sample(t.c - back + 0.08, t.h, b);
        const stream = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        cloth.sample(t.c, t.h, a);
        const sideSign = t.side !== 0 ? t.side : leeward >= 0 ? 1 : -1;
        const leewardSide = t.side === 0 || sideSign * leeward > 0;
        const lift = t.side === 0 ? Math.max(input.stallAmount, input.luffAmount) : leewardSide ? input.stallAmount : input.luffAmount;
        const base: V3 = [a[0] + sideSign * tt.surfaceOffset, a[1], a[2]];
        telltalePoints(base, { stream, away: [sideSign, 0, 0], lift, time, phase: t.phase, segmentLength: tt.length / seg }, seg, chain);
        for (let j = 0; j <= seg; j++) {
          // Ribbon width across the segment, in the sail plane (perpendicular to boom-frame x).
          const j0 = Math.max(j - 1, 0) * 3;
          const j1 = Math.max(j, 1) * 3;
          const dy = chain[j1 + 1]! - chain[j0 + 1]!;
          const dz = chain[j1 + 2]! - chain[j0 + 2]!;
          const len = Math.hypot(dy, dz) || 1;
          const wy = (dz / len) * (tt.width / 2);
          const wz = (-dy / len) * (tt.width / 2);
          const o = (n * perTell + j * 2) * 3;
          ribbonPos[o] = chain[j * 3]!;
          ribbonPos[o + 1] = chain[j * 3 + 1]! + wy;
          ribbonPos[o + 2] = chain[j * 3 + 2]! + wz;
          ribbonPos[o + 3] = chain[j * 3]!;
          ribbonPos[o + 4] = chain[j * 3 + 1]! - wy;
          ribbonPos[o + 5] = chain[j * 3 + 2]! - wz;
        }
      });
      ribbonAttr.needsUpdate = true;
    },
  };
}

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
