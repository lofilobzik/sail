/**
 * Land surface from the baked terrain grid: square tiles of grid cells (frustum-culled separately),
 * triangles only where a cell reaches near the waterline, smooth normals from the whole grid (no
 * seams between tiles) and vertex colours from height, slope and seeded noise. Vertices are logical
 * world coordinates; the owning group is rebased with the floating origin.
 */
import * as THREE from 'three';
import { BAY, fbm, type TerrainGrid } from '../../sim/terrain';
import { sampleGradient } from './ground';

const TILE_CELLS = 64; // VISUAL ESTIMATE: 1.28 km tiles; few draw calls, off-screen tiles culled
// Cells whose highest corner is deeper than this are skipped: the opaque water hides them.
const HIDDEN_DEPTH = -12; // m, VISUAL ESTIMATE: well below the deepest wave trough
const SKIRT_DEPTH = -20; // m, VISUAL ESTIMATE: grid-edge skirt bottom, below HIDDEN_DEPTH
// Distance levels of detail, VISUAL ESTIMATE: past 2 km a 20 m cell is a few pixels wide, past 4.5 km
// a 80 m cell still is. Coarser tiles keep the tile edges' skirts, so neighbours never show cracks.
const TERRAIN_LODS = [{ stride: 1, from: 0 }, { stride: 2, from: 2000 }, { stride: 4, from: 4500 }];
const LOD_HYSTERESIS = 0.1; // fraction of the distance, so a tile at a boundary does not flicker

// Palette (sRGB), all VISUAL ESTIMATE from photographs of temperate sandy/grassy coasts.
const SEABED_SHALLOW = 0xc4b28a; // rippled sand just under the surface
const SEABED_DEEP = 0x7d7a62; // weedy sand a few metres down
const WET_SAND = 0xa89272;
const DRY_SAND = 0xd9c7a0;
const GRASS_LUSH = 0x4b662f;
const GRASS_DRY = 0x8a8a4e;
const SCRUB = 0x565b3a; // heath and scrub on higher ground
const WOODLAND = 0x2e4126; // canopy seen from afar
const ROCK = 0x8d877c;
const ROCK_DARK = 0x67635b;

// Material bands, all VISUAL ESTIMATE.
const SAND_TOP = 2.2; // m: dry sand gives way to grass, plus or minus SAND_TOP_NOISE
const SAND_TOP_NOISE = 0.8; // m
const SAND_BLEND = 1.2; // m over which sand fades into grass
const WET_SAND_TOP = 0.6; // m: swash zone
const SEABED_FADE_DEPTH = 6; // m: shallow sand to deeper seabed
const ROCK_SLOPE_FROM = 0.3; // rise/run where grass starts to break into rock
const ROCK_SLOPE_FULL = 0.5; // rise/run where it is all rock
const ROCK_HEIGHT_FROM = 120; // m: bare high ground begins (mainland hills reach about 220 m)
const ROCK_HEIGHT_FULL = 210; // m
const SCRUB_HEIGHT = 60; // m: grass turns to scrub/heath above this, broken by noise
const PATCH_WAVELENGTH = 170; // m: grass/scrub patchiness
const TONE_WAVELENGTH = 520; // m: broad lush/dry variation
const OUTCROP_WAVELENGTH = 90; // m: rock outcrop noise
const WOOD_WAVELENGTH = 420; // m: size of wooded patches
const WOOD_FROM = 0.0; // woodland noise (fbm in [-1, 1]) where woods begin ...
const WOOD_FULL = 0.25; // ... and where they are dense
const WOOD_SHADE = 0.75; // how far the ground under dense woods darkens to WOODLAND
const NOISE_SEED = BAY.seed + 211; // offset so land colour noise is independent of the relief noise

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

const linear = (hex: number): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const P = {
  seabedShallow: linear(SEABED_SHALLOW), seabedDeep: linear(SEABED_DEEP), wetSand: linear(WET_SAND),
  drySand: linear(DRY_SAND), grassLush: linear(GRASS_LUSH), grassDry: linear(GRASS_DRY), scrub: linear(SCRUB),
  woodland: linear(WOODLAND), rock: linear(ROCK), rockDark: linear(ROCK_DARK),
};

/**
 * Woodland density 0..1 from a seeded noise mask. Tree clumps grow where it is high, and the
 * ground there darkens, so woods still read on far hills where single trees are sub-pixel.
 */
export function woodAmount(x: number, z: number): number {
  return smoothstep(WOOD_FROM, WOOD_FULL, fbm(x / WOOD_WAVELENGTH, z / WOOD_WAVELENGTH, 3, BAY.seed + 301));
}

