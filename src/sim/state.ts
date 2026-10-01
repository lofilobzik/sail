/** Normalized, already rate-limited control values (produced by input/). */
export interface Controls {
  /** Tiller position -1..1, + = tiller to starboard (boat turns to port). */
  tiller: number;
  /** Mainsheet 0..1, 0 = sheeted hard in, 1 = fully eased. */
  sheet: number;
  /** Hiking 0..1, 0 = sitting in, 1 = fully hiked. */
  hike: number;
}

export interface BoatState {
  /** Sim time, s. */
  t: number;
  /** World position, m. */
  x: number;
  z: number;
  /** Compass heading, rad. */
  heading: number;
  /** Body velocity relative to mean still water, m/s (+u forward, +v starboard). */
  u: number;
  v: number;
  /** Yaw rate, rad/s (+ = bow to starboard). */
  r: number;
  /** Heel, rad (+ = starboard rail down), and heel rate. */
  heel: number;
  p: number;
  /** Wave-driven pitch, rad (+ = bow up), and pitch rate, rad/s. */
  pitch: number;
  pitchRate: number;
  /** Boom angle from the centreline, rad (+ = boom to starboard). */
  boom: number;
  /** Side the boom is on: +1 starboard, -1 port. Changes on tacks and gybes. */
  boomSide: 1 | -1;
  /** Crew CG offset from the centreline, m (+ = starboard). */
  crewY: number;
}

export function initialState(heading = 0, speed = 0): BoatState {
  return {
    t: 0,
    x: 0,
    z: 0,
    heading,
    u: speed,
    v: 0,
    r: 0,
    heel: 0,
    p: 0,
    pitch: 0,
    pitchRate: 0,
    boom: 0,
    boomSide: 1,
    crewY: 0,
  };
}

export const NEUTRAL_CONTROLS: Readonly<Controls> = { tiller: 0, sheet: 0.5, hike: 0 };
