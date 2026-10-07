/**
 * Land surface from the baked terrain grid: square tiles of grid cells (frustum-culled separately),
 * triangles only where a cell reaches near the waterline, smooth normals from the whole grid (no
 * seams between tiles) and vertex colours from height, slope and seeded noise. Vertices are logical
 * world coordinates; the owning group is rebased with the floating origin.
 */
import * as THREE from 'three';
import { BAY, fbm, rectWeight, type TerrainGrid } from '../../sim/terrain';
import { sampleGradient, splitsMainDiagonal } from './ground';

const TILE_CELLS = 64; // VISUAL ESTIMATE: 1.28 km tiles; few draw calls, off-screen tiles culled
// Cells whose highest corner is deeper than this are skipped: the opaque water hides them.
const HIDDEN_DEPTH = -12; // m, VISUAL ESTIMATE: well below the deepest wave trough
const SKIRT_DEPTH = -20; // m, VISUAL ESTIMATE: grid-edge skirt bottom, below HIDDEN_DEPTH

// Rubble stone where the harbour's quay and mole slope into the water, so the 20 m terrain grid's
// ramp in front of their crisp slabs reads as a stone revetment instead of a sandy beach.
const RUBBLE = 0x6f6d68;
const RUBBLE_DARK = 0x4d4c49;
const PAVED = BAY.harbour.reclaimed.filter((r) => 'paved' in r && r.paved);

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
  rubble: linear(RUBBLE), rubbleDark: linear(RUBBLE_DARK),
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
  const stone = harbourStone(x, z);
  if (stone > 0) {
    mix(P.rubble, P.rubbleDark, 0.5 + 0.5 * fbm(x / PATCH_WAVELENGTH, z / PATCH_WAVELENGTH, 2, NOISE_SEED + 19), rock);
    mix(c, rock, stone, c);
  }
  out[o] = c[0]!; out[o + 1] = c[1]!; out[o + 2] = c[2]!;
}

/** 0..1: how much of the quay and mole's slope this point lies on (1 inside, easing out over each rectangle's edge). */
function harbourStone(x: number, z: number): number {
  let w = 0;
  for (const r of PAVED) w = Math.max(w, rectWeight(r, x, z));
  return w;
}

/** One tile's geometry, or null if every cell in it lies deeper than HIDDEN_DEPTH. */
function buildTile(grid: TerrainGrid, column0: number, row0: number): THREE.BufferGeometry | null {
  const { heights, columns, rows, cell, minX, minZ } = grid;
  const column1 = Math.min(column0 + TILE_CELLS, columns - 1);
  const row1 = Math.min(row0 + TILE_CELLS, rows - 1);
  const width = column1 - column0 + 1;
  const local = new Int32Array(width * (row1 - row0 + 1)).fill(-1);
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const vertex = (column: number, row: number): number => {
    const key = (row - row0) * width + (column - column0);
    if (local[key]! >= 0) return local[key]!;
    const index = positions.length / 3;
    local[key] = index;
    const [gx, gz] = sampleGradient(grid, column, row);
    const length = Math.hypot(gx, 1, gz);
    positions.push(minX + column * cell, heights[row * columns + column]!, minZ + row * cell);
    normals.push(-gx / length, 1 / length, -gz / length);
    return index;
  };
  for (let row = row0; row < row1; row++) {
    for (let column = column0; column < column1; column++) {
      const i = row * columns + column;
      const top = Math.max(heights[i]!, heights[i + 1]!, heights[i + columns]!, heights[i + columns + 1]!);
      if (top < HIDDEN_DEPTH) continue;
      const a = vertex(column, row), b = vertex(column + 1, row);
      const c = vertex(column, row + 1), d = vertex(column + 1, row + 1);
      // Counter-clockwise seen from above (+y), with x east and z south.
      if (splitsMainDiagonal(grid, column, row)) indices.push(a, d, b, a, c, d);
      else indices.push(a, c, b, b, c, d);
    }
  }
  if (indices.length === 0) return null;
  // Skirts along the outer grid edge hide the cut where the land runs on beyond the bake.
  const skirt = (column: number, row: number, nextColumn: number, nextRow: number, outward: [number, number]): void => {
    const p = vertex(column, row), q = vertex(nextColumn, nextRow);
    const base = positions.length / 3;
    for (const v of [p, q]) {
      positions.push(positions[v * 3]!, SKIRT_DEPTH, positions[v * 3 + 2]!);
      normals.push(outward[0], 0, outward[1]);
    }
    // Faces outward: p, q along the edge with the outward side on the right seen from above.
    indices.push(p, base, q, q, base, base + 1);
  };
  const edgeUsed = (column: number, row: number): boolean => local[(row - row0) * width + (column - column0)]! >= 0;
  if (row0 === 0) for (let c = column0; c < column1; c++) if (edgeUsed(c, 0) && edgeUsed(c + 1, 0)) skirt(c + 1, 0, c, 0, [0, -1]);
  if (row1 === rows - 1) for (let c = column0; c < column1; c++) if (edgeUsed(c, row1) && edgeUsed(c + 1, row1)) skirt(c, row1, c + 1, row1, [0, 1]);
  if (column0 === 0) for (let r = row0; r < row1; r++) if (edgeUsed(0, r) && edgeUsed(0, r + 1)) skirt(0, r, 0, r + 1, [-1, 0]);
  if (column1 === columns - 1) for (let r = row0; r < row1; r++) if (edgeUsed(column1, r) && edgeUsed(column1, r + 1)) skirt(column1, r + 1, column1, r, [1, 0]);

  const count = positions.length / 3;
  const colours = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    const slope = Math.hypot(normals[v * 3]!, normals[v * 3 + 2]!) / Math.max(normals[v * 3 + 1]!, 1e-3);
    landColour(x, z, y, Math.min(slope, 10), colours, v * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** All terrain tiles as meshes sharing one vertex-coloured lit material. */
export function createTerrainMeshes(grid: TerrainGrid, material: THREE.Material): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (let row0 = 0; row0 < grid.rows - 1; row0 += TILE_CELLS) {
    for (let column0 = 0; column0 < grid.columns - 1; column0 += TILE_CELLS) {
      const geometry = buildTile(grid, column0, row0);
      if (geometry) meshes.push(new THREE.Mesh(geometry, material));
    }
  }
  return meshes;
}
