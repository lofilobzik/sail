/**
 * Tree clumps: low-poly conifers and broadleaves as two InstancedMeshes (crown and trunk merged,
 * vertex-coloured, with per-instance tint). Clumps grow with the woodland mask shared with the
 * terrain colouring, on grass only: never on the beach, rock, steep ground or water, and never
 * inside a house plot.
 */
import * as THREE from 'three';
import { BAY, LANDMARKS, type TerrainGrid } from '../../sim/terrain';
import { type Footprints, groundGradient, groundHeight, nearestSample, seededRandom } from './ground';
import { merge, paint } from './parts';
import { rockAmount, woodAmount } from './terrainMesh';

/** Placement, all VISUAL ESTIMATE. */
const CLUMP_SPACING = 100; // m: jittered lattice of candidate clump centres
const CLUMP_RADIUS = 16; // m
const TREES_PER_CLUMP = [3, 8];
const LONE_TREE_CHANCE = 0.08; // clumps outside the woods (hedgerow trees, orchards)
const MAX_SHORE_DISTANCE = 1600; // m: farther inland the haze hides single trees
const MIN_ELEVATION = 3.5; // m: clear of the beach sand
const MAX_SLOPE = 0.38; // rise/run
const MAX_ROCK = 0.3;
const TRUNK_CLEARANCE = 1.5; // m: tree footprint kept clear of house discs
const LANDMARK_CLEARANCE = 25; // m
const CONIFER_HEIGHT = [7, 16]; // m
const BROADLEAF_HEIGHT = [6, 13]; // m
const CONIFER_ABOVE = 80; // m: conifers become common above this elevation

/** Colours (sRGB), VISUAL ESTIMATE. */
const TRUNK = 0x5a4634;
const CONIFER_CROWN = 0x2c4628;
const BROADLEAF_CROWN = 0x46612d;
const TINT = 0.12; // +/- per channel instance tint

/** Unit-height conifer: short trunk and two stacked open cones (the material is double-sided). */
function coniferGeometry(): THREE.BufferGeometry {
  const at = (y: number) => new THREE.Matrix4().makeTranslation(0, y, 0);
  return merge([
    paint(new THREE.CylinderGeometry(0.035, 0.05, 0.25, 4, 1, true), TRUNK, at(0.125)),
    paint(new THREE.ConeGeometry(0.22, 0.55, 6, 1, true), CONIFER_CROWN, at(0.42)),
    paint(new THREE.ConeGeometry(0.16, 0.45, 6, 1, true), CONIFER_CROWN, at(0.775)),
  ]);
}

/** Unit-height broadleaf: trunk and a squashed icosahedral crown. */
function broadleafGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.04, 0.06, 0.45, 4, 1, true), TRUNK, new THREE.Matrix4().makeTranslation(0, 0.225, 0)),
    paint(new THREE.IcosahedronGeometry(0.34, 0), BROADLEAF_CROWN,
      new THREE.Matrix4().makeTranslation(0, 0.64, 0).multiply(new THREE.Matrix4().makeScale(1, 0.95, 1))),
  ]);
}

interface Tree { x: number; z: number; y: number; height: number; width: number; yaw: number; conifer: boolean }

export function placeTrees(grid: TerrainGrid, shore: Float32Array, houses: Footprints): Tree[] {
  const random = seededRandom(BAY.seed * 15485863 + 5);
  const trees: Tree[] = [];
  const range = ([lo, hi]: number[]): number => lo! + (hi! - lo!) * random();
  const spanX = (grid.columns - 1) * grid.cell, spanZ = (grid.rows - 1) * grid.cell;
  for (let cz = 0; cz < spanZ; cz += CLUMP_SPACING) {
    for (let cx = 0; cx < spanX; cx += CLUMP_SPACING) {
      const x0 = grid.minX + cx + random() * CLUMP_SPACING, z0 = grid.minZ + cz + random() * CLUMP_SPACING;
      const lone = random() < LONE_TREE_CHANCE;
      if (random() >= woodAmount(x0, z0) && !lone) continue;
      const d = nearestSample(grid, shore, x0, z0);
      if (d === 0 || d > MAX_SHORE_DISTANCE) continue;
      const count = lone ? 1 + Math.floor(random() * 2) : Math.round(range(TREES_PER_CLUMP));
      for (let k = 0; k < count; k++) {
        const r = CLUMP_RADIUS * Math.sqrt(random()), a = random() * 2 * Math.PI;
        const x = x0 + r * Math.cos(a), z = z0 + r * Math.sin(a);
        const y = groundHeight(grid, x, z);
        if (y < MIN_ELEVATION) continue;
        const [gx, gz] = groundGradient(grid, x, z);
        const slope = Math.hypot(gx, gz);
        if (slope > MAX_SLOPE || rockAmount(x, z, y, slope) > MAX_ROCK) continue;
        if (houses.overlaps(x, z, TRUNK_CLEARANCE)) continue;
        if (LANDMARKS.some((l) => Math.hypot(x - l.x, z - l.z) < LANDMARK_CLEARANCE)) continue;
        const conifer = random() < 0.25 + 0.5 * Math.min(Math.max((y - CONIFER_ABOVE) / CONIFER_ABOVE, 0), 1);
        const height = range(conifer ? CONIFER_HEIGHT : BROADLEAF_HEIGHT);
        trees.push({ x, z, y, height, width: height * (conifer ? range([0.85, 1.1]) : range([0.8, 1.15])), yaw: random() * 2 * Math.PI, conifer });
      }
    }
  }
  return trees;
}

/** Conifer and broadleaf InstancedMeshes; matrices in logical world coordinates. */
export function createTreeMeshes(trees: readonly Tree[], material: THREE.Material): THREE.InstancedMesh[] {
  const random = seededRandom(BAY.seed * 32452843 + 7);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3(), scale = new THREE.Vector3(), tint = new THREE.Color();
  return [true, false].map((conifer) => {
    const kind = trees.filter((t) => t.conifer === conifer);
    const mesh = new THREE.InstancedMesh(conifer ? coniferGeometry() : broadleafGeometry(), material, kind.length);
    kind.forEach((t, i) => {
      // Sink the trunk a little so it never floats on the triangulated slope.
      m.compose(position.set(t.x, t.y - 0.4, t.z), q.setFromAxisAngle(up, t.yaw), scale.set(t.width, t.height, t.width));
      mesh.setMatrixAt(i, m);
      tint.setRGB(1 + (random() * 2 - 1) * TINT, 1 + (random() * 2 - 1) * TINT, 1 + (random() * 2 - 1) * TINT * 0.6);
      mesh.setColorAt(i, tint);
    });
    mesh.computeBoundingSphere();
    return mesh;
  });
}
