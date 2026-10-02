/** Paper chart projection, independent of Three.js, the floating origin, and the true boat position. */
import type { Vec2 } from '../sim/frames';
import { NAVIGATION } from './navigation';

export interface PaperPoint { x: number; y: number }
export interface PaperRect extends PaperPoint { width: number; height: number }

export function contains(rect: PaperRect, point: PaperPoint): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export class ChartProjection {
  center: Vec2 = { ...NAVIGATION.start };
  span = NAVIGATION.visual.chartSpan;

  constructor(readonly rect: PaperRect) {}

  toPaper(point: Vec2): PaperPoint {
    const scale = this.rect.width / this.span;
    return {
      x: this.rect.x + this.rect.width / 2 + (point.x - this.center.x) * scale,
      y: this.rect.y + this.rect.height / 2 + (point.z - this.center.z) * scale,
    };
  }

  toWorld(point: PaperPoint): Vec2 {
    const scale = this.span / this.rect.width;
    return {
      x: this.center.x + (point.x - this.rect.x - this.rect.width / 2) * scale,
      z: this.center.z + (point.y - this.rect.y - this.rect.height / 2) * scale,
    };
  }

  /** Frame every point with a margin, never tighter than the minimum span. North stays up. */
  fit(points: readonly Vec2[]): void {
    if (!points.length) return;
    const visual = NAVIGATION.visual;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    this.center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    // The span is the paper width in metres, so a tall extent needs a proportionally wider span.
    const needed = Math.max(maxX - minX, (maxZ - minZ) * this.rect.width / this.rect.height);
    this.span = Math.max(needed * visual.chartFitPadding, visual.minChartSpan);
  }

  reset(): void {
    this.center = { ...NAVIGATION.start };
    this.span = NAVIGATION.visual.chartSpan;
  }
}
