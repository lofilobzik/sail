import { describe, expect, it } from 'vitest';
import { ChartProjection } from './chart';
import { NAVIGATION } from './navigation';

describe('paper chart', () => {
  const rect = { x: 50, y: 100, width: 600, height: 500 };

  it('keeps north at the top and east to the right, and inverts at distant logical coordinates', () => {
    const chart = new ChartProjection(rect);
    const center = chart.toPaper({ x: 0, z: 0 });
    expect(chart.toPaper({ x: 0, z: -150 }).y).toBeLessThan(center.y);
    expect(chart.toPaper({ x: 150, z: 0 }).x).toBeGreaterThan(center.x);
    chart.center = { x: 1e9, z: -1e9 };
    const world = { x: 1e9 + 75, z: -1e9 - 125 };
    expect(chart.toWorld(chart.toPaper(world))).toEqual(world);
  });

  it('frames every point inside the paper with a margin, wide or tall, and never tighter than the minimum span', () => {
    const chart = new ChartProjection(rect);
    const points = [{ x: -300, z: -380 }, { x: 550, z: 100 }, { x: 150, z: 400 }];
    chart.fit(points);
    for (const p of points) {
      const paper = chart.toPaper(p);
      expect(paper.x).toBeGreaterThan(rect.x);
      expect(paper.x).toBeLessThan(rect.x + rect.width);
      expect(paper.y).toBeGreaterThan(rect.y);
      expect(paper.y).toBeLessThan(rect.y + rect.height);
    }
    const tall = [{ x: 0, z: -2000 }, { x: 10, z: 2000 }];
    chart.fit(tall);
    expect(chart.toPaper(tall[0]!).y).toBeGreaterThan(rect.y);
    expect(chart.toPaper(tall[1]!).y).toBeLessThan(rect.y + rect.height);
    chart.fit([{ x: 5, z: 5 }]);
    expect(chart.span).toBe(NAVIGATION.visual.minChartSpan);
    expect(chart.center).toEqual({ x: 5, z: 5 });
    chart.reset();
    expect(chart.center).toEqual(NAVIGATION.start);
  });
});
