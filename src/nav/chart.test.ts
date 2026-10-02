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

  it('pans and zooms around the mouse without changing the surveyed buoy coordinates', () => {
    const chart = new ChartProjection(rect);
    const mouse = { x: 170, y: 220 };
    const before = chart.toWorld(mouse);
    chart.zoom(mouse, -1);
    const after = chart.toWorld(mouse);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.z).toBeCloseTo(before.z, 10);
    const paper = chart.toPaper(before);
    chart.pan(20, -30);
    expect(chart.toPaper(before).x).toBeCloseTo(paper.x + 20, 10);
    expect(chart.toPaper(before).y).toBeCloseTo(paper.y - 30, 10);
    for (let i = 0; i < 100; i++) chart.zoom(mouse, -1);
    expect(chart.span).toBe(NAVIGATION.visual.minChartSpan);
    for (let i = 0; i < 100; i++) chart.zoom(mouse, 1);
    expect(chart.span).toBe(NAVIGATION.visual.maxChartSpan);
    chart.reset();
    expect(chart.center).toEqual(NAVIGATION.start);
  });
});
