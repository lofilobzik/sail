/**
 * Houses: towns from data/bay.json `towns` (denser toward each centre) and single houses scattered
 * along the mainland shore band (`scatteredHouses`). Only dry, gentle, non-rocky ground, clear of
 * landmark feet and of each other; each faces roughly downhill, toward the water. Drawn as two
 * InstancedMeshes (walls, pitched roofs) with per-instance colours. Seeded from BAY.seed.
 */
import * as THREE from 'three';
import { BAY, LANDMARKS, type TerrainGrid } from '../../sim/terrain';
import { Footprints, groundGradient, groundHeight, nearestSample, seededRandom } from './ground';
import { rockAmount } from './terrainMesh';

/** Placement limits, all VISUAL ESTIMATE. */
const MIN_ELEVATION = 3; // m: above the beach sand (SAND_TOP 2.2 +/- 0.8)
const MAX_SLOPE = 0.22; // rise/run, about 12 degrees: steeper ground stays open
const MAX_ROCK = 0.35; // rock fraction from the terrain colouring
const LANDMARK_CLEARANCE = 35; // m around each landmark foot
const SPACING = 1.25; // minimum gap between houses as a multiple of their half-diagonals
const ATTEMPTS_PER_HOUSE = 40; // rejection-sampling budget
const ISLAND_MARGIN = 1.6; // scattered houses stay off islands: outside this many island radii
const YAW_JITTER_DEG = 18; // houses are not all square to the slope

/** Sizes, VISUAL ESTIMATE from typical small coastal cottages and town houses. */
const LENGTH = [8, 14]; // m along the ridge
const WIDTH = [5.5, 8]; // m across
const WALL_HEIGHT = [3.8, 6.2]; // m: one to two storeys
const ROOF_PITCH_DEG = [35, 50];
const EAVE_OVERHANG = 0.4; // m

/** Colours (sRGB), VISUAL ESTIMATE: whitewash, cream, ochre and grey walls; red, terracotta and slate roofs. */
const WALL_COLOURS = [0xf0ece2, 0xece4cf, 0xe3d3ad, 0xd6a95e, 0xc9c6bd, 0xa49f93, 0xe6c9b4];
const ROOF_COLOURS = [0xa5402c, 0xb8603a, 0x9a4a32, 0x4c535a, 0x3b4046, 0x6e4634];
const COLOUR_JITTER = 0.08; // +/- brightness per instance

export interface House {
  x: number; z: number; ground: number; yaw: number;
  length: number; width: number; wall: number; roof: number;
  sink: number; wallColour: number; roofColour: number;
}