/** Fraction of rock at a point, 0..1; trees and houses also use it to stay off bare ground. */
export function rockAmount(x: number, z: number, height: number, slope: number): number {
  const outcrop = fbm(x / OUTCROP_WAVELENGTH, z / OUTCROP_WAVELENGTH, 3, NOISE_SEED + 7);
  const bySlope = smoothstep(ROCK_SLOPE_FROM, ROCK_SLOPE_FULL, slope + 0.12 * outcrop);
  const byHeight = smoothstep(ROCK_HEIGHT_FROM, ROCK_HEIGHT_FULL, height + 60 * outcrop);
  return Math.max(bySlope, byHeight);
}

/** Component-wise lerp into `into` (which may alias `a` or `b`). */
function mix(a: readonly number[], b: readonly number[], t: number, into: number[]): number[] {
  for (let k = 0; k < 3; k++) into[k] = a[k]! + (b[k]! - a[k]!) * t;
  return into;
}
const colour = [0, 0, 0], sand = [0, 0, 0], grass = [0, 0, 0], rock = [0, 0, 0];

/** Linear vertex colour for one grid sample, written to `out` at `o`. */
function landColour(x: number, z: number, h: number, slope: number, out: Float32Array, o: number): void {
  const c = colour;
  if (h < 0) {
    mix(P.seabedShallow, P.seabedDeep, smoothstep(0, SEABED_FADE_DEPTH, -h), c);
    mix(P.wetSand, c, smoothstep(0, 0.6, -h), c);
  } else {
    const patch = fbm(x / PATCH_WAVELENGTH, z / PATCH_WAVELENGTH, 3, NOISE_SEED);
    const tone = fbm(x / TONE_WAVELENGTH, z / TONE_WAVELENGTH, 2, NOISE_SEED + 3);
    mix(P.wetSand, P.drySand, smoothstep(0.1, WET_SAND_TOP, h), sand);
    mix(P.grassLush, P.grassDry, smoothstep(-0.45, 0.45, tone + 0.5 * patch), grass);
    mix(grass, P.scrub, smoothstep(0.1, 0.6, (h - SCRUB_HEIGHT) / SCRUB_HEIGHT + patch), grass);
    mix(grass, P.woodland, WOOD_SHADE * woodAmount(x, z), grass);
    mix(P.rock, P.rockDark, 0.5 + 0.5 * patch, rock);
    const sandTop = SAND_TOP + SAND_TOP_NOISE * patch;
    const sandAmount = 1 - smoothstep(sandTop, sandTop + SAND_BLEND, h);
    mix(grass, rock, rockAmount(x, z, h, slope), c);
    mix(c, sand, sandAmount, c);
  }
  out[o] = c[0]!; out[o + 1] = c[1]!; out[o + 2] = c[2]!;
}

/**
 * One tile's geometry at `stride` grid cells per triangle pair (1 = every grid sample), or null if
 * every cell in it lies deeper than HIDDEN_DEPTH. Coordinates are logical world, not tile-relative.
 */
