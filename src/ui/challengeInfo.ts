/**
 * The challenge catalogue as the client shows it: titles and rewards from data/challenges.json,
 * steps from the data they refer to. The server verifies and stores progress; the client unlocks
 * rewards when the server reports a challenge complete.
 */
import challengeData from '../../data/challenges.json';
import buoyData from '../../data/buoys.json';
import type { ChallengeStatus } from '../net/protocol';

export interface ChallengeInfo {
  id: string;
  title: string;
  description: string;
  /** Step names in display order. */
  steps: string[];
  reward: { type: 'sail'; id: string } | null;
}

const tour = challengeData.buoyTour;

export const CHALLENGES: readonly ChallengeInfo[] = [
  {
    id: tour.id,
    title: tour.title,
    description: tour.description,
    steps: buoyData.buoys.map((b) => b.name),
    reward: { type: 'sail', id: tour.reward.id },
  },
];

/** Sail id -> title of the challenge that unlocks it, for every reward whose challenge is not complete in `list`. */
export function lockedSails(list: readonly ChallengeStatus[]): Map<string, string> {
  const locked = new Map<string, string>();
  for (const c of CHALLENGES) {
    if (c.reward?.type !== 'sail') continue;
    if (list.find((s) => s.id === c.id)?.completedAt === undefined) locked.set(c.reward.id, c.title);
  }
  return locked;
}
