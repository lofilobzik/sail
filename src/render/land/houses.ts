/**
 * Houses. A town with `layout: "roads"` in data/bay.json has its houses in clusters along that
 * town's roads (roads.ts), set back from the gravel and all facing downhill toward the water; other
 * towns scatter houses at random, denser toward the centre, and single houses are scattered along the
 * mainland shore band (`scatteredHouses`). Only dry, gentle, non-rocky ground, clear of landmark feet,
 * the harbour works and each other. Models are houseModels.ts; each district of the bay is baked into
 * one merged vertex-coloured mesh, so culling works per district and the whole town is a few draw
 * calls. Seeded from BAY.seed.
 */
import * as THREE from 'three';
import { BAY, LANDMARKS, fbm, type TerrainGrid } from '../../sim/terrain';
import { Footprints, groundGradient, groundHeight, nearestSample, seededRandom } from './ground';
import {
  ACCENT_PALETTE, CHIMNEY_PALETTE, DOOR_PALETTE, ROOF_PALETTE, TRIM_PALETTE, WALL_PALETTE,
  houseGeometry, pick, type HouseSpec, type RoofShape,
} from './houseModels';
import { merge } from './parts';
import { ROADS, sampleRoad } from './roads';
import { rockAmount } from './terrainMesh';

/** Placement limits, all VISUAL ESTIMATE. */
const MIN_ELEVATION = 3; // m: above the beach sand (SAND_TOP 2.2 +/- 0.8)
const MAX_SLOPE = 0.22; // rise/run, about 12 degrees: steeper ground stays open
const ROAD_MAX_SLOPE = 0.26; // houses beside a road may sit on slightly steeper ground
const MAX_ROCK = 0.35; // rock fraction from the terrain colouring
const LANDMARK_CLEARANCE = 35; // m around each landmark foot
const HARBOUR_CLEARANCE = 12; // m around the quay, the mole and the terrace: the harbour front is hand-built
const SPACING = 1.1; // minimum gap between houses as a multiple of their half-diagonals
const ATTEMPTS_PER_HOUSE = 40; // rejection-sampling budget
const ISLAND_MARGIN = 1.6; // scattered houses stay off islands: outside this many island radii
const YAW_JITTER_DEG = 18; // houses are not all square to the slope
const ROAD_YAW_JITTER_DEG = 4; // houses beside a road line up with it
const SETBACK = [5, 9]; // m from the road's edge to a house's front
const GAP = [1.5, 5]; // m between neighbours along a road
const CLUSTER_WAVELENGTH = 75; // m: a cluster of houses, then a gap, along each side of a road
const CLUSTER_THRESHOLD = -0.1; // fbm above this builds: about 55 % of the road
const UPHILL_SIDE_CHANCE = 0.75; // the uphill side of a road is built less often than the water side
const CHUNK = 800; // m: houses are merged per square of this size, a compromise between draw calls and culling
const BRIGHTNESS_JITTER = 0.07; // +/- per house: sun-bleached and shaded timber
const ACCENT_WALL_CHANCE = 0.08; // a few saturated walls

export interface House {
  x: number; z: number; ground: number; yaw: number; scale: number;
  /** Footprint after scaling, m (placement and tree keep-clear use these). */
  length: number; width: number;
  spec: HouseSpec;
}

const range = (random: () => number, [lo, hi]: number[]): number => lo! + (hi! - lo!) * random();

function shade(colour: number, factor: number): number {
  const c = new THREE.Color(colour).multiplyScalar(factor);
  return c.getHex();
}

/** A random house: cottages, two-storey houses and cabins, in the weathered palette with a few accents. */
export function makeSpec(random: () => number, sink: number): HouseSpec {
  const kind = random();
  const cottage = kind < 0.45, tall = !cottage && kind < 0.75;
  const roll = random();
  const roof: RoofShape = cottage || tall
    ? roll < 0.55 ? 'gable' : roll < 0.8 ? 'hip' : 'saltbox'
    : roll < 0.65 ? 'gable' : 'lean';
  const pitch = roof === 'lean' ? range(random, [12, 18]) : roof === 'hip' ? range(random, [25, 32]) : range(random, [30, 40]);
  const jitter = () => 1 + (random() * 2 - 1) * BRIGHTNESS_JITTER;
  const accent = random() < ACCENT_WALL_CHANCE;
  return {
    length: cottage ? range(random, [8, 11]) : tall ? range(random, [8, 10.5]) : range(random, [6, 8]),
    width: cottage ? range(random, [6, 7.2]) : tall ? range(random, [6.8, 8]) : range(random, [5, 6]),
    wall: cottage ? range(random, [3.2, 3.5]) : tall ? range(random, [5.6, 6.2]) : range(random, [2.8, 3]),
    storeys: tall ? 2 : 1,
    roof,
    pitch,
    chimney: random() < (cottage ? 0.7 : tall ? 0.6 : 0.4),
    porch: random() < (cottage ? 0.35 : tall ? 0.25 : 0.1),
    sink,
    doorSide: random() < 0.5 ? -1 : 1,
    wallColour: shade(accent ? ACCENT_PALETTE[Math.floor(random() * ACCENT_PALETTE.length)]! : pick(WALL_PALETTE, random()), jitter()),
    trimColour: pick(TRIM_PALETTE, random()),
    roofColour: shade(pick(ROOF_PALETTE, random()), jitter()),
    doorColour: pick(DOOR_PALETTE, random()),
    chimneyColour: pick(CHIMNEY_PALETTE, random()),
  };
}

/**
 * True inside a hand-built harbour rectangle (quay, mole, the cottage terrace), grown by `clearance`.
 * Terraces marked `houses: true` are part of the town and take houses like any other ground.
 */
