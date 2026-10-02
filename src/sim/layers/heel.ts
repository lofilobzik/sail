/**
 * L5 Heel and hiking (PHYSICS.md L5).
 *
 * Righting moment, Day 2017 Eq. 18 (PDF p8), written as a signed moment for any
 * crew position (Day gives the maximum with the crew fully hiked):
 *   RM = W_hull GZ(phi) + W_crew (GZ(phi) + dYCG_crew cos(phi) - dZCG_crew sin(phi))
 * GZ(phi) is the righting lever with the crew mass at the hull CG. Hull form
 * stability from the small-angle relation GZ = GM sin(phi) (Larsson & Eliasson
 * p41, PDF p57, Fig 4.9), GM from boat.ts.
 *
 * Crew position (Day 2017 pp7-8): CG at 55% of standing height; fully hiked, the CG
 * is at most 95% of that height out from the centreline (toe strap on the
 * centreline). Sitting-in offset and CG heights are TUNING GUESS (laser.json).
 * The crew sits on the side opposite the boom and moves across at a limited rate. With the
 * crewCentresWhenLuffing term the target offset shrinks as the sail luffs (reach x (1 - luffAmount)).
 * The sailor only changes sides once the boom has swung clearly across, so a boom
 * flicking about the centreline head to wind does not make the crew rock the boat.
 */
import type { BoatModel } from '../boat';
import { DEG, G } from '../frames';
import type { BoatState, Controls } from '../state';

/** TUNING GUESS: how fast the sailor moves across the boat, m/s. */
export const CREW_CROSSING_SPEED = 1.5;
/** TUNING GUESS: boom angle past the centreline at which the sailor changes sides. */
const CREW_SWITCH_BOOM_ANGLE = 10 * DEG;

export interface CrewPosition {
  /** Target transverse offset from the centreline, m (+ = starboard). */
  targetY: number;
  /** Height relative to the hull CG, m. */
  z: number;
  /** Maximum hiking reach, m. */
  maxReach: number;
}

/** `luffAmount` (0..1) pulls the target toward the centreline; pass 0 to keep the full offset. */
export function crewPosition(state: BoatState, controls: Controls, boat: BoatModel, luffAmount = 0): CrewPosition {
  const c = boat.cfg.crew;
  const hike = Math.min(Math.max(controls.hike, 0), 1);
  const maxReach = c.hikeReachFrac * c.cgHeightFrac * c.height;
  const reach = (c.sitInOffset + hike * (maxReach - c.sitInOffset)) * (1 - Math.min(Math.max(luffAmount, 0), 1));
  let side: number;
  if (Math.abs(state.boom) > CREW_SWITCH_BOOM_ANGLE) side = -Math.sign(state.boom);
  else if (state.crewY !== 0) side = Math.sign(state.crewY);
  else side = -state.boomSide;
  return {
    targetY: side * reach,
    z: c.sitInZAboveHullCg + hike * (c.hikedZAboveHullCg - c.sitInZAboveHullCg),
    maxReach,
  };
}

/** Signed hydrostatic + crew moment about the roll axis, N m (+ = heels to starboard). */
export function rightingMoment(heel: number, crewY: number, crewZ: number, boat: BoatModel): number {
  const gz = boat.gm * Math.sin(heel);
  const wHull = boat.hullMass * G;
  const wCrew = boat.crewMass * G;
  // Eq. 18 terms with signs: hull and crew GZ resist heel; crew offset to starboard
  // (crewY > 0) heels to starboard; crew above the hull CG adds to the heel.
  return -(wHull + wCrew) * gz + wCrew * (crewY * Math.cos(heel) + crewZ * Math.sin(heel));
}
