import { describe, expect, it } from 'vitest';
import buoyData from '../../data/buoys.json';
import type { ChallengeStatus } from '../net/protocol';
import { CHALLENGES } from './challengeInfo';
import { openGoals, trackedQuest } from './quests';

const at = (name: string) => buoyData.buoys.find((b) => b.name === name)!;
const firstSail = CHALLENGES.find((c) => c.id === 'first-sail')!;
const tour = CHALLENGES.find((c) => c.id === 'buoy-tour')!;
const done = (id: string, steps: string[]): ChallengeStatus => ({ id, steps, total: steps.length, completedAt: 1 });

describe('trackedQuest', () => {
  it('follows the first unfinished challenge until the player chooses', () => {
    expect(trackedQuest({ kind: 'auto' }, [])?.id).toBe('first-sail');
    expect(trackedQuest({ kind: 'auto' }, [done('first-sail', firstSail.steps)])?.id).toBe('buoy-tour');
    expect(trackedQuest({ kind: 'auto' }, [done('first-sail', firstSail.steps), done('buoy-tour', tour.steps)])).toBeNull();
  });

  it('keeps an explicit choice, and hands a finished one on to the next unfinished', () => {
    expect(trackedQuest({ kind: 'quest', id: 'buoy-tour' }, [])?.id).toBe('buoy-tour');
    expect(trackedQuest({ kind: 'quest', id: 'buoy-tour' }, [done('buoy-tour', tour.steps)])?.id).toBe('first-sail');
    expect(trackedQuest({ kind: 'quest', id: 'gone' }, [])?.id).toBe('first-sail');
  });

  it('never tracks anything again after an untrack', () => {
    expect(trackedQuest({ kind: 'none' }, [])).toBeNull();
  });
});

describe('openGoals', () => {
  it('takes a course in order, one step at a time, coming back to a buoy as its later step', () => {
    const boat = { x: at('H2').x, z: at('H2').z };
    expect(openGoals(firstSail, undefined, boat).map((g) => g.step)).toEqual(['H1']);
    expect(openGoals(firstSail, { id: 'first-sail', steps: ['H1'], total: 3 }, boat).map((g) => g.step)).toEqual(['H2']);
    const [back] = openGoals(firstSail, { id: 'first-sail', steps: ['H1', 'H2'], total: 3 }, boat);
    expect([back!.step, back!.buoy, back!.x, back!.z]).toEqual(['H1 (2nd)', 'H1', at('H1').x, at('H1').z]);
    expect(openGoals(firstSail, { id: 'first-sail', steps: firstSail.steps, total: 3 }, boat)).toEqual([]);
  });

  it('lists every buoy of an any-order challenge not yet reached, nearest first', () => {
    const nearE = { x: at('E').x + 5, z: at('E').z };
    const all = openGoals(tour, undefined, nearE);
    expect(all.map((g) => g.buoy).sort()).toEqual([...tour.buoys].sort());
    expect(all[0]!.buoy).toBe('E');
    for (let i = 1; i < all.length; i++) expect(all[i]!.distance).toBeGreaterThanOrEqual(all[i - 1]!.distance);
    const later = openGoals(tour, { id: 'buoy-tour', steps: ['E', 'N'], total: 5 }, nearE).map((g) => g.buoy);
    expect(later).toHaveLength(3);
    expect(later).not.toContain('E');
  });
});
