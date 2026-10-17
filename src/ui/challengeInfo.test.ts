import { describe, expect, it } from 'vitest';
import sailDesigns from '../../data/sail-designs.json';
import { CHALLENGES, NO_CHALLENGE, lockedSails, stepName } from './challengeInfo';

describe('challenge catalogue', () => {
  it('rewards only sail designs that exist', () => {
    const ids = sailDesigns.designs.map((d) => d.id);
    for (const c of CHALLENGES) if (c.reward) expect(ids).toContain(c.reward.id);
  });

  it('locks each reward until its own challenge is complete', () => {
    const tour = CHALLENGES.find((c) => c.id === 'buoy-tour')!.steps;
    expect(lockedSails([]).get('tide')).toBe('First sail');
    expect(lockedSails([]).get('sunburst')).toBe('Buoy tour');
    const toured = lockedSails([{ id: 'buoy-tour', steps: tour, total: 5, completedAt: 1 }]);
    expect(toured.has('sunburst')).toBe(false);
    expect(toured.get('tide')).toBe('First sail');
    expect(lockedSails([{ id: 'first-sail', steps: ['H1', 'H2'], total: 3 }]).get('tide')).toBe('First sail');
    expect(lockedSails([{ id: 'first-sail', steps: ['H1', 'H2', 'H1 (2nd)'], total: 3, completedAt: 1 }]).has('tide')).toBe(false);
    expect(lockedSails(null).has('tide')).toBe(false);
  });

  it('names a course\'s returns to a buoy as the server stores them', () => {
    expect(CHALLENGES.find((c) => c.id === 'first-sail')!.steps).toEqual(['H1', 'H2', 'H1 (2nd)']);
    // Same table as server/sim TestCourseStepsChainInOrderAndNameReturns.
    const names: [number, string][] = [[1, 'H1'], [4, 'H1 (4th)'], [11, 'H1 (11th)'], [21, 'H1 (21st)'], [22, 'H1 (22nd)'], [112, 'H1 (112th)']];
    for (const [visit, name] of names) expect(stepName('H1', visit)).toBe(name);
  });

  it('locks every sail no challenge awards, except the default, with or without progress', () => {
    const rewards = CHALLENGES.flatMap((c) => (c.reward ? [c.reward.id] : []));
    const unawarded = sailDesigns.designs.map((d) => d.id).filter((id) => id !== sailDesigns.default && !rewards.includes(id));
    for (const list of [null, []]) {
      const locked = lockedSails(list);
      expect(locked.has(sailDesigns.default)).toBe(false);
      for (const id of unawarded) expect(locked.get(id)).toBe(NO_CHALLENGE);
    }
  });
});
