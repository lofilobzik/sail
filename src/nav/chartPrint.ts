/**
 * Pure tint palette and world-space contour segments for the printed chart (render/chartLand.ts).
 * Browser play and headless export both use that same canvas renderer.
 * Colours are VISUAL ESTIMATE, after the usual paper-chart convention (buff land, blue shallows).
 */
import type { TerrainGrid } from '../sim/terrain';
import { NAVIGATION } from './navigation';

export const LAND = [227, 207, 154];
export const DRYING = [196, 214, 168];
export const SHALLOW = [168, 205, 222];
export const MID = [196, 222, 231];
export const DEEP = [221, 228, 220]; // the plain chart paper

export function chartColour(h: number): number[] {
  const levels = NAVIGATION.visual.chartDepthContours;
  if (h > 0) return LAND;
  if (h > -levels[0]!) return h > -0.5 ? DRYING : SHALLOW;
  if (h > -levels[1]!) return MID;
  return DEEP;
}

export type Segment = (x0: number, z0: number, x1: number, z1: number) => void;

/** Marching squares: every segment where the grid crosses `level`, reported in world metres. */
export function contourSegments(grid: TerrainGrid, level: number, emit: Segment): void {
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
      const line = (p: [number, number], q: [number, number]) => emit(p[0], p[1], q[0], q[1]);
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
