/**
 * The challenge catalogue as the client shows it, from data/challenges.json `challenges` in data
 * order. The server verifies and stores progress (and rejects data it cannot check at startup); the
 * client unlocks rewards when the server reports a challenge complete.
 */
import challengeData from '../../data/challenges.json';
import sailDesigns from '../../data/sail-designs.json';
import type { ChallengeStatus } from '../net/protocol';

/** How a challenge's steps are reached (data/challenges.json `source`). */
export type ChallengeKind = 'visitBuoys' | 'course';

export interface ChallengeInfo {
  id: string;
  title: string;
  description: string;
  kind: ChallengeKind;
  /** Step names in display order (stepName of each listed buoy), exactly as the server stores them. */
  steps: string[];
  /** The data/buoys.json name each step is reached at, by step index. */
  buoys: string[];
  reward: { type: 'sail'; id: string } | null;
}

/**
 * A step at buoy `buoy`, its `visit`th time in the list (1 for the first): the buoy name, then
 * "H1 (2nd)", "H1 (3rd)"... Go twin: StepName in server/sim/challenges.go.
 */
export function stepName(buoy: string, visit: number): string {
  if (visit <= 1) return buoy;
  const teen = visit % 100 >= 11 && visit % 100 <= 13;
  const suffix = teen ? 'th' : visit % 10 === 1 ? 'st' : visit % 10 === 2 ? 'nd' : visit % 10 === 3 ? 'rd' : 'th';
  return `${buoy} (${visit}${suffix})`;
}

/** The step names of a challenge's buoy list, in order. */
function stepNames(buoys: readonly string[]): string[] {
  const visits = new Map<string, number>();
  return buoys.map((b) => {
    const n = (visits.get(b) ?? 0) + 1;
    visits.set(b, n);
    return stepName(b, n);
  });
}

export const CHALLENGES: readonly ChallengeInfo[] = challengeData.challenges.map((c) => ({
  id: c.id,
  title: c.title,
  description: c.description,
  kind: c.kind as ChallengeKind,
  steps: stepNames(c.buoys),
  buoys: c.buoys,
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