/** Unit gable roof: ridge along x at y = 1, eaves at z = +/-0.5, y = 0. Flat-shaded, so scale freely. */
function roofGeometry(): THREE.BufferGeometry {
  const p = [
    // Slopes (front +z, back -z), counter-clockwise from outside.
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    // Gable ends.
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const range = (random: () => number, [lo, hi]: number[]): number => lo! + (hi! - lo!) * random();

/** `shore`: distance to water per grid sample (ground.ts `waterDistance`). */
export function placeHouses(grid: TerrainGrid, shore: Float32Array): House[] {
  const random = seededRandom(BAY.seed * 7919 + 1);
  const taken = new Footprints(16);
  const houses: House[] = [];

  const tryPlace = (x: number, z: number): boolean => {
    const ground = groundHeight(grid, x, z);
    if (ground < MIN_ELEVATION) return false;
    const [gx, gz] = groundGradient(grid, x, z);
    const slope = Math.hypot(gx, gz);
    if (slope > MAX_SLOPE || rockAmount(x, z, ground, slope) > MAX_ROCK) return false;
    const length = range(random, LENGTH), width = range(random, WIDTH);
    const radius = 0.5 * Math.hypot(length, width) * SPACING;
    if (taken.overlaps(x, z, radius)) return false;
    if (LANDMARKS.some((l) => Math.hypot(x - l.x, z - l.z) < LANDMARK_CLEARANCE + radius)) return false;
    taken.add(x, z, radius);
    // Front (local +z) faces downhill, which on this coast is toward the water.
    const downhill = slope > 1e-3 ? Math.atan2(-gx, -gz) : random() * 2 * Math.PI;
    const pitch = range(random, ROOF_PITCH_DEG) * (Math.PI / 180);
    houses.push({
      x, z, ground, yaw: downhill + (random() * 2 - 1) * YAW_JITTER_DEG * (Math.PI / 180),
      length, width, wall: range(random, WALL_HEIGHT), roof: (width / 2 + EAVE_OVERHANG) * Math.tan(pitch),
      // Bury the base so the downhill side never floats.
      sink: slope * 0.5 * Math.hypot(length, width) + 0.3,
      wallColour: WALL_COLOURS[Math.floor(random() * WALL_COLOURS.length)]!,
      roofColour: ROOF_COLOURS[Math.floor(random() * ROOF_COLOURS.length)]!,
    });
    return true;
  };

  for (const town of BAY.towns) {
    let placed = 0;
    for (let attempt = 0; attempt < town.houses * ATTEMPTS_PER_HOUSE && placed < town.houses; attempt++) {
      // Uniform in radius (not area): density falls off as 1/r from the centre.
      const r = town.radius * random(), a = random() * 2 * Math.PI;
      if (tryPlace(town.x + r * Math.cos(a), town.z + r * Math.sin(a))) placed++;
    }
  }

  const { count, minShoreDistance, maxShoreDistance } = BAY.scatteredHouses;
  const spanX = (grid.columns - 1) * grid.cell, spanZ = (grid.rows - 1) * grid.cell;
  let placed = 0;
  for (let attempt = 0; attempt < count * ATTEMPTS_PER_HOUSE * 20 && placed < count; attempt++) {
    const x = grid.minX + spanX * random(), z = grid.minZ + spanZ * random();
    const d = nearestSample(grid, shore, x, z);
    if (d < minShoreDistance || d > maxShoreDistance) continue;
    if (BAY.towns.some((t) => (x - t.x) ** 2 + (z - t.z) ** 2 < t.radius * t.radius)) continue;
    if (BAY.islands.some((i) => Math.hypot(x - i.x, z - i.z) < ISLAND_MARGIN * Math.max(i.rx, i.rz))) continue;
    if (tryPlace(x, z)) placed++;
  }
  return houses;
}

/** Walls and roofs as two InstancedMeshes; matrices in logical world coordinates. */
export function createHouseMeshes(houses: readonly House[], material: THREE.Material): THREE.InstancedMesh[] {
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const walls = new THREE.InstancedMesh(box, material, houses.length);
  const roofs = new THREE.InstancedMesh(roofGeometry(), material, houses.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3(), scale = new THREE.Vector3(), colour = new THREE.Color();
  const random = seededRandom(BAY.seed * 104729 + 3);
  houses.forEach((h, i) => {
    q.setFromAxisAngle(up, h.yaw);
    const base = h.ground - h.sink;
    m.compose(position.set(h.x, base, h.z), q, scale.set(h.length, h.wall + h.sink, h.width));
    walls.setMatrixAt(i, m);
    colour.setHex(h.wallColour).multiplyScalar(1 + (random() * 2 - 1) * COLOUR_JITTER);
    walls.setColorAt(i, colour);
    const eaves = 2 * EAVE_OVERHANG;
    m.compose(position.set(h.x, h.ground + h.wall, h.z), q, scale.set(h.length + eaves, h.roof, h.width + eaves));
    roofs.setMatrixAt(i, m);
    colour.setHex(h.roofColour).multiplyScalar(1 + (random() * 2 - 1) * COLOUR_JITTER);
    roofs.setColorAt(i, colour);
  });
  for (const mesh of [walls, roofs]) mesh.computeBoundingSphere();
  return [walls, roofs];
}
