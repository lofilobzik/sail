/**
 * Grounding on the bay's seabed (data/bay.json `grounding`, all TUNING GUESS).
 *
 * The boat touches when the seabed under it is shallower than the daggerboard tip
 * (canoe-body draft Tc plus board span). Penetration p (m, capped) then
 *   - pushes the boat toward deeper water: F = k p, down the seabed gradient,
 *   - damps its motion through the water: F = -c p V, and yaw: N = -c_r p r.
 * There is no board kick-up, heel-on-the-bottom or keel contact geometry: this is a playable
 * soft stop, so the boat comes to rest in the shallows where the sail's drive balances the push
 * and slides back off when the sheet is eased or it is turned away. Waves are ignored.
 */
import type { BoatModel } from '../boat';
import { bodyToWorld, worldToBody } from '../frames';
import type { BoatState } from '../state';
import { BAY, terrainGradient, terrainHeight } from '../terrain';

export interface GroundResult {
  /** Water depth under the boat, m (negative on dry land). */
  depth: number;
  /** How far the board tip would be below the seabed, m; 0 when afloat. */
  penetration: number;
  /** Body-frame force, N, and yaw moment, N m. */
  fx: number;
  fy: number;
  yawMoment: number;
}

export function groundForces(state: BoatState, boat: BoatModel): GroundResult {
  const g = BAY.grounding;
  const depth = -terrainHeight(state.x, state.z);
  const penetration = Math.min(Math.max(boat.tc + boat.board.span - depth, 0), g.maxPenetration);
  if (penetration === 0) return { depth, penetration, fx: 0, fy: 0, yawMoment: 0 };
  const slope = terrainGradient(state.x, state.z);
  const length = Math.hypot(slope.x, slope.z);
  // Down the slope is toward deeper water; flat ground gives no direction to push.
  const push = length > 1e-6 ? g.pushStiffness * penetration / length : 0;
  const velocity = bodyToWorld(state.heading, state.u, state.v);
  const damping = g.damping * penetration;
  const body = worldToBody(state.heading, -slope.x * push - velocity.x * damping, -slope.z * push - velocity.z * damping);
  return { depth, penetration, fx: body.u, fy: body.v, yawMoment: -g.yawDamping * penetration * state.r };
}
