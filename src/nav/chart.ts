/** Paper chart projection, independent of Three.js, the floating origin, and the true boat position. */
import { clamp, type Vec2 } from '../sim/frames';
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

  pan(dx: number, dy: number): void {
    this.center.x -= dx * this.span / this.rect.width;
    this.center.z -= dy * this.span / this.rect.width;
  }

  /** Keep the chart point under the mouse fixed while zooming, with bounded scale. */
  zoom(point: PaperPoint, direction: number): void {
    const before = this.toWorld(point);
    const visual = NAVIGATION.visual;
    this.span = clamp(this.span * visual.chartZoomFactor ** Math.sign(direction), visual.minChartSpan, visual.maxChartSpan);
    const after = this.toWorld(point);
    this.center.x += before.x - after.x;
    this.center.z += before.z - after.z;
  }

  reset(): void {
    this.center = { ...NAVIGATION.start };
    this.span = NAVIGATION.visual.chartSpan;
  }
}
