import { describe, expect, it } from 'vitest';
import buoyData from '../../data/buoys.json';
import sailDesigns from '../../data/sail-designs.json';
import { CHALLENGES, lockedSails } from './challengeInfo';

describe('challenge catalogue', () => {
  it('rewards only sail designs that exist', () => {
    const ids = sailDesigns.designs.map((d) => d.id);
    for (const c of CHALLENGES) if (c.reward) expect(ids).toContain(c.reward.id);
  });

  it('tours every buoy', () => {
    expect(CHALLENGES[0]!.steps).toEqual(buoyData.buoys.map((b) => b.name));
  });

  it('locks a reward until its challenge is complete', () => {
    const all = buoyData.buoys.map((b) => b.name);
    expect(lockedSails([])).toEqual(new Map([['tide', 'Buoy tour']]));
    expect(lockedSails([{ id: 'buoy-tour', steps: all, total: 5 }])).toEqual(new Map([['tide', 'Buoy tour']]));
    expect(lockedSails([{ id: 'buoy-tour', steps: all, total: 5, completedAt: 1 }]).size).toBe(0);
  });
});
