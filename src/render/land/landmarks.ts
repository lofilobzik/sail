/**
 * The four bearing landmarks (data/bay.json `landmarks`, sim/terrain.ts LANDMARKS), each standing
 * on its `base` with total height `height`, in its own `color`/`band`. Silhouettes are chosen to
 * read apart at several km: a white lighthouse with a red band and lantern, a church (nave plus
 * tall steeple), a squat crenellated stone tower and a thin red/white banded mast with stays.
 * All landmarks are one merged vertex-coloured mesh plus one line set for the stays.
 * Proportions are VISUAL ESTIMATE from typical structures of each kind.
 */
import * as THREE from 'three';
import { LANDMARKS, type Landmark, type TerrainGrid } from '../../sim/terrain';
import { groundHeight } from './ground';
import { merge, paint } from './parts';

const FOOTING = 4; // m: foundations run this far below `base`, so a slope never shows a gap
const STONE_GREY = 0xb3aea3; // plinths and footings
const IRON = 0x34383b; // gallery and railings
const STAY = 0x9a9ea2; // galvanised guy wires: 1 px lines, kept light so the mast, not the stays, reads
const LANTERN_GLASS = 0xf3ead0;
const SEGMENTS = 16; // round structures

const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

/** Vertical frustum from y0 to y1 (relative to the landmark foot). */
function drum(r0: number, r1: number, y0: number, y1: number, colour: THREE.ColorRepresentation, segments = SEGMENTS): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(r1, r0, y1 - y0, segments), colour, at(0, (y0 + y1) / 2, 0));
}

function lighthouse(l: Landmark): THREE.BufferGeometry[] {
  const h = l.height, top = 0.74 * h;
  const rAt = (y: number) => 3.0 + (2.1 - 3.0) * (y / top); // tapered tower radius
  return [
    drum(4.2, 4.2, -FOOTING, 1.0, STONE_GREY),
    drum(rAt(0), rAt(top), 0, top, l.color),
    // The red band: a slightly proud ring on the middle of the shaft.
    drum(rAt(0.4 * top) + 0.04, rAt(0.62 * top) + 0.04, 0.4 * top, 0.62 * top, l.band),
    drum(3.1, 3.1, top, top + 0.5, IRON),
    drum(1.6, 1.6, top + 0.5, 0.9 * h, LANTERN_GLASS),
    drum(3.0, 3.0, top + 0.5, top + 1.4, IRON, SEGMENTS), // gallery railing (solid at range)
    paint(new THREE.ConeGeometry(1.9, 0.1 * h, SEGMENTS), l.band, at(0, 0.95 * h, 0)),
  ];
}

function church(l: Landmark): THREE.BufferGeometry[] {
  const h = l.height, wall = l.color, slate = l.band;
  const towerTop = 0.5 * h, side = 6.5, naveLength = 22, naveWidth = 9.5, naveWall = 9;
  // The steeple stands on the landmark point; the nave runs east (+x) from it.
  const naveX = side / 2 + naveLength / 2;
  const roof = new THREE.BufferGeometry();
  const w = naveWidth / 2 + 0.3, L = naveLength / 2, r = 5.5;
  roof.setAttribute('position', new THREE.Float32BufferAttribute([
    -L, 0, w, L, 0, w, L, r, 0, -L, 0, w, L, r, 0, -L, r, 0,
    L, 0, -w, -L, 0, -w, -L, r, 0, L, 0, -w, -L, r, 0, L, r, 0,
    L, 0, w, L, 0, -w, L, r, 0, -L, 0, -w, -L, 0, w, -L, r, 0,
  ], 3));
  roof.computeVertexNormals();
  return [
    paint(new THREE.BoxGeometry(naveLength, naveWall + FOOTING, naveWidth), wall, at(naveX, (naveWall - FOOTING) / 2, 0)),
    paint(roof, slate, at(naveX, naveWall, 0)),
    paint(new THREE.BoxGeometry(side, towerTop + FOOTING, side), wall, at(0, (towerTop - FOOTING) / 2, 0)),
    // Eight-sided broach spire, rotated so its faces line up with the tower sides.
    paint(new THREE.ConeGeometry(side * 0.62, h - towerTop, 8), slate,
      at(0, (towerTop + h) / 2, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 8))),
  ];
}

function stoneTower(l: Landmark): THREE.BufferGeometry[] {
  const h = l.height, stone = l.color, dark = l.band;
  const radius = 5.5, parapet = 0.84 * h, merlons = 10;
  const parts = [
    drum(radius + 0.6, radius, -FOOTING, 0.15 * h, stone), // battered base
    drum(radius, radius, 0.15 * h, parapet, stone),
    drum(radius + 0.35, radius + 0.35, parapet - 0.6, parapet, dark), // string course
  ];
  for (let i = 0; i < merlons; i++) {
    const a = (i / merlons) * 2 * Math.PI;
    parts.push(paint(new THREE.BoxGeometry(1.9, h - parapet, 1.0), stone,
      at(radius * Math.cos(a), (parapet + h) / 2, radius * Math.sin(a)).multiply(new THREE.Matrix4().makeRotationY(-a + Math.PI / 2))));
  }
  return parts;
}

function mast(l: Landmark): THREE.BufferGeometry[] {
  const h = l.height, bands = 7, white = l.color, red = l.band;
  // A triangular lattice mast reads as a solid prism at range; about 1.7 m across the faces.
  const parts = [drum(2, 2, -FOOTING, 0.8, STONE_GREY, 8)];
  for (let i = 0; i < bands; i++) {
    parts.push(drum(1.0, 1.0, 0.8 + ((h - 0.8) * i) / bands, 0.8 + ((h - 0.8) * (i + 1)) / bands, i % 2 === 0 ? red : white, 3));
  }
  parts.push(paint(new THREE.SphereGeometry(0.6, 8, 6), red, at(0, h + 0.4, 0)));
  return parts;
}

/** Guy wires: three anchors, each stayed at three heights. World coordinates. */
function stays(l: Landmark, grid: TerrainGrid): number[] {
  const points: number[] = [];
  const spread = 0.5 * l.height;
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * 2 * Math.PI + 0.3;
    const ax = l.x + spread * Math.cos(a), az = l.z + spread * Math.sin(a);
    const ay = groundHeight(grid, ax, az);
    for (const f of [0.3, 0.6, 0.9]) points.push(ax, ay, az, l.x + 0.8 * Math.cos(a), l.base + f * l.height, l.z + 0.8 * Math.sin(a));
  }
  return points;
}

/** All landmarks: one merged mesh and the mast stays, in logical world coordinates. */
export function createLandmarks(grid: TerrainGrid, material: THREE.Material): THREE.Object3D[] {
  const parts: THREE.BufferGeometry[] = [];
  const stayPoints: number[] = [];
  for (const l of LANDMARKS) {
    const local = l.kind === 'lighthouse' ? lighthouse(l) : l.kind === 'spire' ? church(l) : l.kind === 'tower' ? stoneTower(l) : mast(l);
    const place = at(l.x, l.base, l.z);
    for (const p of local) parts.push(p.applyMatrix4(place));
    if (l.kind === 'mast') stayPoints.push(...stays(l, grid));
  }
  const merged = merge(parts);
  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.Float32BufferAttribute(stayPoints, 3));
  return [
    new THREE.Mesh(merged, material),
    new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: STAY })),
  ];
}
