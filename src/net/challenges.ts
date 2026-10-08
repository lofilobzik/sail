/**
 * Challenge progress as the client keeps it. Progress only ever grows, so a frame carrying an older
 * state (a welcome built from a database read that predates a confirmed write) never moves it back.
 */
import type { ChallengeStatus } from './protocol';

/** `prev` updated by `next`: steps in first-seen order, completion kept once seen. */
export function mergeChallenges(prev: readonly ChallengeStatus[], next: readonly ChallengeStatus[]): ChallengeStatus[] {
  const out = prev.map((c) => ({ ...c, steps: [...c.steps] }));
  for (const n of next) {
    const i = out.findIndex((c) => c.id === n.id);
    const old = i >= 0 ? out[i]! : undefined;
    const steps = old ? [...old.steps, ...n.steps.filter((s) => !old.steps.includes(s))] : [...n.steps];
    const merged: ChallengeStatus = { id: n.id, steps, total: n.total };
    const completedAt = n.completedAt ?? old?.completedAt;
    if (completedAt !== undefined) merged.completedAt = completedAt;
    if (i >= 0) out[i] = merged;
    else out.push(merged);
  }
  return out;
}
