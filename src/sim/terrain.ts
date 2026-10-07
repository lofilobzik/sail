/**
 * The bay: one analytic, seeded elevation function shared by physics (grounding), the chart and the
 * land mesh. Elevation is metres above mean sea level; negative values are water depth.
 * Layout and every constant live in data/bay.json.
 */
import bay from '../../data/bay.json';
import { DEG, type Vec2 } from './frames';

export const BAY = bay;

export type LandmarkKind = 'lighthouse' | 'spire' | 'tower' | 'mast';
export interface Landmark extends Vec2 {
  name: string;
  kind: LandmarkKind;
  /** Structure height above its foot, m. */
  height: number;
  color: string;
  band: string;
  /** Ground elevation at the foot, m. */
  base: number;
}

// --- Seeded value noise -------------------------------------------------------------------------

function hash(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff; // [0, 1]
}

/** Smooth value noise in [-1, 1]. */
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return 2 * ((a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz) - 1;
}

/** Fractal sum of octaves, normalised to [-1, 1]. */
export function fbm(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0, amplitude = 1, total = 0, frequency = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise(x * frequency, z * frequency, seed + i * 101);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return sum / total;
}

// --- Shapes ------------------------------------------------------------------------------------

const coast = bay.mainland.coast.map(([x, z]) => ({ x: x!, z: z! }));

/** Signed distance to the mainland polygon, positive on land. */
function mainlandDistance(x: number, z: number): number {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = coast.length - 1; i < coast.length; j = i++) {
    const a = coast[j]!, b = coast[i]!;
    const ex = b.x - a.x, ez = b.z - a.z;
    const wx = x - a.x, wz = z - a.z;
    const t = Math.max(0, Math.min(1, (wx * ex + wz * ez) / (ex * ex + ez * ez)));
    const dx = wx - ex * t, dz = wz - ez * t;
    best = Math.min(best, dx * dx + dz * dz);
    if ((a.z > z) !== (b.z > z) && x < a.x + (ex * (z - a.z)) / ez) inside = !inside;
  }
  const d = Math.sqrt(best);
  return inside ? d : -d;
}

const islands = bay.islands.map((i) => ({ ...i, cos: Math.cos(i.rotationDeg * DEG), sin: Math.sin(i.rotationDeg * DEG) }));

/** Approximate signed distance to a rotated ellipse, positive inside (exact on the axes). */
function islandDistance(island: typeof islands[number], x: number, z: number): number {
  const dx = x - island.x, dz = z - island.z;
  const u = dx * island.cos + dz * island.sin;
  const v = -dx * island.sin + dz * island.cos;
  const k = Math.hypot(u / island.rx, v / island.rz);
  if (k === 0) return Math.min(island.rx, island.rz);
  // Distance along the ray through the centre, scaled by the local radius.
  return (1 - k) * Math.hypot(u, v) / k;
}

/** Elevation of one land shape from its noise-perturbed signed distance `d` (positive on land). */
function profile(d: number, hillHeight: number, hillRise: number, x: number, z: number): number {
  const { beach, seabed, reliefNoise } = bay;
  if (d <= 0) {
    const n = 0.5 + 0.5 * fbm(x / seabed.slopeWavelength, z / seabed.slopeWavelength, 2, bay.seed + 31);
    const slope = seabed.nearshoreSlopeMin + (seabed.nearshoreSlopeMax - seabed.nearshoreSlopeMin) * n;
    return -seabed.maxDepth * (1 - Math.exp((d * slope) / seabed.maxDepth));
  }
  const beachPart = beach.height * Math.min(d / beach.width, 1);
  const relief = 1 + reliefNoise.amplitude * fbm(x / reliefNoise.wavelength, z / reliefNoise.wavelength, reliefNoise.octaves, bay.seed + 17);
  const hills = hillHeight * relief * (1 - Math.exp(-Math.max(0, d - beach.width) / hillRise));
  return beachPart + hills;
}

interface HarbourRect { x0: number; z0: number; x1: number; z1: number; edge: number }

/** 1 inside the rectangle, easing (smoothstep) to 0 over `edge` metres outside it. */
export function rectWeight(r: HarbourRect, x: number, z: number): number {
  const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
  const t = Math.min(Math.sqrt(dx * dx + dz * dz) / r.edge, 1);
  return 1 - t * t * (3 - 2 * t);
}

/** Westcove Harbour (data/bay.json `harbour`): the basin is deepened, then the quay, mole and terrace are raised or cut to their flat height. */
function harbourHeight(h: number, x: number, z: number): number {
  for (const d of bay.harbour.dredged) h += (Math.min(h, -d.depth) - h) * rectWeight(d, x, z);
  for (const r of bay.harbour.reclaimed) h += (r.height - h) * rectWeight(r, x, z);
  return h;
}

/** Elevation above mean sea level, m (negative = depth). Deterministic; cheap enough per physics substep. */
export function terrainHeight(x: number, z: number): number {
  const c = bay.coastNoise;
  const wobble = c.amplitude * fbm(x / c.wavelength, z / c.wavelength, c.octaves, bay.seed);
  let h = profile(mainlandDistance(x, z) + wobble, bay.mainland.hillHeight, bay.mainland.hillRise, x, z);
  for (const island of islands) {
    // Islands are smaller, so their coast wobbles proportionally less.
    const scale = Math.min(1, Math.min(island.rx, island.rz) / c.wavelength);
    const d = islandDistance(island, x, z) + wobble * scale;
    h = Math.max(h, profile(d, island.hillHeight, island.hillRise, x, z));
  }
  const maxDepth = bay.seabed.maxDepth;
  for (const s of bay.shoals) {
    const r2 = ((x - s.x) ** 2 + (z - s.z) ** 2) / (s.radius * s.radius);
    h = Math.max(h, -maxDepth + (maxDepth - s.topDepth) * Math.exp(-r2));
  }
  return harbourHeight(h, x, z);
}

/** Horizontal gradient of the elevation (finite difference), per metre. */
export function terrainGradient(x: number, z: number, step = bay.grounding.gradientStep): Vec2 {
  return {
    x: (terrainHeight(x + step, z) - terrainHeight(x - step, z)) / (2 * step),
    z: (terrainHeight(x, z + step) - terrainHeight(x, z - step)) / (2 * step),
  };
}

export const LANDMARKS: readonly Landmark[] = bay.landmarks.map((l) => ({
  ...l,
  kind: l.kind as LandmarkKind,
  base: Math.max(0, terrainHeight(l.x, l.z)),
}));

// --- Baked grid (render mesh, water depth texture, chart) --------------------------------------

export interface TerrainGrid {
  minX: number;
  minZ: number;
  cell: number;
  /** Samples per row (x) and number of rows (z). */
  columns: number;
  rows: number;
  /** Row-major elevations: heights[row * columns + column] at (minX + column * cell, minZ + row * cell). */
  heights: Float32Array;
}

let baked: TerrainGrid | null = null;

/** The elevation sampled on data/bay.json `grid`, baked once on first use. */
export function terrainGrid(): TerrainGrid {
  if (baked) return baked;
  const { minX, maxX, minZ, maxZ, cell } = bay.grid;
  const columns = Math.round((maxX - minX) / cell) + 1;
  const rows = Math.round((maxZ - minZ) / cell) + 1;
  const heights = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      heights[row * columns + column] = terrainHeight(minX + column * cell, minZ + row * cell);
    }
  }
  baked = { minX, minZ, cell, columns, rows, heights };
  return baked;
}
