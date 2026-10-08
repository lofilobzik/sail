import { describe, expect, it } from 'vitest';
import buoyData from '../../data/buoys.json';
import sailDesigns from '../../data/sail-designs.json';
import { CHALLENGES, NO_CHALLENGE, lockedSails } from './challengeInfo';

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
    expect(lockedSails([]).get('tide')).toBe('Buoy tour');
    expect(lockedSails([{ id: 'buoy-tour', steps: all, total: 5 }]).get('tide')).toBe('Buoy tour');
    expect(lockedSails([{ id: 'buoy-tour', steps: all, total: 5, completedAt: 1 }]).has('tide')).toBe(false);
    expect(lockedSails(null).has('tide')).toBe(false);
  });

  it('locks every sail no challenge awards, except the default, with or without progress', () => {
    const unawarded = sailDesigns.designs.map((d) => d.id).filter((id) => id !== sailDesigns.default && id !== 'tide');
    for (const list of [null, []]) {
      const locked = lockedSails(list);
      expect(locked.has(sailDesigns.default)).toBe(false);
      for (const id of unawarded) expect(locked.get(id)).toBe(NO_CHALLENGE);
    }
  });
});
