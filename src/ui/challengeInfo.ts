/**
 * The challenge catalogue as the client shows it, from data/challenges.json `challenges` in data
 * order. The server verifies and stores progress (and rejects data it cannot check at startup); the
 * client unlocks rewards when the server reports a challenge complete.
 */
import challengeData from '../../data/challenges.json';
import sailDesigns from '../../data/sail-designs.json';
import type { ChallengeStatus } from '../net/protocol';

/** How a challenge's steps are reached (data/challenges.json `source`). */
export type ChallengeKind = 'visitBuoys';

export interface ChallengeInfo {
  id: string;
  title: string;
  description: string;
  kind: ChallengeKind;
  /** Step names in display order: buoy names for visitBuoys. */
  steps: string[];
  reward: { type: 'sail'; id: string } | null;
}

export const CHALLENGES: readonly ChallengeInfo[] = challengeData.challenges.map((c) => ({
  id: c.id,
  title: c.title,
  description: c.description,
  kind: c.kind as ChallengeKind,
  steps: c.buoys,
  reward: 'reward' in c && c.reward ? { type: 'sail', id: c.reward.id } : null,
}));

/** Why a sail with no challenge that awards it cannot be picked. */
export const NO_CHALLENGE = 'no challenge yet';

/**
 * Sail id -> why it is locked: the title of the challenge that unlocks it while that challenge is
 * not complete in `list`, or NO_CHALLENGE for every non-default design no challenge awards (always
 * locked). `list` is null while challenges are unavailable (offline, a server without -db, before
 * progress arrives): reward sails then stay open, since there is no progress to check.
 */
export function lockedSails(list: readonly ChallengeStatus[] | null): Map<string, string> {
  const locked = new Map<string, string>();
  const rewards = new Set(CHALLENGES.flatMap((c) => (c.reward?.type === 'sail' ? [c.reward.id] : [])));
  for (const d of sailDesigns.designs) {
    if (d.id !== sailDesigns.default && !rewards.has(d.id)) locked.set(d.id, NO_CHALLENGE);
  }
  if (list === null) return locked;
  for (const c of CHALLENGES) {
    if (c.reward?.type !== 'sail') continue;
    if (list.find((s) => s.id === c.id)?.completedAt === undefined) locked.set(c.reward.id, c.title);
  }
  return locked;
}