function inHarbour(x: number, z: number, clearance: number): boolean {
  return BAY.harbour.reclaimed.some((r) => !('houses' in r && r.houses)
    && x > r.x0 - clearance && x < r.x1 + clearance && z > r.z0 - clearance && z < r.z1 + clearance);
}

/** True on one of the town's terraces behind the harbour (`houses: true`). */
function onTownTerrace(x: number, z: number): boolean {
  return BAY.harbour.reclaimed.some((r) => 'houses' in r && r.houses && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
}

/**
 * Places all houses. `shore`: distance to water per grid sample (ground.ts `waterDistance`).
 */
export function placeHouses(grid: TerrainGrid, shore: Float32Array): House[] {
  const random = seededRandom(BAY.seed * 7919 + 1);
  const taken = new Footprints(16);
  const houses: House[] = [];

  /** Places a house at (x, z) if the ground suits it. `yaw` is the direction its front faces (null: downhill). */
  const tryPlace = (x: number, z: number, yaw: number | null, maxSlope: number): boolean => {
    const ground = groundHeight(grid, x, z);
    if (ground < MIN_ELEVATION) return false;
    const [gx, gz] = groundGradient(grid, x, z);
    const slope = Math.hypot(gx, gz);
    if (slope > maxSlope || rockAmount(x, z, ground, slope) > MAX_ROCK) return false;
    if (inHarbour(x, z, HARBOUR_CLEARANCE)) return false;
    const spec = makeSpec(random, 0);
    const scale = 0.94 + random() * 0.14;
    const length = spec.length * scale, width = spec.width * scale;
    const radius = 0.5 * Math.hypot(length, width) * SPACING;
    if (taken.overlaps(x, z, radius)) return false;
    if (LANDMARKS.some((l) => Math.hypot(x - l.x, z - l.z) < LANDMARK_CLEARANCE + radius)) return false;
    taken.add(x, z, radius);
    const downhill = slope > 1e-3 ? Math.atan2(-gx, -gz) : random() * 2 * Math.PI;
    const facing = yaw === null ? downhill + (random() * 2 - 1) * YAW_JITTER_DEG * (Math.PI / 180) : yaw + (random() * 2 - 1) * ROAD_YAW_JITTER_DEG * (Math.PI / 180);
    // Bury the plinth so the downhill side never floats.
    spec.sink = (slope * 0.5 * Math.hypot(length, width) + 0.3) / scale;
    houses.push({ x, z, ground, yaw: facing, scale, length, width, spec });
    return true;
  };

  // Towns laid out along roads: clusters of houses either side, set back, front to the water.
  for (const town of BAY.towns) {
    if (!('layout' in town) || town.layout !== 'roads') continue;
    ROADS.filter((r) => r.town === town.name).forEach((road, roadIndex) => {
      const samples = sampleRoad(road, 2, grid);
      if (samples.length < 2) return;
      const total = samples[samples.length - 1]!.s;
      for (const side of [1, -1] as const) {
        let s = random() * 8;
        while (s < total) {
          const length = range(random, [7, 11]);
          const centre = s + length / 2;
          if (centre >= total) break;
          const p = samples[Math.min(samples.length - 1, Math.round(centre / 2))]!;
          // The model's width is across the road line: half of it, the setback and half the road.
          const offset = side * (road.width / 2 + range(random, SETBACK) + 3.5);
          const x = p.x + p.nx * offset, z = p.z + p.nz * offset;
          // Out along the hillside the houses come in clusters; on the town's terraces the street is built up.
          const cluster = fbm(centre / CLUSTER_WAVELENGTH + roadIndex * 3.1, side * 5.7 + roadIndex, 2, BAY.seed + 77);
          const built = onTownTerrace(x, z) || (cluster > CLUSTER_THRESHOLD && (side === 1 || random() < UPHILL_SIDE_CHANCE));
          const placed = built && tryPlace(x, z, Math.atan2(p.nx, p.nz), ROAD_MAX_SLOPE);
          s += placed ? length + range(random, GAP) : 6;
        }
      }
    });
  }

  for (const town of BAY.towns) {
    if ('layout' in town && town.layout === 'roads') continue;
    let placed = 0;
    for (let attempt = 0; attempt < town.houses * ATTEMPTS_PER_HOUSE && placed < town.houses; attempt++) {
      // Uniform in radius (not area): density falls off as 1/r from the centre.
      const r = town.radius * random(), a = random() * 2 * Math.PI;
      if (tryPlace(town.x + r * Math.cos(a), town.z + r * Math.sin(a), null, MAX_SLOPE)) placed++;
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
    if (tryPlace(x, z, null, MAX_SLOPE)) placed++;
  }
  return houses;
}

/** One merged mesh per CHUNK-metre square of the bay; geometry is in logical world coordinates. */
export function createHouseMeshes(houses: readonly House[], material: THREE.Material): THREE.Mesh[] {
  const chunks = new Map<string, THREE.BufferGeometry[]>();
  const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  for (const h of houses) {
    const geometry = houseGeometry(h.spec);
    q.setFromAxisAngle(up, h.yaw);
    geometry.applyMatrix4(matrix.compose(position.set(h.x, h.ground, h.z), q, scale.setScalar(h.scale)));
    const key = `${Math.floor(h.x / CHUNK)},${Math.floor(h.z / CHUNK)}`;
    const list = chunks.get(key);
    if (list) list.push(geometry);
    else chunks.set(key, [geometry]);
  }
  return [...chunks.values()].map((parts) => new THREE.Mesh(merge(parts), material));
}