function buildTile(grid: TerrainGrid, column0: number, row0: number, stride: number): THREE.BufferGeometry | null {
  const { heights, columns, rows, cell, minX, minZ } = grid;
  const column1 = Math.min(column0 + TILE_CELLS, columns - 1);
  const row1 = Math.min(row0 + TILE_CELLS, rows - 1);
  const width = column1 - column0 + 1;
  const local = new Int32Array(width * (row1 - row0 + 1)).fill(-1);
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  /** Central-difference gradient over `stride` cells each way: coarse meshes get matching smooth normals. */
  const gradient = (column: number, row: number): [number, number] => {
    const c0 = Math.max(column - stride, 0), c1 = Math.min(column + stride, columns - 1);
    const r0 = Math.max(row - stride, 0), r1 = Math.min(row + stride, rows - 1);
    return [
      (heights[row * columns + c1]! - heights[row * columns + c0]!) / ((c1 - c0) * cell),
      (heights[r1 * columns + column]! - heights[r0 * columns + column]!) / ((r1 - r0) * cell),
    ];
  };
  const vertex = (column: number, row: number): number => {
    const key = (row - row0) * width + (column - column0);
    if (local[key]! >= 0) return local[key]!;
    const index = positions.length / 3;
    local[key] = index;
    const [gx, gz] = stride === 1 ? sampleGradient(grid, column, row) : gradient(column, row);
    const length = Math.hypot(gx, 1, gz);
    positions.push(minX + column * cell, heights[row * columns + column]!, minZ + row * cell);
    normals.push(-gx / length, 1 / length, -gz / length);
    return index;
  };
  for (let row = row0; row < row1; row += stride) {
    const nextRow = Math.min(row + stride, row1);
    for (let column = column0; column < column1; column += stride) {
      const nextColumn = Math.min(column + stride, column1);
      const ha = heights[row * columns + column]!, hb = heights[row * columns + nextColumn]!;
      const hc = heights[nextRow * columns + column]!, hd = heights[nextRow * columns + nextColumn]!;
      if (Math.max(ha, hb, hc, hd) < HIDDEN_DEPTH) continue;
      const a = vertex(column, row), b = vertex(nextColumn, row);
      const c = vertex(column, nextRow), d = vertex(nextColumn, nextRow);
      // Counter-clockwise seen from above (+y), with x east and z south; the diagonal joins the
      // corners that differ least in height (the same rule as ground.ts, so stride 1 matches it).
      if (Math.abs(ha - hd) <= Math.abs(hb - hc)) indices.push(a, d, b, a, c, d);
      else indices.push(a, c, b, b, c, d);
    }
  }
  if (indices.length === 0) return null;
  // Skirts hang down along every tile edge. On the outer grid edge they hide the cut where the land
  // runs on beyond the bake; between tiles they hide the hairline cracks where neighbours of
  // different detail meet, so they take the terrain's own colour there.
  const topOf = new Map<number, number>();
  const skirt = (column: number, row: number, nextColumn: number, nextRow: number, outward: [number, number], inner: boolean): void => {
    if (!edgeUsed(column, row) || !edgeUsed(nextColumn, nextRow)) return;
    const p = vertex(column, row), q = vertex(nextColumn, nextRow);
    const base = positions.length / 3;
    [p, q].forEach((v, k) => {
      positions.push(positions[v * 3]!, SKIRT_DEPTH, positions[v * 3 + 2]!);
      normals.push(outward[0], 0, outward[1]);
      if (inner) topOf.set(base + k, v);
    });
    // Faces outward: p, q along the edge with the outward side on the right seen from above.
    indices.push(p, base, q, q, base, base + 1);
  };
  function edgeUsed(column: number, row: number): boolean {
    return local[(row - row0) * width + (column - column0)]! >= 0;
  }
  for (let c = column0; c < column1; c += stride) {
    const n = Math.min(c + stride, column1);
    skirt(n, row0, c, row0, [0, -1], row0 !== 0);
    skirt(c, row1, n, row1, [0, 1], row1 !== rows - 1);
  }
  for (let r = row0; r < row1; r += stride) {
    const n = Math.min(r + stride, row1);
    skirt(column0, r, column0, n, [-1, 0], column0 !== 0);
    skirt(column1, n, column1, r, [1, 0], column1 !== columns - 1);
  }

  const count = positions.length / 3;
  const colours = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    const slope = Math.hypot(normals[v * 3]!, normals[v * 3 + 2]!) / Math.max(normals[v * 3 + 1]!, 1e-3);
    landColour(x, z, y, Math.min(slope, 10), colours, v * 3);
  }
  for (const [skirtVertex, top] of topOf) colours.copyWithin(skirtVertex * 3, top * 3, top * 3 + 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
  return geometry;
}

/**
 * All terrain tiles, each a LOD object that swaps to a coarser mesh with distance. Every level
 * shares the tile's vertex colouring and material; vertices are tile-relative, with the LOD object
 * placed at the tile's centre so the distance to the camera is the tile's. (The mirror pass sees the
 * same distances: its camera is the real one reflected, horizontally in the same place.)
 */
export function createTerrainMeshes(grid: TerrainGrid, material: THREE.Material): THREE.LOD[] {
  const tiles: THREE.LOD[] = [];
  for (let row0 = 0; row0 < grid.rows - 1; row0 += TILE_CELLS) {
    for (let column0 = 0; column0 < grid.columns - 1; column0 += TILE_CELLS) {
      const centreX = grid.minX + (column0 + Math.min(TILE_CELLS, grid.columns - 1 - column0) / 2) * grid.cell;
      const centreZ = grid.minZ + (row0 + Math.min(TILE_CELLS, grid.rows - 1 - row0) / 2) * grid.cell;
      const lod = new THREE.LOD();
      for (const level of TERRAIN_LODS) {
        const geometry = buildTile(grid, column0, row0, level.stride);
        if (!geometry) break;
        geometry.translate(-centreX, 0, -centreZ);
        geometry.computeBoundingSphere();
        lod.addLevel(new THREE.Mesh(geometry, material), level.from, level.from > 0 ? LOD_HYSTERESIS : 0);
      }
      if (lod.levels.length === 0) continue;
      lod.position.set(centreX, 0, centreZ);
      tiles.push(lod);
    }
  }
  return tiles;
}
