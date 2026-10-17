/**
 * Quest tracking: which challenge the player follows (picked in the J log, kept in Prefs) and its
 * next goal. Pure: reads the catalogue, the server's progress and the boat's position.
 */
import buoyData from '../../data/buoys.json';
import type { ChallengeStatus } from '../net/protocol';
import type { Vec2 } from '../sim/frames';
import { CHALLENGES, type ChallengeInfo } from './challengeInfo';

/**
 * The player's choice: `auto` (never chosen) follows the first unfinished challenge in J order;
 * `none` tracks nothing (an explicit untrack, never undone automatically); `quest` follows one.
 */
export type QuestTracking = { kind: 'auto' } | { kind: 'none' } | { kind: 'quest'; id: string };

export interface QuestGoal {
  /** The step's name, as stored and shown in J ("H1 (2nd)"). */
  step: string;
  /** The data/buoys.json name to sail to. */
  buoy: string;
  /** Logical-world position of that buoy. */
  x: number;
  z: number;
  /** m from the boat. */
  distance: number;
}

const BUOYS = new Map(buoyData.buoys.map((b) => [b.name, b]));

const complete = (list: readonly ChallengeStatus[], id: string): boolean =>
  list.find((s) => s.id === id)?.completedAt !== undefined;

/**
 * The challenge to follow, or null. A tracked challenge that is complete (or gone from the data)
 * hands over to the next unfinished one, as `auto` does; `none` stays none.
 */
export function trackedQuest(tracking: QuestTracking, list: readonly ChallengeStatus[]): ChallengeInfo | null {
  if (tracking.kind === 'none') return null;
  if (tracking.kind === 'quest') {
    const chosen = CHALLENGES.find((c) => c.id === tracking.id);
    if (chosen && !complete(list, chosen.id)) return chosen;
  }
  return CHALLENGES.find((c) => !complete(list, c.id)) ?? null;
}

/**
 * The goals of `quest` open now, given `status` (its server progress): for a course only the first
 * step not yet reached (they go in order); for visitBuoys every unreached buoy, nearest to `boat`
 * first. Empty when all are reached. The first is the one the ring points at.
 */
export function openGoals(quest: ChallengeInfo, status: ChallengeStatus | undefined, boat: Readonly<Vec2>): QuestGoal[] {
  const reached = status?.steps ?? [];
  const goals: QuestGoal[] = [];
  for (let i = 0; i < quest.steps.length; i++) {
    if (reached.includes(quest.steps[i]!)) continue;
    const b = BUOYS.get(quest.buoys[i]!);
    if (!b) throw new Error(`quests: no buoy ${quest.buoys[i]}`);
    const goal = { step: quest.steps[i]!, buoy: b.name, x: b.x, z: b.z, distance: Math.hypot(b.x - boat.x, b.z - boat.z) };
    if (quest.kind === 'course') return [goal];
    goals.push(goal);
  }
  return goals.sort((a, b) => a.distance - b.distance);
}
