/**
 * Trees across all the land: a jittered lattice over the whole mainland and the islands, denser in
 * woods and in the forest belt behind Westcove (forest.ts), with meadow clearings, thinner near the
 * beach and the towns, and never on the beach, bare rock, steep ground, water, roads, house plots or
 * the harbour works. Conifers are narrow, dark, fir-like and dominate the hills and the belt; broadleaves
 * fill the lowlands. Drawn as InstancedMeshes per 500 m square (so off-screen forest is skipped), each
 * a LOD with the full model near and a trunkless crown far. Seeded from BAY.seed.
 */
import * as THREE from 'three';
import { BAY, LANDMARKS, fbm, type TerrainGrid } from '../../sim/terrain';
import { beltAmount } from './forest';
import { type Footprints, groundGradient, groundHeight, nearestSample, seededRandom } from './ground';
import { faceted, merge, paint } from './parts';
import { rockAmount, woodAmount } from './terrainMesh';

/** Placement, all VISUAL ESTIMATE. */
const TREE_SPACING = 15; // m: jittered lattice of candidate spots
const MAX_SHORE_DISTANCE = 2200; // m: farther inland the haze hides single trees (the ground still darkens)
const BASE_DENSITY = 0.5; // chance of a tree per spot on open ground; woods and the belt go up to 1
const MEADOW_WAVELENGTH = 260; // m: size of clearings
const MEADOW_FROM = 0.3; // clearing noise (fbm in [-1, 1]) where meadows begin ...
const MEADOW_FULL = 0.55; // ... and where they are fully open
const MEADOW_OPENNESS = 0.9; // how bare a meadow is
const SHORE_THIN_FROM = 20; // m from the water: no trees closer than this ...
const SHORE_THIN_TO = 90; // ... full density from here
const TOWN_DENSITY = 0.4; // inside a town's radius: gardens and a few trees
const HARBOUR_CLEARANCE = 25; // m around the quay, the mole and the terrace
const MIN_ELEVATION = 3.5; // m: clear of the beach sand
const MAX_SLOPE = 0.38; // rise/run
const BELT_MAX_SLOPE = 0.5; // the belt climbs steeper ground
const MAX_ROCK = 0.3;
const TRUNK_CLEARANCE = 1.5; // m: tree footprint kept clear of house discs
const LANDMARK_CLEARANCE = 25; // m
const CONIFER_HEIGHT = [8, 20]; // m
const BELT_HEIGHT = [13, 24]; // m
const TALLER_PER_100M = 4; // m of extra conifer height per 100 m of elevation above 20 m
const BROADLEAF_HEIGHT = [6, 13]; // m
const CONIFER_WIDTH = [0.5, 0.68]; // crown width as a fraction of height: fir-narrow
const CONIFER_SHARE = 0.45; // lowland share of conifers; woods, height and the belt raise it
const CHUNK = 500; // m: trees are grouped per square of this size
const FAR_DISTANCE = 1000; // m from a chunk's centre: the trunkless far models beyond
const LOD_HYSTERESIS = 0.15; // fraction of the distance, so a square at the boundary never flickers

/** Colours (sRGB), VISUAL ESTIMATE. */
const TRUNK = 0x5a4634;
const CONIFER_CROWN = 0x2c4628;
const BROADLEAF_CROWN = 0x46612d;
const TINT = 0.12; // +/- per channel instance tint

/** Unit-height conifer: short trunk and two stacked open cones (the material is double-sided). */
function coniferGeometry(): THREE.BufferGeometry {
  const at = (y: number) => new THREE.Matrix4().makeTranslation(0, y, 0);
  return faceted(merge([
    paint(new THREE.CylinderGeometry(0.035, 0.05, 0.25, 4, 1, true), TRUNK, at(0.125)),
    paint(new THREE.ConeGeometry(0.22, 0.55, 6, 1, true), CONIFER_CROWN, at(0.42)),
    paint(new THREE.ConeGeometry(0.16, 0.45, 6, 1, true), CONIFER_CROWN, at(0.775)),
  ]));
}

/** Unit-height broadleaf: trunk and a squashed icosahedral crown. */
function broadleafGeometry(): THREE.BufferGeometry {
  return faceted(merge([
    paint(new THREE.CylinderGeometry(0.04, 0.06, 0.45, 4, 1, true), TRUNK, new THREE.Matrix4().makeTranslation(0, 0.225, 0)),
    paint(new THREE.IcosahedronGeometry(0.34, 0), BROADLEAF_CROWN,
      new THREE.Matrix4().makeTranslation(0, 0.64, 0).multiply(new THREE.Matrix4().makeScale(1, 0.95, 1))),
  ]));
}

/**
 * Far models: the conifer keeps its two tiers (5-sided, no trunk, which is invisible at that range) so
 * the swap changes little on screen, even through binoculars; the broadleaf is a plain octahedron.
 */
function farConiferGeometry(): THREE.BufferGeometry {
  const at = (y: number) => new THREE.Matrix4().makeTranslation(0, y, 0);
  return faceted(merge([
    paint(new THREE.ConeGeometry(0.22, 0.55, 5, 1, true), CONIFER_CROWN, at(0.42)),
    paint(new THREE.ConeGeometry(0.16, 0.45, 5, 1, true), CONIFER_CROWN, at(0.775)),
  ]));
}
const farBroadleafGeometry = (): THREE.BufferGeometry =>
  faceted(merge([paint(new THREE.OctahedronGeometry(0.4, 0), BROADLEAF_CROWN, new THREE.Matrix4().makeTranslation(0, 0.6, 0))]));

export interface Tree { x: number; z: number; y: number; height: number; width: number; yaw: number; conifer: boolean; shade: number }

const smoothstep = (a: number, b: number, v: number): number => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

