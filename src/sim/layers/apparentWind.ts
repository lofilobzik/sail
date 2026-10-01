/**
 * L1 Apparent wind (PHYSICS.md L1).
 *   apparentWind = trueWind(position, time) - boatVelocity   (world frame)
 * then expressed in the body frame as apparent wind speed (AWS) and angle (AWA).
 */
import { bodyToWorld, worldToBody, type Vec2 } from '../frames';
import type { BoatState } from '../state';

export interface ApparentWind {
  /** Air velocity relative to the boat, body frame (where the air moves TO), m/s. */
  u: number;
  v: number;
  /** Apparent wind speed, m/s. */
  speed: number;
  /** Apparent wind angle, rad, direction the wind comes FROM relative to the bow, + = starboard. */
  angle: number;
}

/** `enabled = false` returns the true wind in the body frame (boat velocity ignored). */
export function apparentWind(state: BoatState, trueWind: Vec2, enabled: boolean): ApparentWind {
  let wx = trueWind.x;
  let wz = trueWind.z;
  if (enabled) {
    const boatVel = bodyToWorld(state.heading, state.u, state.v);
    wx -= boatVel.x;
    wz -= boatVel.z;
  }
  const body = worldToBody(state.heading, wx, wz);
  return {
    u: body.u,
    v: body.v,
    speed: Math.hypot(body.u, body.v),
    angle: Math.atan2(-body.v, -body.u),
  };
}
