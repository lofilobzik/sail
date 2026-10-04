/**
 * The printed part of the chart: land and depth tints, the coastline, depth and height contours.
 * Baked once from the shared terrain grid in world coordinates; the page only transforms it.
 * Colours are VISUAL ESTIMATE, after the usual paper-chart convention (buff land, blue shallows).
 */
import { NAVIGATION } from '../nav/navigation';
import { terrainGrid, type TerrainGrid } from '../sim/terrain';

const LAND = [227, 207, 154];
const DRYING = [196, 214, 168];
const SHALLOW = [168, 205, 222];
const MID = [196, 222, 231];
const DEEP = [221, 228, 220]; // the plain chart paper

export interface ChartLand {
  grid: TerrainGrid;
  /** One pixel per grid sample, centred on it. */
  tint: HTMLCanvasElement;
  /** World-coordinate paths: the coastline, then each depth and height contour. */
  coast: Path2D;
  depths: Path2D[];
  heights: Path2D;
}

function colour(h: number): number[] {
  const levels = NAVIGATION.visual.chartDepthContours;
  if (h > 0) return LAND;
  if (h > -levels[0]!) return h > -0.5 ? DRYING : SHALLOW;
  if (h > -levels[1]!) return MID;
  return DEEP;
}

/** Marching squares: every segment where the grid crosses `level`, appended to `path` in world metres. */
function contour(grid: TerrainGrid, level: number, path: Path2D): void {
  const { heights, columns, rows, cell, minX, minZ } = grid;
  const v = (c: number, r: number) => heights[r * columns + c]! - level;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = v(c, r), b = v(c + 1, r), d = v(c, r + 1), e = v(c + 1, r + 1);
      const index = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (e > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (index === 0 || index === 15) continue;
      const x0 = minX + c * cell, z0 = minZ + r * cell;
      // Edge crossings: top (a-b), right (b-e), bottom (d-e), left (a-d).
      const top = (): [number, number] => [x0 + cell * a / (a - b), z0];
      const right = (): [number, number] => [x0 + cell, z0 + cell * b / (b - e)];
      const bottom = (): [number, number] => [x0 + cell * d / (d - e), z0 + cell];
      const left = (): [number, number] => [x0, z0 + cell * a / (a - d)];
      const line = (p: [number, number], q: [number, number]) => { path.moveTo(p[0], p[1]); path.lineTo(q[0], q[1]); };
      const centre = (a + b + d + e) / 4;
      switch (index) {
        case 1: case 14: line(left(), top()); break;
        case 2: case 13: line(top(), right()); break;
        case 3: case 12: line(left(), right()); break;
        case 4: case 11: line(right(), bottom()); break;
        case 6: case 9: line(top(), bottom()); break;
        case 7: case 8: line(left(), bottom()); break;
        // Saddles: the cell centre decides which corners connect.
        case 5:
          if (centre > 0) { line(left(), bottom()); line(top(), right()); } else { line(left(), top()); line(right(), bottom()); }
          break;
        case 10:
          if (centre > 0) { line(left(), top()); line(right(), bottom()); } else { line(left(), bottom()); line(top(), right()); }
          break;
      }
    }
  }
}

let baked: ChartLand | null = null;

export function chartLand(): ChartLand {
  if (baked) return baked;
  const grid = terrainGrid();
  const tint = document.createElement('canvas');
  tint.width = grid.columns;
  tint.height = grid.rows;
  const ctx = tint.getContext('2d')!;
  const image = ctx.createImageData(grid.columns, grid.rows);
  for (let i = 0; i < grid.heights.length; i++) {
    const [r, g, b] = colour(grid.heights[i]!);
    image.data[i * 4] = r!; image.data[i * 4 + 1] = g!; image.data[i * 4 + 2] = b!; image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const coast = new Path2D();
  contour(grid, 0, coast);
  const depths = NAVIGATION.visual.chartDepthContours.map((depth) => {
    const path = new Path2D();
    contour(grid, -depth, path);
    return path;
  });
  const heights = new Path2D();
  for (const height of NAVIGATION.visual.chartHeightContours) contour(grid, height, heights);
  baked = { grid, tint, coast, depths, heights };
  return baked;
}
