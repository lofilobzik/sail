import { describe, expect, it } from 'vitest';
import navigation from '../../data/navigation.json';
import { BAY, terrainHeight } from './terrain';

const departure = BAY.harbour.departure;

describe('Westcove Harbour', () => {
  it('starts navigation from the departure point', () => {
    expect(navigation.start).toEqual({ x: departure.x, z: departure.z });
  });

  it('floats the departure in sheltered deep water, with the quay and mole standing above the sea', () => {
    expect(terrainHeight(departure.x, departure.z)).toBeLessThan(-4);
    for (const r of BAY.harbour.reclaimed.filter((q) => q.name === 'Quay' || q.name === 'Mole')) {
      expect(terrainHeight((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2)).toBeCloseTo(r.height, 6);
    }
  });

  it('keeps the dredged basin at least as deep as asked', () => {
    for (const d of BAY.harbour.dredged) {
      for (const [x, z] of [[d.x0, d.z0], [d.x1, d.z1], [(d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2]] as const) {
        expect(terrainHeight(x, z)).toBeLessThanOrEqual(-d.depth + 1e-9);
      }
    }
  });
});
