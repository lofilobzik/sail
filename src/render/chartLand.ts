/**
 * The printed part of the chart: land and depth tints, the coastline, depth and height contours.
 * Baked once from the shared terrain grid in world coordinates; the page only transforms it.
 */
import { chartColour, contourSegments } from '../nav/chartPrint';
import { NAVIGATION } from '../nav/navigation';
import { terrainGrid, type TerrainGrid } from '../sim/terrain';

export interface ChartLand {
  grid: TerrainGrid;
  /** One pixel per grid sample, centred on it. */
  tint: HTMLCanvasElement;
  /** World-coordinate paths: the coastline, then each depth and height contour. */
  coast: Path2D;
  depths: Path2D[];
  heights: Path2D;
}

/** Appends the contour at `level` to `path` in world metres. */
function addContour(grid: TerrainGrid, level: number, path: Path2D): void {
  contourSegments(grid, level, (x0, z0, x1, z1) => { path.moveTo(x0, z0); path.lineTo(x1, z1); });
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
    const [r, g, b] = chartColour(grid.heights[i]!);
    image.data[i * 4] = r!; image.data[i * 4 + 1] = g!; image.data[i * 4 + 2] = b!; image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const coast = new Path2D();
  addContour(grid, 0, coast);
  const depths = NAVIGATION.visual.chartDepthContours.map((depth) => {
    const path = new Path2D();
    addContour(grid, -depth, path);
    return path;
  });
  const heights = new Path2D();
  for (const height of NAVIGATION.visual.chartHeightContours) addContour(grid, height, heights);
  baked = { grid, tint, coast, depths, heights };
  return baked;
}
