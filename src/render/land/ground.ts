/**
 * Ground sampling on the baked terrain grid, consistent with the rendered mesh: each cell is split
 * along the diagonal whose corners differ least in height, and `groundHeight` interpolates on that
 * same triangle, so trees, houses and landmark feet sit exactly on the drawn surface.
 * Also a small seeded PRNG for deterministic placement.
 */
import type { TerrainGrid } from '../../sim/terrain';

/** True when cell (column, row) is split along its a-d diagonal ((c, r) to (c + 1, r + 1)). */
export function splitsMainDiagonal(grid: TerrainGrid, column: number, row: number): boolean {
  const h = grid.heights, n = grid.columns, i = row * n + column;
  return Math.abs(h[i]! - h[i + n + 1]!) <= Math.abs(h[i + 1]! - h[i + n]!);
}

/** Elevation of the rendered terrain surface at logical world (x, z), m; clamped to the grid. */
export function groundHeight(grid: TerrainGrid, x: number, z: number): number {
  const u = Math.min(Math.max((x - grid.minX) / grid.cell, 0), grid.columns - 1.000001);
  const v = Math.min(Math.max((z - grid.minZ) / grid.cell, 0), grid.rows - 1.000001);
  const column = Math.floor(u), row = Math.floor(v);
  const fx = u - column, fz = v - row;
  const h = grid.heights, n = grid.columns, i = row * n + column;
  const a = h[i]!, b = h[i + 1]!, c = h[i + n]!, d = h[i + n + 1]!;
  if (splitsMainDiagonal(grid, column, row)) {
    return fx > fz ? a + (b - a) * fx + (d - b) * fz : a + (d - c) * fx + (c - a) * fz;
  }
  return fx + fz < 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
}

/** Smooth gradient (dh/dx, dh/dz) of the grid at a sample, by central differences. */
export function sampleGradient(grid: TerrainGrid, column: number, row: number): [number, number] {
  const h = grid.heights, n = grid.columns;
  const c0 = Math.max(column - 1, 0), c1 = Math.min(column + 1, n - 1);
  const r0 = Math.max(row - 1, 0), r1 = Math.min(row + 1, grid.rows - 1);
  return [
    (h[row * n + c1]! - h[row * n + c0]!) / ((c1 - c0) * grid.cell),
    (h[r1 * n + column]! - h[r0 * n + column]!) / ((r1 - r0) * grid.cell),
  ];
}

/** Gradient of the grid at logical world (x, z), from the nearest sample. */
export function groundGradient(grid: TerrainGrid, x: number, z: number): [number, number] {
  const column = Math.min(Math.max(Math.round((x - grid.minX) / grid.cell), 0), grid.columns - 1);
  const row = Math.min(Math.max(Math.round((z - grid.minZ) / grid.cell), 0), grid.rows - 1);
  return sampleGradient(grid, column, row);
}

/** Seeded uniform PRNG in [0, 1) (mulberry32): the same seed always places the same land. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Distance from every grid sample to the nearest water sample (elevation below 0), m, by a two-pass
 * 8-neighbour chamfer transform (within about 8% of Euclidean). Setup only.
 */
export function waterDistance(grid: TerrainGrid): Float32Array {
  const { columns: n, rows, cell, heights } = grid;
  const d = new Float32Array(n * rows);
  for (let i = 0; i < d.length; i++) d[i] = heights[i]! < 0 ? 0 : Infinity;
  const diagonal = cell * Math.SQRT2;
  const relax = (i: number, j: number, step: number): void => {
    if (d[j]! + step < d[i]!) d[i] = d[j]! + step;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (c > 0) relax(i, i - 1, cell);
      if (r > 0) {
        relax(i, i - n, cell);
        if (c > 0) relax(i, i - n - 1, diagonal);
        if (c < n - 1) relax(i, i - n + 1, diagonal);
      }
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = n - 1; c >= 0; c--) {
      const i = r * n + c;
      if (c < n - 1) relax(i, i + 1, cell);
      if (r < rows - 1) {
        relax(i, i + n, cell);
        if (c < n - 1) relax(i, i + n + 1, diagonal);
        if (c > 0) relax(i, i + n - 1, diagonal);
      }
    }
  }
  return d;
}

/** Value of a per-sample field at the sample nearest logical world (x, z). */
export function nearestSample(grid: TerrainGrid, field: Float32Array, x: number, z: number): number {
  const column = Math.min(Math.max(Math.round((x - grid.minX) / grid.cell), 0), grid.columns - 1);
  const row = Math.min(Math.max(Math.round((z - grid.minZ) / grid.cell), 0), grid.rows - 1);
  return field[row * grid.columns + column]!;
}

/** Discs on the ground plane with a bucket grid, for keep-clear tests during placement. */
export class Footprints {
  private readonly buckets = new Map<number, number[]>();
  private readonly discs: number[] = [];
  private largest = 0;

  constructor(private readonly bucket: number) {}

  private key(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  add(x: number, z: number, radius: number): void {
    const index = this.discs.length;
    this.discs.push(x, z, radius);
    this.largest = Math.max(this.largest, radius);
    const key = this.key(Math.floor(x / this.bucket), Math.floor(z / this.bucket));
    const list = this.buckets.get(key);
    if (list) list.push(index);
    else this.buckets.set(key, [index]);
  }

  /** True when a disc of `radius` at (x, z) overlaps any stored disc. */
  overlaps(x: number, z: number, radius: number): boolean {
    const ix = Math.floor(x / this.bucket), iz = Math.floor(z / this.bucket);
    const reach = 1 + Math.ceil((radius + this.largest) / this.bucket);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const list = this.buckets.get(this.key(ix + dx, iz + dz));
        if (!list) continue;
        for (const i of list) {
          const r = radius + this.discs[i + 2]!;
          if ((x - this.discs[i]!) ** 2 + (z - this.discs[i + 1]!) ** 2 < r * r) return true;
        }
      }
    }
    return false;
  }
}
