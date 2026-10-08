import { describe, expect, it } from 'vitest';
import { mergeChallenges } from './challenges';

const tour = (steps: string[], completedAt?: number) => ({ id: 'buoy-tour', steps, total: 5, ...(completedAt === undefined ? {} : { completedAt }) });

describe('mergeChallenges', () => {
  it('never loses steps to a late, older frame', () => {
    expect(mergeChallenges([tour(['N', 'NE'])], [tour(['N'])])).toEqual([tour(['N', 'NE'])]);
  });

  it('adds new steps after the known ones, in first-seen order', () => {
    expect(mergeChallenges([tour(['N'])], [tour(['N', 'NE'])])).toEqual([tour(['N', 'NE'])]);
    expect(mergeChallenges([tour(['E'])], [tour(['N', 'E'])])).toEqual([tour(['E', 'N'])]);
  });

  it('keeps a completion the newer frame does not carry', () => {
    expect(mergeChallenges([tour(['N'], 7)], [tour(['N'])])).toEqual([tour(['N'], 7)]);
  });

  it('keeps challenges only the previous state knows', () => {
    const other = { id: 'other', steps: ['a'], total: 2 };
    expect(mergeChallenges([other], [tour(['N'])])).toEqual([other, tour(['N'])]);
  });
});
