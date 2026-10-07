import { describe, expect, it } from 'vitest';
import { BAY, terrainGrid } from '../../sim/terrain';
import { beltAmount } from './forest';
import { Footprints, groundHeight, waterDistance } from './ground';
import { placeHouses } from './houses';
import { ROADS, sampleRoad } from './roads';
import { placeTrees } from './trees';

const grid = terrainGrid();
const shore = waterDistance(grid);
const hillRoad = sampleRoad(ROADS.find((r) => r.name === 'Hill Road')!, 10, grid);

describe('the forest belt behind Westcove', () => {
  // A quarter of the way along Hill Road: north of the terraced middle of town, where Upper Lane runs.
  const mid = hillRoad[Math.floor(hillRoad.length / 4)]!;
  const uphill = (p: typeof mid, metres: number) => beltAmount(p.x - p.nx * metres, p.z - p.nz * metres);

  it('starts clear of the road and the houses beside it, then fills the hillside above', () => {
    expect(uphill(mid, 0)).toBe(0);
    expect(uphill(mid, 10)).toBe(0);
    expect(uphill(mid, 90)).toBeGreaterThan(0.9);
    expect(uphill(mid, 250)).toBeGreaterThan(0.9);
    expect(uphill(mid, 700)).toBe(0);
  });

  it('begins above Upper Lane through the middle of town, leaving its terrace to the houses', () => {
    const lane = sampleRoad(ROADS.find((r) => r.name === 'Upper Lane')!, 10, grid);
    const centre = lane[Math.floor(lane.length / 2)]!;
    const along = (metres: number) => beltAmount(centre.x - centre.nx * metres, centre.z - centre.nz * metres);
    expect(along(-40)).toBe(0); // between Hill Road and Upper Lane
    expect(along(0)).toBe(0);
    expect(along(120)).toBeGreaterThan(0.9);
  });

  it('is absent on the water side of the road, at the harbour and across the bay, and fades toward the ends', () => {
    expect(uphill(mid, -60)).toBe(0);
    expect(beltAmount(-1700, 760)).toBe(0);
    expect(beltAmount(900, -1200)).toBe(0);
    expect(uphill(hillRoad[0]!, 120)).toBeLessThan(0.05);
    expect(uphill(hillRoad[hillRoad.length - 1]!, 120)).toBeLessThan(0.05);
  });
});

describe('trees across the land', () => {
  const houses = placeHouses(grid, shore);
  const plots = new Footprints(16);
  for (const h of houses) plots.add(h.x, h.z, 0.5 * Math.hypot(h.length, h.width));
  for (const road of ROADS) for (const p of sampleRoad(road, 5, grid)) plots.add(p.x, p.z, road.width / 2 + 2);
  const trees = placeTrees(grid, shore, plots);

  it('covers the land in numbers, mostly dark conifers', () => {
    expect(trees.length).toBeGreaterThan(40000);
    const conifers = trees.filter((t) => t.conifer).length;
    expect(conifers / trees.length).toBeGreaterThan(0.6);
  });

  it('never stands on the beach, the harbour works (not the town terraces), a road or a house plot', () => {
    for (const t of trees) {
      expect(groundHeight(grid, t.x, t.z)).toBeGreaterThanOrEqual(3.5);
      for (const r of BAY.harbour.reclaimed.filter((q) => !('houses' in q && q.houses))) {
        expect(t.x > r.x0 - 25 && t.x < r.x1 + 25 && t.z > r.z0 - 25 && t.z < r.z1 + 25).toBe(false);
      }
    }
    expect(trees.every((t) => !plots.overlaps(t.x, t.z, 1.5))).toBe(true);
  });

  it('is deterministic, with narrow firs and taller trees in the belt', () => {
    expect(placeTrees(grid, shore, plots).length).toBe(trees.length);
    const inBelt = trees.filter((t) => t.conifer && beltAmount(t.x, t.z) > 0.5);
    const outside = trees.filter((t) => t.conifer && beltAmount(t.x, t.z) === 0);
    expect(inBelt.length).toBeGreaterThan(1000);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(inBelt.map((t) => t.height))).toBeGreaterThan(mean(outside.map((t) => t.height)));
    expect(mean(inBelt.map((t) => t.shade))).toBeLessThan(mean(outside.map((t) => t.shade)));
    for (const t of inBelt.slice(0, 500)) expect(t.width / t.height).toBeLessThan(0.7);
  });
});
