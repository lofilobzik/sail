/**
 * Helmsman for the headless polar: holds a heading with the tiller and keeps the
 * boat near upright with hiking. Script-side only; the sim has no auto-trim.
 * Gains are TUNING GUESS values chosen for a steady hold, not for performance.
 */
import { clamp, wrapPi, type BoatState, type Controls } from '../../src/sim/index';

const HEADING_KP = 4; // TUNING GUESS: tiller per rad of heading error
const HEADING_KD = 3; // TUNING GUESS: tiller per rad/s of yaw rate
const HIKE_KI = 3; // TUNING GUESS: hike per (rad of leeward heel * s)

export interface Autopilot {
  controls(state: BoatState, dt: number): Controls;
}

export function createAutopilot(targetHeading: number, sheet: number, yawEnabled: boolean): Autopilot {
  let hike = 0;
  return {
    controls(state, dt) {
      const err = wrapPi(state.heading - targetHeading);
      // Tiller to starboard (+) turns the bow to port, so a heading too far to
      // starboard (err > 0) or a starboard yaw rate needs positive tiller.
      const tiller = yawEnabled ? clamp(HEADING_KP * err + HEADING_KD * state.r, -1, 1) : 0;
      const leewardHeel = state.boomSide * state.heel;
      hike = clamp(hike + HIKE_KI * leewardHeel * dt, 0, 1);
      return { tiller, sheet, hike };
    },
  };
}
