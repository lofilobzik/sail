/**
 * What the gust sounds need: how soon a gust reaches the boat, which side it comes from, and how
 * much gust the boat is in now. Reads the same `windSpeedFactor` as the water patches, sampled
 * where the boat will be (its current velocity carried forward), so the warning is only for puffs
 * the boat's course actually meets. Render only.
 */
import type { BoatState, WindConfig } from '../physics/types';
import { bearingToWorld, gustDrift, WIND_PARAMETERS, windSpeedFactor } from '../sim';

/** Gust excess (of full scale) at which a gust has arrived: the warning peaks and the sail fills. */
export const GUST_ONSET = 0.08;
const LEAD_SECONDS = 5; // TUNING GUESS: the warning starts this long before a gust arrives
const PEAK_SECONDS = 10; // how far ahead to look for the coming gust's strength
const STEP_SECONDS = 0.5;
const STRENGTH_FULL = 0.5; // coming gust excess (of full scale) heard at full warning level
const STRENGTH_FLOOR = 0.3; // even a weak coming gust is heard at this fraction

export interface GustCue {
  /** 0..1: a gust is on its way; rises over the last LEAD_SECONDS before it arrives, louder for stronger gusts. */
  approach: number;
  /** -1 (left) .. +1 (right): the side the coming gust approaches from, relative to the listener. */
  pan: number;
  /** 0..1: the gust the boat is in now (speed excess over the full-scale excess). */
  excess: number;
}

/**
 * The cue at the boat's state for a listener facing `facingX/facingZ` (world x-z, need not be unit).
 * Writes into and returns `out`.
 */
export function gustCue(state: BoatState, wind: WindConfig, facingX: number, facingZ: number, out: GustCue): GustCue {
  out.approach = 0;
  out.pan = 0;
  out.excess = 0;
  if (!wind.gusts?.enabled) return out;
  const full = WIND_PARAMETERS.puffs.cap * wind.gusts.gustScale;
  if (full <= 0) return out;
  const forward = bearingToWorld(state.heading);
  // Starboard is forward turned 90 deg clockwise seen from above: (x, z) -> (-z, x).
  const vx = forward.x * state.u - forward.z * state.v;
  const vz = forward.z * state.u + forward.x * state.v;
  let previous = (windSpeedFactor(state, state.t, wind) - 1) / full;
  out.excess = Math.min(previous, 1);
  if (previous >= GUST_ONSET) return out; // in the gust: the arrival layers take over

  let arrival = Infinity;
  let peak = 0;
  for (let lead = STEP_SECONDS; lead <= PEAK_SECONDS; lead += STEP_SECONDS) {
    const ahead = (windSpeedFactor({ x: state.x + vx * lead, z: state.z + vz * lead }, state.t + lead, wind) - 1) / full;
    if (arrival === Infinity) {
      if (ahead < GUST_ONSET) {
        previous = ahead;
        if (lead >= LEAD_SECONDS) break; // nothing arrives within the warning time
        continue;
      }
      // Interpolate the crossing between samples, so the warning swells smoothly.
      arrival = lead - (STEP_SECONDS * (ahead - GUST_ONSET)) / (ahead - previous);
    }
    peak = Math.max(peak, ahead);
  }
  if (arrival > LEAD_SECONDS) return out;
  const strength = Math.min(peak / STRENGTH_FULL, 1);
  out.approach = (1 - arrival / LEAD_SECONDS) * (STRENGTH_FLOOR + (1 - STRENGTH_FLOOR) * strength);

  // Puffs come toward the boat against their velocity relative to it: from upwind, shifted by the
  // boat's own motion.
  const drift = gustDrift(wind);
  const fromX = vx - drift.x;
  const fromZ = vz - drift.z;
  const length = Math.hypot(fromX, fromZ);
  const facing = Math.hypot(facingX, facingZ);
  if (length > 1e-6 && facing > 1e-6) {
    // The listener's right is the facing turned 90 deg clockwise: (x, z) -> (-z, x).
    out.pan = (fromX * -facingZ + fromZ * facingX) / (length * facing);
  }
  return out;
}