function nearHarbour(x: number, z: number): boolean {
  return BAY.harbour.reclaimed.some((r) => x > r.x0 - HARBOUR_CLEARANCE && x < r.x1 + HARBOUR_CLEARANCE && z > r.z0 - HARBOUR_CLEARANCE && z < r.z1 + HARBOUR_CLEARANCE);
}

export function placeTrees(grid: TerrainGrid, shore: Float32Array, houses: Footprints): Tree[] {
  const random = seededRandom(BAY.seed * 15485863 + 5);
  const trees: Tree[] = [];
  const range = ([lo, hi]: number[]): number => lo! + (hi! - lo!) * random();
  const spanX = (grid.columns - 1) * grid.cell, spanZ = (grid.rows - 1) * grid.cell;
  for (let cz = 0; cz < spanZ; cz += TREE_SPACING) {
    for (let cx = 0; cx < spanX; cx += TREE_SPACING) {
      const x = grid.minX + cx + random() * TREE_SPACING, z = grid.minZ + cz + random() * TREE_SPACING;
      const d = nearestSample(grid, shore, x, z);
      if (d === 0 || d > MAX_SHORE_DISTANCE) continue;
      const chance = random(); // one draw per spot keeps the layout stable when the rules change
      const belt = beltAmount(x, z);
      const wood = woodAmount(x, z);
      const meadow = smoothstep(MEADOW_FROM, MEADOW_FULL, fbm(x / MEADOW_WAVELENGTH, z / MEADOW_WAVELENGTH, 2, BAY.seed + 411));
      let density = (BASE_DENSITY + (1 - BASE_DENSITY) * wood) * (1 - MEADOW_OPENNESS * meadow) * smoothstep(SHORE_THIN_FROM, SHORE_THIN_TO, d);
      if (BAY.towns.some((t) => (x - t.x) ** 2 + (z - t.z) ** 2 < t.radius * t.radius)) density *= TOWN_DENSITY;
      density = Math.max(density, belt);
      if (chance >= density) continue;
      const y = groundHeight(grid, x, z);
      if (y < MIN_ELEVATION || nearHarbour(x, z)) continue;
      const [gx, gz] = groundGradient(grid, x, z);
      const slope = Math.hypot(gx, gz);
      if (slope > (belt > 0.3 ? BELT_MAX_SLOPE : MAX_SLOPE) || rockAmount(x, z, y, slope) > MAX_ROCK) continue;
      if (houses.overlaps(x, z, TRUNK_CLEARANCE)) continue;
      if (LANDMARKS.some((l) => Math.hypot(x - l.x, z - l.z) < LANDMARK_CLEARANCE)) continue;
      const conifer = random() < Math.min(1, CONIFER_SHARE + 0.3 * wood + 0.25 * Math.min(Math.max((y - 10) / 90, 0), 1) + 0.4 * belt);
      const taller = (Math.max(y - 20, 0) / 100) * TALLER_PER_100M;
      const height = conifer ? range(belt > 0.3 ? BELT_HEIGHT : CONIFER_HEIGHT) + taller : range(BROADLEAF_HEIGHT);
      const width = height * (conifer ? range(CONIFER_WIDTH) : range([0.8, 1.15]));
      // The belt is the darkest wood; broadleaves are a little lighter than the firs.
      const shade = conifer ? range(belt > 0.3 ? [0.7, 0.9] : [0.85, 1]) : range([0.95, 1.1]);
      trees.push({ x, z, y, height, width, yaw: random() * 2 * Math.PI, conifer, shade });
    }
  }
  return trees;
}

/**
 * Trees as LOD objects per CHUNK square and kind: the full model near, a trunkless crown far. Instance
 * matrices are relative to the chunk's centre, where the LOD object sits, so the camera distance
 * used to pick the level is the chunk's.
 */
export function createTreeMeshes(trees: readonly Tree[], material: THREE.Material): THREE.LOD[] {
  const random = seededRandom(BAY.seed * 32452843 + 7);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  const groups = new Map<string, Tree[]>();
  for (const t of trees) {
    const key = `${Math.floor(t.x / CHUNK)},${Math.floor(t.z / CHUNK)},${t.conifer ? 1 : 0}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  const shared = {
    near: [broadleafGeometry(), coniferGeometry()],
    far: [farBroadleafGeometry(), farConiferGeometry()],
  };
  const lods: THREE.LOD[] = [];
  for (const [key, group] of groups) {
    const [ix, iz, kind] = key.split(',').map(Number) as [number, number, number];
    const centreX = (ix + 0.5) * CHUNK, centreZ = (iz + 0.5) * CHUNK;
    const lod = new THREE.LOD();
    lod.position.set(centreX, 0, centreZ);
    // One tint per tree, shared by both levels so a tree keeps its shade when the model swaps.
    const tints = group.map((t) => new THREE.Color(
      1 + (random() * 2 - 1) * TINT, 1 + (random() * 2 - 1) * TINT, 1 + (random() * 2 - 1) * TINT * 0.6,
    ).multiplyScalar(t.shade));
    for (const [level, geometry] of [[0, shared.near[kind]!], [FAR_DISTANCE, shared.far[kind]!]] as const) {
      const mesh = new THREE.InstancedMesh(geometry, material, group.length);
      group.forEach((t, i) => {
        // Sink the trunk a little so it never floats on the triangulated slope.
        m.compose(position.set(t.x - centreX, t.y - 0.4, t.z - centreZ), q.setFromAxisAngle(up, t.yaw), scale.set(t.width, t.height, t.width));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, tints[i]!);
      });
      mesh.computeBoundingSphere();
      lod.addLevel(mesh, level, level > 0 ? LOD_HYSTERESIS : 0);
    }
    lods.push(lod);
  }
  return lods;
}
